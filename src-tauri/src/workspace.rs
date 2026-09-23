use crate::config;
use crate::git;
use crate::projects;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};

const SKIP_NAMES: &[&str] = &[".git", "node_modules", "target", "dist", ".next", "vendor"];
const MAX_TEXT_BYTES: u64 = 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TreeEntry {
    pub name: String,
    pub path: String,
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub children: Option<Vec<TreeEntry>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileContent {
    pub path: String,
    pub name: String,
    pub text: String,
    pub truncated: bool,
}

pub fn list_tree(root: &Path, depth: u32) -> Result<Vec<TreeEntry>, String> {
    walk(root, root, depth)
}

pub fn list_tree_at(root: &Path, current: &Path, depth: u32) -> Result<Vec<TreeEntry>, String> {
    let current = resolve_inside(root, current)?;
    if !current.is_dir() {
        return Err("不是目录".into());
    }
    walk(root, &current, depth)
}

pub fn read_text_file(root: &Path, target: &Path) -> Result<FileContent, String> {
    let resolved = resolve_inside(root, target)?;
    if !resolved.is_file() {
        return Err("目标不是文件".into());
    }
    let meta = fs::metadata(&resolved).map_err(|err| err.to_string())?;
    if meta.len() > MAX_TEXT_BYTES {
        return Err("文件超过 1MB，暂不支持预览".into());
    }
    let bytes = fs::read(&resolved).map_err(|err| err.to_string())?;
    let text = String::from_utf8_lossy(&bytes).into_owned();
    Ok(FileContent {
        path: display_path(&resolved),
        name: resolved
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_default(),
        text,
        truncated: false,
    })
}

pub fn display_path(path: &Path) -> String {
    strip_verbatim(&path.display().to_string())
}

fn strip_verbatim(raw: &str) -> String {
    let value = raw.trim();
    if let Some(rest) = value.strip_prefix(r"\\?\UNC\") {
        return format!(r"\\{rest}");
    }
    if let Some(rest) = value.strip_prefix(r"\\?\") {
        return rest.to_string();
    }
    value.to_string()
}

pub fn normalize_user_path(raw: &str) -> PathBuf {
    let mut value = percent_decode(raw.trim());
    value = strip_file_url(&value);
    value = strip_verbatim(&value);
    if let Some(index) = value.find(['?', '#']) {
        value.truncate(index);
    }
    let path = PathBuf::from(&value);
    if path.exists() {
        return path;
    }
    PathBuf::from(strip_editor_position(&value))
}

pub fn owning_root(target: &Path) -> Option<PathBuf> {
    let resolved = fs::canonicalize(target).unwrap_or_else(|_| target.to_path_buf());
    allowed_roots(&config::workspace_root())
        .into_iter()
        .find(|root| is_inside(root, &resolved))
}

pub fn resolve_inside(root: &Path, target: &Path) -> Result<PathBuf, String> {
    let cleaned = normalize_user_path(&target.to_string_lossy());
    let resolved = match canonicalize_from(root, &cleaned) {
        Ok(path) => path,
        Err(err) => {
            let stripped = PathBuf::from(strip_editor_position(&cleaned.to_string_lossy()));
            if stripped == cleaned {
                return Err(err);
            }
            canonicalize_from(root, &stripped)?
        }
    };
    if allowed_roots(root)
        .iter()
        .any(|candidate| is_inside(candidate, &resolved))
    {
        return Ok(resolved);
    }
    Err("路径超出工作区".into())
}

fn canonicalize_from(root: &Path, target: &Path) -> Result<PathBuf, String> {
    if target.is_absolute() {
        fs::canonicalize(target).map_err(|err| err.to_string())
    } else {
        let primary = fs::canonicalize(root).map_err(|err| err.to_string())?;
        fs::canonicalize(primary.join(target)).map_err(|err| err.to_string())
    }
}

fn percent_decode(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' && index + 2 < bytes.len() {
            if let Ok(hex) = std::str::from_utf8(&bytes[index + 1..index + 3]) {
                if let Ok(byte) = u8::from_str_radix(hex, 16) {
                    out.push(byte);
                    index += 3;
                    continue;
                }
            }
        }
        out.push(bytes[index]);
        index += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn strip_file_url(raw: &str) -> String {
    let lower = raw.to_ascii_lowercase();
    if !lower.starts_with("file:") {
        return raw.to_string();
    }
    let rest = &raw[5..];
    let trimmed = rest.trim_start_matches('/');
    if trimmed.len() >= 2 && trimmed.as_bytes().get(1) == Some(&b':') {
        return trimmed.to_string();
    }
    if rest.starts_with("//") && !rest.starts_with("///") {
        return format!(r"\\{}", rest.trim_start_matches('/'));
    }
    trimmed.to_string()
}

fn strip_editor_position(value: &str) -> String {
    fn strip_colon_digits(input: &str) -> Option<&str> {
        let (head, tail) = input.rsplit_once(':')?;
        if tail.is_empty() || !tail.chars().all(|ch| ch.is_ascii_digit()) {
            return None;
        }
        Some(head)
    }
    let Some(once) = strip_colon_digits(value) else {
        return value.to_string();
    };
    if once.len() == 1 && once.chars().next().is_some_and(|ch| ch.is_ascii_alphabetic()) {
        return value.to_string();
    }
    if let Some(twice) = strip_colon_digits(once) {
        if twice.len() == 1 && twice.chars().next().is_some_and(|ch| ch.is_ascii_alphabetic()) {
            return once.to_string();
        }
        return twice.to_string();
    }
    once.to_string()
}

pub fn allowed_roots(primary: &Path) -> Vec<PathBuf> {
    let mut roots: Vec<PathBuf> = Vec::new();
    let mut push = |path: PathBuf| {
        if path.as_os_str().is_empty() {
            return;
        }
        let resolved = fs::canonicalize(&path).unwrap_or(path);
        if roots.iter().any(|existing| same_path(existing, &resolved)) {
            return;
        }
        roots.push(resolved);
    };
    push(primary.to_path_buf());
    push(config::workspace_root());
    push(config::projectless_workspace_root());
    for project in projects::list_projects() {
        if let Some(list) = project.get("rootPaths").and_then(Value::as_array) {
            for item in list {
                if let Some(path) = item.as_str() {
                    if !path.trim().is_empty() {
                        push(PathBuf::from(path));
                    }
                }
            }
        }
        if let Some(path) = project.get("path").and_then(Value::as_str) {
            if !path.trim().is_empty() {
                push(PathBuf::from(path));
            }
        }
    }
    for worktree in git_worktree_paths(&config::workspace_root()) {
        push(worktree);
    }
    roots.sort_by_key(|path| std::cmp::Reverse(path.as_os_str().len()));
    roots
}

pub fn same_path(left: &Path, right: &Path) -> bool {
    normalize(left) == normalize(right)
}

fn git_worktree_paths(root: &Path) -> Vec<PathBuf> {
    let (ok, output) = git::run_in(root, &["worktree", "list", "--porcelain"]);
    if !ok {
        return Vec::new();
    }
    output
        .lines()
        .filter_map(|line| line.strip_prefix("worktree "))
        .filter(|path| !path.trim().is_empty())
        .map(PathBuf::from)
        .collect()
}

fn walk(root: &Path, current: &Path, remaining: u32) -> Result<Vec<TreeEntry>, String> {
    let mut entries = Vec::new();
    let read = match fs::read_dir(current) {
        Ok(read) => read,
        Err(_) => return Ok(entries),
    };
    for entry in read.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if SKIP_NAMES.iter().any(|skip| skip.eq_ignore_ascii_case(&name)) {
            continue;
        }
        let path = entry.path();
        let directory = entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false);
        let children = if directory && remaining > 0 {
            Some(walk(root, &path, remaining - 1).unwrap_or_default())
        } else if directory {
            None
        } else {
            None
        };
        entries.push(TreeEntry {
            name,
            path: display_path(&path),
            kind: if directory { "directory".into() } else { "file".into() },
            children,
        });
    }
    entries.sort_by(|left, right| {
        match (left.kind.as_str(), right.kind.as_str()) {
            ("directory", "file") => std::cmp::Ordering::Less,
            ("file", "directory") => std::cmp::Ordering::Greater,
            _ => left.name.to_lowercase().cmp(&right.name.to_lowercase()),
        }
    });
    Ok(entries)
}

