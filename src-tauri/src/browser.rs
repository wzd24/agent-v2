use crate::config;
use serde_json::{json, Value};
use std::path::PathBuf;
use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Mutex, OnceLock};
#[cfg(windows)]
use std::time::Duration;
use tauri::webview::{NewWindowResponse, WebviewBuilder};
use tauri::{AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, WebviewUrl};

const FIND_HOST: &str = "local-codex-find.invalid";

static WANTED: AtomicBool = AtomicBool::new(false);
static COVERED: AtomicU32 = AtomicU32::new(0);

struct NavState {
    entries: Vec<String>,
    index: usize,
}

struct BrowserTabs {
    nav: HashMap<String, NavState>,
    labels: HashSet<String>,
    active: String,
}

fn browser_tabs() -> &'static Mutex<BrowserTabs> {
    static STATE: OnceLock<Mutex<BrowserTabs>> = OnceLock::new();
    STATE.get_or_init(|| Mutex::new(BrowserTabs {
        nav: HashMap::new(),
        labels: HashSet::new(),
        active: String::new(),
    }))
}

fn tab_id_from(payload: &Value) -> String {
    let raw = payload.get("tabId").and_then(Value::as_str).unwrap_or("default");
    let safe: String = raw.chars().filter(|ch| ch.is_ascii_alphanumeric() || *ch == '-' || *ch == '_').take(48).collect();
    if safe.is_empty() { "default".to_string() } else { safe }
}

fn tab_label(tab_id: &str) -> String {
    format!("workspace-browser-{tab_id}")
}

fn label_from(payload: &Value) -> String {
    tab_label(&tab_id_from(payload))
}

fn tab_id_of(label: &str) -> String {
    label.strip_prefix("workspace-browser-").unwrap_or("default").to_string()
}

fn remember_tab(label: &str) {
    if let Ok(mut tabs) = browser_tabs().lock() {
        tabs.labels.insert(label.to_string());
        tabs.active = label.to_string();
    }
}

fn forget_tab(label: &str) {
    if let Ok(mut tabs) = browser_tabs().lock() {
        tabs.labels.remove(label);
        tabs.nav.remove(label);
        if tabs.active == label {
            tabs.active.clear();
        }
    }
}

fn known_labels() -> Vec<String> {
    browser_tabs().lock().map(|tabs| tabs.labels.iter().cloned().collect()).unwrap_or_default()
}

fn active_label() -> String {
    browser_tabs().lock().map(|tabs| tabs.active.clone()).unwrap_or_default()
}

pub fn profile_dir() -> PathBuf {
    config::app_root().join("workspace-browser-profile")
}

fn apply_visibility(app: &AppHandle) {
    let active = active_label();
    let show_active = WANTED.load(Ordering::SeqCst) && COVERED.load(Ordering::SeqCst) == 0;
    for label in known_labels() {
        let Some(view) = app.get_webview(&label) else {
            continue;
        };
        if show_active && label == active {
            let _ = view.show();
        } else {
            let _ = view.hide();
        }
    }
}

fn set_covered(app: &AppHandle, payload: &Value) -> Result<Value, String> {
    let covered = payload
        .get("covered")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    if covered {
        COVERED.fetch_add(1, Ordering::SeqCst);
    } else {
        let _ = COVERED.fetch_update(Ordering::SeqCst, Ordering::SeqCst, |value| {
            Some(value.saturating_sub(1))
        });
    }
    apply_visibility(app);
    Ok(json!(true))
}

fn flags(label: &str) -> (bool, bool) {
    browser_tabs()
        .lock()
        .ok()
        .and_then(|tabs| tabs.nav.get(label).map(history_flags))
        .unwrap_or((false, false))
}

fn resolved_flags(app: &AppHandle, label: &str, fallback: (bool, bool)) -> (bool, bool) {
    #[cfg(windows)]
    {
        if let Some(native) = webview2_flags(app, label) {
            return native;
        }
    }
    let _ = (app, label);
    fallback
}

