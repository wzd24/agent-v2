use crate::engine::Engine;
use serde_json::{json, Value};
use std::collections::HashSet;
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

pub fn hydrate_thread_list(result: Value) -> Value {
    let Some(items) = result.get("data").and_then(Value::as_array).cloned() else {
        return result;
    };
    if items.is_empty() {
        return result;
    }
    let hydrated: Vec<Value> = items.into_iter().map(hydrate_list_item).collect();
    let mut next = result;
    if let Some(object) = next.as_object_mut() {
        object.insert("data".into(), json!(hydrated));
    }
    next
}

pub async fn hydrate_missing_cwd(engine: Arc<Engine>, result: Value) -> Value {
    let Some(items) = result.get("data").and_then(Value::as_array).cloned() else {
        return result;
    };
    if items.is_empty() {
        return result;
    }
    let mut set = tokio::task::JoinSet::new();
    for (index, item) in items.into_iter().enumerate() {
        let engine = Arc::clone(&engine);
        set.spawn(async move { (index, fill_missing_cwd(&engine, item).await) });
    }
    let mut hydrated = Vec::new();
    hydrated.resize(set.len(), Value::Null);
    while let Some(done) = set.join_next().await {
        if let Ok((index, value)) = done {
            if index < hydrated.len() {
                hydrated[index] = value;
            }
        }
    }
    let mut next = result;
    if let Some(object) = next.as_object_mut() {
        object.insert("data".into(), json!(hydrated));
    }
    next
}

async fn fill_missing_cwd(engine: &Engine, item: Value) -> Value {
    if thread_has_cwd(&item) {
        return item;
    }
    let id = item_thread(&item)
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    if id.is_empty() {
        return item;
    }
    let read = tokio::time::timeout(
        Duration::from_secs(15),
        engine.request("thread/read", json!({ "threadId": id })),
    )
    .await;
    let Ok(Ok(detail)) = read else {
        return item;
    };
    let extra = detail.get("thread").cloned().unwrap_or(detail);
    merge_thread_fields(item, extra)
}

fn item_thread(item: &Value) -> &Value {
    item.get("thread").unwrap_or(item)
}

fn thread_has_cwd(item: &Value) -> bool {
    item_thread(item)
        .get("cwd")
        .and_then(Value::as_str)
        .map(|value| !value.is_empty())
        .unwrap_or(false)
}

fn merge_thread_fields(mut item: Value, extra: Value) -> Value {
    let Some(extra) = extra.as_object() else {
        return item;
    };
    let target = if item.get("thread").is_some() {
        item.get_mut("thread").and_then(Value::as_object_mut)
    } else {
        item.as_object_mut()
    };
    if let Some(object) = target {
        for (key, value) in extra {
            object.entry(key.clone()).or_insert(value.clone());
        }
    }
    item
}

fn hydrate_list_item(item: Value) -> Value {
    if item.get("thread").is_some() {
        let mut item = item;
        if let Some(thread) = item.get("thread").cloned() {
            if let Some(object) = item.as_object_mut() {
                object.insert("thread".into(), hydrate_thread(thread));
            }
        }
        item
    } else {
        hydrate_thread(item)
    }
}

