use crate::bridge::{Bridge, Incoming, RpcError};
use crate::config;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::{mpsc, Mutex};

pub const LOCAL_ONLY_APP_SERVER_ARGS: &[&str] = &[
    "app-server",
    "--stdio",
    "--disable",
    "plugins",
    "--disable",
    "remote_plugin",
    "--disable",
    "recommended_plugins",
    "--disable",
    "plugin_sharing",
    "--disable",
    "apps",
    "--disable",
    "enable_mcp_apps",
    "-c",
    "marketplaces={}",
    "-c",
    "notify=[]",
    "-c",
    "analytics.enabled=false",
    "-c",
    "sandbox_mode=workspace-write",
    "-c",
    "sandbox_workspace_write.network_access=true",
];

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineStatus {
    pub state: String,
    pub message: Option<String>,
    pub codex_home: String,
    pub binary: Option<String>,
    pub attempt: u32,
    pub model: Option<String>,
    pub api_key_configured: bool,
}

pub struct Engine {
    app: AppHandle,
    bridge: Mutex<Option<Arc<Bridge>>>,
    status: Mutex<EngineStatus>,
    reconnect_attempt: AtomicU32,
    stopping: AtomicBool,
    session: std::sync::atomic::AtomicU64,
    start_gate: Mutex<()>,
    booting: AtomicBool,
    reconnect_tx: mpsc::UnboundedSender<()>,
}

impl Engine {
    pub fn start_runtime(app: AppHandle) -> Arc<Self> {
        let (reconnect_tx, reconnect_rx) = mpsc::unbounded_channel();
        let engine = Arc::new(Self::new(app, reconnect_tx));
        let worker = Arc::clone(&engine);
        tauri::async_runtime::spawn(async move {
            worker.supervise(reconnect_rx).await;
        });
        engine
    }

    fn new(app: AppHandle, reconnect_tx: mpsc::UnboundedSender<()>) -> Self {
        let codex_home = config::resolve_codex_home();
        Self {
            app,
            bridge: Mutex::new(None),
            status: Mutex::new(EngineStatus {
                state: "starting".into(),
                message: None,
                codex_home: codex_home.display().to_string(),
                binary: None,
                attempt: 0,
                model: None,
                api_key_configured: false,
            }),
            reconnect_attempt: AtomicU32::new(0),
            stopping: AtomicBool::new(false),
            session: std::sync::atomic::AtomicU64::new(0),
            start_gate: Mutex::new(()),
            booting: AtomicBool::new(false),
            reconnect_tx,
        }
    }

    async fn supervise(self: Arc<Self>, mut reconnect_rx: mpsc::UnboundedReceiver<()>) {
        self.start().await;
        while reconnect_rx.recv().await.is_some() {
            if self.stopping.load(Ordering::SeqCst) {
                continue;
            }
            let attempt = self.reconnect_attempt.load(Ordering::SeqCst);
            let delay = Duration::from_millis(
                500 * 2u64.saturating_pow(attempt.saturating_sub(1).min(6)),
            );
            tokio::time::sleep(delay.min(Duration::from_secs(30))).await;
            if self.stopping.load(Ordering::SeqCst) {
                continue;
            }
            self.start().await;
        }
    }

    pub async fn status(&self) -> EngineStatus {
        self.status.lock().await.clone()
    }

    pub async fn start(self: &Arc<Self>) {
        let _gate = self.start_gate.lock().await;
        if let Err(err) = self.boot().await {
            self.stop_bridge().await;
            self.emit_status("error", Some(err)).await;
            drop(_gate);
            self.request_reconnect().await;
        }
    }

    pub async fn restart(self: &Arc<Self>) {
        self.reconnect_attempt.store(0, Ordering::SeqCst);
        self.stopping.store(true, Ordering::SeqCst);
        self.stop_bridge().await;
        self.stopping.store(false, Ordering::SeqCst);
        self.start().await;
    }

    pub async fn request(&self, method: &str, params: Value) -> Result<Value, RpcError> {
        if method == "model/list" {
            return Ok(config::provider_model_catalog());
        }
        let bridge = self.current_bridge().await?;
        let params = crate::runtime::enrich_params(method, params);
        let result = bridge.request(method, params).await?;
        Ok(crate::runtime::rewrite_result(method, result))
    }

    pub async fn notify(&self, method: &str, params: Value) -> Result<(), RpcError> {
        let bridge = self.current_bridge().await?;
        bridge.notify(method, params).await
    }

