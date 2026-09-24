use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

struct EditorProfile {
    label: &'static str,
    path_names: &'static [&'static str],
    relatives: &'static [&'static str],
    exe_names: &'static [&'static str],
}

const VSCODE: EditorProfile = EditorProfile {
    label: "VS Code",
    path_names: &["code.cmd", "code", "code.exe"],
    relatives: &[
        r"Programs\Microsoft VS Code\Code.exe",
        r"Microsoft VS Code\Code.exe",
        r"Programs\Microsoft VS Code Insiders\Code - Insiders.exe",
        r"Microsoft VS Code Insiders\Code - Insiders.exe",
        r"scoop\apps\vscode\current\Code.exe",
        r"scoop\apps\vscode-insiders\current\Code - Insiders.exe",
    ],
    exe_names: &["Code.exe", "Code - Insiders.exe"],
};

const CURSOR: EditorProfile = EditorProfile {
    label: "Cursor",
    path_names: &["cursor.cmd", "cursor", "cursor.exe"],
    relatives: &[
        r"Programs\cursor\Cursor.exe",
        r"Programs\Cursor\Cursor.exe",
        r"cursor\Cursor.exe",
        r"scoop\apps\cursor\current\Cursor.exe",
    ],
    exe_names: &["Cursor.exe"],
};

const VSCODIUM: EditorProfile = EditorProfile {
    label: "VSCodium",
    path_names: &["codium.cmd", "codium", "codium.exe"],
    relatives: &[
        r"Programs\VSCodium\VSCodium.exe",
        r"VSCodium\VSCodium.exe",
        r"scoop\apps\vscodium\current\VSCodium.exe",
    ],
    exe_names: &["VSCodium.exe"],
};

const WINDSURF: EditorProfile = EditorProfile {
    label: "Windsurf",
    path_names: &["windsurf.cmd", "windsurf", "windsurf.exe"],
    relatives: &[
        r"Programs\Windsurf\Windsurf.exe",
        r"Windsurf\Windsurf.exe",
    ],
    exe_names: &["Windsurf.exe"],
};

const SUBLIME: EditorProfile = EditorProfile {
    label: "Sublime Text",
    path_names: &["subl", "sublime_text", "sublime_text.exe"],
    relatives: &[
        r"Sublime Text\sublime_text.exe",
        r"Sublime Text 3\sublime_text.exe",
        r"Sublime Text 4\sublime_text.exe",
    ],
    exe_names: &["sublime_text.exe"],
};

const NOTEPADPP: EditorProfile = EditorProfile {
    label: "Notepad++",
    path_names: &["notepad++.exe", "notepad++"],
    relatives: &[
        r"Notepad++\notepad++.exe",
    ],
    exe_names: &["notepad++.exe"],
};

fn profile_for(application: &str) -> Option<&'static EditorProfile> {
    match normalize_name(application).as_str() {
        "vscode" | "code" | "visualstudiocode" => Some(&VSCODE),
        "cursor" => Some(&CURSOR),
        "vscodium" | "codium" => Some(&VSCODIUM),
        "windsurf" => Some(&WINDSURF),
        "sublime" | "sublimetext" | "subl" => Some(&SUBLIME),
        "notepad++" | "notepadpp" => Some(&NOTEPADPP),
        _ => None,
    }
}

fn normalize_name(value: &str) -> String {
    value
        .trim()
        .to_ascii_lowercase()
        .replace(' ', "")
        .replace('-', "")
}

fn search_roots() -> Vec<PathBuf> {
    let mut roots = Vec::new();
    for key in [
        "LOCALAPPDATA",
        "ProgramFiles",
        "ProgramW6432",
        "ProgramFiles(x86)",
        "USERPROFILE",
    ] {
        if let Ok(value) = std::env::var(key) {
            let path = PathBuf::from(value);
            if path.is_dir() {
                roots.push(path);
            }
        }
    }
    roots
}

fn hide(command: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000);
    }
}

fn which(name: &str) -> Option<PathBuf> {
    #[cfg(windows)]
    {
        let mut command = Command::new("where.exe");
        hide(&mut command);
        let output = command.arg(name).output().ok()?;
        if !output.status.success() {
            return None;
        }
        for line in String::from_utf8_lossy(&output.stdout).lines() {
            let path = PathBuf::from(line.trim());
            if path.is_file() {
                return Some(path);
            }
        }
        None
    }
    #[cfg(not(windows))]
    {
        let mut command = Command::new("which");
        let output = command.arg(name).output().ok()?;
        if !output.status.success() {
            return None;
        }
        let path = PathBuf::from(String::from_utf8_lossy(&output.stdout).trim());
        path.is_file().then_some(path)
    }
}

