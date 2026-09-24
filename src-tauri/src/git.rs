use crate::config;
use crate::workspace;
use serde_json::{json, Value};
use std::cell::RefCell;
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

thread_local! {
    static REPO_CWD: RefCell<Option<PathBuf>> = const { RefCell::new(None) };
}

fn cwd() -> PathBuf {
    REPO_CWD
        .with(|slot| slot.borrow().clone())
        .unwrap_or_else(config::workspace_root)
}

pub fn with_cwd<T>(dir: PathBuf, task: impl FnOnce() -> T) -> T {
    REPO_CWD.with(|slot| *slot.borrow_mut() = Some(dir));
    let result = task();
    REPO_CWD.with(|slot| *slot.borrow_mut() = None);
    result
}

pub fn resolve_repo(requested: &str) -> PathBuf {
    let workspace = config::workspace_root();
    let raw = requested.trim();
    if raw.is_empty() {
        return workspace;
    }
    let target = PathBuf::from(raw);
    if let Ok(resolved) = workspace::resolve_inside(&workspace, &target) {
        if resolved.is_dir() {
            return resolved;
        }
    }
    workspace
}

fn is_git_repo(dir: &Path) -> bool {
    let git = dir.join(".git");
    git.is_dir() || git.is_file()
}

const REPO_SKIP: &[&str] = &[
    ".git",
    "node_modules",
    "target",
    "dist",
    ".next",
    "vendor",
    ".venv",
    "venv",
];

pub fn list_repos() -> Value {
    let root = config::workspace_root();
    let mut items = Vec::new();
    if root.is_dir() {
        collect_repos(&root, &root, 0, 6, &mut items);
    }
    items.sort_by(|left, right| {
        let left_path = left.get("relativePath").and_then(Value::as_str).unwrap_or("");
        let right_path = right.get("relativePath").and_then(Value::as_str).unwrap_or("");
        left_path.cmp(right_path)
    });
    json!({
        "ok": true,
        "items": items,
        "workspaceRoot": workspace::display_path(&root),
    })
}

fn collect_repos(root: &Path, current: &Path, depth: u32, max_depth: u32, out: &mut Vec<Value>) {
    if out.len() >= 40 {
        return;
    }
    if is_git_repo(current) {
        out.push(repo_summary(root, current));
    }
    if depth >= max_depth {
        return;
    }
    let Ok(read) = fs::read_dir(current) else {
        return;
    };
    for entry in read.flatten() {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if REPO_SKIP.iter().any(|skip| skip.eq_ignore_ascii_case(&name)) {
            continue;
        }
        if entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false) {
            collect_repos(root, &entry.path(), depth + 1, max_depth, out);
        }
    }
}

fn repo_summary(workspace: &Path, dir: &Path) -> Value {
    let name = dir
        .file_name()
        .map(|value| value.to_string_lossy().into_owned())
        .unwrap_or_else(|| dir.display().to_string());
    let relative = dir
        .strip_prefix(workspace)
        .map(|path| path.to_string_lossy().replace('\\', "/"))
        .unwrap_or_default();
    let path = workspace::display_path(dir);
    let inside = run_in(dir, &["rev-parse", "--is-inside-work-tree"]);
    if !inside.0 {
        return json!({
            "path": path,
            "name": name,
            "relativePath": relative,
            "branch": "",
            "upstream": "",
            "ahead": 0,
            "behind": 0,
            "changes": 0,
            "dirty": false,
        });
    }
    let status = run_in(dir, &["status", "--porcelain=v1", "--branch"]);
    let mut lines = status.1.lines();
    let header = lines.next().unwrap_or("");
    let (mut branch, upstream, ahead, behind) = parse_status_header(header);
    if branch.is_empty() {
        branch = current_branch(dir);
    }
    let changes = lines.filter(|line| !line.is_empty()).count();
    json!({
        "path": path,
        "name": name,
        "relativePath": relative,
        "branch": branch,
        "upstream": upstream,
        "ahead": ahead,
        "behind": behind,
        "changes": changes,
        "dirty": changes > 0,
    })
}

fn hide(command: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000);
    }
}

pub fn run(args: &[&str]) -> (bool, String) {
    run_in(&cwd(), args)
}

pub fn run_in(dir: &Path, args: &[&str]) -> (bool, String) {
    match run_output(dir, args) {
        Ok(output) => {
            let stdout = String::from_utf8_lossy(&output.stdout).to_string();
            let stderr = String::from_utf8_lossy(&output.stderr).to_string();
            let text = if stdout.trim().is_empty() {
                stderr
            } else {
                stdout
            };
            (output.status.success(), text.trim().to_string())
        }
        Err(err) => (false, err),
    }
}

fn run_output(dir: &Path, args: &[&str]) -> Result<std::process::Output, String> {
    let mut command = Command::new("git");
    command.args(args).current_dir(dir);
    hide(&mut command);
    command.output().map_err(|err| err.to_string())
}

pub fn show_file(dir: &Path, reference: &str, path: &str) -> Option<Vec<u8>> {
    let relative = path.replace('\\', "/");
    let spec = format!(
        "{}:{relative}",
        if reference.trim().is_empty() {
            "HEAD"
        } else {
            reference.trim()
        }
    );
    if let Ok(output) = run_output(dir, &["show", spec.as_str()]) {
        if output.status.success() && !output.stdout.is_empty() {
            return Some(output.stdout);
        }
    }
    let local = dir.join(path);
    if local.is_file() {
        return fs::read(local).ok();
    }
    None
}

