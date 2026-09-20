use crate::bridge::{Bridge, Incoming, RpcError};
use crate::config;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
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
        let bridge = self.current_bridge().await?;
        bridge.request(method, params).await
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
        let bundled = bundled_binary(&self.app);
        let Some(binary) = find_codex_binary(bundled.as_deref()) else {
            let err = "未找到 codex.exe。请安装 Codex CLI，或设置 CODEX_APP_SERVER_CMD，或运行 npm run stage-app-server。".to_string();
            config::log_event(&err);
            return Err(err);
        };
        config::log_event(&format!("using binary {}", binary.display()));

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
        let settings = config::read_settings(&codex_home)?;
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

        let args: Vec<String> = LOCAL_ONLY_APP_SERVER_ARGS
            .iter()
            .map(|value| (*value).to_string())
            .collect();
        let (tx, mut rx) = mpsc::unbounded_channel();
        let bridge = Bridge::spawn(binary.clone(), &args, extra_env, tx).map_err(|err| err.message)?;
        {
            let mut slot = self.bridge.lock().await;
            *slot = Some(Arc::clone(&bridge));
        }

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
                    "title": "Local Codex",
                    "version": "0.1.0"
                }),
                json!({
                    "capabilities": {
                        "experimentalApi": true,
                        "requestAttestation": false
                    }
                }),
            )
            .await
            .map_err(|err| err.message)?;
        tracing::info!("app-server initialized: {init}");
        self.reconnect_attempt.store(0, Ordering::SeqCst);
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
                let _ = self.app.emit(
                    "appserver://notification",
                    json!({ "method": method, "params": params }),
                );
            }
            Incoming::ServerRequest { id, method, params } => {
                if is_handled_approval(&method) {
                    let _ = self.app.emit(
                        "appserver://request",
                        json!({ "id": id, "method": method, "params": params }),
                    );
                } else if let Ok(bridge) = self.current_bridge().await {
                    tracing::warn!("auto-declining unsupported server request {method}");
                    let _ = decline_request(&bridge, id, &method).await;
                }
            }
            Incoming::Unparseable(raw) => {
                tracing::warn!("unparseable app-server line: {raw}");
            }
            Incoming::Stderr(text) => {
                let _ = self.app.emit("appserver://stderr", json!({ "text": text }));
            }
            Incoming::Exit { code } => {
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

fn is_handled_approval(method: &str) -> bool {
    matches!(
        method,
        "item/commandExecution/requestApproval"
            | "item/fileChange/requestApproval"
            | "item/permissions/requestApproval"
    )
}

async fn decline_request(bridge: &Bridge, id: Value, method: &str) -> Result<(), RpcError> {
    if method == "item/permissions/requestApproval" {
        bridge
            .respond(id, json!({ "permissions": {}, "scope": "turn" }))
            .await
    } else if method.ends_with("requestApproval") {
        bridge.respond(id, json!({ "decision": "decline" })).await
    } else {
        bridge
            .respond_error(id, "client does not handle this request")
            .await
    }
}
