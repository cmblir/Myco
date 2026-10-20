//! Closed syntax and exact snapshot failures are rejected, never repaired.

use super::*;

fn first(prepared: &PreparedFocusQa) -> Value {
    output(
        prepared,
        vec![claim(
            0,
            "Please repair the archive.",
            "intention",
            "request",
            "requested",
        )],
    )
}

#[test]
fn source_replay_with_same_count_changed_order_body_metadata_or_raw_json_fails() {
    let (_, prepared) = prepared();
    let old = first(&prepared).to_string();
    let original: Value = serde_json::from_str(prepared.original_user()).unwrap();
    let mut variants = vec![serde_json::to_string_pretty(&original).unwrap()];
    let reordered = source_set(FIRST, SECOND, true);
    variants.push(input(&reordered));
    let changed = source_set(&FIRST.replace("archive", "catalog"), SECOND, false);
    variants.push(input(&changed));
    let mut changed_metadata = original;
    changed_metadata["originalSpans"][0]["turnTime"] = json!("2026-10-03T09:00:00Z");
    variants.push(changed_metadata.to_string());
    for user in variants {
        let different = PreparedFocusQa::prepare(&user).unwrap();
        assert_ne!(
            different.decoder().packet_sha256(),
            prepared.decoder().packet_sha256()
        );
        assert!(different.expand(&old).is_err());
    }
}

#[test]
fn missing_or_malformed_speakers_and_source_coordinates_are_not_defaulted() {
    let (_, prepared) = prepared();
    let original: Value = serde_json::from_str(prepared.original_user()).unwrap();
    let mut variants = Vec::new();
    let mut missing = original.clone();
    missing["originalSpans"][0]
        .as_object_mut()
        .unwrap()
        .remove("speaker");
    variants.push(missing);
    for (field, value) in [
        ("speaker", Value::Null),
        ("speaker", json!("human")),
        ("start", json!(-1)),
        ("end", json!(1)),
        ("sha256", json!("0".repeat(64))),
        ("sourceRevision", json!("A".repeat(64))),
    ] {
        let mut mutated = original.clone();
        mutated["originalSpans"][0][field] = value;
        variants.push(mutated);
    }
    for value in variants {
        assert!(PreparedFocusQa::prepare(&value.to_string()).is_err());
    }
    let mut unknown = original;
    unknown["originalSpans"][0]["speaker"] = json!("unknown");
    let packet = PreparedFocusQa::prepare(&unknown.to_string()).unwrap();
    let mut proposal = first(&packet);
    proposal["claims"][0][4] = json!(["unknown", "speaker", null]);
    assert!(packet.expand(&proposal.to_string()).is_ok());
}

#[test]
fn unknown_kind_and_kind_speech_status_disagreement_are_rejected() {
    let (_, prepared) = prepared();
    for (kind, speech, status) in [
        ("explicit_nonoccurrence", "report", "reported_completed"),
        ("record_or_verification_limit", "report", "reported_failed"),
        ("intention", "report", "unknown"),
        ("uncertain", "report", "unknown"),
        ("asserted_occurrence", "request", "requested"),
        ("asserted_occurrence", "verification", "verified_completed"),
        ("invented_kind", "report", "unknown"),
    ] {
        let raw = output(
            &prepared,
            vec![claim(0, "Please repair the archive.", kind, speech, status)],
        );
        assert!(
            prepared.expand(&raw.to_string()).is_err(),
            "{kind}/{speech}/{status}"
        );
    }
    for (kind, speech, status) in [
        ("explicit_nonoccurrence", "report", "unknown"),
        ("record_or_verification_limit", "report", "unknown"),
        ("intention", "plan", "planned"),
        ("intention", "request", "unknown"),
        ("uncertain", "question", "unknown"),
        ("uncertain", "unknown", "unknown"),
        ("asserted_occurrence", "report", "reported_rolled_back"),
        ("asserted_occurrence", "retraction", "retracted"),
    ] {
        let raw = output(
            &prepared,
            vec![claim(0, "Please repair the archive.", kind, speech, status)],
        );
        assert!(
            prepared.expand(&raw.to_string()).is_ok(),
            "{kind}/{speech}/{status}"
        );
    }
}

