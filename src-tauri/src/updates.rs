use crate::config;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

const GITHUB_RELEASES: &str =
    "https://api.github.com/repos/wzd24/agent-v2/releases?per_page=20";

pub fn check() -> Value {
    let current = env!("CARGO_PKG_VERSION").to_string();
    let prefs = config::read_preferences();
    let configured = prefs
        .get("update_feed_url")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_string();
    let feed = resolve_feed(&configured);
    let mut latest = String::new();
    let mut url = String::new();
    let mut notes = String::new();
    let mut error = String::new();
    let mut source: String;
    match fetch_json(&feed) {
        Ok(data) => {
            source = if configured.is_empty() {
                "github-releases".into()
            } else {
                "feed".into()
            };
            match release_item(data) {
                Some(item) => {
                    latest = version_of(&item);
                    url = link_of(&item);
                    notes = notes_of(&item);
                    if latest.is_empty() {
                        error = no_release_error(configured.is_empty());
                    }
                }
                None => error = no_release_error(configured.is_empty()),
            }
        }
        Err(detail) => {
            error = feed_error(&detail, configured.is_empty());
            source = if configured.is_empty() {
                "github-releases".into()
            } else {
                "feed".into()
            };
        }
    }
    if configured.is_empty() && latest.is_empty() {
        if let Some(tag) = latest_git_tag() {
            latest = tag;
            url.clear();
            notes.clear();
            error.clear();
            source = "git-tags".into();
        }
    }
    let newer = is_newer(&latest, &current);
    json!({
        "current": current,
        "latest": latest,
        "newer": newer,
        "url": url,
        "notes": notes,
        "source": if source.is_empty() { "local" } else { &source },
        "error": error,
        "checkedAt": now_stamp(),
    })
}

pub fn check_and_store() -> Value {
    let result = check();
    let checked = result.get("checkedAt").cloned().unwrap_or(json!(""));
    let _ = config::write_preference("last_update_check", checked);
    let _ = config::write_preference("last_update_result", result.clone());
    result
}

fn resolve_feed(configured: &str) -> String {
    let raw = if configured.is_empty() {
        GITHUB_RELEASES.to_string()
    } else {
        configured.to_string()
    };
    let trimmed = raw.trim_end_matches('/');
    if let Some(base) = trimmed.strip_suffix("/releases/latest") {
        if base.contains("://api.github.com/") {
            return format!("{base}/releases?per_page=20");
        }
    }
    raw
}

fn release_item(data: Value) -> Option<Value> {
    if let Some(items) = data.as_array() {
        return select_release(items);
    }
    Some(data)
}

fn select_release(items: &[Value]) -> Option<Value> {
    let mut best: Option<(String, Value)> = None;
    for item in items {
        if item.get("draft").and_then(Value::as_bool) == Some(true) {
            continue;
        }
        let version = version_of(item);
        if version.is_empty() {
            continue;
        }
        let replace = match &best {
            None => true,
            Some((current, _)) => {
                compare_versions(&version, current) == std::cmp::Ordering::Greater
            }
        };
        if replace {
            best = Some((version, item.clone()));
        }
    }
    best.map(|(_, item)| item)
}

fn no_release_error(using_default: bool) -> String {
    if using_default {
        "GitHub 仓库可以访问，但还没有任何 Release。/releases/latest 在没有发版时会返回 404。发布一个如 v0.2.0 的 Release 并附上安装包后即可检查到更新。".into()
    } else {
        "更新源里没有可用的版本号。".into()
    }
}

fn fetch_json(url: &str) -> Result<Value, String> {
    let mut request = ureq::get(url).timeout(Duration::from_secs(12));
    if url.contains("://api.github.com/") {
        request = request
            .set("User-Agent", "local-codex")
            .set("Accept", "application/vnd.github+json")
            .set("X-GitHub-Api-Version", "2022-11-28");
    }
    let mut text = String::new();
    request
        .call()
        .map_err(|err| match err {
            ureq::Error::Status(code, _) => format!("HTTP {code}"),
            other => other.to_string(),
        })?
        .into_reader()
        .take(512 * 1024)
        .read_to_string(&mut text)
        .map_err(|err| err.to_string())?;
    serde_json::from_str(&text).map_err(|err| err.to_string())
}