fn prefer_gui_binary(path: PathBuf, profile: &EditorProfile) -> PathBuf {
    let Some(parent) = path.parent() else {
        return path;
    };
    for exe in profile.exe_names {
        let same_dir = parent.join(exe);
        if same_dir.is_file() {
            return same_dir;
        }
        if parent
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.eq_ignore_ascii_case("bin"))
        {
            if let Some(app_dir) = parent.parent() {
                let sibling = app_dir.join(exe);
                if sibling.is_file() {
                    return sibling;
                }
            }
        }
    }
    path
}

fn existing_candidate(root: &Path, relative: &str) -> Option<PathBuf> {
    let candidate = root.join(relative);
    candidate.is_file().then_some(candidate)
}

pub fn resolve_editor(application: &str) -> Option<PathBuf> {
    resolve_editor_in(application, &search_roots(), true)
}

fn resolve_editor_in(application: &str, roots: &[PathBuf], use_path: bool) -> Option<PathBuf> {
    let profile = profile_for(application)?;
    if use_path {
        for name in profile.path_names {
            if let Some(found) = which(name) {
                return Some(prefer_gui_binary(found, profile));
            }
        }
    }
    for root in roots {
        for relative in profile.relatives {
            if let Some(found) = existing_candidate(root, relative) {
                return Some(found);
            }
        }
    }
    None
}

fn is_batch(path: &Path) -> bool {
    path.extension()
        .and_then(|ext| ext.to_str())
        .is_some_and(|ext| ext.eq_ignore_ascii_case("cmd") || ext.eq_ignore_ascii_case("bat"))
}

fn spawn_resolved(program: &Path, target: &Path, cwd: &Path) -> Result<(), String> {
    let mut process = if is_batch(program) {
        let mut command = Command::new("cmd.exe");
        command
            .arg("/C")
            .arg(program)
            .arg(target)
            .current_dir(cwd);
        command
    } else {
        let mut command = Command::new(program);
        command.arg(target).current_dir(cwd);
        command
    };
    hide(&mut process);
    process
        .spawn()
        .map(|_| ())
        .map_err(|err| format!("无法启动 {}: {err}", program.display()))
}

pub fn open_with_editor(application: &str, target: &Path, cwd: &Path) -> Result<PathBuf, String> {
    let Some(program) = resolve_editor(application) else {
        let label = profile_for(application)
            .map(|profile| profile.label)
            .unwrap_or(application);
        return Err(format!(
            "未找到 {label}。已检查 PATH 和常见安装目录，可在设置中改用「系统默认」。"
        ));
    };
    spawn_resolved(&program, target, cwd)?;
    Ok(program)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_common_vscode_aliases() {
        assert!(profile_for("VS Code").is_some());
        assert!(profile_for("vscode").is_some());
        assert!(profile_for("code").is_some());
        assert_eq!(profile_for("VS Code").unwrap().label, "VS Code");
        assert_eq!(profile_for("Cursor").unwrap().label, "Cursor");
    }

    #[test]
    fn finds_vscode_under_local_programs() {
        let dir = std::env::temp_dir().join(format!(
            "local-codex-editor-{}",
            std::process::id()
        ));
        let exe = dir
            .join("Programs")
            .join("Microsoft VS Code")
            .join("Code.exe");
        fs::create_dir_all(exe.parent().unwrap()).unwrap();
        fs::write(&exe, []).unwrap();
        let found = resolve_editor_in("VS Code", &[dir.clone()], false).expect("detect vscode");
        assert_eq!(found, exe);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn prefers_gui_exe_next_to_cli_shim() {
        let dir = std::env::temp_dir().join(format!(
            "local-codex-editor-shim-{}",
            std::process::id()
        ));
        let exe = dir.join("Code.exe");
        let shim = dir.join("bin").join("code.cmd");
        fs::create_dir_all(shim.parent().unwrap()).unwrap();
        fs::write(&exe, []).unwrap();
        fs::write(&shim, []).unwrap();
        assert_eq!(prefer_gui_binary(shim, &VSCODE), exe);
        let _ = fs::remove_dir_all(dir);
    }
}
