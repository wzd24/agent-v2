use crate::config;
use crate::engine::Engine;
use crate::githost;
use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

pub fn script_root() -> PathBuf {
    let compile_time = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("mcp");
    if compile_time.is_dir() {
        return compile_time;
    }
    if let Ok(exe) = std::env::current_exe() {
        for candidate in [
            exe.parent().map(|path| path.join("mcp")),
            exe.parent().map(|path| path.join("resources").join("mcp")),
        ]
        .into_iter()
        .flatten()
        {
            if candidate.is_dir() {
                return candidate;
            }
        }
    }
    compile_time
}

fn existing_file(path: PathBuf) -> Option<PathBuf> {
    path.is_file().then_some(path)
}

pub fn find_node() -> Option<PathBuf> {
    if let Ok(explicit) = std::env::var("NODE_BINARY") {
        if let Some(path) = existing_file(PathBuf::from(explicit.trim())) {
            return Some(path);
        }
    }
    let mut bundled = Vec::new();
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            bundled.extend([
                dir.join("node.exe"),
                dir.join("node").join("node.exe"),
                dir.join("resources").join("node.exe"),
                dir.join("resources").join("node").join("node.exe"),
                dir.join("vendor").join("node").join("node.exe"),
            ]);
            let mut cursor = dir.to_path_buf();
            for _ in 0..6 {
                bundled.push(cursor.join("vendor").join("node").join("node.exe"));
                if !cursor.pop() {
                    break;
                }
            }
        }
    }
    bundled.push(
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("vendor")
            .join("node")
            .join("node.exe"),
    );
    for candidate in bundled {
        if let Some(path) = existing_file(candidate) {
            return Some(path);
        }
    }
    #[cfg(windows)]
    {
        for name in ["node.exe", "node"] {
            let mut command = Command::new("where.exe");
            hide(&mut command);
            if let Ok(output) = command.arg(name).output() {
                if output.status.success() {
                    for line in String::from_utf8_lossy(&output.stdout).lines() {
                        let path = PathBuf::from(line.trim());
                        if path.is_file() {
                            return Some(path);
                        }
                        let with_exe = path.with_extension("exe");
                        if with_exe.is_file() {
                            return Some(with_exe);
                        }
                    }
                }
            }
        }
        let mut candidates = Vec::new();
        for key in ["NVM_SYMLINK", "NVM_HOME"] {
            if let Ok(root) = std::env::var(key) {
                candidates.push(PathBuf::from(&root).join("node.exe"));
                candidates.push(PathBuf::from(root).join("nodejs").join("node.exe"));
            }
        }
        if let Ok(appdata) = std::env::var("APPDATA") {
            candidates.push(PathBuf::from(appdata).join("nvm").join("nodejs").join("node.exe"));
        }
        if let Some(local) = dirs::data_local_dir() {
            candidates.push(local.join("fnm").join("aliases").join("default").join("node.exe"));
            candidates.push(local.join("fnm").join("current").join("node.exe"));
            candidates.push(local.join("nvm").join("nodejs").join("node.exe"));
        }
        for root in [
            std::env::var("ProgramFiles").ok(),
            std::env::var("ProgramFiles(x86)").ok(),
        ]
        .into_iter()
        .flatten()
        {
            candidates.push(PathBuf::from(root).join("nodejs").join("node.exe"));
        }
        candidates.push(PathBuf::from(r"C:\nvm4w\nodejs\node.exe"));
        for candidate in candidates {
            if let Some(path) = existing_file(candidate) {
                return Some(path);
            }
        }
    }
    #[cfg(not(windows))]
    {
        for candidate in ["/usr/local/bin/node", "/usr/bin/node", "/opt/homebrew/bin/node"] {
            if let Some(path) = existing_file(PathBuf::from(candidate)) {
                return Some(path);
            }
        }
    }
    None
}

fn hide(command: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000);
    }
}

pub fn hide_command(command: &mut Command) {
    hide(command);
}

fn hidden_exec_name() -> &'static str {
    if cfg!(windows) {
        "hidden-exec.exe"
    } else {
        "hidden-exec"
    }
}