#[cfg(windows)]
fn with_core_webview<R, F>(app: &AppHandle, label: &str, work: F) -> Option<R>
where
    R: Send + 'static,
    F: FnOnce(&webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2) -> R + Send + 'static,
{
    let view = app.get_webview(label)?;
    let (tx, rx) = std::sync::mpsc::sync_channel(1);
    view.with_webview(move |platform| {
        let result = unsafe {
            platform
                .controller()
                .CoreWebView2()
                .ok()
                .map(|core| work(&core))
        };
        let _ = tx.send(result);
    })
    .ok()?;
    rx.recv_timeout(Duration::from_millis(500)).ok().flatten()
}

#[cfg(windows)]
fn webview2_go(app: &AppHandle, label: &str, back: bool) -> bool {
    with_core_webview(app, label, move |core| unsafe {
        let mut allowed = windows_core::BOOL(0);
        if back {
            core.CanGoBack(&mut allowed).is_ok() && allowed.as_bool() && core.GoBack().is_ok()
        } else {
            core.CanGoForward(&mut allowed).is_ok() && allowed.as_bool() && core.GoForward().is_ok()
        }
    })
    .unwrap_or(false)
}

#[cfg(windows)]
fn webview2_flags(app: &AppHandle, label: &str) -> Option<(bool, bool)> {
    with_core_webview(app, label, |core| unsafe {
        let mut back = windows_core::BOOL(0);
        let mut forward = windows_core::BOOL(0);
        core.CanGoBack(&mut back).ok()?;
        core.CanGoForward(&mut forward).ok()?;
        Some((back.as_bool(), forward.as_bool()))
    })
    .flatten()
}

fn record_navigation(label: &str, url: &str) -> (bool, bool) {
    let Ok(mut tabs) = browser_tabs().lock() else {
        return (false, false);
    };
    let guard = tabs.nav.entry(label.to_string()).or_insert(NavState { entries: Vec::new(), index: 0 });
    if guard.entries.get(guard.index) == Some(&url.to_string()) {
        return history_flags(&guard);
    }
    if guard.index > 0 && guard.entries.get(guard.index - 1) == Some(&url.to_string()) {
        guard.index -= 1;
        return history_flags(&guard);
    }
    if guard.index + 1 < guard.entries.len()
        && guard.entries.get(guard.index + 1) == Some(&url.to_string())
    {
        guard.index += 1;
        return history_flags(&guard);
    }
    if !guard.entries.is_empty() {
        let index = guard.index;
        guard.entries.truncate(index + 1);
    }
    guard.entries.push(url.to_string());
    guard.index = guard.entries.len().saturating_sub(1);
    history_flags(&guard)
}

fn history_flags(guard: &NavState) -> (bool, bool) {
    let back = !guard.entries.is_empty() && guard.index > 0;
    let forward = !guard.entries.is_empty() && guard.index + 1 < guard.entries.len();
    (back, forward)
}

fn url_from(payload: &Value) -> Result<url::Url, String> {
    let raw = payload
        .get("url")
        .and_then(Value::as_str)
        .unwrap_or("about:blank")
        .trim();
    let value = if raw.is_empty() {
        "about:blank".to_string()
    } else if raw.starts_with("http://")
        || raw.starts_with("https://")
        || raw.starts_with("about:")
    {
        raw.to_string()
    } else {
        format!("https://{raw}")
    };
    value.parse().map_err(|err| format!("地址无效：{err}"))
}

fn bounds(payload: &Value) -> (f64, f64, f64, f64) {
    let x = payload.get("x").and_then(Value::as_f64).unwrap_or(0.0);
    let y = payload.get("y").and_then(Value::as_f64).unwrap_or(0.0);
    let width = payload.get("width").and_then(Value::as_f64).unwrap_or(800.0).max(1.0);
    let height = payload.get("height").and_then(Value::as_f64).unwrap_or(600.0).max(1.0);
    (x, y, width, height)
}

