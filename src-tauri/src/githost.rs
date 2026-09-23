use crate::config;
use crate::git;
use serde_json::{json, Value};
use std::io::Read;
use std::path::Path;
use std::time::Duration;

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum HostKind {
    Gitlab,
    Github,
}

impl HostKind {
    fn label(self) -> &'static str {
        match self {
            Self::Gitlab => "GitLab",
            Self::Github => "GitHub",
        }
    }
}

pub fn dispatch(kind: HostKind, method: &str, payload: &Value) -> Result<Value, String> {
    let suffix = method.rsplit('.').next().unwrap_or(method);
    match suffix {
        "status" => inspect(kind),
        "project" => load(kind, "project", payload),
        "mergeRequests" => load(kind, "mergeRequests", payload),
        "mergeRequest" => load(kind, "mergeRequest", payload),
        "mergeRequestCommits" => load(kind, "mergeRequestCommits", payload),
        "mergeRequestDiffs" => load(kind, "mergeRequestDiffs", payload),
        "mergeRequestNotes" => load(kind, "mergeRequestNotes", payload),
        "mergeRequestPipelines" => load(kind, "mergeRequestPipelines", payload),
        "branches" => load(kind, "branches", payload),
        "commits" => load(kind, "commits", payload),
        "commitDiff" => load(kind, "commitDiff", payload),
        "graph" => load(kind, "graph", payload),
        "tags" => load(kind, "tags", payload),
        "tree" => load(kind, "tree", payload),
        "file" => load(kind, "file", payload),
        "blame" => load(kind, "blame", payload),
        "createMergeRequest" => write(kind, "createMergeRequest", payload),
        "createNote" => write(kind, "createNote", payload),
        "createReviewComment" => write(kind, "createReviewComment", payload),
        "mergeMergeRequest" => write(kind, "mergeMergeRequest", payload),
        "approveMergeRequest" => write(kind, "approveMergeRequest", payload),
        "createBranch" => write(kind, "createBranch", payload),
        "updateMergeRequestState" => write(kind, "updateMergeRequestState", payload),
        "projects" => list_projects(kind, payload),
        "clone" => clone_repo(kind, payload),
        other => Err(format!("未知 {} 方法：{other}", kind.label())),
    }
}

struct Connection {
    id: String,
    name: String,
    base_url: String,
    enabled: bool,
    token: String,
}

fn connections(kind: HostKind) -> Vec<Connection> {
    let prefs = config::read_preferences();
    let key = if kind == HostKind::Gitlab {
        "gitlab_connections"
    } else {
        "github_connections"
    };
    let listed = prefs
        .get(key)
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    if !listed.is_empty() {
        return listed
            .iter()
            .enumerate()
            .map(|(index, item)| normalize_connection(kind, item, index))
            .collect();
    }
    let enabled_key = if kind == HostKind::Gitlab {
        "gitlab_enabled"
    } else {
        "github_enabled"
    };
    let url_key = if kind == HostKind::Gitlab {
        "gitlab_base_url"
    } else {
        "github_base_url"
    };
    vec![normalize_connection(
        kind,
        &json!({
            "id": "default",
            "name": kind.label(),
            "baseUrl": prefs.get(url_key).and_then(Value::as_str).unwrap_or(""),
            "enabled": prefs.get(enabled_key).and_then(Value::as_bool).unwrap_or(false),
        }),
        0,
    )]
}

fn normalize_connection(kind: HostKind, raw: &Value, index: usize) -> Connection {
    let id = raw
        .get("id")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .unwrap_or(if index == 0 { "default" } else { "conn" })
        .to_string();
    let secret = raw
        .get("secretName")
        .and_then(Value::as_str)
        .map(str::to_string)
        .unwrap_or_else(|| {
            if id == "default" {
                if kind == HostKind::Github {
                    "GITHUB_PERSONAL_TOKEN".into()
                } else {
                    "GITLAB_PERSONAL_TOKEN".into()
                }
            } else {
                let prefix = if kind == HostKind::Github {
                    "GITHUB_TOKEN_"
                } else {
                    "GITLAB_TOKEN_"
                };
                format!(
                    "{prefix}{}",
                    id.chars()
                        .map(|ch| if ch.is_ascii_alphanumeric() { ch } else { '_' })
                        .collect::<String>()
                        .to_uppercase()
                )
            }
        });
    Connection {
        id: id.clone(),
        name: raw
            .get("name")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .unwrap_or(kind.label())
            .to_string(),
        base_url: raw
            .get("baseUrl")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim()
            .to_string(),
        enabled: raw.get("enabled").and_then(Value::as_bool).unwrap_or(true),
        token: config::resolve_secret(&secret).unwrap_or_default(),
    }
}

fn public_connections(items: &[Connection]) -> Vec<Value> {
    items
        .iter()
        .map(|item| {
            json!({
                "id": item.id,
                "name": item.name,
                "baseUrl": item.base_url,
                "enabled": item.enabled,
                "tokenConfigured": !item.token.is_empty(),
            })
        })
        .collect()
}

fn host_context(kind: HostKind) -> Value {
    let listed = connections(kind);
    let remotes = git::remotes(&config::workspace_root());
    let usable: Vec<&Connection> = listed
        .iter()
        .filter(|item| item.enabled && !item.base_url.is_empty())
        .collect();
    let matched = usable.iter().copied().find(|item| {
        remotes
            .iter()
            .any(|remote| normalize_host(&remote.host) == normalize_host(&item.base_url))
    });
    let chosen = matched
        .or_else(|| usable.iter().copied().find(|item| !item.token.is_empty()))
        .or_else(|| usable.first().copied());
    match chosen {
        Some(item) => json!({
            "enabled": true,
            "baseUrl": item.base_url,
            "token": item.token,
        }),
        None => json!({ "enabled": false, "baseUrl": "", "token": "" }),
    }
}

pub fn context_payload() -> Value {
    json!({
        "cwd": config::workspace_root().display().to_string(),
        "gitlab": host_context(HostKind::Gitlab),
        "github": host_context(HostKind::Github),
    })
}

fn inspect(kind: HostKind) -> Result<Value, String> {
    let cwd = config::workspace_root();
    let remotes = git::remotes(&cwd);
    let listed = connections(kind);
    let usable: Vec<&Connection> = listed
        .iter()
        .filter(|item| item.enabled && !item.base_url.is_empty())
        .collect();
    let matched = usable.iter().copied().find(|item| {
        remotes
            .iter()
            .any(|remote| normalize_host(&remote.host) == normalize_host(&item.base_url))
    });
    let chosen = usable
        .iter()
        .copied()
        .find(|item| {
            !item.token.is_empty()
                && remotes
                    .iter()
                    .any(|remote| normalize_host(&remote.host) == normalize_host(&item.base_url))
        })
        .or(matched)
        .or_else(|| usable.iter().copied().find(|item| !item.token.is_empty()))
        .or(usable.first().copied());
    let Some(chosen) = chosen else {
        return Ok(json!({
            "enabled": false,
            "available": false,
            "configured": false,
            "tokenConfigured": false,
            "baseUrl": "",
            "workspaceRoot": cwd.display().to_string(),
            "remoteUrl": remotes.first().map(|item| item.url.clone()).unwrap_or_default(),
            "remoteName": remotes.first().map(|item| item.name.clone()).unwrap_or_default(),
            "projectPath": remotes.first().map(|item| item.project_path.clone()).unwrap_or_default(),
            "currentBranch": git::current_branch(&cwd),
            "project": null,
            "reason": format!("{} 全局开关未开启", kind.label()),
            "connections": public_connections(&listed),
            "connectionId": "",
        }));
    };
    let remote = remotes.iter().find(|remote| {
        normalize_host(&remote.host) == normalize_host(&chosen.base_url)
    });
    let mut status = json!({
        "enabled": true,
        "available": remote.is_some(),
        "configured": !chosen.base_url.is_empty() && !chosen.token.is_empty(),
        "tokenConfigured": !chosen.token.is_empty(),
        "baseUrl": chosen.base_url,
        "workspaceRoot": cwd.display().to_string(),
        "remoteUrl": remote.map(|item| item.url.clone()).or_else(|| remotes.first().map(|item| item.url.clone())).unwrap_or_default(),
        "remoteName": remote.map(|item| item.name.clone()).or_else(|| remotes.first().map(|item| item.name.clone())).unwrap_or_default(),
        "projectPath": remote.map(|item| item.project_path.clone()).unwrap_or_default(),
        "currentBranch": git::current_branch(&cwd),
        "project": null,
        "reason": "",
        "connections": public_connections(&listed),
        "connectionId": chosen.id,
    });
    if remote.is_none() {
        status.as_object_mut().unwrap().insert(
            "reason".into(),
            json!(if remotes.is_empty() {
                "当前工作区没有 Git 远程仓库".to_string()
            } else {
                format!("当前工作区未托管在 {}", normalize_host(&chosen.base_url))
            }),
        );
        return Ok(status);
    }
    if chosen.token.is_empty() {
        status
            .as_object_mut()
            .unwrap()
            .insert("reason".into(), json!(format!("未配置 {} 个人 Token", kind.label())));
        return Ok(status);
    }
    if let Some(remote) = remote {
        match fetch_project(kind, chosen, &remote.project_path) {
            Ok(project) => {
                status.as_object_mut().unwrap().insert("project".into(), project);
                status.as_object_mut().unwrap().insert("reason".into(), json!(""));
            }
            Err(err) => {
                status.as_object_mut().unwrap().insert(
                    "reason".into(),
                    json!(format!("已识别仓库，但读取项目失败：{err}")),
                );
            }
        }
    }
    Ok(status)
}

