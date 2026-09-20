use keyring::Entry;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

const SERVICE: &str = "local-codex";
const API_KEY_ACCOUNT: &str = "DEEPSEEK_API_KEY";
const DEFAULT_MODEL: &str = "deepseek-chat";
const DEFAULT_PROVIDER: &str = "deepseek";
const DEFAULT_BASE_URL: &str = "https://api.deepseek.com/";
const DEFAULT_ENV_KEY: &str = "DEEPSEEK_API_KEY";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub model: String,
    pub model_provider: String,
    pub base_url: String,
    pub env_key: String,
    pub api_key_configured: bool,
    pub codex_home: String,
    pub workspace: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SettingsPatch {
    pub model: Option<String>,
    pub base_url: Option<String>,
    #[serde(alias = "api_key")]
    pub api_key: Option<String>,
    pub workspace: Option<String>,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct UiState {
    workspace: Option<String>,
}

pub fn resolve_codex_home() -> PathBuf {
    if let Ok(value) = std::env::var("CODEX_HOME") {
        let trimmed = value.trim();
        if !trimmed.is_empty() {
            return PathBuf::from(trimmed);
        }
    }
    default_base_dir().join("local-codex").join("codex-home")
}

pub fn default_base_dir() -> PathBuf {
    dirs::data_dir().unwrap_or_else(|| {
        dirs::home_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join("AppData")
            .join("Roaming")
    })
}

fn ui_state_path() -> PathBuf {
    default_base_dir().join("local-codex").join("ui-state.json")
}

pub fn ensure_config(codex_home: &Path) -> Result<PathBuf, String> {
    fs::create_dir_all(codex_home).map_err(|err| err.to_string())?;
    let target = codex_home.join("config.toml");
    if !target.exists() {
        write_config(
            &target,
            DEFAULT_MODEL,
            DEFAULT_PROVIDER,
            DEFAULT_BASE_URL,
            DEFAULT_ENV_KEY,
        )?;
        return Ok(target);
    }
    let source = fs::read_to_string(&target).unwrap_or_default();
    if !source.contains("approval_policy")
        || source.contains("approval_policy = \"untrusted\"")
        || source.contains("preferred_auth_method")
        || !source.contains("sandbox_mode")
        || !source.contains("requires_openai_auth")
    {
        let model = toml_string(&source, "model").unwrap_or_else(|| DEFAULT_MODEL.into());
        let model_provider =
            toml_string(&source, "model_provider").unwrap_or_else(|| DEFAULT_PROVIDER.into());
        let section = provider_section(&source, &model_provider);
        let base_url = toml_string(&section, "base_url").unwrap_or_else(|| DEFAULT_BASE_URL.into());
        let env_key = toml_string(&section, "env_key").unwrap_or_else(|| DEFAULT_ENV_KEY.into());
        write_config(&target, &model, &model_provider, &base_url, &env_key)?;
    }
    Ok(target)
}

pub fn read_settings(codex_home: &Path) -> Result<Settings, String> {
    ensure_config(codex_home)?;
    let source = fs::read_to_string(codex_home.join("config.toml")).unwrap_or_default();
    let model = toml_string(&source, "model").unwrap_or_else(|| DEFAULT_MODEL.into());
    let model_provider =
        toml_string(&source, "model_provider").unwrap_or_else(|| DEFAULT_PROVIDER.into());
    let section = provider_section(&source, &model_provider);
    let base_url = toml_string(&section, "base_url").unwrap_or_else(|| DEFAULT_BASE_URL.into());
    let env_key = toml_string(&section, "env_key").unwrap_or_else(|| DEFAULT_ENV_KEY.into());
    Ok(Settings {
        model,
        model_provider,
        base_url,
        env_key: env_key.clone(),
        api_key_configured: resolve_secret(&env_key).map(|key| !key.is_empty()).unwrap_or(false),
        codex_home: codex_home.display().to_string(),
        workspace: read_ui_state().workspace.or_else(|| {
            default_workspace().map(|path| path.display().to_string())
        }),
    })
}

pub fn save_settings(codex_home: &Path, patch: SettingsPatch) -> Result<Settings, String> {
    let mut current = read_settings(codex_home)?;
    if let Some(model) = patch.model {
        let trimmed = model.trim();
        if !trimmed.is_empty() {
            current.model = trimmed.to_string();
        }
    }
    if let Some(base_url) = patch.base_url {
        let trimmed = base_url.trim();
        if !trimmed.is_empty() {
            current.base_url = trimmed.to_string();
        }
    }
    if let Some(api_key) = patch.api_key {
        let trimmed = normalize_secret(&api_key);
        if !trimmed.is_empty() {
            store_api_key(&trimmed)?;
            let readback = resolve_secret(&current.env_key)?;
            if readback != trimmed {
                return Err("密钥已写入，但无法读回。请重试保存。".into());
            }
        }
    }
    if let Some(workspace) = patch.workspace {
        let trimmed = workspace.trim();
        current.workspace = if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_string())
        };
        write_ui_state(&UiState {
            workspace: current.workspace.clone(),
        })?;
    }
    write_config(
        &codex_home.join("config.toml"),
        &current.model,
        &current.model_provider,
        &current.base_url,
        &current.env_key,
    )?;
    read_settings(codex_home)
}

