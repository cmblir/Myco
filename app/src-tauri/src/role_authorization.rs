//! Native feature selections and revocable opening-bound execution grants.
//! Selection proves a supported route, not installed weights or semantic quality.

use crate::settings::{self, Settings};
use crate::vault_session::AgentVaultSession;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::fmt;
use std::sync::{Mutex, OnceLock};

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RoleId {
    Ask,
    Compilation,
    Organization,
    Reflect,
    Lint,
    Study,
    Audio,
    Agent,
    Embedding,
    Transcription,
}

pub const ROLES: [RoleId; 10] = [
    RoleId::Ask,
    RoleId::Compilation,
    RoleId::Organization,
    RoleId::Reflect,
    RoleId::Lint,
    RoleId::Study,
    RoleId::Audio,
    RoleId::Agent,
    RoleId::Embedding,
    RoleId::Transcription,
];

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RoleUsage {
    Foreground,
    Automatic,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ExecutionLocation {
    InProcess,
    Loopback,
    Remote,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Selection {
    LocalDefault,
    ExplicitLocal,
    PreservedLocal,
    ExplicitExternal,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LegacyRoute {
    pub provider_id: String,
    pub model_id: String,
    pub effort: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ModelRoleSelection {
    pub provider_id: String,
    pub model_id: String,
    pub effort: String,
    pub selection: Selection,
    pub automatic_external_allowed: bool,
    pub legacy_unconfirmed: Option<LegacyRoute>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ModelRoleSettings {
    pub version: u32,
    pub roles: BTreeMap<RoleId, ModelRoleSelection>,
}

impl Default for ModelRoleSettings {
    fn default() -> Self {
        Self {
            version: 2,
            roles: ROLES
                .into_iter()
                .map(|role| {
                    let model = match role {
                        RoleId::Compilation => crate::local_model::SMALL_MODEL.id,
                        RoleId::Embedding => "e5-small-ko",
                        RoleId::Transcription => "whisper-small",
                        _ => crate::local_model::MODEL.id,
                    };
                    (
                        role,
                        ModelRoleSelection {
                            provider_id: "builtin-local".into(),
                            model_id: model.into(),
                            effort: "(default)".into(),
                            selection: Selection::LocalDefault,
                            automatic_external_allowed: false,
                            legacy_unconfirmed: None,
                        },
                    )
                })
                .collect(),
        }
    }
}

impl ModelRoleSettings {
    pub(crate) fn migrate(settings: &Settings) -> Self {
        let mut routes = Self::default();
        for (role, provider, model, effort) in [
            (
                RoleId::Ask,
                &settings.query_provider,
                &settings.query_model,
                &settings.query_effort,
            ),
            (
                RoleId::Compilation,
                &settings.ingest_provider,
                &settings.ingest_model,
                &settings.ingest_effort,
            ),
        ] {
            let route = routes.roles.get_mut(&role).expect("all roles defaulted");
            if provider == "builtin-local" {
                route.model_id = model.clone();
                route.effort = effort.clone();
                route.selection = Selection::PreservedLocal;
            } else {
                route.legacy_unconfirmed = Some(LegacyRoute {
                    provider_id: provider.clone(),
                    model_id: model.clone(),
                    effort: effort.clone(),
                });
            }
        }
        routes
    }
    pub(crate) fn validate(&self) -> Result<(), String> {
        if self.version != 2
            || self.roles.len() != ROLES.len()
            || ROLES.iter().any(|role| !self.roles.contains_key(role))
        {
            return Err("invalid native model role settings schema".into());
        }
        for route in self.roles.values() {
            if route.provider_id.is_empty()
                || route.model_id.is_empty()
                || route.provider_id.len() > 128
                || route.model_id.len() > 256
                || route.effort.len() > 32
            {
                return Err("invalid native model role selection".into());
            }
            if (route.provider_id == "builtin-local")
                == (route.selection == Selection::ExplicitExternal)
                || (route.provider_id == "builtin-local" && route.automatic_external_allowed)
            {
                return Err("model role provenance does not match its route".into());
            }
        }
        Ok(())
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RoleRouteSignature {
    pub role: RoleId,
    pub provider_id: String,
    pub model_id: String,
    pub effort: String,
    pub execution_location: ExecutionLocation,
    pub artifact_revision: Option<String>,
    pub artifact_sha256: Option<String>,
    pub runtime_contract: String,
    signature: String,
}
impl RoleRouteSignature {
    pub fn signature(&self) -> &str {
        &self.signature
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RoleSnapshot {
    pub snapshot_id: String,
    pub origin: AgentVaultSession,
    pub role: RoleId,
    pub route_signature: RoleRouteSignature,
    pub authorization_revision: String,
    pub usage: RoleUsage,
}

#[derive(Debug)]
pub struct RoleError(pub String);
impl fmt::Display for RoleError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}
impl std::error::Error for RoleError {}
impl From<String> for RoleError {
    fn from(value: String) -> Self {
        Self(value)
    }
}

#[derive(Default)]
struct Authorization {
    revision: String,
    fingerprint: String,
    grants: BTreeMap<String, RoleSnapshot>,
}
static AUTHORIZATION: OnceLock<Mutex<Authorization>> = OnceLock::new();
fn authorization() -> &'static Mutex<Authorization> {
    AUTHORIZATION.get_or_init(Mutex::default)
}
fn random_id() -> Result<String, String> {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).map_err(|_| "native role entropy unavailable".to_string())?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}
fn digest(value: &impl Serialize) -> Result<String, String> {
    let bytes = serde_json::to_vec(value).map_err(|error| error.to_string())?;
    Ok(format!("{:x}", Sha256::digest(bytes)))
}
fn fingerprint(settings: &Settings) -> Result<String, String> {
    // Runtime endpoint overrides are part of the authority, never caller input.
    let endpoints: BTreeMap<_, _> = [
        "MYCO_OLLAMA_URL",
        "MYCO_ANTHROPIC_URL",
        "MYCO_OPENAI_URL",
        "MYCO_OPENROUTER_URL",
        "MYCO_GOOGLE_URL",
    ]
    .into_iter()
    .map(|name| (name, std::env::var(name).ok()))
    .collect();
    digest(&(
        &settings.model_roles,
        &settings.providers,
        &settings.myco_pro_url,
        settings.auto_ingest_enabled,
        settings.auto_reflect_enabled,
        endpoints,
    ))
}
fn synchronize(state: &mut Authorization, settings: &Settings) -> Result<(), String> {
    let current = fingerprint(settings)?;
    if state.fingerprint != current || state.revision.is_empty() {
        let revision = random_id()?;
        state.revision = revision;
        state.fingerprint = current;
        state.grants.clear();
    }
    Ok(())
}
fn connected(settings: &Settings, provider: &str) -> bool {
    match provider {
        "builtin-local" => true,
        "anthropic-api" => settings.providers.anthropic_api,
        "openai-api" => settings.providers.openai_api,
        "google-api" => settings.providers.google_api,
        "openrouter" => settings.providers.openrouter,
        "ollama" => settings.providers.ollama,
        "anthropic-cli" => settings.providers.anthropic_cli,
        "codex-cli" => settings.providers.codex_cli,
        "gemini-cli" => settings.providers.gemini_cli,
        "myco-pro" => settings.providers.myco_pro,
        _ => false,
    }
}
fn ollama_is_loopback() -> bool {
    let endpoint = std::env::var("MYCO_OLLAMA_URL")
        .ok()
        .filter(|url| crate::providers::override_allowed(url))
        .unwrap_or_else(|| "http://localhost:11434".into());
    reqwest::Url::parse(&endpoint)
        .ok()
        .and_then(|url| url.host_str().map(str::to_owned))
        .is_some_and(|host| {
            host == "localhost"
                || host
                    .parse::<std::net::IpAddr>()
                    .is_ok_and(|address| address.is_loopback())
        })
}
/// Inspect a selected route without issuing authority or starting inference.
pub(crate) fn route_for(
    settings: &Settings,
    role: RoleId,
    usage: RoleUsage,
) -> Result<RoleRouteSignature, String> {
    settings.model_roles.validate()?;
    let selected = settings
        .model_roles
        .roles
        .get(&role)
        .ok_or("role selection missing")?;
    if !connected(settings, &selected.provider_id) {
        return Err("connection_unavailable: connect the selected provider explicitly".into());
    }
    let local = selected.provider_id == "builtin-local";
    if !local && selected.selection != Selection::ExplicitExternal {
        return Err("route_unconfirmed: select this role explicitly".into());
    }
    if !local && usage == RoleUsage::Automatic && !selected.automatic_external_allowed {
        return Err("automatic_external_not_permitted".into());
    }
    // Optional CLI transports remain unavailable until host/child/MCP confinement is proved.
    if selected.provider_id.ends_with("-cli") {
        return Err("capability_unavailable: optional CLI runner is not confined".into());
    }
    if matches!(role, RoleId::Embedding | RoleId::Transcription) && !local {
        return Err("capability_unavailable: this role is local-only".into());
    }
    if role == RoleId::Agent
        && !local
        && !matches!(
            selected.provider_id.as_str(),
            "anthropic-api" | "openai-api" | "openrouter"
        )
    {
        return Err(
            "capability_unavailable: selected provider has no supported agent transport".into(),
        );
    }
    if selected.provider_id == "myco-pro" && role != RoleId::Compilation {
        return Err("capability_unavailable: subscription route supports compilation only".into());
    }
    if role == RoleId::Embedding && selected.model_id != "e5-small-ko"
        || role == RoleId::Transcription && selected.model_id != "whisper-small"
    {
        return Err(
            "capability_unavailable: this local role is pinned to its current runtime".into(),
        );
    }
    let (revision, sha, runtime) = if local {
        match selected.model_id.as_str() {
            "extractive-retrieval" | "extractive-ingest" => (None, None, "extractive-v1".into()),
            "e5-small-ko" if role == RoleId::Embedding => (None, None, "e5-bundled-384-v1".into()),
            "whisper-small" if role == RoleId::Transcription => {
                (None, None, "whisper-local-small-v1".into())
            }
            id => {
                let artifact = crate::local_model::manifest_for(Some(id))?;
                (
                    Some(artifact.revision.into()),
                    Some(crate::local_model::artifact_identity(artifact)),
                    crate::local_model::runtime_contract(artifact).into(),
                )
            }
        }
    } else {
        (None, None, "http-provider-v1".into())
    };
    let mut route = RoleRouteSignature {
        role,
        provider_id: selected.provider_id.clone(),
        model_id: selected.model_id.clone(),
        effort: selected.effort.clone(),
        execution_location: if local {
            ExecutionLocation::InProcess
        } else if selected.provider_id == "ollama" && ollama_is_loopback() {
            ExecutionLocation::Loopback
        } else {
            ExecutionLocation::Remote
        },
        artifact_revision: revision,
        artifact_sha256: sha,
        runtime_contract: runtime,
        signature: String::new(),
    };
    route.signature = digest(&route)?;
    Ok(route)
}

/// Call only while the native opening guard owns `bound_origin`.
pub(crate) fn capture_role_at(
    bound_origin: &AgentVaultSession,
    role: RoleId,
    usage: RoleUsage,
) -> Result<RoleSnapshot, RoleError> {
    let mut state = authorization()
        .lock()
        .map_err(|_| RoleError("role authorization lock poisoned".into()))?;
    let settings = settings::read_checked().map_err(RoleError)?;
    synchronize(&mut state, &settings)?;
    let route_signature = route_for(&settings, role, usage)?;
    let snapshot = RoleSnapshot {
        snapshot_id: random_id()?,
        origin: bound_origin.clone(),
        role,
        route_signature,
        authorization_revision: state.revision.clone(),
        usage,
    };
    state
        .grants
        .insert(snapshot.snapshot_id.clone(), snapshot.clone());
    Ok(snapshot)
}

/// Keep route validation and a checked publication in one short transaction.
pub(crate) fn with_current_role_at<T>(
    bound_origin: &AgentVaultSession,
    expected: &RoleSnapshot,
    role: RoleId,
    usage: RoleUsage,
    dispatch: impl FnOnce() -> Result<T, String>,
) -> Result<T, RoleError> {
    let mut state = authorization()
        .lock()
        .map_err(|_| RoleError("role authorization lock poisoned".into()))?;
    let settings = settings::read_checked().map_err(RoleError)?;
    synchronize(&mut state, &settings)?;
    let grant = state
        .grants
        .get(&expected.snapshot_id)
        .cloned()
        .ok_or_else(|| RoleError("snapshot_stale: capture the role again".into()))?;
    if grant.origin.vault_path != bound_origin.vault_path
        || grant.origin.opening_token != bound_origin.opening_token
        || grant.role != role
        || grant.usage != usage
        || serde_json::to_value(&grant).map_err(|e| RoleError(e.to_string()))?
            != serde_json::to_value(expected).map_err(|e| RoleError(e.to_string()))?
    {
        return Err(RoleError(
            "role_mismatch: native grant does not match request".into(),
        ));
    }
    if grant.authorization_revision != state.revision
        || grant.route_signature != route_for(&settings, role, usage)?
    {
        return Err(RoleError(
            "snapshot_stale: role authorization changed".into(),
        ));
    }
    // Private lookup is owned above; no registry lock is held separately here.
    dispatch().map_err(RoleError)
}

pub(crate) fn settings_snapshot() -> Result<Settings, String> {
    let mut state = authorization()
        .lock()
        .map_err(|_| "role authorization lock poisoned")?;
    let mut settings = settings::read_checked()?;
    synchronize(&mut state, &settings)?;
    settings.role_authorization_revision = state.revision.clone();
    Ok(settings)
}

/// Serialize a destructive commit with native policy changes. Acquire this
/// guard before the file writer; the callback must not re-enter authorization.
pub(crate) fn with_deletion_policy<T>(
    expected_permanent: bool,
    dispatch: impl FnOnce() -> Result<T, String>,
) -> Result<T, String> {
    let _policy_guard = authorization()
        .lock()
        .map_err(|_| "role authorization lock poisoned")?;
    settings::confirmed_deletion_policy(Some(expected_permanent))?;
    dispatch()
}

#[cfg(test)]
#[path = "deletion_policy_authority_tests.rs"]
mod deletion_policy_authority_tests;

pub(crate) fn save_settings(settings: &Settings) -> Result<(), String> {
    let mut state = authorization()
        .lock()
        .map_err(|_| "role authorization lock poisoned")?;
    let current = settings::read_checked()?;
    if current.model_roles != settings.model_roles {
        return Err(
            "use native select_model_role/set_role_automatic_use to change model roles".into(),
        );
    }
    let changed = fingerprint(&current)? != fingerprint(settings)?;
    let revision = if changed { Some(random_id()?) } else { None };
    settings::save_unlocked(settings)?;
    if let Some(revision) = revision {
        state.revision = revision;
        state.grants.clear();
    }
    state.fingerprint = fingerprint(settings)?;
    Ok(())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RoleSelectionRequest {
    pub role: RoleId,
    pub provider_id: String,
    pub model_id: String,
    pub effort: String,
    pub expected_authorization_revision: String,
}

pub(crate) fn select_role(request: RoleSelectionRequest) -> Result<Settings, String> {
    let mut state = authorization()
        .lock()
        .map_err(|_| "role authorization lock poisoned")?;
    let mut settings = settings::read_checked()?;
    synchronize(&mut state, &settings)?;
    if request.expected_authorization_revision != state.revision {
        return Err("role settings changed; reload before selecting a model".into());
    }
    let local = request.provider_id == "builtin-local";
    if !connected(&settings, &request.provider_id) {
        return Err("connection_unavailable: connect before selecting an external route".into());
    }
    if request.model_id.trim().is_empty()
        || request.model_id.len() > 256
        || request.effort.len() > 32
    {
        return Err("invalid model role selection".into());
    }
    let old = settings
        .model_roles
        .roles
        .get(&request.role)
        .ok_or("role missing")?;
    let choice = ModelRoleSelection {
        provider_id: request.provider_id,
        model_id: request.model_id,
        effort: request.effort,
        selection: if local {
            Selection::ExplicitLocal
        } else {
            Selection::ExplicitExternal
        },
        automatic_external_allowed: false,
        legacy_unconfirmed: old.legacy_unconfirmed.clone(),
    };
    settings.model_roles.roles.insert(request.role, choice);
    // Selection can record an unavailable CLI; capture still refuses dispatch.
    settings.model_roles.validate()?;
    if local {
        let _ = route_for(&settings, request.role, RoleUsage::Foreground)?;
    }
    if request.role == RoleId::Ask {
        let r = &settings.model_roles.roles[&request.role];
        settings.query_provider = r.provider_id.clone();
        settings.query_model = r.model_id.clone();
        settings.query_effort = r.effort.clone();
    }
    if request.role == RoleId::Compilation {
        let r = &settings.model_roles.roles[&request.role];
        settings.ingest_provider = r.provider_id.clone();
        settings.ingest_model = r.model_id.clone();
        settings.ingest_effort = r.effort.clone();
    }
    let revision = random_id()?;
    settings::save_unlocked(&settings)?;
    state.revision = revision;
    state.fingerprint = fingerprint(&settings)?;
    state.grants.clear();
    settings.role_authorization_revision = state.revision.clone();
    Ok(settings)
}

pub(crate) fn set_automatic(
    role: RoleId,
    allowed: bool,
    expected_authorization_revision: &str,
) -> Result<Settings, String> {
    let mut state = authorization()
        .lock()
        .map_err(|_| "role authorization lock poisoned")?;
    let mut settings = settings::read_checked()?;
    synchronize(&mut state, &settings)?;
    if expected_authorization_revision != state.revision {
        return Err("role settings changed; review automatic permission again".into());
    }
    let selected = settings
        .model_roles
        .roles
        .get_mut(&role)
        .ok_or("role missing")?;
    if selected.provider_id == "builtin-local" || selected.selection != Selection::ExplicitExternal
    {
        return Err("automatic permission requires an explicitly selected external route".into());
    }
    selected.automatic_external_allowed = allowed;
    let revision = random_id()?;
    settings::save_unlocked(&settings)?;
    state.revision = revision;
    state.fingerprint = fingerprint(&settings)?;
    state.grants.clear();
    settings.role_authorization_revision = state.revision.clone();
    Ok(settings)
}

pub(crate) fn with_credential_change<T>(
    change: impl FnOnce() -> Result<T, String>,
) -> Result<T, String> {
    let mut state = authorization()
        .lock()
        .map_err(|_| "role authorization lock poisoned")?;
    // Reserve entropy before changing credentials; a failure never leaves an old grant valid.
    let revision = random_id()?;
    let result = change();
    state.revision = revision;
    state.grants.clear();
    result
}

#[cfg(test)]
#[path = "role_authorization_tests.rs"]
mod tests;