fn chosen_connection(kind: HostKind, payload: &Value) -> Result<Connection, String> {
    let listed = connections(kind);
    let wanted = payload
        .get("connectionId")
        .and_then(Value::as_str)
        .unwrap_or("");
    listed
        .into_iter()
        .find(|item| item.enabled && !item.base_url.is_empty() && (wanted.is_empty() || item.id == wanted))
        .ok_or_else(|| format!("未配置可用的 {} 连接", kind.label()))
}

fn load(kind: HostKind, resource: &str, query: &Value) -> Result<Value, String> {
    let status = inspect(kind)?;
    if !status.get("available").and_then(Value::as_bool).unwrap_or(false) {
        return Err(status
            .get("reason")
            .and_then(Value::as_str)
            .unwrap_or("当前工作区未启用托管管理")
            .to_string());
    }
    let connection = chosen_connection(kind, query).or_else(|_| {
        connections(kind)
            .into_iter()
            .find(|item| item.id == status.get("connectionId").and_then(Value::as_str).unwrap_or(""))
            .ok_or_else(|| format!("未配置可用的 {} 连接", kind.label()))
    })?;
    let cwd = config::workspace_root();
    let project_path = status
        .get("projectPath")
        .and_then(Value::as_str)
        .unwrap_or("");
    if resource == "graph" {
        let items = local_graph(
            &cwd,
            query.get("limit").or_else(|| query.get("perPage")).and_then(Value::as_u64).unwrap_or(1000),
        );
        let total = items.len();
        return Ok(json!({
            "status": status,
            "items": items,
            "total": total,
            "hasMore": false,
            "shallow": false
        }));
    }
    if resource == "commitDiff" {
        let sha = query
            .get("sha")
            .or_else(|| query.get("ref"))
            .and_then(Value::as_str)
            .unwrap_or("");
        let local = local_commit_diff(&cwd, sha);
        return Ok(json!({ "status": status, "commit": local.0, "diff": local.1 }));
    }
    if resource == "file" {
        let file_path = query.get("path").and_then(Value::as_str).unwrap_or("");
        let reference = query
            .get("ref")
            .and_then(Value::as_str)
            .unwrap_or("HEAD");
        if let Some(bytes) = git::show_file(&cwd, reference, file_path) {
            return Ok(json!({
                "status": status,
                "file": file_payload(file_path, reference, &bytes, "git"),
            }));
        }
        if connection.token.is_empty() {
            return Err("本地仓库没有该文件，且未配置个人 Token".into());
        }
    }
    if resource == "blame" {
        let file_path = query.get("path").and_then(Value::as_str).unwrap_or("");
        let output = git::run_in(&cwd, &["blame", "--line-porcelain", "--", file_path]);
        if output.0 && !output.1.trim().is_empty() {
            return Ok(json!({ "status": status, "items": parse_blame(&output.1) }));
        }
        if connection.token.is_empty() {
            return Err("无法读取该文件的 blame，且未配置个人 Token".into());
        }
    }
    if connection.token.is_empty() && !matches!(resource, "file" | "blame" | "commitDiff" | "graph")
    {
        return Err(format!("未配置 {} 个人 Token", kind.label()));
    }
    match kind {
        HostKind::Gitlab => gitlab_load(&connection, project_path, &status, resource, query),
        HostKind::Github => github_load(&connection, project_path, &status, resource, query),
    }
}

fn write(kind: HostKind, action: &str, query: &Value) -> Result<Value, String> {
    let status = inspect(kind)?;
    if !status.get("available").and_then(Value::as_bool).unwrap_or(false) {
        return Err(status
            .get("reason")
            .and_then(Value::as_str)
            .unwrap_or("当前工作区未启用托管管理")
            .to_string());
    }
    let connection = connections(kind)
        .into_iter()
        .find(|item| item.id == status.get("connectionId").and_then(Value::as_str).unwrap_or(""))
        .or_else(|| connections(kind).into_iter().find(|item| item.enabled && !item.token.is_empty()))
        .ok_or_else(|| format!("未配置 {} 个人 Token", kind.label()))?;
    if connection.token.is_empty() {
        return Err(format!("未配置 {} 个人 Token", kind.label()));
    }
    let project_path = status
        .get("projectPath")
        .and_then(Value::as_str)
        .unwrap_or("");
    match kind {
        HostKind::Gitlab => gitlab_write(&connection, project_path, &status, action, query),
        HostKind::Github => github_write(&connection, project_path, &status, action, query),
    }
}

fn list_projects(kind: HostKind, query: &Value) -> Result<Value, String> {
    let listed = connections(kind);
    let wanted = query.get("connectionId").and_then(Value::as_str).unwrap_or("");
    let selected: Vec<&Connection> = listed
        .iter()
        .filter(|item| {
            item.enabled && !item.base_url.is_empty() && !item.token.is_empty() && (wanted.is_empty() || item.id == wanted)
        })
        .collect();
    if selected.is_empty() {
        return Err(if wanted.is_empty() {
            format!("未配置可用的 {} 连接", kind.label())
        } else {
            "未找到该连接或尚未配置 Token".into()
        });
    }
    let search = query.get("search").and_then(Value::as_str).unwrap_or("");
    let mut items = Vec::new();
    for item in selected {
        let fetched = match kind {
            HostKind::Gitlab => gitlab_projects(item, search)?,
            HostKind::Github => github_projects(item, search)?,
        };
        for mut project in fetched {
            project
                .as_object_mut()
                .unwrap()
                .insert("connectionId".into(), json!(item.id));
            project
                .as_object_mut()
                .unwrap()
                .insert("connectionName".into(), json!(item.name));
            items.push(project);
        }
    }
    Ok(json!({ "items": items, "connections": public_connections(&listed) }))
}

fn clone_repo(kind: HostKind, query: &Value) -> Result<Value, String> {
    let connection = chosen_connection(kind, query).ok();
    let token = connection.as_ref().map(|item| item.token.as_str()).unwrap_or("");
    let protocol = query.get("protocol").and_then(Value::as_str).unwrap_or("https");
    let source = if protocol == "ssh" {
        query
            .get("sshUrl")
            .or_else(|| query.get("url"))
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string()
    } else {
        query
            .get("httpUrl")
            .or_else(|| query.get("url"))
            .or_else(|| query.get("webUrl"))
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string()
    };
    if source.trim().is_empty() {
        return Err("克隆地址不能为空".into());
    }
    let parent = query
        .get("parentDir")
        .and_then(Value::as_str)
        .unwrap_or("");
    if parent.is_empty() || !Path::new(parent).is_dir() {
        return Err("请选择已存在的目标目录".into());
    }
    let name = query
        .get("folderName")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| {
            source
                .trim_end_matches('/')
                .trim_end_matches(".git")
                .rsplit(['/', '\\'])
                .next()
                .unwrap_or("repository")
                .to_string()
        });
    let target = Path::new(parent).join(&name);
    if target.exists() {
        return Err(format!("目标已存在：{}", target.display()));
    }
    let clone_url = authenticated_url(&source, token, kind);
    let mut args = vec!["clone".to_string()];
    if query.get("shallow").and_then(Value::as_bool).unwrap_or(false) {
        args.extend(["--depth".into(), "1".into()]);
    }
    args.extend(["--".into(), clone_url, target.display().to_string()]);
    let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();
    let (ok, output) = git::run_in(Path::new(parent), &arg_refs);
    if !ok {
        return Err(if token.is_empty() {
            output
        } else {
            output.replace(token, "***")
        });
    }
    Ok(json!({ "ok": true, "path": target.display().to_string(), "name": name }))
}