pub fn dispatch(app: &AppHandle, method: &str, payload: &Value) -> Result<Value, String> {
    match method {
        "browser.show" => show(app, payload),
        "browser.hide" => hide(app),
        "browser.navigate" => navigate(app, payload),
        "browser.close" => close_tab(app, payload),
        "browser.back" => history(app, payload, "back"),
        "browser.forward" => history(app, payload, "forward"),
        "browser.reload" => reload(app, payload),
        "browser.setBounds" => set_bounds(app, payload),
        "browser.find" => find(app, payload),
        "browser.setZoom" => set_zoom(app, payload),
        "browser.setCovered" => set_covered(app, payload),
        "browser.status" => status(app),
        _ => Err(format!("未知浏览器方法：{method}")),
    }
}

fn emit_find(app: &AppHandle, label: &str, matches: u64, active: u64) {
    let _ = app.emit(
        "browser://find",
        json!({
            "tabId": tab_id_of(label),
            "matches": matches,
            "active": active,
            "label": if matches == 0 {
                "0/0".to_string()
            } else {
                format!("{active}/{matches}")
            }
        }),
    );
}

fn emit_navigated(app: &AppHandle, label: &str, url: &str, back: bool, forward: bool) {
    let _ = app.emit(
        "browser://navigated",
        json!({
            "tabId": tab_id_of(label),
            "url": url,
            "canGoBack": back,
            "canGoForward": forward,
        }),
    );
}

fn current_url(label: &str) -> Option<String> {
    browser_tabs().lock().ok().and_then(|tabs| {
        let guard = tabs.nav.get(label)?;
        guard.entries.get(guard.index).cloned()
    })
}

fn place_view<R: tauri::Runtime>(view: &tauri::Webview<R>, x: f64, y: f64, width: f64, height: f64) -> Result<(), String> {
    view.set_position(LogicalPosition::new(x, y)).map_err(|err| err.to_string())?;
    view.set_size(LogicalSize::new(width, height)).map_err(|err| err.to_string())?;
    Ok(())
}

