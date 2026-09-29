use crate::config;
use crate::editors;
use crate::projects;
use crate::workspace;
use crate::{automations, git, githost, hooks, mcp, plugins, preview, runtime, skills};
use crate::githost::HostKind;
use crate::AppState;
use base64::Engine as _;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_notification::NotificationExt;

pub(crate) struct OverlayGuard {
    app: AppHandle,
}

impl OverlayGuard {
    pub(crate) fn new(app: &AppHandle) -> Self {
        crate::browser::set_overlay(app, true);
        Self { app: app.clone() }
    }
}

impl Drop for OverlayGuard {
    fn drop(&mut self) {
        crate::browser::set_overlay(&self.app, false);
    }
}

#[tauri::command]
pub async fn host_call(
    app: AppHandle,
    state: State<'_, AppState>,
    method: String,
    payload: Option<Value>,
) -> Result<Value, String> {
    let payload = payload.unwrap_or_else(|| json!({}));
    dispatch(app, state, &method, payload).await
}

async fn dispatch(
    app: AppHandle,
    state: State<'_, AppState>,
    method: &str,
    payload: Value,
) -> Result<Value, String> {
    if method.starts_with("gitlab.") {
        return githost::dispatch(HostKind::Gitlab, method, &payload);
    }
    if method.starts_with("github.") {
        return githost::dispatch(HostKind::Github, method, &payload);
    }
    if method.starts_with("browser.") {
        return crate::browser::dispatch(&app, method, &payload);
    }
    match method {
        "app.quit" => {
            crate::tray::QUITTING.store(true, std::sync::atomic::Ordering::SeqCst);
            app.exit(0);
            Ok(json!(true))
        }
        "app.info" => Ok(json!({
            "name": "Local Codex",
            "version": env!("CARGO_PKG_VERSION"),
        })),
        "app.windowAction" => window_action(&app, str_field(&payload, "action")),
        "app.isFocused" => {
            let focused = app
                .get_webview_window("main")
                .and_then(|window| window.is_focused().ok())
                .unwrap_or(false);
            Ok(json!(focused))
        }
        "app.openExternalUrl" => open_external(str_field(&payload, "url")),
        "app.fetchImage" => fetch_image(str_field(&payload, "url")),
        "app.openLicenses" => open_licenses(),
        "voice.listen" => listen_voice(&payload).await,
        "app.checkUpdates" => Ok(check_updates(&app)),
        "app.downloadUpdate" => crate::updates::begin_download(
            str_field(&payload, "url").to_string(),
            str_field(&payload, "version").to_string(),
            {
                let app = app.clone();
                move |payload| {
                    if payload.get("phase").and_then(Value::as_str).is_some_and(|phase| phase == "ready" || phase == "error") {
                        crate::tray::show_window(&app);
                    }
                    let _ = app.emit("updates://download", payload);
                }
            },
        ),
        "app.installUpdate" => {
            let path = crate::updates::launch_downloaded(&str_field(&payload, "version"))?;
            let app_for_exit = app.clone();
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_millis(500));
                crate::tray::QUITTING.store(true, std::sync::atomic::Ordering::SeqCst);
                app_for_exit.exit(0);
            });
            Ok(json!({ "ok": true, "path": path }))
        }
        "app.notify" => native_notify(&app, &payload),
        "debug.uiProbe" => {
            config::log_event(&format!("ui probe {payload}"));
            Ok(json!(true))
        }
        "config.read" => config_read(&state).await,
        "config.providerPresets" => Ok(config::provider_presets_json()),
        "config.importOfficialCodex" => {
            let apply = payload
                .get("apply")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let path = str_field(&payload, "path");
            config::import_official_codex(
                if path.is_empty() {
                    None
                } else {
                    Some(Path::new(path))
                },
                apply,
            )
        }
        "config.pickOfficialCodex" => pick_official_codex(&app).await,
        "config.openFile" => {
            let home = config::engine_home();
            config::ensure_config(&home)?;
            let file = home.join("config.toml");
            if !file.exists() {
                return Err("config.toml 不存在".into());
            }
            open_path(&file)?;
            Ok(json!(file.display().to_string()))
        }
        "preferences.read" => Ok(config::read_preferences()),
        "preferences.write" => {
            let key = str_field(&payload, "key");
            if key.is_empty() {
                return Err("偏好键不能为空".into());
            }
            let value = payload.get("value").cloned().unwrap_or(Value::Null);
            let saved = config::write_preference(key, value)?;
            let _ = app.emit("preferences://changed", saved.clone());
            if key == "background_images_directory" {
                if let Some(directory) = saved.get(key).and_then(Value::as_str) {
                    allow_asset_dir(&app, Path::new(directory));
                }
            }
            if key.starts_with("gitlab_") || key.starts_with("github_") {
                mcp::write_contexts();
            }
            if key == "plugins_enabled" || key == "disabled_builtin_skills" {
                runtime::sync_skill_roots(&state.engine).await;
            }
            if key == "hooks_enabled" {
                runtime::sync_hooks(&state.engine).await;
            }
            if matches!(
                key,
                "browser_engine" | "browser_enabled" | "web_search_enabled" | "computer_enabled"
            ) {
                mcp::ensure_defaults(&state.engine).await;
            }
            Ok(saved)
        }
        "secrets.read" => {
            let name = str_field(&payload, "name");
            let value = config::resolve_secret(name).unwrap_or_default();
            if value.is_empty() {
                Ok(json!({ "configured": false }))
            } else {
                Ok(json!({ "configured": true, "value": value }))
            }
        }
        "secrets.write" => {
            let name = str_field(&payload, "name");
            let value = str_field(&payload, "value");
            config::store_named_secret(name, value)?;
            if name.starts_with("GITLAB_") || name.starts_with("GITHUB_") {
                mcp::write_contexts();
            }
            if config::is_engine_api_key(name) {
                state.engine.restart().await;
            }
            Ok(json!(true))
        }
        "workspace.open" => pick_workspace_folder(&app, &payload, true).await,
        "workspace.pick" => pick_workspace_folder(&app, &payload, false).await,
        "workspace.setRoot" => {
            let root = str_field(&payload, "root");
            let saved = set_workspace_root(root)?;
            allow_asset_dir(&app, Path::new(&saved));
            mcp::write_contexts();
            Ok(json!({ "root": saved }))
        }
        "workspace.clearRoot" => {
            config::set_workspace(Some(String::new()))?;
            mcp::write_contexts();
            Ok(json!({ "root": "" }))
        }
        "workspace.openRoot" => {
            let root = config::workspace_root();
            open_path(&root)?;
            Ok(json!({ "ok": true, "output": root.display().to_string() }))
        }
        "workspace.openInEditor" => open_in_editor(&payload),
        "workspace.reveal" | "workspace.revealInFolder" => {
            let raw = str_field(&payload, "target");
            let raw = if raw.is_empty() {
                str_field(&payload, "filePath")
            } else {
                raw
            };
            let target = PathBuf::from(raw);
            reveal_in_folder(&target)?;
            Ok(json!({ "ok": true, "output": target.display().to_string(), "path": target.display().to_string() }))
        }
        "workspace.tree" => workspace_tree(&payload),
        "workspace.searchFiles" => workspace_search(&payload),
        "workspace.readFile" => workspace_read(&payload),
        "workspace.describeFile" => {
            let root = workspace_root_from(&payload);
            let file = PathBuf::from(str_field(&payload, "filePath"));
            workspace::describe_file(&root, &file)
        }
        "workspace.writeFile" => {
            let root = workspace_root_from(&payload);
            let file = PathBuf::from(str_field(&payload, "filePath"));
            let content = payload
                .get("content")
                .and_then(Value::as_str)
                .unwrap_or("");
            let path = workspace::write_text_file(&root, &file, content)?;
            Ok(json!({ "path": workspace::display_path(&path), "content": content }))
        }
        "workspace.createEntry" => {
            let root = workspace_root_from(&payload);
            let parent = PathBuf::from(str_field(&payload, "parent"));
            let name = str_field(&payload, "name");
            let kind = str_field(&payload, "type");
            let path = workspace::create_entry(&root, &parent, name, kind)?;
            Ok(json!({
                "path": workspace::display_path(&path),
                "relativePath": workspace::relative_to(&root, &path),
                "type": if kind == "directory" { "directory" } else { "file" },
            }))
        }
        "workspace.renameEntry" => {
            let root = workspace_root_from(&payload);
            let file = PathBuf::from(str_field(&payload, "filePath"));
            let name = str_field(&payload, "name");
            let path = workspace::rename_entry(&root, &file, name)?;
            Ok(json!({
                "path": workspace::display_path(&path),
                "relativePath": workspace::relative_to(&root, &path),
            }))
        }
        "workspace.deleteEntry" => {
            let root = workspace_root_from(&payload);
            let file = PathBuf::from(str_field(&payload, "filePath"));
            let path = workspace::delete_entry(&root, &file)?;
            Ok(json!({ "path": workspace::display_path(&path) }))
        }
        "workspace.copyEntry" => {
            let root = workspace_root_from(&payload);
            let source = PathBuf::from(str_field(&payload, "source"));
            let destination = PathBuf::from(str_field(&payload, "destination"));
            let path = workspace::copy_entry(&root, &source, &destination)?;
            Ok(json!({
                "path": workspace::display_path(&path),
                "relativePath": workspace::relative_to(&root, &path),
            }))
        }
        "workspace.moveEntry" => {
            let root = workspace_root_from(&payload);
            let source = PathBuf::from(str_field(&payload, "source"));
            let destination = PathBuf::from(str_field(&payload, "destination"));
            let path = workspace::move_entry(&root, &source, &destination)?;
            Ok(json!({
                "path": workspace::display_path(&path),
                "relativePath": workspace::relative_to(&root, &path),
            }))
        }
        "workspace.openExternal" => open_with_app(&payload),
        "clipboard.write" => write_clipboard(str_field(&payload, "text")),
        "backgroundImages.chooseDirectory" => choose_background_dir(&app, &payload).await,
        "backgroundImages.list" => list_background_images(&app, str_field(&payload, "directory")),
        "backgroundImages.read" => read_background_image(
            &app,
            str_field(&payload, "filePath"),
            str_field(&payload, "directory"),
        ),
        "git.listRepos" => Ok(git::list_repos()),
        "git.status" => in_repo(&payload, git::status),
        "git.snapshot" => in_repo(&payload, git::snapshot),
        "git.remotes" => in_repo(&payload, git::remotes_payload),
        "git.diff" => in_repo(&payload, git::diff),
        "git.suggestCommit" => in_repo(&payload, git::suggest_commit),
        "git.restoreFile" => in_repo(&payload, || git::restore_file(str_field(&payload, "filePath"))),
        "git.rejectHunk" => in_repo(&payload, || git::reject_hunk(str_field(&payload, "patch"))),
        "git.commit" => in_repo(&payload, || {
            git::commit(
                str_field(&payload, "message"),
                payload.get("all").and_then(Value::as_bool).unwrap_or(true),
                payload.get("amend").and_then(Value::as_bool).unwrap_or(false),
                payload.get("signoff").and_then(Value::as_bool).unwrap_or(false),
                payload.get("sign").and_then(Value::as_bool).unwrap_or(false),
            )
        }),
        "git.undoCommit" => in_repo(&payload, git::undo_commit),
        "git.abortRebase" => in_repo(&payload, git::abort_rebase),
        "git.stageAll" => in_repo(&payload, git::stage_all),
        "git.unstageAll" => in_repo(&payload, git::unstage_all),
        "git.discardAll" => in_repo(&payload, git::discard_all),
        "git.push" => in_repo(&payload, git::push),
        "git.pushTo" => in_repo(&payload, || {
            git::push_to(
                &str_field(&payload, "remote"),
                payload.get("setUpstream").and_then(Value::as_bool).unwrap_or(false),
            )
        }),
        "git.fetch" => in_repo(&payload, || {
            git::fetch(
                &str_field(&payload, "remote"),
                payload.get("all").and_then(Value::as_bool).unwrap_or(false),
                payload.get("prune").and_then(Value::as_bool).unwrap_or(false),
            )
        }),
        "git.pull" => in_repo(&payload, || {
            git::pull(
                &str_field(&payload, "remote"),
                payload.get("rebase").and_then(Value::as_bool).unwrap_or(false),
            )
        }),
        "git.init" => in_repo(&payload, git::init_repo),
        "git.addRemote" => in_repo(&payload, || {
            git::add_remote(&str_field(&payload, "name"), &str_field(&payload, "url"))
        }),
        "git.removeRemote" => in_repo(&payload, || git::remove_remote(&str_field(&payload, "name"))),
        "git.setRemoteUrl" => in_repo(&payload, || {
            git::set_remote_url(&str_field(&payload, "name"), &str_field(&payload, "url"))
        }),
        "git.branches" => in_repo(&payload, git::branches_payload),
        "git.checkout" => in_repo(&payload, || git::checkout(&str_field(&payload, "name"))),
        "git.stash" => in_repo(&payload, || {
            git::stash(
                &str_field(&payload, "message"),
                payload.get("includeUntracked").and_then(Value::as_bool).unwrap_or(false),
                payload.get("staged").and_then(Value::as_bool).unwrap_or(false),
            )
        }),
        "git.stashPop" => in_repo(&payload, || git::stash_pop_ref(&str_field(&payload, "target"))),
        "git.stashApply" => in_repo(&payload, || git::stash_apply(&str_field(&payload, "target"))),
        "git.stashDrop" => in_repo(&payload, || git::stash_drop(&str_field(&payload, "target"))),
        "git.stashClear" => in_repo(&payload, git::stash_clear),
        "git.stashShow" => in_repo(&payload, || git::stash_show(&str_field(&payload, "target"))),
        "git.stashList" => in_repo(&payload, git::stash_list),
        "git.merge" => in_repo(&payload, || git::merge_branch(&str_field(&payload, "name"))),
        "git.rebase" => in_repo(&payload, || git::rebase_onto(&str_field(&payload, "name"))),
        "git.renameBranch" => in_repo(&payload, || git::rename_branch(&str_field(&payload, "name"))),
        "git.deleteRemoteBranch" => in_repo(&payload, || {
            git::delete_remote_ref(&str_field(&payload, "remote"), &str_field(&payload, "name"))
        }),
        "git.publishBranch" => in_repo(&payload, || git::publish_branch(&str_field(&payload, "remote"))),
        "git.pushTags" => in_repo(&payload, || git::push_tags(&str_field(&payload, "remote"))),
        "git.deleteRemoteTag" => in_repo(&payload, || {
            git::delete_remote_tag(&str_field(&payload, "remote"), &str_field(&payload, "name"))
        }),
        "git.deleteBranch" => in_repo(&payload, || {
            git::delete_branch(
                &str_field(&payload, "name"),
                payload.get("force").and_then(Value::as_bool).unwrap_or(false),
            )
        }),
        "git.tags" => in_repo(&payload, git::tags_payload),
        "git.createTag" => in_repo(&payload, || {
            git::create_tag(&str_field(&payload, "name"), &str_field(&payload, "message"))
        }),
        "git.deleteTag" => in_repo(&payload, || git::delete_tag(&str_field(&payload, "name"))),
        "git.clone" => Ok(git::clone_into(
            &str_field(&payload, "url"),
            &str_field(&payload, "parentDir"),
            &str_field(&payload, "folderName"),
            payload.get("shallow").and_then(Value::as_bool).unwrap_or(false),
        )),
        "git.applyPatch" => in_repo(&payload, || git::apply_patch(&str_field(&payload, "patch"))),
        "git.createPatch" => in_repo(&payload, || git::create_patch(&str_field(&payload, "kind"))),
        "git.graph" => in_repo(&payload, || {
            git::graph(
                payload.get("limit").and_then(Value::as_u64).unwrap_or(300),
                payload.get("remotes").and_then(Value::as_bool).unwrap_or(true),
                str_field(&payload, "ref"),
            )
        }),
        "git.showCommit" => in_repo(&payload, || git::show_commit(str_field(&payload, "sha"))),
        "git.listPath" => in_repo(&payload, || {
            git::list_path(
                &str_field(&payload, "path"),
                payload.get("withCommit").and_then(Value::as_bool).unwrap_or(true),
            )
        }),
        "git.createBranch" => in_repo(&payload, || {
            git::create_branch_from(
                str_field(&payload, "name"),
                str_field(&payload, "start"),
                payload.get("checkout").and_then(Value::as_bool).unwrap_or(true),
            )
        }),
        "git.worktrees" => in_repo(&payload, git::worktrees),
        "git.createWorktree" => in_repo(&payload, || git::create_worktree(str_field(&payload, "branch"))),
        "git.removeWorktree" => in_repo(&payload, || git::remove_worktree(str_field(&payload, "worktreePath"))),
        "codex.projects" => Ok(json!(projects::list_projects())),
        "codex.threadMetadata" => Ok(projects::thread_metadata()),
        "codex.assignThread" => projects::assign_thread(
            str_field(&payload, "threadId"),
            payload.get("assignment").cloned(),
        ),
        "codex.forgetThread" => projects::forget_thread(str_field(&payload, "threadId")),
        "codex.inheritThread" => projects::inherit_assignment(
            str_field(&payload, "fromThreadId"),
            str_field(&payload, "toThreadId"),
        ),
        "codex.registerProject" => projects::register_project(
            str_field(&payload, "projectPath"),
            str_field(&payload, "projectName"),
        ),
        "codex.updateProject" => projects::update_project(
            str_field(&payload, "oldPath"),
            str_field(&payload, "projectName"),
            str_field(&payload, "newPath"),
        ),
        "codex.deleteProject" => projects::delete_project(str_field(&payload, "projectPath")),
        "codex.addProjectRoot" => projects::add_project_root(
            str_field(&payload, "projectPath"),
            str_field(&payload, "extraPath"),
        ),
        "codex.setProjectRoots" => {
            let roots = payload
                .get("rootPaths")
                .and_then(Value::as_array)
                .map(|items| {
                    items
                        .iter()
                        .filter_map(Value::as_str)
                        .map(str::to_string)
                        .collect()
                })
                .unwrap_or_default();
            projects::set_project_roots(
                str_field(&payload, "projectPath"),
                str_field(&payload, "projectName"),
                roots,
            )
        }
        "codex.plugins" => Ok(json!(plugins::list_plugins())),
        "codex.installPlugin" => install_plugin(&app, &state).await,
        "codex.uninstallPlugin" => {
            let result = plugins::uninstall(str_field(&payload, "pluginPath"))?;
            runtime::sync_skill_roots(&state.engine).await;
            Ok(result)
        }
        "codex.setPluginsEnabled" => {
            let enabled = payload.get("enabled").and_then(Value::as_bool).unwrap_or(true);
            config::write_preference("plugins_enabled", json!(enabled))?;
            runtime::sync_skill_roots(&state.engine).await;
            Ok(json!(enabled))
        }
        "skills.builtin" => Ok(skills::list_builtin()),
        "skills.read" => skills::read_skill(str_field(&payload, "id")),
        "skills.setEnabled" => {
            let id = str_field(&payload, "id").to_string();
            let enabled = payload.get("enabled").and_then(Value::as_bool).unwrap_or(true);
            let result = skills::set_enabled(&id, enabled)?;
            runtime::sync_skill_roots(&state.engine).await;
            if id == "web-search" {
                config::write_preference("web_search_enabled", json!(enabled))?;
                mcp::ensure_defaults(&state.engine).await;
            }
            let _ = state
                .engine
                .request(
                    "skills/config/write",
                    json!({ "name": id, "enabled": enabled }),
                )
                .await;
            Ok(result)
        }
        "skills.open" => skills::open_skill(str_field(&payload, "id")),
        "automations.list" => automations::list(),
        "automations.upsert" => automations::upsert(&payload),
        "automations.remove" => automations::remove(str_field(&payload, "id")),
        "automations.run" => run_automation(&app, &state, str_field(&payload, "id"), "manual").await,
        "hooks.list" => Ok(hooks::list_files()),
        "hooks.add" => hooks::add(&payload),
        "hooks.remove" => hooks::remove(&payload),
        "integrations.status" => Ok(mcp::integration_status()),
        "integrations.clearBrowserData" => mcp::clear_browser_data(&app, &state.engine).await,
        "diagnostics.read" => diagnostics(&state).await,
        "help.copyDiagnostics" => {
            let info = diagnostics(&state).await?;
            Ok(json!(format_diagnostics(&info)))
        }
        "help.openLog" => {
            let path = config::engine_log_path();
            if !path.exists() {
                return Ok(json!({
                    "ok": false,
                    "output": "还没有日志文件",
                    "path": path.display().to_string(),
                }));
            }
            open_path(&path)?;
            Ok(json!({ "ok": true, "output": path.display().to_string(), "path": path.display().to_string() }))
        }
        "attachments.save" => save_attachment(&app, &payload),
        "attachments.readImage" => read_image_data_url(&app, str_field(&payload, "filePath")),
        "attachments.openImage" => open_attachment_image(str_field(&payload, "filePath")),
        "export.save" => save_export(&app, &payload).await,
        "import.open" => open_import(&app).await,
        "terminal.start" => {
            state
                .terminals
                .start(
                    app,
                    payload
                        .get("cwd")
                        .and_then(Value::as_str)
                        .map(str::to_string),
                    payload
                        .get("shell")
                        .and_then(Value::as_str)
                        .map(str::to_string),
                    payload.get("cols").and_then(Value::as_u64).map(|value| value as u16),
                    payload.get("rows").and_then(Value::as_u64).map(|value| value as u16),
                )
                .await
        }
        "terminal.write" => {
            let ok = state
                .terminals
                .write(str_field(&payload, "id"), str_field(&payload, "data"))
                .await?;
            Ok(json!(ok))
        }
        "terminal.resize" => {
            let ok = state
                .terminals
                .resize(
                    str_field(&payload, "id"),
                    payload.get("cols").and_then(Value::as_u64).unwrap_or(120) as u16,
                    payload.get("rows").and_then(Value::as_u64).unwrap_or(30) as u16,
                )
                .await?;
            Ok(json!(ok))
        }
        "terminal.terminate" => {
            let ok = state.terminals.terminate(str_field(&payload, "id")).await?;
            Ok(json!(ok))
        }
        other => Err(format!("未知宿主方法: {other}")),
    }
}

