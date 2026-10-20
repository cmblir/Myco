//! Actual process cutoff/restart with synthetic native compilation callbacks.
//! No model inference, installed dispatch or power-loss guarantee is exercised.

use super::*;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::os::unix::fs::{MetadataExt, PermissionsExt};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

const CHILD_TEST: &str = "session_compile::publication::compiled::custody_tests::retirement_process_tests::retirement_process_child";
const ROOT_ENV: &str = "MYCO_CUSTODY_RETIREMENT_QA_ROOT";
const PHASE_ENV: &str = "MYCO_CUSTODY_RETIREMENT_QA_PHASE";
const MARKER: &str = "Synthetic native custody retirement process regression only";
const HUMAN: &str = "\nHuman postscript remains outside the generated section.\n";
const WATCHDOG: Duration = Duration::from_secs(20);

#[derive(Serialize, Deserialize)]
struct Registration {
    root: PathBuf,
    data: PathBuf,
    source: session::SourceBinding,
    step: u8,
    reappear: bool,
}

struct ChildGuard {
    child: Child,
    stdout: PathBuf,
    stderr: PathBuf,
    reaped: bool,
}

impl ChildGuard {
    fn spawn(registration: &Registration, phase: &str) -> Self {
        let stdout = registration
            .root
            .join(format!("retirement-{phase}.stdout.log"));
        let stderr = registration
            .root
            .join(format!("retirement-{phase}.stderr.log"));
        let child = Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                CHILD_TEST,
                "--ignored",
                "--nocapture",
                "--test-threads=1",
            ])
            .env(ROOT_ENV, &registration.root)
            .env(PHASE_ENV, phase)
            .env("MYCO_DATA_DIR", &registration.data)
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

    fn ready(&mut self, root: &Path) -> Value {
        let deadline = Instant::now() + WATCHDOG;
        loop {
            match std::fs::read(root.join("retirement-ready.json")) {
                Ok(bytes) => return serde_json::from_slice(&bytes).unwrap(),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => (),
                Err(error) => panic!("read retirement child readiness: {error}"),
            }
            if let Some(status) = self.child.try_wait().unwrap() {
                self.reaped = true;
                panic!(
                    "retirement child exited before readiness: {status}; {}",
                    self.diagnostics()
                );
            }
            assert!(
                Instant::now() < deadline,
                "retirement readiness watchdog; {}",
                self.diagnostics()
            );
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    fn kill_and_reap(&mut self) {
        assert!(
            self.child.try_wait().unwrap().is_none(),
            "{}",
            self.diagnostics()
        );
        self.child.kill().unwrap();
        let status = self.child.wait().unwrap();
        self.reaped = true;
        use std::os::unix::process::ExitStatusExt;
        assert_eq!(status.signal(), Some(9), "{status}; {}", self.diagnostics());
    }

    fn wait_success(&mut self) {
        let deadline = Instant::now() + WATCHDOG;
        loop {
            if let Some(status) = self.child.try_wait().unwrap() {
                self.reaped = true;
                assert!(
                    status.success(),
                    "retirement child failed: {status}; {}",
                    self.diagnostics()
                );
                return;
            }
            assert!(
                Instant::now() < deadline,
                "retirement completion watchdog; {}",
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
                    eprintln!("retirement child cleanup kill failed: {error}");
                }
                match self.child.wait() {
                    Ok(_) => self.reaped = true,
                    Err(error) => eprintln!("retirement child cleanup reap failed: {error}"),
                }
            }
        }
    }
}

fn read_json(path: &Path) -> Value {
    serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap()
}

fn write_json(path: &Path, value: &Value) {
    crate::settings::atomic_write(path, &serde_json::to_vec(value).unwrap()).unwrap();
}

fn inventory() -> BTreeMap<String, (Vec<u8>, u64, u64)> {
    std::fs::read_dir(store_directory())
        .unwrap()
        .map(|entry| {
            let path = entry.unwrap().path();
            let metadata = std::fs::symlink_metadata(&path).unwrap();
            assert!(metadata.is_file() && !metadata.file_type().is_symlink());
            (
                path.file_name().unwrap().to_str().unwrap().into(),
                (
                    std::fs::read(&path).unwrap(),
                    metadata.dev(),
                    metadata.ino(),
                ),
            )
        })
        .collect()
}

#[test]
fn distinct_process_resumes_each_unlink_before_cursor_acknowledgement() {
    for step in 0..3 {
        run_process_control(step, false);
    }
}

#[test]
fn distinct_process_preserves_same_bytes_leaf_reappearing_below_acknowledged_cursor() {
    run_process_control(1, true);
}

