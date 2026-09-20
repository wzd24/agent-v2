use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

const SKIP_NAMES: &[&str] = &[".git", "node_modules", "target", "dist", ".next", "vendor"];
const MAX_TEXT_BYTES: u64 = 512 * 1024;

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
        return Err("只能读取文件".into());
    }
    let meta = fs::metadata(&resolved).map_err(|err| err.to_string())?;
    if meta.len() > MAX_TEXT_BYTES {
        return Err(format!(
            "文件过大（{} 字节），第一期只读不超过 512KB 的文本",
            meta.len()
        ));
    }
    let bytes = fs::read(&resolved).map_err(|err| err.to_string())?;
    if bytes.contains(&0) {
        return Err("该文件不是文本，未打开".into());
    }
    let text = String::from_utf8(bytes).map_err(|_| "该文件不是 UTF-8 文本".to_string())?;
    Ok(FileContent {
        path: resolved.display().to_string(),
        name: resolved
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_default(),
        text,
        truncated: false,
    })
}

pub fn resolve_inside(root: &Path, target: &Path) -> Result<PathBuf, String> {
    let root = fs::canonicalize(root).map_err(|err| err.to_string())?;
    let resolved = if target.is_absolute() {
        fs::canonicalize(target).map_err(|err| err.to_string())?
    } else {
        fs::canonicalize(root.join(target)).map_err(|err| err.to_string())?
    };
    if !is_inside(&root, &resolved) {
        return Err("路径超出工作区".into());
    }
    Ok(resolved)
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
            path: path.display().to_string(),
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

fn is_inside(root: &Path, candidate: &Path) -> bool {
    let root = normalize(root);
    let candidate = normalize(candidate);
    candidate == root || candidate.starts_with(&format!("{root}{}", std::path::MAIN_SEPARATOR))
}

fn normalize(path: &Path) -> String {
    let display = path.display().to_string();
    if cfg!(windows) {
        display.trim_end_matches(['\\', '/']).to_lowercase()
    } else {
        display.trim_end_matches('/').to_string()
    }
}
