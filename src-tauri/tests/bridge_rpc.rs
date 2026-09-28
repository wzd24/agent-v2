use app_lib::bridge::{Bridge, Incoming};
use serde_json::json;
use std::collections::HashMap;
use std::path::PathBuf;
use std::time::Duration;
use tokio::sync::mpsc;

fn fake_bin() -> PathBuf {
    PathBuf::from(env!("CARGO_BIN_EXE_fake-app-server"))
}

async fn spawn_bridge() -> (
    std::sync::Arc<Bridge>,
    mpsc::UnboundedReceiver<Incoming>,
    mpsc::UnboundedReceiver<Incoming>,
) {
    let (tx, rx) = mpsc::unbounded_channel();
    let (request_tx, request_rx) = mpsc::unbounded_channel();
    let bridge = Bridge::spawn(fake_bin(), &[], HashMap::new(), tx, request_tx).expect("spawn fake server");
    (bridge, rx, request_rx)
}

#[tokio::test]
async fn initialize_roundtrip() {
    let (bridge, _rx, _requests) = spawn_bridge().await;
    let result = bridge
        .initialize(
            json!({ "name": "test", "title": "Test", "version": "0" }),
            json!({ "capabilities": { "experimentalApi": true, "requestAttestation": false } }),
        )
        .await
        .expect("initialize");
    assert_eq!(result["serverInfo"]["name"], "fake-app-server");
    bridge.stop().await;
}

#[tokio::test]
async fn request_matches_pending_id() {
    let (bridge, _rx, _requests) = spawn_bridge().await;
    let listed = bridge
        .request("thread/list", json!({}))
        .await
        .expect("thread/list");
    assert!(listed["data"].as_array().unwrap().is_empty());
    bridge.stop().await;
}

#[tokio::test]
async fn notification_is_forwarded() {
    let (bridge, mut rx, _requests) = spawn_bridge().await;
    let _ = bridge.request("notify-me", json!({})).await.expect("notify-me");
    let incoming = tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            match rx.recv().await {
                Some(Incoming::Notification { method, params }) => {
                    return (method, params);
                }
                Some(_) => continue,
                None => panic!("channel closed"),
            }
        }
    })
    .await
    .expect("notification timeout");
    assert_eq!(incoming.0, "item/agentMessage/delta");
    assert_eq!(incoming.1["delta"], "hi");
    bridge.stop().await;
}

#[tokio::test]
async fn server_request_is_forwarded() {
    let (bridge, _rx, mut requests) = spawn_bridge().await;
    let _ = bridge.request("ask", json!({})).await.expect("ask");
    let incoming = tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            match requests.recv().await {
                Some(Incoming::ServerRequest { method, params, .. }) => {
                    return (method, params);
                }
                Some(_) => continue,
                None => panic!("channel closed"),
            }
        }
    })
    .await
    .expect("server request timeout");
    assert_eq!(incoming.0, "item/commandExecution/requestApproval");
    assert_eq!(incoming.1["command"], "echo hello");
    bridge.stop().await;
}

#[tokio::test]
async fn exit_fails_pending_requests() {
    let (bridge, _rx, _requests) = spawn_bridge().await;
    let pending = tokio::spawn({
        let bridge = std::sync::Arc::clone(&bridge);
        async move { bridge.request("hang", json!({})).await }
    });
    tokio::time::sleep(Duration::from_millis(50)).await;
    let _ = bridge.request("crash", json!({})).await;
    let err = tokio::time::timeout(Duration::from_secs(2), pending)
        .await
        .expect("join timeout")
        .expect("task")
        .expect_err("hang should fail when process exits");
    assert!(err.message.contains("exited") || err.message.contains("停止") || err.message.contains("未启动"));
}

#[tokio::test]
async fn extra_env_reaches_child() {
    let (tx, _rx) = mpsc::unbounded_channel();
    let (request_tx, _request_rx) = mpsc::unbounded_channel();
    let mut extra = HashMap::new();
    extra.insert("TEST_SECRET_KEY".into(), "present".into());
    let bridge = Bridge::spawn(fake_bin(), &[], extra, tx, request_tx).expect("spawn fake server");
    let result = bridge
        .request("env-check", json!({}))
        .await
        .expect("env-check");
    assert_eq!(result["present"], true);
    bridge.stop().await;
}