fn show(app: &AppHandle, payload: &Value) -> Result<Value, String> {
    let label = label_from(payload);
    let requested = payload
        .get("url")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let (x, y, width, height) = bounds(payload);
    remember_tab(&label);
    if requested.is_none() {
        if let Some(existing) = app.get_webview(&label) {
            let _ = existing.hide();
            let _ = existing.close();
            forget_alt_f4_guard(&label);
        }
        if let Ok(mut tabs) = browser_tabs().lock() {
            tabs.nav.remove(&label);
        }
        WANTED.store(true, Ordering::SeqCst);
        apply_visibility(app);
        return Ok(json!(true));
    }
    if let Some(existing) = app.get_webview(&label) {
        if let Some(raw) = requested {
            let url = url_from(&json!({ "url": raw }))?;
            let href = url.to_string();
            if current_url(&label).as_deref() != Some(href.as_str()) {
                existing.navigate(url).map_err(|err| err.to_string())?;
            }
        }
        place_view(&existing, x, y, width, height)?;
        WANTED.store(true, Ordering::SeqCst);
        apply_visibility(app);
        if let Some(href) = current_url(&label) {
            let (back, forward) = flags(&label);
            emit_navigated(app, &label, &href, back, forward);
        }
        return Ok(json!(true));
    }
    let Some(raw) = requested else {
        WANTED.store(true, Ordering::SeqCst);
        apply_visibility(app);
        return Ok(json!(true));
    };
    let url = url_from(&json!({ "url": raw }))?;
    let window = app
        .get_window("main")
        .ok_or_else(|| "主窗口不存在".to_string())?;
    let handle = app.clone();
    let profile = profile_dir();
    let _ = std::fs::create_dir_all(&profile);
    let nav_label = label.clone();
    let popup_label = label.clone();
    let builder = WebviewBuilder::new(label.as_str(), WebviewUrl::External(url.clone()))
        .data_directory(profile)
        .on_new_window({
            let handle = app.clone();
            move |next, _features| {
                if matches!(next.scheme(), "http" | "https") {
                    if let Some(view) = handle.get_webview(&popup_label) {
                        let _ = view.navigate(next.clone());
                        let href = next.to_string();
                        let (back, forward) = record_navigation(&popup_label, &href);
                        emit_navigated(&handle, &popup_label, &href, back, forward);
                    }
                }
                NewWindowResponse::Deny
            }
        })
        .on_navigation(
        move |next| {
            if next.host_str() == Some(FIND_HOST) {
                let matches = next
                    .query_pairs()
                    .find(|(key, _)| key == "m")
                    .map(|(_, value)| value.parse::<u64>().unwrap_or(0))
                    .unwrap_or(0);
                let active = next
                    .query_pairs()
                    .find(|(key, _)| key == "a")
                    .map(|(_, value)| value.parse::<u64>().unwrap_or(0))
                    .unwrap_or(0);
                emit_find(&handle, &nav_label, matches, active);
                return false;
            }
            let href = next.to_string();
            let (back, forward) = record_navigation(&nav_label, &href);
            emit_navigated(&handle, &nav_label, &href, back, forward);
            true
        },
    );
    window
        .add_child(
            builder,
            LogicalPosition::new(x, y),
            LogicalSize::new(width, height),
        )
        .map_err(|err| err.to_string())?;
    install_alt_f4_guard(app, &label);
    let href = url.to_string();
    let (back, forward) = record_navigation(&label, &href);
    emit_navigated(app, &label, &href, back, forward);
    WANTED.store(true, Ordering::SeqCst);
    apply_visibility(app);
    Ok(json!(true))
}

fn close_tab(app: &AppHandle, payload: &Value) -> Result<Value, String> {
    let label = label_from(payload);
    if let Some(view) = app.get_webview(&label) {
        let _ = view.close();
    }
    forget_alt_f4_guard(&label);
    forget_tab(&label);
    apply_visibility(app);
    Ok(json!(true))
}

fn hide(app: &AppHandle) -> Result<Value, String> {
    WANTED.store(false, Ordering::SeqCst);
    apply_visibility(app);
    Ok(json!(true))
}

fn navigate(app: &AppHandle, payload: &Value) -> Result<Value, String> {
    let url = url_from(payload)?;
    let label = label_from(payload);
    if let Some(view) = app.get_webview(&label) {
        view.navigate(url).map_err(|err| err.to_string())?;
        return Ok(json!(true));
    }
    show(app, payload)
}

fn history(app: &AppHandle, payload: &Value, action: &str) -> Result<Value, String> {
    let label = label_from(payload);
    let Some(view) = app.get_webview(&label) else {
        return Ok(json!(false));
    };
    #[cfg(windows)]
    if webview2_go(app, &label, action == "back") {
        emit_history_state(app, &label);
        return Ok(json!(true));
    }
    let script = if action == "back" {
        "history.back()"
    } else {
        "history.forward()"
    };
    let _ = view.eval(script);
    emit_history_state(app, &label);
    Ok(json!(true))
}

fn emit_history_state(app: &AppHandle, label: &str) {
    let url = current_url(label).unwrap_or_default();
    let (back, forward) = resolved_flags(app, label, flags(label));
    emit_navigated(app, label, &url, back, forward);
}

fn reload(app: &AppHandle, payload: &Value) -> Result<Value, String> {
    let label = label_from(payload);
    let Some(view) = app.get_webview(&label) else {
        return Ok(json!(false));
    };
    view.reload().map_err(|err| err.to_string())?;
    Ok(json!(true))
}

