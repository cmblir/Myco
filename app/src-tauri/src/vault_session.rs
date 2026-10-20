//! Native opening identity for work that must stay bound to its source vault.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};

static NEXT_OPENING: AtomicU64 = AtomicU64::new(1);
static PROCESS_IDENTITY: OnceLock<Result<String, String>> = OnceLock::new();

/// Native process identity is independent of paths, clocks and persisted state.
pub(crate) fn process_identity() -> Result<&'static str, String> {
    PROCESS_IDENTITY
        .get_or_init(|| {
            let mut nonce = [0u8; 16];
            getrandom::fill(&mut nonce)
                .map_err(|error| format!("vault process identity entropy failed: {error}"))?;
            Ok(nonce.iter().map(|byte| format!("{byte:02x}")).collect())
        })
        .as_deref()
        .map_err(Clone::clone)
}

/// The generation is for transition ordering; callers treat this token as opaque.
pub(crate) fn opening_token(generation: u64) -> Result<String, String> {
    if generation == 0 {
        return Err("vault opening identity unavailable".into());
    }
    Ok(format!("{}:{generation:x}", process_identity()?))
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentVaultSession {
    pub vault_path: String,
    pub opening_token: String,
}

#[derive(Default)]
struct Opening {
    root: Option<PathBuf>,
    generation: u64,
}

#[derive(Default)]
pub struct VaultRoot(Mutex<Opening>);

impl VaultRoot {
    /// Invalidate old work before validating a new root, even on a failed open.
    pub(crate) fn begin_open(&self) -> Result<u64, String> {
        let mut opening = self.0.lock().map_err(|_| "vault session lock poisoned")?;
        opening.generation = NEXT_OPENING.fetch_add(1, Ordering::Relaxed);
        opening_token(opening.generation)?;
        Ok(opening.generation)
    }

    /// Keep root publication and dependent opening effects in one transition.
    pub(crate) fn finish_open<T>(
        &self,
        generation: u64,
        root: PathBuf,
        publish: impl FnOnce() -> T,
    ) -> Result<T, String> {
        let mut opening = self.0.lock().map_err(|_| "vault session lock poisoned")?;
        if opening.generation != generation {
            return Err("vault opening was superseded".into());
        }
        opening.root = Some(root);
        Ok(publish())
    }

    pub(crate) fn close(&self) -> Result<(), String> {
        let mut opening = self.0.lock().map_err(|_| "vault session lock poisoned")?;
        opening.generation = NEXT_OPENING.fetch_add(1, Ordering::Relaxed);
        opening.root = None;
        Ok(())
    }

    pub fn current(&self) -> Option<PathBuf> {
        self.0.lock().ok()?.root.clone()
    }

    pub(crate) fn get(&self) -> Option<PathBuf> {
        self.current()
    }

    #[cfg(test)]
    pub(crate) fn is_transition_locked_for_test(&self) -> Result<bool, String> {
        match self.0.try_lock() {
            Ok(_) => Ok(false),
            Err(std::sync::TryLockError::WouldBlock) => Ok(true),
            Err(std::sync::TryLockError::Poisoned(_)) => Err("vault session lock poisoned".into()),
        }
    }

    pub(crate) fn snapshot(&self) -> Result<AgentVaultSession, String> {
        let opening = self.0.lock().map_err(|_| "vault session lock poisoned")?;
        let root = opening.root.as_ref().ok_or("no vault is open")?;
        Ok(AgentVaultSession {
            vault_path: root.to_string_lossy().into_owned(),
            opening_token: opening_token(opening.generation)?,
        })
    }

    /// Hold the transition lock through dispatch so checking cannot race a switch.
    pub(crate) fn with_origin<T>(
        &self,
        origin: &AgentVaultSession,
        dispatch: impl FnOnce(&Path) -> Result<T, String>,
    ) -> Result<T, String> {
        let opening = self.0.lock().map_err(|_| "vault session lock poisoned")?;
        let root = opening.root.as_ref().ok_or("no vault is open")?;
        if root != Path::new(&origin.vault_path)
            || origin.opening_token != opening_token(opening.generation)?
        {
            return Err("the active vault changed before the action started".into());
        }
        dispatch(root)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn open(state: &VaultRoot, root: &Path) {
        let generation = state.begin_open().unwrap();
        state
            .finish_open(generation, root.canonicalize().unwrap(), || ())
            .unwrap();
    }

    #[test]
    #[ignore = "only spawned with an explicit synthetic vault by the restart regression"]
    fn synthetic_first_opening_child() {
        let root = PathBuf::from(
            std::env::var_os("MYCO_ORIGIN_PROBE_VAULT")
                .expect("MYCO_ORIGIN_PROBE_VAULT is required; no private fallback"),
        );
        assert!(root.is_absolute());
        assert!(root
            .file_name()
            .unwrap()
            .to_string_lossy()
            .starts_with("myco-synthetic-opening-"));
        assert_eq!(
            std::fs::read_to_string(root.join("synthetic.marker")).unwrap(),
            "Synthetic opening regression only"
        );
        let state = VaultRoot::default();
        open(&state, &root);
        let current = state.snapshot().unwrap();
        let previous_accepted = std::env::var("MYCO_ORIGIN_PREVIOUS_TOKEN")
            .ok()
            .is_some_and(|token| {
                state
                    .with_origin(
                        &AgentVaultSession {
                            vault_path: current.vault_path.clone(),
                            opening_token: token,
                        },
                        |_| Ok(()),
                    )
                    .is_ok()
            });
        println!(
            "SYNTHETIC_FIRST_OPENING={}",
            serde_json::json!({
                "token":current.opening_token,
                "previousAccepted":previous_accepted
            })
        );
    }

    #[test]
    fn native_opening_rejects_a_previous_process_first_opening() {
        let vault = tempfile::Builder::new()
            .prefix("myco-synthetic-opening-")
            .tempdir()
            .unwrap();
        std::fs::write(
            vault.path().join("synthetic.marker"),
            "Synthetic opening regression only",
        )
        .unwrap();
        let run = |previous: Option<&str>| {
            let mut child = std::process::Command::new(std::env::current_exe().unwrap());
            child
                .args([
                    "--exact",
                    "vault_session::tests::synthetic_first_opening_child",
                    "--ignored",
                    "--nocapture",
                    "--test-threads=1",
                ])
                .env("MYCO_ORIGIN_PROBE_VAULT", vault.path())
                .env_remove("MYCO_ORIGIN_PREVIOUS_TOKEN");
            if let Some(previous) = previous {
                child.env("MYCO_ORIGIN_PREVIOUS_TOKEN", previous);
            }
            let output = child.output().unwrap();
            assert!(
                output.status.success(),
                "synthetic child failed: {}",
                String::from_utf8_lossy(&output.stderr)
            );
            let stdout = String::from_utf8(output.stdout).unwrap();
            let record = stdout
                .lines()
                .find_map(|line| {
                    line.find("SYNTHETIC_FIRST_OPENING=")
                        .map(|offset| &line[offset + 24..])
                })
                .expect("synthetic child must emit its actual native opening");
            serde_json::from_str::<serde_json::Value>(record).unwrap()
        };
        let first = run(None);
        let previous = first["token"].as_str().unwrap();
        let second = run(Some(previous));
        assert_eq!(
            second["previousAccepted"], false,
            "another process must reject the prior first-opening token for the same path"
        );
        assert_ne!(second["token"].as_str().unwrap(), previous);
        assert_eq!(
            std::fs::read_to_string(vault.path().join("synthetic.marker")).unwrap(),
            "Synthetic opening regression only"
        );
    }

    #[test]
    fn native_opening_rejects_same_root_reopen_before_dispatch() {
        let vault = tempfile::tempdir().unwrap();
        let state = VaultRoot::default();
        open(&state, vault.path());
        let origin = state.snapshot().unwrap();
        open(&state, vault.path());
        assert!(state.with_origin(&origin, |_| Ok(())).is_err());
    }

    #[test]
    fn native_opening_rejects_work_when_a_new_open_fails() {
        let vault = tempfile::tempdir().unwrap();
        let state = VaultRoot::default();
        open(&state, vault.path());
        let origin = state.snapshot().unwrap();
        state.begin_open().unwrap();
        assert_eq!(state.current(), Some(vault.path().canonicalize().unwrap()));
        assert!(state.with_origin(&origin, |_| Ok(())).is_err());
    }

    #[test]
    fn native_opening_close_cannot_be_revived_by_an_older_open() {
        let vault = tempfile::tempdir().unwrap();
        let state = VaultRoot::default();
        let generation = state.begin_open().unwrap();
        state.close().unwrap();
        assert!(state
            .finish_open(generation, vault.path().to_path_buf(), || ())
            .is_err());
        assert!(state.snapshot().is_err());
    }

    #[test]
    fn native_opening_rejects_switched_root_and_accepts_current_origin() {
        let first = tempfile::tempdir().unwrap();
        let second = tempfile::tempdir().unwrap();
        let state = VaultRoot::default();
        open(&state, first.path());
        let origin = state.snapshot().unwrap();
        open(&state, second.path());
        assert!(state.with_origin(&origin, |_| Ok(())).is_err());
        let current = state.snapshot().unwrap();
        assert_eq!(
            state
                .with_origin(&current, |root| Ok(root.to_path_buf()))
                .unwrap(),
            second.path().canonicalize().unwrap()
        );
    }

    #[test]
    fn native_opening_stale_agent_write_cannot_touch_either_vault() {
        let first = tempfile::tempdir().unwrap();
        let second = tempfile::tempdir().unwrap();
        for root in [first.path(), second.path()] {
            std::fs::create_dir(root.join("wiki")).unwrap();
        }
        let state = VaultRoot::default();
        open(&state, first.path());
        let origin = state.snapshot().unwrap();
        for root in [second.path(), first.path()] {
            open(&state, root);
            assert!(state.with_origin(&origin, |root| crate::agent_tools::dispatch(
                &root.to_string_lossy(), "create_page",
                &serde_json::json!({"path": "wiki/proposal.md", "content": "Synthetic proposal"}), true,
            )).is_err());
            assert!(!first.path().join("wiki/proposal.md").exists());
            assert!(!second.path().join("wiki/proposal.md").exists());
        }
        let current = state.snapshot().unwrap();
        state.with_origin(&current, |root| crate::agent_tools::dispatch(
            &root.to_string_lossy(), "create_page",
            &serde_json::json!({"path": "wiki/proposal.md", "content": "Synthetic proposal"}), true,
        )).unwrap();
        assert_eq!(
            std::fs::read_to_string(first.path().join("wiki/proposal.md")).unwrap(),
            "Synthetic proposal"
        );
    }
}