    pub async fn respond(&self, id: Value, result: Value) -> Result<(), RpcError> {
        let bridge = self.current_bridge().await?;
        bridge.respond(id, result).await
    }

    async fn boot(self: &Arc<Self>) -> Result<(), String> {
        self.booting.store(true, Ordering::SeqCst);
        let result = self.boot_inner().await;
        self.booting.store(false, Ordering::SeqCst);
        result
    }

    async fn boot_inner(self: &Arc<Self>) -> Result<(), String> {
        self.stopping.store(true, Ordering::SeqCst);
        self.stop_bridge().await;
        self.stopping.store(false, Ordering::SeqCst);
        let session = self.session.fetch_add(1, Ordering::SeqCst) + 1;
        let codex_home = config::resolve_codex_home();
        config::ensure_config(&codex_home)?;
        config::migrate_legacy_secrets();
        let requested_mock = config::mock_requested();
        let bundled = bundled_binary(&self.app);
        let real = find_codex_binary(bundled.as_deref());
        let missing_real = "未找到 codex.exe。请安装 Codex CLI，或设置 CODEX_APP_SERVER_CMD，或运行 npm run stage-app-server。";
        let (binary, args, mock) = if requested_mock || (real.is_none() && !config::is_packaged()) {
            match resolve_mock_launch() {
                Some(launch) => launch,
                None if requested_mock => {
                    let err = "无法启动 mock 引擎：未找到 node.exe 或 mock/mock-app-server.mjs".to_string();
                    config::log_event(&err);
                    return Err(err);
                }
                None => {
                    config::log_event(missing_real);
                    return Err(missing_real.into());
                }
            }
        } else if let Some(binary) = real {
            (
                binary,
                LOCAL_ONLY_APP_SERVER_ARGS
                    .iter()
                    .map(|value| (*value).to_string())
                    .collect(),
                false,
            )
        } else {
            config::log_event(missing_real);
            return Err(missing_real.into());
        };
        config::set_mock_active(mock);
        if mock {
            config::log_event(&format!("using mock engine {}", binary.display()));
        } else {
            config::log_event(&format!("using binary {}", binary.display()));
        }

        self.emit_status_with(
            "connecting",
            None,
            Some(binary.display().to_string()),
            &codex_home,
        )
        .await;

        let mut extra_env = HashMap::new();
        extra_env.insert(
            "CODEX_HOME".into(),
            codex_home.display().to_string(),
        );
        // Hidden child processes cannot show a credential prompt. Without these,
        // git and other tools wait forever and the turn never continues.
        extra_env.insert("GIT_TERMINAL_PROMPT".into(), "0".into());
        extra_env.insert("GCM_INTERACTIVE".into(), "never".into());
        if !mock {
            let settings = config::read_settings(&codex_home)?;
            if config::provider_blocked(&settings.model_provider, &settings.base_url) {
                let err = "当前 Provider 指向 OpenAI 托管端点；本应用按需求禁止启动该配置".to_string();
                config::log_event(&err);
                return Err(err);
            }
            let api_key = match config::resolve_secret(&settings.env_key) {
                Ok(value) => value,
                Err(err) => {
                    tracing::warn!("failed to resolve {} from keyring: {err}", settings.env_key);
                    String::new()
                }
            };
            let api_key = api_key.trim().to_string();
            if api_key.is_empty() {
                tracing::warn!(
                    "provider env {} is empty; model turns will fail until an API key is saved",
                    settings.env_key
                );
                config::log_event(&format!("missing provider env {}", settings.env_key));
            } else {
                tracing::info!(
                    "injecting provider env {} ({} chars)",
                    settings.env_key,
                    api_key.chars().count()
                );
                extra_env.insert(settings.env_key.clone(), api_key.clone());
                #[allow(deprecated)]
                std::env::set_var(&settings.env_key, &api_key);
                config::log_event(&format!(
                    "inject {} ({} chars) binary={}",
                    settings.env_key,
                    api_key.chars().count(),
                    binary.display()
                ));
            }
        }
        let (tx, mut rx) = mpsc::unbounded_channel();
        let (request_tx, mut request_rx) = mpsc::unbounded_channel();
        let bridge = Bridge::spawn(binary.clone(), &args, extra_env, tx, request_tx)
            .map_err(|err| err.message)?;
        {
            let mut slot = self.bridge.lock().await;
            *slot = Some(Arc::clone(&bridge));
        }

        let requests = Arc::clone(self);
        tokio::spawn(async move {
            while let Some(event) = request_rx.recv().await {
                if requests.session.load(Ordering::SeqCst) != session {
                    break;
                }
                // Approvals and MCP elicitations must not wait behind tool-output
                // notifications. A blocked prompt freezes the rest of the turn.
                requests.handle_incoming(event).await;
            }
        });
        let engine = Arc::clone(self);
        tokio::spawn(async move {
            while let Some(event) = rx.recv().await {
                if engine.session.load(Ordering::SeqCst) != session {
                    break;
                }
                engine.handle_incoming(event).await;
            }
        });

        let init = bridge
            .initialize(
                json!({
                    "name": "local-codex",
                    "title": "Scorpio Agent",
                    "version": "0.1.12"
                }),
                json!({
                    "capabilities": {
                        "experimentalApi": true,
                        "requestAttestation": false,
                        "mcpServerOpenaiFormElicitation": true,
                        "extensions": { "openai/form": {} }
                    }
                }),
            )
            .await
            .map_err(|err| err.message)?;
        tracing::info!("app-server initialized: {init}");
        self.reconnect_attempt.store(0, Ordering::SeqCst);
        crate::runtime::after_connect(self).await;
        crate::tray::refresh_recent(&self.app);
        self.emit_status_with(
            "connected",
            None,
            Some(binary.display().to_string()),
            &codex_home,
        )
        .await;
        Ok(())
    }

