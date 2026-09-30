use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Nonce};
use base64::Engine as _;
use keyring::Entry;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};

static MOCK_ACTIVE: AtomicBool = AtomicBool::new(false);

const SERVICE: &str = "local-codex";
const API_KEY_ACCOUNT: &str = "DEEPSEEK_API_KEY";
const DEFAULT_MODEL: &str = "deepseek-flash";
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

pub fn app_root() -> PathBuf {
    if let Ok(value) = std::env::var("LOCAL_CODEX_HOME") {
        let trimmed = value.trim();
        if !trimmed.is_empty() {
            return PathBuf::from(trimmed);
        }
    }
    default_base_dir().join("local-codex")
}

pub fn engine_home() -> PathBuf {
    let modern = app_root().join("engine");
    let legacy = app_root().join("codex-home");
    if modern.exists() || !legacy.exists() {
        modern
    } else {
        legacy
    }
}

pub fn resolve_codex_home() -> PathBuf {
    engine_home()
}

pub fn copy_file_if_absent(source: &Path, dest: &Path) -> bool {
    if dest.exists() || !source.is_file() {
        return false;
    }
    if let Some(parent) = dest.parent() {
        let _ = fs::create_dir_all(parent);
    }
    fs::copy(source, dest).is_ok()
}

pub fn mock_requested() -> bool {
    if std::env::args().any(|arg| arg == "--mock") {
        return true;
    }
    matches!(
        std::env::var("LOCAL_CODEX_MOCK").as_deref(),
        Ok("1") | Ok("true") | Ok("TRUE") | Ok("yes") | Ok("YES")
    )
}

pub fn set_mock_active(value: bool) {
    MOCK_ACTIVE.store(value, Ordering::SeqCst);
}

pub fn mock_active() -> bool {
    MOCK_ACTIVE.load(Ordering::SeqCst)
}

pub fn is_packaged() -> bool {
    match std::env::current_exe() {
        Ok(exe) => {
            let text = exe.to_string_lossy();
            let unpackaged = text.contains(r"\target\debug")
                || text.contains(r"\target\release")
                || text.contains("/target/debug")
                || text.contains("/target/release");
            !unpackaged
        }
        Err(_) => !cfg!(debug_assertions),
    }
}

pub fn mock_script() -> Option<PathBuf> {
    let mut roots = Vec::new();
    if let Ok(cwd) = std::env::current_dir() {
        roots.push(cwd.join("mock").join("mock-app-server.mjs"));
        roots.push(cwd.join("..").join("mock").join("mock-app-server.mjs"));
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            roots.push(dir.join("mock").join("mock-app-server.mjs"));
            roots.push(dir.join("resources").join("mock").join("mock-app-server.mjs"));
            roots.push(
                dir.join("..")
                    .join("..")
                    .join("..")
                    .join("mock")
                    .join("mock-app-server.mjs"),
            );
        }
    }
    roots.push(
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("mock")
            .join("mock-app-server.mjs"),
    );
    roots.into_iter().find(|path| path.is_file())
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
    app_root().join("ui-state.json")
}

const BUNDLED_MODELS_JSON: &str = include_str!("../resources/models.json");
const BASE_INSTRUCTIONS: &str = include_str!("../resources/base-instructions.md");

pub fn ensure_config(codex_home: &Path) -> Result<PathBuf, String> {
    fs::create_dir_all(codex_home).map_err(|err| err.to_string())?;
    install_bundled_model_catalog(codex_home)?;
    let target = codex_home.join("config.toml");
    if !target.exists() {
        write_config(
            &target,
            &preferred_catalog_model(""),
            DEFAULT_PROVIDER,
            DEFAULT_BASE_URL,
            DEFAULT_ENV_KEY,
        )?;
        return Ok(target);
    }
    let mut source = fs::read_to_string(&target).unwrap_or_default();
    if !source.contains("approval_policy")
        || source.contains("approval_policy = \"untrusted\"")
        || source.contains("preferred_auth_method")
        || !source.contains("sandbox_mode")
        || !source.contains("requires_openai_auth")
    {
        let model = toml_string(&source, "model").unwrap_or_else(|| DEFAULT_MODEL.into());
        let model_provider = canonical_model_provider(
            &toml_string(&source, "model_provider").unwrap_or_else(|| DEFAULT_PROVIDER.into()),
        );
        let section = provider_section(&source, &model_provider);
        let fallback = provider_section(&source, DEFAULT_PROVIDER);
        let section = if section.is_empty() { fallback } else { section };
        let base_url = toml_string(&section, "base_url").unwrap_or_else(|| DEFAULT_BASE_URL.into());
        let env_key = toml_string(&section, "env_key").unwrap_or_else(|| DEFAULT_ENV_KEY.into());
        write_config(&target, &model, &model_provider, &base_url, &env_key)?;
        source = fs::read_to_string(&target).unwrap_or_default();
    }
    let current_provider =
        toml_string(&source, "model_provider").unwrap_or_else(|| DEFAULT_PROVIDER.into());
    let canonical_provider = canonical_model_provider(&current_provider);
    if canonical_provider != current_provider
        || leftover_slug_provider_tables(&source)
        || missing_catalog_aliases(&source)
    {
        let model = toml_string(&source, "model").unwrap_or_else(|| DEFAULT_MODEL.into());
        let section = provider_section(&source, &canonical_provider);
        let stale = provider_section(&source, &current_provider);
        let fallback = provider_section(&source, DEFAULT_PROVIDER);
        let section = if !section.is_empty() {
            section
        } else if !stale.is_empty() {
            stale
        } else {
            fallback
        };
        let base_url = toml_string(&section, "base_url").unwrap_or_else(|| DEFAULT_BASE_URL.into());
        let env_key = toml_string(&section, "env_key").unwrap_or_else(|| DEFAULT_ENV_KEY.into());
        write_config(&target, &model, &canonical_provider, &base_url, &env_key)?;
        if canonical_provider != current_provider {
            log_event(&format!(
                "rewrote model_provider {current_provider} -> {canonical_provider}"
            ));
        }
        source = fs::read_to_string(&target).unwrap_or_default();
    }
    if !source.contains("[sandbox_workspace_write]") {
        if !source.ends_with('\n') {
            source.push('\n');
        }
        source.push_str("\n[sandbox_workspace_write]\nnetwork_access = true\n");
        fs::write(&target, &source).map_err(|err| err.to_string())?;
    }
    let current_model = toml_string(&source, "model").unwrap_or_default();
    let preferred = preferred_catalog_model(&current_model);
    if preferred != current_model {
        source = replace_toml_string(&source, "model", &preferred);
    }
    source = sync_model_catalog_json(&source, codex_home);
    if source != fs::read_to_string(&target).unwrap_or_default() {
        fs::write(&target, source).map_err(|err| err.to_string())?;
    }
    Ok(target)
}

pub fn default_model() -> &'static str {
    DEFAULT_MODEL
}

pub fn models_json_path() -> Option<PathBuf> {
    for source in config_toml_sources() {
        if let Some(path) = configured_model_catalog_path(&source) {
            if path.is_file() {
                return Some(path);
            }
        }
    }
    models_json_candidates()
        .into_iter()
        .find(|path| path.is_file())
}

fn config_toml_sources() -> Vec<String> {
    [
        engine_home().join("config.toml"),
        app_root().join("codex-home").join("config.toml"),
        app_root().join("engine").join("config.toml"),
    ]
    .into_iter()
    .filter_map(|path| fs::read_to_string(path).ok())
    .collect()
}

fn configured_model_catalog_path(source: &str) -> Option<PathBuf> {
    let raw = toml_string(source, "model_catalog_json")?;
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(PathBuf::from(trimmed))
    }
}

fn models_json_candidates() -> Vec<PathBuf> {
    let mut candidates = vec![
        engine_home().join("models.json"),
        app_root().join("codex-home").join("models.json"),
        app_root().join("engine").join("models.json"),
        app_root().join("models.json"),
    ];
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    candidates.push(manifest.join("models.json"));
    candidates.push(manifest.join("resources").join("models.json"));
    candidates
}

fn resolve_catalog_path(raw: &str, codex_home: &Path) -> PathBuf {
    let path = PathBuf::from(raw.trim());
    if path.is_absolute() {
        path
    } else {
        codex_home.join(path)
    }
}

const BUNDLED_CATALOG_VERSION: i64 = 4;

fn install_bundled_model_catalog(codex_home: &Path) -> Result<(), String> {
    let target = codex_home.join("models.json");
    let current = fs::read_to_string(&target).unwrap_or_default();
    if !should_refresh_app_catalog(&current) {
        return Ok(());
    }
    fs::write(&target, catalog_json_for_engine()?).map_err(|err| err.to_string())
}

/// Codex rejects a catalog model that has neither `base_instructions` nor
/// `model_messages.instructions_template`, and that failure aborts config load.
fn catalog_json_for_engine() -> Result<String, String> {
    let mut value: Value =
        serde_json::from_str(BUNDLED_MODELS_JSON).map_err(|err| err.to_string())?;
    if let Some(object) = value.as_object_mut() {
        object.insert(
            "local_codex_catalog".into(),
            json!(BUNDLED_CATALOG_VERSION),
        );
    }
    if let Some(models) = value.get_mut("models").and_then(Value::as_array_mut) {
        for model in models {
            let Some(object) = model.as_object_mut() else {
                continue;
            };
            let has_template = object
                .get("model_messages")
                .and_then(|messages| messages.get("instructions_template"))
                .and_then(Value::as_str)
                .is_some();
            let has_base = object
                .get("base_instructions")
                .and_then(Value::as_str)
                .is_some();
            if !has_template && !has_base {
                object.insert("base_instructions".into(), json!(BASE_INSTRUCTIONS));
            }
        }
    }
    serde_json::to_string_pretty(&value).map_err(|err| err.to_string())
}