pub fn is_inside(root: &Path, candidate: &Path) -> bool {
    let root = normalize(root);
    let candidate = normalize(candidate);
    candidate == root || candidate.starts_with(&format!("{root}{}", std::path::MAIN_SEPARATOR))
}

fn normalize(path: &Path) -> String {
    let display = strip_verbatim(&path.display().to_string());
    if cfg!(windows) {
        display.replace('/', "\\").trim_end_matches(['\\', '/']).to_lowercase()
    } else {
        display.trim_end_matches('/').to_string()
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct V1TreeEntry {
    pub name: String,
    #[serde(rename = "type")]
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub children: Option<Vec<V1TreeEntry>>,
}

pub fn list_tree_v1(root: &Path, depth: u32) -> Result<(PathBuf, Vec<V1TreeEntry>), String> {
    let root = fs::canonicalize(root).map_err(|err| err.to_string())?;
    if !root.is_dir() {
        return Err("工作区不是目录".into());
    }
    Ok((PathBuf::from(display_path(&root)), to_v1(walk(&root, &root, depth)?)))
}

fn to_v1(entries: Vec<TreeEntry>) -> Vec<V1TreeEntry> {
    entries
        .into_iter()
        .map(|entry| V1TreeEntry {
            name: entry.name,
            kind: if entry.kind == "directory" {
                "directory".into()
            } else {
                "file".into()
            },
            children: entry.children.map(to_v1),
        })
        .collect()
}

pub fn relative_to(root: &Path, target: &Path) -> String {
    let root_n = normalize(root);
    let target_n = normalize(target);
    if target_n == root_n {
        return String::new();
    }
    let prefix = format!("{root_n}{}", std::path::MAIN_SEPARATOR);
    if let Some(rest) = target_n.strip_prefix(&prefix) {
        return rest.replace('\\', "/");
    }
    target
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default()
}

pub fn search_files(root: &Path, query: &str, limit: usize) -> Result<Vec<serde_json::Value>, String> {
    let root = fs::canonicalize(root).map_err(|err| err.to_string())?;
    let query = query.trim().to_lowercase();
    if query.is_empty() {
        return Ok(Vec::new());
    }
    let mut found = Vec::new();
    search_walk(&root, &root, &query, limit, &mut found)?;
    Ok(found)
}

fn search_walk(
    root: &Path,
    current: &Path,
    query: &str,
    limit: usize,
    found: &mut Vec<serde_json::Value>,
) -> Result<(), String> {
    if found.len() >= limit {
        return Ok(());
    }
    let read = match fs::read_dir(current) {
        Ok(read) => read,
        Err(_) => return Ok(()),
    };
    for entry in read.flatten() {
        if found.len() >= limit {
            break;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        if SKIP_NAMES.iter().any(|skip| skip.eq_ignore_ascii_case(&name)) {
            continue;
        }
        let path = entry.path();
        let directory = entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false);
        if name.to_lowercase().contains(query) {
            found.push(serde_json::json!({
                "name": name,
                "path": display_path(&path),
                "relativePath": relative_to(root, &path),
            }));
        }
        if directory {
            search_walk(root, &path, query, limit, found)?;
        }
    }
    Ok(())
}

pub fn describe_file(root: &Path, target: &Path) -> Result<serde_json::Value, String> {
    let resolved = resolve_inside(root, target)?;
    if !resolved.is_file() {
        return Err("目标不是文件".into());
    }
    let meta = fs::metadata(&resolved).map_err(|err| err.to_string())?;
    let name = resolved
        .file_name()
        .map(|value| value.to_string_lossy().into_owned())
        .unwrap_or_default();
    let extension = resolved
        .extension()
        .map(|value| format!(".{}", value.to_string_lossy().to_lowercase()))
        .unwrap_or_default();
    let content = describe_content(&resolved, &extension, meta.len());
    let normalized = content.replace("\r\n", "\n");
    let lines: Vec<&str> = if normalized.is_empty() {
        Vec::new()
    } else {
        normalized.split('\n').collect()
    };
    let meaningful: Vec<&str> = lines
        .iter()
        .map(|line| line.trim())
        .filter(|line| {
            !line.is_empty()
                && !line.starts_with("//")
                && !line.starts_with("/*")
                && !line.starts_with('*')
                && !(line.starts_with('#') && !line.starts_with("# "))
                && !line.starts_with("<!--")
        })
        .collect();
    let declarations: Vec<&str> = meaningful
        .iter()
        .copied()
        .filter(|line| is_declaration(line))
        .collect();
    let source = if declarations.is_empty() {
        &meaningful
    } else {
        &declarations
    };
    let summary_source = source.iter().take(3).copied().collect::<Vec<_>>().join(" · ");
    let summary = if summary_source.is_empty() {
        if meta.len() > MAX_TEXT_BYTES {
            "文件超过 1MB，悬停时不读取内容。".to_string()
        } else {
            "空文件".to_string()
        }
    } else {
        summary_source.chars().take(280).collect::<String>()
    };
    Ok(serde_json::json!({
        "path": display_path(&resolved),
        "relativePath": relative_to(root, &resolved),
        "name": name,
        "extension": extension,
        "language": language_for(&name, &extension),
        "size": meta.len(),
        "lines": lines.len(),
        "modifiedAt": iso8601(meta.modified().ok()),
        "summary": summary,
    }))
}

fn describe_content(path: &Path, extension: &str, size: u64) -> String {
    if matches!(extension, ".docx" | ".xlsx" | ".pptx" | ".pdf" | ".ipynb" | ".csv")
        && size <= 8 * 1024 * 1024
    {
        if let Ok(preview) = crate::preview::read_structured(path) {
            if let Some(text) = preview.get("content").and_then(serde_json::Value::as_str) {
                return text.to_string();
            }
        }
    }
    if size <= MAX_TEXT_BYTES {
        fs::read_to_string(path).unwrap_or_default()
    } else {
        String::new()
    }
}

fn is_declaration(line: &str) -> bool {
    let trimmed = line.trim_start();
    trimmed.starts_with("# ")
        || trimmed.starts_with("## ")
        || trimmed.starts_with("### ")
        || trimmed.starts_with("export ")
        || trimmed.starts_with("async function")
        || trimmed.starts_with("function ")
        || trimmed.starts_with("class ")
        || trimmed.starts_with("interface ")
        || trimmed.starts_with("type ")
        || trimmed.starts_with("const ")
        || trimmed.starts_with("let ")
        || trimmed.starts_with("var ")
        || trimmed.starts_with("enum ")
        || trimmed.starts_with("func ")
        || trimmed.starts_with("package ")
        || trimmed.starts_with("struct ")
        || trimmed.starts_with("trait ")
}

fn iso8601(modified: Option<std::time::SystemTime>) -> String {
    let Some(time) = modified else {
        return String::new();
    };
    let Ok(elapsed) = time.duration_since(std::time::UNIX_EPOCH) else {
        return String::new();
    };
    let secs = elapsed.as_secs();
    let (year, month, day, hour, min, sec) = civil_from_days(secs);
    format!("{year:04}-{month:02}-{day:02}T{hour:02}:{min:02}:{sec:02}.000Z")
}

fn civil_from_days(secs: u64) -> (i32, u32, u32, u32, u32, u32) {
    let days = (secs / 86400) as i64;
    let rem = secs % 86400;
    let hour = (rem / 3600) as u32;
    let min = ((rem % 3600) / 60) as u32;
    let sec = (rem % 60) as u32;
    let z = days + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = (z - era * 146097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    (y as i32, m as u32, d as u32, hour, min, sec)
}

fn language_for(name: &str, extension: &str) -> String {
    let lowered = name.to_lowercase();
    match lowered.as_str() {
        "package.json" => return "Node 包清单".into(),
        "package-lock.json" => return "npm 锁文件".into(),
        "pnpm-lock.yaml" => return "pnpm 锁文件".into(),
        "yarn.lock" => return "Yarn 锁文件".into(),
        "cargo.toml" => return "Cargo 清单".into(),
        "cargo.lock" => return "Cargo 锁文件".into(),
        "pyproject.toml" => return "Python 项目".into(),
        "go.mod" => return "Go 模块".into(),
        "tsconfig.json" => return "TypeScript 配置".into(),
        "dockerfile" => return "Dockerfile".into(),
        "makefile" => return "Makefile".into(),
        "cmakelists.txt" => return "CMake".into(),
        ".gitignore" => return "Git 忽略".into(),
        ".env" => return "环境变量".into(),
        _ => {}
    }
    if lowered.starts_with(".env") {
        return "环境变量".into();
    }
    if lowered.starts_with("dockerfile") {
        return "Dockerfile".into();
    }
    if lowered.contains("docker-compose") && (lowered.ends_with(".yml") || lowered.ends_with(".yaml"))
    {
        return "Docker Compose".into();
    }
    if lowered.starts_with("tsconfig") && lowered.ends_with(".json") {
        return "TypeScript 配置".into();
    }
    match extension {
        ".ts" => "TypeScript",
        ".tsx" => "TypeScript React",
        ".js" => "JavaScript",
        ".jsx" => "JavaScript React",
        ".mjs" => "JavaScript Module",
        ".cjs" => "CommonJS",
        ".json" | ".jsonc" | ".json5" => "JSON",
        ".md" | ".markdown" => "Markdown",
        ".mdx" => "MDX",
        ".go" => "Go",
        ".rs" => "Rust",
        ".py" | ".pyi" | ".pyw" => "Python",
        ".rb" => "Ruby",
        ".php" => "PHP",
        ".java" => "Java",
        ".kt" | ".kts" => "Kotlin",
        ".cs" => "C#",
        ".fs" => "F#",
        ".swift" => "Swift",
        ".dart" => "Dart",
        ".c" | ".h" => "C",
        ".cpp" | ".cc" | ".cxx" | ".hpp" => "C++",
        ".css" => "CSS",
        ".scss" => "SCSS",
        ".less" => "Less",
        ".html" | ".htm" => "HTML",
        ".xml" => "XML",
        ".svg" => "SVG",
        ".yaml" | ".yml" => "YAML",
        ".toml" => "TOML",
        ".ini" | ".cfg" => "INI",
        ".sql" => "SQL",
        ".sh" | ".bash" | ".zsh" => "Shell",
        ".ps1" => "PowerShell",
        ".bat" | ".cmd" => "Batch",
        ".tf" => "Terraform",
        ".hcl" => "HCL",
        ".proto" => "Protobuf",
        ".vue" => "Vue",
        ".svelte" => "Svelte",
        ".docx" => "Word",
        ".xlsx" => "Excel",
        ".csv" => "CSV",
        ".pptx" => "PowerPoint",
        ".pdf" => "PDF",
        ".ipynb" => "Jupyter",
        _ if !extension.is_empty() => {
            return extension.trim_start_matches('.').to_uppercase();
        }
        _ => "文本",
    }
    .into()
}

fn resolve_new_path(root: &Path, target: &Path) -> Result<PathBuf, String> {
    if target.exists() {
        return resolve_inside(root, target);
    }
    let parent = target.parent().filter(|path| !path.as_os_str().is_empty());
    let parent = match parent {
        Some(parent) if parent.exists() => resolve_inside(root, parent)?,
        Some(_) => return Err("父目录不存在".into()),
        None => fs::canonicalize(root).map_err(|err| err.to_string())?,
    };
    let name = target
        .file_name()
        .ok_or_else(|| "无效文件名".to_string())?;
    Ok(parent.join(name))
}

pub fn write_text_file(root: &Path, target: &Path, content: &str) -> Result<PathBuf, String> {
    if content.len() > 4 * 1024 * 1024 {
        return Err("文件超过 4MB，暂不支持编辑".into());
    }
    let resolved = resolve_new_path(root, target)?;
    if let Some(parent) = resolved.parent() {
        fs::create_dir_all(parent).map_err(|err| err.to_string())?;
    }
    fs::write(&resolved, content).map_err(|err| err.to_string())?;
    Ok(resolved)
}

fn assert_entry_name(name: &str) -> Result<String, String> {
    let value = name.trim();
    if value.is_empty()
        || value == "."
        || value == ".."
        || value.contains(['/', '\\', '\0'])
    {
        return Err("文件名无效".into());
    }
    Ok(value.to_string())
}

fn node_extname(name: &str) -> &str {
    let search = if name.starts_with('.') { &name[1..] } else { name };
    match search.rfind('.') {
        Some(rel) => {
            let abs = if name.starts_with('.') { rel + 1 } else { rel };
            &name[abs..]
        }
        None => "",
    }
}

fn unused_name(dir: &Path, name: &str) -> Result<String, String> {
    let base = assert_entry_name(name)?;
    if !dir.join(&base).exists() {
        return Ok(base);
    }
    let extension = node_extname(&base);
    let stem = &base[..base.len() - extension.len()];
    for index in 1..1000 {
        let candidate = if index == 1 {
            format!("{stem} 副本{extension}")
        } else {
            format!("{stem} 副本 {index}{extension}")
        };
        if !dir.join(&candidate).exists() {
            return Ok(candidate);
        }
    }
    Err("无法生成可用文件名".into())
}

fn is_root_entry(root: &Path, target: &Path) -> bool {
    same_path(root, target)
        || allowed_roots(root)
            .iter()
            .any(|candidate| same_path(candidate, target))
}

fn paste_destination_dir(root: &Path, destination: &Path) -> Result<PathBuf, String> {
    let destination = resolve_inside(root, destination)?;
    if !destination.is_dir() {
        return Err("粘贴目标不是目录".into());
    }
    Ok(destination)
}

pub fn create_entry(root: &Path, parent: &Path, name: &str, kind: &str) -> Result<PathBuf, String> {
    let parent = resolve_inside(root, parent)?;
    if !parent.is_dir() {
        return Err("目标不是目录".into());
    }
    let name = assert_entry_name(name)?;
    let dest = parent.join(name);
    if dest.exists() {
        return Err("同名文件已存在".into());
    }
    if kind == "directory" {
        fs::create_dir(&dest).map_err(|err| err.to_string())?;
    } else {
        fs::write(&dest, "").map_err(|err| err.to_string())?;
    }
    Ok(dest)
}

pub fn rename_entry(root: &Path, target: &Path, name: &str) -> Result<PathBuf, String> {
    let resolved = resolve_inside(root, target)?;
    if is_root_entry(root, &resolved) {
        return Err("不能重命名工作区根目录".into());
    }
    let name = assert_entry_name(name)?;
    let dest = resolved
        .parent()
        .ok_or_else(|| "无法重命名".to_string())?
        .join(&name);
    if same_path(&resolved, &dest) {
        return Ok(resolved);
    }
    if dest.exists() {
        return Err("同名文件已存在".into());
    }
    fs::rename(&resolved, &dest).map_err(|err| err.to_string())?;
    Ok(dest)
}

pub fn delete_entry(root: &Path, target: &Path) -> Result<PathBuf, String> {
    let resolved = resolve_inside(root, target)?;
    if is_root_entry(root, &resolved) {
        return Err("不能删除工作区根目录".into());
    }
    if resolved.is_dir() {
        fs::remove_dir_all(&resolved).map_err(|err| err.to_string())?;
    } else {
        fs::remove_file(&resolved).map_err(|err| err.to_string())?;
    }
    Ok(resolved)
}

pub fn copy_entry(root: &Path, source: &Path, destination: &Path) -> Result<PathBuf, String> {
    let source = resolve_inside(root, source)?;
    let destination_dir = paste_destination_dir(root, destination)?;
    let name = source
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| "无效文件名".to_string())?;
    let dest = destination_dir.join(unused_name(&destination_dir, name)?);
    if source.is_dir() {
        copy_dir(&source, &dest)?;
    } else {
        fs::copy(&source, &dest).map_err(|err| err.to_string())?;
    }
    Ok(dest)
}

pub fn move_entry(root: &Path, source: &Path, destination: &Path) -> Result<PathBuf, String> {
    let source = resolve_inside(root, source)?;
    if is_root_entry(root, &source) {
        return Err("不能移动工作区根目录".into());
    }
    let destination_dir = paste_destination_dir(root, destination)?;
    let name = source
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| "无效文件名".to_string())?;
    let dest = destination_dir.join(unused_name(&destination_dir, name)?);
    if same_path(
        source.parent().unwrap_or(source.as_path()),
        &destination_dir,
    ) && source.file_name() == dest.file_name()
    {
        return Ok(source);
    }
    fs::rename(&source, &dest).map_err(|err| err.to_string())?;
    Ok(dest)
}

fn copy_dir(source: &Path, destination: &Path) -> Result<(), String> {
    fs::create_dir_all(destination).map_err(|err| err.to_string())?;
    for entry in fs::read_dir(source).map_err(|err| err.to_string())? {
        let entry = entry.map_err(|err| err.to_string())?;
        let dest = destination.join(entry.file_name());
        if entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false) {
            copy_dir(&entry.path(), &dest)?;
        } else {
            fs::copy(entry.path(), dest).map_err(|err| err.to_string())?;
        }
    }
    Ok(())
}