#[test]
fn focus_requires_unique_unchanged_utf8_bytes_without_normalization_or_trimming() {
    let (_, prepared) = prepared();
    for focus in [
        "",
        "  ",
        "Please fix the archive.",
        " please repair the archive.",
        "Please repair the archive.\n",
        "I",
    ] {
        let raw = output(
            &prepared,
            vec![claim(0, focus, "asserted_occurrence", "report", "unknown")],
        );
        assert!(prepared.expand(&raw.to_string()).is_err(), "{focus:?}");
    }
    let normalized = output(
        &prepared,
        vec![claim(
            1,
            "지금은 초안만 작성했습니다.",
            "asserted_occurrence",
            "report",
            "unknown",
        )],
    );
    assert!(prepared.expand(&normalized.to_string()).is_err());
    let repeated = source_set("aaa", SECOND, false);
    let packet = PreparedFocusQa::prepare(&input(&repeated)).unwrap();
    let raw = output(
        &packet,
        vec![claim(0, "aa", "asserted_occurrence", "report", "unknown")],
    );
    assert!(packet.expand(&raw.to_string()).is_err());
    let long = "가".repeat(513);
    let long_sources = source_set(&long, SECOND, false);
    let packet = PreparedFocusQa::prepare(&input(&long_sources)).unwrap();
    let raw = output(
        &packet,
        vec![claim(0, &long, "asserted_occurrence", "report", "unknown")],
    );
    assert!(packet.expand(&raw.to_string()).is_err());
    let allowed = "가".repeat(512);
    let allowed_sources = source_set(&allowed, SECOND, false);
    let packet = PreparedFocusQa::prepare(&input(&allowed_sources)).unwrap();
    let raw = output(
        &packet,
        vec![claim(
            0,
            &allowed,
            "asserted_occurrence",
            "report",
            "unknown",
        )],
    );
    assert!(packet.expand(&raw.to_string()).is_ok());
}

#[test]
fn wrong_actual_speaker_and_references_outside_supports_fail_before_native_review() {
    let (_, prepared) = prepared();
    let mut variants = Vec::new();
    for (index, value) in [
        (0, json!(2)),
        (0, json!(-1)),
        (0, json!(0.5)),
        (3, json!([])),
        (3, json!([0, 0])),
        (3, json!([1])),
        (3, json!([0, 2])),
        (4, json!(["assistant", "speaker", null])),
        (4, json!(["source", "explicit_subject", 1])),
        (4, json!(["unknown", "unknown", 0])),
        (5, json!(["2026-10-01", "explicit", "day", "specified", 1])),
        (5, json!([null, "unknown", "unknown", "unknown", 0])),
        (8, json!("fake-receipt")),
    ] {
        let mut changed = first(&prepared);
        changed["claims"][0][index] = value;
        variants.push(changed);
    }
    for raw in variants {
        assert!(prepared.expand(&raw.to_string()).is_err(), "{raw}");
    }
    let mut supported = first(&prepared);
    supported["claims"][0][3] = json!([1, 0]);
    supported["claims"][0][4] = json!(["source", "explicit_subject", 1]);
    assert!(prepared.expand(&supported.to_string()).is_ok());
}

#[test]
fn native_validator_retains_explicit_date_checks_without_wire_semantic_repair() {
    let (sources, prepared) = prepared();
    let mut raw = output(
        &prepared,
        vec![claim(
            0,
            "I have not repaired the archive on 2026-10-01.",
            "explicit_nonoccurrence",
            "report",
            "unknown",
        )],
    );
    raw["claims"][0][5] = json!(["2026-09-29", "explicit", "day", "specified", 0]);
    let projection = prepared.expand(&raw.to_string()).unwrap();
    let expanded: Value = serde_json::from_str(projection.canonical()).unwrap();
    assert_eq!(expanded["claims"][0]["eventTime"]["value"], "2026-09-29");
    assert!(sources
        .validate(projection.canonical(), &origin(), Scope::Sessions)
        .is_err());
}