fn run_process_control(step: u8, reappear: bool) {
    with_isolated_data("compiler-custody-retirement-process", |data| {
        let (directory, _parent_vault, source) = fixture();
        let registration = Registration {
            root: directory.path().canonicalize().unwrap(),
            data: data.canonicalize().unwrap(),
            source,
            step,
            reappear,
        };
        std::fs::write(registration.root.join("retirement-process.marker"), MARKER).unwrap();
        std::fs::write(
            registration.root.join("retirement-registration.json"),
            serde_json::to_vec(&registration).unwrap(),
        )
        .unwrap();
        let mut first = ChildGuard::spawn(&registration, "prepare");
        let ready = first.ready(&registration.root);
        assert_eq!(ready["pid"], first.child.id());
        assert_ne!(first.child.id(), std::process::id());
        assert_eq!(ready["step"], step);
        if reappear {
            first.wait_success();
        } else {
            first.kill_and_reap();
        }
        let canonical = registration
            .root
            .join(ready["context"]["summaryPath"].as_str().unwrap());
        let canonical_before = std::fs::read(&canonical).unwrap();
        assert_eq!(
            source_revision(std::str::from_utf8(&canonical_before).unwrap()),
            ready["canonicalSha256"]
        );
        let head_before = read_json(&only_file(".head.json"));
        assert_eq!(head_before["retirementStep"], step);
        assert_eq!(head_before["retirementState"], "pending");
        if !reappear {
            let prefix = ready["oldLeaf"]
                .as_str()
                .unwrap()
                .strip_suffix("anchor")
                .unwrap();
            let suffix = ["anchor", "baseline.txt", "record.json"][step as usize];
            assert_eq!(ready["removedLeaf"], format!("{prefix}{suffix}"));
            assert!(!store_directory()
                .join(ready["removedLeaf"].as_str().unwrap())
                .exists());
        }
        let original_before =
            std::fs::read(registration.root.join(&registration.source.raw_path)).unwrap();
        assert_eq!(original_before, RAW.as_bytes());
        let mut second = ChildGuard::spawn(&registration, "resume");
        second.wait_success();
        let result = read_json(&registration.root.join("retirement-result.json"));
        assert_eq!(result["pid"], second.child.id());
        assert_ne!(result["pid"], ready["pid"]);
        assert!(result["freshOpening"].as_bool().unwrap());
        assert!(result["freshRole"].as_bool().unwrap());
        assert_eq!(
            result["state"],
            if reappear { "pending" } else { "complete" }
        );
        assert_eq!(std::fs::read(canonical).unwrap(), canonical_before);
        assert_eq!(
            std::fs::read(registration.root.join(&registration.source.raw_path)).unwrap(),
            original_before
        );
        assert!(!registration.data.join("models").exists());
        println!(
            "SYNTHETIC_RETIREMENT_PROCESS={}",
            json!({"step":step,"reappearance":reappear,
            "firstPid":ready["pid"],"resumedPid":result["pid"],"osKillObserved":!reappear,
            "result":result,"modelInference":false,"publicWry":false,"powerLossTested":false})
        );
    });
}

#[test]
#[ignore = "spawned only by explicit synthetic retirement process acceptance controls"]
fn retirement_process_child() {
    let root = PathBuf::from(std::env::var_os(ROOT_ENV).expect("explicit synthetic root required"));
    assert!(root.is_absolute());
    assert_eq!(root.canonicalize().unwrap(), root);
    assert!(root
        .file_name()
        .unwrap()
        .to_string_lossy()
        .starts_with("myco-compiler-custody-synthetic-"));
    assert_eq!(
        std::fs::read_to_string(root.join("retirement-process.marker")).unwrap(),
        MARKER
    );
    let registration: Registration =
        serde_json::from_slice(&std::fs::read(root.join("retirement-registration.json")).unwrap())
            .unwrap();
    assert_eq!(root, registration.root);
    assert!(registration.step <= 2);
    assert_eq!(
        PathBuf::from(
            std::env::var_os("MYCO_DATA_DIR").expect("explicit synthetic app data required")
        )
        .canonicalize()
        .unwrap(),
        registration.data
    );
    assert!(std::env::var_os("MEMEX_DATA_DIR").is_none());
    assert_eq!(
        crate::settings::settings_dir()
            .unwrap()
            .canonicalize()
            .unwrap(),
        registration.data
    );
    assert!(!registration.data.join("models").exists());
    match std::env::var(PHASE_ENV).unwrap().as_str() {
        "prepare" => prepare_child(&registration),
        "resume" => resume_child(&registration),
        phase => panic!("unknown retirement child phase: {phase}"),
    }
}

fn open_native(root: &Path) -> VaultRoot {
    let vault = VaultRoot::default();
    let opening = vault.begin_open().unwrap();
    vault
        .finish_open(opening, root.to_path_buf(), || ())
        .unwrap();
    vault
}

