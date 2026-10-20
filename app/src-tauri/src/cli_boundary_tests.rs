//! Public native bridge regression tests. Children use synthetic files only.

use super::*;
use std::os::unix::fs::PermissionsExt;
use std::process::{Command, Stdio};

struct Fixture {
    directory: tempfile::TempDir,
    vault: std::path::PathBuf,
    child: std::path::PathBuf,
    sentinels: Vec<std::path::PathBuf>,
    launched: std::path::PathBuf,
}

impl Fixture {
    fn new() -> Self {
        let directory = tempfile::tempdir().unwrap();
        let base = directory.path().canonicalize().unwrap();
        let vault = base.join("vault");
        std::fs::create_dir_all(vault.join("raw")).unwrap();
        std::fs::create_dir_all(vault.join("wiki")).unwrap();
        let sentinels = vec![
            vault.join("raw/source.md"),
            vault.join("wiki/human.md"),
            base.join("outside.md"),
        ];
        for sentinel in &sentinels {
            std::fs::write(sentinel, "synthetic original").unwrap();
        }
        let launched = base.join("launched");
        let child = base.join("fake-agent");
        let mut script = format!(
            "#!/bin/sh\ncat >/dev/null\nprintf launched > '{}'\n",
            launched.display()
        );
        for sentinel in &sentinels {
            script.push_str(&format!("printf overwritten > '{}'\n", sentinel.display()));
        }
        script.push_str("printf '%s\\n' '{\"type\":\"result\",\"result\":\"done\"}'\n");
        std::fs::write(&child, script).unwrap();
        std::fs::set_permissions(&child, std::fs::Permissions::from_mode(0o700)).unwrap();
        Self {
            directory,
            vault,
            child,
            sentinels,
            launched,
        }
    }

    fn assert_untouched(&self) {
        assert!(!self.launched.exists(), "unconfined child was launched");
        for sentinel in &self.sentinels {
            assert_eq!(
                std::fs::read_to_string(sentinel).unwrap(),
                "synthetic original",
                "{}",
                sentinel.display()
            );
        }
    }
}

struct Override {
    key: &'static str,
    previous: Option<std::ffi::OsString>,
}

impl Override {
    fn set(key: &'static str, child: &Path) -> Self {
        let previous = std::env::var_os(key);
        std::env::set_var(key, child);
        Self { key, previous }
    }
}

impl Drop for Override {
    fn drop(&mut self) {
        if let Some(previous) = &self.previous {
            std::env::set_var(self.key, previous);
        } else {
            std::env::remove_var(self.key);
        }
    }
}

#[test]
fn cli_boundary_fixture_spawns_real_synthetic_child() {
    let fixture = Fixture::new();
    let output = Command::new(&fixture.child)
        .stdin(Stdio::null())
        .output()
        .unwrap();
    assert!(output.status.success());
    assert!(fixture.launched.exists());
    for sentinel in &fixture.sentinels {
        assert_eq!(std::fs::read_to_string(sentinel).unwrap(), "overwritten");
    }
    assert!(fixture.directory.path().exists());
}

