use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::{mpsc, oneshot, Mutex};

const DEFAULT_TIMEOUT: Duration = Duration::from_secs(300);

#[derive(Debug, Clone)]
pub struct RpcError {
    pub message: String,
}

impl std::fmt::Display for RpcError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.message)
    }
}

impl std::error::Error for RpcError {}

impl From<std::io::Error> for RpcError {
    fn from(value: std::io::Error) -> Self {
        Self {
            message: value.to_string(),
        }
    }
}

#[derive(Debug, Clone)]
pub enum Incoming {
    Notification { method: String, params: Value },
    ServerRequest { id: Value, method: String, params: Value },
    Unparseable(String),
    Stderr(String),
    Exit { code: Option<i32> },
}

enum ChildCommand {
    Kill,
}

pub struct Bridge {
    stdin: Mutex<Option<ChildStdin>>,
    pending: Mutex<HashMap<u64, oneshot::Sender<Result<Value, RpcError>>>>,
    next_id: AtomicU64,
    started: AtomicBool,
    kill_tx: mpsc::UnboundedSender<ChildCommand>,
}

impl Bridge {
    pub fn spawn(
        command: PathBuf,
        args: &[String],
        extra_env: HashMap<String, String>,
        incoming: mpsc::UnboundedSender<Incoming>,
        requests: mpsc::UnboundedSender<Incoming>,
    ) -> Result<Arc<Self>, RpcError> {
        let mut cmd = Command::new(&command);
        cmd.args(args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        for (key, value) in extra_env {
            cmd.env(key, value);
        }
        #[cfg(windows)]
        {
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            const CREATE_UNICODE_ENVIRONMENT: u32 = 0x0000_0400;
            cmd.creation_flags(CREATE_NO_WINDOW | CREATE_UNICODE_ENVIRONMENT);
        }

        let mut child = cmd.spawn().map_err(|err| RpcError {
            message: format!("无法启动 app-server（{}）：{err}", command.display()),
        })?;
        let stdout = child.stdout.take().ok_or_else(|| RpcError {
            message: "app-server stdout 不可用".into(),
        })?;
        let stderr = child.stderr.take().ok_or_else(|| RpcError {
            message: "app-server stderr 不可用".into(),
        })?;
        let stdin = child.stdin.take().ok_or_else(|| RpcError {
            message: "app-server stdin 不可用".into(),
        })?;

        let (kill_tx, kill_rx) = mpsc::unbounded_channel();
        let bridge = Arc::new(Self {
            stdin: Mutex::new(Some(stdin)),
            pending: Mutex::new(HashMap::new()),
            next_id: AtomicU64::new(1),
            started: AtomicBool::new(true),
            kill_tx,
        });

        spawn_stdout_reader(stdout, Arc::clone(&bridge), incoming.clone(), requests);
        spawn_stderr_reader(stderr, incoming.clone());
        spawn_child_waiter(child, kill_rx, Arc::clone(&bridge), incoming);
        Ok(bridge)
    }

    pub async fn request(&self, method: &str, params: Value) -> Result<Value, RpcError> {
        self.request_timeout(method, params, DEFAULT_TIMEOUT).await
    }

    pub async fn request_timeout(
        &self,
        method: &str,
        params: Value,
        timeout: Duration,
    ) -> Result<Value, RpcError> {
        if !self.started.load(Ordering::SeqCst) {
            return Err(RpcError {
                message: "app-server 未启动".into(),
            });
        }
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let (tx, rx) = oneshot::channel();
        self.pending.lock().await.insert(id, tx);
        if let Err(err) = self
            .write(&json!({ "id": id, "method": method, "params": params }))
            .await
        {
            self.pending.lock().await.remove(&id);
            return Err(err);
        }
        match tokio::time::timeout(timeout, rx).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err(RpcError {
                message: "请求被取消".into(),
            }),
            Err(_) => {
                self.pending.lock().await.remove(&id);
                Err(RpcError {
                    message: format!("请求超时: {method}"),
                })
            }
        }
    }

    pub async fn notify(&self, method: &str, params: Value) -> Result<(), RpcError> {
        self.write(&json!({ "method": method, "params": params }))
            .await
    }