    async fn handle_incoming(self: &Arc<Self>, event: Incoming) {
        match event {
            Incoming::Notification { method, params } => {
                if method.starts_with("thread/") {
                    crate::tray::refresh_recent(&self.app);
                }
                let params = if method == "thread/started" {
                    crate::projects::attach_started_thread(params)
                } else {
                    params
                };
                let _ = self.app.emit(
                    "appserver://notification",
                    json!({ "method": method, "params": params }),
                );
            }
            Incoming::ServerRequest { id, method, params } => {
                if let Ok(bridge) = self.current_bridge().await {
                    if let Some(result) = auto_server_response(&method, &params) {
                        let _ = bridge.respond(id, result).await;
                        return;
                    }
                    if auto_server_error(&method) {
                        tracing::warn!("rejecting unsupported server request {method}");
                        let _ = bridge
                            .respond_error(id, "client does not handle this request")
                            .await;
                        return;
                    }
                }
                let _ = self.app.emit(
                    "appserver://request",
                    json!({ "id": id, "method": method, "params": params }),
                );
            }
            Incoming::Unparseable(raw) => {
                tracing::warn!("unparseable app-server line: {raw}");
                config::log_event(&format!("unparseable app-server line: {raw}"));
            }
            Incoming::Stderr(text) => {
                config::log_event(&format!("STDERR {text}"));
                let _ = self.app.emit("appserver://stderr", json!({ "text": text }));
            }
            Incoming::Exit { code } => {
                config::log_event(&format!(
                    "EXIT code={}",
                    code.map(|value| value.to_string()).unwrap_or_else(|| "none".into())
                ));
                if self.stopping.load(Ordering::SeqCst) || self.booting.load(Ordering::SeqCst) {
                    return;
                }
                self.emit_status(
                    "disconnected",
                    Some(format!(
                        "app-server 退出（code={}）",
                        code.map(|value| value.to_string()).unwrap_or_else(|| "none".into())
                    )),
                )
                .await;
                self.request_reconnect().await;
            }
        }
    }

    async fn request_reconnect(&self) {
        if self.stopping.load(Ordering::SeqCst) {
            return;
        }
        let attempt = self.reconnect_attempt.fetch_add(1, Ordering::SeqCst) + 1;
        if attempt > 6 {
            self.emit_status(
                "error",
                Some(format!("app-server 连续失败 {attempt} 次，已停止重试")),
            )
            .await;
            return;
        }
        self.emit_status("reconnecting", Some(format!("第 {attempt} 次重连")))
            .await;
        let _ = self.reconnect_tx.send(());
    }

    async fn stop_bridge(&self) {
        if let Some(bridge) = self.bridge.lock().await.take() {
            bridge.stop().await;
        }
    }

    async fn current_bridge(&self) -> Result<Arc<Bridge>, RpcError> {
        self.bridge.lock().await.clone().ok_or_else(|| RpcError {
            message: "app-server 尚未就绪".into(),
        })
    }