pub fn store_api_key(value: &str) -> Result<(), String> {
    let value = normalize_secret(value);
    if value.is_empty() {
        return Err("API Key 不能为空".into());
    }
    cache_secret(DEFAULT_ENV_KEY, &value);
    cache_secret(API_KEY_ACCOUNT, &value);
    write_secret_file(DEFAULT_ENV_KEY, &value);
    let mut last_error = None;
    let mut stored = false;
    for entry in credential_entries(DEFAULT_ENV_KEY) {
        match entry {
            Ok(entry) => match entry.set_password(&value) {
                Ok(()) => stored = true,
                Err(err) => last_error = Some(err.to_string()),
            },
            Err(err) => last_error = Some(err),
        }
    }
    if stored {
        log_event("api key stored in keyring");
    } else {
        log_event(&format!(
            "keyring store failed ({}); using encrypted local fallback",
            last_error.unwrap_or_else(|| "unknown".into())
        ));
    }
    Ok(())
}

pub fn read_api_key() -> Result<String, String> {
    resolve_secret(DEFAULT_ENV_KEY)
}

pub fn resolve_secret(env_key: &str) -> Result<String, String> {
    if let Some(value) = cached_secret(env_key).or_else(|| cached_secret(DEFAULT_ENV_KEY)) {
        return Ok(value);
    }
    for entry in credential_entries(env_key) {
        match entry {
            Ok(entry) => match entry.get_password() {
                Ok(value) => {
                    let value = normalize_secret(&value);
                    if !value.is_empty() {
                        cache_secret(env_key, &value);
                        return Ok(value);
                    }
                }
                Err(keyring::Error::NoEntry) => {}
                Err(err) => tracing::warn!("keyring read failed: {err}"),
            },
            Err(err) => tracing::warn!("keyring entry failed: {err}"),
        }
    }
    if let Some(value) = read_secret_file(env_key).or_else(|| read_secret_file(DEFAULT_ENV_KEY)) {
        cache_secret(env_key, &value);
        return Ok(value);
    }
    Ok(std::env::var(env_key)
        .ok()
        .map(|value| normalize_secret(&value))
        .unwrap_or_default())
}

fn credential_entries(env_key: &str) -> Vec<Result<Entry, String>> {
    vec![
        Entry::new_with_target("local-codex-api-key", SERVICE, "api-key").map_err(|err| err.to_string()),
        Entry::new(SERVICE, env_key).map_err(|err| err.to_string()),
        Entry::new(SERVICE, API_KEY_ACCOUNT).map_err(|err| err.to_string()),
    ]
}

fn secret_cache() -> &'static Mutex<HashMap<String, String>> {
    static CACHE: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn cache_secret(env_key: &str, value: &str) {
    if let Ok(mut guard) = secret_cache().lock() {
        guard.insert(env_key.to_string(), value.to_string());
    }
}

fn cached_secret(env_key: &str) -> Option<String> {
    secret_cache()
        .lock()
        .ok()
        .and_then(|guard| guard.get(env_key).cloned())
        .filter(|value| !value.is_empty())
}

