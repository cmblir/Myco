//! Invalid named fields are rejected; plausible false meanings stay unapproved.

use super::*;

#[test]
fn named_missing_extra_duplicate_or_array_fields_are_never_defaulted() {
    let (_, prepared) = prepared(Encoding::NamedV1);
    let base = output(&prepared, &sample()[..1]);
    let paths: &[(&[&str], &[&str])] = &[
        (&[], &["version", "packetSha256", "outcome", "claims"]),
        (
            &["claims", "0"],
            &[
                "anchorOrdinal",
                "focusQuote",
                "assertionKind",
                "supportOrdinals",
                "actor",
                "eventTime",
                "speechAct",
                "status",
                "verificationId",
            ],
        ),
        (
            &["claims", "0", "actor"],
            &["role", "basis", "subjectOrdinal"],
        ),
        (
            &["claims", "0", "eventTime"],
            &[
                "value",
                "basis",
                "precision",
                "uncertainty",
                "timeSupportOrdinal",
            ],
        ),
    ];
    for (path, keys) in paths {
        for key in *keys {
            let mut missing = base.clone();
            object_mut(&mut missing, path).remove(*key);
            assert!(
                prepared.expand(&missing.to_string()).is_err(),
                "missing {path:?}/{key}"
            );
        }
        let mut extra = base.clone();
        object_mut(&mut extra, path).insert("extra".into(), json!(true));
        assert!(
            prepared.expand(&extra.to_string()).is_err(),
            "extra {path:?}"
        );
    }
    for (key, value) in [
        ("version", json!(NAMED_VERSION)),
        ("focusQuote", json!(FIRST)),
        ("role", json!("source")),
        ("value", json!("2026-10-01")),
    ] {
        let raw = base.to_string();
        let needle = format!("\"{key}\":");
        let duplicated = raw.replacen(&needle, &format!("\"{key}\":{value},{needle}"), 1);
        assert!(prepared.expand(&duplicated).is_err(), "duplicate {key}");
    }
    for field in ["actor", "eventTime"] {
        let mut array = base.clone();
        array["claims"][0][field] = if field == "actor" {
            json!(["source", "explicit_subject", 0])
        } else {
            json!(["2026-10-01", "explicit", "day", "specified", 0])
        };
        assert!(
            prepared.expand(&array.to_string()).is_err(),
            "array disguised as {field}"
        );
    }
    let mut non_null = base.clone();
    non_null["claims"][0]["verificationId"] = json!("forged");
    assert!(prepared.expand(&non_null.to_string()).is_err());
    let raw = base.to_string();
    assert!(prepared.expand(raw.trim_end_matches('}')).is_err());
    assert!(prepared.expand(&(raw + " trailing")).is_err());
}

fn object_mut<'a>(value: &'a mut Value, path: &[&str]) -> &'a mut serde_json::Map<String, Value> {
    let mut current = value;
    for part in path {
        current = if *part == "0" {
            &mut current[0]
        } else {
            &mut current[*part]
        };
    }
    current.as_object_mut().unwrap()
}

#[test]
fn named_and_tuple_versions_shapes_ordinals_and_packet_replays_are_separate() {
    let (_, tuple) = prepared(Encoding::TupleV1);
    let named = PreparedFocusQa::prepare_for(tuple.original_user(), Encoding::NamedV1).unwrap();
    let tuple_raw = output(&tuple, &sample());
    let named_raw = output(&named, &sample());
    assert!(named.expand(&tuple_raw.to_string()).is_err());
    assert!(tuple.expand(&named_raw.to_string()).is_err());
    let mut wrong = named_raw.clone();
    wrong["claims"] = tuple_raw["claims"].clone();
    assert!(named.expand(&wrong.to_string()).is_err());
    let mut wrong = tuple_raw;
    wrong["claims"] = named_raw["claims"].clone();
    assert!(tuple.expand(&wrong.to_string()).is_err());
    for id in [json!(-1), json!(0.5), json!("0"), json!(2)] {
        for field in [
            "anchorOrdinal",
            "supportOrdinals",
            "subjectOrdinal",
            "timeSupportOrdinal",
        ] {
            let mut wrong = named_raw.clone();
            match field {
                "supportOrdinals" => wrong["claims"][0][field] = json!([id.clone()]),
                "subjectOrdinal" => wrong["claims"][0]["actor"][field] = id.clone(),
                "timeSupportOrdinal" => wrong["claims"][0]["eventTime"][field] = id.clone(),
                _ => wrong["claims"][0][field] = id.clone(),
            }
            assert!(named.expand(&wrong.to_string()).is_err(), "{field}: {id}");
        }
    }
    let mut duplicate = named_raw.clone();
    duplicate["claims"][0]["supportOrdinals"] = json!([0, 0]);
    assert!(named.expand(&duplicate.to_string()).is_err());
    for changed in [
        sources(&FIRST.replace("valve", "pump"), false),
        sources(FIRST, true),
    ] {
        let newer = PreparedFocusQa::prepare_for(&input(&changed), Encoding::NamedV1).unwrap();
        assert!(newer.expand(&named_raw.to_string()).is_err());
    }
    for value in [json!("0".repeat(64)), json!("0".repeat(63))] {
        let mut wrong = named_raw.clone();
        wrong["packetSha256"] = value;
        assert!(named.expand(&wrong.to_string()).is_err());
    }
}