    async fn emit_status(&self, state: &str, message: Option<String>) {
        let binary = self.status.lock().await.binary.clone();
        let home = config::resolve_codex_home();
        self.emit_status_with(state, message, binary, &home).await;
    }

    async fn emit_status_with(
        &self,
        state: &str,
        message: Option<String>,
        binary: Option<String>,
        codex_home: &Path,
    ) {
        let settings = config::read_settings(codex_home).ok();
        let status = EngineStatus {
            state: state.to_string(),
            message,
            codex_home: codex_home.display().to_string(),
            binary,
            attempt: self.reconnect_attempt.load(Ordering::SeqCst),
            model: settings.as_ref().map(|item| item.model.clone()),
            api_key_configured: settings
                .as_ref()
                .map(|item| item.api_key_configured)
                .unwrap_or(false),
        };
        {
            let mut slot = self.status.lock().await;
            *slot = status.clone();
        }
        let _ = self.app.emit("appserver://status", status);
    }
}

fn resolve_mock_launch() -> Option<(PathBuf, Vec<String>, bool)> {
    let node = crate::mcp::find_node()?;
    let script = config::mock_script()?;
    Some((node, vec![script.display().to_string()], true))
}

pub fn find_codex_binary(bundled: Option<&Path>) -> Option<PathBuf> {
    if let Ok(explicit) = std::env::var("CODEX_APP_SERVER_CMD") {
        let path = PathBuf::from(explicit.trim());
        if path.exists() {
            return Some(path);
        }
    }
    if let Some(bundled) = bundled {
        if bundled.exists() {
            return Some(bundled.to_path_buf());
        }
    }
    for candidate in vendor_candidates() {
        if candidate.exists() {
            return Some(candidate);
        }
    }
    find_installed_codex()
}

fn bundled_binary(app: &AppHandle) -> Option<PathBuf> {
    let name = if cfg!(windows) { "codex.exe" } else { "codex" };
    app.path()
        .resource_dir()
        .ok()
        .map(|dir| dir.join("app-server").join(name))
        .filter(|path| path.exists())
}

fn vendor_candidates() -> Vec<PathBuf> {
    let name = if cfg!(windows) { "codex.exe" } else { "codex" };
    let mut out = Vec::new();
    if let Ok(cwd) = std::env::current_dir() {
        out.push(cwd.join("vendor").join("app-server").join(name));
        out.push(cwd.join("..").join("vendor").join("app-server").join(name));
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            out.push(dir.join("vendor").join("app-server").join(name));
            out.push(dir.join("..").join("vendor").join("app-server").join(name));
            out.push(dir.join("..").join("..").join("vendor").join("app-server").join(name));
        }
    }
    out.push(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..").join("vendor").join("app-server").join(name));
    if let Some(local) = dirs::data_local_dir() {
        out.push(
            local
                .join("Programs")
                .join("local-codex")
                .join("resources")
                .join("app-server")
                .join(name),
        );
    }
    out
}

fn find_installed_codex() -> Option<PathBuf> {
    #[cfg(windows)]
    {
        let root = dirs::data_local_dir()?.join("OpenAI").join("Codex").join("bin");
        if !root.exists() {
            return None;
        }
        let mut candidates = Vec::new();
        if let Ok(read) = std::fs::read_dir(root) {
            for entry in read.flatten() {
                let file = entry.path().join("codex.exe");
                if let Ok(meta) = std::fs::metadata(&file) {
                    candidates.push((file, meta.modified().ok()));
                }
            }
        }
        candidates.sort_by(|left, right| right.1.cmp(&left.1));
        return candidates.into_iter().map(|(path, _)| path).next();
    }
    #[cfg(not(windows))]
    {
        let home = dirs::home_dir()?;
        for candidate in [
            PathBuf::from("/usr/local/bin/codex"),
            PathBuf::from("/opt/homebrew/bin/codex"),
            home.join(".local").join("bin").join("codex"),
        ] {
            if candidate.exists() {
                return Some(candidate);
            }
        }
        None
    }
}

fn auto_server_response(method: &str, params: &Value) -> Option<Value> {
    match method {
        "currentTime/read" => Some(json!({
            "currentTimeAt": std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs()
        })),
        "mcpServer/elicitation/request" => mcp_elicitation_auto_accept(params),
        _ => None,
    }
}

