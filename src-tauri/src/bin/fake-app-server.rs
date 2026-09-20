use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Write};

fn main() {
    let stdin = std::io::stdin();
    let mut stdout = std::io::stdout();
    let mut reader = BufReader::new(stdin.lock());
    let mut line = String::new();
    let mut server_request_id = 9000u64;

    loop {
        line.clear();
        if reader.read_line(&mut line).unwrap_or(0) == 0 {
            break;
        }
        let raw = line.trim();
        if raw.is_empty() {
            continue;
        }
        let msg: Value = match serde_json::from_str(raw) {
            Ok(value) => value,
            Err(_) => continue,
        };
        let Some(method) = msg.get("method").and_then(Value::as_str) else {
            continue;
        };
        let id = msg.get("id").cloned();
        match method {
            "initialized" => {}
            "hang" => {}
            "crash" => std::process::exit(2),
            "env-check" => {
                let present = std::env::var("TEST_SECRET_KEY")
                    .ok()
                    .filter(|value| !value.is_empty())
                    .is_some();
                if let Some(id) = id {
                    writeln!(stdout, "{}", json!({ "id": id, "result": { "present": present } })).ok();
                    stdout.flush().ok();
                }
            }
            "notify-me" => {
                writeln!(
                    stdout,
                    "{}",
                    json!({
                        "method": "item/agentMessage/delta",
                        "params": { "threadId": "t1", "turnId": "u1", "itemId": "i1", "delta": "hi" }
                    })
                )
                .ok();
                if let Some(id) = id {
                    writeln!(stdout, "{}", json!({ "id": id, "result": { "ok": true } })).ok();
                }
                stdout.flush().ok();
            }
            "ask" => {
                server_request_id += 1;
                writeln!(
                    stdout,
                    "{}",
                    json!({
                        "id": server_request_id,
                        "method": "item/commandExecution/requestApproval",
                        "params": { "command": "echo hello", "cwd": ".", "threadId": "t1", "turnId": "u1", "itemId": "i1" }
                    })
                )
                .ok();
                if let Some(id) = id {
                    writeln!(stdout, "{}", json!({ "id": id, "result": { "ok": true } })).ok();
                }
                stdout.flush().ok();
            }
            other => {
                let Some(id) = id else { continue };
                let result = match other {
                    "initialize" => json!({
                        "serverInfo": { "name": "fake-app-server", "version": "0.1.0" }
                    }),
                    "thread/list" => json!({
                        "data": [],
                        "nextCursor": null,
                        "backwardsCursor": null
                    }),
                    _ => json!({ "ok": true, "method": other }),
                };
                writeln!(stdout, "{}", json!({ "id": id, "result": result })).ok();
                stdout.flush().ok();
            }
        }
    }
}