fn authenticated_url(url: &str, token: &str, kind: HostKind) -> String {
    if token.is_empty() || !url.starts_with("http") {
        return url.to_string();
    }
    if let Some(rest) = url.split_once("://") {
        let user = if kind == HostKind::Github {
            "x-access-token"
        } else {
            "oauth2"
        };
        return format!("{}://{}:{}@{}", rest.0, user, token, rest.1);
    }
    url.to_string()
}

fn gitlab_api(base: &str) -> String {
    let trimmed = base.trim().trim_end_matches('/');
    if trimmed.ends_with("/api/v4") {
        trimmed.to_string()
    } else {
        format!("{trimmed}/api/v4")
    }
}

fn github_api(base: &str) -> String {
    let host = normalize_host(base);
    if host.is_empty() || host == "github.com" || host == "www.github.com" {
        "https://api.github.com".into()
    } else {
        format!("{}/api/v3", base.trim().trim_end_matches('/'))
    }
}

fn request(
    kind: HostKind,
    conn: &Connection,
    method: &str,
    path: &str,
    query: &[(&str, String)],
    body: Option<&Value>,
) -> Result<Value, String> {
    let root = if kind == HostKind::Gitlab {
        gitlab_api(&conn.base_url)
    } else {
        github_api(&conn.base_url)
    };
    let mut url = format!("{root}/{path}");
    if !query.is_empty() {
        let encoded = query
            .iter()
            .map(|(key, value)| format!("{key}={}", urlencoding(value)))
            .collect::<Vec<_>>()
            .join("&");
        url.push('?');
        url.push_str(&encoded);
    }
    let mut builder = ureq::request(method, &url).timeout(Duration::from_secs(20));
    builder = if kind == HostKind::Gitlab {
        builder.set("PRIVATE-TOKEN", &conn.token)
    } else {
        builder
            .set("Authorization", &format!("Bearer {}", conn.token))
            .set("Accept", "application/vnd.github+json")
            .set("User-Agent", "local-codex")
    };
    if body.is_some() {
        builder = builder.set("Content-Type", "application/json");
    }
    let response = if let Some(body) = body {
        builder.send_string(&body.to_string())
    } else {
        builder.call()
    };
    match response {
        Ok(resp) => {
            let mut text = String::new();
            let _ = resp.into_reader().take(8 * 1024 * 1024).read_to_string(&mut text);
            if text.is_empty() {
                Ok(json!({}))
            } else {
                serde_json::from_str(&text).or_else(|_| Ok(json!(text)))
            }
        }
        Err(ureq::Error::Status(code, resp)) => {
            let mut text = String::new();
            let _ = resp.into_reader().read_to_string(&mut text);
            Err(format!("HTTP {code}: {text}"))
        }
        Err(err) => Err(err.to_string()),
    }
}

fn urlencoding(value: &str) -> String {
    let mut out = String::new();
    for ch in value.chars() {
        match ch {
            'A'..='Z' | 'a'..='z' | '0'..='9' | '-' | '_' | '.' | '~' => out.push(ch),
            other => {
                for byte in other.to_string().into_bytes() {
                    out.push_str(&format!("%{byte:02X}"));
                }
            }
        }
    }
    out
}

fn encode_project(path: &str) -> String {
    urlencoding(path)
}

fn fetch_project(kind: HostKind, conn: &Connection, project_path: &str) -> Result<Value, String> {
    match kind {
        HostKind::Gitlab => {
            let data = request(kind, conn, "GET", &format!("projects/{}", encode_project(project_path)), &[], None)?;
            Ok(map_gitlab_project(&data, project_path))
        }
        HostKind::Github => {
            let data = request(kind, conn, "GET", &format!("repos/{project_path}"), &[], None)?;
            Ok(map_github_project(&data, project_path))
        }
    }
}

fn map_gitlab_project(project: &Value, fallback: &str) -> Value {
    json!({
        "id": project.get("id"),
        "name": project.get("name_with_namespace").or_else(|| project.get("name")).and_then(Value::as_str).unwrap_or(fallback),
        "description": project.get("description").and_then(Value::as_str).unwrap_or(""),
        "webUrl": project.get("web_url").and_then(Value::as_str).unwrap_or(""),
        "defaultBranch": project.get("default_branch").and_then(Value::as_str).unwrap_or(""),
        "visibility": project.get("visibility").and_then(Value::as_str).unwrap_or(""),
        "pathWithNamespace": project.get("path_with_namespace").and_then(Value::as_str).unwrap_or(fallback),
        "lastActivityAt": project.get("last_activity_at").and_then(Value::as_str).unwrap_or(""),
        "httpUrl": project.get("http_url_to_repo").and_then(Value::as_str).unwrap_or(""),
        "sshUrl": project.get("ssh_url_to_repo").and_then(Value::as_str).unwrap_or(""),
    })
}

fn map_github_project(repo: &Value, fallback: &str) -> Value {
    json!({
        "id": repo.get("id"),
        "name": repo.get("full_name").or_else(|| repo.get("name")).and_then(Value::as_str).unwrap_or(fallback),
        "description": repo.get("description").and_then(Value::as_str).unwrap_or(""),
        "webUrl": repo.get("html_url").and_then(Value::as_str).unwrap_or(""),
        "defaultBranch": repo.get("default_branch").and_then(Value::as_str).unwrap_or(""),
        "visibility": if repo.get("private").and_then(Value::as_bool).unwrap_or(false) { "private" } else { "public" },
        "pathWithNamespace": repo.get("full_name").and_then(Value::as_str).unwrap_or(fallback),
        "lastActivityAt": repo.get("pushed_at").or_else(|| repo.get("updated_at")).and_then(Value::as_str).unwrap_or(""),
        "httpUrl": repo.get("clone_url").and_then(Value::as_str).unwrap_or(""),
        "sshUrl": repo.get("ssh_url").and_then(Value::as_str).unwrap_or(""),
    })
}

fn map_gitlab_mr(item: &Value) -> Value {
    json!({
        "iid": item.get("iid"),
        "title": item.get("title").and_then(Value::as_str).unwrap_or(""),
        "description": item.get("description").and_then(Value::as_str).unwrap_or(""),
        "state": item.get("state").and_then(Value::as_str).unwrap_or(""),
        "draft": item.get("draft").or_else(|| item.get("work_in_progress")).and_then(Value::as_bool).unwrap_or(false),
        "sourceBranch": item.get("source_branch").and_then(Value::as_str).unwrap_or(""),
        "targetBranch": item.get("target_branch").and_then(Value::as_str).unwrap_or(""),
        "author": item.pointer("/author/name").or_else(|| item.pointer("/author/username")).and_then(Value::as_str).unwrap_or(""),
        "createdAt": item.get("created_at").and_then(Value::as_str).unwrap_or(""),
        "updatedAt": item.get("updated_at").and_then(Value::as_str).unwrap_or(""),
        "mergedAt": item.get("merged_at").and_then(Value::as_str).unwrap_or(""),
        "webUrl": item.get("web_url").and_then(Value::as_str).unwrap_or(""),
        "labels": item.get("labels").cloned().unwrap_or(json!([])),
        "sha": item.get("sha").and_then(Value::as_str).unwrap_or(""),
        "userNotesCount": item.get("user_notes_count").and_then(Value::as_u64).unwrap_or(0),
        "mergeStatus": item.get("detailed_merge_status").or_else(|| item.get("merge_status")).and_then(Value::as_str).unwrap_or(""),
        "diffRefs": {
            "baseSha": item.pointer("/diff_refs/base_sha").and_then(Value::as_str).unwrap_or(""),
            "startSha": item.pointer("/diff_refs/start_sha").and_then(Value::as_str).unwrap_or(""),
            "headSha": item.pointer("/diff_refs/head_sha").and_then(Value::as_str).unwrap_or(""),
        }
    })
}