pub fn hidden_exec_path() -> Option<PathBuf> {
    let name = hidden_exec_name();
    let mut candidates = Vec::new();
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            candidates.extend([
                dir.join(name),
                dir.join("resources").join(name),
                dir.join("bundled").join(name),
            ]);
        }
    }
    candidates.push(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("bundled").join(name));
    candidates.into_iter().find_map(existing_file)
}

fn wrap_hidden(program: &Path, args: Vec<String>) -> (String, Vec<String>) {
    if let Some(wrapper) = hidden_exec_path() {
        let mut wrapped = vec![program.display().to_string()];
        wrapped.extend(args);
        (wrapper.display().to_string(), wrapped)
    } else {
        (program.display().to_string(), args)
    }
}

pub fn git_host_context_file() -> PathBuf {
    config::app_root().join("git-host-mcp.json")
}

pub fn office_context_file() -> PathBuf {
    config::app_root().join("office-mcp.json")
}

pub fn browser_profile_dir() -> PathBuf {
    config::app_root().join("browser-profile")
}

pub fn write_contexts() {
    if let Some(parent) = git_host_context_file().parent() {
        let _ = fs::create_dir_all(parent);
    }
    let payload = githost::context_payload();
    let _ = fs::write(
        git_host_context_file(),
        format!("{}\n", payload),
    );
    let office = json!({
        "cwd": config::workspace_root().display().to_string(),
        "codexHome": config::resolve_codex_home().display().to_string(),
    });
    let _ = fs::write(office_context_file(), format!("{office}\n"));
}

fn script_path(name: &str) -> PathBuf {
    script_root().join(name)
}

fn managed_enabled(prefs: &Value, pref_key: &str, server: Option<&Value>) -> bool {
    if prefs.get(pref_key).and_then(Value::as_bool) == Some(false) {
        return false;
    }
    if server
        .and_then(|item| item.get("enabled"))
        .and_then(Value::as_bool)
        == Some(false)
        && prefs.get(pref_key).and_then(Value::as_bool) != Some(true)
    {
        return false;
    }
    true
}

fn managed_server(server: Option<&Value>, script_name: &str) -> bool {
    let Some(server) = server else {
        return true;
    };
    let command = server.get("command").and_then(Value::as_str).unwrap_or("");
    let url = server.get("url").and_then(Value::as_str).unwrap_or("");
    if command.is_empty() && url.is_empty() {
        return true;
    }
    let args = server
        .get("args")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    if script_name == "local-computer-mcp.cjs"
        && command == "npx"
        && args.iter().any(|item| {
            item.as_str()
                .map(|value| value.contains("desktop-commander"))
                .unwrap_or(false)
        })
    {
        return true;
    }
    args.iter().any(|item| {
        item.as_str()
            .map(|value| value.replace('\\', "/").ends_with(script_name))
            .unwrap_or(false)
    })
}

fn push_script_server(
    edits: &mut Vec<Value>,
    name: &str,
    script: &str,
    enabled: bool,
    extra_env: &[(&str, String)],
    timeout: u64,
    node: &Path,
) {
    let path = script_path(script);
    if !path.is_file() {
        config::log_event(&format!("MCP script missing: {name} ({script})"));
        return;
    }
    let (command, args) = wrap_hidden(node, vec![path.display().to_string()]);
    edits.push(json!({
        "keyPath": format!("mcp_servers.{name}.command"),
        "value": command,
        "mergeStrategy": "replace"
    }));
    edits.push(json!({
        "keyPath": format!("mcp_servers.{name}.args"),
        "value": args,
        "mergeStrategy": "replace"
    }));
    edits.push(json!({
        "keyPath": format!("mcp_servers.{name}.startup_timeout_sec"),
        "value": timeout,
        "mergeStrategy": "replace"
    }));
    edits.push(json!({
        "keyPath": format!("mcp_servers.{name}.enabled"),
        "value": enabled,
        "mergeStrategy": "replace"
    }));
    for (key, value) in extra_env {
        edits.push(json!({
            "keyPath": format!("mcp_servers.{name}.env.{key}"),
            "value": value,
            "mergeStrategy": "replace"
        }));
    }
}