fn ok_output(ok: bool, output: impl Into<String>) -> Value {
    json!({ "ok": ok, "output": output.into() })
}

pub fn status() -> Value {
    let (ok, output) = run(&["status", "--short", "--branch"]);
    ok_output(ok, output)
}

pub fn diff() -> Value {
    let root = cwd();
    if !root.is_dir() {
        return ok_output(false, "工作区目录不存在");
    }
    let inside = run_in(&root, &["rev-parse", "--is-inside-work-tree"]);
    if !inside.0 {
        return ok_output(
            false,
            if inside.1.trim().is_empty() {
                "当前目录不是 Git 仓库".into()
            } else {
                inside.1
            },
        );
    }
    let head = run_in(&root, &["rev-parse", "--verify", "HEAD"]);
    let mut diff = if head.0 {
        let (ok, output) = run_in(&root, &["diff", "HEAD", "--", "."]);
        if !ok && !output.trim_start().starts_with("diff ") {
            return ok_output(false, output);
        }
        output
    } else {
        let staged = run_in(&root, &["diff", "--cached", "--", "."]).1;
        let unstaged = run_in(&root, &["diff", "--", "."]).1;
        if staged.is_empty() {
            unstaged
        } else if unstaged.is_empty() {
            staged
        } else {
            format!("{staged}\n{unstaged}")
        }
    };
    let status = run_in(&root, &["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
    if !status.0 {
        return ok_output(false, status.1);
    }
    let mut extras = Vec::new();
    for record in status.1.split('\0') {
        if let Some(relative) = record.strip_prefix("?? ") {
            if let Some(synthetic) = untracked_diff(&root, relative) {
                extras.push(synthetic);
            }
        }
    }
    if !extras.is_empty() {
        if !diff.trim().is_empty() {
            diff.push('\n');
        }
        diff.push_str(&extras.join("\n"));
    }
    json!({ "ok": true, "output": diff.trim() })
}

fn read_preview(path: &Path, limit: usize) -> Option<(Vec<u8>, bool)> {
    let mut file = fs::File::open(path).ok()?;
    let meta = file.metadata().ok()?;
    if !meta.is_file() {
        return None;
    }
    let truncated = meta.len() as u64 > limit as u64;
    let mut buf = Vec::new();
    let _ = Read::take(&mut file, limit as u64 + 1).read_to_end(&mut buf);
    if buf.len() > limit {
        buf.truncate(limit);
    }
    Some((buf, truncated))
}

fn untracked_diff(root: &Path, relative: &str) -> Option<String> {
    let target = root.join(relative);
    if !crate::workspace::is_inside(root, &target) {
        return None;
    }
    let (bytes, truncated) = read_preview(&target, 256 * 1024)?;
    let normalized = relative.replace('\\', "/");
    let header = format!(
        "diff --git a/{normalized} b/{normalized}\nnew file mode 100644\n--- /dev/null\n+++ b/{normalized}\n"
    );
    if bytes.contains(&0) {
        return Some(format!("{header}@@ -0,0 +1,1 @@\n+[二进制文件，无法在此处预览]\n"));
    }
    let mut content = String::from_utf8_lossy(&bytes).replace("\r\n", "\n");
    if truncated {
        if !content.ends_with('\n') {
            content.push('\n');
        }
        content.push_str("[文件过大，仅显示前 256 KB]\n");
    }
    let mut lines: Vec<&str> = content.split('\n').collect();
    if lines.last() == Some(&"") {
        lines.pop();
    }
    let hunk = format!(
        "@@ -0,0 +1,{} @@\n{}",
        lines.len(),
        lines
            .iter()
            .map(|line| format!("+{line}"))
            .collect::<Vec<_>>()
            .join("\n")
    );
    Some(format!("{header}{hunk}\n"))
}

pub fn restore_file(file_path: &str) -> Value {
    let cleaned = crate::workspace::normalize_user_path(file_path);
    let target = if cleaned.is_absolute() {
        cleaned
    } else {
        cwd().join(cleaned)
    };
    let Some(root) = crate::workspace::owning_root(&target) else {
        return ok_output(false, "只能撤销已配置项目内的文件");
    };
    let relative = pathdiff(&root, &target);
    if relative.starts_with("..") || Path::new(&relative).is_absolute() {
        return ok_output(false, "只能撤销已配置项目内的文件");
    }
    let (ok, output) = run_in(&root, &["restore", "--worktree", "--", &relative]);
    ok_output(ok, output)
}

pub fn reject_hunk(patch: &str) -> Value {
    if patch.is_empty() || patch.len() > 1024 * 1024 {
        return ok_output(false, "Patch 为空或超过 1MB");
    }
    let root = cwd();
    for line in patch.lines() {
        if let Some(rest) = line.strip_prefix("--- ").or_else(|| line.strip_prefix("+++ ")) {
            let path = rest.trim().trim_start_matches("a/").trim_start_matches("b/");
            if path == "/dev/null" {
                continue;
            }
            let relative = pathdiff(&root, &root.join(path));
            if relative.starts_with("..") {
                return ok_output(false, "Patch 包含工作区外路径");
            }
        }
    }
    let mut command = Command::new("git");
    command
        .args(["apply", "-R", "--recount", "--whitespace=nowarn", "-"])
        .current_dir(&root)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    hide(&mut command);
    match command.spawn() {
        Ok(mut child) => {
            if let Some(stdin) = child.stdin.as_mut() {
                let _ = stdin.write_all(patch.as_bytes());
            }
            match child.wait_with_output() {
                Ok(output) => {
                    let text = if output.stdout.is_empty() {
                        String::from_utf8_lossy(&output.stderr).to_string()
                    } else {
                        String::from_utf8_lossy(&output.stdout).to_string()
                    };
                    ok_output(output.status.success(), text.trim())
                }
                Err(err) => ok_output(false, err.to_string()),
            }
        }
        Err(err) => ok_output(false, err.to_string()),
    }
}

pub fn commit(message: &str, all: bool, amend: bool, signoff: bool, sign: bool) -> Value {
    let message = message.trim();
    if message.is_empty() && !amend {
        return ok_output(false, "提交信息不能为空");
    }
    let root = cwd();
    if all {
        let staged = run_in(&root, &["add", "-A"]);
        if !staged.0 {
            return ok_output(false, staged.1);
        }
    }
    let mut args = vec!["commit"];
    if amend {
        args.push("--amend");
        if message.is_empty() {
            args.push("--no-edit");
        }
    }
    if signoff {
        args.push("--signoff");
    }
    if sign {
        args.push("-S");
    }
    if !message.is_empty() {
        args.push("-m");
        args.push(message);
    }
    let (ok, output) = run_in(&root, &args);
    ok_output(ok, output)
}

pub fn undo_commit() -> Value {
    let (ok, output) = run(&["reset", "--soft", "HEAD~1"]);
    ok_output(ok, output)
}

pub fn abort_rebase() -> Value {
    let (ok, output) = run(&["rebase", "--abort"]);
    ok_output(ok, output)
}

pub fn stage_all() -> Value {
    let (ok, output) = run(&["add", "-A"]);
    ok_output(ok, output)
}

pub fn unstage_all() -> Value {
    let (ok, output) = run(&["reset"]);
    ok_output(ok, output)
}

pub fn discard_all() -> Value {
    let (ok, output) = run(&["restore", "--source=HEAD", "--staged", "--worktree", "--", "."]);
    ok_output(ok, output)
}

pub fn merge_branch(name: &str) -> Value {
    let name = name.trim();
    if !valid_branch(name) {
        return ok_output(false, "分支名无效");
    }
    let (ok, output) = run(&["merge", "--", name]);
    ok_output(ok, output)
}

pub fn rebase_onto(name: &str) -> Value {
    let name = name.trim();
    if !valid_branch(name) {
        return ok_output(false, "分支名无效");
    }
    let (ok, output) = run(&["rebase", "--", name]);
    ok_output(ok, output)
}

pub fn rename_branch(name: &str) -> Value {
    let name = name.trim();
    if !valid_branch(name) {
        return ok_output(false, "分支名无效");
    }
    let (ok, output) = run(&["branch", "-m", "--", name]);
    ok_output(ok, output)
}

pub fn create_branch_from(name: &str, start: &str, switch: bool) -> Value {
    let start = start.trim();
    if start.is_empty() {
        return create_branch(name, switch);
    }
    if !valid_branch(name.trim()) || !valid_branch(start) {
        return json!({ "ok": false, "output": "分支名无效", "branch": name.trim() });
    }
    let created = run(&["branch", "--", name.trim(), start]);
    if !created.0 {
        return json!({ "ok": false, "output": created.1, "branch": name.trim() });
    }
    if switch {
        let switched = checkout(name);
        return json!({
            "ok": switched.get("ok").and_then(Value::as_bool).unwrap_or(false),
            "output": switched.get("output").and_then(Value::as_str).unwrap_or(""),
            "branch": name.trim(),
        });
    }
    json!({ "ok": true, "output": created.1, "branch": name.trim() })
}

pub fn delete_remote_ref(remote: &str, name: &str) -> Value {
    let remote = if remote.trim().is_empty() { "origin" } else { remote.trim() };
    let name = name.trim();
    if !valid_remote_name(remote) || name.is_empty() {
        return ok_output(false, "远端或引用无效");
    }
    let spec = if name.starts_with("refs/") {
        name.to_string()
    } else {
        format!("refs/heads/{name}")
    };
    let (ok, output) = run(&["push", remote, "--delete", &spec]);
    ok_output(ok, output)
}

pub fn publish_branch(remote: &str) -> Value {
    push_to(remote, true)
}

pub fn push_tags(remote: &str) -> Value {
    let remote = if remote.trim().is_empty() { "origin" } else { remote.trim() };
    if !valid_remote_name(remote) {
        return ok_output(false, "远端名称无效");
    }
    let (ok, output) = run(&["push", remote, "--tags"]);
    ok_output(ok, output)
}

pub fn delete_remote_tag(remote: &str, name: &str) -> Value {
    let remote = if remote.trim().is_empty() { "origin" } else { remote.trim() };
    let name = name.trim();
    if !valid_remote_name(remote) || !valid_branch(name) {
        return ok_output(false, "远端或标签无效");
    }
    let spec = format!("refs/tags/{name}");
    let (ok, output) = run(&["push", remote, "--delete", &spec]);
    ok_output(ok, output)
}

pub fn push() -> Value {
    let root = cwd();
    let branch = run_in(&root, &["branch", "--show-current"]).1;
    if branch.is_empty() {
        return json!({ "ok": false, "output": "无法读取当前分支", "branch": "" });
    }
    let spec = format!("HEAD:{branch}");
    let (ok, output) = run_in(&root, &["push", "origin", &spec]);
    json!({ "ok": ok, "output": output, "branch": branch })
}

pub fn create_branch(name: &str, checkout: bool) -> Value {
    let branch = name.trim();
    if !valid_branch(branch) {
        return json!({ "ok": false, "output": "分支名无效", "branch": branch });
    }
    let args: Vec<&str> = if checkout {
        vec!["checkout", "-b", branch]
    } else {
        vec!["branch", "--", branch]
    };
    let (ok, output) = run(&args);
    json!({ "ok": ok, "output": output, "branch": branch })
}

pub fn worktrees() -> Value {
    let (ok, output) = run(&["worktree", "list", "--porcelain"]);
    if !ok {
        return json!({ "ok": false, "output": output, "entries": [] });
    }
    let entries: Vec<Value> = output
        .split("\n\n")
        .filter(|block| !block.trim().is_empty())
        .map(|block| {
            let mut path = String::new();
            let mut head = String::new();
            let mut branch = String::new();
            let mut detached = false;
            for line in block.lines() {
                if let Some(value) = line.strip_prefix("worktree ") {
                    path = value.to_string();
                } else if let Some(value) = line.strip_prefix("HEAD ") {
                    head = value.to_string();
                } else if let Some(value) = line.strip_prefix("branch ") {
                    branch = value.trim_start_matches("refs/heads/").to_string();
                } else if line == "detached" {
                    detached = true;
                }
            }
            if detached && branch.is_empty() {
                branch = "detached".into();
            }
            json!({ "path": path, "head": head, "branch": branch })
        })
        .collect();
    json!({ "ok": true, "output": "", "entries": entries })
}

pub fn create_worktree(branch: &str) -> Value {
    let safe = branch.trim();
    if !valid_branch(safe) {
        return json!({ "ok": false, "output": "分支名无效" });
    }
    let root = cwd();
    let parent = root.parent().unwrap_or(&root);
    let folder = safe.replace(['\\', '/'], "-");
    let target = parent.join(".worktrees").join(folder);
    let relative = pathdiff(parent, &target);
    if relative.is_empty() || relative.starts_with("..") || Path::new(&relative).is_absolute() {
        return json!({ "ok": false, "output": "Worktree 路径越界" });
    }
    if let Some(dir) = target.parent() {
        let _ = fs::create_dir_all(dir);
    }
    let target_s = target.display().to_string();
    let (ok, output) = run_in(&root, &["worktree", "add", "-b", safe, &target_s]);
    json!({ "ok": ok, "output": output, "path": target_s })
}

pub fn remove_worktree(worktree_path: &str) -> Value {
    let root = cwd();
    let parent = root.parent().unwrap_or(&root);
    let target = PathBuf::from(worktree_path);
    let relative = pathdiff(parent, &target);
    if relative.is_empty() || relative.starts_with("..") || same_path(&target, &root) {
        return ok_output(false, "不能移除当前工作区或父目录之外的 Worktree");
    }
    let target_s = target.display().to_string();
    let (ok, output) = run_in(&root, &["worktree", "remove", &target_s]);
    ok_output(ok, output)
}

fn valid_branch(name: &str) -> bool {
    !name.is_empty()
        && !name.contains("..")
        && name
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | '/' | '-'))
}

