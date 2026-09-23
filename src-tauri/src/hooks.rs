use crate::config;
use serde_json::{json, Map, Value};
use std::fs;
use std::path::{Path, PathBuf};

const EVENTS: &[&str] = &[
    "PreToolUse",
    "PermissionRequest",
    "PostToolUse",
    "PreCompact",
    "PostCompact",
    "SessionStart",
    "SessionEnd",
    "UserPromptSubmit",
    "SubagentStart",
    "SubagentStop",
    "Stop",
    "Interrupt",
];

fn event_name(value: &str) -> Option<&'static str> {
    let raw = value.trim();
    EVENTS
        .iter()
        .copied()
        .find(|name| *name == raw || name.eq_ignore_ascii_case(raw))
}

fn user_file() -> PathBuf {
    let dest = config::app_root().join("hooks.json");
    let _ = config::copy_file_if_absent(&config::engine_home().join("hooks.json"), &dest);
    dest
}

fn project_file(workspace: &Path) -> PathBuf {
    let dest = workspace.join(".local-codex").join("hooks.json");
    let _ = config::copy_file_if_absent(&workspace.join(".codex").join("hooks.json"), &dest);
    dest
}

fn read_document(file: &Path) -> Result<Value, String> {
    if !file.exists() {
        return Ok(json!({ "hooks": {} }));
    }
    let raw: Value = serde_json::from_str(&fs::read_to_string(file).map_err(|err| err.to_string())?)
        .map_err(|err| format!("{} 不是有效 JSON：{err}", file.display()))?;
    let hooks = if raw.get("hooks").map(Value::is_object).unwrap_or(false) {
        raw.get("hooks").cloned().unwrap_or_else(|| json!({}))
    } else {
        raw.clone()
    };
    Ok(json!({ "hooks": hooks, "description": raw.get("description") }))
}

fn write_document(file: &Path, document: &Value) -> Result<(), String> {
    if let Some(parent) = file.parent() {
        fs::create_dir_all(parent).map_err(|err| err.to_string())?;
    }
    let mut payload = json!({ "hooks": {} });
    if let Some(description) = document.get("description").and_then(Value::as_str) {
        if !description.trim().is_empty() {
            payload
                .as_object_mut()
                .unwrap()
                .insert("description".into(), json!(description.trim()));
        }
    }
    let mut hooks = Map::new();
    for event in EVENTS {
        if let Some(groups) = document
            .pointer(&format!("/hooks/{event}"))
            .and_then(Value::as_array)
        {
            let kept: Vec<Value> = groups
                .iter()
                .filter(|group| {
                    group
                        .get("hooks")
                        .and_then(Value::as_array)
                        .map(|items| !items.is_empty())
                        .unwrap_or(false)
                })
                .cloned()
                .collect();
            if !kept.is_empty() {
                hooks.insert((*event).into(), json!(kept));
            }
        }
    }
    payload
        .as_object_mut()
        .unwrap()
        .insert("hooks".into(), Value::Object(hooks));
    fs::write(
        file,
        format!(
            "{}\n",
            serde_json::to_string_pretty(&payload).map_err(|err| err.to_string())?
        ),
    )
    .map_err(|err| err.to_string())?;
    publish_to_engine();
    Ok(())
}

fn copy_over(source: &Path, dest: &Path) {
    if !source.is_file() {
        return;
    }
    if let Some(parent) = dest.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let _ = fs::copy(source, dest);
}

pub fn publish_to_engine() {
    copy_over(&user_file(), &config::engine_home().join("hooks.json"));
    let workspace = config::workspace_root();
    if workspace.is_dir() {
        copy_over(
            &project_file(&workspace),
            &workspace.join(".codex").join("hooks.json"),
        );
    }
}

fn flatten(scope: &str, file: &Path, document: &Value) -> Vec<Value> {
    let mut items = Vec::new();
    for event in EVENTS {
        let groups = document
            .pointer(&format!("/hooks/{event}"))
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        for (group_index, group) in groups.iter().enumerate() {
            let hooks = group
                .get("hooks")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            for (hook_index, hook) in hooks.iter().enumerate() {
                items.push(json!({
                    "id": format!("{scope}:{event}:{group_index}:{hook_index}"),
                    "scope": scope,
                    "file": file.display().to_string(),
                    "event": event,
                    "matcher": group.get("matcher").and_then(Value::as_str).unwrap_or(""),
                    "groupIndex": group_index,
                    "hookIndex": hook_index,
                    "type": hook.get("type").and_then(Value::as_str).unwrap_or("command"),
                    "command": hook.get("command").and_then(Value::as_str).unwrap_or(""),
                    "commandWindows": hook.get("commandWindows").and_then(Value::as_str).unwrap_or(""),
                    "statusMessage": hook.get("statusMessage").and_then(Value::as_str).unwrap_or(""),
                    "timeout": hook.get("timeout").cloned().or_else(|| hook.get("timeoutSec").cloned()).unwrap_or(Value::Null),
                    "async": hook.get("async").and_then(Value::as_bool).unwrap_or(false),
                }));
            }
        }
    }
    items
}

pub fn list_files() -> Value {
    let entries = vec![
        ("user", user_file()),
        ("project", project_file(&config::workspace_root())),
    ];
    json!(entries
        .into_iter()
        .map(|(scope, file)| {
            match read_document(&file) {
                Ok(document) => json!({
                    "scope": scope,
                    "file": file.display().to_string(),
                    "exists": file.exists(),
                    "hooks": flatten(scope, &file, &document),
                    "error": "",
                }),
                Err(error) => json!({
                    "scope": scope,
                    "file": file.display().to_string(),
                    "exists": file.exists(),
                    "hooks": [],
                    "error": error,
                }),
            }
        })
        .collect::<Vec<_>>())
}

