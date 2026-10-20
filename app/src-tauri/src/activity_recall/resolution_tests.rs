use super::*;
use crate::commands::DateRange;
use crate::wiki_claims::{ActorRole, ClaimOutcome};
use serde_json::json;

fn epoch(value: &str) -> i64 {
    crate::importers::parse_iso8601(value).unwrap()
}
fn period() -> DateRange {
    DateRange {
        start: "2026-10-03".into(),
        end: "2026-10-04".into(),
        start_epoch: None,
        end_epoch: None,
    }
}
fn request(mode: ResolutionMode) -> ResolutionRequest {
    let captured = epoch("2026-10-08T12:00:00Z");
    ResolutionRequest {
        mode,
        as_of_epoch: if mode == ResolutionMode::CurrentState {
            captured
        } else {
            epoch("2026-10-05T00:00:00Z") - 1
        },
        captured_query_epoch: captured,
    }
}
fn transcript(time: Option<&str>, role: &str, text: &str) -> String {
    format!(
        "---\nturn_metadata: [{}]\n---\n\n**{role}:**\n\n{text}\n",
        json!({"timestamp":time,"original_role":role.to_ascii_lowercase(),"phase":"final"})
    )
}
fn put(root: &Path, index: &mut Bm25Index, page: &str, text: &str) {
    let path = root.join(page);
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, text).unwrap();
    index.upsert_page(page, "Synthetic task", &chunk_page(text));
}
struct Fixture {
    dir: tempfile::TempDir,
    index: Bm25Index,
    origin: AgentVaultSession,
    initial: SourceSet,
    keys: Vec<ResolutionTaskKey>,
}
fn fixture() -> Fixture {
    let dir = tempfile::tempdir().unwrap();
    let mut index = Bm25Index::new();
    let source = transcript(
        Some("2026-10-03T08:00:00Z"),
        "User",
        "Please build synthetic_export_btn for the synthetic project.",
    );
    put(dir.path(), &mut index, "sessions/request.md", &source);
    let origin = AgentVaultSession {
        vault_path: dir
            .path()
            .canonicalize()
            .unwrap()
            .to_string_lossy()
            .into_owned(),
        opening_token: "17".into(),
    };
    let initial = SourceSet::new(
        origin.clone(),
        Scope::Sessions,
        vec![super::super::bind_original_page(
            "sessions/request.md",
            &source,
            &chunk_page(&source),
            &[0],
        )
        .unwrap()],
        vec![],
    )
    .unwrap();
    let id = initial.spans().next().unwrap().id();
    let claims=initial.validate(&json!({"outcome":"claims","claims":[{"action":"A synthetic request.","anchorSpanId":id,"supportSpanIds":[id],"actor":{"role":"user","basis":"speaker","subjectSpanId":null},"eventTime":{"value":null,"basis":"unknown","precision":"unknown","uncertainty":"unknown","supportSpanId":null},"speechAct":"request","status":"requested","verificationId":null}]}).to_string(),&origin,Scope::Sessions).unwrap();
    assert_eq!(claims.outcome, ClaimOutcome::Claims);
    let (keys, omitted) = task_keys(&claims).unwrap();
    assert!(!omitted);
    Fixture {
        dir,
        index,
        origin,
        initial,
        keys,
    }
}
fn scan(f: &Fixture, mode: ResolutionMode, paths: Option<&[String]>) -> ResolutionSources {
    let window = request(mode)
        .checked_window(&period(), epoch("2026-10-08T12:00:00Z"))
        .unwrap();
    read(
        ResolutionRead {
            root: f.dir.path(),
            index: &f.index,
            origin: &f.origin,
            scope: Scope::Sessions,
            paths,
            window: &window,
            task_keys: &f.keys,
            initial: &f.initial,
            include_archived: false,
        },
        &AtomicBool::new(false),
    )
    .unwrap()
}