fn notes_of(item: &Value) -> String {
    item.get("notes")
        .or_else(|| item.get("body"))
        .or_else(|| item.get("changelog"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string()
}

fn link_of(item: &Value) -> String {
    if let Some(url) = asset_download_url(item) {
        return url;
    }
    let download = item
        .get("downloadUrl")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    if !download.is_empty() {
        return download.to_string();
    }
    let html = item.get("html_url").and_then(Value::as_str).unwrap_or("").trim();
    let url = item.get("url").and_then(Value::as_str).unwrap_or("").trim();
    if !html.is_empty() && url.contains("api.github.com") {
        return html.to_string();
    }
    if !url.is_empty() {
        return url.to_string();
    }
    html.to_string()
}

fn asset_download_url(item: &Value) -> Option<String> {
    let assets = item.get("assets")?.as_array()?;
    let name_of = |asset: &Value| {
        asset
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_ascii_lowercase()
    };
    let matches_platform = |name: &str| match std::env::consts::OS {
        "windows" => name.ends_with(".exe") || name.ends_with(".msi"),
        "macos" => name.ends_with(".dmg") || name.contains(".app.tar.gz"),
        _ => name.ends_with(".appimage") || name.ends_with(".deb") || name.ends_with(".rpm"),
    };
    let asset = assets
        .iter()
        .find(|asset| matches_platform(&name_of(asset)))
        .or_else(|| assets.first())?;
    let url = asset
        .get("browser_download_url")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    if url.is_empty() {
        None
    } else {
        Some(url.to_string())
    }
}

fn feed_error(detail: &str, using_default: bool) -> String {
    if using_default && detail.contains("HTTP 404") {
        return "GitHub 返回 404。仓库公开时，/releases/latest 在还没有 Release 时也会 404。".into();
    }
    if let Some(code) = detail.strip_prefix("HTTP ") {
        return format!("更新源返回 HTTP {code}。");
    }
    "更新源暂时无法读取。".into()
}

fn version_of(item: &Value) -> String {
    let latest = item
        .get("version")
        .or_else(|| item.get("tag_name"))
        .or_else(|| item.get("name"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .trim_start_matches(['v', 'V'])
        .to_string();
    if parse_version(&latest).is_some() {
        latest
    } else {
        String::new()
    }
}

fn latest_git_tag() -> Option<String> {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..");
    let mut command = Command::new("git");
    command
        .args(["ls-remote", "--tags", "--refs", "origin"])
        .current_dir(&root);
    crate::mcp::hide_command(&mut command);
    let output = command.output().ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&output.stdout);
    let mut versions: Vec<String> = text
        .lines()
        .filter_map(|line| {
            line.split("refs/tags/")
                .nth(1)
                .map(|tag| tag.trim().trim_start_matches('v').to_string())
        })
        .filter(|tag| parse_version(tag).is_some())
        .collect();
    versions.sort_by(|left, right| compare_versions(left, right));
    versions.pop()
}

fn parse_version(value: &str) -> Option<[u32; 3]> {
    let mut parts = value.split('.');
    Some([
        parts.next()?.parse().ok()?,
        parts.next()?.parse().ok()?,
        parts.next()?.parse().ok()?,
    ])
}

fn compare_versions(left: &str, right: &str) -> std::cmp::Ordering {
    match (parse_version(left), parse_version(right)) {
        (Some(a), Some(b)) => a.cmp(&b),
        _ => std::cmp::Ordering::Equal,
    }
}

fn is_newer(latest: &str, current: &str) -> bool {
    matches!(compare_versions(latest, current), std::cmp::Ordering::Greater)
}

fn now_stamp() -> String {
    let Ok(duration) = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH) else {
        return String::new();
    };
    let secs = duration.as_secs();
    let (year, month, day) = civil_from_days((secs / 86_400) as i64);
    let rem = secs % 86_400;
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}Z",
        rem / 3600,
        (rem % 3600) / 60,
        rem % 60
    )
}

fn civil_from_days(days: i64) -> (i32, u32, u32) {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    (y as i32, m as u32, d as u32)
}

const MAX_INSTALLER_BYTES: u64 = 2 * 1024 * 1024 * 1024;

struct ActiveDownload {
    generation: u64,
    version: String,
    url: String,
    phase: String,
    downloaded: u64,
    total: u64,
    path: String,
    error: String,
}

fn downloads() -> &'static Mutex<Option<ActiveDownload>> {
    static SLOT: OnceLock<Mutex<Option<ActiveDownload>>> = OnceLock::new();
    SLOT.get_or_init(|| Mutex::new(None))
}

pub fn begin_download(
    url: String,
    version: String,
    emit: impl Fn(Value) + Send + Sync + 'static,
) -> Result<Value, String> {
    let parsed = allowed_update_url(&url)?;
    let file_name = installer_file_name(&parsed)?;
    let version_key = safe_version(&version);
    {
        let mut slot = downloads().lock().map_err(|_| "更新下载状态不可用".to_string())?;
        if let Some(state) = slot.as_ref() {
            if state.version == version
                && state.url == url
                && state.phase == "ready"
                && Path::new(&state.path).is_file()
            {
                let snapshot = download_snapshot(state);
                emit(snapshot.clone());
                return Ok(snapshot);
            }
            if state.version == version && state.url == url && state.phase == "downloading" {
                return Ok(download_snapshot(state));
            }
        }
        if let Some(path) = completed_installer(&version_key, &url, &file_name) {
            let bytes = std::fs::metadata(&path).map(|meta| meta.len()).unwrap_or(0);
            let state = ActiveDownload {
                generation: slot.as_ref().map(|state| state.generation).unwrap_or(1),
                version: version.clone(),
                url: url.clone(),
                phase: "ready".into(),
                downloaded: bytes,
                total: bytes,
                path: path.display().to_string(),
                error: String::new(),
            };
            let snapshot = download_snapshot(&state);
            *slot = Some(state);
            emit(snapshot.clone());
            return Ok(snapshot);
        }
        let (resumed, resumed_total) = partial_progress(&version_key, &url);
        let generation = slot.as_ref().map(|state| state.generation.saturating_add(1)).unwrap_or(1);
        let state = ActiveDownload {
            generation,
            version: version.clone(),
            url: url.clone(),
            phase: "downloading".into(),
            downloaded: resumed,
            total: resumed_total,
            path: String::new(),
            error: String::new(),
        };
        let snapshot = download_snapshot(&state);
        *slot = Some(state);
        emit(snapshot.clone());
        let generation = snapshot.get("generation").and_then(Value::as_u64).unwrap_or(generation);
        std::thread::spawn(move || {
            let result = download_installer(&url, &version_key, &file_name, generation, &emit, 0);
            let mut slot = match downloads().lock() {
                Ok(slot) => slot,
                Err(_) => return,
            };
            let Some(state) = slot.as_mut() else {
                return;
            };
            if state.generation != generation {
                return;
            }
            match result {
                Ok((path, total)) => {
                    state.phase = "ready".into();
                    state.path = path;
                    state.downloaded = total;
                    state.total = total;
                    state.error.clear();
                }
                Err(error) => {
                    state.phase = "error".into();
                    state.error = error;
                }
            }
            emit(download_snapshot(state));
        });
        Ok(snapshot)
    }
}