fn str_field<'a>(payload: &'a Value, key: &str) -> &'a str {
    payload.get(key).and_then(Value::as_str).unwrap_or("")
}

fn in_repo(payload: &Value, task: impl FnOnce() -> Value) -> Result<Value, String> {
    Ok(git::with_cwd(git::resolve_repo(&str_field(payload, "cwd")), task))
}

fn set_workspace_root(root: &str) -> Result<String, String> {
    let target = PathBuf::from(root.trim());
    if target.as_os_str().is_empty() {
        return Err("项目目录不存在".into());
    }
    let target = fs::canonicalize(&target).map_err(|_| "项目目录不存在".to_string())?;
    if !target.is_dir() {
        return Err("项目目录不存在".into());
    }
    let current = config::workspace_root();
    if workspace::same_path(&current, &target) {
        return config::set_workspace(Some(workspace::display_path(&target)));
    }
    let configured = projects::list_projects().iter().any(|project| {
        let mut paths = Vec::new();
        if let Some(list) = project.get("rootPaths").and_then(Value::as_array) {
            for item in list {
                if let Some(path) = item.as_str() {
                    paths.push(PathBuf::from(path));
                }
            }
        }
        if let Some(path) = project.get("path").and_then(Value::as_str) {
            paths.push(PathBuf::from(path));
        }
        paths.iter().any(|path| workspace::same_path(path, &target))
    });
    let projectless = config::projectless_workspace_root();
    let is_projectless = workspace::same_path(&projectless, &target);
    let (ok, output) = git::run_in(&current, &["worktree", "list", "--porcelain"]);
    let known_worktree = ok
        && output.lines().filter_map(|line| line.strip_prefix("worktree ")).any(|path| {
            workspace::same_path(&PathBuf::from(path), &target)
        });
    if !configured && !is_projectless && !known_worktree {
        return Err("只能切换到已配置的本地项目、无项目任务文件夹或 Git 工作树".into());
    }
    config::set_workspace(Some(workspace::display_path(&target)))
}