fn map_github_pr(item: &Value) -> Value {
    let merged = item.get("merged_at").and_then(Value::as_str).is_some();
    let state = if merged {
        "merged"
    } else if item.get("state").and_then(Value::as_str) == Some("open") {
        "opened"
    } else {
        item.get("state").and_then(Value::as_str).unwrap_or("")
    };
    json!({
        "iid": item.get("number"),
        "title": item.get("title").and_then(Value::as_str).unwrap_or(""),
        "description": item.get("body").and_then(Value::as_str).unwrap_or(""),
        "state": state,
        "draft": item.get("draft").and_then(Value::as_bool).unwrap_or(false),
        "sourceBranch": item.pointer("/head/ref").and_then(Value::as_str).unwrap_or(""),
        "targetBranch": item.pointer("/base/ref").and_then(Value::as_str).unwrap_or(""),
        "author": item.pointer("/user/login").and_then(Value::as_str).unwrap_or(""),
        "createdAt": item.get("created_at").and_then(Value::as_str).unwrap_or(""),
        "updatedAt": item.get("updated_at").and_then(Value::as_str).unwrap_or(""),
        "mergedAt": item.get("merged_at").and_then(Value::as_str).unwrap_or(""),
        "webUrl": item.get("html_url").and_then(Value::as_str).unwrap_or(""),
        "sha": item.pointer("/head/sha").and_then(Value::as_str).unwrap_or(""),
        "labels": item.get("labels").and_then(Value::as_array).map(|items| items.iter().filter_map(|label| label.get("name").and_then(Value::as_str)).collect::<Vec<_>>()).unwrap_or_default(),
        "diffRefs": {
            "baseSha": item.pointer("/base/sha").and_then(Value::as_str).unwrap_or(""),
            "startSha": item.pointer("/base/sha").and_then(Value::as_str).unwrap_or(""),
            "headSha": item.pointer("/head/sha").and_then(Value::as_str).unwrap_or(""),
        }
    })
}

fn map_github_commit(item: &Value) -> Value {
    let sha = item
        .get("sha")
        .or_else(|| item.get("id"))
        .and_then(Value::as_str)
        .unwrap_or("");
    let message = item
        .pointer("/commit/message")
        .or_else(|| item.get("message"))
        .and_then(Value::as_str)
        .unwrap_or("");
    let title = message.split('\n').next().unwrap_or("");
    json!({
        "id": sha,
        "shortId": sha.get(..8).unwrap_or(sha),
        "title": title,
        "message": message,
        "authorName": item.pointer("/commit/author/name").or_else(|| item.pointer("/author/login")).or_else(|| item.get("authorName")).and_then(Value::as_str).unwrap_or(""),
        "authoredDate": item.pointer("/commit/author/date").or_else(|| item.get("authoredDate")).and_then(Value::as_str).unwrap_or(""),
        "createdAt": item.pointer("/commit/author/date").and_then(Value::as_str).unwrap_or(""),
        "parentIds": item.get("parents").and_then(Value::as_array).map(|items| items.iter().filter_map(|parent| parent.get("sha").and_then(Value::as_str)).collect::<Vec<_>>()).unwrap_or_default(),
        "webUrl": item.get("html_url").and_then(Value::as_str).unwrap_or(""),
    })
}

fn query_iid(query: &Value) -> Result<u64, String> {
    let value = query
        .get("iid")
        .ok_or_else(|| "合并请求编号无效".to_string())?;
    let id = value
        .as_u64()
        .or_else(|| value.as_i64().and_then(|n| u64::try_from(n).ok()))
        .or_else(|| value.as_f64().and_then(|n| if n > 0.0 { Some(n as u64) } else { None }))
        .or_else(|| value.as_str().and_then(|s| s.trim().parse().ok()))
        .unwrap_or(0);
    if id == 0 {
        Err("合并请求编号无效".into())
    } else {
        Ok(id)
    }
}

fn map_gitlab_commit(item: &Value) -> Value {
    let id = item
        .get("id")
        .or_else(|| item.get("commitId"))
        .and_then(Value::as_str)
        .unwrap_or("");
    let message = item
        .get("message")
        .and_then(Value::as_str)
        .unwrap_or("");
    let title = item
        .get("title")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| message.split('\n').next().unwrap_or(""));
    json!({
        "id": id,
        "shortId": item.get("short_id").or_else(|| item.get("shortId")).and_then(Value::as_str).filter(|value| !value.is_empty()).unwrap_or_else(|| &id[..id.len().min(8)]),
        "title": title,
        "message": if message.is_empty() { title } else { message },
        "authorName": item.get("author_name").or_else(|| item.get("authorName")).and_then(Value::as_str).unwrap_or(""),
        "authoredDate": item.get("authored_date").or_else(|| item.get("authoredDate")).or_else(|| item.get("committed_date")).or_else(|| item.get("created_at")).and_then(Value::as_str).unwrap_or(""),
        "createdAt": item.get("created_at").or_else(|| item.get("authored_date")).and_then(Value::as_str).unwrap_or(""),
        "parentIds": item.get("parent_ids").cloned().unwrap_or(json!([])),
        "webUrl": item.get("web_url").or_else(|| item.get("webUrl")).and_then(Value::as_str).unwrap_or(""),
    })
}

fn map_gitlab_pipeline(item: &Value) -> Value {
    json!({
        "id": item.get("id"),
        "status": item.get("status"),
        "ref": item.get("ref"),
        "sha": item.get("sha"),
        "webUrl": item.get("web_url"),
        "createdAt": item.get("created_at"),
    })
}

fn map_gitlab_tree_item(item: &Value) -> Value {
    json!({
        "id": item.get("id"),
        "name": item.get("name"),
        "path": item.get("path"),
        "type": item.get("type"),
        "mode": item.get("mode"),
    })
}

fn local_merge_commits(cwd: &Path, source: &str, target: &str) -> Vec<Value> {
    if source.is_empty() || target.is_empty() {
        return Vec::new();
    }
    let spec = format!("{target}..{source}");
    let output = git::run_in(cwd, &["log", "--format=%H%x09%h%x09%s%x09%an%x09%aI", &spec]).1;
    output
        .lines()
        .filter(|line| !line.is_empty())
        .map(|line| {
            let cols: Vec<&str> = line.split('\t').collect();
            json!({
                "id": cols.first().copied().unwrap_or(""),
                "shortId": cols.get(1).copied().unwrap_or(""),
                "title": cols.get(2).copied().unwrap_or(""),
                "message": cols.get(2).copied().unwrap_or(""),
                "authorName": cols.get(3).copied().unwrap_or(""),
                "authoredDate": cols.get(4).copied().unwrap_or(""),
                "createdAt": cols.get(4).copied().unwrap_or(""),
                "webUrl": "",
            })
        })
        .collect()
}

fn local_merge_diff(cwd: &Path, source: &str, target: &str) -> String {
    if source.is_empty() || target.is_empty() {
        return String::new();
    }
    let spec = format!("{target}...{source}");
    git::run_in(cwd, &["diff", "--find-renames", &spec]).1
}

fn gitlab_project_api(status: &Value, project_path: &str) -> String {
    if let Some(id) = status.pointer("/project/id") {
        if let Some(n) = id.as_u64() {
            return format!("projects/{n}");
        }
        if let Some(text) = id.as_i64() {
            return format!("projects/{text}");
        }
        if let Some(text) = id.as_str().filter(|value| !value.is_empty()) {
            return format!("projects/{}", encode_project(text));
        }
    }
    format!("projects/{}", encode_project(project_path))
}

fn candidate_refs(status: &Value, query: &Value) -> Vec<String> {
    let mut refs = Vec::new();
    let mut add = |value: &str| {
        let trimmed = value.trim();
        if !trimmed.is_empty() && !refs.iter().any(|item| item == trimmed) {
            refs.push(trimmed.to_string());
        }
    };
    add(query.get("ref").and_then(Value::as_str).unwrap_or(""));
    add(
        status
            .pointer("/project/defaultBranch")
            .and_then(Value::as_str)
            .unwrap_or(""),
    );
    add(status.get("currentBranch").and_then(Value::as_str).unwrap_or(""));
    add("main");
    add("master");
    refs
}

fn request_with_refs(
    conn: &Connection,
    path: &str,
    base_params: &[(&str, String)],
    refs: &[String],
    ref_key: &str,
    accept_empty: bool,
) -> Result<(Value, String), String> {
    let fallback = [String::new()];
    let list = if refs.is_empty() { &fallback[..] } else { refs };
    let mut last_error = None;
    for reference in list {
        let mut params: Vec<(&str, String)> = base_params.to_vec();
        if !reference.is_empty() {
            params.push((ref_key, reference.clone()));
        }
        match request(HostKind::Gitlab, conn, "GET", path, &params, None) {
            Ok(data) => {
                let items = as_list(&data);
                if !items.is_empty() || reference.is_empty() || accept_empty {
                    return Ok((data, reference.clone()));
                }
            }
            Err(err) => {
                if !err.contains("HTTP 404") {
                    return Err(err);
                }
                last_error = Some(err);
            }
        }
    }
    Err(last_error.unwrap_or_else(|| "无法读取仓库引用".into()))
}