pub fn launch_downloaded(version: &str) -> Result<String, String> {
    let path = {
        let slot = downloads().lock().map_err(|_| "更新下载状态不可用".to_string())?;
        let state = slot.as_ref().ok_or("更新还没有下载完成")?;
        if state.version != version || state.phase != "ready" {
            return Err("更新还没有下载完成".into());
        }
        state.path.clone()
    };
    if !Path::new(&path).is_file() {
        return Err("更新包不存在，请重新下载".into());
    }
    launch_installer(Path::new(&path))?;
    Ok(path)
}

fn download_snapshot(state: &ActiveDownload) -> Value {
    json!({
        "generation": state.generation,
        "version": state.version,
        "url": state.url,
        "phase": state.phase,
        "downloaded": state.downloaded,
        "total": state.total,
        "error": state.error,
    })
}

const DOWNLOAD_THREADS: usize = 4;

#[derive(Clone, Serialize, Deserialize)]
struct DownloadManifest {
    url: String,
    version: String,
    total: u64,
    etag: String,
    chunks: Vec<ChunkSpan>,
}

#[derive(Clone, Copy, Serialize, Deserialize)]
struct ChunkSpan {
    start: u64,
    end: u64,
}

#[derive(Serialize, Deserialize)]
struct CompletedDownload {
    url: String,
    version: String,
    total: u64,
    bytes: u64,
}

fn download_installer(
    url: &str,
    version_key: &str,
    file_name: &str,
    generation: u64,
    emit: &(impl Fn(Value) + Sync),
    attempt: u8,
) -> Result<(String, u64), String> {
    let dir = update_dir(version_key);
    std::fs::create_dir_all(&dir).map_err(|err| format!("无法创建更新目录：{err}"))?;
    let dest = dir.join(file_name);
    if let Some(path) = completed_installer(version_key, url, file_name) {
        let bytes = std::fs::metadata(&path).map(|meta| meta.len()).unwrap_or(0);
        return Ok((path.display().to_string(), bytes));
    }
    let probe = probe_download(url)?;
    if !probe.ranges {
        clear_partial(&dir);
        let total = stream_full_download(&probe.body, &dest, generation, emit)?;
        write_complete(&dir, url, version_key, total)?;
        return Ok((dest.display().to_string(), total));
    }
    if probe.total == 0 || probe.total > MAX_INSTALLER_BYTES {
        return Err("更新包大小无效".into());
    }
    let manifest = prepare_manifest(&dir, url, version_key, probe.total, &probe.etag)?;
    let downloaded = Arc::new(AtomicU64::new(count_downloaded(&dir, &manifest.chunks)));
    publish_progress(generation, downloaded.load(Ordering::Relaxed), manifest.total, emit);
    if count_downloaded(&dir, &manifest.chunks) == manifest.total {
        assemble_chunks(&dir, &dest, &manifest.chunks)?;
        write_complete(&dir, url, version_key, manifest.total)?;
        clear_partial(&dir);
        return Ok((dest.display().to_string(), manifest.total));
    }
    let stop = Arc::new(AtomicBool::new(false));
    let last_emit = Arc::new(Mutex::new(Instant::now() - Duration::from_secs(1)));
    let manifest_chunks = manifest.chunks.clone();
    let etag = manifest.etag.clone();
    let total = manifest.total;
    let error: Mutex<Option<String>> = Mutex::new(None);
    std::thread::scope(|scope| {
        for (index, chunk) in manifest_chunks.iter().copied().enumerate() {
            let dir = dir.clone();
            let url = url.to_string();
            let etag = etag.clone();
            let downloaded = Arc::clone(&downloaded);
            let stop = Arc::clone(&stop);
            let last_emit = Arc::clone(&last_emit);
            let error = &error;
            scope.spawn(move || {
                if let Err(err) = download_chunk(
                    &url,
                    &dir,
                    index,
                    chunk,
                    &etag,
                    total,
                    generation,
                    &downloaded,
                    &stop,
                    &last_emit,
                    emit,
                ) {
                    stop.store(true, Ordering::Relaxed);
                    if let Ok(mut slot) = error.lock() {
                        if slot.is_none() {
                            *slot = Some(err);
                        }
                    }
                }
            });
        }
    });
    if let Some(err) = error.lock().ok().and_then(|slot| slot.clone()) {
        if attempt == 0 && err.contains("已变化") {
            clear_partial(&dir);
            return download_installer(url, version_key, file_name, generation, emit, 1);
        }
        return Err(err);
    }
    if !download_still_current(generation) {
        return Err("更新下载已取消".into());
    }
    assemble_chunks(&dir, &dest, &manifest.chunks)?;
    write_complete(&dir, url, version_key, total)?;
    clear_partial(&dir);
    Ok((dest.display().to_string(), total))
}