fn pathdiff(root: &Path, target: &Path) -> String {
    let root_n = normalize(root);
    let target_n = normalize(target);
    if target_n == root_n {
        return String::new();
    }
    let prefix = format!("{root_n}{}", std::path::MAIN_SEPARATOR);
    target_n
        .strip_prefix(&prefix)
        .unwrap_or(&target_n)
        .to_string()
}

fn same_path(left: &Path, right: &Path) -> bool {
    normalize(left) == normalize(right)
}

fn normalize(path: &Path) -> String {
    let value = path.display().to_string();
    let trimmed = value.trim_end_matches(['\\', '/']);
    if cfg!(windows) {
        trimmed.to_lowercase()
    } else {
        trimmed.to_string()
    }
}

pub fn current_branch(dir: &Path) -> String {
    run_in(dir, &["rev-parse", "--abbrev-ref", "HEAD"]).1
}

pub fn remotes(dir: &Path) -> Vec<Remote> {
    let output = run_in(dir, &["remote", "-v"]).1;
    let mut seen = std::collections::BTreeSet::new();
    let mut remotes = Vec::new();
    for line in output.lines() {
        let parts: Vec<&str> = line.split_whitespace().collect();
        if parts.len() < 2 {
            continue;
        }
        let name = parts[0].to_string();
        let url = parts[1].to_string();
        let key = format!("{name}:{url}");
        if !seen.insert(key) {
            continue;
        }
        let (host, project_path) = parse_remote(&url).unwrap_or_default();
        remotes.push(Remote {
            name,
            url,
            host,
            project_path,
        });
    }
    remotes.sort_by_key(|item| if item.name == "origin" { 0 } else { 1 });
    remotes
}