fn gitlab_load(conn: &Connection, project_path: &str, status: &Value, resource: &str, query: &Value) -> Result<Value, String> {
    let api = gitlab_project_api(status, project_path);
    let per_page = query.get("perPage").and_then(Value::as_u64).unwrap_or(50).to_string();
    let cwd = config::workspace_root();
    match resource {
        "project" => Ok(json!({ "status": status, "project": fetch_project(HostKind::Gitlab, conn, project_path)? })),
        "mergeRequests" => {
            let data = request(HostKind::Gitlab, conn, "GET", &format!("{api}/merge_requests"), &[
                ("state", query.get("state").and_then(Value::as_str).unwrap_or("all").into()),
                ("per_page", per_page),
                ("order_by", "updated_at".into()),
                ("sort", "desc".into()),
            ], None)?;
            Ok(json!({ "status": status, "items": as_list(&data).into_iter().map(|item| map_gitlab_mr(&item)).collect::<Vec<_>>() }))
        }
        "mergeRequest" => {
            let iid = query_iid(query)?;
            let data = request(HostKind::Gitlab, conn, "GET", &format!("{api}/merge_requests/{iid}"), &[], None)?;
            Ok(json!({ "status": status, "mergeRequest": map_gitlab_mr(&data) }))
        }
        "mergeRequestCommits" => {
            let iid = query_iid(query)?;
            let data = request(HostKind::Gitlab, conn, "GET", &format!("{api}/merge_requests/{iid}/commits"), &[("per_page", "100".into())], None).unwrap_or(json!([]));
            let mut items: Vec<Value> = as_list(&data).into_iter().map(|item| map_gitlab_commit(&item)).collect();
            if items.is_empty() {
                items = local_merge_commits(
                    &cwd,
                    query.get("sourceBranch").and_then(Value::as_str).unwrap_or(""),
                    query.get("targetBranch").and_then(Value::as_str).unwrap_or(""),
                );
            }
            Ok(json!({ "status": status, "items": items }))
        }
        "mergeRequestDiffs" => {
            let iid = query_iid(query)?;
            let diffs = request(HostKind::Gitlab, conn, "GET", &format!("{api}/merge_requests/{iid}/diffs"), &[("per_page", "100".into())], None).unwrap_or(json!([]));
            let mut unified = gitlab_diffs_to_unified(&diffs);
            if unified.trim().is_empty() {
                unified = local_merge_diff(
                    &cwd,
                    query.get("sourceBranch").and_then(Value::as_str).unwrap_or(""),
                    query.get("targetBranch").and_then(Value::as_str).unwrap_or(""),
                );
            }
            Ok(json!({ "status": status, "diff": unified }))
        }
        "mergeRequestNotes" => {
            let iid = query_iid(query)?;
            let data = request(HostKind::Gitlab, conn, "GET", &format!("{api}/merge_requests/{iid}/notes"), &[("per_page", "100".into())], None)?;
            Ok(json!({ "status": status, "items": as_list(&data).into_iter().map(|item| json!({
                "id": item.get("id"),
                "body": item.get("body").and_then(Value::as_str).unwrap_or(""),
                "system": item.get("system").and_then(Value::as_bool).unwrap_or(false),
                "author": item.pointer("/author/name").or_else(|| item.pointer("/author/username")).and_then(Value::as_str).unwrap_or(""),
                "createdAt": item.get("created_at").and_then(Value::as_str).unwrap_or(""),
            })).collect::<Vec<_>>() }))
        }
        "mergeRequestPipelines" => {
            let iid = query_iid(query)?;
            let data = request(HostKind::Gitlab, conn, "GET", &format!("{api}/merge_requests/{iid}/pipelines"), &[], None).unwrap_or(json!([]));
            Ok(json!({ "status": status, "items": as_list(&data).into_iter().map(|item| map_gitlab_pipeline(&item)).collect::<Vec<_>>() }))
        }
        "branches" => {
            let data = request(HostKind::Gitlab, conn, "GET", &format!("{api}/repository/branches"), &[("per_page", "100".into())], None)?;
            Ok(json!({ "status": status, "items": as_list(&data).into_iter().map(|item| json!({
                "name": item.get("name"),
                "default": item.get("default"),
                "protected": item.get("protected"),
                "merged": item.get("merged"),
                "commitId": item.pointer("/commit/id"),
                "commitTitle": item.pointer("/commit/title"),
                "commitDate": item.pointer("/commit/committed_date").or_else(|| item.pointer("/commit/authored_date")),
                "webUrl": item.get("web_url"),
            })).collect::<Vec<_>>() }))
        }
        "commits" => {
            let params = vec![("per_page", per_page.clone())];
            let (data, _) = request_with_refs(
                conn,
                &format!("{api}/repository/commits"),
                &params,
                &candidate_refs(status, query),
                "ref_name",
                true,
            )?;
            Ok(json!({ "status": status, "items": as_list(&data).into_iter().map(|item| map_gitlab_commit(&item)).collect::<Vec<_>>() }))
        }
        "tags" => {
            let data = request(HostKind::Gitlab, conn, "GET", &format!("{api}/repository/tags"), &[("per_page", per_page)], None)?;
            Ok(json!({ "status": status, "items": as_list(&data).into_iter().map(|item| json!({
                "name": item.get("name"),
                "message": item.get("message").and_then(Value::as_str).unwrap_or(""),
                "commitId": item.pointer("/commit/id"),
                "commitTitle": item.pointer("/commit/title"),
                "commitDate": item.pointer("/commit/committed_date").or_else(|| item.pointer("/commit/authored_date")),
                "webUrl": item.pointer("/commit/web_url"),
            })).collect::<Vec<_>>() }))
        }
        "tree" => {
            let path = query.get("path").and_then(Value::as_str).unwrap_or("");
            let mut params = vec![("per_page", "100".into())];
            if !path.is_empty() {
                params.push(("path", path.into()));
            }
            if query.get("recursive").and_then(Value::as_bool).unwrap_or(false) {
                params.push(("recursive", "true".into()));
            }
            let (data, used_ref) = request_with_refs(
                conn,
                &format!("{api}/repository/tree"),
                &params,
                &candidate_refs(status, query),
                "ref",
                !path.is_empty(),
            )?;
            Ok(json!({
                "status": status,
                "items": as_list(&data).into_iter().map(|item| map_gitlab_tree_item(&item)).collect::<Vec<_>>(),
                "ref": used_ref,
            }))
        }
        "file" => gitlab_remote_file(conn, project_path, status, query),
        "blame" => gitlab_remote_blame(conn, project_path, status, query),
        other => Err(format!("未知 GitLab 资源：{other}")),
    }
}

