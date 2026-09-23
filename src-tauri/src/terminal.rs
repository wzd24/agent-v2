use crate::config;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use tauri::{AppHandle, Emitter};

struct Session {
    writer: Mutex<Box<dyn Write + Send>>,
    master: Mutex<Box<dyn MasterPty + Send>>,
    killer: Mutex<Box<dyn ChildKiller + Send + Sync>>,
}

pub struct TerminalHub {
    next_id: AtomicU64,
    sessions: tokio::sync::Mutex<HashMap<String, Arc<Session>>>,
}

impl TerminalHub {
    pub fn new() -> Self {
        Self {
            next_id: AtomicU64::new(1),
            sessions: tokio::sync::Mutex::new(HashMap::new()),
        }
    }

    pub async fn start(
        &self,
        app: AppHandle,
        cwd: Option<String>,
        shell: Option<String>,
        cols: Option<u16>,
        rows: Option<u16>,
    ) -> Result<Value, String> {
        let id = format!("term-{}", self.next_id.fetch_add(1, Ordering::SeqCst));
        let workspace = config::workspace_root();
        let cwd = cwd
            .filter(|value| !value.trim().is_empty())
            .map(PathBuf::from)
            .unwrap_or_else(|| workspace.clone());
        if !is_inside(&workspace, &cwd) {
            return Err("终端目录必须位于当前工作区内".into());
        }
        let shell_name = shell
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| "PowerShell".into());
        let cols = cols.unwrap_or(120).max(20);
        let rows = rows.unwrap_or(30).max(5);
        let (exe, args) = shell_command(&shell_name);
        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|err| format!("无法创建终端：{err}"))?;
        let mut command = CommandBuilder::new(&exe);
        for arg in &args {
            command.arg(arg);
        }
        command.cwd(&cwd);
        command.env("TERM", "xterm-256color");
        let mut child = pair
            .slave
            .spawn_command(command)
            .map_err(|err| format!("无法启动终端：{err}"))?;
        let killer = child.clone_killer();
        let mut reader = pair
            .master
            .try_clone_reader()
            .map_err(|err| err.to_string())?;
        let writer = pair.master.take_writer().map_err(|err| err.to_string())?;
        let master = pair.master;
        let session = Arc::new(Session {
            writer: Mutex::new(writer),
            master: Mutex::new(master),
            killer: Mutex::new(killer),
        });
        let output_id = id.clone();
        let output_app = app.clone();
        std::thread::spawn(move || {
            let mut buffer = [0u8; 4096];
            loop {
                match reader.read(&mut buffer) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        let text = String::from_utf8_lossy(&buffer[..n]).to_string();
                        let _ = output_app.emit(
                            "terminal://output",
                            json!({ "id": output_id, "data": text }),
                        );
                    }
                }
            }
        });
        let exit_id = id.clone();
        let exit_app = app.clone();
        std::thread::spawn(move || {
            let code = match child.wait() {
                Ok(status) => status.exit_code() as i32,
                Err(_) => 1,
            };
            let _ = exit_app.emit(
                "terminal://exit",
                json!({ "id": exit_id, "exitCode": code, "signal": Value::Null }),
            );
        });
        self.sessions.lock().await.insert(id.clone(), session);
        Ok(json!({ "id": id, "cwd": cwd.display().to_string(), "shell": exe }))
    }

    pub async fn write(&self, id: &str, data: &str) -> Result<bool, String> {
        let sessions = self.sessions.lock().await;
        let Some(session) = sessions.get(id).cloned() else {
            return Ok(false);
        };
        drop(sessions);
        let bytes = data.as_bytes().to_vec();
        tokio::task::spawn_blocking(move || {
            let mut writer = session.writer.lock().map_err(|err| err.to_string())?;
            writer.write_all(&bytes).map_err(|err| err.to_string())?;
            writer.flush().map_err(|err| err.to_string())?;
            Ok(true)
        })
        .await
        .map_err(|err| err.to_string())?
    }

    pub async fn resize(&self, id: &str, cols: u16, rows: u16) -> Result<bool, String> {
        let sessions = self.sessions.lock().await;
        let Some(session) = sessions.get(id).cloned() else {
            return Ok(false);
        };
        let master = session.master.lock().map_err(|err| err.to_string())?;
        master
            .resize(PtySize {
                rows: rows.max(5),
                cols: cols.max(20),
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|err| err.to_string())?;
        Ok(true)
    }

    pub async fn terminate(&self, id: &str) -> Result<bool, String> {
        let mut sessions = self.sessions.lock().await;
        let Some(session) = sessions.remove(id) else {
            return Ok(false);
        };
        if let Ok(mut killer) = session.killer.lock() {
            let _ = killer.kill();
        }
        Ok(true)
    }

    pub async fn count(&self) -> usize {
        self.sessions.lock().await.len()
    }
}

fn is_inside(root: &std::path::Path, target: &std::path::Path) -> bool {
    fn normalize(path: &std::path::Path) -> Option<PathBuf> {
        let canonical = std::fs::canonicalize(path).ok()?;
        let text = canonical.to_string_lossy();
        Some(PathBuf::from(text.strip_prefix(r"\\?\").unwrap_or(&text)))
    }
    let Some(root) = normalize(root) else {
        return false;
    };
    let Some(target) = normalize(target) else {
        return false;
    };
    target.starts_with(&root)
}

fn first_existing(paths: impl IntoIterator<Item = PathBuf>) -> Option<PathBuf> {
    paths.into_iter().find(|path| path.exists())
}

fn look_path(name: &str) -> Option<PathBuf> {
    let mut command = std::process::Command::new("where.exe");
    crate::mcp::hide_command(&mut command);
    let output = command.arg(name).output().ok()?;
    if !output.status.success() {
        return None;
    }
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .next()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(PathBuf::from)
        .filter(|path| path.exists())
}

fn shell_command(shell: &str) -> (String, Vec<String>) {
    let lowered = shell.to_lowercase();
    if lowered.contains("cmd") || lowered.contains("命令提示符") {
        return (
            std::env::var("ComSpec").unwrap_or_else(|_| "cmd.exe".into()),
            Vec::new(),
        );
    }
    if lowered.contains("bash") || lowered.contains("git") {
        let program = PathBuf::from(std::env::var("ProgramFiles").unwrap_or_default());
        if let Some(bash) = first_existing([program.join("Git/bin/bash.exe")]) {
            return (bash.display().to_string(), vec!["--login".into()]);
        }
    }
    let system_root = PathBuf::from(std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".into()));
    let powershell = look_path("pwsh.exe")
        .or_else(|| look_path("powershell.exe"))
        .or_else(|| {
            first_existing([system_root.join("System32/WindowsPowerShell/v1.0/powershell.exe")])
        })
        .unwrap_or_else(|| PathBuf::from("powershell.exe"));
    (powershell.display().to_string(), vec!["-NoLogo".into()])
}
