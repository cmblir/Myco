// Native-bridge integration tests: the OS-facing behaviors that the ?mock
// browser route-smoke (scripts/route-smoke.mjs) cannot reach because they need
// the real Rust backend rather than the mocked IPC shim. Three surfaces:
//
//   1. keychain secret storage  (secrets::{set,get,delete}_key)
//   2. CLI agent spawning guard (cli_agent::{check,run_prompt})
//   3. MCP registration is exercised at the pure-logic level in the
//      mcp_server module's own #[cfg(test)] block (registration_info needs a
//      live tauri::AppHandle, so it stays a manual acceptance flow — see
//      app/docs/E2E.md).
//
// Tests that touch the real OS keychain are #[ignore]d: they persist a
// credential and, depending on the platform/session, may raise an interactive
// unlock prompt (macOS login keychain) or hard-fail with no secret-service
// (headless Linux CI). Run them deliberately on a machine with an unlocked
// keychain via:  cargo test --test native_bridges -- --ignored

use memex_lib::cli_agent;
use memex_lib::secrets;

// ---------- keychain secret storage (real OS keychain; #[ignore]) ----------

// A provider id unlikely to collide with a real Memex-stored key. Reused across
// the round-trip so we can guarantee cleanup.
const TEST_PROVIDER: &str = "memex-e2e-selftest-provider";

#[test]
#[ignore = "touches the real OS keychain: persists a credential and may prompt for unlock"]
fn keychain_set_get_delete_round_trip() {
    let secret = "sk-e2e-do-not-use-0123456789";

    // set -> get returns exactly what we stored.
    secrets::set_key(TEST_PROVIDER, secret).expect("set_key should succeed on an unlocked keychain");
    let got = secrets::get_key(TEST_PROVIDER).expect("get_key should not error");
    assert_eq!(got.as_deref(), Some(secret), "round-tripped secret must match");

    // delete -> get now returns None (absent), not an error.
    secrets::delete_key(TEST_PROVIDER).expect("delete_key should succeed");
    let after = secrets::get_key(TEST_PROVIDER).expect("get_key after delete should not error");
    assert_eq!(after, None, "deleted key must read back as absent");
}

#[test]
#[ignore = "touches the real OS keychain"]
fn keychain_delete_absent_is_idempotent() {
    // Deleting a key that was never stored is a no-op, never an error — the app
    // relies on this when the user hits "clear" on a provider with no saved key.
    secrets::delete_key("memex-e2e-never-stored-key").expect("deleting an absent key must be Ok");
}

#[test]
#[ignore = "touches the real OS keychain"]
fn keychain_get_absent_returns_none() {
    // Reading a provider with no stored secret is Ok(None), the sentinel the
    // Settings screen uses to render the "not set" state.
    let got = secrets::get_key("memex-e2e-definitely-absent").expect("get of absent key is Ok(None)");
    assert_eq!(got, None);
}

// ---------- CLI agent spawning guard (no #[ignore]: deterministic) ----------

#[test]
fn agent_check_unknown_provider_reports_not_installed() {
    // Pure: an unknown provider short-circuits before any process spawn.
    let s = cli_agent::check("not-a-real-cli");
    assert!(!s.installed);
    assert!(s.version.is_none());
    assert!(s.path.is_none());
}

#[test]
fn agent_check_known_provider_returns_coherent_status() {
    // Host-dependent (the CLI may or may not be installed here), so we assert
    // only the struct's internal invariant rather than a fixed value: an
    // "installed" status must carry a resolved path.
    for provider in ["gemini-cli", "codex-cli"] {
        let s = cli_agent::check(provider);
        if s.installed {
            assert!(
                s.path.is_some(),
                "{provider}: installed status must carry a path"
            );
        } else {
            assert!(s.path.is_none());
            assert!(s.version.is_none());
        }
    }
}

#[test]
fn agent_run_unknown_provider_errors_without_spawning() {
    let res = cli_agent::run_prompt("not-a-real-cli", "(default)", "hi", "/tmp");
    assert!(res.is_err(), "unknown provider must error");
}

#[test]
fn agent_run_rejects_nonexistent_cwd() {
    // Whether or not the CLI is installed, a missing working directory must be
    // rejected before the child is spawned into it. (If the binary isn't found
    // we get the earlier "not found" error — also Err, which is what we assert.)
    let missing = std::env::temp_dir().join("memex-e2e-no-such-cwd-zzz");
    let _ = std::fs::remove_dir_all(&missing);
    let res = cli_agent::run_prompt("codex-cli", "(default)", "hi", missing.to_str().unwrap());
    assert!(res.is_err(), "missing cwd must error");
}
