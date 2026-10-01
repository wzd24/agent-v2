use crate::config;
use crate::engine::Engine;
use crate::mcp;
use crate::plugins;
use crate::skills;
use serde_json::{json, Value};

pub async fn after_connect(engine: &Engine) {
    crate::hooks::publish_to_engine();
    sync_skill_roots(engine).await;
    sync_hooks(engine).await;
    mcp::write_contexts();
    mcp::ensure_defaults(engine).await;
    let home = config::engine_home();
    let _ = config::ensure_config(&home);
    if let Ok(settings) = config::read_settings(&home) {
        let _ = engine
            .request(
                "config/batchWrite",
                json!({
                    "edits": [
                        {
                            "keyPath": "model_provider",
                            "value": settings.model_provider,
                            "mergeStrategy": "replace"
                        },
                        {
                            "keyPath": "model",
                            "value": settings.model,
                            "mergeStrategy": "replace"
                        }
                    ],
                    "reloadUserConfig": true
                }),
            )
            .await;
        if let Some(prefs) = config::read_preferences()
            .get("model_provider")
            .and_then(Value::as_str)
        {
            let canonical = config::canonical_model_provider(prefs);
            if canonical != prefs {
                let _ = config::write_preference("model_provider", json!(canonical));
            }
        }
    }
    let workspace = config::workspace_root();
    if workspace.is_dir() && workspace.join(".git").exists() {
        let name = workspace
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_else(|| workspace.display().to_string());
        let _ = crate::projects::register_project(&workspace.display().to_string(), &name);
    }
    let _ = engine
        .request(
            "config/value/write",
            json!({
                "keyPath": "approval_policy",
                "value": config::approval_policy(),
                "mergeStrategy": "replace"
            }),
        )
        .await;
    let _ = engine
        .request(
            "config/value/write",
            json!({
                "keyPath": "sandbox_mode",
                "value": config::sandbox_mode(),
                "mergeStrategy": "replace"
            }),
        )
        .await;
    let _ = engine
        .request(
            "config/value/write",
            json!({
                "keyPath": "sandbox_workspace_write.network_access",
                "value": config::sandbox_network(),
                "mergeStrategy": "replace"
            }),
        )
        .await;
}

fn missing_or_null(object: &serde_json::Map<String, Value>, key: &str) -> bool {
    object.get(key).map(Value::is_null).unwrap_or(true)
}

pub fn enrich_params(method: &str, params: Value) -> Value {
    let mut params = if params.is_object() {
        params
    } else {
        json!({})
    };
    let Some(object) = params.as_object_mut() else {
        return params;
    };
    match method {
        "thread/settings/update" => {
            rewrite_existing_model_provider(object);
        }
        "thread/start" | "thread/resume" | "thread/fork" => {
            sanitize_model_provider_param(object);
            if missing_or_null(object, "sandbox") {
                object.insert("sandbox".into(), json!(config::sandbox_mode()));
            }
            if missing_or_null(object, "approvalPolicy") {
                object.insert("approvalPolicy".into(), json!(config::approval_policy()));
            }
            object.remove("permissions");
            // Local project ids live in projects.json and are unknown to
            // Codex app-server. Sending them makes thread/start fail with
            // "project not found: proj-…".
            object.remove("projectId");
            if object.get("cwd").and_then(Value::as_str).unwrap_or("").is_empty() {
                let root = config::workspace_root();
                if root.exists() {
                    object.insert("cwd".into(), json!(root.display().to_string()));
                }
            }
            let roots_missing = object
                .get("runtimeWorkspaceRoots")
                .map(|value| {
                    value.is_null() || value.as_array().map(|items| items.is_empty()).unwrap_or(true)
                })
                .unwrap_or(true);
            if roots_missing {
                let root = config::workspace_root();
                if root.exists() {
                    object.insert(
                        "runtimeWorkspaceRoots".into(),
                        json!([root.display().to_string()]),
                    );
                }
            }
            config::log_event(&format!(
                "rpc {method} sandbox={} approval={}",
                object
                    .get("sandbox")
                    .and_then(Value::as_str)
                    .unwrap_or("?"),
                object
                    .get("approvalPolicy")
                    .and_then(Value::as_str)
                    .unwrap_or("?")
            ));
        }
        "config/value/write" => rewrite_provider_edit(object),
        "config/batchWrite" => {
            if let Some(edits) = object.get_mut("edits").and_then(Value::as_array_mut) {
                for edit in edits {
                    if let Some(item) = edit.as_object_mut() {
                        rewrite_provider_edit(item);
                    }
                }
            }
        }
        "turn/start" => {
            object.remove("permissions");
            rewrite_existing_model_provider(object);
            // Existing threads can keep a read-only, network-restricted policy.
            // External tools then wait on an approval that never unblocks the turn.
            if missing_or_null(object, "sandboxPolicy") {
                object.insert("sandboxPolicy".into(), config::sandbox_policy());
            }
            if missing_or_null(object, "approvalPolicy") {
                object.insert("approvalPolicy".into(), json!(config::approval_policy()));
            }
        }
        _ => {}
    }
    params
}

/// Rewrites a legacy provider id (a catalog slug such as `deepseek-flash`) to `deepseek`.
/// Leaves the model id unchanged; that slug is still the catalog default.
fn rewrite_existing_model_provider(object: &mut serde_json::Map<String, Value>) {
    if let Some(value) = object.get("modelProvider").and_then(Value::as_str) {
        let next = config::canonical_model_provider(value);
        if next != value {
            object.insert("modelProvider".into(), json!(next));
        }
    }
}