pub async fn ensure_defaults(engine: &Engine) {
    write_contexts();
    let current = match engine.request("config/read", json!({})).await {
        Ok(value) => value.get("config").cloned().unwrap_or(value),
        Err(err) => {
            config::log_event(&format!("config/read before MCP defaults failed: {}", err.message));
            return;
        }
    };
    let prefs = config::read_preferences();
    let mut edits = Vec::new();
    let servers = current.get("mcp_servers").cloned().unwrap_or(json!({}));

    let electron = servers.get("electron");
    if electron
        .and_then(|item| item.get("command"))
        .and_then(Value::as_str)
        == Some("npx")
        && electron
            .and_then(|item| item.get("args"))
            .and_then(Value::as_array)
            .map(|args| {
                args.iter().any(|item| {
                    item.as_str()
                        .map(|value| value.contains("electron-mcp-server"))
                        .unwrap_or(false)
                })
            })
            .unwrap_or(false)
        && electron
            .and_then(|item| item.get("enabled"))
            .and_then(Value::as_bool)
            != Some(false)
    {
        edits.push(json!({
            "keyPath": "mcp_servers.electron.enabled",
            "value": false,
            "mergeStrategy": "replace"
        }));
    }

    let node = find_node();
    if node.is_none() {
        config::log_event("MCP skipped: node.exe not found");
    }
    if let Some(node) = node.as_ref() {
    if managed_server(servers.get("computer"), "local-computer-mcp.cjs") {
        push_script_server(
            &mut edits,
            "computer",
            "local-computer-mcp.cjs",
            managed_enabled(&prefs, "computer_enabled", servers.get("computer")),
            &[(
                "LOCAL_CODEX_COMPUTER_POLICY_FILE",
                config::preferences_path().display().to_string(),
            )],
            30,
            &node,
        );
    }
    if managed_server(servers.get("git-host"), "git-host-mcp.cjs") {
        push_script_server(
            &mut edits,
            "git-host",
            "git-host-mcp.cjs",
            managed_enabled(&prefs, "git_host_enabled", servers.get("git-host")),
            &[(
                "LOCAL_CODEX_GIT_HOST_CONTEXT",
                git_host_context_file().display().to_string(),
            )],
            30,
            &node,
        );
    }
    if managed_server(servers.get("office"), "office-mcp.cjs") {
        push_script_server(
            &mut edits,
            "office",
            "office-mcp.cjs",
            managed_enabled(&prefs, "office_enabled", servers.get("office")),
            &[(
                "LOCAL_CODEX_OFFICE_CONTEXT",
                office_context_file().display().to_string(),
            )],
            30,
            &node,
        );
    }
    if managed_server(servers.get("notebook"), "notebook-mcp.cjs") {
        push_script_server(
            &mut edits,
            "notebook",
            "notebook-mcp.cjs",
            managed_enabled(&prefs, "notebook_enabled", servers.get("notebook")),
            &[(
                "LOCAL_CODEX_NOTEBOOK_CONTEXT",
                office_context_file().display().to_string(),
            )],
            30,
            &node,
        );
    }
    if managed_server(servers.get("web-search"), "web-search-mcp.cjs") {
        push_script_server(
            &mut edits,
            "web-search",
            "web-search-mcp.cjs",
            managed_enabled(&prefs, "web_search_enabled", servers.get("web-search")),
            &[],
            30,
            &node,
        );
    }
    if let Some((command, args)) = playwright_launch(&node, &prefs) {
        let browser = servers.get("browser");
        let existing_args = browser
            .and_then(|item| item.get("args"))
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let managed = browser.is_none()
            || existing_args.iter().any(|item| {
                item.as_str()
                    .map(|value| {
                        value.contains("@playwright/mcp")
                            || value.ends_with("cli.js")
                            || value == "-y"
                    })
                    .unwrap_or(false)
            });
        if managed {
            edits.push(json!({
                "keyPath": "mcp_servers.browser.command",
                "value": command,
                "mergeStrategy": "replace"
            }));
            edits.push(json!({
                "keyPath": "mcp_servers.browser.args",
                "value": args,
                "mergeStrategy": "replace"
            }));
            edits.push(json!({
                "keyPath": "mcp_servers.browser.startup_timeout_sec",
                "value": 120,
                "mergeStrategy": "replace"
            }));
            edits.push(json!({
                "keyPath": "mcp_servers.browser.enabled",
                "value": managed_enabled(&prefs, "browser_enabled", servers.get("browser")),
                "mergeStrategy": "replace"
            }));
        }
    } else if let Some(browser) = servers.get("browser") {
        let hanging = browser
            .get("command")
            .and_then(Value::as_str)
            .map(|value| value.contains("npx"))
            .unwrap_or(false)
            || browser
                .get("args")
                .and_then(Value::as_array)
                .map(|args| {
                    args.iter().any(|item| {
                        item.as_str()
                            .map(|value| value == "-y" || value.contains("@playwright/mcp"))
                            .unwrap_or(false)
                    })
                })
                .unwrap_or(false);
        if hanging {
            edits.push(json!({
                "keyPath": "mcp_servers.browser.enabled",
                "value": false,
                "mergeStrategy": "replace"
            }));
            config::log_event("browser MCP disabled: npx @playwright/mcp would hang startup");
        }
    }
    } else if let Some(browser) = servers.get("browser") {
        let hanging = browser
            .get("command")
            .and_then(Value::as_str)
            .map(|value| value.contains("npx"))
            .unwrap_or(false)
            || browser
                .get("args")
                .and_then(Value::as_array)
                .map(|args| {
                    args.iter().any(|item| {
                        item.as_str()
                            .map(|value| value == "-y" || value.contains("@playwright/mcp"))
                            .unwrap_or(false)
                    })
                })
                .unwrap_or(false);
        if hanging {
            edits.push(json!({
                "keyPath": "mcp_servers.browser.enabled",
                "value": false,
                "mergeStrategy": "replace"
            }));
            config::log_event("browser MCP disabled: npx @playwright/mcp would hang startup");
        }
    }
    if edits.is_empty() {
        return;
    }
    if let Err(err) = engine
        .request(
            "config/batchWrite",
            json!({ "edits": edits, "reloadUserConfig": true }),
        )
        .await
    {
        config::log_event(&format!("local MCP defaults failed: {}", err.message));
        return;
    }
    if let Err(err) = engine.request("config/mcpServer/reload", json!({})).await {
        config::log_event(&format!("mcpServer reload failed: {}", err.message));
        return;
    }
    config::log_event("local computer/git-host/office/notebook/web-search MCP defaults ensured");
}