#[test]
fn resolution_finds_later_original_outside_initial_pages_and_global_top_k_scope_noise() {
    let mut f = fixture();
    for i in 0..60 {
        put(
            f.dir.path(),
            &mut f.index,
            &format!("wiki/noise-{i}.md"),
            "synthetic_export_btn",
        );
    }
    put(
        f.dir.path(),
        &mut f.index,
        "sessions/later.md",
        &transcript(
            Some("2026-10-05T10:00:00Z"),
            "User",
            "The synthetic_export_btn draft was rejected. Please reopen the task.",
        ),
    );
    assert!(f
        .index
        .search("synthetic_export_btn", 12)
        .iter()
        .all(|hit| hit.page.starts_with("wiki/")));
    let found = scan(&f, ResolutionMode::CurrentState, None);
    assert_eq!(found.coverage.admitted_pages, 1);
    let span = found.originals.spans().next().unwrap();
    assert_eq!(span.source_path(), "sessions/later.md");
    assert_eq!(span.speaker(), ActorRole::User);
    assert_eq!(span.turn_time(), Some("2026-10-05T10:00:00Z"));
    assert_eq!(span.source_phase(), Some("final"));
    let source = std::fs::read_to_string(f.dir.path().join(span.source_path())).unwrap();
    assert_eq!(source.get(span.start()..span.end()), Some(span.text()));
    assert_eq!(
        span.span_sha256(),
        format!("{:x}", Sha256::digest(span.text().as_bytes()))
    );
    assert_eq!(found.declarations[0].origin.opening_token, "17");
    assert_eq!(found.declarations[0].citation_page, "sessions/later.md");
}

#[test]
fn historical_as_of_excludes_later_completion_retraction_and_resumption() {
    let mut f = fixture();
    for (i, role, body) in [
        (0, "Assistant", "synthetic_export_btn was completed."),
        (1, "User", "synthetic_export_btn completion was retracted."),
        (2, "User", "Resume synthetic_export_btn."),
    ] {
        put(
            f.dir.path(),
            &mut f.index,
            &format!("sessions/later-{i}.md"),
            &transcript(Some("2026-10-05T10:00:00Z"), role, body),
        );
    }
    let historical = scan(&f, ResolutionMode::HistoricalAsOf, None);
    assert_eq!(historical.coverage.original_spans, 0);
    assert_eq!(historical.coverage.excluded_after_as_of_spans, 3);
    assert!(historical.declarations.is_empty());
    let current = scan(&f, ResolutionMode::CurrentState, None);
    assert_eq!(current.coverage.original_spans, 3);
    assert!(current
        .originals
        .spans()
        .any(|span| span.speaker() == ActorRole::Assistant));
}

#[test]
fn scope_and_explicit_paths_apply_before_the_candidate_budget() {
    let mut f = fixture();
    put(
        f.dir.path(),
        &mut f.index,
        "sessions/allowed.md",
        &transcript(
            Some("2026-10-05T10:00:00Z"),
            "User",
            "synthetic_export_btn rejected.",
        ),
    );
    put(
        f.dir.path(),
        &mut f.index,
        "sessions/excluded.md",
        &transcript(
            Some("2026-10-06T10:00:00Z"),
            "User",
            "synthetic_export_btn reopened.",
        ),
    );
    let paths = vec!["sessions/allowed.md".into()];
    let found = scan(&f, ResolutionMode::CurrentState, Some(&paths));
    assert_eq!(found.coverage.candidate_chunks, 1);
    assert_eq!(found.declarations[0].citation_page, "sessions/allowed.md");
}

#[test]
fn unknown_time_or_missing_results_never_becomes_proof_of_noncompletion() {
    let mut f = fixture();
    let empty = scan(&f, ResolutionMode::CurrentState, None);
    assert_eq!(empty.coverage.original_spans, 0);
    assert!(empty.declarations.is_empty());
    put(
        f.dir.path(),
        &mut f.index,
        "sessions/undated.md",
        &transcript(
            None,
            "User",
            "synthetic_export_btn might have been reopened.",
        ),
    );
    let unknown = scan(&f, ResolutionMode::CurrentState, None);
    assert_eq!(unknown.coverage.original_spans, 0);
    assert_eq!(unknown.coverage.undated_spans, 1);
    assert!(unknown.coverage.incomplete);
    assert!(unknown.declarations.is_empty());
}