fn set_bounds(app: &AppHandle, payload: &Value) -> Result<Value, String> {
    let (x, y, width, height) = bounds(payload);
    let mut moved = false;
    for label in known_labels() {
        let Some(view) = app.get_webview(&label) else {
            continue;
        };
        place_view(&view, x, y, width, height)?;
        moved = true;
    }
    apply_visibility(app);
    Ok(json!(moved))
}

#[cfg(windows)]
fn last_native_find() -> &'static Mutex<String> {
    static STATE: OnceLock<Mutex<String>> = OnceLock::new();
    STATE.get_or_init(|| Mutex::new(String::new()))
}

#[cfg(windows)]
fn webview2_finder(
    core: &webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2,
) -> Option<(
    webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Find,
    webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Environment15,
)> {
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        ICoreWebView2Environment15, ICoreWebView2_2, ICoreWebView2_28,
    };
    use windows_core::Interface;
    unsafe {
        let find_host = core.cast::<ICoreWebView2_28>().ok()?;
        let finder = find_host.Find().ok()?;
        let env = core.cast::<ICoreWebView2_2>().ok()?.Environment().ok()?;
        let env15 = env.cast::<ICoreWebView2Environment15>().ok()?;
        Some((finder, env15))
    }
}

#[cfg(windows)]
fn webview2_find_counts(
    finder: &webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Find,
) -> (i32, i32) {
    unsafe {
        let mut matches = 0i32;
        let mut active = 0i32;
        let _ = finder.MatchCount(&mut matches);
        let _ = finder.ActiveMatchIndex(&mut active);
        (matches, active)
    }
}

#[cfg(windows)]
fn webview2_find(
    app: &AppHandle,
    label: &str,
    query: &str,
    forward: bool,
    find_next: bool,
    match_case: bool,
) -> bool {
    use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2FindStartCompletedHandler;
    use windows_core::HSTRING;
    let query_owned = query.to_string();
    let acted = with_core_webview(app, label, {
        let query_owned = query_owned.clone();
        move |core| {
            let Some((finder, env15)) = webview2_finder(core) else {
                return false;
            };
            unsafe {
                if query_owned.is_empty() {
                    let _ = finder.Stop();
                    if let Ok(mut last) = last_native_find().lock() {
                        last.clear();
                    }
                    return true;
                }
                let last = last_native_find()
                    .lock()
                    .ok()
                    .map(|guard| guard.clone())
                    .unwrap_or_default();
                if find_next && last == query_owned {
                    return if forward {
                        finder.FindNext().is_ok()
                    } else {
                        finder.FindPrevious().is_ok()
                    };
                }
                let Ok(options) = env15.CreateFindOptions() else {
                    return false;
                };
                if options.SetFindTerm(&HSTRING::from(query_owned.as_str())).is_err() {
                    return false;
                }
                if options.SetIsCaseSensitive(match_case).is_err() {
                    return false;
                }
                if options.SetShouldHighlightAllMatches(true).is_err() {
                    return false;
                }
                if finder
                    .Start(&options, None::<&ICoreWebView2FindStartCompletedHandler>)
                    .is_err()
                {
                    return false;
                }
                if let Ok(mut last) = last_native_find().lock() {
                    *last = query_owned;
                }
                true
            }
        }
    });
    if !acted.unwrap_or(false) {
        return false;
    }
    if query.is_empty() {
        emit_find(app, label, 0, 0);
        return true;
    }
    let handle = app.clone();
    let find_label = label.to_string();
    std::thread::spawn(move || {
        for delay in [40_u64, 80, 160] {
            std::thread::sleep(Duration::from_millis(delay));
            let counts = with_core_webview(&handle, &find_label, |core| {
                webview2_finder(core).map(|(finder, _)| webview2_find_counts(&finder))
            })
            .flatten();
            let Some((matches, active)) = counts else {
                continue;
            };
            let matches = matches.max(0) as u64;
            let active = if matches == 0 {
                0
            } else if active < 1 {
                1
            } else {
                active as u64
            };
            emit_find(&handle, &find_label, matches, active);
            if matches > 0 || delay >= 160 {
                break;
            }
        }
    });
    true
}