fn should_refresh_app_catalog(current: &str) -> bool {
    if current.trim().is_empty() {
        return true;
    }
    let Ok(value) = serde_json::from_str::<Value>(current) else {
        return false;
    };
    let version = value
        .get("local_codex_catalog")
        .and_then(Value::as_i64)
        .unwrap_or(0);
    if version > 0 {
        return version < BUNDLED_CATALOG_VERSION;
    }
    let Some(models) = value.get("models").and_then(Value::as_array) else {
        return false;
    };
    let legacy = ["deepseek-flash", "deepseek-v4-pro"];
    let slugs: Vec<&str> = models
        .iter()
        .filter_map(|item| item.get("slug").and_then(Value::as_str))
        .collect();
    !slugs.is_empty() && slugs.iter().all(|slug| legacy.contains(slug))
}

/// Codex refuses `thread/start` with `failed to load configuration` (os error 2)
/// when `model_catalog_json` points at a file that is not on this machine.
/// Prefer a real file, then the catalog installed into this engine home.
fn existing_catalog_path(source: &str, codex_home: &Path) -> Option<PathBuf> {
    if let Some(raw) = toml_string(source, "model_catalog_json") {
        let path = resolve_catalog_path(&raw, codex_home);
        if path.is_file() {
            return Some(path);
        }
    }
    let bundled = codex_home.join("models.json");
    if bundled.is_file() {
        return Some(bundled);
    }
    models_json_candidates()
        .into_iter()
        .find(|path| path.is_file())
}

fn sync_model_catalog_json(source: &str, codex_home: &Path) -> String {
    let mut without = source
        .lines()
        .filter(|line| {
            let trimmed = line.trim();
            !(trimmed.starts_with("model_catalog_json") && trimmed.contains('='))
        })
        .collect::<Vec<_>>()
        .join("\n");
    if !without.is_empty() && !without.ends_with('\n') {
        without.push('\n');
    }
    let Some(path) = existing_catalog_path(source, codex_home) else {
        return without;
    };
    let assignment = format!(
        "model_catalog_json = \"{}\"\n",
        escape_toml(&toml_path(&path))
    );
    if let Some(index) = without.find("\n[") {
        let (head, tail) = without.split_at(index + 1);
        format!("{head}{assignment}{tail}")
    } else {
        without.push_str(&assignment);
        without
    }
}

fn toml_path(path: &Path) -> String {
    path.display().to_string().replace('\\', "/")
}

fn preset_owners(slug: &str) -> Vec<String> {
    let mut owners: Vec<String> = provider_presets()
        .into_iter()
        .filter(|spec| spec.default_model == slug)
        .map(|spec| spec.id)
        .collect();
    if matches!(slug, "deepseek-flash" | "deepseek-v4-pro")
        && !owners.iter().any(|id| id == DEFAULT_PROVIDER)
    {
        owners.push(DEFAULT_PROVIDER.to_string());
    }
    owners
}

fn models_for_provider(data: Vec<Value>, provider: &str, configured: &str) -> Vec<Value> {
    let provider = canonical_model_provider(provider);
    let matched: Vec<Value> = data
        .into_iter()
        .filter(|item| {
            let slug = item.get("model").and_then(Value::as_str).unwrap_or("");
            preset_owners(slug).iter().any(|id| id == &provider)
        })
        .collect();
    if !matched.is_empty() {
        return matched;
    }
    let owners = preset_owners(configured);
    if configured.is_empty() || (!owners.is_empty() && !owners.iter().any(|id| id == &provider)) {
        return Vec::new();
    }
    vec![provider_model(
        configured,
        configured,
        "",
        true,
        "high",
        &[],
        &["text"],
    )]
}

pub fn provider_model_catalog() -> Value {
    let source = fs::read_to_string(engine_home().join("config.toml")).unwrap_or_default();
    let configured = toml_string(&source, "model").unwrap_or_default();
    let provider = toml_string(&source, "model_provider").unwrap_or_else(|| DEFAULT_PROVIDER.into());
    let data = catalog_from_models_file(&configured).unwrap_or_else(|| {
        vec![
            provider_model(
                "deepseek-flash",
                "DeepSeek-Flash",
                "Latest frontier agentic coding model with image input.",
                configured == "deepseek-flash" || configured.is_empty(),
                "high",
                &[
                    ("low", "Fast responses with lighter reasoning"),
                    ("high", "Extra high reasoning depth for complex problems"),
                    ("ultra", "Maximum reasoning depth for the hardest problems"),
                ],
                &["text", "image"],
            ),
            provider_model(
                "deepseek-v4-pro",
                "DeepSeek-V4-Pro",
                "High-capability DeepSeek coding model.",
                configured == "deepseek-v4-pro",
                "high",
                &[("low", "低"), ("high", "高"), ("ultra", "Ultra")],
                &["text"],
            ),
        ]
    });
    let data = models_for_provider(data, &provider, &configured);
    json!({ "data": data, "nextCursor": Value::Null })
}

fn catalog_from_models_file(configured: &str) -> Option<Vec<Value>> {
    let path = models_json_path()?;
    let source: Value = serde_json::from_str(&fs::read_to_string(path).ok()?).ok()?;
    catalog_from_models_json(&source, configured)
}

fn catalog_from_models_json(source: &Value, configured: &str) -> Option<Vec<Value>> {
    let models = source.get("models")?.as_array()?;
    let mut ranked: Vec<(i64, Value)> = Vec::new();
    for item in models {
        let visibility = item
            .get("visibility")
            .and_then(Value::as_str)
            .unwrap_or("list");
        if visibility != "list" {
            continue;
        }
        let Some(slug) = item.get("slug").and_then(Value::as_str).filter(|value| !value.trim().is_empty()) else {
            continue;
        };
        let display_name = item
            .get("display_name")
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
            .unwrap_or(slug);
        let description = item
            .get("description")
            .and_then(Value::as_str)
            .unwrap_or("");
        let default_effort = map_reasoning_effort(
            item.get("default_reasoning_level")
                .and_then(Value::as_str)
                .unwrap_or("medium"),
        );
        let efforts: Vec<(String, String)> = item
            .get("supported_reasoning_levels")
            .and_then(Value::as_array)
            .map(|levels| {
                levels
                    .iter()
                    .filter_map(|level| {
                        let effort = map_reasoning_effort(level.get("effort").and_then(Value::as_str)?);
                        let description = level
                            .get("description")
                            .and_then(Value::as_str)
                            .unwrap_or(effort.as_str())
                            .to_string();
                        Some((effort, description))
                    })
                    .collect()
            })
            .unwrap_or_default();
        let effort_refs: Vec<(&str, &str)> = efforts
            .iter()
            .map(|(effort, description)| (effort.as_str(), description.as_str()))
            .collect();
        let modalities: Vec<String> = item
            .get("input_modalities")
            .and_then(Value::as_array)
            .map(|values| {
                values
                    .iter()
                    .filter_map(Value::as_str)
                    .map(str::to_string)
                    .collect()
            })
            .unwrap_or_else(|| vec!["text".into()]);
        let modality_refs: Vec<&str> = modalities.iter().map(String::as_str).collect();
        let is_default = slug == configured;
        let priority = item.get("priority").and_then(Value::as_i64).unwrap_or(100);
        ranked.push((
            priority,
            provider_model(
                slug,
                display_name,
                description,
                is_default,
                &default_effort,
                &effort_refs,
                &modality_refs,
            ),
        ));
    }
    if ranked.is_empty() {
        return None;
    }
    ranked.sort_by_key(|(priority, _)| *priority);
    let mut data: Vec<Value> = ranked.into_iter().map(|(_, item)| item).collect();
    if !data.iter().any(|item| item.get("isDefault") == Some(&json!(true))) {
        if let Some(first) = data.first_mut().and_then(Value::as_object_mut) {
            first.insert("isDefault".into(), json!(true));
        }
    }
    Some(data)
}

fn map_reasoning_effort(value: &str) -> String {
    match value {
        "max" => "ultra".into(),
        other => other.to_string(),
    }
}

fn catalog_slugs() -> Vec<String> {
    catalog_from_models_file("")
        .unwrap_or_default()
        .iter()
        .filter_map(|item| {
            item.get("model")
                .and_then(Value::as_str)
                .map(str::to_string)
        })
        .collect()
}

fn is_catalog_model_slug(value: &str) -> bool {
    catalog_provider_aliases().iter().any(|slug| *slug == value)
}

pub fn canonical_model_provider(provider: &str) -> String {
    let trimmed = provider.trim();
    if trimmed.is_empty() || is_catalog_model_slug(trimmed) {
        DEFAULT_PROVIDER.to_string()
    } else {
        trimmed.to_string()
    }
}