#[test]
fn stale_index_and_changed_admitted_original_are_not_publishable() {
    let mut f = fixture();
    let page = "sessions/later.md";
    put(
        f.dir.path(),
        &mut f.index,
        page,
        &transcript(
            Some("2026-10-05T10:00:00Z"),
            "User",
            "synthetic_export_btn rejected.",
        ),
    );
    let found = scan(&f, ResolutionMode::CurrentState, None);
    std::fs::write(
        f.dir.path().join(page),
        transcript(
            Some("2026-10-05T10:00:00Z"),
            "User",
            "synthetic_export_btn actually reopened.",
        ),
    )
    .unwrap();
    assert!(recheck(
        Path::new(&f.origin.vault_path),
        &found.revisions,
        &AtomicBool::new(false),
    )
    .unwrap_err()
    .contains("changed"));
    let stale = scan(&f, ResolutionMode::CurrentState, None);
    assert!(stale.coverage.incomplete);
    assert_eq!(stale.coverage.admitted_pages, 0);
}

#[test]
fn request_snapshot_mode_and_inclusive_historical_end_are_exact() {
    let historical = request(ResolutionMode::HistoricalAsOf);
    let window = historical
        .checked_window(&period(), historical.captured_query_epoch)
        .unwrap();
    assert_eq!(window.end_epoch, epoch("2026-10-05T00:00:00Z"));
    let mut wrong = historical.clone();
    wrong.as_of_epoch += 1;
    assert!(wrong
        .checked_window(&period(), wrong.captured_query_epoch)
        .is_err());
    let mut future = request(ResolutionMode::CurrentState);
    future.captured_query_epoch += 400;
    future.as_of_epoch = future.captured_query_epoch;
    assert!(future
        .checked_window(&period(), historical.captured_query_epoch)
        .is_err());
    let mut mixed = period();
    mixed.start_epoch = Some(window.start_epoch);
    assert!(historical
        .checked_window(&mixed, historical.captured_query_epoch)
        .is_err());
}

#[test]
fn day_only_record_time_keeps_uncertainty_and_never_sets_event_time() {
    let mut f = fixture();
    put(f.dir.path(),&mut f.index,"sessions/note.md","---\ncreated: '2026-10-08'\n---\n\nsynthetic_export_btn is described in this undated note.");
    let found = scan(&f, ResolutionMode::CurrentState, None);
    assert_eq!(found.coverage.original_spans, 0);
    assert_eq!(found.coverage.undated_spans, 1);
    assert!(found.coverage.incomplete);
}

#[test]
fn invalid_opening_and_cancellation_fail_before_source_read() {
    let f = fixture();
    let window = request(ResolutionMode::CurrentState)
        .checked_window(&period(), epoch("2026-10-08T12:00:00Z"))
        .unwrap();
    let wrong = AgentVaultSession {
        vault_path: "/synthetic/wrong".into(),
        opening_token: "17".into(),
    };
    let read_request = |origin| ResolutionRead {
        root: f.dir.path(),
        index: &f.index,
        origin,
        scope: Scope::Sessions,
        paths: None,
        window: &window,
        task_keys: &f.keys,
        initial: &f.initial,
        include_archived: false,
    };
    assert!(read(read_request(&wrong), &AtomicBool::new(false))
        .err()
        .unwrap()
        .contains("origin"));
    assert_eq!(
        read(read_request(&f.origin), &AtomicBool::new(true))
            .err()
            .unwrap(),
        "cancelled"
    );
}