fn playwright_launch(node: &Path, prefs: &Value) -> Option<(String, Vec<String>)> {
    let profile = browser_profile_dir();
    let _ = fs::create_dir_all(&profile);
    let preference = prefs
        .get("browser_engine")
        .and_then(Value::as_str)
        .unwrap_or("auto");
    let resolved = resolve_browser(preference);
    if !resolved.installed {
        return None;
    }
    let mut extra = vec![
        "--user-data-dir".into(),
        profile.display().to_string(),
        "--browser".into(),
        resolved.playwright.clone(),
    ];
    if !resolved.executable.is_empty() && !resolved.executable.ends_with(".app") {
        extra.push("--executable-path".into());
        extra.push(resolved.executable.clone());
    }
    if let Some(cli) = playwright_cli() {
        let mut args = vec![cli.display().to_string()];
        args.extend(extra);
        let (command, args) = wrap_hidden(node, args);
        return Some((command, args));
    }
    config::log_event("browser MCP skipped: @playwright/mcp not installed");
    None
}

fn playwright_cli() -> Option<PathBuf> {
    let name = PathBuf::from("@playwright").join("mcp").join("cli.js");
    let mut roots = Vec::new();
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            roots.push(dir.join("node_modules"));
            roots.push(dir.join("resources").join("node_modules"));
            roots.push(dir.join("..").join("..").join("..").join("node_modules"));
        }
    }
    if let Ok(cwd) = std::env::current_dir() {
        roots.push(cwd.join("node_modules"));
        roots.push(cwd.join("ui").join("node_modules"));
    }
    {
        let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        roots.push(dir.join("..").join("node_modules"));
        roots.push(dir.join("..").join("ui").join("node_modules"));
    }
    if let Some(local) = dirs::data_local_dir() {
        roots.push(local.join("npm").join("node_modules"));
    }
    roots.push(config::app_root().join("node_modules"));
    for root in roots {
        let candidate = root.join(&name);
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

pub fn preview_file(path: &Path) -> Result<Value, String> {
    let node = find_node().ok_or_else(|| "未找到 node.exe，无法预览 Office/PDF".to_string())?;
    let script = script_path("preview.cjs");
    if !script.is_file() {
        return Err("缺少预览脚本".into());
    }
    let mut command = Command::new(node);
    command.args([script.as_os_str(), path.as_os_str()]);
    hide(&mut command);
    match command.output() {
        Ok(output) if output.status.success() => {
            serde_json::from_slice(&output.stdout).map_err(|err| err.to_string())
        }
        Ok(output) => {
            let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
            Err(if stderr.is_empty() {
                "无法解析该文件".into()
            } else {
                stderr
            })
        }
        Err(err) => Err(err.to_string()),
    }
}

pub async fn clear_browser_data(app: &tauri::AppHandle, engine: &Engine) -> Result<Value, String> {
    crate::browser::destroy(app);
    let workspace = crate::browser::profile_dir();
    if workspace.exists() {
        let _ = fs::remove_dir_all(&workspace);
    }
    let target = browser_profile_dir();
    let mut enabled = true;
    if let Ok(config) = engine.request("config/read", json!({})).await {
        enabled = config
            .pointer("/config/mcp_servers/browser/enabled")
            .or_else(|| config.pointer("/mcp_servers/browser/enabled"))
            .and_then(Value::as_bool)
            != Some(false);
        let _ = engine
            .request(
                "config/value/write",
                json!({
                    "keyPath": "mcp_servers.browser.enabled",
                    "value": false,
                    "mergeStrategy": "replace"
                }),
            )
            .await;
        let _ = engine.request("config/mcpServer/reload", json!({})).await;
    }
    if target.exists() {
        fs::remove_dir_all(&target).map_err(|err| err.to_string())?;
    }
    if enabled {
        let _ = engine
            .request(
                "config/value/write",
                json!({
                    "keyPath": "mcp_servers.browser.enabled",
                    "value": true,
                    "mergeStrategy": "replace"
                }),
            )
            .await;
        let _ = engine.request("config/mcpServer/reload", json!({})).await;
    }
    Ok(json!({ "ok": true, "path": target.display().to_string() }))
}

fn first_existing(paths: impl IntoIterator<Item = PathBuf>) -> String {
    paths
        .into_iter()
        .find(|path| path.exists())
        .map(|path| path.display().to_string())
        .unwrap_or_default()
}

fn browser_exe(kind: &str) -> (bool, String) {
    let local = dirs::data_local_dir().unwrap_or_default();
    let home = dirs::home_dir().unwrap_or_default();
    let program = PathBuf::from(std::env::var("ProgramFiles").unwrap_or_default());
    let program_x86 = PathBuf::from(std::env::var("ProgramFiles(x86)").unwrap_or_default());
    let path = match kind {
        "chrome" => first_existing([
            program.join("Google/Chrome/Application/chrome.exe"),
            program_x86.join("Google/Chrome/Application/chrome.exe"),
            local.join("Google/Chrome/Application/chrome.exe"),
        ]),
        "msedge" => first_existing([
            program_x86.join("Microsoft/Edge/Application/msedge.exe"),
            program.join("Microsoft/Edge/Application/msedge.exe"),
            local.join("Microsoft/Edge/Application/msedge.exe"),
        ]),
        "chromium" => first_existing([
            program.join("Chromium/Application/chrome.exe"),
            program_x86.join("Chromium/Application/chrome.exe"),
            local.join("Chromium/Application/chrome.exe"),
            home.join("AppData/Local/Chromium/Application/chrome.exe"),
        ]),
        _ => String::new(),
    };
    (!path.is_empty(), path)
}

struct ResolvedBrowser {
    id: String,
    playwright: String,
    executable: String,
    installed: bool,
}

fn normalize_browser_preference(value: &str) -> String {
    match value.trim().to_ascii_lowercase().as_str() {
        "chrome" | "chromium" | "auto" => value.trim().to_ascii_lowercase(),
        "edge" | "msedge" => "msedge".into(),
        _ => "auto".into(),
    }
}

fn playwright_id(kind: &str) -> &'static str {
    match kind {
        "chrome" => "chrome",
        "chromium" => "chromium",
        _ => "msedge",
    }
}