fn find(app: &AppHandle, payload: &Value) -> Result<Value, String> {
    let label = label_from(payload);
    let Some(view) = app.get_webview(&label) else {
        return Ok(json!(false));
    };
    let query = payload.get("query").and_then(Value::as_str).unwrap_or("");
    let forward = payload
        .get("forward")
        .and_then(Value::as_bool)
        .unwrap_or(true);
    let find_next = payload
        .get("findNext")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let match_case = payload
        .get("matchCase")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    #[cfg(windows)]
    if webview2_find(app, &label, query, forward, find_next, match_case) {
        return Ok(json!(true));
    }
    if query.is_empty() {
        let _ = view.eval(
            r#"(function(){
  const docs = [];
  const walk = (doc) => {
    if (!doc || docs.includes(doc)) return;
    docs.push(doc);
    try {
      const frames = doc.defaultView ? doc.defaultView.frames : [];
      for (let i = 0; i < frames.length; i++) {
        try { walk(frames[i].document); } catch (e) {}
      }
    } catch (e) {}
  };
  walk(document);
  docs.forEach((doc) => {
    doc.querySelectorAll('mark[data-lc-find]').forEach((node) => {
      const parent = node.parentNode;
      if (!parent) return;
      parent.replaceChild(doc.createTextNode(node.textContent || ''), node);
      parent.normalize();
    });
    doc.documentElement.removeAttribute('data-lc-query');
  });
  try { location.href = 'https://local-codex-find.invalid/?m=0&a=0'; } catch (e) {}
})()"#,
        );
        return Ok(json!(true));
    }
    let encoded = serde_json::to_string(query).unwrap_or_else(|_| "\"\"".into());
    let script = format!(
        r#"(function(){{
  const query = {encoded};
  const forward = {forward};
  const findNext = {find_next};
  const matchCase = {match_case};
  const styleText = 'mark[data-lc-find]{{background:#f7e07c;color:inherit}}mark[data-lc-find].lc-active{{background:#ff9632}}';
  const collectDocs = (doc, into) => {{
    if (!doc || into.includes(doc)) return;
    into.push(doc);
    try {{
      const frames = doc.defaultView ? doc.defaultView.frames : [];
      for (let i = 0; i < frames.length; i++) {{
        try {{ collectDocs(frames[i].document, into); }} catch (e) {{}}
      }}
    }} catch (e) {{}}
  }};
  const docs = [];
  collectDocs(document, docs);
  const report = (matches, active) => {{
    try {{ location.href = 'https://local-codex-find.invalid/?m=' + matches + '&a=' + active; }} catch (e) {{}}
  }};
  const clearDoc = (doc) => {{
    doc.querySelectorAll('mark[data-lc-find]').forEach((node) => {{
      const parent = node.parentNode;
      if (!parent) return;
      parent.replaceChild(doc.createTextNode(node.textContent || ''), node);
      parent.normalize();
    }});
  }};
  const allMarks = () => docs.flatMap((doc) => Array.from(doc.querySelectorAll('mark[data-lc-find]')));
  const previous = document.documentElement.getAttribute('data-lc-query') || '';
  const existing = allMarks();
  if (existing.length && findNext && previous === query) {{
    let idx = existing.findIndex((node) => node.classList.contains('lc-active'));
    existing.forEach((node) => node.classList.remove('lc-active'));
    idx = forward ? idx + 1 : idx - 1;
    if (idx >= existing.length) idx = 0;
    if (idx < 0) idx = existing.length - 1;
    existing[idx].classList.add('lc-active');
    existing[idx].scrollIntoView({{ block: 'center', inline: 'nearest' }});
    report(existing.length, idx + 1);
    return;
  }}
  docs.forEach(clearDoc);
  document.documentElement.setAttribute('data-lc-query', query);
  const needle = matchCase ? query : query.toLowerCase();
  let matches = 0;
  const hay = (value) => matchCase ? value : value.toLowerCase();
  docs.forEach((doc) => {{
    if (!doc.getElementById('__lc-find-style')) {{
      const style = doc.createElement('style');
      style.id = '__lc-find-style';
      style.textContent = styleText;
      doc.documentElement.appendChild(style);
    }}
    const walker = doc.createTreeWalker(doc.body || doc.documentElement, NodeFilter.SHOW_TEXT, {{
      acceptNode(node) {{
        if (!node.nodeValue || !node.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
        const parent = node.parentElement;
        if (!parent || ['SCRIPT','STYLE','NOSCRIPT','TEXTAREA','INPUT'].includes(parent.tagName)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }}
    }});
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    for (const node of nodes) {{
      const text = node.nodeValue || '';
      const lower = hay(text);
      if (!lower.includes(needle)) continue;
      const frag = doc.createDocumentFragment();
      let last = 0;
      let pos = 0;
      while ((pos = lower.indexOf(needle, last)) !== -1) {{
        if (pos > last) frag.appendChild(doc.createTextNode(text.slice(last, pos)));
        const mark = doc.createElement('mark');
        mark.setAttribute('data-lc-find', '1');
        mark.textContent = text.slice(pos, pos + query.length);
        frag.appendChild(mark);
        matches += 1;
        last = pos + query.length;
      }}
      if (last < text.length) frag.appendChild(doc.createTextNode(text.slice(last)));
      if (node.parentNode) node.parentNode.replaceChild(frag, node);
    }}
  }});
  const marks = allMarks();
  if (marks[0]) {{
    marks[0].classList.add('lc-active');
    marks[0].scrollIntoView({{ block: 'center', inline: 'nearest' }});
  }}
  report(matches, matches ? 1 : 0);
}})()"#,
        encoded = encoded,
        forward = if forward { "true" } else { "false" },
        find_next = if find_next { "true" } else { "false" },
        match_case = if match_case { "true" } else { "false" }
    );
    let _ = view.eval(&script);
    Ok(json!(true))
}

