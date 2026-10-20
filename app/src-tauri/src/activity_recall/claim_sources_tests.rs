use super::*;
use crate::retrieval::Scope;
use crate::vault_session::AgentVaultSession;
use crate::wiki_claims::SourceSet;

fn set(document: SourceDocument) -> SourceSet {
    SourceSet::new(
        AgentVaultSession {
            vault_path: "/synthetic/vault".into(),
            opening_token: "1".into(),
        },
        Scope::All,
        vec![document],
        vec![],
    )
    .unwrap()
}

fn transcript(first: &str, second: &str) -> String {
    format!("---\ncreated: 2026-10-08\nturn_metadata: [{{\"message_id\":\"synthetic-user\",\"timestamp\":\"2026-10-03T08:00:00Z\"}},{{\"message_id\":\"synthetic-assistant\",\"timestamp\":\"2026-10-04T09:00:00Z\"}}]\n---\n\n**User:**\n{first}\n\n**Assistant:**\n{second}\n")
}

#[test]
fn two_turn_packet_uses_exact_source_body_offsets_and_original_times() {
    let source = transcript(
        "Please add a synthetic export button.",
        "I reported a synthetic draft; its review is unrecorded.",
    );
    let chunks = chunk_page(&source);
    let snapshot =
        set(bind_original_page("sessions/synthetic.md", &source, &chunks, &[0, 1]).unwrap());
    let spans: Vec<_> = snapshot.spans().collect();
    assert_eq!(spans.len(), 2);
    assert_eq!(spans[0].speaker(), ActorRole::User);
    assert_eq!(spans[1].speaker(), ActorRole::Assistant);
    assert_eq!(spans[0].turn_time(), Some("2026-10-03T08:00:00Z"));
    assert_eq!(spans[1].turn_time(), Some("2026-10-04T09:00:00Z"));
    for span in spans {
        let value = serde_json::to_value(span).unwrap();
        let start = value["start"].as_u64().unwrap() as usize;
        let end = value["end"].as_u64().unwrap() as usize;
        assert_eq!(source.get(start..end), Some(span.text()));
        assert_eq!(
            span.source_revision(),
            format!("{:x}", Sha256::digest(source.as_bytes()))
        );
        assert!(!span.text().contains("turn_metadata"));
    }
}

#[test]
fn repeated_identical_turn_bodies_keep_the_second_speaker_and_time() {
    let source = transcript(
        "The synthetic report is ready.",
        "The synthetic report is ready.",
    );
    let chunks = chunk_page(&source);
    let snapshot =
        set(bind_original_page("sessions/synthetic.md", &source, &chunks, &[1]).unwrap());
    let span = snapshot.spans().next().unwrap();
    assert_eq!(span.speaker(), ActorRole::Assistant);
    assert_eq!(span.turn_time(), Some("2026-10-04T09:00:00Z"));
    let value = serde_json::to_value(span).unwrap();
    assert!(value["start"].as_u64().unwrap() as usize > source.find("**Assistant:**").unwrap());
}

#[test]
fn nfd_original_body_keeps_raw_byte_proof_while_index_chunks_are_nfc() {
    let source = transcript(
        "\u{1100}\u{1161} synthetic request.",
        "Synthetic result is unrecorded.",
    );
    let chunks = chunk_page(&source);
    assert!(chunks[0].contains('가'));
    let snapshot =
        set(bind_original_page("sessions/synthetic.md", &source, &chunks, &[0]).unwrap());
    assert!(snapshot
        .spans()
        .next()
        .unwrap()
        .text()
        .starts_with("\u{1100}\u{1161}"));
}

#[test]
fn message_without_timestamp_never_borrows_record_creation_date() {
    let source = "---\ncreated: 2026-10-08\nturn_metadata: [{}]\n---\n\n**User:**\nA synthetic old request with an unknown action date.\n";
    let chunks = chunk_page(source);
    let snapshot = set(bind_original_page("sessions/synthetic.md", source, &chunks, &[0]).unwrap());
    assert_eq!(snapshot.spans().next().unwrap().turn_time(), None);
    let value = serde_json::to_value(snapshot.spans().next().unwrap()).unwrap();
    assert_eq!(value["recordTime"], "2026-10-08");
}