pub fn remotes_payload() -> Value {
    let items: Vec<Value> = remotes(&cwd())
        .into_iter()
        .map(|item| {
            json!({
                "name": item.name,
                "url": item.url,
                "host": item.host,
                "projectPath": item.project_path,
            })
        })
        .collect();
    let signature = items
        .iter()
        .filter_map(|item| {
            Some(format!(
                "{}:{}",
                item.get("name")?.as_str()?,
                item.get("url")?.as_str()?
            ))
        })
        .collect::<Vec<_>>()
        .join("|");
    json!({ "items": items, "signature": signature })
}

fn valid_remote_name(name: &str) -> bool {
    !name.is_empty()
        && !name.contains("..")
        && name
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | '-'))
}

fn valid_remote_url(url: &str) -> bool {
    let url = url.trim();
    !url.is_empty()
        && url.len() < 2048
        && !url.contains('\0')
        && !url.contains('\n')
        && !url.contains('\r')
}

fn parse_status_header(header: &str) -> (String, String, u32, u32) {
    let rest = header.trim_start_matches("## ").trim();
    if let Some(branch) = rest.strip_prefix("No commits yet on ") {
        return (branch.trim().to_string(), String::new(), 0, 0);
    }
    if rest.starts_with("HEAD") {
        return ("HEAD".into(), String::new(), 0, 0);
    }
    let (names, trail) = rest.split_once('[').unwrap_or((rest, ""));
    let (branch, upstream) = match names.split_once("...") {
        Some((left, right)) => (left.trim().to_string(), right.trim().to_string()),
        None => (names.trim().to_string(), String::new()),
    };
    let digits = |label: &str| -> u32 {
        trail
            .split(label)
            .nth(1)
            .and_then(|part| {
                part.chars()
                    .take_while(|ch| ch.is_ascii_digit())
                    .collect::<String>()
                    .parse()
                    .ok()
            })
            .unwrap_or(0)
    };
    (branch, upstream, digits("ahead "), digits("behind "))
}

