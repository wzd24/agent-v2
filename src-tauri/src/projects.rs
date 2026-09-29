use crate::config;
use serde_json::{json, Map, Value};
use std::fs;
use std::path::{Path, PathBuf};

fn projects_path() -> PathBuf {
    config::app_root().join("projects.json")
}

fn threads_path() -> PathBuf {
    config::app_root().join("threads.json")
}

fn display_path(path: &Path) -> String {
    path.display()
        .to_string()
        .trim_start_matches(r"\\?\")
        .to_string()
}

fn same_path(left: &str, right: &str) -> bool {
    normalize(left) == normalize(right)
}

fn normalize(path: &str) -> String {
    let value = path
        .trim()
        .trim_start_matches(r"\\?\")
        .trim_end_matches(['\\', '/']);
    if cfg!(windows) {
        value.to_lowercase()
    } else {
        value.to_string()
    }
}

fn project_roots(project: &Value) -> Vec<String> {
    let mut roots = Vec::new();
    if let Some(list) = project.get("rootPaths").and_then(Value::as_array) {
        for item in list {
            if let Some(path) = item.as_str() {
                if !path.trim().is_empty() {
                    roots.push(path.to_string());
                }
            }
        }
    }
    if roots.is_empty() {
        if let Some(path) = project.get("path").and_then(Value::as_str) {
            if !path.trim().is_empty() {
                roots.push(path.to_string());
            }
        }
    }
    roots
}

fn git_origin(root: &str) -> String {
    let mut command = std::process::Command::new("git");
    command.args(["-C", root, "config", "--get", "remote.origin.url"]);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000);
    }
    command
        .output()
        .ok()
        .filter(|result| result.status.success())
        .map(|result| String::from_utf8_lossy(&result.stdout).trim().to_string())
        .unwrap_or_default()
}

fn to_project(project: &Value) -> Option<Value> {
    let roots = project_roots(project);
    let root = roots.first()?.clone();
    let name = project
        .get("name")
        .and_then(Value::as_str)
        .map(str::to_string)
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| {
            Path::new(&root)
                .file_name()
                .map(|name| name.to_string_lossy().into_owned())
                .unwrap_or_else(|| root.clone())
        });
    Some(json!({
        "id": project.get("id").and_then(Value::as_str).unwrap_or(""),
        "path": root,
        "rootPaths": roots,
        "name": name,
        "trustLevel": project.get("trustLevel").and_then(Value::as_str).unwrap_or("trusted"),
        "gitOrigin": git_origin(&root),
    }))
}

fn read_json(path: &Path) -> Value {
    fs::read_to_string(path)
        .ok()
        .and_then(|source| serde_json::from_str(&source).ok())
        .unwrap_or_else(|| json!({}))
}

fn write_json(path: &Path, value: &Value) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|err| err.to_string())?;
    }
    fs::write(
        path,
        serde_json::to_string_pretty(value).map_err(|err| err.to_string())?,
    )
    .map_err(|err| err.to_string())
}

fn projects_from_map(map: &Map<String, Value>) -> Vec<Value> {
    map.values().filter_map(to_project).collect()
}

fn migrate_legacy() {
    if projects_path().exists() && threads_path().exists() {
        return;
    }
    let home = config::engine_home();
    let state = read_json(&home.join(".codex-global-state.json"));
    let persisted = state
        .get("electron-persisted-atom-state")
        .cloned()
        .unwrap_or_else(|| json!({}));
    if !projects_path().exists() {
        let local = state
            .get("local-projects")
            .or_else(|| persisted.get("local-projects"))
            .cloned()
            .unwrap_or_else(|| json!({}));
        let mut projects = if let Value::Object(map) = local {
            projects_from_map(&map)
        } else {
            Vec::new()
        };
        if projects.is_empty() {
            projects = read_engine_toml_projects(&home);
        }
        let _ = write_json(
            &projects_path(),
            &json!({ "version": 1, "projects": projects }),
        );
    }
    if !threads_path().exists() {
        let assignments = state
            .get("thread-project-assignments")
            .or_else(|| persisted.get("thread-project-assignments"))
            .cloned()
            .unwrap_or_else(|| json!({}));
        let projectless = state
            .get("projectless-thread-ids")
            .or_else(|| persisted.get("projectless-thread-ids"))
            .cloned()
            .unwrap_or_else(|| json!([]));
        let _ = write_json(
            &threads_path(),
            &json!({
                "version": 1,
                "assignments": assignments,
                "projectless": projectless
            }),
        );
    }
}