#[test]
fn mismatched_metadata_and_changed_section_are_rejected() {
    let source = transcript("Synthetic request.", "Synthetic report.");
    let truncated = source.replace(
        ",{\"message_id\":\"synthetic-assistant\",\"timestamp\":\"2026-10-04T09:00:00Z\"}",
        "",
    );
    assert!(bind_original_page(
        "sessions/synthetic.md",
        &truncated,
        &chunk_page(&truncated),
        &[0]
    )
    .is_err());
    let mut chunks = chunk_page(&source);
    chunks[0].push_str(" injected");
    assert!(bind_original_page("sessions/synthetic.md", &source, &chunks, &[0]).is_err());
}

#[test]
fn ordinary_wiki_body_does_not_acquire_a_speaker_or_event_date() {
    let source = "---\ncreated: 2026-10-08\ntype: analysis\n---\n\n# Synthetic project\nThe old plan discussed a synthetic connector; outcome is unknown.\n";
    let snapshot =
        set(bind_original_page("wiki/synthetic.md", source, &chunk_page(source), &[0]).unwrap());
    let span = snapshot.spans().next().unwrap();
    assert_eq!(span.speaker(), ActorRole::Unknown);
    assert_eq!(span.turn_time(), None);
    assert!(!span.text().contains("created:"));
}

#[test]
fn selected_long_turn_retains_its_tail_without_reassigning_the_role() {
    let first = "Synthetic user request. ".repeat(100);
    let second = format!(
        "{}\n\nThe synthetic draft was later rejected.",
        "Synthetic assistant report. ".repeat(100)
    );
    let source = transcript(&first, &second);
    let chunks = chunk_page(&source);
    let assistant = chunks
        .iter()
        .position(|chunk| chunk.starts_with("**Assistant:**"))
        .unwrap();
    let snapshot =
        set(bind_original_page("sessions/synthetic.md", &source, &chunks, &[assistant]).unwrap());
    let span = snapshot.spans().next().unwrap();
    assert_eq!(span.speaker(), ActorRole::Assistant);
    assert!(span.text().contains("later rejected"));
}

fn curated_quote(source: &str) -> CuratedQuote {
    let start = source.find("**Assistant:**\n").unwrap() + "**Assistant:**\n".len();
    let end = source.len();
    CuratedQuote {
        id: "synthetic-quote".into(),
        event: "synthetic-event".into(),
        source: "raw/conversations/synthetic.md".into(),
        source_sha256: format!("{:x}", Sha256::digest(source.as_bytes())),
        start,
        end,
        quote_sha256: format!("{:x}", Sha256::digest(&source.as_bytes()[start..end])),
        role: "Assistant".into(),
        date: Some("2026-10-04T09:00:00Z".into()),
        purpose: crate::activity_recall::QuotePurpose::Work,
    }
}

#[test]
fn curated_binding_rejects_forged_speaker_even_when_source_and_span_hashes_match() {
    let source = transcript("Synthetic request.", "Synthetic assistant report.");
    let mut quote = curated_quote(&source);
    quote.role = "User".into();
    assert!(bind_curated_quote("wiki/synthetic.md", &source, &quote).is_err());
}

#[test]
fn curated_binding_rejects_changed_original_revision_without_reusing_unchanged_quote() {
    let source = transcript("Synthetic request.", "Synthetic assistant report.");
    let quote = curated_quote(&source);
    let changed = source.replace("2026-10-08", "2026-10-09");
    assert!(bind_curated_quote("wiki/synthetic.md", &changed, &quote).is_err());
}

