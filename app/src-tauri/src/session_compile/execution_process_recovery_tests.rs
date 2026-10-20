//! Actual OS process termination and native checkpoint recovery with synthetic
//! callbacks. This is not model, public IPC, installed-app or power-loss QA.

use super::*;
use crate::session_compile::{SessionCompileContext, SourceBinding};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, ExitStatus, Stdio};
use std::time::{Duration, Instant};

#[path = "execution_process_recovery_child.rs"]
mod child;

const CHILD_TEST: &str = "session_compile::execution::tests::process_recovery_tests::child::synthetic_checkpoint_recovery_child";
const MARKER: &str = "Synthetic checkpoint crash/recovery regression only";
const ROOT_ENV: &str = "MYCO_SESSION_RECOVERY_QA_ROOT";
const PHASE_ENV: &str = "MYCO_SESSION_RECOVERY_QA_PHASE";
const WATCHDOG: Duration = Duration::from_secs(15);

#[derive(Serialize, Deserialize)]
struct Registration {
    version: u8,
    vault: PathBuf,
    data: PathBuf,
    source: SourceBinding,
    usage: RoleUsage,
}

#[derive(Serialize, Deserialize)]
struct CheckpointReady {
    version: u8,
    child_pid: u32,
    context: SessionCompileContext,
    queue_sha256: String,
    old_attempt: Value,
    original_sha256: String,
    human_sha256: String,
    bound_request: String,
    compiler_busy: bool,
}

struct ChildGuard {
    child: Child,
    stdout: PathBuf,
    stderr: PathBuf,
    reaped: bool,
}