pub fn snapshot() -> Value {
    let root = cwd();
    let inside = run_in(&root, &["rev-parse", "--is-inside-work-tree"]);
    let remotes = remotes_payload();
    if !inside.0 {
        return json!({
            "ok": true,
            "isRepo": false,
            "workspaceRoot": root.display().to_string(),
            "branch": "",
            "upstream": "",
            "ahead": 0,
            "behind": 0,
            "dirty": false,
            "changes": 0,
            "files": [],
            "remotes": remotes.get("items").cloned().unwrap_or(json!([])),
            "rebasing": false,
            "hasCommits": false,
            "reason": if inside.1.trim().is_empty() {
                "当前目录不是 Git 仓库".to_string()
            } else {
                inside.1
            },
        });
    }
    let status = run_in(&root, &["status", "--porcelain=v1", "--branch"]);
    let mut lines = status.1.lines();
    let header = lines.next().unwrap_or("");
    let (mut branch, upstream, ahead, behind) = parse_status_header(header);
    if branch.is_empty() {
        branch = current_branch(&root);
    }
    let files: Vec<Value> = lines
        .filter(|line| !line.is_empty())
        .map(|line| {
            let code = if line.len() >= 2 { &line[..2] } else { line };
            let path = if line.len() > 3 { line[3..].trim() } else { "" };
            json!({ "code": code, "path": path })
        })
        .collect();
    let changes = files.len();
    json!({
        "ok": status.0,
        "isRepo": true,
        "workspaceRoot": root.display().to_string(),
        "branch": branch,
        "upstream": upstream,
        "ahead": ahead,
        "behind": behind,
        "dirty": changes > 0,
        "changes": changes,
        "files": files,
        "remotes": remotes.get("items").cloned().unwrap_or(json!([])),
        "rebasing": rebasing(&root),
        "hasCommits": run_in(&root, &["rev-parse", "--verify", "HEAD"]).0,
        "reason": "",
    })
}

fn rebasing(root: &Path) -> bool {
    let merge = run_in(root, &["rev-parse", "--git-path", "rebase-merge"]);
    let apply = run_in(root, &["rev-parse", "--git-path", "rebase-apply"]);
    [merge.1, apply.1].iter().any(|path| {
        let trimmed = path.trim();
        !trimmed.is_empty() && (root.join(trimmed).exists() || Path::new(trimmed).exists())
    })
}

pub fn init_repo() -> Value {
    let (ok, output) = run(&["init"]);
    ok_output(ok, output)
}

pub fn fetch(remote: &str, all: bool, prune: bool) -> Value {
    let remote = remote.trim();
    if !remote.is_empty() && !valid_remote_name(remote) {
        return ok_output(false, "远端名称无效");
    }
    let mut args = vec!["fetch"];
    if prune {
        args.push("--prune");
    }
    if all || remote.is_empty() {
        args.push("--all");
    } else {
        args.push("--");
        args.push(remote);
    }
    let (ok, output) = run(&args);
    ok_output(ok, output)
}