#[test]
fn curated_binding_uses_original_timestamp_spelling_after_epoch_equivalence_check() {
    let source = transcript("Synthetic request.", "Synthetic assistant report.")
        .replace("2026-10-04T09:00:00Z", "2026-10-04T05:00:00-04:00");
    let quote = curated_quote(&source);
    let bound = set(bind_curated_quote("wiki/synthetic.md", &source, &quote).unwrap());
    let span = bound.spans().next().unwrap();
    assert_eq!(span.speaker(), ActorRole::Assistant);
    assert_eq!(span.turn_time(), Some("2026-10-04T05:00:00-04:00"));
}

#[test]
fn conflicting_original_role_metadata_cannot_become_a_verified_user_speaker() {
    let source = "---\nturn_metadata: [{original_role: assistant, timestamp: '2026-10-03T08:00:00Z'}]\n---\n\n**User:**\nA synthetic request.\n";
    let chunks = chunk_page(source);
    assert!(bind_original_page("sessions/synthetic.md", source, &chunks, &[0]).is_err());
}

#[test]
fn invalid_recorded_turn_timestamp_remains_a_binding_failure() {
    let source = "---\nturn_metadata: [{timestamp: 'invalid-synthetic-time'}]\n---\n\n**User:**\nA synthetic request.\n";
    let chunks = chunk_page(source);
    assert!(bind_original_page("sessions/synthetic.md", source, &chunks, &[0]).is_err());
}

#[test]
fn original_turn_phase_is_preserved_without_promoting_analysis_to_user_work() {
    let source="---\nturn_metadata: [{timestamp: '2026-10-03T08:00:00Z', original_role: assistant, phase: analysis}]\n---\n\n**Assistant:**\n\nSynthetic coordination chatter: tests passed; actual user work is unverified.\n";
    let chunks = chunk_page(source);
    let snapshot =
        set(bind_original_page("sessions/synthetic-phase.md", source, &chunks, &[0]).unwrap());
    let span = snapshot.spans().next().unwrap();
    assert_eq!(span.speaker(), ActorRole::Assistant);
    let metadata = serde_json::to_value(span).unwrap();
    assert_eq!(metadata["sourcePhase"], "analysis");
    assert_eq!(metadata["speaker"], "assistant");
}

#[test]
fn original_channel_alias_is_preserved_and_malformed_phase_is_not_discarded() {
    let source="---\nturn_metadata: [{timestamp: '2026-10-03T08:00:00Z', original_role: assistant, channel: commentary}]\n---\n\n**Assistant:**\n\nSynthetic reported draft; this does not verify user work.\n";
    let chunks = chunk_page(source);
    let snapshot =
        set(bind_original_page("sessions/synthetic-channel.md", source, &chunks, &[0]).unwrap());
    assert_eq!(
        snapshot.spans().next().unwrap().source_phase(),
        Some("commentary")
    );
    for invalid in ["phase: 7", "phase: ''", r#"phase: "bad\nphase""#] {
        let broken = source.replace("channel: commentary", invalid);
        assert!(bind_original_page(
            "sessions/synthetic-channel.md",
            &broken,
            &chunk_page(&broken),
            &[0]
        )
        .unwrap_err()
        .contains("phase"));
    }
}

#[test]
fn curated_raw_quote_keeps_the_original_phase_not_a_generated_summary_phase() {
    let original="---\nturn_metadata: [{timestamp: '2026-10-03T08:00:00Z', original_role: assistant, phase: analysis}]\n---\n\n**Assistant:**\n\nSynthetic analysis and coordination; completion is unverified.\n";
    let start = original.find("Synthetic analysis").unwrap();
    let end = original.len();
    let quote = CuratedQuote {
        id: "synthetic-phase".into(),
        event: "synthetic-event".into(),
        source: "sessions/synthetic-raw.md".into(),
        source_sha256: format!("{:x}", Sha256::digest(original.as_bytes())),
        start,
        end,
        quote_sha256: format!("{:x}", Sha256::digest(&original.as_bytes()[start..end])),
        role: "Assistant".into(),
        date: Some("2026-10-03T08:00:00Z".into()),
        purpose: super::super::QuotePurpose::Work,
    };
    let snapshot = set(bind_curated_quote("wiki/synthetic-summary.md", original, &quote).unwrap());
    assert_eq!(
        snapshot.spans().next().unwrap().source_phase(),
        Some("analysis")
    );
    assert_eq!(
        snapshot.spans().next().unwrap().source_path(),
        "sessions/synthetic-raw.md"
    );
}