fn check_updates(app: &AppHandle) -> Value {
    let result = crate::updates::check_and_store();
    let _ = app.emit("updates://status", result.clone());
    result
}

pub async fn maybe_startup_update_check(app: AppHandle) {
    let prefs = config::read_preferences();
    if prefs.get("auto_check_updates").and_then(Value::as_bool) == Some(false) {
        return;
    }
    let result = crate::updates::check_and_store();
    let _ = app.emit("updates://status", result);
}

fn workspace_root_from(payload: &Value) -> PathBuf {
    payload
        .get("root")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(config::workspace_root)
}

fn workspace_tree(payload: &Value) -> Result<Value, String> {
    let root = workspace_root_from(payload);
    let depth = payload.get("depth").and_then(Value::as_u64).unwrap_or(0) as u32;
    let (resolved, entries) = workspace::list_tree_v1(&root, depth)?;
    Ok(json!({
        "root": resolved.display().to_string(),
        "entries": entries,
    }))
}

fn workspace_search(payload: &Value) -> Result<Value, String> {
    let root = workspace_root_from(payload);
    let query = str_field(payload, "query");
    let limit = payload
        .get("limit")
        .and_then(Value::as_u64)
        .unwrap_or(200)
        .min(500) as usize;
    let entries = workspace::search_files(&root, query, limit)?;
    Ok(json!({
        "root": root.display().to_string(),
        "entries": entries,
    }))
}