#[test]
fn generated_action_string_is_not_a_search_key() {
    let f = fixture();
    assert!(f.keys[0].exact_phrase.contains("synthetic_export_btn"));
    assert!(!f.keys[0].exact_phrase.contains("A synthetic request."));
    assert_eq!(
        f.keys[0].phrase_sha256,
        format!("{:x}", Sha256::digest(f.keys[0].exact_phrase.as_bytes()))
    );
}

#[test]
fn same_page_later_turn_outside_initial_sections_retains_original_sequence() {
    let mut f = fixture();
    let source="---\nturn_metadata: [{timestamp: '2026-10-03T08:00:00Z', original_role: user, phase: final}, {timestamp: '2026-10-05T10:00:00Z', original_role: assistant, phase: commentary}]\n---\n\n**User:**\n\nPlease build synthetic_export_btn for the synthetic project.\n\n**Assistant:**\n\nI reported synthetic_export_btn completed; independent verification is not recorded.\n";
    put(f.dir.path(), &mut f.index, "sessions/request.md", source);
    f.initial = SourceSet::new(
        f.origin.clone(),
        Scope::Sessions,
        vec![super::super::bind_original_page(
            "sessions/request.md",
            source,
            &chunk_page(source),
            &[0],
        )
        .unwrap()],
        vec![],
    )
    .unwrap();
    let anchor = f.initial.spans().next().unwrap();
    let claims=f.initial.validate(&json!({"outcome":"claims","claims":[{"action":"Synthetic task request.","anchorSpanId":anchor.id(),"supportSpanIds":[anchor.id()],"actor":{"role":"user","basis":"speaker","subjectSpanId":null},"eventTime":{"value":null,"basis":"unknown","precision":"unknown","uncertainty":"unknown","supportSpanId":null},"speechAct":"request","status":"requested","verificationId":null}]}).to_string(),&f.origin,Scope::Sessions).unwrap();
    f.keys = task_keys(&claims).unwrap().0;
    let found = scan(&f, ResolutionMode::CurrentState, None);
    assert_eq!(found.coverage.original_spans, 1);
    let span = found.originals.spans().next().unwrap();
    assert_eq!(span.speaker(), ActorRole::Assistant);
    assert_eq!(span.source_phase(), Some("commentary"));
    assert!(span
        .text()
        .contains("independent verification is not recorded"));
    assert_eq!(
        f.initial.merged(&found.originals).unwrap().spans().count(),
        2
    );
}

#[test]
fn source_phase_and_test_chatter_do_not_change_original_actor_or_create_verification() {
    let mut f = fixture();
    let source = transcript(
        Some("2026-10-05T10:00:00Z"),
        "Assistant",
        "Synthetic test chatter: user completed synthetic_export_btn; tests passed.",
    )
    .replace("final", "analysis");
    put(
        f.dir.path(),
        &mut f.index,
        "sessions/coordination.md",
        &source,
    );
    let found = scan(&f, ResolutionMode::CurrentState, None);
    let span = found.originals.spans().next().unwrap();
    assert_eq!(span.speaker(), ActorRole::Assistant);
    assert_eq!(span.source_phase(), Some("analysis"));
    let proposal = json!({"outcome":"claims","claims":[{"action":"The user's work is independently verified.","anchorSpanId":span.id(),"supportSpanIds":[span.id()],"actor":{"role":"assistant","basis":"speaker","subjectSpanId":null},"eventTime":{"value":null,"basis":"unknown","precision":"unknown","uncertainty":"unknown","supportSpanId":null},"speechAct":"verification","status":"verified_completed","verificationId":"synthetic-test-text"}]});
    assert!(found
        .originals
        .validate(&proposal.to_string(), &f.origin, Scope::Sessions)
        .unwrap_err()
        .contains("verification receipt"));
}