pub fn pull(remote: &str, rebase: bool) -> Value {
    let remote = remote.trim();
    if !remote.is_empty() && !valid_remote_name(remote) {
        return ok_output(false, "远端名称无效");
    }
    let mut args = vec!["pull"];
    if rebase {
        args.push("--rebase");
    }
    if !remote.is_empty() {
        args.push("--");
        args.push(remote);
    }
    let (ok, output) = run(&args);
    ok_output(ok, output)
}

pub fn push_to(remote: &str, set_upstream: bool) -> Value {
    let remote = if remote.trim().is_empty() {
        "origin"
    } else {
        remote.trim()
    };
    if !valid_remote_name(remote) {
        return json!({ "ok": false, "output": "远端名称无效", "branch": "" });
    }
    let branch = current_branch(&cwd());
    if branch.is_empty() || branch == "HEAD" {
        return json!({ "ok": false, "output": "无法读取当前分支", "branch": branch });
    }
    let spec = format!("HEAD:{branch}");
    let mut args = vec!["push"];
    if set_upstream {
        args.push("-u");
    }
    args.extend(["--", remote, spec.as_str()]);
    let (ok, output) = run(&args);
    json!({ "ok": ok, "output": output, "branch": branch })
}

pub fn add_remote(name: &str, url: &str) -> Value {
    let name = name.trim();
    let url = url.trim();
    if !valid_remote_name(name) {
        return ok_output(false, "远端名称无效");
    }
    if !valid_remote_url(url) {
        return ok_output(false, "远端地址无效");
    }
    let existing = remotes(&cwd());
    if existing.iter().any(|item| item.name == name) {
        return json!({
            "ok": false,
            "exists": true,
            "output": format!("远端 {name} 已存在"),
        });
    }
    let (ok, output) = run(&["remote", "add", name, url]);
    ok_output(ok, output)
}

pub fn remove_remote(name: &str) -> Value {
    let name = name.trim();
    if !valid_remote_name(name) {
        return ok_output(false, "远端名称无效");
    }
    let (ok, output) = run(&["remote", "remove", name]);
    ok_output(ok, output)
}

pub fn set_remote_url(name: &str, url: &str) -> Value {
    let name = name.trim();
    let url = url.trim();
    if !valid_remote_name(name) {
        return ok_output(false, "远端名称无效");
    }
    if !valid_remote_url(url) {
        return ok_output(false, "远端地址无效");
    }
    let (ok, output) = run(&["remote", "set-url", name, url]);
    ok_output(ok, output)
}

pub fn branches_payload() -> Value {
    let output = run(&[
        "for-each-ref",
        "--format=%(refname:short)\t%(objectname:short)\t%(HEAD)\t%(upstream:short)",
        "refs/heads",
    ]);
    if !output.0 && output.1.contains("not a git repository") {
        return json!({ "ok": false, "output": output.1, "items": [] });
    }
    let items: Vec<Value> = output
        .1
        .lines()
        .filter(|line| !line.trim().is_empty())
        .map(|line| {
            let mut parts = line.split('\t');
            let name = parts.next().unwrap_or("").to_string();
            let sha = parts.next().unwrap_or("").to_string();
            let head = parts.next().unwrap_or("");
            let upstream = parts.next().unwrap_or("").to_string();
            json!({
                "name": name,
                "sha": sha,
                "current": head == "*",
                "upstream": upstream,
            })
        })
        .collect();
    json!({ "ok": true, "output": "", "items": items })
}

pub fn checkout(name: &str) -> Value {
    let name = name.trim();
    if !valid_branch(name) {
        return ok_output(false, "分支名无效");
    }
    let (ok, output) = run(&["switch", "--", name]);
    if ok {
        return ok_output(true, output);
    }
    let fallback = run(&["checkout", "--", name]);
    ok_output(fallback.0, fallback.1)
}

pub fn stash(message: &str, include_untracked: bool, staged: bool) -> Value {
    let message = message.trim();
    let mut args = vec!["stash", "push"];
    if include_untracked {
        args.push("-u");
    }
    if staged {
        args.push("--staged");
    }
    if !message.is_empty() {
        args.push("-m");
        args.push(message);
    }
    let (ok, output) = run(&args);
    ok_output(ok, output)
}

pub fn stash_apply(target: &str) -> Value {
    stash_cmd("apply", target)
}

#[allow(dead_code)]
pub fn stash_pop() -> Value {
    stash_cmd("pop", "")
}

pub fn stash_pop_ref(target: &str) -> Value {
    stash_cmd("pop", target)
}

pub fn stash_drop(target: &str) -> Value {
    stash_cmd("drop", target)
}

pub fn stash_clear() -> Value {
    let (ok, output) = run(&["stash", "clear"]);
    ok_output(ok, output)
}

pub fn stash_show(target: &str) -> Value {
    stash_cmd("show", target)
}

fn stash_cmd(action: &str, target: &str) -> Value {
    let target = normalize_stash(target);
    let (ok, output) = if target.is_empty() {
        run(&["stash", action])
    } else {
        run(&["stash", action, &target])
    };
    ok_output(ok, output)
}

fn normalize_stash(raw: &str) -> String {
    let value = raw.trim();
    if value.is_empty() {
        return String::new();
    }
    if value.chars().all(|ch| ch.is_ascii_digit()) {
        return format!("stash@{{{value}}}");
    }
    if value.starts_with("stash@{") {
        return value.to_string();
    }
    value.to_string()
}