#[test]
fn named_actual_prompt_encoding_private_proof_and_native_review_context_are_bound() {
    let (current_sources, mut prepared) = prepared(Encoding::NamedV1);
    let raw = output(&prepared, &sample()).to_string();
    let system = prepared.system.clone();
    prepared.system.push(' ');
    assert!(prepared.expand(&raw).is_err());
    prepared.system = system;
    let user = prepared.user.clone();
    prepared.user.push(' ');
    assert!(prepared.expand(&raw).is_err());
    prepared.user = user;
    let original = prepared.expand(&raw).unwrap();
    let mut changed = original.clone();
    changed.generation_system.push(' ');
    assert!(changed.verify_binding().is_err());
    let mut changed = original.clone();
    changed.generation_user.push(' ');
    assert!(changed.verify_binding().is_err());
    let mut changed = original.clone();
    changed.encoding = Some(Encoding::TupleV1);
    assert!(changed.verify_binding().is_err());
    let checked = current_sources
        .validate(original.canonical(), &origin(), Scope::Sessions)
        .unwrap();
    let context: Value = serde_json::from_str(prepared.original_user()).unwrap();
    for field in ["question", "language", "activityPeriod"] {
        let mut changed = context.clone();
        changed[field] = Value::Null;
        assert!(original
            .review_value(&current_sources, &checked, &changed)
            .is_err());
    }
    let reversed = sources(FIRST, true);
    assert!(original
        .review_value(&reversed, &checked, &context)
        .is_err());
    let missing = current_sources
        .retained(|span| span.id() == "Q-FIRST")
        .unwrap();
    assert!(original.review_value(&missing, &checked, &context).is_err());
    let decoder = prepared.decoder;
    prepared.decoder.encoding = Encoding::TupleV1;
    assert!(prepared.expand(&raw).is_err());
    prepared.decoder = decoder;
    prepared.decoder.packet_sha256[0] ^= 1;
    assert!(prepared.expand(&raw).is_err());
}

#[test]
fn named_false_actor_and_kind_are_not_repaired_or_semantically_approved() {
    let (sources, prepared) = prepared(Encoding::NamedV1);
    let mut claims = sample();
    claims[0][4] = json!(["user", "speaker", null]);
    claims[1][2] = json!("asserted_occurrence");
    claims[1][7] = json!("reported_completed");
    let projection = prepared
        .expand(&output(&prepared, &claims).to_string())
        .unwrap();
    let checked = sources
        .validate(projection.canonical(), &origin(), Scope::Sessions)
        .unwrap();
    assert_eq!(checked.claims[0].proposal.actor.role, ActorRole::User);
    assert_eq!(
        checked.claims[1].proposal.action,
        "I did not deploy the change because the preview was blank."
    );
    assert_eq!(
        checked.claims[1].proposal.status,
        crate::wiki_claims::ClaimStatus::ReportedCompleted
    );
    assert!(checked
        .claims
        .iter()
        .all(|claim| claim.semantic_review_required));
    assert!(!projection.semantic_accepted);
    let mut incompatible = claims;
    incompatible[1][2] = json!("explicit_nonoccurrence");
    assert!(prepared
        .expand(&output(&prepared, &incompatible).to_string())
        .is_err());
}

#[test]
fn named_invalid_time_literal_is_preserved_for_strict_native_rejection() {
    let (sources, prepared) = prepared(Encoding::NamedV1);
    for invalid in ["report", "unknown", "cancelled", "reopened"] {
        let mut claims = sample();
        claims[0][5] = json!([invalid, "inferred_from_turn", "instant", "inferred", 0]);
        let projection = prepared
            .expand(&output(&prepared, &claims).to_string())
            .unwrap();
        let native: Value = serde_json::from_str(projection.canonical()).unwrap();
        assert_eq!(native["claims"][0]["eventTime"]["value"], invalid);
        let error = sources
            .validate(projection.canonical(), &origin(), Scope::Sessions)
            .err()
            .unwrap();
        assert_eq!(error, "claim time has invalid value or precision");
    }
}