#[test]
fn codex_provider_prefix_reaches_selected_extraction_and_full_answer_review_once() {
    use std::cell::{Cell, RefCell};
    let raw = crate::importers::codex::provenance_test_rollout();
    let plan = crate::importers::plan_import(
        "synthetic.jsonl",
        &raw,
        &crate::importers::ledger::Ledger::default(),
    )
    .unwrap();
    let source = &plan.docs[0].body;
    let page = "sessions/synthetic-provenance.md";
    let chunks = chunk_page(source);
    let selected = chunks
        .iter()
        .position(|chunk| chunk.starts_with("**Assistant:**"))
        .unwrap();
    let packet = set(bind_original_page(page, source, &chunks, &[selected]).unwrap());
    let first_header = original_turns(source).unwrap()[0].header_start;
    let body_start = frontmatter_header(source).unwrap().len();
    let expected_prefix = &source[body_start..first_header];
    let rows: Vec<_> = packet
        .spans()
        .map(|span| serde_json::to_value(span).unwrap())
        .collect();
    assert_eq!(rows.len(), 2);
    let repeated_selection =
        set(bind_original_page(page, source, &chunks, &[selected, selected]).unwrap());
    assert_eq!(
        repeated_selection
            .spans()
            .map(|span| serde_json::to_value(span).unwrap())
            .collect::<Vec<_>>(),
        rows
    );
    assert_eq!(rows[0]["turnId"], "T-preamble");
    assert_eq!(rows[0]["speaker"], "unknown");
    assert_eq!(rows[0]["text"], expected_prefix);
    assert_eq!(rows[0]["start"], body_start);
    assert_eq!(rows[0]["end"], first_header);
    assert_eq!(rows[1]["speaker"], "assistant");
    assert_eq!(rows[1]["sourcePhase"], "commentary");
    assert!(rows[1]["text"]
        .as_str()
        .unwrap()
        .ends_with("no execution is established. 가🙂\n\n"));
    for span in packet.spans() {
        assert_eq!(source.get(span.start()..span.end()), Some(span.text()));
        assert_eq!(
            span.span_sha256(),
            format!("{:x}", Sha256::digest(span.text().as_bytes()))
        );
    }
    let origin = AgentVaultSession {
        vault_path: "/synthetic/vault".into(),
        opening_token: "1".into(),
    };
    let range = crate::commands::DateRange {
        start: "2026-10-01".into(),
        end: "2026-10-04".into(),
        start_epoch: None,
        end_epoch: None,
    };
    let context = crate::wiki_claim_review::tests::context(
        "Synthetic work",
        "en",
        Scope::All,
        &range,
        &origin,
    );
    let counted = RefCell::new(None::<String>);
    let extraction_generations = Cell::new(0);
    let extraction = crate::local_synthesis::claim_prompt::extract(
        "Synthetic work",
        "en",
        &range,
        &packet,
        &origin,
        Scope::All,
        768,
        |_, user| {
            *counted.borrow_mut() = Some(user.to_string());
            Ok(1000)
        },
        |_, user, output, context_tokens, _| {
            extraction_generations.set(extraction_generations.get() + 1);
            assert_eq!((output, context_tokens), (768, 4096));
            assert_eq!(counted.borrow().as_deref(), Some(user));
            let payload: serde_json::Value = serde_json::from_str(user).unwrap();
            assert_eq!(payload["originalSpans"].as_array().unwrap().len(), 2);
            assert_eq!(payload["originalSpans"][0]["text"], expected_prefix);
            assert!(payload["originalSpans"][1]["text"]
                .as_str()
                .unwrap()
                .contains("Later tail:"));
            Err("synthetic observation stop before claim decoding".into())
        },
        &context,
    );
    assert!(extraction.is_err());
    assert!(counted.borrow().is_some());
    assert_eq!(extraction_generations.get(), 1);

    let revision = format!("{:x}", Sha256::digest(source.as_bytes()));
    let full = set(bind_all_originals(page, page, source, &revision).unwrap());
    let evidence = crate::local_synthesis::Evidence {
        page: page.into(),
        stem: "Synthetic source".into(),
        section: 0,
        text: source.clone(),
        title: None,
        compiled: None,
    };
    let prompt =
        crate::local_synthesis::prepare("Synthetic work", None, "en", &[evidence], |_, _| Ok(true))
            .unwrap();
    let draft = crate::local_synthesis::answer_draft::validate_answer_draft(
        r#"{"answer":"The sources contain an unverified synthetic request and report; no completed deployment is established.","sources":["S1"]}"#,
        &prompt, "en").unwrap();
    let reviewed = RefCell::new(None::<String>);
    let review_generations = Cell::new(0);
    let result = crate::local_synthesis::answer_review::run(
        &context,
        &full,
        &prompt,
        &draft,
        |_, user| {
            *reviewed.borrow_mut() = Some(user.to_string());
            Ok(1000)
        },
        |_, user, output, context_tokens| {
            review_generations.set(review_generations.get() + 1);
            assert_eq!((output, context_tokens), (768, 4096));
            assert_eq!(reviewed.borrow().as_deref(), Some(user));
            let payload: serde_json::Value = serde_json::from_str(user).unwrap();
            let originals = payload["originalSpans"].as_array().unwrap();
            assert_eq!(originals.len(), 4);
            assert_eq!(
                originals
                    .iter()
                    .filter(|span| span["turnId"] == "T-preamble")
                    .count(),
                1
            );
            assert_eq!(originals[0]["text"], expected_prefix);
            assert_eq!(originals[0]["speaker"], "unknown");
            assert!(originals[3]["text"]
                .as_str()
                .unwrap()
                .contains("quoted JSON"));
            assert_eq!(
                originals
                    .iter()
                    .map(|span| span.as_object().unwrap().len())
                    .sum::<usize>(),
                56
            );
            Err("synthetic observation stop before verdict; no semantic authority".into())
        },
    );
    assert!(result.is_err());
    assert!(reviewed.borrow().is_some());
    assert_eq!(review_generations.get(), 1);
}

