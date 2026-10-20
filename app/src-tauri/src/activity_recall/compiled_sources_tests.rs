use super::*;
use crate::importers::{Conversation, Role, Source, Turn, TurnMetadata};
use crate::vault_session::AgentVaultSession;
use crate::wiki_claims::{ActorRole, SourceSet};
use serde_json::json;
use std::path::PathBuf;

pub(crate) struct Fixture {
    _directory: tempfile::TempDir,
    pub(crate) root: PathBuf,
    pub(crate) page: String,
    pub(crate) raw_path: String,
    pub(crate) original: String,
    pub(crate) summary: String,
}

pub(crate) fn fixture() -> Fixture {
    fixture_with_texts([
        "Please build synthetic_export_widget.",
        "I reported synthetic_export_widget complete; it was not independently verified.",
        "The synthetic_export_widget failed. Withdraw the earlier completion and keep the repair pending.",
    ])
}

fn fixture_with_texts(texts: [&str; 3]) -> Fixture {
    fixture_with_times(
        texts,
        [
            Some("2026-10-03T08:00:00Z"),
            Some("2026-10-03T09:00:00Z"),
            Some("2026-10-03T10:00:00Z"),
        ],
    )
}

fn fixture_with_times(texts: [&str; 3], times: [Option<&str>; 3]) -> Fixture {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().canonicalize().unwrap();
    let key = "codex:synthetic-compiled-reader";
    let conversation = Conversation {
        id: "synthetic-compiled-reader".into(),
        source: Source::Codex,
        title: "Synthetic imported transcript".into(),
        created: None,
        turns: [
            (Role::User, texts[0], times[0]),
            (Role::Assistant, texts[1], times[1]),
            (Role::User, texts[2], times[2]),
        ]
        .into_iter()
        .enumerate()
        .map(|(ordinal, (role, text, timestamp))| Turn {
            role,
            text: text.into(),
            metadata: TurnMetadata {
                message_id: Some(format!("synthetic-turn-{ordinal}")),
                timestamp: timestamp.map(str::to_owned),
                phase: Some("final".into()),
                ..TurnMetadata::default()
            },
        })
        .collect(),
    };
    let original = conversation.to_inbox_doc();
    let fingerprint = crate::importers::ledger::fingerprint(&original);
    let revision = crate::importers::wikify::source_revision(&original);
    let raw_path = format!(
        "raw/conversations/codex/{}-{fingerprint}.md",
        conversation.doc_stem()
    );
    let projection_path = "sessions/2026-10/codex-synthetic-compiled-reader.md";
    let transcript_start = original.find("**User:**").unwrap();
    let projection = format!(
        "{}<!-- myco:import-transcript:v1 {} -->\n{}<!-- /myco:import-transcript -->\n\nHuman annotation retained.\n",
        original[..transcript_start].replacen("\n---\n", &format!("\nraw_path: {raw_path}\nsource_revision: {revision}\n---\n"), 1),
        json!({"key":key,"raw_path":raw_path,"original_path":null,"source_revision":revision,
            "transcript_sha256":crate::importers::wikify::source_revision(&original[transcript_start..])}),
        &original[transcript_start..],
    );
    for (path, content) in [
        (raw_path.as_str(), original.as_str()),
        (projection_path, projection.as_str()),
    ] {
        std::fs::create_dir_all(root.join(path).parent().unwrap()).unwrap();
        std::fs::write(root.join(path), content).unwrap();
    }
    let mut ledger = crate::importers::ledger::Ledger::default();
    ledger.record(key.into(), fingerprint);
    ledger.record_location("sessions", key, projection_path.into());
    ledger.save(&root).unwrap();

    let page = format!(
        "wiki/source-session-codex-{}.md",
        &crate::importers::wikify::source_revision(key)[..16]
    );
    let original_chunks = chunk_page(&original);
    let document = bind_original_page(
        &raw_path,
        &original,
        &original_chunks,
        &(0..original_chunks.len()).collect::<Vec<_>>(),
    )
    .unwrap();
    let origin = AgentVaultSession {
        vault_path: root.to_string_lossy().into_owned(),
        opening_token: "synthetic-opening".into(),
    };
    let sources = SourceSet::new(origin, Scope::All, vec![document], vec![]).unwrap();
    let mut body = String::from("## Synthetic compiled title\n\n");
    for span in sources.spans() {
        let mut coordinate = serde_json::to_value(span).unwrap();
        coordinate.as_object_mut().unwrap().remove("text");
        body.push_str(&format!("- Generated claim: independently verified completed work. [^mx-{}]\n  <!-- myco:claim-metadata {} -->\n", span.id(),
            json!({"actor":{"role":"user"},"eventTime":{"value":"2026-10-07"},"speechAct":"completed","status":"verified_completed","sourceSpans":[coordinate],"independentVerification":true})));
    }
    body.push('\n');
    for span in sources.spans() {
        body.push_str(&format!("[^mx-{}]: {raw_path}\n", span.id()));
    }
    let marker = json!({"sessionKey":key,"sourceRevision":revision,"compileSignature":"c".repeat(64),"artifactRevision":"d".repeat(64),"nonce":"e".repeat(32)});
    let summary = format!("---\ntype: source-summary\nsession_key: {key}\nraw_path: {raw_path}\nsession_revision: {revision}\n---\n# Synthetic displayed title\n\n<!-- myco:session-compilation:v1 {marker} -->\n{body}<!-- /myco:session-compilation -->\n");
    std::fs::create_dir_all(root.join("wiki")).unwrap();
    std::fs::write(root.join(&page), &summary).unwrap();
    Fixture {
        _directory: directory,
        root,
        page,
        raw_path,
        original,
        summary,
    }
}