fn leftover_slug_provider_tables(source: &str) -> bool {
    let provider = toml_string(source, "model_provider").unwrap_or_default();
    is_catalog_model_slug(&provider)
        || source.lines().any(|line| {
            provider_table_name(line.trim()).is_some_and(|name| {
                !is_catalog_model_slug(name) && canonical_model_provider(name) != name
            })
        })
}

fn catalog_provider_aliases() -> &'static [&'static str] {
    &["deepseek-flash", "deepseek-v4-pro"]
}

fn missing_catalog_aliases(source: &str) -> bool {
    let provider = toml_string(source, "model_provider").unwrap_or_default();
    if canonical_model_provider(&provider) != DEFAULT_PROVIDER {
        return false;
    }
    catalog_provider_aliases()
        .iter()
        .any(|slug| !source.contains(&format!("[model_providers.{slug}]")))
}

fn render_catalog_alias_tables(provider: &str, base_url: &str, env_key: &str) -> String {
    if provider != DEFAULT_PROVIDER {
        return String::new();
    }
    let mut out = String::new();
    for slug in catalog_provider_aliases() {
        out.push_str(&format!(
            "\n[model_providers.{slug}]\nname = \"{provider}\"\nbase_url = \"{base_url}\"\nenv_key = \"{env_key}\"\nwire_api = \"responses\"\nrequires_openai_auth = false\n"
        ));
    }
    out
}

fn provider_table_name(header: &str) -> Option<&str> {
    header
        .strip_prefix("[model_providers.")
        .and_then(|rest| rest.strip_suffix(']'))
}

fn preferred_catalog_model(configured: &str) -> String {
    let slugs = catalog_slugs();
    if slugs.iter().any(|slug| slug == configured) {
        return configured.to_string();
    }
    slugs
        .into_iter()
        .next()
        .unwrap_or_else(|| DEFAULT_MODEL.to_string())
}

fn replace_toml_string(source: &str, key: &str, value: &str) -> String {
    let prefix = format!("{key} =");
    let mut found = false;
    let mut out = String::new();
    for line in source.lines() {
        if !found && line.trim().starts_with(&prefix) {
            out.push_str(&format!("{key} = \"{}\"", escape_toml(value)));
            found = true;
        } else {
            out.push_str(line);
        }
        out.push('\n');
    }
    if found {
        out
    } else {
        format!("{key} = \"{}\"\n{source}", escape_toml(value))
    }
}

fn provider_model(
    id: &str,
    display_name: &str,
    description: &str,
    is_default: bool,
    default_effort: &str,
    efforts: &[(&str, &str)],
    modalities: &[&str],
) -> Value {
    let supported: Vec<Value> = if efforts.is_empty() {
        vec![
            json!({ "reasoningEffort": "low", "description": "低" }),
            json!({ "reasoningEffort": "medium", "description": "中" }),
            json!({ "reasoningEffort": "high", "description": "高" }),
        ]
    } else {
        efforts
            .iter()
            .map(|(effort, description)| {
                json!({ "reasoningEffort": effort, "description": description })
            })
            .collect()
    };
    json!({
        "id": id,
        "model": id,
        "name": display_name,
        "upgrade": null,
        "upgradeInfo": null,
        "availabilityNux": null,
        "displayName": display_name,
        "display_name": display_name,
        "description": description,
        "modelSpecialty": null,
        "hidden": false,
        "supportedReasoningEfforts": supported,
        "defaultReasoningEffort": default_effort,
        "inputModalities": modalities,
        "supportsPersonality": false,
        "multiAgentVersion": null,
        "additionalSpeedTiers": [],
        "serviceTiers": [],
        "defaultServiceTier": null,
        "availableAccessPrograms": null,
        "isDefault": is_default,
    })
}

#[derive(Debug, Clone)]
pub struct CompletionProfile {
    pub model: String,
    pub base_url: String,
    pub api_key: String,
    pub wire_api: String,
}

pub fn completion_profile() -> Result<CompletionProfile, String> {
    let settings = read_settings(&engine_home())?;
    let api_key = resolve_secret(&settings.env_key).unwrap_or_default();
    if api_key.trim().is_empty() {
        return Err("还没有配置模型密钥，无法生成提交说明".into());
    }
    let source = fs::read_to_string(engine_home().join("config.toml")).unwrap_or_default();
    let section = {
        let primary = provider_section(&source, &settings.model_provider);
        if primary.is_empty() {
            provider_section(&source, DEFAULT_PROVIDER)
        } else {
            primary
        }
    };
    Ok(CompletionProfile {
        model: settings.model,
        base_url: settings.base_url,
        api_key,
        wire_api: toml_string(&section, "wire_api").unwrap_or_else(|| "responses".into()),
    })
}

pub fn read_settings(codex_home: &Path) -> Result<Settings, String> {
    ensure_config(codex_home)?;
    let source = fs::read_to_string(codex_home.join("config.toml")).unwrap_or_default();
    let model = toml_string(&source, "model").unwrap_or_else(|| DEFAULT_MODEL.into());
    let model_provider = canonical_model_provider(
        &toml_string(&source, "model_provider").unwrap_or_else(|| DEFAULT_PROVIDER.into()),
    );
    let section = provider_section(&source, &model_provider);
    let fallback = provider_section(&source, DEFAULT_PROVIDER);
    let section = if section.is_empty() { fallback } else { section };
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
    store_named_secret(DEFAULT_ENV_KEY, value)
}

pub fn store_named_secret(env_key: &str, value: &str) -> Result<(), String> {
    let value = normalize_secret(value);
    if value.is_empty() {
        return Err("密钥不能为空".into());
    }
    let env_key = env_key.trim();
    if env_key.is_empty() {
        return Err("密钥名称不能为空".into());
    }
    cache_secret(env_key, &value);
    if env_key == DEFAULT_ENV_KEY || env_key == API_KEY_ACCOUNT {
        cache_secret(DEFAULT_ENV_KEY, &value);
        cache_secret(API_KEY_ACCOUNT, &value);
    }
    write_secret_file(env_key, &value);
    let mut last_error = None;
    let mut stored = false;
    for entry in credential_entries(env_key) {
        match entry {
            Ok(entry) => match entry.set_password(&value) {
                Ok(()) => stored = true,
                Err(err) => last_error = Some(err.to_string()),
            },
            Err(err) => last_error = Some(err),
        }
    }
    if stored {
        log_event(&format!("secret stored in keyring for {env_key}"));
    } else {
        log_event(&format!(
            "keyring store failed for {env_key} ({}); using encrypted local fallback",
            last_error.unwrap_or_else(|| "unknown".into())
        ));
    }
    Ok(())
}

pub fn workspace_root() -> PathBuf {
    read_ui_state()
        .workspace
        .map(PathBuf::from)
        .or_else(default_workspace)
        .unwrap_or_else(|| dirs::home_dir().unwrap_or_else(|| PathBuf::from(".")))
}

fn config_source() -> String {
    fs::read_to_string(resolve_codex_home().join("config.toml")).unwrap_or_default()
}

fn normalized_approval_policy(value: Option<&str>) -> String {
    match value.map(str::trim).unwrap_or("") {
        "" | "untrusted" => "on-request".into(),
        other => other.to_string(),
    }
}

fn normalized_sandbox_mode(value: Option<&str>) -> String {
    match value.map(str::trim).unwrap_or("") {
        "read-only" | "danger-full-access" | "workspace-write" => value.unwrap().trim().to_string(),
        _ => "workspace-write".into(),
    }
}

pub fn sandbox_mode() -> String {
    normalized_sandbox_mode(
        toml_string(&config_source(), "sandbox_mode")
            .or_else(|| {
                read_preferences()
                    .get("sandbox_mode")
                    .and_then(Value::as_str)
                    .map(str::to_string)
            })
            .as_deref(),
    )
}

pub fn approval_policy() -> String {
    normalized_approval_policy(
        toml_string(&config_source(), "approval_policy")
            .or_else(|| {
                read_preferences()
                    .get("approval_policy")
                    .and_then(Value::as_str)
                    .map(str::to_string)
            })
            .as_deref(),
    )
}

pub fn engine_policy() -> Value {
    json!({
        "approval_policy": approval_policy(),
        "sandbox_mode": sandbox_mode(),
        "sandbox_workspace_write": { "network_access": sandbox_network() },
    })
}

pub fn apply_local_setting(key: &str, value: &Value) -> Result<(), String> {
    let home = resolve_codex_home();
    ensure_config(&home)?;
    let target = home.join("config.toml");
    let mut source = fs::read_to_string(&target).unwrap_or_default();
    match key {
        "model_provider" => {
            let next = canonical_model_provider(value.as_str().unwrap_or(""));
            source = replace_toml_string(&source, "model_provider", &next);
        }
        "approval_policy" => {
            let next = normalized_approval_policy(value.as_str());
            source = replace_toml_string(&source, "approval_policy", &next);
        }
        "sandbox_mode" => {
            let next = normalized_sandbox_mode(value.as_str());
            source = replace_toml_string(&source, "sandbox_mode", &next);
        }
        "sandbox_workspace_write.network_access" => {
            source = replace_table_bool(&source, "sandbox_workspace_write", "network_access", value.as_bool().unwrap_or(false));
        }
        "computer_enabled" => {
            source = replace_table_bool(
                &source,
                "mcp_servers.computer",
                "enabled",
                value.as_bool().unwrap_or(false),
            );
        }
        "browser_enabled" => {
            source = replace_table_bool(
                &source,
                "mcp_servers.browser",
                "enabled",
                value.as_bool().unwrap_or(false),
            );
        }
        "web_search_enabled" => {
            source = replace_table_bool(
                &source,
                "mcp_servers.web-search",
                "enabled",
                value.as_bool().unwrap_or(false),
            );
        }
        key if key.starts_with("mcp_servers.") && key.ends_with(".enabled") => {
            let table = key.trim_end_matches(".enabled");
            source = replace_table_bool(&source, table, "enabled", value.as_bool().unwrap_or(false));
        }
        _ => return Ok(()),
    }
    fs::write(&target, source).map_err(|err| err.to_string())
}