fn sanitize_model_provider_param(object: &mut serde_json::Map<String, Value>) {
    rewrite_existing_model_provider(object);
    if object
        .get("modelProvider")
        .and_then(Value::as_str)
        .is_some()
    {
        return;
    }
    if object.contains_key("modelProvider") && object.get("modelProvider") != Some(&Value::Null) {
        return;
    }
    let from_model = object
        .get("model")
        .and_then(Value::as_str)
        .map(config::canonical_model_provider)
        .unwrap_or_else(|| config::canonical_model_provider(""));
    object.insert("modelProvider".into(), json!(from_model));
}

fn rewrite_provider_edit(object: &mut serde_json::Map<String, Value>) {
    let key = object
        .get("keyPath")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    if key == "model_provider" {
        if let Some(value) = object.get("value").and_then(Value::as_str) {
            object.insert("value".into(), json!(config::canonical_model_provider(value)));
        }
        return;
    }
    let Some(rest) = key.strip_prefix("model_providers.") else {
        return;
    };
    let (name, suffix) = rest.split_once('.').unwrap_or((rest, ""));
    let canonical = config::canonical_model_provider(name);
    if canonical == name {
        return;
    }
    let next = if suffix.is_empty() {
        format!("model_providers.{canonical}")
    } else {
        format!("model_providers.{canonical}.{suffix}")
    };
    object.insert("keyPath".into(), json!(next));
    if suffix == "name" {
        if let Some(value) = object.get("value").and_then(Value::as_str) {
            object.insert("value".into(), json!(config::canonical_model_provider(value)));
        }
    }
}

pub fn rewrite_result(method: &str, result: Value) -> Value {
    match method {
        "model/list" => config::provider_model_catalog(),
        _ => result,
    }
}

pub async fn sync_skill_roots(engine: &Engine) {
    let prefs = config::read_preferences();
    let include = prefs.get("plugins_enabled").and_then(Value::as_bool) != Some(false);
    let roots = if include {
        plugins::plugin_skill_roots()
    } else {
        Vec::new()
    };
    let extra = skills::extra_roots(roots);
    config::log_event(&format!(
        "skills extraRoots {}: {}",
        extra.len(),
        extra.join(" | ")
    ));
    if let Err(err) = engine
        .request("skills/extraRoots/set", json!({ "extraRoots": extra }))
        .await
    {
        tracing::warn!("skills/extraRoots/set failed: {}", err.message);
        config::log_event(&format!("skills extraRoots failed: {}", err.message));
    }
}

pub async fn sync_hooks(engine: &Engine) {
    let enabled = config::read_preferences().get("hooks_enabled").and_then(Value::as_bool)
        != Some(false);
    if let Err(err) = engine
        .request(
            "experimentalFeature/enablement/set",
            json!({ "enablement": { "hooks": enabled } }),
        )
        .await
    {
        tracing::warn!("hooks enablement failed: {}", err.message);
        config::log_event(&format!("hooks enablement failed: {}", err.message));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rewrite_model_list_replaces_openai_catalog() {
        let rewritten = rewrite_result(
            "model/list",
            json!({ "data": [{ "id": "gpt-6-astra", "displayName": "GPT-6-Astra" }] }),
        );
        let data = rewritten.get("data").and_then(Value::as_array).expect("data");
        assert!(!data.is_empty());
        assert!(data.iter().all(|item| {
            !item
                .get("displayName")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .starts_with("GPT-")
        }));
    }

    #[test]
    fn thread_start_drops_local_project_id() {
        let params = enrich_params(
            "thread/start",
            json!({
                "cwd": "D:/tmp",
                "projectId": "proj-1790083906071"
            }),
        );
        assert!(params.get("projectId").is_none());
        assert_eq!(params["cwd"], "D:/tmp");
    }

    #[test]
    fn turn_start_injects_configured_sandbox_policy() {
        let params = enrich_params("turn/start", json!({ "threadId": "t1", "permissions": "default" }));
        let policy = params.get("sandboxPolicy").expect("sandboxPolicy");
        assert!(policy.get("type").and_then(Value::as_str).is_some());
        assert!(params.get("approvalPolicy").and_then(Value::as_str).is_some());
        assert!(params.get("permissions").is_none());
        assert!(params.get("modelProvider").is_none());
    }

    #[test]
    fn resume_rewrites_slug_model_provider() {
        let params = enrich_params(
            "thread/resume",
            json!({
                "threadId": "t1",
                "modelProvider": "deepseek-flash"
            }),
        );
        assert_eq!(params["modelProvider"], "deepseek");
    }

    #[test]
    fn batch_write_rewrites_model_slug_provider() {
        let params = enrich_params(
            "config/batchWrite",
            json!({
                "edits": [
                    { "keyPath": "model_provider", "value": "deepseek-flash", "mergeStrategy": "replace" },
                    { "keyPath": "model_providers.deepseek-flash.base_url", "value": "https://api.deepseek.com/", "mergeStrategy": "replace" }
                ]
            }),
        );
        let edits = params["edits"].as_array().expect("edits");
        assert_eq!(edits[0]["value"], "deepseek");
        assert_eq!(edits[1]["keyPath"], "model_providers.deepseek.base_url");
    }
}
