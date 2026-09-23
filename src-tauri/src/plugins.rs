use crate::config;
use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};

fn plugin_home() -> PathBuf {
    let dest = config::app_root().join("plugins");
    let legacy = config::engine_home().join("plugins");
    if !dest.exists() && legacy.is_dir() {
        let _ = copy_dir(&legacy, &dest);
    }
    dest
}

fn read_manifest(candidate: &Path) -> Option<Value> {
    let nested = candidate.join(".codex-plugin").join("plugin.json");
    let direct = candidate.join("plugin.json");
    let file = if nested.is_file() {
        nested
    } else if direct.is_file() {
        direct
    } else {
        return None;
    };
    serde_json::from_str(&fs::read_to_string(file).ok()?).ok()
}

pub fn list_plugins() -> Vec<Value> {
    let workspace = config::workspace_root();
    let roots = [
        (plugin_home(), "应用目录"),
        (workspace.join(".local-codex").join("plugin"), "项目目录"),
        (workspace.join(".codex-plugin"), "项目目录"),
        (workspace.join("plugins"), "项目目录"),
    ];
    let mut plugins = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for (root, source) in roots {
        if !root.exists() {
            continue;
        }
        let candidates = if read_manifest(&root).is_some() {
            vec![root.clone()]
        } else {
            fs::read_dir(&root)
                .ok()
                .into_iter()
                .flatten()
                .flatten()
                .filter(|entry| entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false))
                .map(|entry| entry.path())
                .collect()
        };
        for candidate in candidates {
            let Some(data) = read_manifest(&candidate) else {
                continue;
            };
            let key = candidate.display().to_string();
            if !seen.insert(key.clone()) {
                continue;
            }
            let fallback = candidate
                .file_name()
                .map(|name| name.to_string_lossy().into_owned())
                .unwrap_or_default();
            plugins.push(json!({
                "name": data.get("name").and_then(Value::as_str).unwrap_or(&fallback),
                "description": data.get("description").and_then(Value::as_str).unwrap_or(""),
                "path": key,
                "source": source,
                "enabled": data.get("enabled").and_then(Value::as_bool).unwrap_or(true),
            }));
        }
    }
    plugins
}

pub fn plugin_skill_roots() -> Vec<PathBuf> {
    list_plugins()
        .iter()
        .filter_map(|plugin| plugin.get("path").and_then(Value::as_str).map(PathBuf::from))
        .collect()
}

pub fn install(source: &Path) -> Result<Value, String> {
    let source = fs::canonicalize(source).map_err(|_| "所选目录不是有效的 Codex 插件".to_string())?;
    if read_manifest(&source).is_none() {
        return Err("所选目录不是有效的 Codex 插件".into());
    }
    let data = read_manifest(&source).unwrap_or_else(|| json!({}));
    let raw_name = data
        .get("name")
        .and_then(Value::as_str)
        .map(str::to_string)
        .unwrap_or_else(|| {
            source
                .file_name()
                .map(|name| name.to_string_lossy().into_owned())
                .unwrap_or_else(|| "plugin".into())
        });
    let plugin_name: String = raw_name
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | '-') {
                ch
            } else {
                '-'
            }
        })
        .collect();
    let target_root = plugin_home();
    let target = target_root.join(&plugin_name);
    if target.exists() {
        if same(&source, &target) {
            return Ok(json!({ "canceled": false, "plugin": { "name": plugin_name, "path": target.display().to_string() } }));
        }
        return Err(format!("插件已存在：{plugin_name}"));
    }
    fs::create_dir_all(&target_root).map_err(|err| err.to_string())?;
    copy_dir(&source, &target)?;
    Ok(json!({
        "canceled": false,
        "plugin": { "name": plugin_name, "path": target.display().to_string() },
    }))
}

pub fn uninstall(plugin_path: &str) -> Result<Value, String> {
    let root = fs::canonicalize(plugin_home()).unwrap_or_else(|_| plugin_home());
    let target = PathBuf::from(plugin_path);
    let resolved = fs::canonicalize(&target).unwrap_or(target);
    let relative = resolved
        .strip_prefix(&root)
        .map_err(|_| "只能卸载应用目录 plugins 下的插件".to_string())?;
    if relative.as_os_str().is_empty() {
        return Err("只能卸载应用目录 plugins 下的插件".into());
    }
    if !resolved.exists() {
        return Ok(json!({ "ok": false, "output": "插件目录不存在" }));
    }
    fs::remove_dir_all(&resolved).map_err(|err| err.to_string())?;
    Ok(json!({ "ok": true, "output": resolved.display().to_string() }))
}

fn copy_dir(source: &Path, dest: &Path) -> Result<(), String> {
    fs::create_dir_all(dest).map_err(|err| err.to_string())?;
    for entry in fs::read_dir(source).map_err(|err| err.to_string())? {
        let entry = entry.map_err(|err| err.to_string())?;
        let target = dest.join(entry.file_name());
        if entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false) {
            copy_dir(&entry.path(), &target)?;
        } else {
            fs::copy(entry.path(), target).map_err(|err| err.to_string())?;
        }
    }
    Ok(())
}

fn same(left: &Path, right: &Path) -> bool {
    left.display().to_string().eq_ignore_ascii_case(&right.display().to_string())
}