struct Probe {
    total: u64,
    etag: String,
    ranges: bool,
    body: Vec<u8>,
}

fn probe_download(url: &str) -> Result<Probe, String> {
    let response = send_ranged(url, Some((0, 0)), "")?;
    let status = response.status();
    let etag = response.header("etag").unwrap_or("").trim().to_string();
    if status == 206 {
        let header = response.header("content-range").unwrap_or("");
        let (_, _, total) = parse_content_range(header).ok_or("更新服务器没有返回文件大小")?;
        let mut body = Vec::new();
        response.into_reader().take(8).read_to_end(&mut body).ok();
        return Ok(Probe { total, etag, ranges: true, body });
    }
    if status == 200 {
        let total = response
            .header("content-length")
            .and_then(|value| value.parse::<u64>().ok())
            .unwrap_or(0);
        let mut body = Vec::new();
        response
            .into_reader()
            .take(MAX_INSTALLER_BYTES + 1)
            .read_to_end(&mut body)
            .map_err(|err| format!("下载更新失败：{err}"))?;
        if body.len() as u64 > MAX_INSTALLER_BYTES {
            return Err("更新包过大".into());
        }
        return Ok(Probe {
            total: if total == 0 { body.len() as u64 } else { total },
            etag,
            ranges: false,
            body,
        });
    }
    Err(format!("下载更新失败：HTTP {status}"))
}

fn stream_full_download(
    body: &[u8],
    dest: &Path,
    generation: u64,
    emit: &impl Fn(Value),
) -> Result<u64, String> {
    if !download_still_current(generation) {
        return Err("更新下载已取消".into());
    }
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent).map_err(|err| format!("无法创建更新目录：{err}"))?;
    }
    let mut file = std::fs::File::create(dest).map_err(|err| format!("无法保存更新包：{err}"))?;
    file.write_all(body).map_err(|err| format!("无法保存更新包：{err}"))?;
    file.flush().map_err(|err| format!("无法保存更新包：{err}"))?;
    let total = body.len() as u64;
    publish_progress(generation, total, total, emit);
    Ok(total)
}

fn prepare_manifest(
    dir: &Path,
    url: &str,
    version: &str,
    total: u64,
    etag: &str,
) -> Result<DownloadManifest, String> {
    if let Some(saved) = read_manifest(dir) {
        if saved.url == url && saved.version == version && saved.total == total && (etag.is_empty() || saved.etag == etag) {
            return Ok(saved);
        }
        clear_partial(dir);
    }
    let manifest = DownloadManifest {
        url: url.to_string(),
        version: version.to_string(),
        total,
        etag: etag.to_string(),
        chunks: plan_chunks(total, download_thread_count(total)),
    };
    write_manifest(dir, &manifest)?;
    Ok(manifest)
}

fn download_chunk(
    url: &str,
    dir: &Path,
    index: usize,
    chunk: ChunkSpan,
    etag: &str,
    total: u64,
    generation: u64,
    downloaded: &AtomicU64,
    stop: &AtomicBool,
    last_emit: &Mutex<Instant>,
    emit: &(impl Fn(Value) + Sync),
) -> Result<(), String> {
    let path = chunk_path(dir, index);
    let file_len = std::fs::metadata(&path).map(|meta| meta.len()).unwrap_or(0);
    let expected = chunk.end - chunk.start + 1;
    if file_len > expected {
        let file = std::fs::OpenOptions::new().write(true).open(&path).map_err(|err| format!("无法保存更新包：{err}"))?;
        file.set_len(expected).map_err(|err| format!("无法保存更新包：{err}"))?;
        return Ok(());
    }
    let Some((start, end)) = resume_range(chunk, file_len) else {
        return Ok(());
    };
    let mut have = file_len;
    let response = send_ranged(url, Some((start, end)), etag)?;
    let status = response.status();
    if status == 200 {
        return Err("更新包已变化，请重新下载".into());
    }
    if status != 206 {
        return Err(format!("下载更新失败：HTTP {status}"));
    }
    if let Some(header) = response.header("content-range") {
        if let Some((got_start, got_end, _)) = parse_content_range(header) {
            if got_start != start || got_end != end {
                return Err("更新服务器返回了错误的续传范围".into());
            }
        }
    }
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|err| format!("无法保存更新包：{err}"))?;
    let mut reader = response.into_reader().take(expected - have);
    let mut buf = [0u8; 64 * 1024];
    let mut since_flush = 0u64;
    loop {
        if stop.load(Ordering::Relaxed) || !download_still_current(generation) {
            let _ = file.flush();
            return Err("更新下载已取消".into());
        }
        let read = reader.read(&mut buf).map_err(|err| format!("下载更新失败：{err}"))?;
        if read == 0 {
            break;
        }
        file.write_all(&buf[..read]).map_err(|err| format!("无法保存更新包：{err}"))?;
        have += read as u64;
        downloaded.fetch_add(read as u64, Ordering::Relaxed);
        since_flush += read as u64;
        if since_flush >= 256 * 1024 {
            file.flush().map_err(|err| format!("无法保存更新包：{err}"))?;
            since_flush = 0;
        }
        if let Ok(mut last) = last_emit.lock() {
            if last.elapsed() >= Duration::from_millis(200) {
                *last = Instant::now();
                publish_progress(generation, downloaded.load(Ordering::Relaxed), total, emit);
            }
        }
        if have > expected {
            return Err("更新分块超出范围".into());
        }
    }
    file.flush().map_err(|err| format!("无法保存更新包：{err}"))?;
    if have != expected {
        return Err("更新分块下载不完整".into());
    }
    Ok(())
}