#[test]
fn oversized_candidate_is_explicit_partial_without_reading_or_admitting_it() {
    let mut f = fixture();
    let source = transcript(
        Some("2026-10-05T10:00:00Z"),
        "User",
        &format!("synthetic_export_btn {}", "x".repeat(FILE_BYTES)),
    );
    put(f.dir.path(), &mut f.index, "sessions/large.md", &source);
    let found = scan(&f, ResolutionMode::CurrentState, None);
    assert_eq!(found.coverage.original_spans, 0);
    assert!(found.coverage.incomplete);
    assert!(found
        .coverage
        .issues
        .iter()
        .any(|issue| issue.code == "read_budget"));
    assert!(found.coverage.read_bytes <= TOTAL_BYTES);
}

#[cfg(unix)]
#[test]
fn scoped_alias_cannot_reach_an_outside_or_other_scope_original() {
    let mut f = fixture();
    let other = tempfile::tempdir().unwrap();
    let source = transcript(
        Some("2026-10-05T10:00:00Z"),
        "User",
        "synthetic_export_btn rejected.",
    );
    let target = other.path().join("outside.md");
    std::fs::write(&target, &source).unwrap();
    let alias = "sessions/alias.md";
    std::os::unix::fs::symlink(&target, f.dir.path().join(alias)).unwrap();
    f.index
        .upsert_page(alias, "Synthetic alias", &chunk_page(&source));
    let window = request(ResolutionMode::CurrentState)
        .checked_window(&period(), epoch("2026-10-08T12:00:00Z"))
        .unwrap();
    let failure = read(
        ResolutionRead {
            root: f.dir.path(),
            index: &f.index,
            origin: &f.origin,
            scope: Scope::Sessions,
            paths: None,
            window: &window,
            task_keys: &f.keys,
            initial: &f.initial,
            include_archived: false,
        },
        &AtomicBool::new(false),
    )
    .err()
    .unwrap();
    assert!(failure.contains("outside") || failure.contains("escape") || failure.contains("vault"));
}

#[test]
fn altered_generated_phrase_cannot_borrow_the_original_anchor_metadata() {
    let mut f = fixture();
    f.keys[0].exact_phrase = "injected model action".into();
    let window = request(ResolutionMode::CurrentState)
        .checked_window(&period(), epoch("2026-10-08T12:00:00Z"))
        .unwrap();
    let failure = read(
        ResolutionRead {
            root: f.dir.path(),
            index: &f.index,
            origin: &f.origin,
            scope: Scope::Sessions,
            paths: None,
            window: &window,
            task_keys: &f.keys,
            initial: &f.initial,
            include_archived: false,
        },
        &AtomicBool::new(false),
    )
    .err()
    .unwrap();
    assert!(failure.contains("frozen initial original"));
}

#[test]
fn answer_lineage_contains_only_later_original_windows_even_on_an_initial_page() {
    let mut f = fixture();
    let source = "---\nturn_metadata: [{timestamp: '2026-10-03T08:00:00Z', original_role: user}, {timestamp: '2026-10-05T10:00:00Z', original_role: assistant}]\n---\n\n**User:**\n\nPlease build synthetic_export_btn for the synthetic project.\n\n**Assistant:**\n\nI reported synthetic_export_btn completed; the user has not verified it.\n";
    put(f.dir.path(), &mut f.index, "sessions/request.md", source);
    f.initial = SourceSet::new(
        f.origin.clone(),
        Scope::Sessions,
        vec![super::super::bind_original_page(
            "sessions/request.md",
            source,
            &chunk_page(source),
            &[0],
        )
        .unwrap()],
        vec![],
    )
    .unwrap();
    let anchor = f.initial.spans().next().unwrap();
    let claims = f.initial.validate(&json!({"outcome":"claims","claims":[{"action":"Synthetic request.","anchorSpanId":anchor.id(),"supportSpanIds":[anchor.id()],"actor":{"role":"user","basis":"speaker","subjectSpanId":null},"eventTime":{"value":null,"basis":"unknown","precision":"unknown","uncertainty":"unknown","supportSpanId":null},"speechAct":"request","status":"requested","verificationId":null}]}).to_string(), &f.origin, Scope::Sessions).unwrap();
    f.keys = task_keys(&claims).unwrap().0;
    let found = scan(&f, ResolutionMode::CurrentState, None);
    assert_eq!(found.coverage.original_spans, 1);
    let windowed = found
        .originals
        .windowed(|span| {
            let middle = span.text().char_indices().nth(20).unwrap().0;
            Ok(vec![
                span.text()[..middle].into(),
                span.text()[middle..].into(),
            ])
        })
        .unwrap();
    let combined = f.initial.merged(&windowed).unwrap();
    let selected = combined.spans().cloned().collect::<Vec<_>>();
    let declarations = answer_declarations(
        &found.declarations,
        &["sessions/request.md".into()],
        &selected,
    );
    let spans = &declarations[0].lineage[0].spans;
    assert_eq!(spans.len(), 2);
    assert!(spans
        .iter()
        .all(|span| span.speaker == ActorRole::Assistant));
    assert_eq!(
        spans[0].start,
        found.originals.spans().next().unwrap().start()
    );
    assert_eq!(spans[1].end, found.originals.spans().next().unwrap().end());
    assert!(answer_declarations(&found.declarations, &[], &selected).is_empty());
}