#[test]
fn version_hash_outer_fields_tuple_lengths_and_complete_eof_are_strict() {
    let (_, prepared) = prepared();
    let valid = first(&prepared);
    let mut variants = Vec::new();
    for (field, value) in [
        ("version", json!("WikiClaimsCompactQaV1")),
        ("packetSha256", json!("0".repeat(64))),
        ("packetSha256", json!("0".repeat(63))),
        ("extra", json!(true)),
        ("outcome", json!("insufficient_evidence")),
    ] {
        let mut changed = valid.clone();
        changed[field] = value;
        variants.push(changed.to_string());
    }
    for field in ["version", "packetSha256", "outcome", "claims"] {
        let mut changed = valid.clone();
        changed.as_object_mut().unwrap().remove(field);
        variants.push(changed.to_string());
    }
    for index in [4, 5] {
        let mut changed = valid.clone();
        changed["claims"][0][index].as_array_mut().unwrap().pop();
        variants.push(changed.to_string());
        let mut changed = valid.clone();
        changed["claims"][0][index]
            .as_array_mut()
            .unwrap()
            .push(Value::Null);
        variants.push(changed.to_string());
    }
    let mut missing = valid.clone();
    missing["claims"][0].as_array_mut().unwrap().pop();
    variants.push(missing.to_string());
    let mut extra = valid.clone();
    extra["claims"][0].as_array_mut().unwrap().push(Value::Null);
    variants.push(extra.to_string());
    let mut duplicated = valid.clone();
    duplicated["claims"]
        .as_array_mut()
        .unwrap()
        .push(valid["claims"][0].clone());
    variants.push(duplicated.to_string());
    variants.push(valid.to_string().trim_end_matches('}').to_string());
    variants.push(format!("{} trailing", valid));
    let duplicate_version =
        valid
            .to_string()
            .replacen("{", "{\"version\":\"WikiSourceFocusClaimsQaV1\",", 1);
    variants.push(duplicate_version);
    for raw in variants {
        assert!(prepared.expand(&raw).is_err(), "{raw}");
    }
    let mut empty_claims = valid;
    empty_claims["claims"] = json!([]);
    assert!(prepared.expand(&empty_claims.to_string()).is_err());
}

#[test]
fn preparation_rejects_nonempty_receipts_zero_or_more_than_eight_originals() {
    let (_, prepared) = prepared();
    let original: Value = serde_json::from_str(prepared.original_user()).unwrap();
    let mut receipt = original.clone();
    receipt["independentVerificationReceipts"] = json!([{"id":"fake-receipt"}]);
    assert!(PreparedFocusQa::prepare(&receipt.to_string()).is_err());
    for count in [0, 9] {
        let mut bounded = original.clone();
        bounded["originalSpans"] = json!((0..count)
            .map(|index| {
                let mut span = original["originalSpans"][0].clone();
                span["id"] = json!(format!("Q-{index}"));
                span
            })
            .collect::<Vec<_>>());
        bounded["allowedSpanIds"] = json!((0..count)
            .map(|index| format!("Q-{index}"))
            .collect::<Vec<_>>());
        assert!(PreparedFocusQa::prepare(&bounded.to_string()).is_err());
    }
}

#[test]
fn native_full_source_packets_at_one_and_eight_originals_keep_their_bounds() {
    let turns = (0..8)
        .map(|index| format!("I recorded item {index}.\n"))
        .collect::<Vec<_>>();
    let original = turns.concat();
    let mut start = 0;
    let spans = turns
        .iter()
        .enumerate()
        .map(|(index, text)| {
            let span = SpanInput {
                id: format!("Q-{index}"),
                start,
                end: start + text.len(),
                turn_id: format!("T-{index}"),
                speaker: ActorRole::Unknown,
                turn_time: None,
            };
            start += text.len();
            span
        })
        .collect();
    let document = SourceDocument::bind(
        "S-EIGHT".into(),
        "sessions/eight.md".into(),
        "sessions/eight.md".into(),
        &original,
        None,
        spans,
    )
    .unwrap();
    let sources = SourceSet::new(origin(), Scope::Sessions, vec![document], vec![]).unwrap();
    let one = sources.retained(|span| span.id() == "Q-0").unwrap();
    for (source, count) in [(&one, 1), (&sources, 8)] {
        let packet = PreparedFocusQa::prepare(&input(source)).unwrap();
        assert_eq!(packet.decoder().span_count(), count);
        let raw = output(&packet, vec![]);
        assert!(packet.expand(&raw.to_string()).is_ok());
    }
}

#[test]
fn native_claim_bound_is_preserved_without_salvaging_excess_claims() {
    let (_, prepared) = prepared();
    let claims = (1..=16)
        .map(|length| claim(0, &FIRST[..length], "intention", "request", "requested"))
        .collect::<Vec<_>>();
    assert!(prepared
        .expand(&output(&prepared, claims.clone()).to_string())
        .is_ok());
    let mut excess = claims;
    excess.push(claim(0, &FIRST[..17], "intention", "request", "requested"));
    assert!(prepared
        .expand(&output(&prepared, excess).to_string())
        .is_err());
}