fn workspace_read(payload: &Value) -> Result<Value, String> {
    let root = workspace_root_from(payload);
    let file = PathBuf::from(str_field(payload, "filePath"));
    let resolved = workspace::resolve_inside(&root, &file)?;
    if !resolved.is_file() {
        return Err("目标不是文件".into());
    }
    let ext = resolved
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_lowercase();
    if matches!(
        ext.as_str(),
        "docx" | "xlsx" | "csv" | "pptx" | "pdf" | "ipynb"
    ) {
        let meta = fs::metadata(&resolved).map_err(|err| err.to_string())?;
        if meta.len() > 8 * 1024 * 1024 {
            return Err("文件超过 8MB，暂不支持预览".into());
        }
        return preview::read_structured(&resolved);
    }
    let content = workspace::read_text_file(&root, &file)?;
    Ok(json!({
        "path": content.path,
        "content": content.text,
    }))
}

async fn pick_workspace_folder(
    app: &AppHandle,
    payload: &Value,
    register: bool,
) -> Result<Value, String> {
    crate::tray::show_window(app);
    let _cover = OverlayGuard::new(app);
    let title = str_field(payload, "title");
    let title = if title.is_empty() { "选择工作区" } else { title };
    let (tx, rx) = tokio::sync::oneshot::channel();
    let mut picker = app.dialog().file().set_title(title);
    let default_path = payload
        .get("defaultPath")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty());
    if let Some(path) = default_path {
        picker = picker.set_directory(path);
    } else {
        picker = picker.set_directory(config::workspace_root());
    }
    picker.pick_folder(move |folder| {
        let _ = tx.send(folder);
    });
    let Some(folder) = rx.await.map_err(|err| err.to_string())? else {
        return Ok(json!({
            "canceled": true,
            "root": if register {
                config::workspace_root().display().to_string()
            } else {
                String::new()
            },
        }));
    };
    let path = folder
        .into_path()
        .map_err(|err| err.to_string())?
        .display()
        .to_string();
    allow_asset_dir(app, Path::new(&path));
    if register {
        config::set_workspace(Some(path.clone()))?;
        let name = Path::new(&path)
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_else(|| path.clone());
        let _ = projects::register_project(&path, &name);
        mcp::write_contexts();
    }
    Ok(json!({ "canceled": false, "root": path }))
}

async fn choose_background_dir(app: &AppHandle, payload: &Value) -> Result<Value, String> {
    crate::tray::show_window(app);
    let _cover = OverlayGuard::new(app);
    let (tx, rx) = tokio::sync::oneshot::channel();
    let current = str_field(payload, "directory");
    let mut picker = app.dialog().file().set_title("选择背景图片目录");
    if !current.is_empty() && Path::new(current).is_dir() {
        picker = picker.set_directory(current);
    } else if let Some(pictures) = dirs::picture_dir() {
        picker = picker.set_directory(pictures);
    }
    picker.pick_folder(move |folder| {
        let _ = tx.send(folder);
    });
    let Some(folder) = rx.await.map_err(|err| err.to_string())? else {
        return Ok(json!({
            "canceled": true,
            "directory": str_field(payload, "directory"),
            "images": [],
        }));
    };
    let directory = folder
        .into_path()
        .map_err(|err| err.to_string())?
        .display()
        .to_string();
    let listed = list_background_images(app, &directory)?;
    Ok(json!({
        "canceled": false,
        "directory": listed.get("directory").cloned().unwrap_or(json!(directory)),
        "images": listed.get("images").cloned().unwrap_or(json!([])),
    }))
}

fn list_background_images(app: &AppHandle, directory: &str) -> Result<Value, String> {
    if directory.trim().is_empty() {
        return Ok(json!({ "directory": directory, "images": [] }));
    }
    let root = PathBuf::from(directory);
    allow_asset_dir(app, &root);
    let mut images = Vec::new();
    if let Ok(entries) = fs::read_dir(&root) {
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_file() {
                continue;
            }
            let ext = path
                .extension()
                .and_then(|value| value.to_str())
                .unwrap_or("")
                .to_lowercase();
            if !["png", "jpg", "jpeg", "gif", "webp", "bmp"].contains(&ext.as_str()) {
                continue;
            }
            let name = path
                .file_name()
                .map(|value| value.to_string_lossy().into_owned())
                .unwrap_or_default();
            images.push(json!({
                "path": display_path(&path),
                "name": name,
                "relativePath": name,
            }));
        }
    }
    images.sort_by(|left, right| {
        left.get("name")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .cmp(right.get("name").and_then(Value::as_str).unwrap_or_default())
    });
    Ok(json!({ "directory": display_path(&root), "images": images }))
}