fn replace_table_string(source: &str, table: &str, key: &str, value: &str) -> String {
    replace_table_line(source, table, key, &format!("{key} = \"{}\"", escape_toml(value)))
}

fn replace_table_bool(source: &str, table: &str, key: &str, value: bool) -> String {
    replace_table_line(
        source,
        table,
        key,
        &format!("{key} = {}", if value { "true" } else { "false" }),
    )
}

fn replace_table_line(source: &str, table: &str, key: &str, rendered: &str) -> String {
    let header = format!("[{table}]");
    let mut out = String::new();
    let mut in_table = false;
    let mut replaced = false;
    for line in source.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with('[') {
            if in_table && !replaced {
                if !out.ends_with('\n') && !out.is_empty() {
                    out.push('\n');
                }
                out.push_str(&rendered);
                out.push('\n');
                replaced = true;
            }
            in_table = trimmed == header;
        }
        if in_table && trimmed.starts_with(&format!("{key} =")) {
            out.push_str(&rendered);
            out.push('\n');
            replaced = true;
            continue;
        }
        out.push_str(line);
        out.push('\n');
    }
    if !replaced {
        if !out.ends_with('\n') && !out.is_empty() {
            out.push('\n');
        }
        out.push_str(&format!("\n{header}\n{rendered}\n"));
    }
    out
}

pub fn sandbox_network() -> bool {
    if let Some(value) = read_preferences()
        .get("sandbox_workspace_write.network_access")
        .and_then(Value::as_bool)
        .or_else(|| {
            read_preferences()
                .pointer("/sandbox_workspace_write/network_access")
                .and_then(Value::as_bool)
        })
    {
        return value;
    }
    sandbox_network_from(&config_source())
}

fn sandbox_network_from(source: &str) -> bool {
    sandbox_network_explicit(source).unwrap_or(true)
}

fn sandbox_network_explicit(source: &str) -> Option<bool> {
    let section = source.split("[sandbox_workspace_write]").nth(1)?;
    for line in section.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with('[') {
            break;
        }
        if let Some(rest) = trimmed.strip_prefix("network_access") {
            return Some(rest.trim().trim_start_matches('=').trim() == "true");
        }
    }
    None
}

pub fn sandbox_policy() -> Value {
    let network = sandbox_network();
    let mut roots = Vec::new();
    let mut seen = HashSet::new();
    for root in crate::workspace::allowed_roots(&workspace_root()) {
        let key = normalize_path_key(&root);
        if !seen.insert(key) {
            continue;
        }
        if root.exists() {
            roots.push(json!(root.display().to_string()));
        }
    }
    match sandbox_mode().as_str() {
        "danger-full-access" => json!({ "type": "dangerFullAccess" }),
        "read-only" => json!({ "type": "readOnly", "networkAccess": network }),
        _ => json!({
            "type": "workspaceWrite",
            "writableRoots": roots,
            "networkAccess": network,
            "excludeTmpdirEnvVar": false,
            "excludeSlashTmp": false
        }),
    }
}

pub fn set_workspace(path: Option<String>) -> Result<String, String> {
    let home = resolve_codex_home();
    let workspace = path.and_then(|value| {
        let trimmed = value.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_string())
        }
    });
    save_settings(
        &home,
        SettingsPatch {
            workspace: Some(workspace.clone().unwrap_or_default()),
            ..SettingsPatch::default()
        },
    )?;
    Ok(workspace.unwrap_or_default())
}

pub fn attachments_root() -> PathBuf {
    let root = std::env::temp_dir().join("local-codex-attachments");
    let _ = fs::create_dir_all(&root);
    root
}

pub fn projectless_workspace_root() -> PathBuf {
    let root = dirs::document_dir()
        .or_else(dirs::home_dir)
        .unwrap_or_else(|| PathBuf::from("."))
        .join("Local Codex");
    let _ = fs::create_dir_all(&root);
    root
}

pub fn engine_log_path() -> PathBuf {
    app_root().join("engine.log")
}

pub fn preferences_path() -> PathBuf {
    app_root().join("preferences.json")
}

fn persist_preferences(value: &Value) -> Result<(), String> {
    if let Some(parent) = preferences_path().parent() {
        fs::create_dir_all(parent).map_err(|err| err.to_string())?;
    }
    fs::write(
        preferences_path(),
        serde_json::to_string_pretty(value).map_err(|err| err.to_string())?,
    )
    .map_err(|err| err.to_string())
}

fn migrate_legacy_preferences() {
    let dest = preferences_path();
    if dest.exists() {
        return;
    }
    let candidates = [
        default_base_dir().join("Local Codex").join("preferences.json"),
        dirs::config_dir()
            .unwrap_or_default()
            .join("Local Codex")
            .join("preferences.json"),
    ];
    for source in candidates {
        if !source.is_file() {
            continue;
        }
        if let Some(parent) = dest.parent() {
            let _ = fs::create_dir_all(parent);
        }
        if fs::copy(&source, &dest).is_ok() {
            log_event(&format!(
                "migrated Electron preferences from {}",
                source.display()
            ));
            return;
        }
    }
}

fn clamp_pref_number(value: &Value, fallback: f64, minimum: f64, maximum: f64) -> Value {
    let parsed = value.as_f64().or_else(|| {
        value
            .as_str()
            .and_then(|text| text.parse::<f64>().ok())
    });
    json!(parsed
        .filter(|number| number.is_finite())
        .map(|number| number.clamp(minimum, maximum))
        .unwrap_or(fallback))
}

fn normalize_preferences(source: Value) -> Value {
    let mut map = match source {
        Value::Object(map) => map,
        _ => Map::new(),
    };
    if !map
        .get("background_images_enabled")
        .map(Value::is_boolean)
        .unwrap_or(false)
    {
        map.insert("background_images_enabled".into(), json!(false));
    }
    if !map
        .get("background_images_directory")
        .map(Value::is_string)
        .unwrap_or(false)
    {
        map.insert("background_images_directory".into(), json!(""));
    }
    let enums = [
        (
            "background_images_order",
            ["随机", "顺序"].as_slice(),
            "随机",
        ),
        (
            "background_images_alignment",
            [
                "左上",
                "顶部居中",
                "右上",
                "左侧居中",
                "居中",
                "右侧居中",
                "左下",
                "底部居中",
                "右下",
            ]
            .as_slice(),
            "居中",
        ),
        (
            "background_images_repeat",
            ["不重复", "重复", "水平重复", "垂直重复"].as_slice(),
            "不重复",
        ),
        (
            "background_images_size",
            ["覆盖", "包含", "原始大小"].as_slice(),
            "覆盖",
        ),
    ];
    for (key, allowed, fallback) in enums {
        let current = map.get(key).and_then(Value::as_str).unwrap_or("");
        if !allowed.contains(&current) {
            map.insert(key.to_string(), json!(fallback));
        }
    }
    map.insert(
        "background_images_blur".into(),
        clamp_pref_number(map.get("background_images_blur").unwrap_or(&Value::Null), 0.0, 0.0, 40.0),
    );
    map.insert(
        "background_images_opacity".into(),
        clamp_pref_number(map.get("background_images_opacity").unwrap_or(&Value::Null), 0.7, 0.0, 1.0),
    );
    map.insert(
        "background_images_foreground_opacity".into(),
        clamp_pref_number(
            map.get("background_images_foreground_opacity")
                .unwrap_or(&Value::Null),
            0.8,
            0.05,
            1.0,
        ),
    );
    map.insert(
        "background_images_interval".into(),
        clamp_pref_number(map.get("background_images_interval").unwrap_or(&Value::Null), 30.0, 1.0, 3600.0),
    );
    Value::Object(map)
}

pub fn read_preferences() -> Value {
    migrate_legacy_preferences();
    let saved = fs::read_to_string(preferences_path())
        .ok()
        .and_then(|source| serde_json::from_str(&source).ok())
        .unwrap_or_else(|| json!({}));
    let normalized = normalize_preferences(saved.clone());
    if normalized != saved {
        let _ = persist_preferences(&normalized);
    }
    normalized
}

pub fn write_preference(key: &str, value: Value) -> Result<Value, String> {
    let mut map = match read_preferences() {
        Value::Object(map) => map,
        _ => Map::new(),
    };
    map.insert(key.to_string(), value.clone());
    let out = normalize_preferences(Value::Object(map));
    persist_preferences(&out)?;
    apply_local_setting(key, &value)?;
    Ok(out)
}

pub fn read_api_key() -> Result<String, String> {
    resolve_secret(DEFAULT_ENV_KEY)
}