    pub async fn respond(&self, id: Value, result: Value) -> Result<(), RpcError> {
        self.write(&json!({ "id": id, "result": result })).await
    }

    pub async fn respond_error(&self, id: Value, message: &str) -> Result<(), RpcError> {
        self.write(&json!({
            "id": id,
            "error": { "code": -32601, "message": message }
        }))
        .await
    }

    pub async fn initialize(&self, client_info: Value, extra: Value) -> Result<Value, RpcError> {
        let mut params = extra;
        if !params.is_object() {
            params = json!({});
        }
        params
            .as_object_mut()
            .expect("initialize params object")
            .insert("clientInfo".into(), client_info);
        let result = self.request("initialize", params).await?;
        self.notify("initialized", json!({})).await?;
        Ok(result)
    }

    pub async fn stop(&self) {
        self.started.store(false, Ordering::SeqCst);
        let _ = self.kill_tx.send(ChildCommand::Kill);
        self.fail_all("app-server 已停止").await;
        let mut stdin = self.stdin.lock().await;
        *stdin = None;
    }

    async fn write(&self, msg: &Value) -> Result<(), RpcError> {
        let mut stdin = self.stdin.lock().await;
        let Some(handle) = stdin.as_mut() else {
            return Err(RpcError {
                message: "app-server 未启动或输入流已关闭".into(),
            });
        };
        let mut line = serde_json::to_vec(msg).map_err(|err| RpcError {
            message: err.to_string(),
        })?;
        line.push(b'\n');
        handle.write_all(&line).await?;
        handle.flush().await?;
        Ok(())
    }

    async fn fail_all(&self, message: &str) {
        let mut pending = self.pending.lock().await;
        for (_, tx) in pending.drain() {
            let _ = tx.send(Err(RpcError {
                message: message.to_string(),
            }));
        }
    }
}

fn spawn_stdout_reader(
    stdout: tokio::process::ChildStdout,
    bridge: Arc<Bridge>,
    incoming: mpsc::UnboundedSender<Incoming>,
    requests: mpsc::UnboundedSender<Incoming>,
) {
    tokio::spawn(async move {
        let mut reader = BufReader::new(stdout);
        let mut buf = Vec::new();
        loop {
            buf.clear();
            match reader.read_until(b'\n', &mut buf).await {
                Ok(0) => break,
                Ok(_) => {
                    if buf.last() == Some(&b'\n') {
                        buf.pop();
                    }
                    if buf.last() == Some(&b'\r') {
                        buf.pop();
                    }
                    let line = String::from_utf8_lossy(&buf).into_owned();
                    handle_line(&bridge, &incoming, &requests, line).await;
                }
                Err(err) => {
                    let _ = incoming.send(Incoming::Unparseable(format!(
                        "stdout read error: {err}"
                    )));
                    break;
                }
            }
        }
    });
}

fn spawn_stderr_reader(
    stderr: tokio::process::ChildStderr,
    incoming: mpsc::UnboundedSender<Incoming>,
) {
    tokio::spawn(async move {
        let mut lines = BufReader::new(stderr).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            if !line.trim().is_empty() {
                let _ = incoming.send(Incoming::Stderr(line));
            }
        }
    });
}

fn spawn_child_waiter(
    mut child: Child,
    mut kill_rx: mpsc::UnboundedReceiver<ChildCommand>,
    bridge: Arc<Bridge>,
    incoming: mpsc::UnboundedSender<Incoming>,
) {
    tokio::spawn(async move {
        let code = tokio::select! {
            status = child.wait() => status.ok().and_then(|status| status.code()),
            Some(ChildCommand::Kill) = kill_rx.recv() => {
                let _ = child.start_kill();
                child.wait().await.ok().and_then(|status| status.code())
            }
        };
        bridge.started.store(false, Ordering::SeqCst);
        {
            let mut stdin = bridge.stdin.lock().await;
            *stdin = None;
        }
        bridge
            .fail_all(&format!(
                "app-server exited (code={})",
                code.map(|value| value.to_string()).unwrap_or_else(|| "none".into())
            ))
            .await;
        let _ = incoming.send(Incoming::Exit { code });
    });
}

