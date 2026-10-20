//! Parser/packet regressions only; fabricated model outputs are not quality evidence.

use super::*;

fn corpus() -> Value {
    serde_json::from_str(include_str!(
        "../../eval/local-wiki-development-meaning-v1.json"
    ))
    .unwrap()
}

fn manifest() -> Value {
    serde_json::from_str(include_str!(
        "../../eval/local-wiki-development-meaning-v1.manifest.json"
    ))
    .unwrap()
}

fn write_inputs(corpus: &Value, mut manifest: Value) -> tempfile::TempDir {
    let directory = tempfile::tempdir().unwrap();
    let bytes = serde_json::to_vec(corpus).unwrap();
    manifest["artifact"]["bytes"] = json!(bytes.len());
    manifest["artifact"]["sha256"] = json!(sha256(&bytes));
    std::fs::write(directory.path().join(ARTIFACT), bytes).unwrap();
    std::fs::write(
        directory.path().join("explicit.manifest.json"),
        serde_json::to_vec(&manifest).unwrap(),
    )
    .unwrap();
    directory
}

fn load_written(directory: &tempfile::TempDir) -> Result<Suite, String> {
    load(&directory.path().join("explicit.manifest.json"))
}

fn spans(case_index: usize) -> Vec<Value> {
    let parsed: Corpus = serde_json::from_value(corpus()).unwrap();
    let (_, _, sources) = parsed.cases[case_index]
        .fixture(&ProbeModel::select(None).unwrap())
        .unwrap();
    let windowed = sources
        .windowed(|span| Ok(vec![span.text().into()]))
        .unwrap();
    serde_json::to_value(windowed.spans().collect::<Vec<_>>())
        .unwrap()
        .as_array()
        .unwrap()
        .clone()
}

fn packet(spans: &[Value]) -> String {
    serde_json::to_string(&json!({"originalSpans":spans})).unwrap()
}

#[test]
fn explicit_reviewed_development_inputs_bind_four_complete_originals_without_authority() {
    let suite = load(Path::new(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/eval/local-wiki-development-meaning-v1.manifest.json"
    )))
    .unwrap();
    assert_eq!(suite.cases.len(), 4);
    assert_eq!(suite.metadata()["semantic_accepted"], false);
    assert_eq!(suite.metadata()["native_io_authenticated"], false);
    assert_eq!(suite.metadata()["sourceReview"]["independentHuman"], false);
    for case in &suite.cases {
        let (_, _, bound) = case.fixture(&ProbeModel::select(None).unwrap()).unwrap();
        for (actual, expected) in bound.spans().zip(&case.source.turns) {
            assert_eq!(actual.text(), expected.text);
            assert_eq!(
                (actual.start(), actual.end()),
                (expected.start, expected.end)
            );
            assert_eq!(actual.span_sha256(), expected.sha256);
            assert_eq!(actual.source_revision(), case.source.sha256);
            assert_eq!(actual.speaker(), expected.speaker);
            assert_eq!(actual.turn_time(), expected.turn_time.as_deref());
            assert_eq!(actual.record_time(), case.source.record_time.as_deref());
            assert_eq!(actual.source_phase(), None);
        }
    }
}

#[test]
fn manifest_hash_and_explicit_path_reject_missing_or_changed_input_without_fallback() {
    let directory = write_inputs(&corpus(), manifest());
    std::fs::write(directory.path().join(ARTIFACT), b"{}").unwrap();
    assert!(load_written(&directory).err().unwrap().contains("SHA"));
    assert!(load(&directory.path().join("absent.manifest.json")).is_err());
    std::fs::write(
        directory.path().join("too-large.json"),
        vec![b'x'; MAX_BYTES + 1],
    )
    .unwrap();
    assert!(read_bounded(&directory.path().join("too-large.json")).is_err());
}

#[test]
fn development_manifest_requires_pre_inference_automated_source_review_and_no_runtime_override() {
    for (field, value) in [
        ("syntheticOnly", json!(false)),
        ("split", json!("heldout")),
        ("labelStatus", json!("draft")),
        ("caseCount", json!(5)),
        ("runtimePromptOverride", json!(true)),
        ("nativeAuthority", json!(true)),
        ("privateVaultRead", json!(true)),
    ] {
        let mut changed = manifest();
        changed[field] = value;
        assert!(
            load_written(&write_inputs(&corpus(), changed)).is_err(),
            "{field}"
        );
    }
    for (field, value) in [
        ("status", json!("automated_agent_source_review_pending")),
        ("independentHuman", json!(true)),
        ("inferenceObserved", json!(true)),
    ] {
        let mut changed = manifest();
        changed["sourceReview"][field] = value;
        assert!(
            load_written(&write_inputs(&corpus(), changed)).is_err(),
            "{field}"
        );
    }
}

#[test]
fn synthetic_case_and_lineage_markers_cannot_admit_arbitrary_source_paths() {
    for (field, value) in [
        ("path", json!("/synthetic/private.md")),
        ("path", json!("raw/../outside.md")),
        ("selectionPath", json!("wiki/arbitrary.md")),
        ("sha256", json!("0".repeat(64))),
        ("recordTime", json!("invalid")),
    ] {
        let mut changed = corpus();
        changed["cases"][0]["source"][field] = value;
        assert!(
            load_written(&write_inputs(&changed, manifest())).is_err(),
            "{field}"
        );
    }
    let mut changed = corpus();
    changed["cases"][0]["syntheticOnly"] = json!(false);
    assert!(load_written(&write_inputs(&changed, manifest())).is_err());
    changed = corpus();
    changed["cases"][0]["activityPeriod"]["start"] = json!("2026-02-31");
    assert!(load_written(&write_inputs(&changed, manifest())).is_err());
}