pub fn migrate_legacy_secrets() {
    let map = read_secret_map();
    if map.is_empty() {
        return;
    }
    let mut upgraded = Vec::new();
    for (name, stored) in &map {
        if stored.trim().is_empty() {
            continue;
        }
        if decrypt_dpapi_hex(stored).is_some() {
            continue;
        }
        if let Some(plain) = decrypt_chromium_secret(stored) {
            upgraded.push((name.clone(), plain));
        }
    }
    if upgraded.is_empty() {
        return;
    }
    let count = upgraded.len();
    for (name, plain) in upgraded {
        if let Err(err) = store_named_secret(&name, &plain) {
            log_event(&format!("legacy secret migrate failed for {name}: {err}"));
        }
    }
    log_event(&format!("migrated {count} Electron safeStorage secrets"));
}

pub fn resolve_secret(env_key: &str) -> Result<String, String> {
    let env_key = env_key.trim();
    if env_key.is_empty() {
        return Ok(String::new());
    }
    if let Some(value) = cached_secret(env_key) {
        return Ok(value);
    }
    if is_provider_env_key(env_key) {
        if let Some(value) = cached_secret(DEFAULT_ENV_KEY).or_else(|| cached_secret(API_KEY_ACCOUNT)) {
            return Ok(value);
        }
    }
    if let Some(value) = read_named_keyring(env_key) {
        cache_secret(env_key, &value);
        return Ok(value);
    }
    if let Some(value) = read_secret_file(env_key) {
        cache_secret(env_key, &value);
        return Ok(value);
    }
    if is_provider_env_key(env_key) {
        if let Some(value) = read_named_keyring(DEFAULT_ENV_KEY).or_else(|| read_named_keyring(API_KEY_ACCOUNT))
        {
            cache_secret(env_key, &value);
            return Ok(value);
        }
        if let Some(value) = read_secret_file(DEFAULT_ENV_KEY).or_else(|| read_secret_file(API_KEY_ACCOUNT))
        {
            cache_secret(env_key, &value);
            return Ok(value);
        }
        if let Some(value) = read_provider_keyring() {
            cache_secret(env_key, &value);
            return Ok(value);
        }
    }
    Ok(std::env::var(env_key)
        .ok()
        .map(|value| normalize_secret(&value))
        .unwrap_or_default())
}

fn is_provider_env_key(env_key: &str) -> bool {
    env_key == DEFAULT_ENV_KEY || env_key == API_KEY_ACCOUNT
}

pub fn is_engine_api_key(name: &str) -> bool {
    let name = name.trim();
    if name.is_empty() {
        return false;
    }
    if is_provider_env_key(name) {
        return true;
    }
    read_settings(&engine_home())
        .map(|settings| settings.env_key == name)
        .unwrap_or(false)
}

fn credential_entries(env_key: &str) -> Vec<Result<Entry, String>> {
    if is_provider_env_key(env_key) {
        vec![
            Entry::new(SERVICE, DEFAULT_ENV_KEY).map_err(|err| err.to_string()),
            Entry::new(SERVICE, API_KEY_ACCOUNT).map_err(|err| err.to_string()),
            Entry::new_with_target("local-codex-api-key", SERVICE, "api-key")
                .map_err(|err| err.to_string()),
        ]
    } else {
        vec![Entry::new(SERVICE, env_key).map_err(|err| err.to_string())]
    }
}

fn read_named_keyring(env_key: &str) -> Option<String> {
    let entry = Entry::new(SERVICE, env_key).ok()?;
    match entry.get_password() {
        Ok(value) => {
            let value = normalize_secret(&value);
            if value.is_empty() {
                None
            } else {
                Some(value)
            }
        }
        Err(_) => None,
    }
}

fn read_provider_keyring() -> Option<String> {
    let entry = Entry::new_with_target("local-codex-api-key", SERVICE, "api-key").ok()?;
    match entry.get_password() {
        Ok(value) => {
            let value = normalize_secret(&value);
            if value.is_empty() {
                None
            } else {
                Some(value)
            }
        }
        Err(_) => None,
    }
}

pub fn inspect_provider(codex_home: &Path) -> Value {
    match read_settings(codex_home) {
        Ok(settings) => json!({
            "provider": settings.model_provider,
            "baseUrl": settings.base_url,
            "blocked": provider_blocked(&settings.model_provider, &settings.base_url),
        }),
        Err(_) => json!({ "provider": "", "baseUrl": "", "blocked": false }),
    }
}

pub fn provider_blocked(provider: &str, base_url: &str) -> bool {
    if provider.eq_ignore_ascii_case("openai") {
        return true;
    }
    let host = url_hostname(base_url);
    host == "api.openai.com"
        || host.ends_with(".api.openai.com")
        || host == "chatgpt.com"
        || host.ends_with(".chatgpt.com")
}

pub fn url_hostname(value: &str) -> String {
    let value = value.trim();
    if value.is_empty() {
        return String::new();
    }
    let with_scheme = if value.contains("://") {
        value.to_string()
    } else {
        format!("https://{value}")
    };
    with_scheme
        .split("://")
        .nth(1)
        .unwrap_or("")
        .split('/')
        .next()
        .unwrap_or("")
        .split('@')
        .next_back()
        .unwrap_or("")
        .split(':')
        .next()
        .unwrap_or("")
        .to_lowercase()
}

pub fn path_writable(path: &Path) -> bool {
    if !path.exists() {
        return false;
    }
    let probe = path.join(format!(".local-codex-write-{}", std::process::id()));
    match fs::write(&probe, b"") {
        Ok(()) => {
            let _ = fs::remove_file(&probe);
            true
        }
        Err(_) => false,
    }
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
    let path = engine_log_path();
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
    app_root().join("secrets.json")
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
    let stored = map.get(env_key)?;
    if let Some(value) = decrypt_dpapi_hex(stored) {
        return Some(value);
    }
    decrypt_chromium_secret(stored)
}

fn decrypt_dpapi_hex(stored: &str) -> Option<String> {
    let blob = from_hex(stored)?;
    let bytes = unprotect_bytes(&blob).ok()?;
    let value = normalize_secret(&String::from_utf8_lossy(&bytes));
    if value.is_empty() {
        None
    } else {
        Some(value)
    }
}

fn decrypt_chromium_secret(stored: &str) -> Option<String> {
    let raw = base64::engine::general_purpose::STANDARD
        .decode(stored.trim())
        .ok()?;
    if raw.len() < 3 + 12 + 16 {
        return None;
    }
    if !raw.starts_with(b"v10") && !raw.starts_with(b"v11") {
        return None;
    }
    let key = chromium_os_crypt_key()?;
    let payload = &raw[3..];
    let nonce = Nonce::from_slice(&payload[..12]);
    let cipher = Aes256Gcm::new_from_slice(&key).ok()?;
    let plain = cipher.decrypt(nonce, payload[12..].as_ref()).ok()?;
    let value = normalize_secret(&String::from_utf8_lossy(&plain));
    if value.is_empty() {
        None
    } else {
        Some(value)
    }
}

fn chromium_os_crypt_key() -> Option<Vec<u8>> {
    let path = app_root().join("Local State");
    let source = fs::read_to_string(path).ok()?;
    let json: Value = serde_json::from_str(&source).ok()?;
    let b64 = json
        .get("os_crypt")?
        .get("encrypted_key")?
        .as_str()?;
    let blob = base64::engine::general_purpose::STANDARD
        .decode(b64.trim())
        .ok()?;
    let dpapi = blob.strip_prefix(b"DPAPI")?;
    let unprotected = unprotect_bytes(dpapi).ok()?;
    if unprotected.len() < 32 {
        return None;
    }
    Some(unprotected[unprotected.len() - 32..].to_vec())
}

fn normalize_path_key(path: &Path) -> String {
    let mut value = path.display().to_string();
    if let Some(rest) = value.strip_prefix(r"\\?\") {
        value = rest.to_string();
    }
    value.trim_end_matches(['\\', '/']).to_lowercase()
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
    let provider_name = canonical_model_provider(provider);
    let alias_tables = render_catalog_alias_tables(&provider_name, base_url, env_key);
    let model = escape_toml(model);
    let provider = escape_toml(&provider_name);
    let base_url = escape_toml(base_url);
    let env_key = escape_toml(env_key);
    let existing = fs::read_to_string(target).unwrap_or_default();
    let catalog_home = target.parent().unwrap_or_else(|| Path::new("."));
    let catalog_line = existing_catalog_path(&existing, catalog_home)
        .map(|path| format!("model_catalog_json = \"{}\"\n", escape_toml(&toml_path(&path))))
        .unwrap_or_default();
    let approval = normalized_approval_policy(
        toml_string(&existing, "approval_policy")
            .or_else(|| {
                read_preferences()
                    .get("approval_policy")
                    .and_then(Value::as_str)
                    .map(str::to_string)
            })
            .as_deref(),
    );
    let sandbox = normalized_sandbox_mode(
        toml_string(&existing, "sandbox_mode")
            .or_else(|| {
                read_preferences()
                    .get("sandbox_mode")
                    .and_then(Value::as_str)
                    .map(str::to_string)
            })
            .as_deref(),
    );
    let extra_keys = preserve_top_level_keys(
        &existing,
        &[
            "model",
            "model_provider",
            "approval_policy",
            "sandbox_mode",
            "analytics",
            "model_catalog_json",
        ],
    );
    let mcp = preserve_toml_tables(&existing, "[mcp_servers");
    let other_providers = preserve_other_providers(&existing, &provider_name);
    let mut toml = format!(
        "model = \"{model}\"\nmodel_provider = \"{provider}\"\napproval_policy = \"{approval}\"\nsandbox_mode = \"{sandbox}\"\nanalytics = {{ enabled = false }}\n{catalog_line}"
    );
    if !extra_keys.is_empty() {
        toml.push_str(&extra_keys);
        if !extra_keys.ends_with('\n') {
            toml.push('\n');
        }
    }
    let network = if sandbox_network_from(&existing) { "true" } else { "false" };
    toml.push_str(&format!(
        "\n[sandbox_workspace_write]\nnetwork_access = {network}\n\n[model_providers.{provider}]\nname = \"{provider}\"\nbase_url = \"{base_url}\"\nenv_key = \"{env_key}\"\nwire_api = \"responses\"\nrequires_openai_auth = false\n"
    ));
    toml.push_str(&alias_tables);
    if !other_providers.is_empty() {
        toml.push('\n');
        toml.push_str(&other_providers);
        toml.push('\n');
    }
    if !mcp.is_empty() {
        toml.push('\n');
        toml.push_str(&mcp);
        toml.push('\n');
    }
    fs::write(target, toml).map_err(|err| err.to_string())
}