fn update_dir(version_key: &str) -> PathBuf {
    std::env::temp_dir().join("local-codex-updates").join(version_key)
}

fn completed_installer(version_key: &str, url: &str, file_name: &str) -> Option<PathBuf> {
    let dir = update_dir(version_key);
    let text = std::fs::read_to_string(dir.join("complete.json")).ok()?;
    let marker: CompletedDownload = serde_json::from_str(&text).ok()?;
    if marker.url != url || marker.bytes == 0 || marker.bytes != marker.total {
        return None;
    }
    let path = dir.join(file_name);
    let len = std::fs::metadata(&path).ok()?.len();
    if len == marker.bytes { Some(path) } else { None }
}

fn partial_progress(version_key: &str, url: &str) -> (u64, u64) {
    let dir = update_dir(version_key);
    let Some(manifest) = read_manifest(&dir) else {
        return (0, 0);
    };
    if manifest.url != url {
        return (0, 0);
    }
    (count_downloaded(&dir, &manifest.chunks), manifest.total)
}

fn send_ranged(url: &str, range: Option<(u64, u64)>, if_range: &str) -> Result<ureq::Response, String> {
    let agent = ureq::AgentBuilder::new().redirects(0).build();
    let mut current = url.to_string();
    for _ in 0..8 {
        let mut request = agent
            .get(&current)
            .timeout(Duration::from_secs(600))
            .set("User-Agent", "local-codex")
            .set("Accept", "application/octet-stream");
        if let Some((start, end)) = range {
            request = request.set("Range", &format!("bytes={start}-{end}"));
        }
        if !if_range.is_empty() {
            request = request.set("If-Range", if_range);
        }
        let response = match request.call() {
            Ok(response) => response,
            Err(ureq::Error::Status(code, response)) if (300..400).contains(&code) => response,
            Err(ureq::Error::Status(code, _)) => return Err(format!("下载更新失败：HTTP {code}")),
            Err(err) => return Err(format!("下载更新失败：{err}")),
        };
        if (300..400).contains(&response.status()) {
            let location = response
                .header("location")
                .ok_or("更新下载没有跳转地址")?
                .to_string();
            current = resolve_redirect(&current, &location)?;
            continue;
        }
        return Ok(response);
    }
    Err("更新下载跳转过多".into())
}

fn resolve_redirect(base: &str, location: &str) -> Result<String, String> {
    let base = url::Url::parse(base).map_err(|_| "更新地址无效".to_string())?;
    let next = base.join(location).map_err(|_| "更新下载跳转地址无效".to_string())?;
    if next.scheme() != "https" {
        return Err("只允许通过 HTTPS 下载更新".into());
    }
    let host = next.host_str().unwrap_or("");
    if host.is_empty() || is_local_update_host(host) {
        return Err("不允许从本地地址下载更新".into());
    }
    Ok(next.to_string())
}

fn plan_chunks(total: u64, threads: usize) -> Vec<ChunkSpan> {
    if total == 0 {
        return Vec::new();
    }
    let threads = threads.max(1);
    if total < threads as u64 {
        return vec![ChunkSpan { start: 0, end: total - 1 }];
    }
    let size = total / threads as u64;
    let mut chunks = Vec::with_capacity(threads);
    let mut start = 0u64;
    for index in 0..threads {
        let end = if index + 1 == threads { total - 1 } else { start + size - 1 };
        chunks.push(ChunkSpan { start, end });
        start = end + 1;
    }
    chunks
}

fn download_thread_count(total: u64) -> usize {
    if total < 8 * 1024 * 1024 { 1 } else { DOWNLOAD_THREADS }
}

fn resume_range(chunk: ChunkSpan, file_len: u64) -> Option<(u64, u64)> {
    let expected = chunk.end - chunk.start + 1;
    let have = file_len.min(expected);
    if have >= expected {
        None
    } else {
        Some((chunk.start + have, chunk.end))
    }
}

fn parse_content_range(header: &str) -> Option<(u64, u64, u64)> {
    let rest = header.trim().strip_prefix("bytes ")?;
    let (range, total) = rest.split_once('/')?;
    let (start, end) = range.split_once('-')?;
    Some((start.parse().ok()?, end.parse().ok()?, total.parse().ok()?))
}

fn read_manifest(dir: &Path) -> Option<DownloadManifest> {
    let text = std::fs::read_to_string(dir.join("manifest.json")).ok()?;
    serde_json::from_str(&text).ok()
}