fn next_source(
    root: &Path,
    previous: &session::SourceBinding,
    ordinal: u8,
) -> session::SourceBinding {
    let raw = std::fs::read_to_string(root.join(&previous.raw_path)).unwrap()
        + &format!("\n**User:**\nPlease request synthetic process revision {ordinal}.\n");
    let source = session::SourceBinding {
        key: previous.key.clone(),
        raw_path: format!("raw/conversations/codex/synthetic-custody-process-r{ordinal}.md"),
        source_revision: source_revision(&raw),
    };
    append_raw(root, &source.raw_path, &raw).unwrap();
    admit(root, &source);
    source
}

fn prepare_child(registration: &Registration) {
    let root = &registration.root;
    let vault = open_native(root);
    let (first, outcome) = compile(&vault, &registration.source);
    assert_eq!(outcome.unwrap().state, session::WorkState::Completed);
    let canonical = root.join(&first.summary_path);
    let human = std::fs::read_to_string(&canonical).unwrap() + HUMAN;
    std::fs::write(&canonical, human).unwrap();
    let old_anchor = only_file(".anchor");
    let old_held = std::fs::File::open(&old_anchor).unwrap();
    let old_bytes = std::fs::read(&old_anchor).unwrap();
    let old_inode = old_held.metadata().unwrap().ino();
    let next = next_source(root, &registration.source, 2);
    *custody::ACTION_BUDGET.lock().unwrap() = Some(if registration.reappear { 1 } else { 0 });
    let (context, outcome) = compile(&vault, &next);
    assert_eq!(outcome.unwrap().state, session::WorkState::Completed);
    let sha = source_revision(&std::fs::read_to_string(&canonical).unwrap());
    assert!(std::fs::read_to_string(&canonical)
        .unwrap()
        .ends_with(HUMAN));
    let mut ready = json!({"pid":std::process::id(),"context":context.clone(),"step":registration.step,
        "canonicalSha256":sha,"oldLeaf":old_anchor.file_name().unwrap().to_str().unwrap()});
    if registration.reappear {
        assert!(!old_anchor.exists());
        std::fs::write(&old_anchor, old_bytes).unwrap();
        std::fs::set_permissions(&old_anchor, std::fs::Permissions::from_mode(0o600)).unwrap();
        assert_ne!(std::fs::metadata(&old_anchor).unwrap().ino(), old_inode);
        drop(old_held);
        ready["reappearedSha256"] = json!(source_revision(
            &std::fs::read_to_string(&old_anchor).unwrap()
        ));
        write_json(&root.join("retirement-ready.json"), &ready);
        return;
    }
    let mut store = custody::Store::open(root, &context).unwrap();
    let guard = crate::vault::lock_file_mutation().unwrap();
    let diagnostic = store
        .maintain_retirement_locked(&guard, registration.step as usize)
        .unwrap();
    assert_eq!(diagnostic.step, registration.step);
    assert!(!diagnostic.is_complete());
    let ready_path = root.join("retirement-ready.json");
    *custody::AFTER_UNLINK.lock().unwrap() = Some(Box::new(move |removed| {
        assert!(!removed.exists());
        ready["removedLeaf"] = json!(removed.file_name().unwrap().to_str().unwrap());
        write_json(&ready_path, &ready);
        loop {
            std::thread::park();
        }
    }));
    let _ = store.maintain_retirement_locked(&guard, 1);
    panic!("parent did not kill the child at the actual unlink/cursor boundary");
}