fn mcp_elicitation_auto_accept(params: &Value) -> Option<Value> {
    let mode = params.get("mode").and_then(Value::as_str).unwrap_or("form");
    if mode == "url" || mode == "openai/userVerification" {
        return None;
    }
    let server = params
        .get("serverName")
        .and_then(Value::as_str)
        .unwrap_or("");
    let message = params.get("message").and_then(Value::as_str).unwrap_or("");
    let allow = message.to_ascii_lowercase().starts_with("allow ")
        || message.starts_with("允许")
        || message.contains("tool/")
        || message.contains("tool:");
    if !allow && !mcp_schema_is_decision(params.get("requestedSchema")) {
        return None;
    }
    if !mcp_server_already_granted(server) {
        return None;
    }
    config::log_event(&format!(
        "auto-accept MCP elicitation server={server} message={message}"
    ));
    Some(json!({
        "action": "accept",
        "content": mcp_schema_accept_content(params.get("requestedSchema")),
        "_meta": Value::Null
    }))
}

fn mcp_schema_is_decision(schema: Option<&Value>) -> bool {
    let Some(props) = schema.and_then(|value| value.get("properties")).and_then(Value::as_object)
    else {
        return true;
    };
    if props.is_empty() {
        return true;
    }
    props.values().all(|spec| {
        spec.get("type").and_then(Value::as_str) == Some("boolean")
            || spec.get("enum").and_then(Value::as_array).is_some()
    })
}

fn mcp_schema_accept_content(schema: Option<&Value>) -> Value {
    let Some(props) = schema.and_then(|value| value.get("properties")).and_then(Value::as_object)
    else {
        return json!({});
    };
    let mut out = serde_json::Map::new();
    for (key, spec) in props {
        if let Some(default) = spec.get("default") {
            out.insert(key.clone(), default.clone());
            continue;
        }
        if spec.get("type").and_then(Value::as_str) == Some("boolean") {
            out.insert(key.clone(), json!(true));
            continue;
        }
        if let Some(enums) = spec.get("enum").and_then(Value::as_array) {
            let picked = enums.iter().find(|item| {
                matches!(
                    item.as_str().unwrap_or("").to_ascii_lowercase().as_str(),
                    "allow" | "accept" | "yes" | "true" | "approve" | "approved"
                )
            });
            if let Some(value) = picked.or_else(|| enums.first()) {
                out.insert(key.clone(), value.clone());
            }
        }
    }
    json!(out)
}

fn mcp_toml_server_enabled(name: &str) -> Option<bool> {
    let header = format!("[mcp_servers.{name}]");
    let source = fs::read_to_string(config::engine_home().join("config.toml")).unwrap_or_default();
    let mut in_table = false;
    for line in source.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with('[') {
            in_table = trimmed.eq_ignore_ascii_case(&header);
            continue;
        }
        if in_table {
            if let Some(rest) = trimmed.strip_prefix("enabled") {
                return Some(rest.trim().trim_start_matches('=').trim() == "true");
            }
        }
    }
    None
}

fn mcp_server_already_granted(server: &str) -> bool {
    let name = server.trim().to_ascii_lowercase();
    if name.is_empty() {
        return false;
    }
    let prefs = config::read_preferences();
    if prefs
        .pointer(&format!("/mcp_allowed_tools/{name}"))
        .and_then(Value::as_str)
        != Some("*")
    {
        return false;
    }
    if prefs
        .pointer(&format!("/mcp_servers/{name}/enabled"))
        .and_then(Value::as_bool)
        == Some(false)
    {
        return false;
    }
    if mcp_toml_server_enabled(&name) == Some(false)
        && prefs.get(&format!("{}_enabled", name.replace('-', "_"))).and_then(Value::as_bool)
            != Some(true)
    {
        return false;
    }
    true
}

fn auto_server_error(method: &str) -> bool {
    matches!(
        method,
        "account/chatgptAuthTokens/refresh" | "attestation/generate"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn leaves_enabled_computer_tool_elicitation_for_ui() {
        let params = json!({
            "serverName": "computer",
            "mode": "form",
            "message": "Allow the computer MCP server to tool/computer_get_screen_size?",
            "requestedSchema": { "type": "object", "properties": {} }
        });
        assert!(auto_server_response("mcpServer/elicitation/request", &params).is_none());
    }

    #[test]
    fn leaves_url_elicitation_for_ui() {
        let params = json!({
            "serverName": "github",
            "mode": "url",
            "message": "Sign in",
            "url": "https://example.com"
        });
        assert!(auto_server_response("mcpServer/elicitation/request", &params).is_none());
    }
}