fn github_load(conn: &Connection, project_path: &str, status: &Value, resource: &str, query: &Value) -> Result<Value, String> {
    let repo = format!("repos/{project_path}");
    match resource {
        "project" => Ok(json!({ "status": status, "project": fetch_project(HostKind::Github, conn, project_path)? })),
        "mergeRequests" => {
            let data = request(HostKind::Github, conn, "GET", &format!("{repo}/pulls"), &[
                ("state", query.get("state").and_then(Value::as_str).unwrap_or("all").into()),
                ("per_page", "50".into()),
            ], None)?;
            Ok(json!({ "status": status, "items": as_list(&data).into_iter().map(|item| map_github_pr(&item)).collect::<Vec<_>>() }))
        }
        "mergeRequest" => {
            let iid = query_iid(query)?;
            let data = request(HostKind::Github, conn, "GET", &format!("{repo}/pulls/{iid}"), &[], None)?;
            Ok(json!({ "status": status, "mergeRequest": map_github_pr(&data) }))
        }
        "mergeRequestCommits" => {
            let iid = query_iid(query)?;
            let data = request(HostKind::Github, conn, "GET", &format!("{repo}/pulls/{iid}/commits"), &[], None).unwrap_or(json!([]));
            Ok(json!({ "status": status, "items": as_list(&data).into_iter().map(|item| map_github_commit(&item)).collect::<Vec<_>>() }))
        }
        "mergeRequestDiffs" => {
            let iid = query_iid(query)?;
            let files = request(HostKind::Github, conn, "GET", &format!("{repo}/pulls/{iid}/files"), &[], None).unwrap_or(json!([]));
            Ok(json!({ "status": status, "diff": github_files_to_unified(&files) }))
        }
        "mergeRequestNotes" => {
            let iid = query_iid(query)?;
            let data = request(HostKind::Github, conn, "GET", &format!("{repo}/issues/{iid}/comments"), &[], None)?;
            Ok(json!({ "status": status, "items": as_list(&data).into_iter().map(|item| json!({
                "id": item.get("id"),
                "body": item.get("body").and_then(Value::as_str).unwrap_or(""),
                "system": false,
                "author": item.pointer("/user/login").and_then(Value::as_str).unwrap_or(""),
                "createdAt": item.get("created_at").and_then(Value::as_str).unwrap_or(""),
            })).collect::<Vec<_>>() }))
        }
        "mergeRequestPipelines" => {
            let sha = query.get("sha").and_then(Value::as_str).unwrap_or("");
            if sha.is_empty() {
                return Ok(json!({ "status": status, "items": [] }));
            }
            let data = request(HostKind::Github, conn, "GET", &format!("{repo}/commits/{sha}/check-runs"), &[], None).unwrap_or(json!({}));
            Ok(json!({ "status": status, "items": data.get("check_runs").cloned().unwrap_or(json!([])) }))
        }
        "branches" => {
            let data = request(HostKind::Github, conn, "GET", &format!("{repo}/branches"), &[("per_page", "100".into())], None)?;
            Ok(json!({ "status": status, "items": as_list(&data).into_iter().map(|item| json!({
                "name": item.get("name"),
                "commitId": item.pointer("/commit/sha"),
                "protected": item.get("protected"),
            })).collect::<Vec<_>>() }))
        }
        "commits" => {
            let data = request(HostKind::Github, conn, "GET", &format!("{repo}/commits"), &[("per_page", "50".into())], None)?;
            Ok(json!({ "status": status, "items": as_list(&data).into_iter().map(|item| map_github_commit(&item)).collect::<Vec<_>>() }))
        }
        "tags" => {
            let data = request(HostKind::Github, conn, "GET", &format!("{repo}/tags"), &[("per_page", "50".into())], None)?;
            Ok(json!({ "status": status, "items": as_list(&data).into_iter().map(|item| json!({
                "name": item.get("name"),
                "message": item.get("message").or_else(|| item.pointer("/commit/message")).and_then(Value::as_str).unwrap_or(""),
                "commitId": item.pointer("/commit/sha"),
                "commitTitle": item.pointer("/commit/message").and_then(Value::as_str).unwrap_or("").split('\n').next().unwrap_or(""),
                "commitDate": item.pointer("/commit/author/date").or_else(|| item.pointer("/commit/committer/date")),
                "webUrl": item.get("zipball_url"),
            })).collect::<Vec<_>>() }))
        }
        "tree" => {
            let path = query.get("path").and_then(Value::as_str).unwrap_or("");
            let reference = query.get("ref").and_then(Value::as_str).unwrap_or("");
            let api_path = if path.is_empty() {
                format!("{repo}/contents")
            } else {
                format!("{repo}/contents/{path}")
            };
            let mut params = vec![];
            if !reference.is_empty() {
                params.push(("ref", reference.into()));
            }
            let data = request(HostKind::Github, conn, "GET", &api_path, &params, None)?;
            let items = as_list(&data).into_iter().map(|item| json!({
                "name": item.get("name"),
                "path": item.get("path"),
                "type": if item.get("type").and_then(Value::as_str) == Some("dir") { "tree" } else { "blob" },
                "id": item.get("sha"),
            })).collect::<Vec<_>>();
            Ok(json!({ "status": status, "items": items, "ref": reference }))
        }
        "file" => github_remote_file(conn, project_path, status, query),
        "blame" => github_remote_blame(conn, project_path, status, query),
        other => Err(format!("未知 GitHub 资源：{other}")),
    }
}

fn gitlab_write(conn: &Connection, project_path: &str, status: &Value, action: &str, query: &Value) -> Result<Value, String> {
    let api = format!("projects/{}", encode_project(project_path));
    match action {
        "createMergeRequest" => {
            let title = query.get("title").and_then(Value::as_str).unwrap_or("").trim();
            if title.is_empty() {
                return Err("标题不能为空".into());
            }
            let source = query
                .get("sourceBranch")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .or_else(|| status.get("currentBranch").and_then(Value::as_str))
                .unwrap_or("");
            let target = query
                .get("targetBranch")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .or_else(|| status.pointer("/project/defaultBranch").and_then(Value::as_str))
                .unwrap_or("");
            if source.is_empty() || target.is_empty() {
                return Err("源分支和目标分支不能为空".into());
            }
            let data = request(HostKind::Gitlab, conn, "POST", &format!("{api}/merge_requests"), &[], Some(&json!({
                "source_branch": source,
                "target_branch": target,
                "title": title,
                "description": query.get("description").and_then(Value::as_str).unwrap_or(""),
            })))?;
            Ok(json!({ "status": status, "mergeRequest": map_gitlab_mr(&data) }))
        }
        "createNote" => {
            let iid = query_iid(query)?;
            let body = query.get("body").and_then(Value::as_str).unwrap_or("").trim();
            if body.is_empty() {
                return Err("评论不能为空".into());
            }
            let data = request(HostKind::Gitlab, conn, "POST", &format!("{api}/merge_requests/{iid}/notes"), &[], Some(&json!({ "body": body })))?;
            Ok(json!({ "status": status, "note": {
                "id": data.get("id"),
                "body": data.get("body").and_then(Value::as_str).unwrap_or(body),
                "system": false,
                "author": data.pointer("/author/name").and_then(Value::as_str).unwrap_or(""),
                "createdAt": data.get("created_at").and_then(Value::as_str).unwrap_or(""),
            }}))
        }
        "mergeMergeRequest" => {
            let iid = query_iid(query)?;
            let data = request(HostKind::Gitlab, conn, "PUT", &format!("{api}/merge_requests/{iid}/merge"), &[], Some(&json!({
                "merge_when_pipeline_succeeds": query.get("whenPipelineSucceeds").and_then(Value::as_bool).unwrap_or(false),
                "should_remove_source_branch": query.get("removeSourceBranch").and_then(Value::as_bool).unwrap_or(true),
            })))?;
            Ok(json!({ "status": status, "mergeRequest": map_gitlab_mr(&data) }))
        }
        "approveMergeRequest" => {
            let iid = query_iid(query)?;
            let _ = request(HostKind::Gitlab, conn, "POST", &format!("{api}/merge_requests/{iid}/approve"), &[], Some(&json!({})));
            let data = request(HostKind::Gitlab, conn, "GET", &format!("{api}/merge_requests/{iid}"), &[], None)?;
            Ok(json!({ "status": status, "mergeRequest": map_gitlab_mr(&data) }))
        }
        "createBranch" => {
            let name = query.get("name").and_then(Value::as_str).unwrap_or("");
            let reference = query.get("ref").and_then(Value::as_str).unwrap_or("HEAD");
            let data = request(HostKind::Gitlab, conn, "POST", &format!("{api}/repository/branches"), &[("branch", name.into()), ("ref", reference.into())], None)?;
            Ok(json!({ "status": status, "branch": { "name": data.get("name").and_then(Value::as_str).unwrap_or(name), "commitId": data.pointer("/commit/id") } }))
        }
        "updateMergeRequestState" => {
            let iid = query_iid(query)?;
            let event = query.get("stateEvent").and_then(Value::as_str).unwrap_or("");
            let data = request(HostKind::Gitlab, conn, "PUT", &format!("{api}/merge_requests/{iid}"), &[], Some(&json!({ "state_event": event })))?;
            Ok(json!({ "status": status, "mergeRequest": map_gitlab_mr(&data) }))
        }
        "createReviewComment" => {
            let iid = query_iid(query)?;
            let body = query.get("body").and_then(Value::as_str).unwrap_or("");
            let path = query.get("path").and_then(Value::as_str).unwrap_or("");
            let data = request(HostKind::Gitlab, conn, "POST", &format!("{api}/merge_requests/{iid}/discussions"), &[], Some(&json!({
                "body": body,
                "position": {
                    "position_type": "text",
                    "base_sha": query.pointer("/diffRefs/baseSha").and_then(Value::as_str).unwrap_or(""),
                    "start_sha": query.pointer("/diffRefs/startSha").and_then(Value::as_str).unwrap_or(""),
                    "head_sha": query.pointer("/diffRefs/headSha").and_then(Value::as_str).unwrap_or(""),
                    "old_path": query.get("oldPath").and_then(Value::as_str).unwrap_or(path),
                    "new_path": path,
                    "new_line": query.get("newLine"),
                    "old_line": query.get("oldLine"),
                }
            })))?;
            Ok(json!({ "status": status, "note": { "id": data.get("id"), "body": body } }))
        }
        other => Err(format!("未知 GitLab 写入操作：{other}")),
    }
}