fn read_background_image(
    app: &AppHandle,
    file_path: &str,
    directory: &str,
) -> Result<Value, String> {
    let root = PathBuf::from(directory);
    let file = PathBuf::from(file_path);
    let resolved = resolve_in_directory(&root, &file)?;
    allow_asset_dir(app, &root);
    allow_asset_file(app, &resolved);
    Ok(json!({
        "path": display_path(&resolved),
    }))
}

fn image_mime(path: &Path) -> Option<&'static str> {
    match path
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

fn read_image_data_url(app: &AppHandle, file_path: &str) -> Result<Value, String> {
    let path = workspace::normalize_user_path(file_path);
    let mime = image_mime(&path).ok_or_else(|| "仅支持读取图片附件".to_string())?;
    let meta = fs::metadata(&path).map_err(|err| err.to_string())?;
    if !meta.is_file() {
        return Err("图片附件不是文件".into());
    }
    if meta.len() > 10 * 1024 * 1024 {
        return Err("图片附件超过 10MB".into());
    }
    allow_asset_file(app, &path);
    Ok(json!({
        "path": display_path(&path),
        "mime": mime,
    }))
}

fn resolve_in_directory(root: &Path, target: &Path) -> Result<PathBuf, String> {
    if root.as_os_str().is_empty() {
        return Err("未选择背景图片目录".into());
    }
    let cleaned = workspace::normalize_user_path(&target.to_string_lossy());
    let resolved = if cleaned.is_absolute() {
        fs::canonicalize(&cleaned).unwrap_or(cleaned)
    } else {
        let base = fs::canonicalize(root).map_err(|err| err.to_string())?;
        fs::canonicalize(base.join(&cleaned)).map_err(|err| err.to_string())?
    };
    if !resolved.is_file() {
        return Err("背景图片不是文件".into());
    }
    let root_canon = fs::canonicalize(root).unwrap_or_else(|_| root.to_path_buf());
    if !workspace::is_inside(&root_canon, &resolved) && !workspace::is_inside(root, &resolved) {
        return Err("路径超出所选目录".into());
    }
    Ok(resolved)
}

fn display_path(path: &Path) -> String {
    let text = path.display().to_string();
    text.strip_prefix(r"\\?\").unwrap_or(&text).to_string()
}

fn allow_asset_dir(app: &AppHandle, directory: &Path) {
    if directory.as_os_str().is_empty() {
        return;
    }
    let _ = app.asset_protocol_scope().allow_directory(directory, true);
    if let Ok(canon) = fs::canonicalize(directory) {
        let _ = app.asset_protocol_scope().allow_directory(&canon, true);
        let stripped = PathBuf::from(display_path(&canon));
        if stripped != canon && stripped != directory {
            let _ = app.asset_protocol_scope().allow_directory(&stripped, true);
        }
    }
}

fn allow_asset_file(app: &AppHandle, file: &Path) {
    if file.as_os_str().is_empty() {
        return;
    }
    let _ = app.asset_protocol_scope().allow_file(file);
    if let Some(parent) = file.parent() {
        allow_asset_dir(app, parent);
    }
    if let Ok(canon) = fs::canonicalize(file) {
        let _ = app.asset_protocol_scope().allow_file(&canon);
        if let Some(parent) = canon.parent() {
            allow_asset_dir(app, parent);
        }
        let stripped = PathBuf::from(display_path(&canon));
        if stripped != canon {
            let _ = app.asset_protocol_scope().allow_file(&stripped);
        }
    }
}

pub fn grant_asset_scopes(app: &AppHandle) {
    allow_asset_dir(app, &config::attachments_root());
    allow_asset_dir(app, &config::workspace_root());
    allow_asset_dir(app, &config::projectless_workspace_root());
    if let Some(home) = dirs::home_dir() {
        allow_asset_dir(app, &home);
    }
    if let Some(pictures) = dirs::picture_dir() {
        allow_asset_dir(app, &pictures);
    }
    if let Some(desktop) = dirs::desktop_dir() {
        allow_asset_dir(app, &desktop);
    }
    if let Some(documents) = dirs::document_dir() {
        allow_asset_dir(app, &documents);
    }
    if let Some(downloads) = dirs::download_dir() {
        allow_asset_dir(app, &downloads);
    }
    if let Some(directory) = config::read_preferences()
        .get("background_images_directory")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
    {
        allow_asset_dir(app, Path::new(directory));
    }
}

fn open_attachment_image(file_path: &str) -> Result<Value, String> {
    let file = PathBuf::from(file_path);
    let ext = file
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_lowercase();
    if !matches!(ext.as_str(), "png" | "jpg" | "jpeg" | "gif" | "webp" | "bmp") {
        return Ok(json!({ "ok": false, "output": "仅支持打开图片附件" }));
    }
    if !file.is_file() {
        return Ok(json!({ "ok": false, "output": "图片附件不是文件" }));
    }
    open_path(&file)?;
    Ok(json!({ "ok": true, "output": file.display().to_string() }))
}

fn save_attachment(app: &AppHandle, payload: &Value) -> Result<Value, String> {
    let name = str_field(payload, "name");
    let safe = name
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | '-') {
                ch
            } else {
                '_'
            }
        })
        .collect::<String>();
    let safe = if safe.is_empty() {
        "file".to_string()
    } else {
        safe
    };
    let root = payload
        .get("root")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(config::attachments_root);
    fs::create_dir_all(&root).map_err(|err| err.to_string())?;
    let dest = root.join(format!("{}-{safe}", timestamp_ms()));
    let bytes = if let Some(items) = payload.get("bytes").and_then(Value::as_array) {
        items
            .iter()
            .filter_map(Value::as_u64)
            .map(|value| value as u8)
            .collect()
    } else if let Some(items) = payload.get("data").and_then(Value::as_array) {
        items
            .iter()
            .filter_map(Value::as_u64)
            .map(|value| value as u8)
            .collect()
    } else if let Some(encoded) = payload.get("data").and_then(Value::as_str) {
        base64::engine::general_purpose::STANDARD
            .decode(encoded.trim())
            .unwrap_or_default()
    } else {
        Vec::new()
    };
    fs::write(&dest, bytes).map_err(|err| err.to_string())?;
    allow_asset_file(app, &dest);
    Ok(json!(dest.display().to_string()))
}

async fn save_export(app: &AppHandle, payload: &Value) -> Result<Value, String> {
    crate::tray::show_window(app);
    let _cover = OverlayGuard::new(app);
    let default_name = str_field(payload, "defaultName");
    let content = payload
        .get("content")
        .and_then(Value::as_str)
        .unwrap_or("");
    let (tx, rx) = tokio::sync::oneshot::channel();
    let mut dialog = app
        .dialog()
        .file()
        .set_title("导出")
        .add_filter("JSON", &["json"]);
    if !default_name.is_empty() {
        dialog = dialog.set_file_name(default_name);
    }
    dialog.save_file(move |file| {
        let _ = tx.send(file);
    });
    let Some(file) = rx.await.map_err(|err| err.to_string())? else {
        return Ok(json!({ "canceled": true }));
    };
    let path = file.into_path().map_err(|err| err.to_string())?;
    fs::write(&path, content).map_err(|err| err.to_string())?;
    Ok(json!({ "canceled": false, "path": path.display().to_string() }))
}

async fn pick_official_codex(app: &AppHandle) -> Result<Value, String> {
    crate::tray::show_window(app);
    let _cover = OverlayGuard::new(app);
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .set_title("选择官方 Codex config.toml")
        .add_filter("Codex 配置", &["toml"])
        .pick_file(move |file| {
            let _ = tx.send(file);
        });
    let Some(file) = rx.await.map_err(|err| err.to_string())? else {
        return Ok(json!({ "canceled": true }));
    };
    let path = file.into_path().map_err(|err| err.to_string())?;
    if !path.is_file() {
        return Err("选择的不是文件".into());
    }
    Ok(json!({
        "canceled": false,
        "path": path.display().to_string(),
    }))
}