fn bind(fixture: &Fixture, content: &str) -> Result<ActivitySourceInputs, String> {
    let chunks = chunk_page(content);
    original_activity_inputs(
        &fixture.root,
        &fixture.page,
        content,
        &chunks,
        &(0..chunks.len()).collect::<Vec<_>>(),
        &mut 0,
        false,
    )
}

#[test]
fn compiled_reader_binds_only_original_roles_and_bytes_instead_of_generated_completion() {
    let fixture = fixture();
    let bound = bind(&fixture, &fixture.summary).unwrap();
    let origin = AgentVaultSession {
        vault_path: fixture.root.to_string_lossy().into_owned(),
        opening_token: "synthetic-opening".into(),
    };
    let sources = SourceSet::new(origin, Scope::Wiki, bound.documents, vec![]).unwrap();
    let spans: Vec<_> = sources.spans().collect();
    assert_eq!(spans.len(), 3);
    assert!(spans.iter().all(
        |span| span.source_path() == fixture.raw_path && span.selection_path() == fixture.page
    ));
    assert!(spans
        .iter()
        .all(|span| fixture.original.contains(span.text())
            && !span.text().contains("Generated claim:")));
    assert_eq!(
        spans.iter().map(|span| span.speaker()).collect::<Vec<_>>(),
        [ActorRole::User, ActorRole::Assistant, ActorRole::User]
    );
    assert!(spans[2].text().contains("Withdraw the earlier completion"));
    assert_eq!(spans[2].turn_time(), Some("2026-10-03T10:00:00Z"));
    assert_eq!(spans[2].source_phase(), Some("final"));
}

#[test]
fn compiled_reader_rejects_matching_hash_with_forged_original_actor() {
    let fixture = fixture();
    let forged = fixture
        .summary
        .replace("\"speaker\":\"assistant\"", "\"speaker\":\"user\"");
    assert_ne!(forged, fixture.summary);
    assert!(bind(&fixture, &forged).is_err());
}

