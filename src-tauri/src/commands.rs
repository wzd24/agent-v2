use crate::config::{self, Settings, SettingsPatch};
use crate::engine::EngineStatus;
use crate::workspace::{self, FileContent, TreeEntry};
use crate::AppState;
use serde_json::Value;
use std::path::PathBuf;
use tauri::{AppHandle, State};
use tauri_plugin_dialog::DialogExt;

#[tauri::command]
pub async fn engine_status(state: State<'_, AppState>) -> Result<EngineStatus, String> {
    Ok(state.engine.status().await)
}

#[tauri::command]
pub async fn engine_restart(state: State<'_, AppState>) -> Result<EngineStatus, String> {
    state.engine.restart().await;
    Ok(state.engine.status().await)
}

#[tauri::command]
pub async fn rpc_request(
    state: State<'_, AppState>,
    method: String,
    params: Option<Value>,
) -> Result<Value, String> {
    if method == "model/list" {
        return Ok(config::provider_model_catalog());
    }
    let payload = params.unwrap_or(Value::Null);
    let result = match state.engine.request(&method, payload.clone()).await {
        Ok(value) => value,
        Err(err) => {
            if method == "thread/list" || method == "thread/search" {
                crate::config::log_event(&format!("rpc {method} failed: {}", err.message));
            }
            return Err(err.message);
        }
    };
    if method == "thread/list" || method == "thread/search" {
        let archived = payload
            .get("archived")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let search = payload
            .get("searchTerm")
            .and_then(Value::as_str)
            .unwrap_or("");
        let result = crate::threads::hydrate_thread_list(result);
        let result = crate::threads::merge_local_sessions(result, archived, search);
        let result = if crate::config::mock_active() {
            result
        } else {
            crate::threads::hydrate_missing_cwd(std::sync::Arc::clone(&state.engine), result).await
        };
        Ok(crate::projects::attach_project_ids(result))
    } else if method == "thread/start" || method == "thread/fork" {
        Ok(crate::projects::attach_started_thread(result))
    } else {
        Ok(result)
    }
}

#[tauri::command]
pub async fn rpc_notify(
    state: State<'_, AppState>,
    method: String,
    params: Option<Value>,
) -> Result<(), String> {
    state
        .engine
        .notify(&method, params.unwrap_or(Value::Null))
        .await
        .map_err(|err| err.message)
}

#[tauri::command]
pub async fn rpc_respond(state: State<'_, AppState>, id: Value, result: Value) -> Result<(), String> {
    state.engine.respond(id, result).await.map_err(|err| err.message)
}

#[tauri::command]
pub async fn pick_workspace(app: AppHandle) -> Result<Option<String>, String> {
    crate::tray::show_window(&app);
    let _cover = crate::host::OverlayGuard::new(&app);
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .set_title("选择工作区")
        .pick_folder(move |folder| {
            let _ = tx.send(folder);
        });
    let Some(folder) = rx.await.map_err(|err| err.to_string())? else {
        return Ok(None);
    };
    let path = folder
        .into_path()
        .map_err(|err| err.to_string())?
        .display()
        .to_string();
    let home = config::resolve_codex_home();
    config::save_settings(
        &home,
        SettingsPatch {
            workspace: Some(path.clone()),
            ..SettingsPatch::default()
        },
    )?;
    Ok(Some(path))
}

#[tauri::command]
pub async fn list_workspace(
    root: String,
    path: Option<String>,
    depth: Option<u32>,
) -> Result<Vec<TreeEntry>, String> {
    let root_path = PathBuf::from(&root);
    let depth = depth.unwrap_or(0);
    match path {
        Some(current) if !current.trim().is_empty() => {
            workspace::list_tree_at(&root_path, &PathBuf::from(current), depth)
        }
        _ => workspace::list_tree(&root_path, depth),
    }
}

#[tauri::command]
pub async fn read_workspace_file(root: String, path: String) -> Result<FileContent, String> {
    workspace::read_text_file(&PathBuf::from(root), &PathBuf::from(path))
}

#[tauri::command]
pub async fn get_settings() -> Result<Settings, String> {
    let home = config::resolve_codex_home();
    Ok(config::ensure_workspace(&home)?)
}

#[tauri::command(rename_all = "camelCase")]
pub async fn save_settings(
    state: State<'_, AppState>,
    patch: Option<SettingsPatch>,
    model: Option<String>,
    base_url: Option<String>,
    api_key: Option<String>,
    workspace: Option<String>,
    restart: Option<bool>,
) -> Result<Settings, String> {
    let mut merged = patch.unwrap_or_default();
    if merged.model.is_none() {
        merged.model = model;
    }
    if merged.base_url.is_none() {
        merged.base_url = base_url;
    }
    if merged.api_key.is_none() {
        merged.api_key = api_key;
    }
    if merged.workspace.is_none() {
        merged.workspace = workspace;
    }
    let has_key = merged
        .api_key
        .as_deref()
        .map(str::trim)
        .is_some_and(|value| !value.is_empty());
    config::log_event(&format!(
        "save_settings api_key={} restart={}",
        if has_key { "yes" } else { "no" },
        restart.unwrap_or(true)
    ));
    let home = config::resolve_codex_home();
    let settings = config::save_settings(&home, merged)?;
    if restart.unwrap_or(true) {
        state.engine.restart().await;
    }
    Ok(settings)
}
