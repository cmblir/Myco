use super::*;

fn origin(token: &str) -> AgentVaultSession {
    AgentVaultSession {
        vault_path: "/synthetic/compiler-vault".into(),
        opening_token: token.into(),
    }
}
fn identity(role: &str, schema: &str) -> CompileIdentity {
    CompileIdentity {
        source: SourceBinding {
            key: "codex:synthetic-session".into(),
            raw_path: "raw/conversations/codex/source-r1.md".into(),
            source_revision: "a".repeat(64),
        },
        contract: CompilerContract {
            compiler: "compiler-v1".into(),
            schema: schema.into(),
            prompt: "prompt-v1".into(),
        },
        role_signature: role.into(),
    }
}
fn output(id: &str) -> NativeOutput {
    NativeOutput {
        publication_id: "b".repeat(64),
        attempt_id: id.into(),
        path: "wiki/source-synthetic.md".into(),
        revision: "c".repeat(64),
        identity: serde_json::json!({"device":7,"inode":9}),
        native_created: true,
    }
}
fn checks(semantic: CheckState) -> ProcessingChecks {
    ProcessingChecks {
        original_source: CheckState::Passed,
        source_schema: CheckState::Passed,
        semantic_review: semantic,
        eligible_units: 8,
        processed_units: 8,
        omitted_units: 0,
    }
}
fn running() -> CompilationJob {
    let binding = identity("local-a", "schema-v1");
    let mut job = CompilationJob::new("source-job".into(), binding.source.clone(), 1);
    job.begin(
        "attempt-a".into(),
        origin("process-a:1"),
        "role-a".into(),
        binding,
        2,
    )
    .unwrap();
    job
}

#[test]
fn source_schema_and_quote_coverage_do_not_establish_semantic_completion() {
    let mut job = running();
    assert!(!job
        .finish(
            "attempt-a",
            checks(CheckState::NotRun),
            vec![output("attempt-a")],
            3
        )
        .unwrap());
    assert_eq!(job.state, WorkState::Partial);
    assert!(job.receipts.is_empty());
    assert_eq!(job.attempts[0].checks.semantic_review, CheckState::NotRun);
}
#[test]
fn semantic_unavailable_rejected_and_omitted_units_remain_partial() {
    for state in [CheckState::Unavailable, CheckState::Rejected] {
        let mut job = running();
        assert!(!job
            .finish("attempt-a", checks(state), vec![output("attempt-a")], 3)
            .unwrap());
        assert!(job.receipts.is_empty());
    }
    let mut job = running();
    let mut check = checks(CheckState::Passed);
    check.omitted_units = 1;
    check.processed_units = 7;
    assert!(!job
        .finish("attempt-a", check, vec![output("attempt-a")], 3)
        .unwrap());
    assert!(job.receipts.is_empty());
}
#[test]
fn same_path_reopen_stops_old_attempt_without_reusing_its_output() {
    let mut job = running();
    job.attempts[0].outputs.push(output("attempt-a"));
    let binding = identity("local-a", "schema-v1");
    job.begin(
        "attempt-b".into(),
        origin("process-a:2"),
        "role-b".into(),
        binding.clone(),
        4,
    )
    .unwrap();
    assert_eq!(job.attempts[0].state, WorkState::Stopped);
    assert_eq!(job.attempts[0].outputs.len(), 1);
    assert!(job
        .active("attempt-a", &origin("process-a:1"), "role-a", &binding)
        .is_err());
    assert!(job
        .active("attempt-b", &origin("process-a:2"), "role-b", &binding)
        .is_ok());
    assert!(job
        .finish(
            "attempt-b",
            checks(CheckState::Passed),
            vec![output("attempt-a")],
            5
        )
        .is_err());
    assert!(job.receipts.is_empty());
}
#[test]
fn restart_roundtrip_retains_old_attempt_and_requires_new_origin_attempt() {
    let job = running();
    let bytes = serde_json::to_vec(&job).unwrap();
    let mut resumed: CompilationJob = serde_json::from_slice(&bytes).unwrap();
    let binding = identity("local-a", "schema-v1");
    resumed
        .begin(
            "attempt-b".into(),
            origin("process-b:1"),
            "role-b".into(),
            binding.clone(),
            4,
        )
        .unwrap();
    assert_eq!(resumed.attempts.len(), 2);
    assert_eq!(resumed.attempts[0].state, WorkState::Stopped);
    assert!(resumed
        .active("attempt-a", &origin("process-a:1"), "role-a", &binding)
        .is_err());
}
#[test]
fn role_schema_or_prompt_change_invalidates_old_attempt_and_preserves_receipt_history() {
    let mut changed_prompt = identity("local-a", "schema-v1");
    changed_prompt.contract.prompt = "prompt-v2".into();
    for changed in [
        identity("local-b", "schema-v1"),
        identity("local-a", "schema-v2"),
        changed_prompt,
    ] {
        let mut job = running();
        assert!(job
            .finish(
                "attempt-a",
                checks(CheckState::Passed),
                vec![output("attempt-a")],
                3
            )
            .unwrap());
        assert_eq!(job.receipts.len(), 1);
        job.begin(
            "attempt-b".into(),
            origin("process-a:1"),
            "role-b".into(),
            changed.clone(),
            4,
        )
        .unwrap();
        assert!(job
            .active(
                "attempt-a",
                &origin("process-a:1"),
                "role-a",
                &identity("local-a", "schema-v1")
            )
            .is_err());
        assert_eq!(job.receipts.len(), 1);
        assert_ne!(job.receipts[0].identity, changed);
    }
}
#[test]
fn running_attempt_is_not_replaced_by_an_identical_concurrent_request() {
    let mut job = running();
    let before = serde_json::to_vec(&job).unwrap();
    assert!(job
        .begin(
            "attempt-b".into(),
            origin("process-a:1"),
            "role-a".into(),
            identity("local-a", "schema-v1"),
            4
        )
        .is_err());
    assert_eq!(serde_json::to_vec(&job).unwrap(), before);
}
#[test]
fn superseded_source_is_retained_without_a_success_receipt() {
    let mut job = running();
    let source = job.source.clone();
    job.supersede("d".repeat(64), 4);
    assert_eq!(job.source, source);
    assert_eq!(job.state, WorkState::Superseded);
    assert_eq!(job.attempts[0].state, WorkState::Stopped);
    assert!(job.receipts.is_empty());
    assert!(job
        .finish(
            "attempt-a",
            checks(CheckState::Passed),
            vec![output("attempt-a")],
            5
        )
        .is_err());
}
#[test]
fn distinct_native_checks_and_current_output_are_required_for_a_receipt() {
    let mut job = running();
    assert!(job
        .finish(
            "attempt-a",
            checks(CheckState::Passed),
            vec![output("attempt-a")],
            3
        )
        .unwrap());
    assert_eq!(job.state, WorkState::Completed);
    assert_eq!(job.receipts.len(), 1);
    assert_eq!(job.receipts[0].attempt_id, "attempt-a");
    assert_eq!(job.receipts[0].outputs[0].attempt_id, "attempt-a");
    // These are pure state fixtures, not native dispatch/model semantic proof.
}