fn read_engine_toml_projects(home: &Path) -> Vec<Value> {
    let source = fs::read_to_string(home.join("config.toml")).unwrap_or_default();
    let mut projects = Vec::new();
    for line in source.lines() {
        let trimmed = line.trim();
        if let Some(rest) = trimmed.strip_prefix("[projects.\"") {
            if let Some(end) = rest.find("\"]") {
                let project_path = rest[..end].replace("\\\\", "\\").replace("\\\"", "\"");
                projects.push(json!({
                    "id": format!("proj-{}", projects.len() + 1),
                    "path": project_path,
                    "rootPaths": [project_path.clone()],
                    "name": Path::new(&project_path).file_name().map(|name| name.to_string_lossy().into_owned()).unwrap_or_else(|| project_path.clone()),
                    "trustLevel": "trusted",
                }));
            }
        }
    }
    projects
}

fn read_projects() -> Vec<Value> {
    migrate_legacy();
    let document = read_json(&projects_path());
    document
        .get("projects")
        .and_then(Value::as_array)
        .map(|items| items.iter().filter_map(to_project).collect())
        .unwrap_or_default()
}

fn write_projects(projects: &[Value]) -> Result<(), String> {
    write_json(
        &projects_path(),
        &json!({ "version": 1, "projects": projects }),
    )
}

fn read_threads() -> Value {
    migrate_legacy();
    let document = read_json(&threads_path());
    json!({
        "assignments": document.get("assignments").cloned().unwrap_or_else(|| json!({})),
        "projectless": document.get("projectless").cloned().unwrap_or_else(|| json!([])),
    })
}

fn write_threads(assignments: Value, projectless: Value) -> Result<(), String> {
    write_json(
        &threads_path(),
        &json!({
            "version": 1,
            "assignments": assignments,
            "projectless": projectless
        }),
    )
}

pub fn list_projects() -> Vec<Value> {
    read_projects()
}

pub fn thread_metadata() -> Value {
    read_threads()
}