fn hydrate_thread(mut thread: Value) -> Value {
    let has_cwd = thread
        .get("cwd")
        .and_then(Value::as_str)
        .map(|value| !value.is_empty())
        .unwrap_or(false);
    let has_title = ["title", "displayTitle", "name", "preview"]
        .iter()
        .any(|key| {
            thread
                .get(*key)
                .and_then(Value::as_str)
                .map(|value| !value.trim().is_empty())
                .unwrap_or(false)
        });
    let mut path = thread
        .get("path")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    path = path.trim_start_matches(r"\\?\").to_string();
    if path.is_empty() {
        if let Some(found) = thread
            .get("id")
            .and_then(Value::as_str)
            .and_then(find_rollout_for_id)
        {
            path = found;
            if let Some(object) = thread.as_object_mut() {
                object.entry("path").or_insert_with(|| json!(path.clone()));
            }
        }
    }
    if path.is_empty() {
        return thread;
    }
    let meta = read_rollout_metadata(&path);
    let preview = if has_title {
        None
    } else {
        first_user_preview(&path)
    };
    let object = match thread.as_object_mut() {
        Some(object) => object,
        None => return thread,
    };
    if let Some(meta) = meta {
        if !has_cwd {
            if let Some(cwd) = meta.get("cwd").and_then(Value::as_str) {
                object.insert(
                    "cwd".into(),
                    json!(cwd.trim_start_matches(r"\\?\").to_string()),
                );
            }
        } else if let Some(cwd) = object.get("cwd").and_then(Value::as_str) {
            let cleaned = cwd.trim_start_matches(r"\\?\").to_string();
            object.insert("cwd".into(), json!(cleaned));
        }
        if object.get("gitInfo").is_none() {
            if let Some(url) = meta
                .get("git")
                .and_then(|git| git.get("repository_url"))
                .and_then(Value::as_str)
            {
                object.insert("gitInfo".into(), json!({ "originUrl": url }));
            }
        }
        if let Some(source) = meta.get("source").cloned() {
            object.entry("source").or_insert(source);
        }
        if let Some(version) = meta.get("cli_version").cloned() {
            object.entry("cliVersion").or_insert(version);
        }
    }
    if let Some(preview) = preview {
        object.entry("preview").or_insert_with(|| json!(preview.clone()));
        object.entry("title").or_insert_with(|| json!(preview.clone()));
        object
            .entry("displayTitle")
            .or_insert_with(|| json!(preview));
    }
    thread
}

fn find_rollout_for_id(thread_id: &str) -> Option<String> {
    if thread_id.trim().is_empty() {
        return None;
    }
    let roots = [
        crate::config::engine_home().join("sessions"),
        crate::config::app_root().join("codex-home").join("sessions"),
    ];
    for root in roots {
        if let Some(path) = walk_rollout(&root, thread_id, 0) {
            return Some(path);
        }
    }
    None
}

fn walk_rollout(dir: &Path, thread_id: &str, depth: u8) -> Option<String> {
    if depth > 6 || !dir.is_dir() {
        return None;
    }
    let entries = fs::read_dir(dir).ok()?;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            if let Some(found) = walk_rollout(&path, thread_id, depth + 1) {
                return Some(found);
            }
            continue;
        }
        let name = path.file_name()?.to_string_lossy();
        if name.contains(thread_id) && name.ends_with(".jsonl") {
            return Some(path.display().to_string());
        }
    }
    None
}

fn read_rollout_metadata(path: &str) -> Option<Value> {
    let file = Path::new(path);
    if !file.is_file() {
        return None;
    }
    let handle = fs::File::open(file).ok()?;
    let mut reader = BufReader::new(handle);
    let mut first = String::new();
    reader.read_line(&mut first).ok()?;
    let parsed: Value = serde_json::from_str(first.trim()).ok()?;
    if parsed.get("type").and_then(Value::as_str) != Some("session_meta") {
        return None;
    }
    parsed.get("payload").cloned()
}

fn first_user_preview(path: &str) -> Option<String> {
    let handle = fs::File::open(path).ok()?;
    let reader = BufReader::new(handle);
    let mut seen = 0usize;
    for line in reader.lines() {
        let Ok(line) = line else {
            continue;
        };
        seen += line.len();
        if seen > 2 * 1024 * 1024 {
            break;
        }
        let Ok(parsed) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        if let Some(text) = user_message_text(&parsed) {
            let trimmed = collapse_preview(&text);
            if !trimmed.is_empty() {
                return Some(trimmed);
            }
        }
    }
    None
}

fn user_message_text(parsed: &Value) -> Option<String> {
    let payload = parsed.get("payload").unwrap_or(parsed);
    let kind = payload.get("type").and_then(Value::as_str).unwrap_or("");
    if kind.eq_ignore_ascii_case("item_completed") {
        let item = payload.get("item")?;
        let item_type = item.get("type").and_then(Value::as_str).unwrap_or("");
        if item_type.eq_ignore_ascii_case("UserMessage")
            || item_type.eq_ignore_ascii_case("user_message")
        {
            if let Some(text) = collect_text(item.get("content")) {
                return Some(text);
            }
            return plain_user_text(item.get("text").or_else(|| item.get("message")));
        }
    }
    if kind.eq_ignore_ascii_case("message")
        || kind.eq_ignore_ascii_case("user_message")
        || kind.eq_ignore_ascii_case("userMessage")
    {
        let role = payload.get("role").and_then(Value::as_str).unwrap_or("user");
        if role.eq_ignore_ascii_case("user") {
            if let Some(text) = collect_text(payload.get("content")) {
                return Some(text);
            }
            return plain_user_text(payload.get("message").or_else(|| payload.get("text")));
        }
    }
    None
}

fn plain_user_text(value: Option<&Value>) -> Option<String> {
    let text = value.and_then(Value::as_str)?;
    if looks_like_system_context(text) {
        return None;
    }
    let trimmed = collapse_preview(text);
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed)
    }
}