fn resolve_browser(preference: &str) -> ResolvedBrowser {
    const ENGINE_ORDER: [&str; 3] = ["msedge", "chrome", "chromium"];
    let wanted = normalize_browser_preference(preference);
    let mut order: Vec<&str> = if wanted == "auto" {
        ENGINE_ORDER.to_vec()
    } else {
        std::iter::once(wanted.as_str())
            .chain(ENGINE_ORDER.iter().copied().filter(|id| *id != wanted))
            .collect()
    };
    for id in order.drain(..) {
        let (installed, executable) = browser_exe(id);
        if installed {
            return ResolvedBrowser {
                id: id.into(),
                playwright: playwright_id(id).into(),
                executable,
                installed: true,
            };
        }
    }
    let fallback = if wanted == "auto" { "chrome" } else { wanted.as_str() };
    ResolvedBrowser {
        id: fallback.into(),
        playwright: playwright_id(fallback).into(),
        executable: String::new(),
        installed: false,
    }
}

fn excel_exe() -> String {
    let program = PathBuf::from(std::env::var("ProgramFiles").unwrap_or_default());
    let program_x86 = PathBuf::from(std::env::var("ProgramFiles(x86)").unwrap_or_default());
    first_existing([
        program.join("Microsoft Office/root/Office16/EXCEL.EXE"),
        program.join("Microsoft Office/Office16/EXCEL.EXE"),
        program_x86.join("Microsoft Office/root/Office16/EXCEL.EXE"),
        program_x86.join("Microsoft Office/Office16/EXCEL.EXE"),
    ])
}