pub fn read_bytes(root: &Path, target: &Path) -> Result<(PathBuf, Vec<u8>), String> {
    let resolved = resolve_inside(root, target)?;
    let bytes = fs::read(&resolved).map_err(|err| err.to_string())?;
    Ok((resolved, bytes))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("local-codex-ws-{}-{}", std::process::id(), name));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn text_preview_rejects_over_1mb() {
        let root = temp_root("big");
        let file = root.join("big.txt");
        fs::write(&file, vec![b'a'; (MAX_TEXT_BYTES as usize) + 1]).unwrap();
        let err = read_text_file(&root, &file).unwrap_err();
        assert_eq!(err, "文件超过 1MB，暂不支持预览");
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn text_preview_reads_utf8() {
        let root = temp_root("ok");
        let file = root.join("ok.txt");
        fs::write(&file, "hello").unwrap();
        let content = read_text_file(&root, &file).unwrap();
        assert_eq!(content.text, "hello");
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn rejects_deleting_workspace_root() {
        let root = temp_root("root-del");
        let err = delete_entry(&root, &root).unwrap_err();
        assert_eq!(err, "不能删除工作区根目录");
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn copy_into_folder_uses_unused_name() {
        let root = temp_root("copy");
        let file = root.join("note.txt");
        fs::write(&file, "hi").unwrap();
        let first = copy_entry(&root, &file, &root).unwrap();
        assert_eq!(first.file_name().unwrap(), "note 副本.txt");
        let second = copy_entry(&root, &file, &root).unwrap();
        assert_eq!(second.file_name().unwrap(), "note 副本 2.txt");
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn create_rejects_file_parent() {
        let root = temp_root("parent");
        let file = root.join("a.txt");
        fs::write(&file, "x").unwrap();
        let err = create_entry(&root, &file, "b.txt", "file").unwrap_err();
        assert_eq!(err, "目标不是目录");
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn normalize_user_path_keeps_windows_verbatim_prefix() {
        let parsed = normalize_user_path(r"\\?\D:\sources\repos\server\go.mod");
        assert_eq!(parsed, PathBuf::from(r"D:\sources\repos\server\go.mod"));
        let query = normalize_user_path(r"C:\repo\main.go?line=12");
        assert_eq!(query, PathBuf::from(r"C:\repo\main.go"));
    }

    #[cfg(windows)]
    #[test]
    fn verbatim_workspace_file_is_inside() {
        let root = temp_root("verbatim");
        let file = root.join("go.mod");
        fs::write(&file, "module demo\n").unwrap();
        let canonical = fs::canonicalize(&root).unwrap();
        let verbatim = PathBuf::from(format!(
            r"\\?\{}\go.mod",
            display_path(&canonical)
        ));
        let content = read_text_file(&canonical, &verbatim).expect("should read verbatim path");
        assert!(content.text.contains("module demo"));
        assert!(!content.path.contains(r"\\?\"));
        let _ = fs::remove_dir_all(root);
    }
}