fn github_write(conn: &Connection, project_path: &str, status: &Value, action: &str, query: &Value) -> Result<Value, String> {
    let repo = format!("repos/{project_path}");
    match action {
        "createMergeRequest" => {
            let title = query.get("title").and_then(Value::as_str).unwrap_or("").trim();
            if title.is_empty() {
                return Err("标题不能为空".into());
            }
            let data = request(HostKind::Github, conn, "POST", &format!("{repo}/pulls"), &[], Some(&json!({
                "title": title,
                "head": query.get("sourceBranch").and_then(Value::as_str).unwrap_or(""),
                "base": query.get("targetBranch").and_then(Value::as_str).unwrap_or(""),
                "body": query.get("description").and_then(Value::as_str).unwrap_or(""),
            })))?;
            Ok(json!({ "status": status, "mergeRequest": map_github_pr(&data) }))
        }
        "createNote" => {
            let iid = query_iid(query)?;
            let body = query.get("body").and_then(Value::as_str).unwrap_or("");
            let data = request(HostKind::Github, conn, "POST", &format!("{repo}/issues/{iid}/comments"), &[], Some(&json!({ "body": body })))?;
            Ok(json!({ "status": status, "note": {
                "id": data.get("id"),
                "body": data.get("body").and_then(Value::as_str).unwrap_or(body),
                "author": data.pointer("/user/login").and_then(Value::as_str).unwrap_or(""),
                "createdAt": data.get("created_at").and_then(Value::as_str).unwrap_or(""),
            }}))
        }
        "mergeMergeRequest" => {
            let iid = query_iid(query)?;
            let _ = request(HostKind::Github, conn, "PUT", &format!("{repo}/pulls/{iid}/merge"), &[], Some(&json!({})))?;
            let data = request(HostKind::Github, conn, "GET", &format!("{repo}/pulls/{iid}"), &[], None)?;
            Ok(json!({ "status": status, "mergeRequest": map_github_pr(&data) }))
        }
        "approveMergeRequest" => {
            let iid = query_iid(query)?;
            let _ = request(HostKind::Github, conn, "POST", &format!("{repo}/pulls/{iid}/reviews"), &[], Some(&json!({ "event": "APPROVE" })));
            let data = request(HostKind::Github, conn, "GET", &format!("{repo}/pulls/{iid}"), &[], None)?;
            Ok(json!({ "status": status, "mergeRequest": map_github_pr(&data) }))
        }
        "createBranch" => {
            let name = query.get("name").and_then(Value::as_str).unwrap_or("");
            let reference = query.get("ref").and_then(Value::as_str).unwrap_or("HEAD");
            let sha = git::run_in(&config::workspace_root(), &["rev-parse", reference]).1;
            let data = request(HostKind::Github, conn, "POST", &format!("{repo}/git/refs"), &[], Some(&json!({
                "ref": format!("refs/heads/{name}"),
                "sha": sha,
            })))?;
            Ok(json!({ "status": status, "branch": { "name": name, "commitId": data.pointer("/object/sha") } }))
        }
        "updateMergeRequestState" => {
            let iid = query_iid(query)?;
            let event = query.get("stateEvent").and_then(Value::as_str).unwrap_or("");
            let state = if event == "close" { "closed" } else { "open" };
            let data = request(HostKind::Github, conn, "PATCH", &format!("{repo}/pulls/{iid}"), &[], Some(&json!({ "state": state })))?;
            Ok(json!({ "status": status, "mergeRequest": map_github_pr(&data) }))
        }
        "createReviewComment" => {
            let iid = query_iid(query)?;
            let data = request(HostKind::Github, conn, "POST", &format!("{repo}/pulls/{iid}/comments"), &[], Some(&json!({
                "body": query.get("body").and_then(Value::as_str).unwrap_or(""),
                "path": query.get("path").and_then(Value::as_str).unwrap_or(""),
                "commit_id": query.pointer("/diffRefs/headSha").and_then(Value::as_str).unwrap_or(""),
                "line": query.get("newLine"),
                "side": "RIGHT",
            })))?;
            Ok(json!({ "status": status, "note": { "id": data.get("id"), "body": data.get("body") } }))
        }
        other => Err(format!("未知 GitHub 写入操作：{other}")),
    }
}

fn gitlab_projects(conn: &Connection, search: &str) -> Result<Vec<Value>, String> {
    let mut query = vec![
        ("membership", "true".into()),
        ("min_access_level", "40".into()),
        ("archived", "false".into()),
        ("order_by", "last_activity_at".into()),
        ("sort", "desc".into()),
        ("per_page", "100".into()),
    ];
    if !search.is_empty() {
        query.push(("search", search.into()));
    }
    let data = request(HostKind::Gitlab, conn, "GET", "projects", &query, None)?;
    Ok(as_list(&data)
        .into_iter()
        .map(|item| map_gitlab_project(&item, item.get("path_with_namespace").and_then(Value::as_str).unwrap_or("")))
        .collect())
}

fn github_projects(conn: &Connection, search: &str) -> Result<Vec<Value>, String> {
    let data = request(HostKind::Github, conn, "GET", "user/repos", &[
        ("per_page", "100".into()),
        ("sort", "updated".into()),
        ("affiliation", "owner,collaborator,organization_member".into()),
    ], None)?;
    Ok(as_list(&data)
        .into_iter()
        .filter(|item| {
            search.is_empty()
                || item
                    .get("full_name")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_lowercase()
                    .contains(&search.to_lowercase())
        })
        .map(|item| map_github_project(&item, item.get("full_name").and_then(Value::as_str).unwrap_or("")))
        .collect())
}

fn as_list(data: &Value) -> Vec<Value> {
    data.as_array().cloned().unwrap_or_default()
}