fn write_manifest(dir: &Path, manifest: &DownloadManifest) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(|err| format!("无法创建更新目录：{err}"))?;
    let text = serde_json::to_string(manifest).map_err(|err| format!("无法保存下载进度：{err}"))?;
    let temp = dir.join("manifest.json.tmp");
    std::fs::write(&temp, text).map_err(|err| format!("无法保存下载进度：{err}"))?;
    std::fs::rename(&temp, dir.join("manifest.json")).map_err(|err| format!("无法保存下载进度：{err}"))?;
    Ok(())
}

fn write_complete(dir: &Path, url: &str, version: &str, total: u64) -> Result<(), String> {
    let marker = CompletedDownload {
        url: url.to_string(),
        version: version.to_string(),
        total,
        bytes: total,
    };
    let text = serde_json::to_string(&marker).map_err(|err| format!("无法保存下载进度：{err}"))?;
    std::fs::write(dir.join("complete.json"), text).map_err(|err| format!("无法保存下载进度：{err}"))
}

fn clear_partial(dir: &Path) {
    let _ = std::fs::remove_file(dir.join("manifest.json"));
    for index in 0..16 {
        let _ = std::fs::remove_file(chunk_path(dir, index));
    }
}

fn chunk_path(dir: &Path, index: usize) -> PathBuf {
    dir.join(format!("chunk-{index}.part"))
}

fn count_downloaded(dir: &Path, chunks: &[ChunkSpan]) -> u64 {
    chunks.iter().enumerate().map(|(index, chunk)| {
        let expected = chunk.end - chunk.start + 1;
        std::fs::metadata(chunk_path(dir, index)).map(|meta| meta.len()).unwrap_or(0).min(expected)
    }).sum()
}

fn assemble_chunks(dir: &Path, dest: &Path, chunks: &[ChunkSpan]) -> Result<(), String> {
    let staging = dest.with_extension("assembling");
    let mut output = std::fs::File::create(&staging).map_err(|err| format!("无法保存更新包：{err}"))?;
    for (index, chunk) in chunks.iter().enumerate() {
        let expected = chunk.end - chunk.start + 1;
        let mut input = std::fs::File::open(chunk_path(dir, index)).map_err(|_| "更新分块不完整".to_string())?;
        let copied = std::io::copy(&mut input, &mut output).map_err(|err| format!("无法保存更新包：{err}"))?;
        if copied != expected {
            let _ = std::fs::remove_file(&staging);
            return Err("更新分块不完整".into());
        }
    }
    output.flush().map_err(|err| format!("无法保存更新包：{err}"))?;
    drop(output);
    if dest.exists() {
        let _ = std::fs::remove_file(dest);
    }
    std::fs::rename(&staging, dest).map_err(|err| format!("无法保存更新包：{err}"))?;
    Ok(())
}

fn publish_progress(generation: u64, downloaded: u64, total: u64, emit: &impl Fn(Value)) {
    let Ok(mut slot) = downloads().lock() else {
        return;
    };
    let Some(state) = slot.as_mut() else {
        return;
    };
    if state.generation != generation || state.phase != "downloading" {
        return;
    }
    state.downloaded = downloaded;
    state.total = total;
    emit(download_snapshot(state));
}

fn download_still_current(generation: u64) -> bool {
    downloads()
        .lock()
        .ok()
        .and_then(|slot| slot.as_ref().map(|state| state.generation == generation && state.phase == "downloading"))
        .unwrap_or(false)
}

fn launch_installer(path: &Path) -> Result<(), String> {
    if !cfg!(windows) {
        return Err("当前平台还不能自动安装更新".into());
    }
    Command::new(path)
        .spawn()
        .map(|_| ())
        .map_err(|err| format!("无法启动安装程序：{err}"))
}

pub fn allowed_update_url(url: &str) -> Result<url::Url, String> {
    let parsed = url::Url::parse(url.trim()).map_err(|_| "更新地址无效".to_string())?;
    if parsed.scheme() != "https" {
        return Err("只允许通过 HTTPS 下载更新".into());
    }
    let host = parsed.host_str().unwrap_or("");
    if host.is_empty() || is_local_update_host(host) {
        return Err("不允许从本地地址下载更新".into());
    }
    installer_file_name(&parsed)?;
    Ok(parsed)
}

fn installer_file_name(url: &url::Url) -> Result<String, String> {
    let name = url
        .path_segments()
        .and_then(|mut parts| parts.next_back())
        .unwrap_or("")
        .trim();
    if name.is_empty() || name.contains("..") || name.contains(['/', '\\', ':']) {
        return Err("更新包文件名无效".into());
    }
    let lower = name.to_ascii_lowercase();
    if !(lower.ends_with(".exe") || lower.ends_with(".msi")) {
        return Err("这个版本没有可安装的更新包".into());
    }
    Ok(name.to_string())
}

fn safe_version(version: &str) -> String {
    let cleaned: String = version
        .chars()
        .filter(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | '-'))
        .collect();
    if cleaned.is_empty() {
        "update".into()
    } else {
        cleaned
    }
}