#[test]
fn compiled_reader_rejects_nonquote_original_mutation() {
    let fixture = fixture();
    std::fs::write(
        fixture.root.join(&fixture.raw_path),
        format!("{}\nUnselected synthetic mutation.\n", fixture.original),
    )
    .unwrap();
    assert!(bind(&fixture, &fixture.summary).is_err());
}

#[test]
fn compiled_reader_never_falls_back_after_a_malformed_reserved_marker() {
    let fixture = fixture();
    let malformed = fixture.summary.replace(
        "<!-- myco:session-compilation:v1 ",
        "<!-- myco:session-compilation:v1 malformed ",
    );
    assert!(bind(&fixture, &malformed).is_err());
}

#[test]
fn compiled_reader_recall_uses_original_turn_dates_without_generated_summary_dates() {
    let fixture = fixture();
    let mut index = Bm25Index::new();
    index.upsert_page(
        &fixture.page,
        "Synthetic displayed title",
        &chunk_page(&fixture.summary),
    );
    let range = DateRange {
        start: "2026-10-03".into(),
        end: "2026-10-03".into(),
        start_epoch: None,
        end_epoch: None,
    };
    let result = recall(&fixture.root, &index, &range, Scope::Wiki, None, false).unwrap();
    assert!(!result.hits.is_empty());
    assert!(result.hits.iter().all(|hit| hit.page == fixture.page));
}

fn unavailable(result: Result<ActivitySourceInputs, String>) {
    match result {
        Err(error) => assert!(
            error.starts_with("compiled_source_lineage_unavailable:"),
            "{error}"
        ),
        Ok(_) => panic!("invalid compiled lineage was accepted"),
    }
}

fn altered_span(fixture: &Fixture, update: impl FnOnce(&mut serde_json::Value)) -> String {
    let prefix = "<!-- myco:claim-metadata ";
    let start = fixture.summary.find(prefix).unwrap() + prefix.len();
    let end = start + fixture.summary[start..].find(" -->").unwrap();
    let mut claim: serde_json::Value = serde_json::from_str(&fixture.summary[start..end]).unwrap();
    update(&mut claim["sourceSpans"][0]);
    format!(
        "{}{}{}",
        &fixture.summary[..start],
        claim,
        &fixture.summary[end..]
    )
}

#[test]
fn compiled_reader_rejects_forged_time_phase_turn_and_quote_sha() {
    let fixture = fixture();
    for (field, value) in [
        ("turnTime", json!("2026-10-07T08:00:00Z")),
        ("recordTime", json!("2026-10-07")),
        ("sourcePhase", json!("analysis")),
        ("turnId", json!("T-other-original")),
        ("sha256", json!("a".repeat(64))),
    ] {
        let altered = altered_span(&fixture, |span| span[field] = value);
        unavailable(bind(&fixture, &altered));
    }
}

#[test]
fn compiled_reader_rejects_utf8_midpoint_header_and_mixed_source() {
    let fixture = fixture_with_texts(["한글 요청", "한글 보고", "한글 철회"]);
    let midpoint = fixture.original.find("한글 요청").unwrap() + 1;
    for altered in [
        altered_span(&fixture, |span| span["start"] = json!(midpoint)),
        altered_span(&fixture, |span| span["start"] = json!(0)),
        altered_span(&fixture, |span| {
            span["sourcePath"] = json!("raw/archive/other.md")
        }),
        altered_span(&fixture, |span| {
            span["selectionPath"] = json!("wiki/other.md")
        }),
        altered_span(&fixture, |span| {
            span["sourceRevision"] = json!("a".repeat(64))
        }),
    ] {
        unavailable(bind(&fixture, &altered));
    }
}