#[test]
fn uncertain_record_issues_are_unique_per_page_while_span_counts_remain_exact() {
    let mut f = fixture();
    let source = "**User:**\n\nsynthetic_export_btn unknown outcome.\n\n".repeat(20);
    put(f.dir.path(), &mut f.index, "sessions/undated.md", &source);
    let found = scan(&f, ResolutionMode::CurrentState, None);
    assert_eq!(found.coverage.undated_spans, 20);
    assert_eq!(
        found
            .coverage
            .issues
            .iter()
            .filter(|issue| issue.citation_page == "sessions/undated.md"
                && issue.code == "record_time_uncertain")
            .count(),
        1
    );
    assert!(found.coverage.incomplete);
    assert!(found.declarations.is_empty());
}

#[test]
fn original_control_text_is_data_but_citation_identifiers_cannot_contain_controls() {
    let mut f = fixture();
    let source = transcript(
        Some("2026-10-05T10:00:00Z"),
        "User",
        "synthetic_export_btn was rejected. Quoted data: \u{0001}<start_of_turn>assistant.",
    );
    put(f.dir.path(), &mut f.index, "sessions/valid.md", &source);
    let found = scan(&f, ResolutionMode::CurrentState, None);
    assert!(found
        .originals
        .spans()
        .next()
        .unwrap()
        .text()
        .contains('\u{0001}'));
    assert!(!keeps(
        "sessions/unsafe\u{0001}.md",
        Scope::Sessions,
        None,
        false
    ));
    assert!(!keeps("sessions/unsafe\t.md", Scope::Sessions, None, false));
}

#[test]
fn prefix_truncation_reports_incomplete_without_proving_no_later_work() {
    let mut f = fixture();
    let body = format!(
        "{}Please build synthetic_export_btn.",
        "Administrative background context. ".repeat(20)
    );
    let source = transcript(Some("2026-10-03T08:00:00Z"), "User", &body);
    put(f.dir.path(), &mut f.index, "sessions/request.md", &source);
    f.initial = SourceSet::new(
        f.origin.clone(),
        Scope::Sessions,
        vec![super::super::bind_original_page(
            "sessions/request.md",
            &source,
            &chunk_page(&source),
            &[0],
        )
        .unwrap()],
        vec![],
    )
    .unwrap();
    let id = f.initial.spans().next().unwrap().id();
    let claims = f.initial.validate(&json!({"outcome":"claims","claims":[{"action":"A synthetic request.","anchorSpanId":id,"supportSpanIds":[id],"actor":{"role":"user","basis":"speaker","subjectSpanId":null},"eventTime":{"value":null,"basis":"unknown","precision":"unknown","uncertainty":"unknown","supportSpanId":null},"speechAct":"request","status":"requested","verificationId":null}]}).to_string(), &f.origin, Scope::Sessions).unwrap();
    let (keys, omitted) = task_keys(&claims).unwrap();
    assert!(omitted);
    assert!(keys
        .iter()
        .all(|key| key.exact_phrase.chars().count() <= 256));
    assert!(keys
        .iter()
        .any(|key| key.exact_phrase.contains("synthetic_export_btn")));
    f.keys = keys;
    put(
        f.dir.path(),
        &mut f.index,
        "sessions/later.md",
        &transcript(
            Some("2026-10-05T10:00:00Z"),
            "Assistant",
            "synthetic_export_btn completion was retracted.",
        ),
    );
    let found = scan(&f, ResolutionMode::CurrentState, None);
    assert!(found.coverage.incomplete);
    // Native source windows now admit the tail; omission is still explicit and
    // lexical admission does not establish a semantically accepted task state.
    assert_eq!(found.coverage.original_spans, 1);
    assert_exact_later_span(&f, &found, "sessions/later.md", "completion was retracted");
}