fn normalize_secret(value: &str) -> String {
    value
        .trim()
        .trim_start_matches('\u{feff}')
        .trim_matches(|ch: char| ch.is_whitespace() || ch == '\0')
        .to_string()
}

pub fn log_event(message: &str) {
    let path = default_base_dir().join("local-codex").join("engine.log");
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let line = format!("{} {message}\n", now_stamp());
    if let Ok(mut file) = fs::OpenOptions::new().create(true).append(true).open(path) {
        use std::io::Write;
        let _ = file.write_all(line.as_bytes());
    }
}

fn now_stamp() -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    now.to_string()
}

fn secrets_path() -> PathBuf {
    default_base_dir().join("local-codex").join("secrets.json")
}

fn write_secret_file(env_key: &str, value: &str) {
    let mut map = read_secret_map();
    match protect_bytes(value.as_bytes()) {
        Ok(blob) => {
            map.insert(env_key.to_string(), to_hex(&blob));
            if let Ok(json) = serde_json::to_string(&map) {
                if let Some(parent) = secrets_path().parent() {
                    let _ = fs::create_dir_all(parent);
                }
                let _ = fs::write(secrets_path(), json);
            }
        }
        Err(err) => log_event(&format!("secret file protect failed: {err}")),
    }
}

fn read_secret_file(env_key: &str) -> Option<String> {
    let map = read_secret_map();
    let hex = map.get(env_key)?;
    let blob = from_hex(hex)?;
    let bytes = unprotect_bytes(&blob).ok()?;
    let value = normalize_secret(&String::from_utf8_lossy(&bytes));
    if value.is_empty() {
        None
    } else {
        Some(value)
    }
}

fn read_secret_map() -> HashMap<String, String> {
    fs::read_to_string(secrets_path())
        .ok()
        .and_then(|source| serde_json::from_str(&source).ok())
        .unwrap_or_default()
}

fn to_hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn from_hex(value: &str) -> Option<Vec<u8>> {
    if value.len() % 2 != 0 {
        return None;
    }
    (0..value.len())
        .step_by(2)
        .map(|index| u8::from_str_radix(&value[index..index + 2], 16).ok())
        .collect()
}

#[cfg(windows)]
fn protect_bytes(bytes: &[u8]) -> Result<Vec<u8>, String> {
    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::Security::Cryptography::{CryptProtectData, CRYPT_INTEGER_BLOB};
    let input = CRYPT_INTEGER_BLOB {
        cbData: bytes.len() as u32,
        pbData: bytes.as_ptr() as *mut u8,
    };
    let mut output = CRYPT_INTEGER_BLOB {
        cbData: 0,
        pbData: std::ptr::null_mut(),
    };
    let ok = unsafe {
        CryptProtectData(
            &input,
            std::ptr::null(),
            std::ptr::null(),
            std::ptr::null_mut(),
            std::ptr::null(),
            0,
            &mut output,
        )
    };
    if ok == 0 {
        return Err("CryptProtectData failed".into());
    }
    let blob = unsafe { std::slice::from_raw_parts(output.pbData, output.cbData as usize) }.to_vec();
    unsafe {
        LocalFree(output.pbData as *mut std::ffi::c_void);
    }
    Ok(blob)
}

#[cfg(windows)]
fn unprotect_bytes(bytes: &[u8]) -> Result<Vec<u8>, String> {
    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::Security::Cryptography::{CryptUnprotectData, CRYPT_INTEGER_BLOB};
    let input = CRYPT_INTEGER_BLOB {
        cbData: bytes.len() as u32,
        pbData: bytes.as_ptr() as *mut u8,
    };
    let mut output = CRYPT_INTEGER_BLOB {
        cbData: 0,
        pbData: std::ptr::null_mut(),
    };
    let ok = unsafe {
        CryptUnprotectData(
            &input,
            std::ptr::null_mut(),
            std::ptr::null(),
            std::ptr::null_mut(),
            std::ptr::null(),
            0,
            &mut output,
        )
    };
    if ok == 0 {
        return Err("CryptUnprotectData failed".into());
    }
    let blob = unsafe { std::slice::from_raw_parts(output.pbData, output.cbData as usize) }.to_vec();
    unsafe {
        LocalFree(output.pbData as *mut std::ffi::c_void);
    }
    Ok(blob)
}