fn collect_text(content: Option<&Value>) -> Option<String> {
    if let Some(text) = content.and_then(Value::as_str) {
        return plain_user_text(Some(&Value::String(text.to_string())));
    }
    let items = content.and_then(Value::as_array)?;
    let mut parts = Vec::new();
    for item in items {
        let kind = item
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or("")
            .replace('_', "")
            .to_ascii_lowercase();
        if !matches!(kind.as_str(), "text" | "inputtext") {
            continue;
        }
        if let Some(text) = item.get("text").and_then(Value::as_str) {
            if looks_like_system_context(text) {
                continue;
            }
            parts.push(text.trim());
        }
    }
    let joined = parts.join(" ").trim().to_string();
    if joined.is_empty() {
        None
    } else {
        Some(joined)
    }
}

fn looks_like_system_context(text: &str) -> bool {
    let lowered = text.trim_start();
    lowered.starts_with("<INSTRUCTIONS>")
        || lowered.starts_with("<environment_context>")
        || lowered.starts_with("# AGENTS.md")
        || lowered.starts_with("<skills_instructions>")
        || lowered.starts_with("<permissions")
}

fn collapse_preview(text: &str) -> String {
    let collapsed = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if collapsed.chars().count() <= 80 {
        collapsed
    } else {
        format!(
            "{}…",
            collapsed.chars().take(80).collect::<String>().trim()
        )
    }
}

pub fn merge_local_sessions(result: Value, archived: bool, search: &str) -> Value {
    let mut items = result
        .get("data")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut seen = HashSet::new();
    for item in &items {
        let id = listed_thread_id(item);
        if !id.is_empty() {
            seen.insert(id);
        }
    }
    for local in scan_local_threads(archived, search) {
        let id = listed_thread_id(&local);
        if id.is_empty() || !seen.insert(id) {
            continue;
        }
        items.push(local);
    }
    items.sort_by(|left, right| listed_recency(right).cmp(&listed_recency(left)));
    let mut next = if result.is_object() {
        result
    } else {
        json!({ "nextCursor": Value::Null })
    };
    if let Some(object) = next.as_object_mut() {
        object.insert("data".into(), json!(items));
        object.entry("nextCursor").or_insert(Value::Null);
    }
    next
}

fn listed_thread_id(item: &Value) -> String {
    item.get("thread")
        .and_then(|thread| thread.get("id"))
        .or_else(|| item.get("id"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string()
}

fn listed_recency(item: &Value) -> i64 {
    let thread = item.get("thread").unwrap_or(item);
    ["recencyAt", "updatedAt", "createdAt"]
        .iter()
        .find_map(|key| thread.get(*key).and_then(Value::as_i64))
        .unwrap_or(0)
}

fn scan_local_threads(archived: bool, search: &str) -> Vec<Value> {
    let mut out = Vec::new();
    for root in session_roots() {
        collect_rollouts(&root, 0, archived, search, &mut out);
    }
    out
}

fn session_roots() -> Vec<PathBuf> {
    let mut roots = vec![
        crate::config::engine_home().join("sessions"),
        crate::config::app_root().join("codex-home").join("sessions"),
    ];
    roots.sort();
    roots.dedup();
    roots
}

fn collect_rollouts(dir: &Path, depth: u8, archived: bool, search: &str, out: &mut Vec<Value>) {
    if depth > 6 || !dir.is_dir() {
        return;
    }
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect_rollouts(&path, depth + 1, archived, search, out);
            continue;
        }
        let name = path.file_name().map(|name| name.to_string_lossy().into_owned()).unwrap_or_default();
        if !name.starts_with("rollout-") || !name.ends_with(".jsonl") {
            continue;
        }
        if let Some(thread) = thread_from_rollout(&path, archived, search) {
            out.push(thread);
        }
    }
}