fn resolve_file(scope: &str) -> Result<PathBuf, String> {
    match scope {
        "project" => Ok(project_file(&config::workspace_root())),
        "user" => Ok(user_file()),
        _ => Err("只能编辑用户或项目 Hooks".into()),
    }
}

pub fn add(payload: &Value) -> Result<Value, String> {
    let scope = payload
        .get("scope")
        .and_then(Value::as_str)
        .unwrap_or("user");
    let file = resolve_file(scope)?;
    let mut document = read_document(&file)?;
    let event = event_name(payload.get("event").and_then(Value::as_str).unwrap_or(""))
        .ok_or_else(|| "不支持的 Hook 事件".to_string())?;
    let command = payload
        .get("command")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    if command.is_empty() {
        return Err("命令不能为空".into());
    }
    let mut handler = json!({ "type": "command", "command": command });
    if let Some(value) = payload.get("commandWindows").and_then(Value::as_str) {
        if !value.trim().is_empty() {
            handler
                .as_object_mut()
                .unwrap()
                .insert("commandWindows".into(), json!(value.trim()));
        }
    }
    if let Some(value) = payload.get("statusMessage").and_then(Value::as_str) {
        if !value.trim().is_empty() {
            handler
                .as_object_mut()
                .unwrap()
                .insert("statusMessage".into(), json!(value.trim()));
        }
    }
    if let Some(timeout) = payload.get("timeout").and_then(Value::as_f64) {
        handler
            .as_object_mut()
            .unwrap()
            .insert("timeout".into(), json!(timeout));
    }
    if payload.get("async").and_then(Value::as_bool).unwrap_or(false) {
        handler
            .as_object_mut()
            .unwrap()
            .insert("async".into(), json!(true));
    }
    let matcher = payload
        .get("matcher")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_string();
    let hooks = document
        .as_object_mut()
        .unwrap()
        .entry("hooks")
        .or_insert_with(|| json!({}));
    let groups = hooks
        .as_object_mut()
        .unwrap()
        .entry(event.to_string())
        .or_insert_with(|| json!([]));
    let mut found = false;
    if let Some(list) = groups.as_array_mut() {
        for group in list.iter_mut() {
            let current = group
                .get("matcher")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            if current == matcher {
                group
                    .as_object_mut()
                    .unwrap()
                    .entry("hooks")
                    .or_insert_with(|| json!([]))
                    .as_array_mut()
                    .unwrap()
                    .push(handler.clone());
                found = true;
                break;
            }
        }
        if !found {
            let mut group = json!({ "hooks": [handler] });
            if !matcher.is_empty() {
                group
                    .as_object_mut()
                    .unwrap()
                    .insert("matcher".into(), json!(matcher));
            }
            list.push(group);
        }
    }
    write_document(&file, &document)?;
    let saved = read_document(&file)?;
    Ok(json!({
        "file": file.display().to_string(),
        "scope": scope,
        "hooks": flatten(scope, &file, &saved),
    }))
}

pub fn remove(payload: &Value) -> Result<Value, String> {
    let scope = payload
        .get("scope")
        .and_then(Value::as_str)
        .unwrap_or("user");
    let file = payload
        .get("file")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .unwrap_or(resolve_file(scope)?);
    let mut document = read_document(&file)?;
    let event = event_name(payload.get("event").and_then(Value::as_str).unwrap_or(""))
        .ok_or_else(|| "找不到要删除的 Hook 组".to_string())?;
    let group_index = payload.get("groupIndex").and_then(Value::as_u64).unwrap_or(0) as usize;
    let hook_index = payload.get("hookIndex").and_then(Value::as_u64).unwrap_or(0) as usize;
    let groups = document
        .pointer_mut(&format!("/hooks/{event}"))
        .and_then(Value::as_array_mut)
        .ok_or_else(|| "找不到要删除的 Hook 组".to_string())?;
    let group = groups
        .get_mut(group_index)
        .ok_or_else(|| "找不到要删除的 Hook 组".to_string())?;
    let hooks = group
        .get_mut("hooks")
        .and_then(Value::as_array_mut)
        .ok_or_else(|| "找不到要删除的 Hook".to_string())?;
    if hook_index >= hooks.len() {
        return Err("找不到要删除的 Hook".into());
    }
    hooks.remove(hook_index);
    groups.retain(|item| {
        item.get("hooks")
            .and_then(Value::as_array)
            .map(|list| !list.is_empty())
            .unwrap_or(false)
    });
    write_document(&file, &document)?;
    let saved = read_document(&file)?;
    Ok(json!({
        "file": file.display().to_string(),
        "scope": scope,
        "hooks": flatten(scope, &file, &saved),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_session_start_event_name() {
        assert_eq!(event_name("sessionStart"), Some("SessionStart"));
        assert_eq!(event_name("PreToolUse"), Some("PreToolUse"));
        assert_eq!(event_name("unknown"), None);
    }

    #[test]
    fn project_hooks_live_under_local_codex() {
        let file = project_file(Path::new("D:/tmp/repo"));
        let text = file.to_string_lossy().replace('\\', "/");
        assert!(text.ends_with(".local-codex/hooks.json"), "{text}");
    }
}