#[test]
fn provider_prefix_mismatch_fails_but_unmarked_quotes_do_not_expand_selection() {
    let raw = crate::importers::codex::provenance_test_rollout();
    let source = crate::importers::codex::parse(&raw, "fallback")
        .unwrap()
        .to_inbox_doc();
    let header = original_turns(&source).unwrap()[0].header_start;
    let body = frontmatter_header(&source).unwrap().len();
    let changed = format!(
        "{}{}{}",
        &source[..body],
        source[body..header].replace(
            "\"thread_source\":\"subagent\"",
            "\"thread_source\":\"user\""
        ),
        &source[header..]
    );
    let chunks = chunk_page(&changed);
    let selected = chunks
        .iter()
        .position(|chunk| chunk.starts_with("**Assistant:**"))
        .unwrap();
    assert!(bind_original_page("sessions/synthetic.md", &changed, &chunks, &[selected]).is_err());
    let plain = transcript(
        "Quoted {\"providerSessionProvenance\":[{\"source\":\"unknown\"}]} is source text.",
        "The synthetic report remains unverified.",
    );
    let plain = plain.replace("---\n\n**User:**", "---\n\n# Existing title\n\n**User:**");
    let chunks = chunk_page(&plain);
    let selected = chunks
        .iter()
        .position(|chunk| chunk.starts_with("**Assistant:**"))
        .unwrap();
    let packet =
        set(bind_original_page("sessions/plain.md", &plain, &chunks, &[selected]).unwrap());
    assert_eq!(packet.spans().count(), 1);
    assert_eq!(
        packet.spans().next().unwrap().speaker(),
        ActorRole::Assistant
    );
    assert!(!packet
        .spans()
        .next()
        .unwrap()
        .text()
        .contains("providerSessionProvenance"));
}