fn set_zoom(app: &AppHandle, payload: &Value) -> Result<Value, String> {
    let scale = payload
        .get("scale")
        .and_then(Value::as_f64)
        .unwrap_or(1.0)
        .clamp(0.5, 5.0);
    for label in known_labels() {
        if let Some(view) = app.get_webview(&label) {
            let _ = view.set_zoom(scale);
        }
    }
    Ok(json!(true))
}

fn status(app: &AppHandle) -> Result<Value, String> {
    let label = active_label();
    let (back, forward) = if label.is_empty() { (false, false) } else { resolved_flags(app, &label, flags(&label)) };
    Ok(json!({
        "open": !label.is_empty() && app.get_webview(&label).is_some(),
        "tabId": if label.is_empty() { Value::Null } else { json!(tab_id_of(&label)) },
        "url": if label.is_empty() { Value::Null } else { json!(current_url(&label)) },
        "canGoBack": back,
        "canGoForward": forward,
    }))
}

pub fn destroy(app: &AppHandle) {
    for label in known_labels() {
        if let Some(view) = app.get_webview(&label) {
            let _ = view.close();
        }
        forget_alt_f4_guard(&label);
    }
    WANTED.store(false, Ordering::SeqCst);
    COVERED.store(0, Ordering::SeqCst);
    if let Ok(mut tabs) = browser_tabs().lock() {
        tabs.nav.clear();
        tabs.labels.clear();
        tabs.active.clear();
    }
}

fn alt_f4_guarded() -> &'static Mutex<HashSet<String>> {
    static GUARDED: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    GUARDED.get_or_init(|| Mutex::new(HashSet::new()))
}

pub fn forget_alt_f4_guard(label: &str) {
    if let Ok(mut guarded) = alt_f4_guarded().lock() {
        guarded.remove(label);
    }
}