fn replace_initial_request(f: &mut Fixture, body: &str) {
    let source = transcript(Some("2026-10-03T08:00:00Z"), "User", body);
    put(f.dir.path(), &mut f.index, "sessions/request.md", &source);
    f.initial = SourceSet::new(
        f.origin.clone(),
        Scope::Sessions,
        vec![super::super::bind_original_page(
            "sessions/request.md",
            &source,
            &chunk_page(&source),
            &[0],
        )
        .unwrap()],
        vec![],
    )
    .unwrap();
    let anchor = f.initial.spans().next().unwrap();
    let claims = f.initial.validate(
        &json!({"outcome":"claims","claims":[{"action":"An invented action must not supply its search words.","anchorSpanId":anchor.id(),"supportSpanIds":[anchor.id()],"actor":{"role":"user","basis":"speaker","subjectSpanId":null},"eventTime":{"value":null,"basis":"unknown","precision":"unknown","uncertainty":"unknown","supportSpanId":null},"speechAct":"request","status":"requested","verificationId":null}]}).to_string(),
        &f.origin, Scope::Sessions,
    ).unwrap();
    let (keys, omitted) = task_keys(&claims).unwrap();
    assert!(omitted);
    f.keys = keys;
}

fn assert_exact_later_span(f: &Fixture, found: &ResolutionSources, page: &str, phrase: &str) {
    let span = found
        .originals
        .spans()
        .find(|span| span.source_path() == page && span.text().contains(phrase))
        .expect("the later original task outcome must be admitted");
    let source = std::fs::read_to_string(f.dir.path().join(page)).unwrap();
    assert_eq!(source.get(span.start()..span.end()), Some(span.text()));
    assert_eq!(
        span.source_revision(),
        format!("{:x}", Sha256::digest(source.as_bytes()))
    );
    assert_eq!(
        span.span_sha256(),
        format!("{:x}", Sha256::digest(span.text().as_bytes()))
    );
    assert_eq!(span.speaker(), ActorRole::Assistant);
    assert_eq!(span.turn_time(), Some("2026-10-05T10:00:00Z"));
    assert_eq!(span.source_phase(), Some("final"));
    assert!(found.declarations.iter().any(|declaration| {
        declaration.citation_page == page
            && declaration.origin.vault_path == f.origin.vault_path
            && declaration.origin.opening_token == f.origin.opening_token
            && declaration.lineage.iter().any(|lineage| {
                lineage.source_revision == span.source_revision()
                    && lineage.spans.iter().any(|declared| {
                        declared.start == span.start()
                            && declared.end == span.end()
                            && declared.sha256 == span.span_sha256()
                    })
            })
    }));
    recheck(
        Path::new(&f.origin.vault_path),
        &found.revisions,
        &AtomicBool::new(false),
    )
    .unwrap();
}