#[test]
fn compiled_reader_keeps_repeated_originals_and_nfd_late_retraction() {
    let late = "한글 철회: earlier completion withdrawn; repair pending.";
    let fixture = fixture_with_texts([
        "Repeated original statement.",
        "Repeated original statement.",
        late,
    ]);
    let bound = bind(&fixture, &fixture.summary).unwrap();
    let sources = SourceSet::new(
        AgentVaultSession {
            vault_path: fixture.root.to_string_lossy().into_owned(),
            opening_token: "synthetic-opening".into(),
        },
        Scope::Wiki,
        bound.documents,
        vec![],
    )
    .unwrap();
    let spans: Vec<_> = sources.spans().collect();
    assert_eq!(spans.len(), 3);
    assert_eq!(spans[0].speaker(), ActorRole::User);
    assert_eq!(spans[1].speaker(), ActorRole::Assistant);
    assert!(spans[0].end() < spans[1].start());
    assert!(spans[1].end() < spans[2].start());
    assert!(spans[2].text().contains(late));
    assert_ne!(crate::norm::nfc(spans[2].text()), spans[2].text());
    assert_eq!(spans[2].turn_time(), Some("2026-10-03T10:00:00Z"));
}

#[test]
fn compiled_reader_generated_dates_do_not_select_originals_or_scaffolding() {
    let fixture = fixture();
    let bound = bind(&fixture, &fixture.summary).unwrap();
    let original_range = DateRange {
        start: "2026-10-03".into(),
        end: "2026-10-03".into(),
        start_epoch: None,
        end_epoch: None,
    };
    let generated_range = DateRange {
        start: "2026-10-07".into(),
        end: "2026-10-07".into(),
        start_epoch: None,
        end_epoch: None,
    };
    let sections = bound.sections.as_ref().unwrap();
    assert!(sections.iter().any(|selected| *selected));
    for (section, selected) in sections.iter().enumerate() {
        assert_eq!(
            original_section_in_range(bound.section_times.as_deref(), section, &original_range),
            Some(*selected)
        );
        assert_eq!(
            original_section_in_range(bound.section_times.as_deref(), section, &generated_range),
            Some(false)
        );
    }
    let mut index = Bm25Index::new();
    index.upsert_page(
        &fixture.page,
        "Synthetic title",
        &chunk_page(&fixture.summary),
    );
    assert!(recall(
        &fixture.root,
        &index,
        &generated_range,
        Scope::Wiki,
        None,
        false
    )
    .unwrap()
    .hits
    .is_empty());
}

#[test]
fn compiled_reader_does_not_read_backing_sources_for_only_scaffolding_selection() {
    let fixture = fixture();
    let chunks = chunk_page(&fixture.summary);
    let mut bytes = 0;
    let bound = original_activity_inputs(
        &fixture.root,
        &fixture.page,
        &fixture.summary,
        &chunks,
        &[0],
        &mut bytes,
        false,
    )
    .unwrap();
    assert!(bound.documents.is_empty());
    assert!(!bound.sections.unwrap()[0]);
    assert_eq!(bytes, 0);
}

#[test]
fn compiled_reader_read_budget_charges_raw_once_and_exact_lineage_bytes() {
    let fixture = fixture();
    let chunks = chunk_page(&fixture.summary);
    let mut bytes = 0;
    let bound = original_activity_inputs(
        &fixture.root,
        &fixture.page,
        &fixture.summary,
        &chunks,
        &(0..chunks.len()).collect::<Vec<_>>(),
        &mut bytes,
        false,
    )
    .unwrap();
    assert_eq!(bound.documents.len(), 1);
    assert_eq!(bound.guard_revisions.len(), 2);
    let lineage_bytes: usize = bound
        .guard_revisions
        .keys()
        .map(|path| std::fs::read(fixture.root.join(path)).unwrap().len())
        .sum();
    assert_eq!(bytes, fixture.original.len() + lineage_bytes);
    let mut bytes = 0;
    let limited = original_activity_inputs_with_limits(
        &fixture.root,
        &fixture.page,
        &fixture.summary,
        &chunks,
        &(0..chunks.len()).collect::<Vec<_>>(),
        &mut bytes,
        false,
        Limits {
            total_bytes: fixture.original.len(),
            ..Limits::default()
        },
    );
    unavailable(limited);
    assert_eq!(bytes, 0);
}