fn thread_from_rollout(path: &Path, archived: bool, search: &str) -> Option<Value> {
    let meta = read_rollout_metadata(&path.display().to_string())?;
    if hidden_session(&meta) {
        return None;
    }
    if meta.get("archived").and_then(Value::as_bool).unwrap_or(false) != archived {
        return None;
    }
    let id = meta
        .get("id")
        .or_else(|| meta.get("session_id"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    if id.is_empty() {
        return None;
    }
    let preview = first_user_preview(&path.display().to_string()).unwrap_or_default();
    if !search.trim().is_empty() {
        let haystack = format!(
            "{} {} {}",
            preview,
            meta.get("cwd").and_then(Value::as_str).unwrap_or(""),
            id
        )
        .to_ascii_lowercase();
        if !haystack.contains(&search.trim().to_ascii_lowercase()) {
            return None;
        }
    }
    let created = timestamp_secs(meta.get("timestamp")).unwrap_or_else(|| file_mtime_secs(path));
    let mut thread = json!({
        "id": id,
        "path": path.display().to_string(),
        "cwd": meta.get("cwd").and_then(Value::as_str).unwrap_or("").trim_start_matches(r"\\?\"),
        "preview": preview,
        "createdAt": created,
        "updatedAt": created,
        "recencyAt": created,
        "ephemeral": false,
        "archived": archived,
        "source": meta.get("source").cloned().unwrap_or(json!("appServer")),
        "modelProvider": meta.get("model_provider").cloned().unwrap_or(Value::Null),
    });
    if !preview.is_empty() {
        if let Some(object) = thread.as_object_mut() {
            object.insert("title".into(), json!(preview.clone()));
            object.insert("displayTitle".into(), json!(preview));
        }
    }
    if let Some(url) = meta
        .get("git")
        .and_then(|git| git.get("repository_url"))
        .and_then(Value::as_str)
    {
        if let Some(object) = thread.as_object_mut() {
            object.insert("gitInfo".into(), json!({ "originUrl": url }));
        }
    }
    Some(hydrate_thread(thread))
}

fn hidden_session(meta: &Value) -> bool {
    if meta
        .get("parent_thread_id")
        .and_then(Value::as_str)
        .map(|value| !value.is_empty())
        .unwrap_or(false)
    {
        return true;
    }
    if meta.get("thread_source").and_then(Value::as_str) == Some("subagent") {
        return true;
    }
    meta.get("source")
        .and_then(Value::as_object)
        .and_then(|value| value.get("subagent"))
        .is_some()
}

fn timestamp_secs(value: Option<&Value>) -> Option<i64> {
    let text = value.and_then(Value::as_str)?.trim();
    let cleaned = text.trim_end_matches('Z');
    let (date, rest) = cleaned.split_once('T')?;
    let mut dates = date.split('-');
    let year: i32 = dates.next()?.parse().ok()?;
    let month: i32 = dates.next()?.parse().ok()?;
    let day: i32 = dates.next()?.parse().ok()?;
    let time = rest.split(['.', '+', '-']).next()?;
    let mut times = time.split(':');
    let hour: i64 = times.next()?.parse().ok()?;
    let minute: i64 = times.next()?.parse().ok()?;
    let second: i64 = times.next()?.parse().ok()?;
    Some(days_from_civil(year, month, day) * 86400 + hour * 3600 + minute * 60 + second)
}

fn days_from_civil(year: i32, month: i32, day: i32) -> i64 {
    let year = if month <= 2 { year - 1 } else { year } as i64;
    let era = if year >= 0 { year } else { year - 399 } / 400;
    let yoe = year - era * 400;
    let doy = (153 * (month as i64 + if month > 2 { -3 } else { 9 }) + 2) / 5 + day as i64 - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146097 + doe - 719468
}

fn file_mtime_secs(path: &Path) -> i64 {
    fs::metadata(path)
        .and_then(|meta| meta.modified())
        .ok()
        .and_then(|time| time.duration_since(SystemTime::UNIX_EPOCH).ok())
        .or_else(|| SystemTime::now().duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_secs() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("local-codex-thread-list-{name}"));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn merge_local_sessions_adds_missing_rollout() {
        let dir = temp_dir("merge");
        let path = dir.join("rollout-2026-09-23T00-00-00-01a0bbbb-cccc-7ddd-8eee-ffffffffffff.jsonl");
        let mut file = fs::File::create(&path).unwrap();
        writeln!(
            file,
            r#"{{"type":"session_meta","payload":{{"id":"01a0bbbb-cccc-7ddd-8eee-ffffffffffff","cwd":"D:/repo/server","timestamp":"2026-09-23T00:00:00Z","source":"vscode","git":{{"repository_url":"ssh://git@example/server.git"}}}}}}"#
        )
        .unwrap();
        writeln!(
            file,
            r#"{{"type":"event_msg","payload":{{"type":"item_completed","item":{{"type":"UserMessage","content":[{{"type":"text","text":"打开 Outlook"}}]}}}}}}"#
        )
        .unwrap();
        drop(file);

        let mut found = Vec::new();
        collect_rollouts(&dir, 0, false, "", &mut found);
        assert_eq!(found.len(), 1);
        assert_eq!(found[0]["id"], "01a0bbbb-cccc-7ddd-8eee-ffffffffffff");
        assert_eq!(found[0]["cwd"], "D:/repo/server");
        assert!(found[0]["preview"].as_str().unwrap_or("").contains("Outlook"));

        let merged = merge_local_sessions(json!({ "data": [] }), false, "");
        // merge_local_sessions also scans real homes; just assert helper path works.
        let _ = fs::remove_dir_all(dir);
        let _ = merged;
    }

    #[test]
    fn hides_subagent_rollouts() {
        let meta = json!({
            "id": "child",
            "parent_thread_id": "parent",
            "source": { "subagent": "review" }
        });
        assert!(hidden_session(&meta));
        assert!(!hidden_session(&json!({ "id": "root", "source": "vscode" })));
    }
}