fn resume_child(registration: &Registration) {
    let root = &registration.root;
    let ready = read_json(&root.join("retirement-ready.json"));
    let old: SessionCompileContext = serde_json::from_value(ready["context"].clone()).unwrap();
    let vault = open_native(root);
    assert_ne!(std::process::id(), ready["pid"].as_u64().unwrap() as u32);
    assert!(session::complete(&vault, &old, std::slice::from_ref(&old.summary_path)).is_err());
    let before_admission = Pending::try_load(root).unwrap();
    let completed = before_admission
        .compile_jobs
        .iter()
        .find(|job| job.id == old.job_id)
        .unwrap();
    assert_eq!(completed.state, session::WorkState::Completed);
    assert!(completed.superseded_by.is_none());
    assert_eq!(completed.receipts.len(), 1);
    assert_eq!(completed.receipts[0].attempt_id, old.attempt_id);
    let completed_attempt = completed
        .attempts
        .iter()
        .find(|attempt| attempt.id == old.attempt_id)
        .unwrap();
    assert_eq!(completed_attempt.state, session::WorkState::Completed);
    assert!(completed_attempt.checks.completed_compilation());
    assert_eq!(completed_attempt.outputs, completed.receipts[0].outputs);
    let receipts_before = serde_json::to_value(&completed.receipts).unwrap();
    let attempts_before = serde_json::to_value(&completed.attempts).unwrap();
    let source = next_source(root, &old.source, 3);
    let fresh = session::begin(
        &vault,
        &vault.snapshot().unwrap(),
        source,
        RoleUsage::Foreground,
    )
    .unwrap();
    assert_ne!(fresh.origin.opening_token, old.origin.opening_token);
    assert_ne!(
        fresh.role_snapshot.snapshot_id,
        old.role_snapshot.snapshot_id
    );
    let before = inventory();
    let head_path = only_file(".head.json");
    let head_before = read_json(&head_path);
    if registration.reappear {
        let error = session::execution::step(
            &vault,
            &fresh,
            "en",
            &AtomicBool::new(false),
            |_, _| panic!("pending retirement must not tokenize"),
            |_, _, _, _, _| panic!("pending retirement must not generate"),
        )
        .err()
        .expect("reappeared acknowledged leaf must block the fresh attempt");
        assert_eq!(
            error.outcome.as_ref().unwrap().state,
            session::WorkState::Pending
        );
        assert_eq!(
            error.outcome.as_ref().unwrap().reason.code(),
            "custody_retirement_pending"
        );
        assert!(error.finalization_error.is_none());
        let after = inventory();
        for (leaf, value) in &before {
            if !leaf.ends_with(".head.json") {
                assert_eq!(after.get(leaf), Some(value), "{leaf}");
            }
        }
        assert_eq!(before.len(), after.len());
        let head = read_json(&only_file(".head.json"));
        assert_eq!(head["retirementStep"], 1);
        assert_eq!(head["retirementState"], "retained");
        assert_eq!(head["retirementReason"], "reappeared_below_cursor");
        let old_leaf = ready["oldLeaf"].as_str().unwrap();
        assert_eq!(
            source_revision(&std::fs::read_to_string(store_directory().join(old_leaf)).unwrap()),
            ready["reappearedSha256"]
        );
    } else {
        assert!(!store_directory()
            .join(ready["removedLeaf"].as_str().unwrap())
            .exists());
        let diagnostic = session::with_attempt(&vault, &fresh, |root, _, _| {
            session::publication::maintain_custody(root, &fresh)
        })
        .unwrap();
        assert!(diagnostic.is_complete());
        assert_eq!(diagnostic.step, 3);
        let after = inventory();
        assert_eq!(after.len(), 4);
        let head = read_json(&only_file(".head.json"));
        assert_eq!(head["retirementStep"], 3);
        assert_eq!(head["retirementState"], "complete");
        assert_eq!(head["generation"], head_before["generation"]);
        assert_eq!(head["recordSha256"], head_before["recordSha256"]);
        let head_leaf = head_path.file_name().unwrap().to_str().unwrap();
        let key = head_leaf.strip_suffix(".head.json").unwrap();
        let current_prefix = format!("{key}.{}", head["generation"].as_str().unwrap());
        let mut expected_leaves = vec![head_leaf.to_owned()];
        for suffix in ["anchor", "baseline.txt", "record.json"] {
            let leaf = format!("{current_prefix}.{suffix}");
            assert_eq!(after.get(&leaf), before.get(&leaf), "{leaf}");
            expected_leaves.push(leaf);
        }
        expected_leaves.sort();
        assert_eq!(after.keys().cloned().collect::<Vec<_>>(), expected_leaves);
    }
    assert!(std::fs::read_to_string(root.join(&fresh.summary_path))
        .unwrap()
        .ends_with(HUMAN));
    assert_eq!(
        session::checked_source(root, &registration.source).unwrap(),
        RAW
    );
    session::checked_source(root, &old.source).unwrap();
    session::checked_source(root, &fresh.source).unwrap();
    let pending = Pending::try_load(root).unwrap();
    let completed = pending
        .compile_jobs
        .iter()
        .find(|job| job.id == old.job_id)
        .unwrap();
    // Admitting R3 supersedes the R2 job while retaining its completed evidence.
    assert_eq!(completed.state, session::WorkState::Superseded);
    assert_eq!(
        completed.superseded_by.as_deref(),
        Some(fresh.source.source_revision.as_str())
    );
    assert_eq!(
        completed.reason.as_deref(),
        Some("new_immutable_source_revision_admitted")
    );
    assert_eq!(completed.receipts.len(), 1);
    assert_eq!(
        serde_json::to_value(&completed.receipts).unwrap(),
        receipts_before
    );
    assert_eq!(
        serde_json::to_value(&completed.attempts).unwrap(),
        attempts_before
    );
    write_json(
        &root.join("retirement-result.json"),
        &json!({"pid":std::process::id(),
        "freshOpening":true,"freshRole":true,"state":if registration.reappear { "pending" } else { "complete" },
        "step":registration.step,"modelInference":false,"oldCompletionRestored":false}),
    );
}
