use crate::config;
use serde_json::{json, Value};
use std::io::Read;
use std::path::PathBuf;
use std::process::Command;
use std::time::Duration;

pub fn check() -> Value {
    let current = env!("CARGO_PKG_VERSION").to_string();
    let prefs = config::read_preferences();
    let feed = prefs
        .get("update_feed_url")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_string();
    let mut latest = String::new();
    let mut url = String::new();
    let mut notes = String::new();
    let mut source = String::new();
    if !feed.is_empty() {
        if let Ok(data) = fetch_json(&feed) {
            let item = data
                .as_array()
                .and_then(|items| items.first())
                .unwrap_or(&data);
            latest = version_of(item);
            url = item
                .get("url")
                .or_else(|| item.get("html_url"))
                .or_else(|| item.get("downloadUrl"))
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            notes = item
                .get("notes")
                .or_else(|| item.get("body"))
                .or_else(|| item.get("changelog"))
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            source = "feed".into();
        }
    } else if let Some(tag) = latest_git_tag() {
        latest = tag;
        source = "git-tags".into();
    }
    let newer = is_newer(&latest, &current);
    json!({
        "current": current,
        "latest": latest,
        "newer": newer,
        "url": url,
        "notes": notes,
        "source": if source.is_empty() { "local" } else { &source },
        "checkedAt": now_stamp(),
    })
}

pub fn check_and_store() -> Value {
    let result = check();
    let checked = result.get("checkedAt").cloned().unwrap_or(json!(""));
    let _ = config::write_preference("last_update_check", checked);
    let _ = config::write_preference("last_update_result", result.clone());
    result
}

fn fetch_json(url: &str) -> Result<Value, String> {
    let mut text = String::new();
    ureq::get(url)
        .timeout(Duration::from_secs(12))
        .call()
        .map_err(|err| err.to_string())?
        .into_reader()
        .take(512 * 1024)
        .read_to_string(&mut text)
        .map_err(|err| err.to_string())?;
    serde_json::from_str(&text).map_err(|err| err.to_string())
}

fn version_of(item: &Value) -> String {
    let latest = item
        .get("version")
        .or_else(|| item.get("tag_name"))
        .or_else(|| item.get("name"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .trim_start_matches(['v', 'V'])
        .to_string();
    if parse_version(&latest).is_some() {
        latest
    } else {
        String::new()
    }
}

fn latest_git_tag() -> Option<String> {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..");
    let mut command = Command::new("git");
    command
        .args(["ls-remote", "--tags", "--refs", "origin"])
        .current_dir(&root);
    crate::mcp::hide_command(&mut command);
    let output = command.output().ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&output.stdout);
    let mut versions: Vec<String> = text
        .lines()
        .filter_map(|line| {
            line.split("refs/tags/")
                .nth(1)
                .map(|tag| tag.trim().trim_start_matches('v').to_string())
        })
        .filter(|tag| parse_version(tag).is_some())
        .collect();
    versions.sort_by(|left, right| compare_versions(left, right));
    versions.pop()
}

fn parse_version(value: &str) -> Option<[u32; 3]> {
    let mut parts = value.split('.');
    Some([
        parts.next()?.parse().ok()?,
        parts.next()?.parse().ok()?,
        parts.next()?.parse().ok()?,
    ])
}

fn compare_versions(left: &str, right: &str) -> std::cmp::Ordering {
    match (parse_version(left), parse_version(right)) {
        (Some(a), Some(b)) => a.cmp(&b),
        _ => std::cmp::Ordering::Equal,
    }
}

fn is_newer(latest: &str, current: &str) -> bool {
    matches!(compare_versions(latest, current), std::cmp::Ordering::Greater)
}

fn now_stamp() -> String {
    let Ok(duration) = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH) else {
        return String::new();
    };
    let secs = duration.as_secs();
    let (year, month, day) = civil_from_days((secs / 86_400) as i64);
    let rem = secs % 86_400;
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}Z",
        rem / 3600,
        (rem % 3600) / 60,
        rem % 60
    )
}

fn civil_from_days(days: i64) -> (i32, u32, u32) {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    (y as i32, m as u32, d as u32)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn version_of_keeps_semver_and_drops_garbage() {
        assert_eq!(version_of(&json!({ "version": "v1.2.3" })), "1.2.3");
        assert_eq!(version_of(&json!({ "tag_name": "0.1.0" })), "0.1.0");
        assert_eq!(version_of(&json!({ "name": "latest" })), "");
        assert_eq!(version_of(&json!({ "version": "not-a-version" })), "");
    }

    #[test]
    fn is_newer_compares_semver() {
        assert!(is_newer("0.2.0", "0.1.0"));
        assert!(!is_newer("0.1.0", "0.1.0"));
        assert!(!is_newer("", "0.1.0"));
    }
}