pub fn integration_status() -> Value {
    let prefs = config::read_preferences();
    let preference = prefs
        .get("browser_engine")
        .and_then(Value::as_str)
        .unwrap_or("auto");
    let resolved = resolve_browser(preference);
    let (chrome_ok, chrome_exe) = browser_exe("chrome");
    let (edge_ok, edge_exe) = browser_exe("msedge");
    let (chromium_ok, chromium_exe) = browser_exe("chromium");
    let excel = excel_exe();
    json!({
        "platform": std::env::consts::OS,
        "computer": {
            "available": find_node().is_some() && script_path("local-computer-mcp.cjs").is_file(),
            "toolCount": 11,
        },
        "browser": {
            "available": resolved.installed && playwright_cli().is_some(),
            "engine": if resolved.installed { resolved.id.clone() } else { String::new() },
            "executable": resolved.executable.clone(),
            "profile": browser_profile_dir().display().to_string(),
            "preference": normalize_browser_preference(preference),
            "playwright": playwright_cli().map(|path| path.display().to_string()).unwrap_or_default(),
            "engines": [
                { "id": "msedge", "name": "Microsoft Edge", "playwright": "msedge", "installed": edge_ok, "executable": edge_exe.clone() },
                { "id": "chrome", "name": "Google Chrome", "playwright": "chrome", "installed": chrome_ok, "executable": chrome_exe.clone() },
                { "id": "chromium", "name": "Chromium", "playwright": "chromium", "installed": chromium_ok, "executable": chromium_exe },
            ],
        },
        "apps": [
            { "id": "any", "name": "任意应用", "installed": true, "enabledKey": "computer_allow_any_app" },
            { "id": "chrome", "name": "Google Chrome", "installed": chrome_ok, "executable": chrome_exe, "enabledKey": "computer_chrome_enabled" },
            { "id": "edge", "name": "Microsoft Edge", "installed": edge_ok, "executable": edge_exe, "enabledKey": "computer_edge_enabled" },
            { "id": "excel", "name": "Microsoft Excel", "installed": !excel.is_empty(), "executable": excel, "enabledKey": "computer_excel_enabled" },
        ],
    })
}

pub fn sync_preference(key: &str) -> bool {
    matches!(
        key,
        "plugins_enabled"
            | "disabled_builtin_skills"
            | "hooks_enabled"
            | "browser_engine"
            | "browser_enabled"
            | "web_search_enabled"
            | "computer_enabled"
    ) || key.starts_with("gitlab_")
        || key.starts_with("github_")
}