pub fn stash_list() -> Value {
    let (ok, output) = run(&["stash", "list"]);
    let items: Vec<Value> = output
        .lines()
        .filter(|line| !line.trim().is_empty())
        .map(|line| json!({ "label": line }))
        .collect();
    json!({ "ok": ok, "output": output, "items": items })
}

pub fn delete_branch(name: &str, force: bool) -> Value {
    let name = name.trim();
    if !valid_branch(name) {
        return ok_output(false, "分支名无效");
    }
    if current_branch(&cwd()) == name {
        return ok_output(false, "不能删除当前分支");
    }
    let flag = if force { "-D" } else { "-d" };
    let (ok, output) = run(&["branch", flag, "--", name]);
    ok_output(ok, output)
}

pub fn tags_payload() -> Value {
    let output = run(&[
        "for-each-ref",
        "--format=%(refname:short)\t%(objectname:short)\t%(creatordate:short)",
        "refs/tags",
    ]);
    if !output.0 && output.1.contains("not a git repository") {
        return json!({ "ok": false, "output": output.1, "items": [] });
    }
    let items: Vec<Value> = output
        .1
        .lines()
        .filter(|line| !line.trim().is_empty())
        .map(|line| {
            let mut parts = line.split('\t');
            json!({
                "name": parts.next().unwrap_or(""),
                "sha": parts.next().unwrap_or(""),
                "date": parts.next().unwrap_or(""),
            })
        })
        .collect();
    json!({ "ok": true, "output": "", "items": items })
}

pub fn create_tag(name: &str, message: &str) -> Value {
    let name = name.trim();
    if !valid_branch(name) {
        return ok_output(false, "标签名无效");
    }
    let message = message.trim();
    let (ok, output) = if message.is_empty() {
        run(&["tag", "--", name])
    } else {
        run(&["tag", "-a", name, "-m", message])
    };
    ok_output(ok, output)
}

pub fn delete_tag(name: &str) -> Value {
    let name = name.trim();
    if !valid_branch(name) {
        return ok_output(false, "标签名无效");
    }
    let (ok, output) = run(&["tag", "-d", "--", name]);
    ok_output(ok, output)
}

pub fn clone_into(url: &str, parent: &str, folder: &str, shallow: bool) -> Value {
    let url = url.trim();
    if !valid_remote_url(url) {
        return ok_output(false, "克隆地址无效");
    }
    let parent = Path::new(parent.trim());
    if !parent.is_dir() {
        return ok_output(false, "目标目录不存在");
    }
    let name = if folder.trim().is_empty() {
        parse_remote(url)
            .and_then(|(_, path)| path.rsplit('/').next().map(str::to_string))
            .filter(|item| !item.is_empty())
            .unwrap_or_else(|| "repository".into())
    } else {
        folder.trim().to_string()
    };
    if name.contains(['/', '\\']) || name.contains("..") || name.is_empty() {
        return ok_output(false, "文件夹名无效");
    }
    let target = parent.join(&name);
    if target.exists() {
        return ok_output(false, format!("目标已存在：{}", target.display()));
    }
    let target_s = target.display().to_string();
    let mut args = vec!["clone".to_string()];
    if shallow {
        args.extend(["--depth".into(), "1".into()]);
    }
    args.extend(["--".into(), url.to_string(), target_s.clone()]);
    let refs: Vec<&str> = args.iter().map(String::as_str).collect();
    let (ok, output) = run_in(parent, &refs);
    json!({ "ok": ok, "output": output, "path": target_s, "name": name })
}

pub fn apply_patch(patch: &str) -> Value {
    if patch.is_empty() || patch.len() > 2 * 1024 * 1024 {
        return ok_output(false, "补丁为空或超过 2MB");
    }
    let root = cwd();
    let mut command = Command::new("git");
    command
        .args(["apply", "--recount", "--whitespace=nowarn", "-"])
        .current_dir(&root)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    hide(&mut command);
    match command.spawn() {
        Ok(mut child) => {
            if let Some(stdin) = child.stdin.as_mut() {
                let _ = stdin.write_all(patch.as_bytes());
            }
            match child.wait_with_output() {
                Ok(output) => {
                    let text = if output.stdout.is_empty() {
                        String::from_utf8_lossy(&output.stderr).to_string()
                    } else {
                        String::from_utf8_lossy(&output.stdout).to_string()
                    };
                    ok_output(output.status.success(), text.trim())
                }
                Err(err) => ok_output(false, err.to_string()),
            }
        }
        Err(err) => ok_output(false, err.to_string()),
    }
}