async fn open_import(app: &AppHandle) -> Result<Value, String> {
    crate::tray::show_window(app);
    let _cover = OverlayGuard::new(app);
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .set_title("导入本地线程")
        .add_filter("线程文件", &["json", "txt", "md"])
        .pick_file(move |file| {
            let _ = tx.send(file);
        });
    let Some(file) = rx.await.map_err(|err| err.to_string())? else {
        return Ok(json!({ "canceled": true }));
    };
    let path = file.into_path().map_err(|err| err.to_string())?;
    let meta = fs::metadata(&path).map_err(|err| err.to_string())?;
    if !meta.is_file() {
        return Err("导入目标不是文件".into());
    }
    if meta.len() > 10 * 1024 * 1024 {
        return Err("导入文件超过 10MB".into());
    }
    let content = fs::read_to_string(&path).map_err(|err| err.to_string())?;
    Ok(json!({
        "canceled": false,
        "path": path.display().to_string(),
        "content": content,
    }))
}

async fn config_read(state: &State<'_, AppState>) -> Result<Value, String> {
    let status = state.engine.status().await;
    let home = config::engine_home();
    let workspace = config::workspace_root();
    let policy = config::engine_policy();
    let model = config::read_model_config();
    Ok(json!({
        "appRoot": config::app_root().display().to_string(),
        "engineHome": home.display().to_string(),
        "codexHome": home.display().to_string(),
        "mock": config::mock_active(),
        "state": map_state(&status.state),
        "message": status.message,
        "workspaceRoot": workspace.display().to_string(),
        "projectlessWorkspaceRoot": config::projectless_workspace_root().display().to_string(),
        "attachmentRoot": config::attachments_root().display().to_string(),
        "deepseekApiKeyConfigured": status.api_key_configured,
        "approval_policy": policy.get("approval_policy").cloned().unwrap_or(json!("on-request")),
        "sandbox_mode": policy.get("sandbox_mode").cloned().unwrap_or(json!("workspace-write")),
        "sandbox_workspace_write": policy.get("sandbox_workspace_write").cloned().unwrap_or(json!({ "network_access": true })),
        "model": model.get("model").cloned().unwrap_or(json!(config::default_model())),
        "model_provider": model.get("model_provider").cloned().unwrap_or(json!("deepseek")),
        "model_providers": model.get("model_providers").cloned().unwrap_or(json!({})),
    }))
}

async fn diagnostics(state: &State<'_, AppState>) -> Result<Value, String> {
    let status = state.engine.status().await;
    let home = config::engine_home();
    let workspace = config::workspace_root();
    let config_path = home.join("config.toml");
    let platform = if cfg!(windows) {
        format!(
            "win32/{}",
            if cfg!(target_arch = "x86_64") {
                "x64"
            } else {
                std::env::consts::ARCH
            }
        )
    } else {
        format!("{}/{}", std::env::consts::OS, std::env::consts::ARCH)
    };
    Ok(json!({
        "name": "Local Codex",
        "cwd": workspace.display().to_string(),
        "appRoot": config::app_root().display().to_string(),
        "engineHome": home.display().to_string(),
        "codexHome": home.display().to_string(),
        "state": map_state(&status.state),
        "message": status.message,
        "version": env!("CARGO_PKG_VERSION"),
        "platform": platform,
        "configExists": config_path.exists(),
        "serverCommand": status.binary,
        "mock": config::mock_active(),
        "workspaceWritable": config::path_writable(&workspace),
        "codexHomeWritable": config::path_writable(&home),
        "logFile": config::engine_log_path().display().to_string(),
        "provider": config::inspect_provider(&home),
        "networkBoundary": "仅允许当前非 OpenAI Provider；阻止 api.openai.com 和 chatgpt.com 配置",
        "activeTerminals": state.terminals.count().await,
        "versions": {
            "tauri": "2",
            "electron": "",
            "node": crate::mcp::find_node()
                .map(|path| path.display().to_string())
                .unwrap_or_default(),
            "webview2": "WebView2",
        },
    }))
}

fn format_diagnostics(info: &Value) -> String {
    let message = info
        .get("message")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(|value| format!("（{value}）"))
        .unwrap_or_default();
    let lines = [
        format!(
            "应用：Local Codex {}",
            info.get("version").and_then(Value::as_str).unwrap_or("")
        ),
        format!(
            "状态：{}{}",
            info.get("state").and_then(Value::as_str).unwrap_or("unknown"),
            message
        ),
        format!(
            "平台：{}",
            info.get("platform").and_then(Value::as_str).unwrap_or("")
        ),
        format!(
            "工作区：{}",
            info.get("cwd").and_then(Value::as_str).unwrap_or("")
        ),
        format!(
            "应用数据：{}",
            info.get("appRoot").and_then(Value::as_str).unwrap_or("")
        ),
        format!(
            "引擎运行时：{}",
            info.get("engineHome")
                .or_else(|| info.get("codexHome"))
                .and_then(Value::as_str)
                .unwrap_or("")
        ),
        format!(
            "配置文件：{}",
            if info.get("configExists").and_then(Value::as_bool).unwrap_or(false) {
                "存在"
            } else {
                "缺失"
            }
        ),
        format!(
            "Provider：{}{}",
            info.pointer("/provider/provider")
                .and_then(Value::as_str)
                .unwrap_or("未设置"),
            if info
                .pointer("/provider/blocked")
                .and_then(Value::as_bool)
                .unwrap_or(false)
            {
                "（已被拦截）"
            } else {
                ""
            }
        ),
        format!(
            "工作区可写：{}",
            if info.get("workspaceWritable").and_then(Value::as_bool).unwrap_or(false) {
                "是"
            } else {
                "否"
            }
        ),
        format!(
            "引擎目录可写：{}",
            if info.get("codexHomeWritable").and_then(Value::as_bool).unwrap_or(false) {
                "是"
            } else {
                "否"
            }
        ),
        format!(
            "网络边界：{}",
            info.get("networkBoundary").and_then(Value::as_str).unwrap_or("")
        ),
        format!(
            "终端数：{}",
            info.get("activeTerminals").and_then(Value::as_u64).unwrap_or(0)
        ),
        format!(
            "日志：{}",
            info.get("logFile").and_then(Value::as_str).unwrap_or("")
        ),
        format!(
            "运行时：Tauri {} / Node {}",
            info.pointer("/versions/tauri")
                .and_then(Value::as_str)
                .unwrap_or("2"),
            info.pointer("/versions/node")
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty())
                .unwrap_or("未找到")
        ),
    ];
    format!("{}\n", lines.join("\n"))
}

fn map_state(state: &str) -> &str {
    match state {
        "starting" => "connecting",
        other => other,
    }
}

fn window_action(app: &AppHandle, action: &str) -> Result<Value, String> {
    let Some(window) = app.get_webview_window("main") else {
        return Ok(json!(false));
    };
    match action {
        "new-window" => {
            crate::tray::show_window(app);
        }
        "minimize" => window.minimize().map_err(|err| err.to_string())?,
        "maximize" => {
            if window.is_maximized().unwrap_or(false) {
                window.unmaximize().map_err(|err| err.to_string())?;
            } else {
                window.maximize().map_err(|err| err.to_string())?;
            }
        }
        "close" => {
            window.hide().map_err(|err| err.to_string())?;
            crate::browser::hide_if_open(app);
        }
        "quit" => {
            crate::tray::QUITTING.store(true, std::sync::atomic::Ordering::SeqCst);
            app.exit(0);
        }
        "fullscreen" => {
            let full = window.is_fullscreen().unwrap_or(false);
            window.set_fullscreen(!full).map_err(|err| err.to_string())?;
        }
        "task-manager" => {
            window.open_devtools();
        }
        "devtools" => {
            if window.is_devtools_open() {
                window.close_devtools();
            } else {
                window.open_devtools();
            }
        }
        _ => return Ok(json!(false)),
    }
    Ok(json!(true))
}