#[test]
fn compiled_reader_current_ledger_and_projection_are_required_and_guarded() {
    let fixture = fixture();
    let bound = bind(&fixture, &fixture.summary).unwrap();
    let cancelled = std::sync::atomic::AtomicBool::new(false);
    recheck_resolution(&fixture.root, &bound.guard_revisions, &cancelled).unwrap();
    let projection = bound
        .guard_revisions
        .keys()
        .find(|path| path.starts_with("sessions/"))
        .unwrap();
    let original = std::fs::read_to_string(fixture.root.join(projection)).unwrap();
    std::fs::write(
        fixture.root.join(projection),
        format!("{original}\nFurther human annotation retained.\n"),
    )
    .unwrap();
    assert!(recheck_resolution(&fixture.root, &bound.guard_revisions, &cancelled).is_err());
    assert!(bind(&fixture, &fixture.summary).is_ok());
    std::fs::write(
        fixture.root.join(projection),
        original.replace(
            "Please build synthetic_export_widget",
            "Edited owned transcript",
        ),
    )
    .unwrap();
    unavailable(bind(&fixture, &fixture.summary));
}

#[test]
fn compiled_reader_corrupt_missing_or_stale_ledger_has_no_summary_fallback() {
    for ledger in [
        "{bad-json",
        "[]",
        "{}",
        "{\"codex:synthetic-compiled-reader\":\"wrong-current-revision\"}",
    ] {
        let fixture = fixture();
        std::fs::write(fixture.root.join(".myco/ledger.json"), ledger).unwrap();
        unavailable(bind(&fixture, &fixture.summary));
    }
    let fixture = fixture();
    std::fs::remove_file(fixture.root.join(".myco/ledger.json")).unwrap();
    unavailable(bind(&fixture, &fixture.summary));
}

#[test]
fn compiled_reader_custom_or_copied_layout_is_explicitly_unavailable() {
    let fixture = fixture();
    let copied = "wiki/custom-session-copy.md";
    std::fs::write(fixture.root.join(copied), &fixture.summary).unwrap();
    let chunks = chunk_page(&fixture.summary);
    let mut bytes = 0;
    unavailable(original_activity_inputs(
        &fixture.root,
        copied,
        &fixture.summary,
        &chunks,
        &(0..chunks.len()).collect::<Vec<_>>(),
        &mut bytes,
        false,
    ));
    assert_eq!(bytes, 0);
    let duplicate = format!("{}\n{}", fixture.summary, fixture.summary);
    unavailable(bind(&fixture, &duplicate));
    let truncated = fixture.summary.replace(
        "<!-- /myco:session-compilation -->",
        "<!-- /myco:session-compilation",
    );
    unavailable(bind(&fixture, &truncated));
}

#[cfg(unix)]
#[test]
fn compiled_reader_raw_symlink_and_hardlink_custody_fail_before_read() {
    let fixture = fixture();
    let raw = fixture.root.join(&fixture.raw_path);
    let twin = fixture.root.join("synthetic-raw-twin.md");
    std::fs::hard_link(&raw, &twin).unwrap();
    let chunks = chunk_page(&fixture.summary);
    let mut bytes = 0;
    unavailable(original_activity_inputs(
        &fixture.root,
        &fixture.page,
        &fixture.summary,
        &chunks,
        &(0..chunks.len()).collect::<Vec<_>>(),
        &mut bytes,
        false,
    ));
    assert_eq!(bytes, 0);
    assert_eq!(std::fs::read_to_string(&twin).unwrap(), fixture.original);
    std::fs::remove_file(&raw).unwrap();
    std::os::unix::fs::symlink(&twin, &raw).unwrap();
    unavailable(bind(&fixture, &fixture.summary));
    assert_eq!(std::fs::read_to_string(&twin).unwrap(), fixture.original);
}