fn gitlab_diffs_to_unified(data: &Value) -> String {
    as_list(data)
        .into_iter()
        .map(|item| {
            let old_path = item.get("old_path").and_then(Value::as_str).unwrap_or("file");
            let new_path = item.get("new_path").and_then(Value::as_str).unwrap_or(old_path);
            let diff = item.get("diff").and_then(Value::as_str).unwrap_or("");
            if diff.starts_with("diff --git ") {
                diff.to_string()
            } else {
                format!("diff --git a/{old_path} b/{new_path}\n--- a/{old_path}\n+++ b/{new_path}\n{diff}")
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn github_files_to_unified(data: &Value) -> String {
    as_list(data)
        .into_iter()
        .map(|item| {
            let path = item.get("filename").and_then(Value::as_str).unwrap_or("file");
            let old_path = item.get("previous_filename").and_then(Value::as_str).unwrap_or(path);
            let patch = item.get("patch").and_then(Value::as_str).unwrap_or("");
            if patch.starts_with("diff --git ") {
                patch.to_string()
            } else {
                format!("diff --git a/{old_path} b/{path}\n--- a/{old_path}\n+++ b/{path}\n{patch}")
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn local_graph(cwd: &Path, limit: u64) -> Vec<Value> {
    let count = limit.clamp(50, 5000).to_string();
    let spec = format!("-n{count}");
    let output = git::run_in(cwd, &[
        "log",
        "--all",
        "--topo-order",
        &spec,
        "--pretty=format:%H%x09%P%x09%h%x09%s%x09%an%x09%aI%x09%D",
    ]).1;
    output
        .lines()
        .filter(|line| !line.is_empty())
        .map(|line| {
            let cols: Vec<&str> = line.split('\t').collect();
            json!({
                "id": cols.first().copied().unwrap_or(""),
                "shortId": cols.get(2).copied().unwrap_or(""),
                "title": cols.get(3).copied().unwrap_or(""),
                "authorName": cols.get(4).copied().unwrap_or(""),
                "authoredDate": cols.get(5).copied().unwrap_or(""),
                "createdAt": cols.get(5).copied().unwrap_or(""),
                "parentIds": cols.get(1).unwrap_or(&"").split_whitespace().collect::<Vec<_>>(),
                "refs": [],
                "webUrl": "",
            })
        })
        .collect()
}

fn local_commit_diff(cwd: &Path, sha: &str) -> (Value, String) {
    let spec = if sha.is_empty() { "HEAD" } else { sha };
    let meta = git::run_in(cwd, &["log", "-1", "--format=%H%x09%h%x09%s%x09%an%x09%aI%x09%P", spec]).1;
    let cols: Vec<&str> = meta.split('\t').collect();
    let commit = json!({
        "id": cols.first().copied().unwrap_or(spec),
        "shortId": cols.get(1).copied().unwrap_or(""),
        "title": cols.get(2).copied().unwrap_or(""),
        "authorName": cols.get(3).copied().unwrap_or(""),
        "authoredDate": cols.get(4).copied().unwrap_or(""),
        "parentIds": cols.get(5).unwrap_or(&"").split_whitespace().collect::<Vec<_>>(),
    });
    let diff = git::run_in(cwd, &["show", "--format=", "--find-renames", spec]).1;
    (commit, diff)
}

fn parse_blame(output: &str) -> Vec<Value> {
    let mut items = Vec::new();
    let mut current = json!({ "commitId": "", "shortId": "", "authorName": "", "authoredDate": "", "lines": [] });
    for line in output.lines() {
        if let Some(rest) = line.strip_prefix("author ") {
            current.as_object_mut().unwrap().insert("authorName".into(), json!(rest));
        } else if let Some(rest) = line.strip_prefix("author-time ") {
            current.as_object_mut().unwrap().insert("authoredDate".into(), json!(rest));
        } else if line.starts_with('\t') {
            current
                .as_object_mut()
                .unwrap()
                .entry("lines")
                .or_insert_with(|| json!([]))
                .as_array_mut()
                .unwrap()
                .push(json!(line.trim_start_matches('\t')));
        } else if line.len() >= 40 && line.as_bytes().iter().take(40).all(|b| b.is_ascii_hexdigit()) {
            if current.get("commitId").and_then(Value::as_str).unwrap_or("").is_empty() == false {
                items.push(current.clone());
            }
            let sha = &line[..40];
            current = json!({
                "commitId": sha,
                "shortId": &sha[..8.min(sha.len())],
                "authorName": "",
                "authoredDate": "",
                "lines": [],
            });
        }
    }
    if current.get("commitId").and_then(Value::as_str).map(|value| !value.is_empty()).unwrap_or(false) {
        items.push(current);
    }
    items
}

fn normalize_host(value: &str) -> String {
    let raw = value.trim();
    if raw.is_empty() {
        return String::new();
    }
    let with_scheme = if raw.contains("://") {
        raw.to_string()
    } else {
        format!("https://{raw}")
    };
    with_scheme
        .split("://")
        .nth(1)
        .unwrap_or(raw)
        .split('/')
        .next()
        .unwrap_or(raw)
        .split(':')
        .next()
        .unwrap_or(raw)
        .to_lowercase()
}

fn image_mime(path: &str) -> Option<&'static str> {
    match Path::new(path)
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_lowercase()
        .as_str()
    {
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "gif" => Some("image/gif"),
        "webp" => Some("image/webp"),
        "bmp" => Some("image/bmp"),
        "svg" => Some("image/svg+xml"),
        "ico" => Some("image/x-icon"),
        _ => None,
    }
}

fn file_payload(path: &str, reference: &str, bytes: &[u8], source: &str) -> Value {
    let size = bytes.len();
    let image = image_mime(path);
    let binary = image.is_none() && bytes.iter().take(8000).any(|byte| *byte == 0);
    let too_large = if image.is_some() {
        size > 8 * 1024 * 1024
    } else {
        size > 2 * 1024 * 1024
    };
    let mut payload = json!({
        "path": path,
        "name": Path::new(path).file_name().map(|name| name.to_string_lossy().into_owned()).unwrap_or_default(),
        "ref": reference,
        "size": size,
        "binary": binary,
        "image": image.is_some(),
        "tooLarge": too_large,
        "content": "",
        "dataUrl": "",
        "source": source,
        "commit": null,
    });
    if too_large || (binary && image.is_none()) {
        return payload;
    }
    if let Some(mime) = image {
        let encoded = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, bytes);
        payload["dataUrl"] = json!(format!("data:{mime};base64,{encoded}"));
        return payload;
    }
    payload["content"] = json!(String::from_utf8_lossy(bytes).to_string());
    payload
}

fn decode_base64_content(data: &Value) -> Vec<u8> {
    let content = data.get("content").and_then(Value::as_str).unwrap_or("");
    let encoding = data
        .get("encoding")
        .and_then(Value::as_str)
        .unwrap_or("base64")
        .to_lowercase();
    if encoding == "base64" {
        let compact: String = content.chars().filter(|ch| !ch.is_whitespace()).collect();
        base64::Engine::decode(&base64::engine::general_purpose::STANDARD, compact).unwrap_or_default()
    } else {
        content.as_bytes().to_vec()
    }
}

fn gitlab_remote_file(conn: &Connection, project_path: &str, status: &Value, query: &Value) -> Result<Value, String> {
    let file_path = query.get("path").and_then(Value::as_str).unwrap_or("");
    let api = format!(
        "{}/repository/files/{}",
        gitlab_project_api(status, project_path),
        urlencoding(file_path)
    );
    let refs = candidate_refs(status, query);
    let (data, used_ref) = request_with_refs(conn, &api, &[], &refs, "ref", true)?;
    let bytes = decode_base64_content(&data);
    let used_ref = data
        .get("ref")
        .and_then(Value::as_str)
        .unwrap_or(&used_ref);
    Ok(json!({
        "status": status,
        "file": file_payload(file_path, used_ref, &bytes, "gitlab"),
    }))
}

fn gitlab_remote_blame(conn: &Connection, project_path: &str, status: &Value, query: &Value) -> Result<Value, String> {
    let file_path = query.get("path").and_then(Value::as_str).unwrap_or("");
    let api = format!(
        "{}/repository/files/{}/blame",
        gitlab_project_api(status, project_path),
        urlencoding(file_path)
    );
    let refs = candidate_refs(status, query);
    let (data, _) = request_with_refs(conn, &api, &[], &refs, "ref", true)?;
    let items: Vec<Value> = as_list(&data)
        .into_iter()
        .map(|item| {
            json!({
                "commitId": item.pointer("/commit/id").and_then(Value::as_str).unwrap_or(""),
                "shortId": item.pointer("/commit/short_id").and_then(Value::as_str).unwrap_or(""),
                "authorName": item.pointer("/commit/author_name").and_then(Value::as_str).unwrap_or(""),
                "authoredDate": item.pointer("/commit/authored_date").and_then(Value::as_str).unwrap_or(""),
                "lines": item.get("lines").cloned().unwrap_or(json!([])),
            })
        })
        .collect();
    Ok(json!({ "status": status, "items": items }))
}

fn github_remote_file(conn: &Connection, project_path: &str, status: &Value, query: &Value) -> Result<Value, String> {
    let file_path = query.get("path").and_then(Value::as_str).unwrap_or("");
    let reference = query.get("ref").and_then(Value::as_str).unwrap_or("");
    let api = format!("repos/{project_path}/contents/{file_path}");
    let mut params = vec![];
    if !reference.is_empty() {
        params.push(("ref", reference.to_string()));
    }
    let data = request(HostKind::Github, conn, "GET", &api, &params, None)?;
    let bytes = decode_base64_content(&data);
    Ok(json!({
        "status": status,
        "file": file_payload(file_path, reference, &bytes, "github"),
    }))
}

fn github_remote_blame(_conn: &Connection, _project_path: &str, status: &Value, query: &Value) -> Result<Value, String> {
    let file_path = query.get("path").and_then(Value::as_str).unwrap_or("");
    let reference = query.get("ref").and_then(Value::as_str).unwrap_or("HEAD");
    let cwd = config::workspace_root();
    let output = git::run_in(&cwd, &["blame", "--line-porcelain", reference, "--", file_path]);
    if output.0 {
        return Ok(json!({ "status": status, "items": parse_blame(&output.1) }));
    }
    let detail = output.1.trim();
    Err(if detail.is_empty() {
        "无法读取 Git blame".into()
    } else {
        format!("无法读取 Git blame：{detail}")
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn candidate_refs_prefers_requested_then_default() {
        let status = json!({
            "currentBranch": "local-only",
            "project": { "defaultBranch": "develop", "id": 12 }
        });
        assert_eq!(
            candidate_refs(&status, &json!({})),
            vec!["develop", "local-only", "main", "master"]
        );
        assert_eq!(
            candidate_refs(&status, &json!({ "ref": "feature/x" }))[0],
            "feature/x"
        );
    }

    #[test]
    fn candidate_refs_skips_empty() {
        let status = json!({ "currentBranch": "  ", "project": { "defaultBranch": "" } });
        assert_eq!(candidate_refs(&status, &json!({ "ref": "" })), vec!["main", "master"]);
    }

    #[test]
    fn gitlab_project_api_prefers_numeric_id() {
        assert_eq!(
            gitlab_project_api(&json!({ "project": { "id": 99 } }), "group/name"),
            "projects/99"
        );
        assert_eq!(
            gitlab_project_api(&json!({}), "group/name"),
            "projects/group%2Fname"
        );
    }
}