fn open_external(url: &str) -> Result<Value, String> {
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return Ok(json!({ "ok": false, "output": "只允许打开 HTTP/HTTPS 地址" }));
    }
    open::that(url).map_err(|err| err.to_string())?;
    Ok(json!({ "ok": true, "output": url }))
}

fn fetch_image(url: &str) -> Result<Value, String> {
    let href = url.trim();
    let target = url::Url::parse(href).map_err(|_| "图片地址无效".to_string())?;
    if target.scheme() != "http" && target.scheme() != "https" {
        return Err("只允许加载 HTTP/HTTPS 图片".into());
    }
    if is_blocked_image_host(target.host_str().unwrap_or("")) {
        return Err("不允许加载本地图片地址".into());
    }
    {
        let cache = image_cache();
        if let Ok(guard) = cache.lock() {
            if let Some(cached) = guard.get(href) {
                return Ok(json!({ "dataUrl": cached }));
            }
        }
    }
    let response = ureq::get(target.as_str())
        .set(
            "Accept",
            "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
        )
        .set("User-Agent", "Local-Codex")
        .call()
        .map_err(|err| err.to_string())?;
    if response.status() >= 400 {
        return Err(format!("图片加载失败 ({})", response.status()));
    }
    let header_mime = response.content_type().to_string();
    let mut bytes = Vec::new();
    response
        .into_reader()
        .take(5 * 1024 * 1024 + 1)
        .read_to_end(&mut bytes)
        .map_err(|err| err.to_string())?;
    if bytes.len() > 5 * 1024 * 1024 {
        return Err("图片过大".into());
    }
    let mime = sniff_image_mime(&header_mime, href, &bytes);
    if mime.is_empty() {
        return Err("不是图片".into());
    }
    let encoded = base64::engine::general_purpose::STANDARD.encode(&bytes);
    let data_url = format!("data:{mime};base64,{encoded}");
    if let Ok(mut guard) = image_cache().lock() {
        guard.insert(href.to_string(), data_url.clone());
    }
    Ok(json!({ "dataUrl": data_url }))
}

fn image_cache() -> &'static Mutex<HashMap<String, String>> {
    static CACHE: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn is_blocked_image_host(hostname: &str) -> bool {
    let host = hostname.trim().trim_end_matches('.').to_ascii_lowercase();
    if host.is_empty()
        || host == "localhost"
        || host.ends_with(".localhost")
        || host == "127.0.0.1"
        || host == "0.0.0.0"
        || host == "::1"
        || host == "[::1]"
        || host == "169.254.169.254"
        || host.ends_with(".internal")
        || host.ends_with(".local")
    {
        return true;
    }
    if host.starts_with("10.") || host.starts_with("192.168.") || host.starts_with("169.254.") {
        return true;
    }
    if let Some(rest) = host.strip_prefix("172.") {
        if let Some(second) = rest.split('.').next() {
            if let Ok(octet) = second.parse::<u8>() {
                return (16..=31).contains(&octet);
            }
        }
    }
    false
}

fn sniff_image_mime(content_type: &str, url: &str, buffer: &[u8]) -> String {
    let type_name = content_type
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    if type_name.starts_with("image/") {
        return type_name;
    }
    let head = String::from_utf8_lossy(&buffer[..buffer.len().min(256)])
        .trim_start()
        .to_ascii_lowercase();
    if head.starts_with("<svg") || head.starts_with("<?xml") {
        return "image/svg+xml".into();
    }
    if buffer.len() >= 2 && buffer[0] == 0x89 && buffer[1] == 0x50 {
        return "image/png".into();
    }
    if buffer.len() >= 2 && buffer[0] == 0xff && buffer[1] == 0xd8 {
        return "image/jpeg".into();
    }
    if buffer.len() >= 2 && buffer[0] == 0x47 && buffer[1] == 0x49 {
        return "image/gif".into();
    }
    if buffer.len() >= 12 && buffer[0] == 0x52 && buffer[1] == 0x49 && buffer[8] == 0x57 {
        return "image/webp".into();
    }
    if url.to_ascii_lowercase().contains(".svg") {
        return "image/svg+xml".into();
    }
    String::new()
}

fn open_licenses() -> Result<Value, String> {
    let candidates = [
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..").join("LICENSE"),
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("LICENSE"),
        std::env::current_exe()
            .ok()
            .and_then(|exe| exe.parent().map(|dir| dir.join("LICENSE")))
            .unwrap_or_default(),
        std::env::current_exe()
            .ok()
            .and_then(|exe| exe.parent().map(|dir| dir.join("resources").join("LICENSE")))
            .unwrap_or_default(),
        config::app_root().join("LICENSE.txt"),
    ];
    if let Some(path) = candidates.into_iter().find(|path| path.is_file()) {
        open_path(&path)?;
        return Ok(json!(path.display().to_string()));
    }
    let fallback = config::app_root().join("LICENSE.txt");
    if let Some(parent) = fallback.parent() {
        let _ = fs::create_dir_all(parent);
    }
    fs::write(
        &fallback,
        "Local Codex\n\nThis application bundles Codex app-server, Chromium/WebView2, and other open-source components. Source licenses are retained in the repository and vendor directories.\n",
    )
    .map_err(|err| err.to_string())?;
    open_path(&fallback)?;
    Ok(json!(fallback.display().to_string()))
}

async fn listen_voice(payload: &Value) -> Result<Value, String> {
    let locale = payload
        .get("locale")
        .and_then(Value::as_str)
        .unwrap_or("zh-CN")
        .chars()
        .filter(|ch| ch.is_ascii_alphanumeric() || *ch == '-')
        .collect::<String>();
    let locale = if locale.is_empty() { "zh-CN".into() } else { locale };
    let script = format!(
        r#"
Add-Type -AssemblyName System.Speech
$culture = $null
try {{ $culture = [System.Globalization.CultureInfo]::GetCultureInfo('{locale}') }} catch {{}}
$engine = if ($culture) {{ New-Object System.Speech.Recognition.SpeechRecognitionEngine $culture }} else {{ New-Object System.Speech.Recognition.SpeechRecognitionEngine }}
try {{
  $engine.SetInputToDefaultAudioDevice()
  $engine.LoadGrammar((New-Object System.Speech.Recognition.DictationGrammar))
  $engine.InitialSilenceTimeout = [TimeSpan]::FromSeconds(4)
  $engine.BabbleTimeout = [TimeSpan]::FromSeconds(2)
  $engine.EndSilenceTimeout = [TimeSpan]::FromSeconds(0.8)
  $result = $engine.Recognize([TimeSpan]::FromSeconds(8))
  if ($result -and $result.Text) {{ [Console]::Out.Write($result.Text) }}
}} finally {{
  if ($engine) {{ $engine.Dispose() }}
}}
"#
    );
    let encoded = {
        let mut bytes = Vec::new();
        for unit in script.encode_utf16() {
            bytes.extend_from_slice(&unit.to_le_bytes());
        }
        base64::engine::general_purpose::STANDARD.encode(bytes)
    };
    let output = tokio::task::spawn_blocking(move || {
        let mut command = std::process::Command::new("powershell.exe");
        command.args([
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-Sta",
            "-ExecutionPolicy",
            "Bypass",
            "-EncodedCommand",
            &encoded,
        ]);
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x0800_0000);
        }
        command.output()
    })
    .await
    .map_err(|err| err.to_string())?
    .map_err(|err| format!("无法启动语音识别：{err}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if stderr.is_empty() {
            "语音识别失败，请检查麦克风和系统语音包".into()
        } else {
            stderr
        });
    }
    let text = String::from_utf8_lossy(&output.stdout).trim().to_string();
    Ok(json!({ "text": text }))
}