fn preserve_toml_tables(existing: &str, prefix: &str) -> String {
    let mut out = String::new();
    let mut keep = false;
    for line in existing.lines() {
        let trimmed = line.trim_start();
        if trimmed.starts_with('[') {
            keep = trimmed.starts_with(prefix);
        }
        if keep {
            if !out.is_empty() {
                out.push('\n');
            }
            out.push_str(line);
        }
    }
    out
}

fn preserve_other_providers(existing: &str, current: &str) -> String {
    let skip = format!("[model_providers.{current}]");
    let mut out = String::new();
    let mut keep = false;
    for line in existing.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with('[') {
            let name = provider_table_name(trimmed).unwrap_or("");
            keep = trimmed.starts_with("[model_providers.")
                && !trimmed.eq_ignore_ascii_case(&skip)
                && !is_catalog_model_slug(name)
                && canonical_model_provider(name) == name;
        }
        if keep {
            if !out.is_empty() {
                out.push('\n');
            }
            out.push_str(line);
        }
    }
    out
}

fn preserve_top_level_keys(existing: &str, skip: &[&str]) -> String {
    let mut out = String::new();
    for line in existing.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with('[') {
            break;
        }
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        let Some(key) = trimmed.split('=').next().map(str::trim) else {
            continue;
        };
        if skip.iter().any(|item| *item == key) {
            continue;
        }
        if !out.is_empty() {
            out.push('\n');
        }
        out.push_str(line);
    }
    if !out.is_empty() {
        out.push('\n');
    }
    out
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

#[derive(Debug, Clone)]
pub struct ProviderSpec {
    pub id: String,
    pub name: String,
    pub base_url: String,
    pub env_key: String,
    pub default_model: String,
}

fn provider_spec(
    id: &str,
    name: &str,
    base_url: &str,
    env_key: &str,
    default_model: &str,
) -> ProviderSpec {
    ProviderSpec {
        id: id.to_string(),
        name: name.to_string(),
        base_url: base_url.to_string(),
        env_key: env_key.to_string(),
        default_model: default_model.to_string(),
    }
}

pub fn provider_presets() -> Vec<ProviderSpec> {
    vec![
        provider_spec(
            DEFAULT_PROVIDER,
            "DeepSeek",
            DEFAULT_BASE_URL,
            DEFAULT_ENV_KEY,
            DEFAULT_MODEL,
        ),
        provider_spec(
            "moonshot",
            "Moonshot / Kimi",
            "https://api.moonshot.cn/v1",
            "MOONSHOT_API_KEY",
            "kimi-k2.5",
        ),
        provider_spec(
            "dashscope",
            "阿里云百炼",
            "https://dashscope.aliyuncs.com/compatible-mode/v1",
            "DASHSCOPE_API_KEY",
            "qwen-plus",
        ),
        provider_spec(
            "siliconflow",
            "硅基流动",
            "https://api.siliconflow.cn/v1",
            "SILICONFLOW_API_KEY",
            "deepseek-ai/DeepSeek-V3",
        ),
        provider_spec(
            "zhipu",
            "智谱",
            "https://open.bigmodel.cn/api/paas/v4",
            "ZHIPU_API_KEY",
            "glm-4.5",
        ),
        provider_spec(
            "minimax",
            "MiniMax",
            "https://api.minimax.chat/v1",
            "MINIMAX_API_KEY",
            "MiniMax-M2",
        ),
        provider_spec(
            "volcengine",
            "火山方舟",
            "https://ark.cn-beijing.volces.com/api/v3",
            "ARK_API_KEY",
            "",
        ),
        provider_spec(
            "openrouter",
            "OpenRouter",
            "https://openrouter.ai/api/v1",
            "OPENROUTER_API_KEY",
            "deepseek/deepseek-chat",
        ),
        provider_spec(
            "groq",
            "Groq",
            "https://api.groq.com/openai/v1",
            "GROQ_API_KEY",
            "",
        ),
        provider_spec(
            "together",
            "Together",
            "https://api.together.xyz/v1",
            "TOGETHER_API_KEY",
            "deepseek-ai/DeepSeek-V3",
        ),
        provider_spec(
            "fireworks",
            "Fireworks",
            "https://api.fireworks.ai/inference/v1",
            "FIREWORKS_API_KEY",
            "",
        ),
        provider_spec(
            "gemini",
            "Google Gemini",
            "https://generativelanguage.googleapis.com/v1beta/openai/",
            "GEMINI_API_KEY",
            "gemini-2.5-flash",
        ),
    ]
}

pub fn provider_presets_json() -> Value {
    json!({
        "presets": provider_presets()
            .into_iter()
            .map(|spec| spec_value(&spec))
            .collect::<Vec<_>>(),
    })
}

fn spec_value(spec: &ProviderSpec) -> Value {
    json!({
        "id": spec.id,
        "name": spec.name,
        "baseUrl": spec.base_url,
        "base_url": spec.base_url,
        "envKey": spec.env_key,
        "env_key": spec.env_key,
        "defaultModel": spec.default_model,
        "wire_api": "responses",
        "requires_openai_auth": false,
    })
}

fn blocked_provider(id: &str, name: &str, base_url: &str) -> bool {
    let hay = format!("{id}\n{name}\n{base_url}").to_ascii_lowercase();
    hay.contains("chatgpt")
        || hay.contains("oaipro")
        || hay.split(|ch: char| !ch.is_ascii_alphanumeric())
            .any(|part| part == "openai")
}

fn official_codex_home() -> Option<PathBuf> {
    let ours = [
        engine_home(),
        app_root(),
        app_root().join("engine"),
        app_root().join("codex-home"),
    ];
    if let Ok(value) = std::env::var("CODEX_HOME") {
        let path = PathBuf::from(value.trim());
        if !path.as_os_str().is_empty() && ours.iter().all(|item| !paths_equal(item, &path)) {
            return Some(path);
        }
    }
    dirs::home_dir().map(|home| home.join(".codex"))
}

pub fn official_codex_config_path() -> Option<PathBuf> {
    let file = official_codex_home()?.join("config.toml");
    if file.is_file() && !paths_equal(&file, &engine_home().join("config.toml")) {
        Some(file)
    } else {
        None
    }
}

fn paths_equal(left: &Path, right: &Path) -> bool {
    crate::workspace::same_path(left, right)
}

fn parse_provider_tables(source: &str) -> Vec<ProviderSpec> {
    let mut ids = Vec::new();
    for line in source.lines() {
        if let Some(id) = provider_table_name(line.trim()) {
            if !ids.iter().any(|existing| existing == id) {
                ids.push(id.to_string());
            }
        }
    }
    ids.into_iter()
        .filter_map(|id| {
            if is_catalog_model_slug(&id) {
                return None;
            }
            let section = provider_section(source, &id);
            let name = toml_string(&section, "name").unwrap_or_else(|| id.clone());
            let base_url = toml_string(&section, "base_url").unwrap_or_default();
            let env_key = toml_string(&section, "env_key").unwrap_or_else(|| {
                format!("{}_API_KEY", id.to_ascii_uppercase().replace(|ch: char| !ch.is_ascii_alphanumeric(), "_"))
            });
            if blocked_provider(&id, &name, &base_url) {
                return None;
            }
            Some(ProviderSpec {
                id,
                name,
                base_url,
                env_key,
                default_model: String::new(),
            })
        })
        .collect()
}

fn render_provider_table(spec: &ProviderSpec) -> String {
    format!(
        "[model_providers.{id}]\nname = \"{name}\"\nbase_url = \"{url}\"\nenv_key = \"{key}\"\nwire_api = \"responses\"\nrequires_openai_auth = false\n",
        id = spec.id,
        name = escape_toml(&spec.name),
        url = escape_toml(&spec.base_url),
        key = escape_toml(&spec.env_key),
    )
}

