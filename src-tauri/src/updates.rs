use crate::config;
use serde_json::{json, Value};
use std::io::Read;
use std::path::PathBuf;
use std::process::Command;
use std::time::Duration;

const GITHUB_RELEASES: &str =
    "https://api.github.com/repos/wzd24/agent-v2/releases?per_page=20";

pub fn check() -> Value {
    let current = env!("CARGO_PKG_VERSION").to_string();
    let prefs = config::read_preferences();
    let configured = prefs
        .get("update_feed_url")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_string();
    let feed = resolve_feed(&configured);
    let mut latest = String::new();
    let mut url = String::new();
    let mut notes = String::new();
    let mut error = String::new();
    let mut source: String;
    match fetch_json(&feed) {
        Ok(data) => {
            source = if configured.is_empty() {
                "github-releases".into()
            } else {
                "feed".into()
            };
            match release_item(data) {
                Some(item) => {
                    latest = version_of(&item);
                    url = link_of(&item);
                    notes = notes_of(&item);
                    if latest.is_empty() {
                        error = no_release_error(configured.is_empty());
                    }
                }
                None => error = no_release_error(configured.is_empty()),
            }
        }
        Err(detail) => {
            error = feed_error(&detail, configured.is_empty());
            source = if configured.is_empty() {
                "github-releases".into()
            } else {
                "feed".into()
            };
        }
    }
    if configured.is_empty() && latest.is_empty() {
        if let Some(tag) = latest_git_tag() {
            latest = tag;
            url.clear();
            notes.clear();
            error.clear();
            source = "git-tags".into();
        }
    }
    let newer = is_newer(&latest, &current);
    json!({
        "current": current,
        "latest": latest,
        "newer": newer,
        "url": url,
        "notes": notes,
        "source": if source.is_empty() { "local" } else { &source },
        "error": error,
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

fn resolve_feed(configured: &str) -> String {
    let raw = if configured.is_empty() {
        GITHUB_RELEASES.to_string()
    } else {
        configured.to_string()
    };
    let trimmed = raw.trim_end_matches('/');
    if let Some(base) = trimmed.strip_suffix("/releases/latest") {
        if base.contains("://api.github.com/") {
            return format!("{base}/releases?per_page=20");
        }
    }
    raw
}

fn release_item(data: Value) -> Option<Value> {
    if let Some(items) = data.as_array() {
        return select_release(items);
    }
    Some(data)
}

fn select_release(items: &[Value]) -> Option<Value> {
    let mut best: Option<(String, Value)> = None;
    for item in items {
        if item.get("draft").and_then(Value::as_bool) == Some(true) {
            continue;
        }
        let version = version_of(item);
        if version.is_empty() {
            continue;
        }
        let replace = match &best {
            None => true,
            Some((current, _)) => {
                compare_versions(&version, current) == std::cmp::Ordering::Greater
            }
        };
        if replace {
            best = Some((version, item.clone()));
        }
    }
    best.map(|(_, item)| item)
}

fn no_release_error(using_default: bool) -> String {
    if using_default {
        "GitHub 仓库可以访问，但还没有任何 Release。/releases/latest 在没有发版时会返回 404。发布一个如 v0.2.0 的 Release 并附上安装包后即可检查到更新。".into()
    } else {
        "更新源里没有可用的版本号。".into()
    }
}

fn fetch_json(url: &str) -> Result<Value, String> {
    let mut request = ureq::get(url).timeout(Duration::from_secs(12));
    if url.contains("://api.github.com/") {
        request = request
            .set("User-Agent", "local-codex")
            .set("Accept", "application/vnd.github+json")
            .set("X-GitHub-Api-Version", "2022-11-28");
    }
    let mut text = String::new();
    request
        .call()
        .map_err(|err| match err {
            ureq::Error::Status(code, _) => format!("HTTP {code}"),
            other => other.to_string(),
        })?
        .into_reader()
        .take(512 * 1024)
        .read_to_string(&mut text)
        .map_err(|err| err.to_string())?;
    serde_json::from_str(&text).map_err(|err| err.to_string())
}

fn notes_of(item: &Value) -> String {
    item.get("notes")
        .or_else(|| item.get("body"))
        .or_else(|| item.get("changelog"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string()
}

fn link_of(item: &Value) -> String {
    if let Some(url) = asset_download_url(item) {
        return url;
    }
    let download = item
        .get("downloadUrl")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    if !download.is_empty() {
        return download.to_string();
    }
    let html = item.get("html_url").and_then(Value::as_str).unwrap_or("").trim();
    let url = item.get("url").and_then(Value::as_str).unwrap_or("").trim();
    if !html.is_empty() && url.contains("api.github.com") {
        return html.to_string();
    }
    if !url.is_empty() {
        return url.to_string();
    }
    html.to_string()
}

fn asset_download_url(item: &Value) -> Option<String> {
    let assets = item.get("assets")?.as_array()?;
    let name_of = |asset: &Value| {
        asset
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_ascii_lowercase()
    };
    let matches_platform = |name: &str| match std::env::consts::OS {
        "windows" => name.ends_with(".exe") || name.ends_with(".msi"),
        "macos" => name.ends_with(".dmg") || name.contains(".app.tar.gz"),
        _ => name.ends_with(".appimage") || name.ends_with(".deb") || name.ends_with(".rpm"),
    };
    let asset = assets
        .iter()
        .find(|asset| matches_platform(&name_of(asset)))
        .or_else(|| assets.first())?;
    let url = asset
        .get("browser_download_url")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    if url.is_empty() {
        None
    } else {
        Some(url.to_string())
    }
}

fn feed_error(detail: &str, using_default: bool) -> String {
    if using_default && detail.contains("HTTP 404") {
        return "GitHub 返回 404。仓库公开时，/releases/latest 在还没有 Release 时也会 404。".into();
    }
    if let Some(code) = detail.strip_prefix("HTTP ") {
        return format!("更新源返回 HTTP {code}。");
    }
    "更新源暂时无法读取。".into()
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

    #[test]
    fn github_release_prefers_installer_over_api_url() {
        let item = json!({
            "tag_name": "v0.2.0",
            "url": "https://api.github.com/repos/wzd24/agent-v2/releases/1",
            "html_url": "https://github.com/wzd24/agent-v2/releases/tag/v0.2.0",
            "body": "fixes",
            "assets": [
                {
                    "name": "notes.txt",
                    "browser_download_url": "https://github.com/wzd24/agent-v2/releases/download/v0.2.0/notes.txt"
                },
                {
                    "name": "Local Codex_0.2.0_x64-setup.exe",
                    "browser_download_url": "https://github.com/wzd24/agent-v2/releases/download/v0.2.0/Local%20Codex_0.2.0_x64-setup.exe"
                }
            ]
        });
        assert_eq!(version_of(&item), "0.2.0");
        assert_eq!(notes_of(&item), "fixes");
        let url = link_of(&item);
        if cfg!(windows) {
            assert!(url.ends_with(".exe"));
        } else {
            assert!(url.contains("github.com/wzd24/agent-v2/releases/"));
        }
        assert!(!url.contains("api.github.com"));
    }

    #[test]
    fn github_release_without_assets_uses_html_url() {
        let item = json!({
            "tag_name": "0.2.0",
            "url": "https://api.github.com/repos/wzd24/agent-v2/releases/1",
            "html_url": "https://github.com/wzd24/agent-v2/releases/tag/v0.2.0"
        });
        assert_eq!(
            link_of(&item),
            "https://github.com/wzd24/agent-v2/releases/tag/v0.2.0"
        );
    }

    #[test]
    fn latest_endpoint_404_is_not_treated_as_private() {
        let message = feed_error("HTTP 404", true);
        assert!(message.contains("404"));
        assert!(!message.contains("私有"));
        assert_eq!(feed_error("HTTP 500", false), "更新源返回 HTTP 500。");
    }

    #[test]
    fn empty_release_list_is_not_a_version() {
        assert!(release_item(json!([])).is_none());
        assert!(no_release_error(true).contains("还没有任何 Release"));
    }

    #[test]
    fn release_list_picks_highest_semver() {
        let item = release_item(json!([
            { "tag_name": "v0.1.0", "html_url": "https://github.com/wzd24/agent-v2/releases/tag/v0.1.0" },
            { "tag_name": "v0.3.0", "html_url": "https://github.com/wzd24/agent-v2/releases/tag/v0.3.0" },
            { "tag_name": "nightly", "html_url": "https://github.com/wzd24/agent-v2/releases/tag/nightly" },
            { "tag_name": "v0.2.0", "draft": true, "html_url": "https://github.com/wzd24/agent-v2/releases/tag/v0.2.0" }
        ]))
        .unwrap();
        assert_eq!(version_of(&item), "0.3.0");
    }

    #[test]
    fn releases_latest_url_reads_the_list_instead() {
        assert_eq!(
            resolve_feed(""),
            "https://api.github.com/repos/wzd24/agent-v2/releases?per_page=20"
        );
        assert_eq!(
            resolve_feed("https://api.github.com/repos/wzd24/agent-v2/releases/latest"),
            "https://api.github.com/repos/wzd24/agent-v2/releases?per_page=20"
        );
    }
}