#[cfg(not(windows))]
fn protect_bytes(bytes: &[u8]) -> Result<Vec<u8>, String> {
    Ok(bytes.to_vec())
}

#[cfg(not(windows))]
fn unprotect_bytes(bytes: &[u8]) -> Result<Vec<u8>, String> {
    Ok(bytes.to_vec())
}

pub fn ensure_workspace(codex_home: &Path) -> Result<Settings, String> {
    let settings = read_settings(codex_home)?;
    if read_ui_state().workspace.is_some() {
        return Ok(settings);
    }
    let Some(path) = settings.workspace.clone() else {
        return Ok(settings);
    };
    save_settings(
        codex_home,
        SettingsPatch {
            workspace: Some(path),
            ..SettingsPatch::default()
        },
    )
}

pub fn default_workspace() -> Option<PathBuf> {
    let repo = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..");
    if let Ok(path) = fs::canonicalize(&repo) {
        if path.join("src-tauri").is_dir() || path.join("ui").is_dir() {
            return Some(path);
        }
    }
    dirs::document_dir().or_else(dirs::home_dir)
}

fn write_config(
    target: &Path,
    model: &str,
    provider: &str,
    base_url: &str,
    env_key: &str,
) -> Result<(), String> {
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).map_err(|err| err.to_string())?;
    }
    let model = escape_toml(model);
    let provider = escape_toml(provider);
    let base_url = escape_toml(base_url);
    let env_key = escape_toml(env_key);
    let toml = format!(
        "model = \"{model}\"\nmodel_provider = \"{provider}\"\napproval_policy = \"on-request\"\nsandbox_mode = \"workspace-write\"\nanalytics = {{ enabled = false }}\n\n[model_providers.{provider}]\nname = \"{provider}\"\nbase_url = \"{base_url}\"\nenv_key = \"{env_key}\"\nwire_api = \"responses\"\nrequires_openai_auth = false\n"
    );
    fs::write(target, toml).map_err(|err| err.to_string())
}

fn read_ui_state() -> UiState {
    let path = ui_state_path();
    fs::read_to_string(path)
        .ok()
        .and_then(|source| serde_json::from_str(&source).ok())
        .unwrap_or_default()
}

fn write_ui_state(state: &UiState) -> Result<(), String> {
    let path = ui_state_path();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|err| err.to_string())?;
    }
    fs::write(path, serde_json::to_string_pretty(state).map_err(|err| err.to_string())?)
        .map_err(|err| err.to_string())
}

fn toml_string(source: &str, key: &str) -> Option<String> {
    let prefix = format!("{key} =");
    for line in source.lines() {
        let trimmed = line.trim();
        if let Some(rest) = trimmed.strip_prefix(&prefix) {
            return Some(unquote(rest.trim()));
        }
    }
    None
}

fn provider_section(source: &str, provider: &str) -> String {
    let header = format!("[model_providers.{provider}]");
    let mut taking = false;
    let mut out = String::new();
    for line in source.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with('[') {
            taking = trimmed.eq_ignore_ascii_case(&header);
            continue;
        }
        if taking {
            out.push_str(line);
            out.push('\n');
        }
    }
    out
}

fn unquote(value: &str) -> String {
    let trimmed = value.trim().trim_matches('"').trim_matches('\'');
    trimmed.to_string()
}

fn escape_toml(value: &str) -> String {
    value.replace('\\', "\\\\").replace('"', "\\\"")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn memory_secret_roundtrip() {
        let key = format!("LOCAL_CODEX_TEST_KEY_{}", std::process::id());
        cache_secret(&key, "probe-value");
        assert_eq!(resolve_secret(&key).unwrap(), "probe-value");
        assert_eq!(normalize_secret("  sk-abc\r\n"), "sk-abc");
    }

    #[test]
    fn dpapi_blob_roundtrip() {
        let original = b"probe-secret-value";
        let blob = protect_bytes(original).expect("protect");
        let back = unprotect_bytes(&blob).expect("unprotect");
        assert_eq!(back, original);
    }
}