fn upsert_provider_table(source: &str, spec: &ProviderSpec) -> String {
    let table = format!("model_providers.{}", spec.id);
    let header = format!("[{table}]");
    if source
        .lines()
        .any(|line| line.trim().eq_ignore_ascii_case(&header))
    {
        let mut out = replace_table_string(source, &table, "name", &spec.name);
        out = replace_table_string(&out, &table, "base_url", &spec.base_url);
        out = replace_table_string(&out, &table, "env_key", &spec.env_key);
        out = replace_table_string(&out, &table, "wire_api", "responses");
        replace_table_bool(&out, &table, "requires_openai_auth", false)
    } else {
        let mut out = source.to_string();
        if !out.is_empty() && !out.ends_with('\n') {
            out.push('\n');
        }
        if !out.ends_with("\n\n") && !out.is_empty() {
            out.push('\n');
        }
        out.push_str(&render_provider_table(spec));
        out
    }
}

fn import_provider_secret(spec: &ProviderSpec, section: &str) -> Option<String> {
    let from_toml = toml_string(section, "api_key").or_else(|| toml_string(section, "secret"));
    let from_env = std::env::var(&spec.env_key).ok();
    let value = from_toml
        .or(from_env)
        .map(|value| normalize_secret(&value))
        .filter(|value| !value.is_empty())?;
    store_named_secret(&spec.env_key, &value).ok()?;
    Some(spec.env_key.clone())
}

pub fn read_model_config_from(source: &str) -> Value {
    let mut providers = Map::new();
    for preset in provider_presets() {
        providers.insert(preset.id.clone(), spec_value(&preset));
    }
    for spec in parse_provider_tables(source) {
        providers.insert(spec.id.clone(), spec_value(&spec));
    }
    let model = toml_string(source, "model").unwrap_or_else(|| DEFAULT_MODEL.into());
    let model_provider = canonical_model_provider(
        &toml_string(source, "model_provider").unwrap_or_else(|| DEFAULT_PROVIDER.into()),
    );
    json!({
        "model": model,
        "model_provider": model_provider,
        "model_providers": providers,
    })
}

pub fn read_model_config() -> Value {
    let home = engine_home();
    let _ = ensure_config(&home);
    read_model_config_from(&fs::read_to_string(home.join("config.toml")).unwrap_or_default())
}

fn import_preview(source_path: &Path, source: &str, imported: &[ProviderSpec]) -> Value {
    let official_provider = toml_string(source, "model_provider").unwrap_or_default();
    let official_model = toml_string(source, "model").unwrap_or_default();
    let selected_allowed = imported
        .iter()
        .any(|item| item.id.eq_ignore_ascii_case(&official_provider));
    let will_select = if selected_allowed {
        official_provider.clone()
    } else {
        imported
            .first()
            .map(|item| item.id.clone())
            .unwrap_or_else(|| DEFAULT_PROVIDER.to_string())
    };
    json!({
        "found": true,
        "path": source_path.display().to_string(),
        "providers": imported.iter().map(spec_value).collect::<Vec<_>>(),
        "model": official_model,
        "modelProvider": official_provider,
        "willSelectProvider": will_select,
        "skippedOpenAi": !selected_allowed && !official_provider.is_empty(),
        "applied": false,
    })
}

pub fn import_official_codex_into(
    target_home: &Path,
    source_path: &Path,
    apply: bool,
) -> Result<Value, String> {
    if !source_path.is_file() {
        return Err(format!("官方配置不存在：{}", source_path.display()));
    }
    if paths_equal(source_path, &target_home.join("config.toml"))
        || paths_equal(source_path, &engine_home().join("config.toml"))
    {
        return Err("这是 Local Codex 自己的配置，请选择官方 ~/.codex/config.toml".into());
    }
    let source = fs::read_to_string(source_path).map_err(|err| err.to_string())?;
    let imported = parse_provider_tables(&source);
    let mut preview = import_preview(source_path, &source, &imported);
    if !apply {
        return Ok(preview);
    }
    if imported.is_empty() {
        return Err("官方配置中没有可导入的模型提供者（已跳过 OpenAI/ChatGPT）".into());
    }
    ensure_config(target_home)?;
    let target = target_home.join("config.toml");
    let mut ours = fs::read_to_string(&target).unwrap_or_default();
    let mut imported_keys = Vec::new();
    for spec in &imported {
        ours = upsert_provider_table(&ours, spec);
        if let Some(key) = import_provider_secret(spec, &provider_section(&source, &spec.id)) {
            imported_keys.push(key);
        }
    }
    let official_provider = toml_string(&source, "model_provider").unwrap_or_default();
    let official_model = toml_string(&source, "model").unwrap_or_default();
    let selected_allowed = imported
        .iter()
        .any(|item| item.id.eq_ignore_ascii_case(&official_provider));
    let select_id = canonical_model_provider(if selected_allowed {
        &official_provider
    } else {
        &imported[0].id
    });
    let select_spec = imported
        .iter()
        .find(|item| item.id == select_id)
        .unwrap_or(&imported[0]);
    let model = if selected_allowed && !official_model.is_empty() {
        official_model
    } else {
        toml_string(&ours, "model").unwrap_or_else(|| DEFAULT_MODEL.into())
    };
    ours = replace_toml_string(&ours, "model", &model);
    ours = replace_toml_string(&ours, "model_provider", &select_id);
    if let Some(approval) = toml_string(&source, "approval_policy") {
        ours = replace_toml_string(
            &ours,
            "approval_policy",
            &normalized_approval_policy(Some(&approval)),
        );
    }
    if let Some(sandbox) = toml_string(&source, "sandbox_mode") {
        ours = replace_toml_string(
            &ours,
            "sandbox_mode",
            &normalized_sandbox_mode(Some(&sandbox)),
        );
    }
    fs::write(&target, ours).map_err(|err| err.to_string())?;
    if let Some(object) = preview.as_object_mut() {
        object.insert("applied".into(), json!(true));
        object.insert("model".into(), json!(model));
        object.insert("modelProvider".into(), json!(select_id));
        object.insert("baseUrl".into(), json!(select_spec.base_url));
        object.insert("envKey".into(), json!(select_spec.env_key));
        object.insert("importedEnvKeys".into(), json!(imported_keys));
    }
    Ok(preview)
}

pub fn import_official_codex(path: Option<&Path>, apply: bool) -> Result<Value, String> {
    let source_path = match path {
        Some(value) if !value.as_os_str().is_empty() => value.to_path_buf(),
        _ => official_codex_config_path().ok_or_else(|| {
            "未找到官方 Codex 配置（~/.codex/config.toml）。可改用选择文件导入。".to_string()
        })?,
    };
    import_official_codex_into(&engine_home(), &source_path, apply)
}