#[test]
fn resolution_native_keys_find_task_after_256_chars_and_keep_retraction_lineage() {
    let mut f = fixture();
    let body = format!(
        "{}Please build spectral_widget_revision.",
        "Administrative context. ".repeat(30)
    );
    replace_initial_request(&mut f, &body);
    assert!(f
        .keys
        .iter()
        .any(|key| key.exact_phrase.contains("spectral_widget_revision")));
    assert!(f.keys.iter().all(|key| {
        let original = &key.original;
        key.exact_phrase.chars().count() <= 256
            && original
                .text()
                .get(key.phrase_start - original.start()..key.phrase_end - original.start())
                == Some(key.exact_phrase.as_str())
            && !key.exact_phrase.contains("invented action")
    }));
    let page = "sessions/tail-outcome.md";
    put(
        f.dir.path(),
        &mut f.index,
        page,
        &transcript(
            Some("2026-10-05T10:00:00Z"),
            "Assistant",
            "spectral_widget_revision was rejected; the earlier completion report is retracted.",
        ),
    );
    let found = scan(&f, ResolutionMode::CurrentState, None);
    assert_eq!(found.coverage.admitted_pages, 1);
    assert_exact_later_span(&f, &found, page, "completion report is retracted");
    assert!(found.coverage.incomplete);
}

#[test]
fn resolution_native_keys_find_middle_task_in_multikilobyte_boilerplate() {
    let mut f = fixture();
    let body = format!(
        "{}Please build 출처_검증_내보내기. {}",
        "Administrative context. ".repeat(150),
        "Archival background. ".repeat(150)
    );
    assert!(body.chars().count() > 6000);
    replace_initial_request(&mut f, &body);
    assert!(f
        .keys
        .iter()
        .any(|key| key.exact_phrase.contains("출처_검증_내보내기")));
    let page = "sessions/middle-outcome.md";
    put(
        f.dir.path(),
        &mut f.index,
        page,
        &transcript(
            Some("2026-10-05T10:00:00Z"),
            "Assistant",
            "출처_검증_내보내기 was rolled back; its completion report no longer applies.",
        ),
    );
    let found = scan(&f, ResolutionMode::CurrentState, None);
    assert_eq!(found.coverage.admitted_pages, 1);
    assert_exact_later_span(&f, &found, page, "was rolled back");
    assert!(found.coverage.incomplete);
}

#[test]
fn resolution_reads_page_tail_after_more_than_first_candidate_budget_chunks() {
    let mut f = fixture();
    let page = "sessions/long-outcome.md";
    let mut turns = Vec::new();
    let mut body = String::new();
    for _ in 0..80 {
        turns.push(json!({"timestamp":"2026-10-05T10:00:00Z","original_role":"assistant","phase":"commentary"}));
        body.push_str("**Assistant:**\n\nPlease build synthetic_export_btn for the synthetic project; this is repeated planning chatter.\n\n");
    }
    turns.push(
        json!({"timestamp":"2026-10-05T10:00:00Z","original_role":"assistant","phase":"final"}),
    );
    body.push_str("**Assistant:**\n\nsynthetic_export_btn was rejected and its earlier completion report is retracted.\n");
    let source = format!(
        "---\nturn_metadata: {}\n---\n\n{body}",
        serde_json::to_string(&turns).unwrap()
    );
    put(f.dir.path(), &mut f.index, page, &source);
    let last_section = chunk_page(&source).len() - 1;
    let first = f.index.search_where(
        &f.keys[0].exact_phrase,
        MAX_CANDIDATES + 1,
        |candidate, _| candidate == page,
    );
    assert_eq!(first.len(), MAX_CANDIDATES + 1);
    assert!(first.iter().all(|hit| hit.section < last_section));
    let found = scan(&f, ResolutionMode::CurrentState, None);
    assert_exact_later_span(&f, &found, page, "completion report is retracted");
    assert_eq!(found.coverage.admitted_pages, 1);
    assert!(found.coverage.incomplete);
    assert!(found.coverage.candidate_chunks <= MAX_CANDIDATES);
    assert!(found.coverage.original_spans <= MAX_SPANS);
    assert!(found.coverage.read_bytes <= TOTAL_BYTES);
}