#[test]
fn compiled_reader_cold_projection_and_disallowed_scope_are_not_admitted() {
    let fixture = fixture();
    let path = "sessions/archive/2026-10/synthetic-compiled-reader.md";
    let original_path = "sessions/2026-10/codex-synthetic-compiled-reader.md";
    std::fs::create_dir_all(fixture.root.join(path).parent().unwrap()).unwrap();
    std::fs::rename(fixture.root.join(original_path), fixture.root.join(path)).unwrap();
    let mut ledger = crate::importers::ledger::Ledger::parse_checked_snapshot(
        &std::fs::read(fixture.root.join(".myco/ledger.json")).unwrap(),
    )
    .unwrap();
    ledger.record_location("sessions", "codex:synthetic-compiled-reader", path.into());
    ledger.save(&fixture.root).unwrap();
    unavailable(bind(&fixture, &fixture.summary));
    let chunks = chunk_page(&fixture.summary);
    let mut bytes = 0;
    assert!(original_activity_inputs(
        &fixture.root,
        &fixture.page,
        &fixture.summary,
        &chunks,
        &(0..chunks.len()).collect::<Vec<_>>(),
        &mut bytes,
        true
    )
    .is_ok());
    let mut index = Bm25Index::new();
    index.upsert_page(&fixture.page, "Synthetic title", &chunks);
    let range = DateRange {
        start: "2026-10-03".into(),
        end: "2026-10-03".into(),
        start_epoch: None,
        end_epoch: None,
    };
    for (scope, paths) in [
        (Scope::Sessions, None),
        (Scope::Wiki, Some(vec!["wiki/other.md".into()])),
    ] {
        let result = recall(&fixture.root, &index, &range, scope, paths.as_deref(), true).unwrap();
        assert!(result.hits.is_empty());
        assert_eq!(result.scanned_pages, 0);
    }
}

#[test]
fn compiled_reader_unknown_original_time_stays_incomplete_despite_generated_date() {
    let fixture = fixture_with_times(
        [
            "Undated request.",
            "Undated reported completion.",
            "Undated withdrawal.",
        ],
        [None, None, None],
    );
    let bound = bind(&fixture, &fixture.summary).unwrap();
    assert!(bound.incomplete);
    assert!(bound
        .section_times
        .as_ref()
        .unwrap()
        .iter()
        .flatten()
        .all(|time| time.turn_time.is_none() && time.record_time.is_none()));
    let range = DateRange {
        start: "2026-10-07".into(),
        end: "2026-10-07".into(),
        start_epoch: None,
        end_epoch: None,
    };
    let mut index = Bm25Index::new();
    index.upsert_page(
        &fixture.page,
        "Synthetic title",
        &chunk_page(&fixture.summary),
    );
    let result = recall(&fixture.root, &index, &range, Scope::Wiki, None, false).unwrap();
    assert!(result.hits.is_empty());
    assert!(result.incomplete);
}

#[test]
fn compiled_reader_explicit_partial_keeps_sources_over_the_existing_512kib_limit() {
    let fixture = fixture();
    let large = format!("{}{}", fixture.original, "x".repeat(512 * 1024));
    std::fs::write(fixture.root.join(&fixture.raw_path), &large).unwrap();
    let chunks = chunk_page(&fixture.summary);
    let mut bytes = 0;
    unavailable(original_activity_inputs(
        &fixture.root,
        &fixture.page,
        &fixture.summary,
        &chunks,
        &(0..chunks.len()).collect::<Vec<_>>(),
        &mut bytes,
        false,
    ));
    assert_eq!(bytes, 0);
    assert_eq!(
        std::fs::read_to_string(fixture.root.join(&fixture.raw_path)).unwrap(),
        large
    );
}
