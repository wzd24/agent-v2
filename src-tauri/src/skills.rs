use crate::config;
use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};

const SETTINGS_BY_ID: &[(&str, &str)] = &[
    ("computer-use", "computer"),
    ("documents", "plugins"),
    ("pdf", "plugins"),
    ("spreadsheets", "plugins"),
    ("presentations", "plugins"),
    ("template-creator", "plugins"),
    ("notebooks", "plugins"),
    ("web-search", "plugins"),
    ("git-host", "connections"),
];

pub fn bundled_root() -> PathBuf {
    let compile_time = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("skills");
    if compile_time.is_dir() {
        return compile_time;
    }
    if let Ok(exe) = std::env::current_exe() {
        for candidate in [
            exe.parent().map(|path| path.join("skills")),
            exe.parent().map(|path| path.join("resources").join("skills")),
        ]
        .into_iter()
        .flatten()
        {
            if candidate.is_dir() {
                return candidate;
            }
        }
    }
    compile_time
}

fn safe_id(value: &str) -> Result<String, String> {
    let id = value.trim();
    if id.is_empty()
        || !id
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | '-'))
        || !id.chars().next().unwrap().is_ascii_alphanumeric()
    {
        return Err("技能 id 无效".into());
    }
    Ok(id.to_string())
}

fn parse_frontmatter(source: &str) -> (String, String, String) {
    let text = source.replace("\r\n", "\n");
    if let Some(rest) = text.strip_prefix("---\n") {
        if let Some((meta, body)) = rest.split_once("\n---") {
            let mut name = String::new();
            let mut description = String::new();
            for line in meta.lines() {
                if let Some((key, value)) = line.split_once(':') {
                    match key.trim() {
                        "name" => name = value.trim().to_string(),
                        "description" => description = value.trim().to_string(),
                        _ => {}
                    }
                }
            }
            return (name, description, body.trim().to_string());
        }
    }
    (String::new(), String::new(), source.to_string())
}

fn disabled_ids() -> Vec<String> {
    match config::read_preferences().get("disabled_builtin_skills") {
        Some(Value::Array(items)) => items
            .iter()
            .filter_map(Value::as_str)
            .map(str::to_string)
            .collect(),
        _ => Vec::new(),
    }
}

pub fn list_builtin() -> Value {
    json!(list_builtin_vec())
}

pub fn list_builtin_vec() -> Vec<Value> {
    let root = bundled_root();
    let blocked: std::collections::HashSet<String> = disabled_ids().into_iter().collect();
    let mut skills = Vec::new();
    let Ok(entries) = fs::read_dir(&root) else {
        return skills;
    };
    for entry in entries.flatten() {
        if !entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false) {
            continue;
        }
        let id = entry.file_name().to_string_lossy().into_owned();
        let file = entry.path().join("SKILL.md");
        if !file.is_file() {
            continue;
        }
        let source = fs::read_to_string(&file).unwrap_or_default();
        let (name, description, _) = parse_frontmatter(&source);
        let section = SETTINGS_BY_ID
            .iter()
            .find(|(key, _)| *key == id)
            .map(|(_, section)| *section)
            .unwrap_or("plugins");
        skills.push(json!({
            "id": id,
            "name": if name.is_empty() { id.clone() } else { name },
            "description": description,
            "path": file.display().to_string(),
            "enabled": !blocked.contains(&id),
            "settingsSection": section,
        }));
    }
    skills
}

pub fn read_skill(id: &str) -> Result<Value, String> {
    let id = safe_id(id)?;
    let file = bundled_root().join(&id).join("SKILL.md");
    if !file.is_file() {
        return Err("没有这篇技能说明".into());
    }
    let source = fs::read_to_string(&file).map_err(|err| err.to_string())?;
    let (name, description, _) = parse_frontmatter(&source);
    Ok(json!({
        "id": id,
        "path": file.display().to_string(),
        "name": if name.is_empty() { id } else { name },
        "description": description,
        "body": source,
    }))
}

pub fn set_enabled(id: &str, enabled: bool) -> Result<Value, String> {
    let id = safe_id(id)?;
    let mut blocked = disabled_ids();
    if enabled {
        blocked.retain(|item| item != &id);
    } else if !blocked.contains(&id) {
        blocked.push(id);
    }
    config::write_preference("disabled_builtin_skills", json!(blocked))?;
    Ok(list_builtin())
}

pub fn extra_roots(plugin_roots: Vec<PathBuf>) -> Vec<String> {
    let blocked: std::collections::HashSet<String> = disabled_ids().into_iter().collect();
    let mut roots = Vec::new();
    for skill in list_builtin_vec() {
        let id = skill.get("id").and_then(Value::as_str).unwrap_or_default();
        let enabled = skill.get("enabled").and_then(Value::as_bool).unwrap_or(true);
        if enabled && !blocked.contains(id) {
            if let Some(path) = skill.get("path").and_then(Value::as_str) {
                if let Some(parent) = Path::new(path).parent() {
                    roots.push(parent.display().to_string());
                }
            }
        }
    }
    for root in plugin_roots {
        if root.exists() {
            roots.push(root.display().to_string());
            let skills = root.join("skills");
            if skills.exists() {
                roots.push(skills.display().to_string());
            }
        }
    }
    roots
}

pub fn open_skill(id: &str) -> Result<Value, String> {
    let skill = read_skill(id)?;
    let path = skill.get("path").and_then(Value::as_str).unwrap_or("");
    open::that(path).map_err(|err| err.to_string())?;
    Ok(json!({ "ok": true, "output": path, "path": path }))
}