pub fn install_alt_f4_guard(app: &AppHandle, label: &str) {
    #[cfg(windows)]
    {
        let mut guarded = match alt_f4_guarded().lock() {
            Ok(guarded) => guarded,
            Err(poisoned) => poisoned.into_inner(),
        };
        if !guarded.insert(label.to_string()) {
            return;
        }
        drop(guarded);
        let Some(view) = app.get_webview(label) else {
            forget_alt_f4_guard(label);
            return;
        };
        let app = app.clone();
        let (tx, rx) = std::sync::mpsc::sync_channel(1);
        let queued = view
            .with_webview(move |platform| unsafe {
                let mut token = 0_i64;
                let handler = webview2_com::AcceleratorKeyPressedEventHandler::create(Box::new(
                    move |_controller, args| {
                        let Some(args) = args else {
                            return Ok(());
                        };
                        let mut kind = webview2_com::Microsoft::Web::WebView2::Win32::COREWEBVIEW2_KEY_EVENT_KIND(0);
                        let mut key = 0_u32;
                        let mut status = webview2_com::Microsoft::Web::WebView2::Win32::COREWEBVIEW2_PHYSICAL_KEY_STATUS::default();
                        if args.KeyEventKind(&mut kind).is_err()
                            || args.VirtualKey(&mut key).is_err()
                            || args.PhysicalKeyStatus(&mut status).is_err()
                        {
                            return Ok(());
                        }
                        let key_down = kind
                            == webview2_com::Microsoft::Web::WebView2::Win32::COREWEBVIEW2_KEY_EVENT_KIND_KEY_DOWN
                            || kind
                                == webview2_com::Microsoft::Web::WebView2::Win32::COREWEBVIEW2_KEY_EVENT_KIND_SYSTEM_KEY_DOWN;
                        if key_down && !status.WasKeyDown.as_bool() && !status.IsKeyReleased.as_bool() && key == 0x54 && !status.IsMenuKeyDown.as_bool() {
                            let ctrl = windows_sys::Win32::UI::Input::KeyboardAndMouse::GetAsyncKeyState(0x11) < 0;
                            let shift = windows_sys::Win32::UI::Input::KeyboardAndMouse::GetAsyncKeyState(0x10) < 0;
                            if ctrl && !shift {
                                let _ = args.SetHandled(true);
                                let app = app.clone();
                                std::thread::spawn(move || {
                                    let _ = app.run_on_main_thread({
                                        let app = app.clone();
                                        move || {
                                            let _ = app.emit("browser://new-tab", json!({}));
                                        }
                                    });
                                });
                            }
                        }
                        if key_down && key == 0x73 && status.IsMenuKeyDown.as_bool() && !status.IsKeyReleased.as_bool() {
                            let _ = args.SetHandled(true);
                            let app = app.clone();
                            std::thread::spawn(move || {
                                let _ = app.run_on_main_thread({
                                    let app = app.clone();
                                    move || crate::tray::hide_window(&app)
                                });
                            });
                        }
                        Ok(())
                    },
                ));
                let added = platform
                    .controller()
                    .add_AcceleratorKeyPressed(&handler, &mut token)
                    .is_ok();
                let _ = tx.send(added);
            })
            .is_ok();
        let installed = queued && rx.recv_timeout(Duration::from_millis(500)).unwrap_or(false);
        if !installed {
            forget_alt_f4_guard(label);
        }
    }
    #[cfg(not(windows))]
    {
        let _ = (app, label);
    }
}

pub fn hide_if_open(app: &AppHandle) {
    for label in known_labels() {
        if let Some(view) = app.get_webview(&label) {
            let _ = view.hide();
        }
    }
}

pub fn restore_if_wanted(app: &AppHandle) {
    apply_visibility(app);
}

pub fn set_overlay(app: &AppHandle, covered: bool) {
    let _ = set_covered(app, &json!({ "covered": covered }));
}
