//! Optional external CLI bridges. Installation does not grant execution.
//!
//! No current runner has a verified boundary covering its own settings, MCP,
//! hooks, children and host filesystem. Runs fail before binary lookup/spawn.
//! Read-only prompts, tool allowlists and a tool-shell sandbox are insufficient.

use std::path::Path;

use crate::claude::{locate_runner_bin, CliResult, CliStatus};
use crate::vault_session::{AgentVaultSession, VaultRoot};

#[cfg(all(test, unix))]
#[path = "cli_boundary_tests.rs"]
mod boundary_tests;

#[derive(Clone, Copy, Debug, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum CliExecutionCapability {
    ReadOnly,
    StagedWrite,
}

/// Explicit intended operation and native identity of its source vault opening.
#[derive(Clone, Debug, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CliExecutionRequest {
    pub capability: CliExecutionCapability,
    pub origin: AgentVaultSession,
    // Carry the original selection; it never enables an unsupported runner.
    #[serde(default)]
    pub role_snapshot: Option<crate::role_authorization::RoleSnapshot>,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CliExecutionSupport {
    pub read_only: bool,
    pub staged_write: bool,
    pub reason: String,
}

/// Backwards compatible installation fields plus truthful execution support.
#[derive(Debug, serde::Serialize)]
pub struct CliRunnerStatus {
    #[serde(flatten)]
    pub installation: CliStatus,
    pub execution: CliExecutionSupport,
}

impl CliRunnerStatus {
    pub fn new(installation: CliStatus, provider: &str) -> Self {
        Self {
            installation,
            execution: CliExecutionSupport {
                read_only: false,
                staged_write: false,
                reason: execution_unavailable(provider, CliExecutionCapability::ReadOnly),
            },
        }
    }
}

pub(crate) fn execution_unavailable(provider: &str, capability: CliExecutionCapability) -> String {
    let reason = match capability {
        CliExecutionCapability::ReadOnly => "a verified boundary for host files, settings, MCP, hooks and child processes is not available; prompts and tool sandbox flags alone do not enforce it",
        CliExecutionCapability::StagedWrite => "isolated draft generation and origin-bound checked publication are not available; direct vault writes are disabled",
    };
    format!("CLI_EXECUTION_UNAVAILABLE: {provider}: {reason}")
}

/// Reject a missing capability, foreign root or stale opening before dispatch.
/// This does not grant a runner permission to spawn an unconfined process.
pub(crate) fn validate_execution(
    state: &VaultRoot,
    request: Option<&CliExecutionRequest>,
    cwd: &str,
) -> Result<CliExecutionCapability, String> {
    let request = request.ok_or("CLI_EXECUTION_CAPABILITY_REQUIRED: an explicit capability and native vault opening are required; unconfined CLI execution is disabled")?;
    state.with_origin(&request.origin, |root| {
        let requested_root = Path::new(cwd)
            .canonicalize()
            .map_err(|error| format!("CLI working root is inaccessible: {error}"))?;
        if requested_root != root {
            return Err("CLI working root does not match its source vault opening".into());
        }
        Ok(request.capability)
    })
}

/// One fail-closed gate shared by all public CLI IPC entry points.
pub(crate) fn require_execution(
    state: &VaultRoot,
    request: Option<&CliExecutionRequest>,
    cwd: &str,
    provider: &str,
) -> Result<(), String> {
    let capability = validate_execution(state, request, cwd)?;
    Err(execution_unavailable(provider, capability))
}

pub fn provider_bin(provider: &str) -> Option<(&'static str, &'static str)> {
    match provider {
        "gemini-cli" => Some(("gemini", "MYCO_GEMINI_PATH")),
        "codex-cli" => Some(("codex", "MYCO_CODEX_PATH")),
        _ => None,
    }
}

pub fn check(provider: &str) -> CliStatus {
    let Some((bin, env)) = provider_bin(provider) else {
        return CliStatus {
            installed: false,
            version: None,
            path: None,
        };
    };
    let path = locate_runner_bin(bin, env);
    CliStatus {
        installed: path.is_some(),
        version: None,
        path,
    }
}

/// Legacy bridge kept as an explicit error for older callers. A missing
/// capability cannot fall back to the historical writable-vault invocation.
pub fn run_prompt(
    provider: &str,
    _model: &str,
    _effort: &str,
    _prompt: &str,
    _cwd: &str,
) -> Result<CliResult, String> {
    provider_bin(provider).ok_or_else(|| format!("unknown provider: {provider}"))?;
    Err(execution_unavailable(
        provider,
        CliExecutionCapability::ReadOnly,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn provider_bins_map() {
        assert_eq!(provider_bin("gemini-cli").unwrap().0, "gemini");
        assert_eq!(provider_bin("codex-cli").unwrap().0, "codex");
        assert!(provider_bin("ollama").is_none());
    }

    #[test]
    fn run_prompt_rejects_unknown_provider() {
        assert!(run_prompt("nope", "", "", "hi", "/tmp").is_err());
    }

    #[test]
    fn cli_boundary_status_never_equates_installation_with_execution() {
        for provider in ["anthropic-cli", "codex-cli", "gemini-cli"] {
            let status = CliRunnerStatus::new(
                CliStatus {
                    installed: true,
                    version: Some("synthetic".into()),
                    path: None,
                },
                provider,
            );
            assert!(!status.execution.read_only);
            assert!(!status.execution.staged_write);
            assert!(status
                .execution
                .reason
                .contains("CLI_EXECUTION_UNAVAILABLE"));
        }
    }

    #[test]
    fn cli_boundary_request_rejects_unknown_capability_and_fields() {
        for value in [
            serde_json::json!({"capability":"unrestricted", "origin":{"vaultPath":"/synthetic", "openingToken":"1"}}),
            serde_json::json!({"capability":"read-only", "origin":{"vaultPath":"/synthetic", "openingToken":"1"}, "allowTools":true}),
        ] {
            assert!(serde_json::from_value::<CliExecutionRequest>(value).is_err());
        }
    }
}