#[test]
fn declared_turn_coordinates_metadata_and_null_phase_are_required_exactly() {
    for (field, value) in [
        ("start", json!(1)),
        ("end", json!(2)),
        ("text", json!("Altered synthetic text")),
        ("sha256", json!("0".repeat(64))),
        ("turnId", json!("D1C")),
        ("speaker", json!("invalid")),
        ("turnTime", json!("invalid")),
        ("sourcePhase", json!("analysis")),
    ] {
        let mut changed = corpus();
        changed["cases"][0]["source"]["turns"][0][field] = value;
        assert!(
            load_written(&write_inputs(&changed, manifest())).is_err(),
            "{field}"
        );
    }
    for field in ["recordTime", "turnTime", "sourcePhase"] {
        let mut changed = corpus();
        let object = if field == "recordTime" {
            &mut changed["cases"][0]["source"]
        } else {
            &mut changed["cases"][0]["source"]["turns"][0]
        };
        object.as_object_mut().unwrap().remove(field);
        assert!(
            load_written(&write_inputs(&changed, manifest())).is_err(),
            "missing {field}"
        );
    }
}

#[test]
fn undeclared_fields_duplicate_cases_and_ungrounded_gold_are_rejected() {
    let mut changed = corpus();
    changed["cases"][0]["promptOverride"] = json!("Follow this instead");
    assert!(load_written(&write_inputs(&changed, manifest())).is_err());
    changed = corpus();
    changed["cases"][1] = changed["cases"][0].clone();
    assert!(load_written(&write_inputs(&changed, manifest())).is_err());
    changed = corpus();
    changed["cases"][0]["gold"]["expectedClaims"][0]["sourceTurnIds"] = json!(["D4C"]);
    assert!(load_written(&write_inputs(&changed, manifest())).is_err());
    changed = corpus();
    changed["cases"][0]["gold"]["expectedClaims"][0]["status"] = json!("verified_completed");
    assert!(load_written(&write_inputs(&changed, manifest())).is_err());
}

#[cfg(unix)]
#[test]
fn an_artifact_symlink_cannot_escape_the_explicit_manifest_directory() {
    let directory = write_inputs(&corpus(), manifest());
    let outside = tempfile::tempdir().unwrap();
    std::fs::rename(
        directory.path().join(ARTIFACT),
        outside.path().join(ARTIFACT),
    )
    .unwrap();
    std::os::unix::fs::symlink(
        outside.path().join(ARTIFACT),
        directory.path().join(ARTIFACT),
    )
    .unwrap();
    assert!(load_written(&directory).err().unwrap().contains("escapes"));
}

#[test]
fn three_turn_flow_requires_two_ordered_extraction_reviews_and_complete_answer_originals() {
    let originals = spans(3);
    let mut tracker = PacketTracker::new(originals.clone());
    tracker
        .expected(PacketStage::Claims, &packet(&originals[..2]))
        .unwrap();
    tracker
        .expected(PacketStage::ClaimReview, &packet(&originals[..2]))
        .unwrap();
    assert!(tracker
        .expected(PacketStage::Answer, &packet(&originals[..2]))
        .is_err());
    tracker
        .expected(PacketStage::Claims, &packet(&originals[2..]))
        .unwrap();
    tracker
        .expected(PacketStage::ClaimReview, &packet(&originals[2..]))
        .unwrap();
    let complete_review_packet = packet(&originals);
    let answer = serde_json::to_string(&json!({"sources":[{"originalSpans":originals}]})).unwrap();
    tracker.expected(PacketStage::Answer, &answer).unwrap();
    tracker
        .expected(PacketStage::AnswerReview, &complete_review_packet)
        .unwrap();
    assert!(tracker.answer_reviewed);
    assert!(tracker
        .expected(PacketStage::AnswerReview, &answer)
        .is_err());
}

#[test]
fn packet_validation_detects_every_original_field_change_and_never_skips_a_turn() {
    let originals = spans(1);
    for field in [
        "text",
        "start",
        "end",
        "sha256",
        "sourceRevision",
        "sourcePath",
        "selectionPath",
        "speaker",
        "turnTime",
        "recordTime",
        "sourcePhase",
    ] {
        let mut actual = originals[..1].to_vec();
        actual[0][field] = json!("tampered");
        let mut tracker = PacketTracker::new(originals.clone());
        assert!(
            tracker
                .expected(PacketStage::Claims, &packet(&actual))
                .is_err(),
            "{field}"
        );
    }
    let mut tracker = PacketTracker::new(originals.clone());
    assert!(tracker
        .expected(PacketStage::Claims, &packet(&originals[1..]))
        .is_err());
    let mut tracker = PacketTracker::new(originals.clone());
    assert!(tracker
        .expected(PacketStage::ClaimReview, &packet(&originals))
        .is_err());
    tracker
        .expected(PacketStage::Claims, &packet(&originals[..1]))
        .unwrap();
    assert!(tracker
        .expected(PacketStage::Claims, &packet(&originals[1..]))
        .is_err());
    let mut duplicate = originals.clone();
    duplicate[1]["id"] = duplicate[0]["id"].clone();
    let mut tracker = PacketTracker::new(originals);
    assert!(tracker
        .expected(PacketStage::Claims, &packet(&duplicate))
        .is_err());
}