async fn handle_line(
    bridge: &Bridge,
    incoming: &mpsc::UnboundedSender<Incoming>,
    requests: &mpsc::UnboundedSender<Incoming>,
    line: String,
) {
    let raw = line.trim();
    if raw.is_empty() {
        return;
    }
    let msg: Value = match serde_json::from_str(raw) {
        Ok(value) => value,
        Err(_) => {
            let _ = incoming.send(Incoming::Unparseable(raw.to_string()));
            return;
        }
    };
    // A JSON-RPC request has a method. A response never does. Server request
    // ids reuse the same integer space as client requests; matching on id
    // alone swallows approval and elicitation calls, and the turn waits forever.
    if let Some(method) = msg.get("method").and_then(Value::as_str) {
        if let Some(id) = msg.get("id").cloned().filter(|id| !id.is_null()) {
            let _ = requests.send(Incoming::ServerRequest {
                id,
                method: method.to_string(),
                params: msg.get("params").cloned().unwrap_or(Value::Null),
            });
            return;
        }
        let _ = incoming.send(Incoming::Notification {
            method: method.to_string(),
            params: msg.get("params").cloned().unwrap_or(Value::Null),
        });
        return;
    }
    if let Some(id) = msg.get("id").cloned().filter(|id| !id.is_null()) {
        if let Some(numeric) = value_as_u64(&id) {
            let waiter = {
                let mut pending = bridge.pending.lock().await;
                pending.remove(&numeric)
            };
            if let Some(tx) = waiter {
                if let Some(error) = msg.get("error") {
                    let message = error
                        .get("message")
                        .and_then(Value::as_str)
                        .map(str::to_string)
                        .unwrap_or_else(|| error.to_string());
                    let _ = tx.send(Err(RpcError { message }));
                } else {
                    let _ = tx.send(Ok(msg.get("result").cloned().unwrap_or(Value::Null)));
                }
            }
        }
    }
}

fn value_as_u64(value: &Value) -> Option<u64> {
    value
        .as_u64()
        .or_else(|| value.as_i64().and_then(|id| u64::try_from(id).ok()))
        .or_else(|| value.as_str().and_then(|id| id.parse().ok()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::sync::oneshot;

    fn test_bridge() -> (
        Arc<Bridge>,
        mpsc::UnboundedSender<Incoming>,
        mpsc::UnboundedReceiver<Incoming>,
        mpsc::UnboundedSender<Incoming>,
        mpsc::UnboundedReceiver<Incoming>,
    ) {
        let (kill_tx, _kill_rx) = mpsc::unbounded_channel();
        let (notify_tx, notify_rx) = mpsc::unbounded_channel();
        let (request_tx, request_rx) = mpsc::unbounded_channel();
        let bridge = Arc::new(Bridge {
            stdin: Mutex::new(None),
            pending: Mutex::new(HashMap::new()),
            next_id: AtomicU64::new(1),
            started: AtomicBool::new(true),
            kill_tx,
        });
        (bridge, notify_tx, notify_rx, request_tx, request_rx)
    }

    #[tokio::test]
    async fn server_request_reusing_client_id_is_not_a_response() {
        let (bridge, notify_tx, mut notify_rx, request_tx, mut request_rx) = test_bridge();
        let (tx, mut rx) = oneshot::channel();
        bridge.pending.lock().await.insert(7, tx);
        handle_line(
            &bridge,
            &notify_tx,
            &request_tx,
            r#"{"id":7,"method":"mcpServer/elicitation/request","params":{"serverName":"git-host"}}"#
                .into(),
        )
        .await;
        match request_rx.try_recv() {
            Ok(Incoming::ServerRequest { method, .. }) => {
                assert_eq!(method, "mcpServer/elicitation/request");
            }
            other => panic!("expected server request, got {other:?}"),
        }
        assert!(notify_rx.try_recv().is_err());
        assert!(rx.try_recv().is_err());
        assert!(bridge.pending.lock().await.contains_key(&7));
    }
}