#[test]
#[serial_test::serial]
fn cli_boundary_public_blocking_bridges_refuse_unconfined_children() {
    let mut failures = Vec::new();
    for (provider, variable) in [
        ("anthropic-cli", "MYCO_CLAUDE_PATH"),
        ("codex-cli", "MYCO_CODEX_PATH"),
        ("gemini-cli", "MYCO_GEMINI_PATH"),
    ] {
        let fixture = Fixture::new();
        let _override = Override::set(variable, &fixture.child);
        let result = if provider == "anthropic-cli" {
            crate::claude::run_prompt(
                "synthetic question",
                fixture.vault.to_str().unwrap(),
                None,
                None,
            )
        } else {
            run_prompt(
                provider,
                "",
                "",
                "synthetic question",
                fixture.vault.to_str().unwrap(),
            )
        };
        if result.is_ok()
            || fixture.launched.exists()
            || fixture
                .sentinels
                .iter()
                .any(|path| std::fs::read_to_string(path).unwrap() != "synthetic original")
        {
            failures.push(format!(
                "{provider}: result={result:?}, child launched={}, sentinel protection failed",
                fixture.launched.exists()
            ));
        } else {
            fixture.assert_untouched();
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

#[test]
#[serial_test::serial]
fn cli_boundary_public_streaming_bridge_refuses_unconfined_child() {
    let fixture = Fixture::new();
    let _override = Override::set("MYCO_CLAUDE_PATH", &fixture.child);
    let result = crate::claude::run_prompt_stream(
        "synthetic-run",
        "synthetic question",
        fixture.vault.to_str().unwrap(),
        None,
        None,
        |_| {},
    );
    assert!(
        result.is_err(),
        "unconfined streaming child returned {result:?}"
    );
    fixture.assert_untouched();
}

fn open(state: &VaultRoot, vault: &Path) {
    let generation = state.begin_open().unwrap();
    state
        .finish_open(generation, vault.canonicalize().unwrap(), || ())
        .unwrap();
}

#[test]
fn cli_boundary_native_gate_refuses_missing_scope_and_both_capabilities() {
    let fixture = Fixture::new();
    let state = VaultRoot::default();
    open(&state, &fixture.vault);
    let cwd = fixture.vault.to_str().unwrap();
    assert!(require_execution(&state, None, cwd, "anthropic-cli")
        .unwrap_err()
        .contains("CAPABILITY_REQUIRED"));
    for capability in [
        CliExecutionCapability::ReadOnly,
        CliExecutionCapability::StagedWrite,
    ] {
        let request = CliExecutionRequest {
            role_snapshot: None,
            capability,
            origin: state.snapshot().unwrap(),
        };
        let error = require_execution(&state, Some(&request), cwd, "anthropic-cli").unwrap_err();
        assert!(error.contains("CLI_EXECUTION_UNAVAILABLE"));
        fixture.assert_untouched();
    }
}

#[test]
fn cli_boundary_native_gate_rejects_stale_same_path_failed_open_and_foreign_root() {
    let fixture = Fixture::new();
    let second = Fixture::new();
    let state = VaultRoot::default();
    open(&state, &fixture.vault);
    let request = CliExecutionRequest {
        role_snapshot: None,
        capability: CliExecutionCapability::ReadOnly,
        origin: state.snapshot().unwrap(),
    };
    let cwd = fixture.vault.to_str().unwrap();
    assert!(
        validate_execution(&state, Some(&request), second.vault.to_str().unwrap())
            .unwrap_err()
            .contains("does not match")
    );
    open(&state, &fixture.vault);
    assert!(require_execution(&state, Some(&request), cwd, "codex-cli")
        .unwrap_err()
        .contains("active vault changed"));
    let request = CliExecutionRequest {
        role_snapshot: None,
        origin: state.snapshot().unwrap(),
        ..request
    };
    state.begin_open().unwrap();
    assert!(require_execution(&state, Some(&request), cwd, "codex-cli")
        .unwrap_err()
        .contains("active vault changed"));
    state.close().unwrap();
    assert!(require_execution(&state, Some(&request), cwd, "codex-cli")
        .unwrap_err()
        .contains("no vault is open"));
    fixture.assert_untouched();
    second.assert_untouched();
}

#[test]
#[serial_test::serial]
fn cli_boundary_cancel_does_not_release_a_blocked_runner() {
    let fixture = Fixture::new();
    let _override = Override::set("MYCO_CLAUDE_PATH", &fixture.child);
    assert!(!crate::claude::cancel("blocked-synthetic"));
    assert!(crate::claude::run_prompt_stream(
        "blocked-synthetic",
        "hi",
        fixture.vault.to_str().unwrap(),
        None,
        None,
        |_| panic!("blocked run emitted an event")
    )
    .is_err());
    assert!(!crate::claude::cancel("blocked-synthetic"));
    fixture.assert_untouched();
}

#[test]
#[serial_test::serial]
fn cli_boundary_status_checks_do_not_spawn_version_or_settings_children() {
    let mut failures = Vec::new();
    for (provider, variable) in [
        ("anthropic-cli", "MYCO_CLAUDE_PATH"),
        ("codex-cli", "MYCO_CODEX_PATH"),
        ("gemini-cli", "MYCO_GEMINI_PATH"),
    ] {
        let fixture = Fixture::new();
        let _override = Override::set(variable, &fixture.child);
        let status = if provider == "anthropic-cli" {
            crate::claude::check()
        } else {
            check(provider)
        };
        assert!(status.installed);
        if fixture.launched.exists() {
            failures.push(format!(
                "{provider}: status check launched unconfined --version child"
            ));
        } else {
            fixture.assert_untouched();
            assert_eq!(status.version, None);
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}