fn is_local_update_host(host: &str) -> bool {
    let host = host.trim_matches(['[', ']']).to_ascii_lowercase();
    if host == "localhost" || host.ends_with(".local") || host.ends_with(".localhost") {
        return true;
    }
    let Ok(ip) = host.parse::<std::net::IpAddr>() else {
        return false;
    };
    match ip {
        std::net::IpAddr::V4(ip) => {
            ip.is_private() || ip.is_loopback() || ip.is_link_local() || ip.is_unspecified()
        }
        std::net::IpAddr::V6(ip) => ip.is_loopback() || ip.is_unspecified() || is_unique_local_v6(ip),
    }
}

fn is_unique_local_v6(ip: std::net::Ipv6Addr) -> bool {
    (ip.segments()[0] & 0xfe00) == 0xfc00
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn version_of_keeps_semver_and_drops_garbage() {
        assert_eq!(version_of(&json!({ "version": "v1.2.3" })), "1.2.3");
        assert_eq!(version_of(&json!({ "tag_name": "0.1.0" })), "0.1.0");
        assert_eq!(version_of(&json!({ "name": "latest" })), "");
        assert_eq!(version_of(&json!({ "version": "not-a-version" })), "");
    }

    #[test]
    fn is_newer_compares_semver() {
        assert!(is_newer("0.2.0", "0.1.0"));
        assert!(!is_newer("0.1.0", "0.1.0"));
        assert!(!is_newer("", "0.1.0"));
    }

    #[test]
    fn github_release_prefers_installer_over_api_url() {
        let item = json!({
            "tag_name": "v0.2.0",
            "url": "https://api.github.com/repos/wzd24/agent-v2/releases/1",
            "html_url": "https://github.com/wzd24/agent-v2/releases/tag/v0.2.0",
            "body": "fixes",
            "assets": [
                {
                    "name": "notes.txt",
                    "browser_download_url": "https://github.com/wzd24/agent-v2/releases/download/v0.2.0/notes.txt"
                },
                {
                    "name": "Local Codex_0.2.0_x64-setup.exe",
                    "browser_download_url": "https://github.com/wzd24/agent-v2/releases/download/v0.2.0/Local%20Codex_0.2.0_x64-setup.exe"
                }
            ]
        });
        assert_eq!(version_of(&item), "0.2.0");
        assert_eq!(notes_of(&item), "fixes");
        let url = link_of(&item);
        if cfg!(windows) {
            assert!(url.ends_with(".exe"));
        } else {
            assert!(url.contains("github.com/wzd24/agent-v2/releases/"));
        }
        assert!(!url.contains("api.github.com"));
    }

    #[test]
    fn github_release_without_assets_uses_html_url() {
        let item = json!({
            "tag_name": "0.2.0",
            "url": "https://api.github.com/repos/wzd24/agent-v2/releases/1",
            "html_url": "https://github.com/wzd24/agent-v2/releases/tag/v0.2.0"
        });
        assert_eq!(
            link_of(&item),
            "https://github.com/wzd24/agent-v2/releases/tag/v0.2.0"
        );
    }

    #[test]
    fn latest_endpoint_404_is_not_treated_as_private() {
        let message = feed_error("HTTP 404", true);
        assert!(message.contains("404"));
        assert!(!message.contains("私有"));
        assert_eq!(feed_error("HTTP 500", false), "更新源返回 HTTP 500。");
    }

    #[test]
    fn empty_release_list_is_not_a_version() {
        assert!(release_item(json!([])).is_none());
        assert!(no_release_error(true).contains("还没有任何 Release"));
    }

    #[test]
    fn release_list_picks_highest_semver() {
        let item = release_item(json!([
            { "tag_name": "v0.1.0", "html_url": "https://github.com/wzd24/agent-v2/releases/tag/v0.1.0" },
            { "tag_name": "v0.3.0", "html_url": "https://github.com/wzd24/agent-v2/releases/tag/v0.3.0" },
            { "tag_name": "nightly", "html_url": "https://github.com/wzd24/agent-v2/releases/tag/nightly" },
            { "tag_name": "v0.2.0", "draft": true, "html_url": "https://github.com/wzd24/agent-v2/releases/tag/v0.2.0" }
        ]))
        .unwrap();
        assert_eq!(version_of(&item), "0.3.0");
    }

    #[test]
    fn chunks_cover_the_file_and_resume_from_partial_length() {
        let chunks = plan_chunks(10, 4);
        assert_eq!(chunks.first().map(|chunk| chunk.start), Some(0));
        assert_eq!(chunks.last().map(|chunk| chunk.end), Some(9));
        let mut covered = 0u64;
        for chunk in &chunks {
            covered += chunk.end - chunk.start + 1;
        }
        assert_eq!(covered, 10);
        assert_eq!(resume_range(chunks[0], 0), Some((chunks[0].start, chunks[0].end)));
        assert_eq!(resume_range(ChunkSpan { start: 0, end: 99 }, 40), Some((40, 99)));
        assert_eq!(resume_range(ChunkSpan { start: 0, end: 99 }, 100), None);
        assert_eq!(parse_content_range("bytes 40-99/100"), Some((40, 99, 100)));
        assert_eq!(download_thread_count(119 * 1024 * 1024), 4);
        assert_eq!(download_thread_count(1024), 1);
    }

    #[test]
    fn interrupted_download_resumes_from_chunk_files() {
        const TOTAL: usize = 8 * 1024 * 1024;
        const PREFIX: usize = 4096;
        let body: Vec<u8> = (0..TOTAL).map(|index| (index % 251) as u8).collect();
        let ranges = Arc::new(Mutex::new(Vec::<(u64, u64)>::new()));
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind");
        let port = listener.local_addr().expect("addr").port();
        let ranges_server = Arc::clone(&ranges);
        let body_server = body.clone();
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { continue };
                let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
                let mut header = Vec::new();
                let mut byte = [0u8; 1];
                while stream.read(&mut byte).ok() == Some(1) {
                    header.push(byte[0]);
                    if header.ends_with(b"\r\n\r\n") || header.len() > 8192 {
                        break;
                    }
                }
                let text = String::from_utf8_lossy(&header);
                let (start, end) = text
                    .lines()
                    .find_map(|line| {
                        let value = line.split_once(':')?.1.trim();
                        if !line.to_ascii_lowercase().starts_with("range:") {
                            return None;
                        }
                        let value = value.strip_prefix("bytes=")?;
                        let (start, end) = value.split_once('-')?;
                        Some((start.parse::<u64>().ok()?, end.parse::<u64>().ok()?))
                    })
                    .unwrap_or((0, body_server.len() as u64 - 1));
                if let Ok(mut log) = ranges_server.lock() {
                    log.push((start, end));
                }
                let from = start as usize;
                let to = (end as usize).saturating_add(1).min(body_server.len());
                let payload = &body_server[from..to];
                let head = format!(
                    "HTTP/1.1 206 Partial Content\r\nContent-Range: bytes {start}-{end}/{TOTAL}\r\nContent-Length: {}\r\nETag: \"v1\"\r\nAccept-Ranges: bytes\r\nConnection: close\r\n\r\n",
                    payload.len()
                );
                let _ = stream.write_all(head.as_bytes());
                let _ = stream.write_all(payload);
                let _ = stream.flush();
            }
        });

        let version_key = "9.9.9-resume";
        let dir = update_dir(version_key);
        let _ = std::fs::remove_dir_all(&dir);
        let url = format!("http://127.0.0.1:{port}/setup.exe");
        let probe = probe_download(&url).expect("probe");
        assert!(probe.ranges);
        assert_eq!(probe.total, TOTAL as u64);
        let chunks = plan_chunks(probe.total, download_thread_count(probe.total));
        assert_eq!(chunks.len(), 4);
        write_manifest(
            &dir,
            &DownloadManifest {
                url: url.clone(),
                version: version_key.into(),
                total: probe.total,
                etag: probe.etag,
                chunks: chunks.clone(),
            },
        )
        .expect("manifest");
        for (index, chunk) in chunks.iter().enumerate() {
            let from = chunk.start as usize;
            std::fs::write(chunk_path(&dir, index), &body[from..from + PREFIX]).expect("partial chunk");
        }
        if let Ok(mut log) = ranges.lock() {
            log.clear();
        }
        {
            let mut slot = downloads().lock().expect("download state");
            *slot = Some(ActiveDownload {
                generation: 7,
                version: version_key.into(),
                url: url.clone(),
                phase: "downloading".into(),
                downloaded: 0,
                total: 0,
                path: String::new(),
                error: String::new(),
            });
        }
        let emit = |_payload: Value| {};
        let resumed = download_installer(&url, version_key, "setup.exe", 7, &emit, 0).expect("resume");
        let saved = std::fs::read(&resumed.0).expect("installer");
        assert_eq!(saved, body);
        let log = ranges.lock().expect("ranges").clone();
        for chunk in &chunks {
            assert!(
                log.iter().any(|(start, end)| *start == chunk.start + PREFIX as u64 && *end == chunk.end),
                "chunk {}-{} should resume at {}",
                chunk.start,
                chunk.end,
                chunk.start + PREFIX as u64
            );
        }
        assert!(
            log.iter()
                .filter(|(start, end)| end > start)
                .all(|(start, _)| chunks.iter().all(|chunk| *start != chunk.start)),
            "resume must not request a chunk from its beginning"
        );
        let _ = std::fs::remove_dir_all(&dir);
        if let Ok(mut slot) = downloads().lock() {
            *slot = None;
        }
    }

    #[test]
    fn installer_url_must_be_https_package() {
        assert!(allowed_update_url(
            "https://github.com/wzd24/agent-v2/releases/download/v0.1.3/Local-Codex_0.1.3_x64-setup.exe"
        )
        .is_ok());
        assert!(allowed_update_url("http://github.com/wzd24/agent-v2/releases/download/v0.1.3/setup.exe").is_err());
        assert!(allowed_update_url("https://github.com/wzd24/agent-v2/releases/tag/v0.1.3").is_err());
        assert!(allowed_update_url("https://127.0.0.1/setup.exe").is_err());
        assert!(allowed_update_url("https://localhost/setup.exe").is_err());
    }

    #[test]
    fn releases_latest_url_reads_the_list_instead() {
        assert_eq!(
            resolve_feed(""),
            "https://api.github.com/repos/wzd24/agent-v2/releases?per_page=20"
        );
        assert_eq!(
            resolve_feed("https://api.github.com/repos/wzd24/agent-v2/releases/latest"),
            "https://api.github.com/repos/wzd24/agent-v2/releases?per_page=20"
        );
    }
}