pub fn apply_provider_preset(id: &str) -> Result<Value, String> {
    let spec = provider_presets()
        .into_iter()
        .find(|item| item.id == id)
        .ok_or_else(|| format!("未知预设：{id}"))?;
    let home = engine_home();
    ensure_config(&home)?;
    let target = home.join("config.toml");
    let mut ours = fs::read_to_string(&target).unwrap_or_default();
    ours = upsert_provider_table(&ours, &spec);
    ours = replace_toml_string(&ours, "model_provider", &spec.id);
    if !spec.default_model.is_empty() {
        ours = replace_toml_string(&ours, "model", &spec.default_model);
    }
    fs::write(&target, ours).map_err(|err| err.to_string())?;
    Ok(spec_value(&spec))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;

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

    #[test]
    fn models_json_catalog_uses_visible_slugs() {
        let source = json!({
            "models": [
                {
                    "slug": "deepseek-flash",
                    "display_name": "DeepSeek-Flash",
                    "description": "flash",
                    "visibility": "list",
                    "priority": 1,
                    "default_reasoning_level": "high",
                    "supported_reasoning_levels": [
                        { "effort": "low", "description": "Fast" },
                        { "effort": "max", "description": "Max" }
                    ],
                    "input_modalities": ["text", "image"]
                },
                {
                    "slug": "hidden-model",
                    "display_name": "Hidden",
                    "visibility": "hidden",
                    "priority": 0
                }
            ]
        });
        let data = catalog_from_models_json(&source, "deepseek-flash").expect("catalog");
        assert_eq!(data.len(), 1);
        assert_eq!(data[0]["model"], "deepseek-flash");
        assert_eq!(data[0]["displayName"], "DeepSeek-Flash");
        assert_eq!(data[0]["display_name"], "DeepSeek-Flash");
        assert_eq!(data[0]["name"], "DeepSeek-Flash");
        assert_eq!(data[0]["isDefault"], true);
        let efforts = data[0]["supportedReasoningEfforts"].as_array().unwrap();
        assert!(efforts.iter().any(|item| item["reasoningEffort"] == "ultra"));
    }

    #[test]
    fn reads_model_catalog_json_from_toml() {
        let source = r#"
model = "deepseek-flash"
model_catalog_json = "C:/Users/zidan/AppData/Roaming/local-codex/codex-home/models.json"
"#;
        assert_eq!(
            configured_model_catalog_path(source).unwrap(),
            PathBuf::from("C:/Users/zidan/AppData/Roaming/local-codex/codex-home/models.json")
        );
    }

    #[test]
    fn write_config_keeps_saved_permission_policy() {
        let dir = std::env::temp_dir().join(format!(
            "local-codex-config-policy-{}",
            std::process::id()
        ));
        let _ = fs::create_dir_all(&dir);
        let target = dir.join("config.toml");
        fs::write(
            &target,
            r#"model = "deepseek-flash"
model_provider = "deepseek-flash"
approval_policy = "never"
sandbox_mode = "danger-full-access"
analytics = { enabled = false }

[sandbox_workspace_write]
network_access = false

[model_providers.deepseek-flash]
name = "deepseek-flash"
base_url = "https://api.deepseek.com/"
env_key = "DEEPSEEK_API_KEY"
wire_api = "responses"
requires_openai_auth = false
"#,
        )
        .unwrap();
        write_config(
            &target,
            "deepseek-flash",
            "deepseek-flash",
            "https://api.deepseek.com/",
            "DEEPSEEK_API_KEY",
        )
        .unwrap();
        let saved = fs::read_to_string(&target).unwrap();
        assert!(saved.contains("approval_policy = \"never\""));
        assert!(saved.contains("sandbox_mode = \"danger-full-access\""));
        assert!(saved.contains("network_access = false"));
        assert!(saved.contains("model_provider = \"deepseek\""));
        assert!(saved.contains("[model_providers.deepseek]"));
        assert!(saved.contains("[model_providers.deepseek-flash]"));
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn ensure_config_rewrites_leftover_flash_provider() {
        let dir = std::env::temp_dir().join(format!(
            "local-codex-ensure-provider-{}",
            std::process::id()
        ));
        let _ = fs::create_dir_all(&dir);
        fs::write(
            dir.join("config.toml"),
            r#"model = "deepseek-flash"
model_provider = "deepseek-flash"
approval_policy = "on-request"
sandbox_mode = "workspace-write"

[sandbox_workspace_write]
network_access = true

[model_providers.deepseek-flash]
name = "deepseek-flash"
base_url = "https://api.deepseek.com/"
env_key = "DEEPSEEK_API_KEY"
wire_api = "responses"
requires_openai_auth = false
"#,
        )
        .unwrap();
        ensure_config(&dir).expect("ensure_config");
        let saved = fs::read_to_string(dir.join("config.toml")).unwrap();
        assert!(saved.contains("model_provider = \"deepseek\""));
        assert!(saved.contains("[model_providers.deepseek]"));
        assert!(!saved.contains("model_provider = \"deepseek-flash\""));
        assert!(saved.contains("[model_providers.deepseek-flash]"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn ensure_config_drops_missing_model_catalog() {
        let dir = std::env::temp_dir().join(format!(
            "local-codex-missing-catalog-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);
        let _ = fs::create_dir_all(&dir);
        fs::write(
            dir.join("config.toml"),
            r#"model = "deepseek-flash"
model_provider = "deepseek"
approval_policy = "on-request"
sandbox_mode = "workspace-write"
model_catalog_json = "C:/no/such/local-codex-models.json"

[sandbox_workspace_write]
network_access = true

[model_providers.deepseek]
name = "deepseek"
base_url = "https://api.deepseek.com/"
env_key = "DEEPSEEK_API_KEY"
wire_api = "responses"
requires_openai_auth = false
"#,
        )
        .unwrap();
        ensure_config(&dir).expect("ensure_config");
        let saved = fs::read_to_string(dir.join("config.toml")).unwrap();
        let catalog = dir.join("models.json");
        assert!(catalog.is_file());
        assert!(saved.contains(&toml_path(&catalog).replace('\\', "/")) || saved.contains("models.json"));
        assert!(!saved.contains("C:/no/such/local-codex-models.json"));
        let pointed = configured_model_catalog_path(&saved).expect("catalog path");
        assert!(pointed.is_file(), "{}", pointed.display());
        let parsed: Value = serde_json::from_str(&fs::read_to_string(&catalog).unwrap()).unwrap();
        let flash = parsed["models"]
            .as_array()
            .and_then(|models| {
                models
                    .iter()
                    .find(|item| item.get("slug").and_then(Value::as_str) == Some("deepseek-flash"))
            })
            .expect("deepseek-flash");
        assert!(
            flash
                .get("base_instructions")
                .and_then(Value::as_str)
                .is_some_and(|text| text.contains("coding agent")),
            "catalog models need instructions so Codex can load the file"
        );
        let data = catalog_from_models_json(&parsed, "deepseek-flash").expect("models");
        let slugs: Vec<&str> = data
            .iter()
            .filter_map(|item| item.get("model").and_then(Value::as_str))
            .collect();
        assert_eq!(slugs.first().copied(), Some("deepseek-flash"));
        for preset in provider_presets() {
            if preset.default_model.is_empty() {
                continue;
            }
            assert!(
                slugs.contains(&preset.default_model.as_str()),
                "missing {}",
                preset.default_model
            );
        }
        assert_eq!(canonical_model_provider("kimi-k2.5"), "kimi-k2.5");
        assert_eq!(canonical_model_provider("moonshot"), "moonshot");
        let parsed: Value = serde_json::from_str(BUNDLED_MODELS_JSON).unwrap();
        let all = catalog_from_models_json(&parsed, "deepseek-flash").unwrap();
        let deepseek = models_for_provider(all.clone(), "deepseek", "deepseek-flash");
        let deepseek_ids: Vec<&str> = deepseek
            .iter()
            .filter_map(|item| item.get("model").and_then(Value::as_str))
            .collect();
        assert_eq!(deepseek_ids, vec!["deepseek-flash", "deepseek-v4-pro"]);
        let moonshot = models_for_provider(all.clone(), "moonshot", "kimi-k2.5");
        assert_eq!(moonshot.len(), 1);
        assert_eq!(moonshot[0]["model"], "kimi-k2.5");
        let silicon = models_for_provider(all, "siliconflow", "deepseek-ai/DeepSeek-V3");
        assert_eq!(silicon[0]["model"], "deepseek-ai/DeepSeek-V3");
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn canonical_provider_rejects_model_slugs() {
        assert_eq!(canonical_model_provider("deepseek-flash"), "deepseek");
        assert_eq!(canonical_model_provider("deepseek-v4-pro"), "deepseek");
        assert_eq!(canonical_model_provider("deepseek"), "deepseek");
        assert_eq!(canonical_model_provider("custom-proxy"), "custom-proxy");
    }

    #[test]
    fn parse_official_providers_skips_openai() {
        let source = r#"
model = "kimi-k2.5"
model_provider = "moonshot"

[model_providers.openai]
name = "OpenAI"
base_url = "https://api.openai.com/v1"
env_key = "OPENAI_API_KEY"

[model_providers.moonshot]
name = "Moonshot"
base_url = "https://api.moonshot.cn/v1"
env_key = "MOONSHOT_API_KEY"

[model_providers.chatgpt]
name = "ChatGPT"
base_url = "https://chatgpt.com/backend-api/codex"
"#;
        let imported = parse_provider_tables(source);
        assert_eq!(imported.len(), 1);
        assert_eq!(imported[0].id, "moonshot");
        assert!(blocked_provider(
            "openai",
            "OpenAI",
            "https://api.openai.com/v1"
        ));
        assert!(!blocked_provider(
            "openrouter",
            "OpenRouter",
            "https://openrouter.ai/api/v1"
        ));
    }

    #[test]
    fn import_official_codex_merges_providers_without_secrets() {
        let stamp = format!(
            "local-codex-import-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_millis()
        );
        let root = std::env::temp_dir().join(&stamp);
        let official = root.join("official");
        let local = root.join("local");
        let _ = fs::create_dir_all(&official);
        let _ = fs::create_dir_all(&local);
        fs::write(
            official.join("config.toml"),
            r#"model = "kimi-k2.5"
model_provider = "moonshot"
approval_policy = "on-request"
sandbox_mode = "workspace-write"

[model_providers.openai]
name = "OpenAI"
base_url = "https://api.openai.com/v1"
env_key = "OPENAI_API_KEY"
api_key = "sk-should-not-land-in-toml"

[model_providers.moonshot]
name = "Moonshot"
base_url = "https://api.moonshot.cn/v1"
env_key = "MOONSHOT_API_KEY"
"#,
        )
        .unwrap();
        ensure_config(&local).expect("ensure local");
        let preview = import_official_codex_into(&local, &official.join("config.toml"), false)
            .expect("preview");
        assert_eq!(preview["applied"], false);
        assert_eq!(preview["willSelectProvider"], "moonshot");
        import_official_codex_into(&local, &official.join("config.toml"), true).expect("apply");
        let saved = fs::read_to_string(local.join("config.toml")).unwrap();
        assert!(saved.contains("model_provider = \"moonshot\""));
        assert!(saved.contains("[model_providers.moonshot]"));
        assert!(saved.contains("base_url = \"https://api.moonshot.cn/v1\""));
        assert!(!saved.contains("sk-should-not-land-in-toml"));
        assert!(!saved.contains("[model_providers.openai]"));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn read_model_config_includes_default_presets() {
        let value = read_model_config_from("model = \"deepseek-flash\"\nmodel_provider = \"deepseek\"\n");
        assert_eq!(value["model_provider"], "deepseek");
        assert!(value["model_providers"]["deepseek"]["base_url"]
            .as_str()
            .unwrap()
            .contains("api.deepseek.com"));
        assert!(value["model_providers"].get("moonshot").is_some());
    }
}