pub fn assign_thread(thread_id: &str, assignment: Option<Value>) -> Result<Value, String> {
    let id = thread_id.trim();
    if id.is_empty() {
        return Err("线程无效".into());
    }
    let current = read_threads();
    let mut assignments = current
        .get("assignments")
        .cloned()
        .unwrap_or_else(|| json!({}));
    if !assignments.is_object() {
        assignments = json!({});
    }
    let mut projectless: Vec<String> = current
        .get("projectless")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default();
    let project_id = assignment
        .as_ref()
        .and_then(|value| value.get("projectId"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    if project_id.is_empty() {
        assignments.as_object_mut().unwrap().remove(id);
        if !projectless.iter().any(|item| item == id) {
            projectless.push(id.to_string());
        }
    } else {
        assignments.as_object_mut().unwrap().insert(
            id.to_string(),
            json!({
                "projectId": project_id,
                "projectKind": assignment.as_ref().and_then(|value| value.get("projectKind")).and_then(Value::as_str).unwrap_or("local"),
                "projectPath": assignment.as_ref().and_then(|value| value.get("projectPath")).and_then(Value::as_str).unwrap_or(""),
            }),
        );
        projectless.retain(|item| item != id);
    }
    write_threads(assignments, json!(projectless))?;
    Ok(thread_metadata())
}

pub fn forget_thread(thread_id: &str) -> Result<Value, String> {
    let id = thread_id.trim();
    if id.is_empty() {
        return Ok(thread_metadata());
    }
    let current = read_threads();
    let mut assignments = current
        .get("assignments")
        .cloned()
        .unwrap_or_else(|| json!({}));
    if let Some(map) = assignments.as_object_mut() {
        map.remove(id);
    }
    let mut projectless: Vec<String> = current
        .get("projectless")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default();
    projectless.retain(|item| item != id);
    write_threads(assignments, json!(projectless))?;
    Ok(thread_metadata())
}

pub fn inherit_assignment(from_id: &str, to_id: &str) -> Result<Value, String> {
    let from = from_id.trim();
    let to = to_id.trim();
    if from.is_empty() || to.is_empty() {
        return Ok(thread_metadata());
    }
    let current = read_threads();
    let projectless: Vec<String> = current
        .get("projectless")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default();
    if projectless.iter().any(|item| item == from) {
        return assign_thread(to, None);
    }
    let assignment = current
        .get("assignments")
        .and_then(Value::as_object)
        .and_then(|map| map.get(from))
        .cloned();
    assign_thread(to, assignment)
}

pub fn find_project_for_path(path: &str) -> Option<Value> {
    infer_project_from_cwd(path, None, &read_projects())
}

struct ThreadAssignmentState {
    projects: Vec<Value>,
    assignments: Value,
    projectless: Vec<String>,
}

fn load_thread_assignment_state() -> ThreadAssignmentState {
    let projects = read_projects();
    let current = read_threads();
    let mut assignments = current
        .get("assignments")
        .cloned()
        .unwrap_or_else(|| json!({}));
    if !assignments.is_object() {
        assignments = json!({});
    }
    let projectless = current
        .get("projectless")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default();
    ThreadAssignmentState {
        projects,
        assignments,
        projectless,
    }
}

pub fn attach_project_ids(result: Value) -> Value {
    let Some(items) = result.get("data").and_then(Value::as_array).cloned() else {
        return result;
    };
    if items.is_empty() {
        return result;
    }
    let ThreadAssignmentState {
        projects,
        mut assignments,
        projectless,
    } = load_thread_assignment_state();
    let mut changed = false;
    let hydrated: Vec<Value> = items
        .into_iter()
        .map(|item| {
            attach_one_thread(item, &projects, &mut assignments, &projectless, &mut changed)
        })
        .collect();
    if changed {
        let _ = write_threads(assignments, json!(projectless));
    }
    let mut next = result;
    if let Some(object) = next.as_object_mut() {
        object.insert("data".into(), json!(hydrated));
    }
    next
}

pub fn attach_started_thread(result: Value) -> Value {
    let ThreadAssignmentState {
        projects,
        mut assignments,
        projectless,
    } = load_thread_assignment_state();
    let mut changed = false;
    let next = attach_one_thread(result, &projects, &mut assignments, &projectless, &mut changed);
    if changed {
        let _ = write_threads(assignments, json!(projectless));
    }
    next
}

fn attach_one_thread(
    mut item: Value,
    projects: &[Value],
    assignments: &mut Value,
    projectless: &[String],
    changed: &mut bool,
) -> Value {
    let id = thread_id(&item);
    if id.is_empty() {
        return item;
    }
    if projectless.iter().any(|item| item == &id) {
        set_thread_project_id(&mut item, Value::Null);
        return item;
    }
    if let Some(existing) = assignments
        .get(&id)
        .and_then(|value| value.get("projectId"))
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
    {
        set_thread_project_id(&mut item, json!(existing));
        return item;
    }
    let cwd = thread_field(&item, "cwd");
    let origin = thread_git_origin(&item);
    if let Some(project) = infer_project_from_cwd(&cwd, origin.as_deref(), projects) {
        let project_id = project
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        if !project_id.is_empty() {
            if let Some(map) = assignments.as_object_mut() {
                map.insert(
                    id,
                    json!({
                        "projectId": project_id,
                        "projectKind": "local",
                        "projectPath": project.get("path").and_then(Value::as_str).unwrap_or(""),
                    }),
                );
            }
            set_thread_project_id(&mut item, json!(project_id));
            *changed = true;
        }
    }
    item
}

fn thread_id(item: &Value) -> String {
    item.get("thread")
        .and_then(|thread| thread.get("id"))
        .or_else(|| item.get("id"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string()
}

fn thread_field(item: &Value, key: &str) -> String {
    item.get("thread")
        .and_then(|thread| thread.get(key))
        .or_else(|| item.get(key))
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string()
}

fn thread_git_origin(item: &Value) -> Option<String> {
    let git = item
        .get("thread")
        .and_then(|thread| thread.get("gitInfo"))
        .or_else(|| item.get("gitInfo"))?;
    git.get("originUrl")
        .or_else(|| git.get("origin_url"))
        .and_then(Value::as_str)
        .map(str::to_string)
        .filter(|value| !value.is_empty())
}

fn set_thread_project_id(item: &mut Value, project_id: Value) {
    if let Some(thread) = item.get_mut("thread").and_then(Value::as_object_mut) {
        thread.insert("projectId".into(), project_id);
        return;
    }
    if let Some(object) = item.as_object_mut() {
        object.insert("projectId".into(), project_id);
    }
}

fn infer_project_from_cwd(cwd: &str, origin: Option<&str>, projects: &[Value]) -> Option<Value> {
    if let Some(origin) = origin.filter(|value| !value.trim().is_empty()) {
        let target = normalize_remote(origin);
        if !target.is_empty() {
            if let Some(project) = projects.iter().find(|project| {
                normalize_remote(project.get("gitOrigin").and_then(Value::as_str).unwrap_or(""))
                    == target
            }) {
                return Some(project.clone());
            }
        }
    }
    let cwd = normalize(cwd);
    if cwd.is_empty() {
        return None;
    }
    projects
        .iter()
        .filter(|project| {
            project_roots(project).iter().any(|root| {
                let root = normalize(root);
                !root.is_empty() && (cwd == root || cwd.starts_with(&(root.clone() + "\\")) || cwd.starts_with(&(root + "/")))
            })
        })
        .max_by_key(|project| {
            project_roots(project)
                .iter()
                .map(|root| normalize(root).len())
                .max()
                .unwrap_or(0)
        })
        .cloned()
}

fn normalize_remote(value: &str) -> String {
    let value = value.trim();
    let value = value
        .split_once("://")
        .map(|(_, rest)| rest)
        .unwrap_or(value);
    value
        .trim_start_matches("git@")
        .trim_end_matches(".git")
        .trim_end_matches('/')
        .to_lowercase()
}

pub fn register_project(project_path: &str, project_name: &str) -> Result<Value, String> {
    let target = fs::canonicalize(project_path).map_err(|_| "项目源文件夹不存在".to_string())?;
    if !target.is_dir() {
        return Err("项目源文件夹不存在".into());
    }
    let target_s = display_path(&target);
    let mut projects = read_projects();
    if let Some(existing) = projects.iter().find(|project| {
        project_roots(project)
            .iter()
            .any(|root| same_path(root, &target_s))
    }) {
        return Ok(existing.clone());
    }
    let id = format!(
        "proj-{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0)
    );
    let name = if project_name.trim().is_empty() {
        target
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_else(|| target_s.clone())
    } else {
        project_name.trim().to_string()
    };
    let entry = json!({
        "id": id,
        "name": name,
        "path": target_s,
        "rootPaths": [target_s],
        "trustLevel": "trusted",
    });
    let saved = to_project(&entry).unwrap_or(entry);
    projects.push(saved.clone());
    write_projects(&projects)?;
    Ok(saved)
}

fn find_index(projects: &[Value], project_path: &str) -> Option<usize> {
    projects.iter().position(|project| {
        project_roots(project)
            .iter()
            .any(|root| same_path(root, project_path))
    })
}

pub fn update_project(old_path: &str, project_name: &str, new_path: &str) -> Result<Value, String> {
    let new_path = if new_path.trim().is_empty() {
        old_path
    } else {
        new_path
    };
    let target = fs::canonicalize(new_path).map_err(|_| "项目源文件夹不存在".to_string())?;
    let target_s = display_path(&target);
    let mut projects = read_projects();
    let Some(index) = find_index(&projects, old_path) else {
        return register_project(&target_s, project_name);
    };
    let name = if project_name.trim().is_empty() {
        target
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_else(|| target_s.clone())
    } else {
        project_name.trim().to_string()
    };
    if let Some(project) = projects.get_mut(index) {
        let object = project.as_object_mut().unwrap();
        object.insert("path".into(), json!(target_s));
        object.insert("rootPaths".into(), json!([target_s]));
        object.insert("name".into(), json!(name));
    }
    let saved = projects
        .get(index)
        .cloned()
        .and_then(|value| to_project(&value))
        .unwrap_or_else(|| json!({}));
    write_projects(&projects)?;
    Ok(saved)
}

pub fn delete_project(project_path: &str) -> Result<Value, String> {
    let mut projects = read_projects();
    let removed: Vec<String> = projects
        .iter()
        .filter(|project| {
            project_roots(project)
                .iter()
                .any(|root| same_path(root, project_path))
        })
        .filter_map(|project| {
            project
                .get("id")
                .and_then(Value::as_str)
                .map(str::to_string)
        })
        .collect();
    projects.retain(|project| {
        !project_roots(project)
            .iter()
            .any(|root| same_path(root, project_path))
    });
    write_projects(&projects)?;
    if !removed.is_empty() {
        let current = read_threads();
        let mut assignments = current
            .get("assignments")
            .cloned()
            .unwrap_or_else(|| json!({}));
        if let Some(map) = assignments.as_object_mut() {
            map.retain(|_, value| {
                let id = value
                    .get("projectId")
                    .and_then(Value::as_str)
                    .unwrap_or("");
                let path = value
                    .get("projectPath")
                    .and_then(Value::as_str)
                    .unwrap_or("");
                !removed.iter().any(|item| item == id) && !same_path(path, project_path)
            });
        }
        let projectless = current
            .get("projectless")
            .cloned()
            .unwrap_or_else(|| json!([]));
        let _ = write_threads(assignments, projectless);
    }
    Ok(json!({ "path": project_path }))
}

pub fn add_project_root(project_path: &str, extra_path: &str) -> Result<Value, String> {
    let extra = fs::canonicalize(extra_path).map_err(|_| "源文件夹不存在".to_string())?;
    let extra_s = display_path(&extra);
    let mut projects = read_projects();
    let index = find_index(&projects, project_path).ok_or_else(|| "找不到这个项目".to_string())?;
    if let Some(project) = projects.get_mut(index) {
        let mut roots = project_roots(project);
        if !roots.iter().any(|root| same_path(root, &extra_s)) {
            roots.push(extra_s);
        }
        project
            .as_object_mut()
            .unwrap()
            .insert("rootPaths".into(), json!(roots));
    }
    let saved = projects
        .get(index)
        .cloned()
        .and_then(|value| to_project(&value))
        .unwrap_or_else(|| json!({}));
    write_projects(&projects)?;
    Ok(saved)
}

pub fn set_project_roots(
    project_path: &str,
    project_name: &str,
    root_paths: Vec<String>,
) -> Result<Value, String> {
    if root_paths.is_empty() {
        return Err("至少需要一个源文件夹".into());
    }
    let mut projects = read_projects();
    let index = find_index(&projects, project_path).ok_or_else(|| "找不到这个项目".to_string())?;
    if let Some(project) = projects.get_mut(index) {
        let first = root_paths[0].clone();
        let object = project.as_object_mut().unwrap();
        object.insert("path".into(), json!(first));
        object.insert("rootPaths".into(), json!(root_paths));
        if !project_name.trim().is_empty() {
            object.insert("name".into(), json!(project_name.trim()));
        }
    }
    let saved = projects
        .get(index)
        .cloned()
        .and_then(|value| to_project(&value))
        .unwrap_or_else(|| json!({}));
    write_projects(&projects)?;
    Ok(saved)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn infers_project_from_cwd_and_origin() {
        let projects = vec![json!({
            "id": "proj-1",
            "name": "server",
            "path": r"D:\go_workspace\src\git.gem.io\lab\server",
            "rootPaths": [r"D:\go_workspace\src\git.gem.io\lab\server"],
            "gitOrigin": "ssh://git@git.gem.io:20022/lab/server.git",
        })];
        let by_cwd = infer_project_from_cwd(
            r"D:\go_workspace\src\git.gem.io\lab\server",
            None,
            &projects,
        )
        .unwrap();
        assert_eq!(by_cwd["id"], "proj-1");
        let by_origin = infer_project_from_cwd(
            "",
            Some("ssh://git@git.gem.io:20022/lab/server.git"),
            &projects,
        )
        .unwrap();
        assert_eq!(by_origin["id"], "proj-1");
    }

    #[test]
    fn attach_project_ids_writes_inferred_assignment() {
        let projects = vec![json!({
            "id": "proj-1",
            "path": r"D:\go_workspace\src\git.gem.io\lab\server",
            "rootPaths": [r"D:\go_workspace\src\git.gem.io\lab\server"],
        })];
        let mut assignments = json!({});
        let projectless = Vec::new();
        let mut changed = false;
        let item = attach_one_thread(
            json!({
                "id": "thread-1",
                "cwd": r"D:\go_workspace\src\git.gem.io\lab\server",
                "projectId": null
            }),
            &projects,
            &mut assignments,
            &projectless,
            &mut changed,
        );
        assert_eq!(item["projectId"], "proj-1");
        assert!(changed);
        assert_eq!(assignments["thread-1"]["projectId"], "proj-1");
    }
}