impl ChildGuard {
    fn spawn(root: &Path, data: &Path, phase: &str) -> Self {
        let stdout = root.join(format!("recovery-{phase}.stdout.log"));
        let stderr = root.join(format!("recovery-{phase}.stderr.log"));
        let child = Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                CHILD_TEST,
                "--ignored",
                "--nocapture",
                "--test-threads=1",
            ])
            .env(ROOT_ENV, root)
            .env(PHASE_ENV, phase)
            .env("MYCO_DATA_DIR", data)
            .env_remove("MEMEX_DATA_DIR")
            .env_remove("MYCO_QA_GENERATION")
            .stdin(Stdio::null())
            .stdout(Stdio::from(std::fs::File::create(&stdout).unwrap()))
            .stderr(Stdio::from(std::fs::File::create(&stderr).unwrap()))
            .spawn()
            .unwrap();
        Self {
            child,
            stdout,
            stderr,
            reaped: false,
        }
    }

    fn diagnostics(&self) -> String {
        format!(
            "stdout:\n{}\nstderr:\n{}",
            std::fs::read_to_string(&self.stdout).unwrap_or_else(|error| error.to_string()),
            std::fs::read_to_string(&self.stderr).unwrap_or_else(|error| error.to_string())
        )
    }

    fn require_live(&mut self) {
        match self.child.try_wait().unwrap() {
            None => (),
            Some(status) => {
                self.reaped = true;
                panic!(
                    "synthetic recovery child terminated before OS kill: {status}; {}",
                    self.diagnostics()
                );
            }
        }
    }

    fn wait_ready(&mut self, root: &Path) -> CheckpointReady {
        let deadline = Instant::now() + WATCHDOG;
        loop {
            self.require_live();
            match std::fs::read(root.join("checkpoint-ready.json")) {
                Ok(bytes) => return serde_json::from_slice(&bytes).unwrap(),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => (),
                Err(error) => panic!("read synthetic checkpoint readiness: {error}"),
            }
            assert!(
                Instant::now() < deadline,
                "synthetic checkpoint readiness watchdog fired; {}",
                self.diagnostics()
            );
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    fn kill_and_reap(&mut self) -> ExitStatus {
        self.require_live();
        self.child.kill().unwrap_or_else(|error| {
            panic!(
                "OS kill of synthetic checkpoint child failed: {error}; {}",
                self.diagnostics()
            )
        });
        let status = self.child.wait().unwrap();
        self.reaped = true;
        status
    }

    fn wait_success(&mut self) {
        let deadline = Instant::now() + WATCHDOG;
        loop {
            if let Some(status) = self.child.try_wait().unwrap() {
                self.reaped = true;
                assert!(
                    status.success(),
                    "synthetic recovery child failed: {status}; {}",
                    self.diagnostics()
                );
                return;
            }
            assert!(
                Instant::now() < deadline,
                "synthetic restart child watchdog fired; {}",
                self.diagnostics()
            );
            std::thread::sleep(Duration::from_millis(10));
        }
    }
}

impl Drop for ChildGuard {
    fn drop(&mut self) {
        if self.reaped {
            return;
        }
        match self.child.try_wait() {
            Ok(Some(_)) => self.reaped = true,
            Ok(None) | Err(_) => {
                if let Err(error) = self.child.kill() {
                    eprintln!("cleanup OS kill of synthetic recovery child failed: {error}");
                }
                match self.child.wait() {
                    Ok(_) => self.reaped = true,
                    Err(error) => {
                        eprintln!("cleanup reap of synthetic recovery child failed: {error}")
                    }
                }
            }
        }
    }
}

#[test]
fn os_kill_and_restart_preserve_checkpoint_and_require_fresh_foreground_review() {
    run_process_recovery(RoleUsage::Foreground);
}

#[test]
fn os_kill_and_restart_preserve_checkpoint_and_require_fresh_automatic_review() {
    run_process_recovery(RoleUsage::Automatic);
}

fn run_process_recovery(usage: RoleUsage) {
    with_isolated_data("compiler-process-checkpoint-recovery", |data| {
        crate::settings::save(&crate::settings::Settings {
            auto_ingest_enabled: true,
            ..Default::default()
        })
        .unwrap();
        let (directory, _parent_vault, _parent_origin, source) = fixture();
        let root = directory.path().canonicalize().unwrap();
        let data = data.canonicalize().unwrap();
        std::fs::write(root.join("process-recovery.marker"), MARKER).unwrap();
        let human = format!("---\ntype: source-summary\nsession_key: {}\n---\n# Synthetic human title\n\nHuman annotation remains.\n",
            serde_json::to_string(&source.key).unwrap());
        std::fs::create_dir_all(root.join("wiki")).unwrap();
        std::fs::write(root.join("wiki/session.md"), &human).unwrap();
        let original = std::fs::read(root.join(&source.raw_path)).unwrap();
        let registration = Registration {
            version: 1,
            vault: root.clone(),
            data: data.clone(),
            source: source.clone(),
            usage,
        };
        std::fs::write(
            root.join("process-registration.json"),
            serde_json::to_vec(&registration).unwrap(),
        )
        .unwrap();

        let mut first = ChildGuard::spawn(&root, &data, "prepare");
        let ready = first.wait_ready(&root);
        assert_eq!(ready.version, 1);
        assert_eq!(ready.child_pid, first.child.id());
        assert!(ready.compiler_busy);
        assert_eq!(ready.context.source, source);
        assert_eq!(ready.context.role_snapshot.usage, usage);
        assert_eq!(ready.context.summary_path, "wiki/session.md");
        assert!(!ready.bound_request.is_empty());
        let before_kill = std::fs::read(Pending::path(&root)).unwrap();
        assert_eq!(
            source_revision(std::str::from_utf8(&before_kill).unwrap()),
            ready.queue_sha256
        );
        let status = first.kill_and_reap();
        assert!(
            !status.success(),
            "an actual OS kill must not become a graceful successful exit"
        );
        #[cfg(unix)]
        {
            use std::os::unix::process::ExitStatusExt;
            assert_eq!(status.signal(), Some(9));
        }
        assert_eq!(std::fs::read(Pending::path(&root)).unwrap(), before_kill);
        let crashed = Pending::try_load(&root).unwrap();
        assert_eq!(crashed.compile_jobs[0].state, WorkState::Running);
        assert_eq!(
            serde_json::to_value(&crashed.compile_jobs[0].attempts[0]).unwrap(),
            ready.old_attempt
        );
        assert_eq!(
            std::fs::read(root.join(&source.raw_path)).unwrap(),
            original
        );
        assert_eq!(
            std::fs::read_to_string(root.join("wiki/session.md")).unwrap(),
            human
        );
        assert!(!data.join("models").exists());

        let mut restarted = ChildGuard::spawn(&root, &data, "recover");
        restarted.wait_success();
        let result: Value =
            serde_json::from_slice(&std::fs::read(root.join("recovery-result.json")).unwrap())
                .unwrap();
        assert_eq!(result["childPid"], restarted.child.id());
        assert_eq!(result["usage"], serde_json::to_value(usage).unwrap());
        assert_eq!(result["freshReviewCalls"], 1);
        assert_eq!(result["freshReviewAccepted"], false);
        assert_eq!(result["viewStateBeforeBegin"], "pending");
        assert_eq!(
            result["viewReasonBeforeBegin"],
            "compiler_runtime_revalidation_required"
        );
        assert_eq!(
            std::fs::read(root.join(&source.raw_path)).unwrap(),
            original
        );
        assert_eq!(
            std::fs::read_to_string(root.join("wiki/session.md")).unwrap(),
            human
        );
        assert!(!data.join("models").exists());
        println!(
            "SYNTHETIC_PROCESS_RECOVERY={}",
            json!({"usage":usage,
            "firstChildPid":ready.child_pid,"restartedChildPid":restarted.child.id(),
            "osKillObserved":true,"restart":result,"modelInference":false,
            "generationCallbacks":"synthetic","publicWry":false,"installedApp":false,
            "egressObserved":false,"powerLossTested":false})
        );
    });
}

const APPENDED_REVISION_PATH: &str = "raw/conversations/codex/synthetic-native-r2.md";
const APPENDED_REVISION_TURN: &str =
    "\n**User:**\nThe synthetic report is withdrawn; do not treat it as completed.\n";
const HUMAN_POSTSCRIPT: &str = "\nHuman annotation after completed R1 remains.\n";

#[derive(Serialize, Deserialize)]
struct CompletedRevisionReady {
    child_pid: u32,
    context: SessionCompileContext,
    canonical_sha256: String,
    original_sha256: String,
    reviewed_packets: usize,
}

#[test]
fn completed_canonical_refreshes_appended_revision_after_distinct_process_restart() {
    run_completed_process_refresh(RoleUsage::Foreground);
}

#[test]
fn completed_canonical_automatically_refreshes_appended_revision_after_distinct_process_restart() {
    run_completed_process_refresh(RoleUsage::Automatic);
}

fn run_completed_process_refresh(usage: RoleUsage) {
    with_isolated_data("compiler-completed-process-refresh", |data| {
        if usage == RoleUsage::Automatic {
            crate::settings::save(&crate::settings::Settings {
                auto_ingest_enabled: true,
                ..Default::default()
            })
            .unwrap();
        }
        let (directory, _parent_vault, _parent_origin, source) = fixture();
        let root = directory.path().canonicalize().unwrap();
        let data = data.canonicalize().unwrap();
        std::fs::write(root.join("process-recovery.marker"), MARKER).unwrap();
        let registration = Registration {
            version: 1,
            vault: root.clone(),
            data: data.clone(),
            source: source.clone(),
            usage,
        };
        std::fs::write(
            root.join("process-registration.json"),
            serde_json::to_vec(&registration).unwrap(),
        )
        .unwrap();
        let original = std::fs::read_to_string(root.join(&source.raw_path)).unwrap();
        let mut first = ChildGuard::spawn(&root, &data, "complete-r1");
        first.wait_success();
        let completed: CompletedRevisionReady = serde_json::from_slice(
            &std::fs::read(root.join("completed-revision-ready.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(completed.child_pid, first.child.id());
        assert_eq!(completed.context.source, source);
        assert_eq!(completed.context.role_snapshot.usage, usage);
        assert!(completed.reviewed_packets > 0);
        assert_eq!(completed.original_sha256, source.source_revision);
        let canonical = root.join(&completed.context.summary_path);
        let published = std::fs::read_to_string(&canonical).unwrap();
        assert_eq!(source_revision(&published), completed.canonical_sha256);
        assert!(published.contains("<!-- myco:session-compilation:v1 "));
        let first_queue = Pending::try_load(&root).unwrap();
        let first_job = first_queue
            .compile_jobs
            .iter()
            .find(|job| job.source == source)
            .unwrap();
        assert_eq!(first_job.state, WorkState::Completed);
        assert_eq!(first_job.receipts.len(), 1);
        assert!(first_queue.pending.is_empty());

        // This is an explicit human edit after native R1 completion, outside
        // its generated section. No old native capability is serialized.
        let with_human = published + HUMAN_POSTSCRIPT;
        std::fs::write(&canonical, &with_human).unwrap();
        let mut restarted = ChildGuard::spawn(&root, &data, "append-r2");
        restarted.wait_success();
        let result: Value = serde_json::from_slice(
            &std::fs::read(root.join("completed-revision-result.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(result["childPid"], restarted.child.id());
        assert_ne!(restarted.child.id(), completed.child_pid);
        assert_ne!(
            result["freshOpening"],
            completed.context.origin.opening_token
        );
        assert_eq!(result["previousPrivateAuthorityPresent"], false);
        assert_eq!(result["oldContextRefused"], true);
        assert_eq!(result["canonicalPath"], completed.context.summary_path);
        assert_eq!(result["usage"], serde_json::to_value(usage).unwrap());
        let updated_raw = original.clone() + APPENDED_REVISION_TURN;
        assert_eq!(
            std::fs::read_to_string(root.join(&source.raw_path)).unwrap(),
            original
        );
        assert_eq!(
            std::fs::read_to_string(root.join(APPENDED_REVISION_PATH)).unwrap(),
            updated_raw
        );
        let current = std::fs::read_to_string(&canonical).unwrap();
        assert!(current.ends_with(HUMAN_POSTSCRIPT));
        assert!(!data.join("models").exists());
        let queue = Pending::try_load(&root).unwrap();
        let updated = SourceBinding {
            key: source.key.clone(),
            raw_path: APPENDED_REVISION_PATH.into(),
            source_revision: source_revision(&updated_raw),
        };
        let updated_job = queue
            .compile_jobs
            .iter()
            .find(|job| job.source == updated)
            .unwrap();
        let attempt = updated_job.attempts.last().unwrap();
        let progress = attempt.compiler_progress.as_ref().unwrap();
        assert_eq!(progress.next_packet, progress.batches.len());
        assert!(progress.next_packet > 0);
        assert!(progress
            .batches
            .iter()
            .all(|batch| batch.review_output.is_some()));
        assert_eq!(result["reviewedPackets"], progress.batches.len());
        assert_eq!(
            queue
                .compile_jobs
                .iter()
                .find(|job| job.source == source)
                .unwrap()
                .receipts
                .len(),
            1
        );
        if result["completed"] != true {
            // A refusal must leave the human-edited R1 intact and must not
            // counterfeit a successful R2 publication or completion receipt.
            assert_eq!(current, with_human);
            assert!(updated_job.receipts.is_empty());
            assert!(attempt.outputs.is_empty());
            assert!(result["failure"]["message"].is_string());
        }
        println!(
            "SYNTHETIC_COMPLETED_PROCESS_REFRESH={}",
            json!({
            "firstChildPid":completed.child_pid,"restartedChildPid":restarted.child.id(),
            "usage":usage,"firstProcessLog":first.diagnostics(),
            "restartedProcessLog":restarted.diagnostics(),
            "firstCanonicalSha256":completed.canonical_sha256,
            "humanCanonicalSha256":source_revision(&with_human),
            "canonicalAfterSha256":source_revision(&current),
            "result":result,"modelInference":false,"generationCallbacks":"synthetic",
            "publicWry":false,"installedApp":false,"egressObserved":false,"powerLossTested":false})
        );
        assert_eq!(result["completed"], true,
            "completed canonical R1 must accept freshly reviewed R2 after process restart; actual result: {result}; {}",
            restarted.diagnostics());
        assert_eq!(updated_job.state, WorkState::Completed);
        assert_eq!(updated_job.receipts.len(), 1);
        assert!(attempt.checks.completed_compilation());
        assert!(queue.pending.is_empty());
        let metadata = gray_matter::Matter::<gray_matter::engine::YAML>::new()
            .parse::<Value>(&current)
            .unwrap()
            .data
            .unwrap();
        assert_eq!(metadata["raw_path"], updated.raw_path);
        assert_eq!(metadata["session_revision"], updated.source_revision);
        assert_eq!(
            metadata["derived_from"],
            json!([source.raw_path, updated.raw_path])
        );
        assert!(current.contains("withdrawn"));
        assert_eq!(
            current.matches("<!-- myco:session-compilation:v1 ").count(),
            1
        );
    });
}