fn open_path(path: &Path) -> Result<(), String> {
    open::that(path).map_err(|err| err.to_string())
}

fn reveal_in_folder(path: &Path) -> Result<(), String> {
    #[cfg(windows)]
    {
        let mut command = std::process::Command::new("explorer");
        command.arg(format!("/select,{}", path.display()));
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000);
        command.spawn().map_err(|err| err.to_string())?;
        return Ok(());
    }
    #[cfg(not(windows))]
    {
        let parent = path.parent().unwrap_or(path);
        open_path(parent)
    }
}

fn running_automations() -> &'static Mutex<HashSet<String>> {
    static SLOT: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    SLOT.get_or_init(|| Mutex::new(HashSet::new()))
}

async fn install_plugin(app: &AppHandle, state: &State<'_, AppState>) -> Result<Value, String> {
    crate::tray::show_window(app);
    let _cover = OverlayGuard::new(app);
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .set_title("选择要安装的本地插件目录")
        .pick_folder(move |folder| {
            let _ = tx.send(folder);
        });
    let Some(folder) = rx.await.map_err(|err| err.to_string())? else {
        return Ok(json!({ "canceled": true }));
    };
    let path = folder.into_path().map_err(|err| err.to_string())?;
    let result = plugins::install(&path)?;
    runtime::sync_skill_roots(&state.engine).await;
    Ok(result)
}

async fn run_automation(
    app: &AppHandle,
    state: &State<'_, AppState>,
    id: &str,
    reason: &str,
) -> Result<Value, String> {
    if id.trim().is_empty() {
        return Err("自动化无效".into());
    }
    {
        let mut running = running_automations().lock().map_err(|err| err.to_string())?;
        if running.contains(id) {
            return Ok(json!({ "skipped": true, "reason": "running" }));
        }
        running.insert(id.to_string());
    }
    let result = run_automation_inner(app, state, id, reason).await;
    if let Ok(mut running) = running_automations().lock() {
        running.remove(id);
    }
    result
}

async fn run_automation_inner(
    app: &AppHandle,
    state: &State<'_, AppState>,
    id: &str,
    reason: &str,
) -> Result<Value, String> {
    let item = automations::get(id)?;
    let cwd = item
        .get("cwd")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty() && Path::new(value).exists())
        .map(str::to_string)
        .unwrap_or_else(|| config::workspace_root().display().to_string());
    let prompt = item
        .get("prompt")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let name = item
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or("自动化")
        .to_string();
    let started = state
        .engine
        .request("thread/start", json!({ "cwd": cwd }))
        .await
        .map_err(|err| err.message)?;
    let thread_id = started
        .pointer("/thread/id")
        .or_else(|| started.get("id"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    if thread_id.is_empty() {
        let _ = automations::mark_run(id, None, Some("无法创建自动化线程"));
        return Err("无法创建自动化线程".into());
    }
    let _ = state
        .engine
        .request(
            "thread/name/set",
            json!({ "threadId": thread_id, "name": name }),
        )
        .await;
    if let Err(err) = state
        .engine
        .request(
            "turn/start",
            json!({
                "threadId": thread_id,
                "input": [{ "type": "text", "text": prompt, "text_elements": [] }],
                "cwd": cwd
            }),
        )
        .await
    {
        let _ = automations::mark_run(id, Some(&thread_id), Some(&err.message));
        return Err(err.message);
    }
    let _ = automations::mark_run(id, Some(&thread_id), None);
    let _ = native_notify(
        app,
        &json!({
            "title": "Local Codex",
            "body": format!("自动化「{name}」已开始"),
        }),
    );
    let _ = app.emit(
        "automations://ran",
        json!({ "id": id, "threadId": thread_id, "name": name, "reason": reason }),
    );
    Ok(json!({ "threadId": thread_id }))
}

pub async fn tick_automations(app: AppHandle) {
    let state = app.state::<AppState>();
    let status = state.engine.status().await;
    if status.state != "connected" {
        return;
    }
    let Ok(items) = automations::due_items() else {
        return;
    };
    for item in items {
        let id = item
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        if id.is_empty() {
            continue;
        }
        if let Err(err) = run_automation(&app, &state, &id, "schedule").await {
            tracing::warn!("automation {id} failed: {err}");
            config::log_event(&format!("automation {id} failed: {err}"));
        }
    }
}

fn open_with_app(payload: &Value) -> Result<Value, String> {
    let root = workspace_root_from(payload);
    let file = PathBuf::from(str_field(payload, "filePath"));
    let resolved = match workspace::resolve_inside(&root, &file) {
        Ok(path) => path,
        Err(_) if file.exists() => file.clone(),
        Err(err) => return Err(err),
    };
    let application = str_field(payload, "application");
    if application.is_empty() || application == "系统默认" {
        open_path(&resolved)?;
        return Ok(json!({ "ok": true, "output": resolved.display().to_string() }));
    }
    match editors::open_with_editor(application, &resolved, &root) {
        Ok(_) => Ok(json!({ "ok": true, "output": resolved.display().to_string() })),
        Err(err) => Ok(json!({ "ok": false, "output": err })),
    }
}

fn open_in_editor(payload: &Value) -> Result<Value, String> {
    let raw = str_field(payload, "root");
    let target = if raw.is_empty() {
        config::workspace_root()
    } else {
        PathBuf::from(raw)
    };
    if !target.exists() {
        return Ok(json!({ "ok": false, "output": "工作区不存在" }));
    }
    let application = {
        let value = str_field(payload, "application");
        if value.is_empty() {
            "VS Code"
        } else {
            value
        }
    };
    match editors::open_with_editor(application, &target, &target) {
        Ok(_) => Ok(json!({ "ok": true, "output": target.display().to_string() })),
        Err(err) => Ok(json!({ "ok": false, "output": err })),
    }
}

fn write_clipboard(text: &str) -> Result<Value, String> {
    arboard::Clipboard::new()
        .and_then(|mut clipboard| clipboard.set_text(text))
        .map_err(|err| err.to_string())?;
    Ok(json!(true))
}

fn native_notify(app: &AppHandle, payload: &Value) -> Result<Value, String> {
    let title = payload
        .get("title")
        .and_then(Value::as_str)
        .unwrap_or("Local Codex")
        .to_string();
    let body = payload
        .get("body")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let handle = app.clone();
    let _ = app
        .notification()
        .builder()
        .title(&title)
        .body(&body)
        .show();
    std::thread::spawn(move || {
        let mut notification = notify_rust::Notification::new();
        notification.summary(&title).body(&body);
        #[cfg(windows)]
        {
            if let Ok(exe) = std::env::current_exe() {
                if let Some(dir) = exe.parent() {
                    let current = dir.display().to_string();
                    if !(current.contains(r"\target\debug") || current.contains(r"\target\release"))
                    {
                        notification.app_id("com.wzd24.localcodex");
                    }
                }
            }
        }
        if let Ok(shown) = notification.show() {
            let _ = shown.wait_for_response(|response: &notify_rust::NotificationResponse| {
                if !matches!(response, notify_rust::NotificationResponse::Closed(_)) {
                    crate::tray::show_window(&handle);
                }
            });
        }
    });
    Ok(json!(true))
}

fn timestamp_ms() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|value| value.as_millis())
        .unwrap_or(0)
}