pub fn list_path(path: &str, with_commit: bool) -> Value {
    let root = cwd();
    let rel = path.trim().replace('\\', "/").trim_matches('/').to_string();
    if rel.contains("..") {
        return json!({ "ok": false, "output": "路径无效", "items": [], "latest": Value::Null, "path": "" });
    }
    let dir = if rel.is_empty() {
        root.clone()
    } else {
        root.join(&rel)
    };
    if !dir.is_dir() {
        return json!({
            "ok": false,
            "output": "不是目录",
            "items": [],
            "latest": Value::Null,
            "path": rel,
        });
    }
    let mut names = Vec::new();
    if let Ok(read) = fs::read_dir(&dir) {
        for entry in read.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            if name == ".git" {
                continue;
            }
            let is_dir = entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false);
            names.push((name, is_dir));
        }
    }
    names.sort_by(|left, right| match (left.1, right.1) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => left.0.to_lowercase().cmp(&right.0.to_lowercase()),
    });
    let load_commit = with_commit && names.len() <= 80;
    let items: Vec<Value> = names
        .into_iter()
        .map(|(name, is_dir)| {
            let child = if rel.is_empty() {
                name.clone()
            } else {
                format!("{rel}/{name}")
            };
            let mut title = String::new();
            let mut author = String::new();
            let mut date = String::new();
            let mut sha = String::new();
            if load_commit {
                let log = run_in(
                    &root,
                    &["log", "-1", "--pretty=format:%h\t%s\t%an\t%cI", "--", &child],
                );
                if log.0 && !log.1.is_empty() {
                    let mut parts = log.1.split('\t');
                    sha = parts.next().unwrap_or("").to_string();
                    title = parts.next().unwrap_or("").to_string();
                    author = parts.next().unwrap_or("").to_string();
                    date = parts.next().unwrap_or("").to_string();
                }
            }
            json!({
                "name": name,
                "path": child,
                "type": if is_dir { "tree" } else { "blob" },
                "lastCommitId": sha,
                "lastCommitTitle": title,
                "lastCommitAuthor": author,
                "lastCommitDate": date,
            })
        })
        .collect();
    let latest_log = run_in(
        &root,
        &[
            "log",
            "-1",
            "--pretty=format:%H\t%h\t%s\t%an\t%cI",
            "--",
            if rel.is_empty() { "." } else { rel.as_str() },
        ],
    );
    let latest = if latest_log.0 && !latest_log.1.is_empty() {
        let mut parts = latest_log.1.split('\t');
        json!({
            "id": parts.next().unwrap_or(""),
            "shortId": parts.next().unwrap_or(""),
            "title": parts.next().unwrap_or(""),
            "authorName": parts.next().unwrap_or(""),
            "authoredDate": parts.next().unwrap_or(""),
        })
    } else {
        Value::Null
    };
    json!({
        "ok": true,
        "output": "",
        "path": rel,
        "items": items,
        "latest": latest,
    })
}

pub fn create_patch(kind: &str) -> Value {
    let (ok, output) = match kind {
        "staged" => run(&["diff", "--cached", "--", "."]),
        "unstaged" => run(&["diff", "--", "."]),
        _ => run(&["diff", "HEAD", "--", "."]),
    };
    json!({ "ok": ok, "output": output, "empty": output.trim().is_empty() })
}

#[derive(Clone)]
pub struct Remote {
    pub name: String,
    pub url: String,
    pub host: String,
    pub project_path: String,
}

pub fn parse_remote(value: &str) -> Option<(String, String)> {
    let value = value.trim();
    if let Some(rest) = value.strip_prefix("git@") {
        let (host, path) = rest.split_once(':')?;
        return Some((
            host.split(':').next().unwrap_or(host).to_lowercase(),
            path.trim_end_matches(".git").trim_matches('/').to_string(),
        ));
    }
    if let Some(rest) = value.strip_prefix("ssh://") {
        let rest = rest.split('@').next_back().unwrap_or(rest);
        let (host, path) = rest.split_once('/')?;
        return Some((
            host.split(':').next().unwrap_or(host).to_lowercase(),
            path.trim_end_matches(".git").trim_matches('/').to_string(),
        ));
    }
    let url = if value.contains("://") {
        value.to_string()
    } else {
        format!("https://{value}")
    };
    let without = url.split("://").nth(1)?;
    let (host, path) = without.split_once('/')?;
    let host = host.split('@').next_back().unwrap_or(host);
    Some((
        host.split(':').next().unwrap_or(host).to_lowercase(),
        path.trim_end_matches(".git").trim_matches('/').to_string(),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn remotes_payload_exposes_signature() {
        let value = remotes_payload();
        assert!(value.get("items").and_then(Value::as_array).is_some());
        assert!(value.get("signature").and_then(Value::as_str).is_some());
    }

    #[test]
    fn parse_remote_reads_github_urls() {
        assert_eq!(
            parse_remote("git@github.com:acme/demo.git").unwrap(),
            ("github.com".into(), "acme/demo".into())
        );
        assert_eq!(
            parse_remote("https://github.com/acme/demo.git").unwrap(),
            ("github.com".into(), "acme/demo".into())
        );
    }

    #[test]
    fn parse_status_header_reads_ahead_behind() {
        let (branch, upstream, ahead, behind) =
            parse_status_header("## main...origin/main [ahead 2, behind 1]");
        assert_eq!(branch, "main");
        assert_eq!(upstream, "origin/main");
        assert_eq!(ahead, 2);
        assert_eq!(behind, 1);
        assert!(valid_remote_name("origin"));
        assert!(!valid_remote_name("origin name"));
        assert!(valid_remote_url("git@github.com:acme/demo.git"));
        assert!(!valid_remote_url("https://example.com/a\nb.git"));
    }

    #[test]
    fn list_repos_reports_workspace_root() {
        let value = list_repos();
        assert_eq!(value.get("ok").and_then(Value::as_bool), Some(true));
        assert!(value.get("items").and_then(Value::as_array).is_some());
        assert!(value.get("workspaceRoot").and_then(Value::as_str).is_some());
    }
}
