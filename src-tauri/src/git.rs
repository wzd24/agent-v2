use crate::config;
use serde_json::{json, Value};
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

fn cwd() -> PathBuf {
    config::workspace_root()
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

pub fn commit(message: &str, sign: bool) -> Value {
    let message = message.trim();
    if message.is_empty() {
        return ok_output(false, "提交信息不能为空");
    }
    let root = cwd();
    let staged = run_in(&root, &["add", "-A"]);
    if !staged.0 {
        return ok_output(false, staged.1);
    }
    let mut args = vec!["commit"];
    if sign {
        args.push("-S");
    }
    args.push("-m");
    args.push(message);
    let (ok, output) = run_in(&root, &args);
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
        if let Some(parsed) = parse_remote(&url) {
            remotes.push(Remote {
                name,
                url,
                host: parsed.0,
                project_path: parsed.1,
            });
        }
    }
    remotes.sort_by_key(|item| if item.name == "origin" { 0 } else { 1 });
    remotes
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
