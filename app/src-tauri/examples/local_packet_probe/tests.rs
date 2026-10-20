use super::*;
use serde_json::{json, Value};

fn packet(id: &str) -> Value {
    let system = "  Exact system\nwith literal \\n and 한국어.\n";
    let user = "{\"originalSpans\":[{\"text\":\"synthetic evidence\"}]}\n";
    json!({
        "version":1,"dataScope":"synthetic-native-activity-development",
        "source":{"recordSha256":"a".repeat(64),"buildReceiptSha256":"b".repeat(64),
            "sourceReceiptSha256":"c".repeat(64),"observationOrdinal":2,
            "requestId":"native-activity-recent_work-answer"},
        "model":model(id).unwrap(),"runtime":runtime(),"sampler":sampler(),
        "system":system,"systemSha256":hash(system.as_bytes()),
        "user":user,"userSha256":hash(user.as_bytes()),
        "contextTokens":4096,"originalOutputTokens":768,"originalPromptTokens":2213,
        "originalSchema":"wikiClaimsV1","originalLoopStop":"outputBudget",
    })
}

fn parse_value(value: &Value, id: &str) -> Result<Packet, String> {
    let bytes = serde_json::to_vec(value).unwrap();
    parse(&bytes, &hash(&bytes), id)
}

#[test]
fn preserves_exact_utf8_spaces_newlines_and_literal_escapes() {
    for id in [MODEL.id, GEMMA_CANDIDATE.id] {
        let value = packet(id);
        let parsed = parse_value(&value, id).unwrap();
        assert_eq!(
            parsed.system.as_bytes(),
            value["system"].as_str().unwrap().as_bytes()
        );
        assert_eq!(
            parsed.user.as_bytes(),
            value["user"].as_str().unwrap().as_bytes()
        );
    }
}

#[test]
fn rejects_changed_messages_even_with_updated_outer_packet_hash() {
    for field in ["system", "user"] {
        let mut value = packet(MODEL.id);
        value[field] = json!(format!("{} ", value[field].as_str().unwrap()));
        assert!(
            parse_value(&value, MODEL.id).is_err(),
            "accepted changed {field}"
        );
    }
}

#[test]
fn rejects_changed_registration_even_with_self_consistent_message_hashes() {
    let mut value = packet(MODEL.id);
    let registered = serde_json::to_vec(&value).unwrap();
    value["system"] = json!("changed");
    value["systemSha256"] = json!(hash(b"changed"));
    let bytes = serde_json::to_vec(&value).unwrap();
    assert!(parse(&bytes, &hash(&registered), MODEL.id).is_err());
}

#[test]
fn rejects_all_changed_model_pins_and_cross_model_pairings() {
    for field in [
        "id",
        "repository",
        "revision",
        "file",
        "url",
        "bytes",
        "sha256",
        "license",
    ] {
        let mut value = packet(MODEL.id);
        value["model"][field] = if field == "bytes" {
            json!(1)
        } else {
            json!("changed")
        };
        assert!(
            parse_value(&value, MODEL.id).is_err(),
            "accepted changed model {field}"
        );
    }
    assert!(parse_value(&packet(MODEL.id), GEMMA_CANDIDATE.id).is_err());
    for id in ["", "qwen3.5-2b-q4_k_m", "gemma", "qwen", "other"] {
        assert!(model(id).is_err(), "accepted implicit/unsupported {id}");
    }
}

#[test]
fn rejects_every_changed_runtime_pin_before_generation() {
    for field in [
        "cargoLockSha256",
        "decoderSourceSha256",
        "gemmaTemplateSourceSha256",
        "grammarSha256",
    ] {
        let mut value = packet(MODEL.id);
        value["runtime"][field] = json!("d".repeat(64));
        assert!(
            parse_value(&value, MODEL.id).is_err(),
            "accepted changed runtime {field}"
        );
    }
}

#[test]
fn rejects_changed_sampler_values_order_and_profile() {
    for field in [
        "penaltyLastN",
        "repeatPenalty",
        "frequencyPenalty",
        "presencePenalty",
        "topK",
        "topP",
        "minKeep",
        "temperature",
        "seed",
    ] {
        let mut value = packet(MODEL.id);
        value["sampler"][field] = json!(0);
        if field == "frequencyPenalty" {
            value["sampler"][field] = json!(0.5);
        }
        assert!(
            parse_value(&value, MODEL.id).is_err(),
            "accepted changed sampler {field}"
        );
    }
    for field in ["profile", "order"] {
        let mut value = packet(MODEL.id);
        value["sampler"][field] = if field == "order" {
            json!(["dist", "grammar"])
        } else {
            json!("other")
        };
        assert!(parse_value(&value, MODEL.id).is_err());
    }
}

#[test]
fn rejects_wrong_scope_version_budget_or_original_stop() {
    for (field, changed) in [
        ("version", json!(2)),
        ("dataScope", json!("private-vault")),
        ("contextTokens", json!(2048)),
        ("originalOutputTokens", json!(1536)),
        ("originalPromptTokens", json!(0)),
        ("originalLoopStop", json!("eog")),
        ("originalSchema", json!("wikiClaimReviewV1")),
    ] {
        let mut value = packet(MODEL.id);
        value[field] = changed;
        assert!(
            parse_value(&value, MODEL.id).is_err(),
            "accepted changed {field}"
        );
    }
}

#[test]
fn rejects_invalid_original_record_registration() {
    for field in [
        "recordSha256",
        "buildReceiptSha256",
        "sourceReceiptSha256",
        "observationOrdinal",
        "requestId",
    ] {
        let mut value = packet(MODEL.id);
        value["source"][field] = if field == "observationOrdinal" {
            json!(0)
        } else {
            json!("")
        };
        assert!(
            parse_value(&value, MODEL.id).is_err(),
            "accepted source {field}"
        );
    }
}

#[test]
fn rejects_extra_authority_gold_and_duplicate_fields() {
    for field in ["semanticPassed", "gold", "priorOutput", "reviewApprovals"] {
        let mut value = packet(MODEL.id);
        value[field] = json!(true);
        assert!(parse_value(&value, MODEL.id).is_err());
    }
    let bytes = serde_json::to_string(&packet(MODEL.id)).unwrap();
    for replaced in [
        bytes.replacen("\"version\":1", "\"version\":1,\"version\":1", 1),
        bytes.replacen(
            "\"bytes\":2707513696",
            "\"bytes\":2707513696,\"bytes\":2707513696",
            1,
        ),
    ] {
        assert_ne!(replaced, bytes);
        assert!(parse(replaced.as_bytes(), &hash(replaced.as_bytes()), MODEL.id).is_err());
    }
}

#[test]
fn reserves_complete_input_without_truncating_or_accepting_a_changed_tokenizer() {
    let mut value = packet(MODEL.id);
    value["originalPromptTokens"] = json!(2552);
    let parsed = parse_value(&value, MODEL.id).unwrap();
    assert!(preflight(&parsed, 2552, 1536).is_ok());
    assert!(preflight(&parsed, 2551, 1536).is_err());
    for invalid in [-1, 0, 512, 769, 1537] {
        assert!(preflight(&parsed, 2552, invalid).is_err());
    }
    value["originalPromptTokens"] = json!(2553);
    let parsed = parse_value(&value, MODEL.id).unwrap();
    assert!(preflight(&parsed, 2553, 768).is_ok());
    assert!(preflight(&parsed, 2553, 1536).is_err());
}

fn arguments() -> Vec<String> {
    [
        "--model-dir",
        "/synthetic/models",
        "--model-id",
        MODEL.id,
        "--packet",
        "/synthetic/packet.json",
        "--packet-sha256",
        &"a".repeat(64),
    ]
    .map(String::from)
    .to_vec()
}

#[test]
fn admits_only_complete_explicit_execution_registration_options() {
    let mut args = arguments();
    args.extend([
        "--execution-registration".into(),
        "/synthetic/execution-registration.json".into(),
        "--execution-registration-sha256".into(),
        "b".repeat(64),
    ]);
    assert!(options(args.clone()).is_ok());
    for removed in [8, 10] {
        let mut incomplete = args.clone();
        incomplete.drain(removed..removed + 2);
        assert!(options(incomplete).is_err());
    }
    args[11] = "B".repeat(64);
    assert!(options(args).is_err());
}

#[test]
fn rejects_duplicate_execution_registration_and_arbitrary_sampler_overrides() {
    let mut args = arguments();
    args.extend([
        "--execution-registration".into(),
        "/synthetic/execution-registration.json".into(),
        "--execution-registration-sha256".into(),
        "b".repeat(64),
    ]);
    assert!(options(args.clone()).is_ok());
    for flag in [
        "--execution-registration",
        "--execution-registration-sha256",
        "--presence-penalty",
        "--sampler",
    ] {
        let mut overridden = args.clone();
        overridden.extend([flag.into(), "other".into()]);
        assert!(options(overridden).is_err());
    }
}

#[test]
fn requires_explicit_complete_options_and_rejects_duplicates_or_overrides() {
    let parsed = options(arguments()).unwrap();
    assert_eq!(parsed.model_id, MODEL.id);
    assert_eq!(
        parsed.model_dir,
        std::path::PathBuf::from("/synthetic/models")
    );
    assert_eq!(
        parsed.packet_path,
        std::path::PathBuf::from("/synthetic/packet.json")
    );
    assert_eq!(parsed.packet_sha256, "a".repeat(64));
    for index in [0, 2, 4, 6] {
        let mut args = arguments();
        args.drain(index..index + 2);
        assert!(options(args).is_err());
    }
    for flag in [
        "--model-dir",
        "--model-id",
        "--packet",
        "--packet-sha256",
        "--output-tokens",
        "--system",
        "--sampler",
    ] {
        let mut args = arguments();
        args.extend([flag.into(), "other".into()]);
        assert!(options(args).is_err(), "accepted duplicate/override {flag}");
    }
    let mut args = arguments();
    args[7] = "A".repeat(64);
    assert!(options(args).is_err());
}

#[test]
fn reads_registered_bytes_once_and_rejects_empty_large_non_utf8_and_changed_files() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("packet.json");
    let bytes = serde_json::to_vec(&packet(MODEL.id)).unwrap();
    std::fs::write(&path, &bytes).unwrap();
    let retained = read(&path, &hash(&bytes), MODEL.id).unwrap();
    std::fs::write(&path, b"changed after admission").unwrap();
    assert_eq!(retained.user, packet(MODEL.id)["user"].as_str().unwrap());
    assert!(read(&path, &hash(&bytes), MODEL.id).is_err());
    for invalid in [
        Vec::new(),
        vec![b' '; MAX_PACKET_BYTES + 1],
        vec![0xff, 0xfe],
    ] {
        std::fs::write(&path, &invalid).unwrap();
        assert!(read(&path, &hash(&invalid), MODEL.id).is_err());
    }
    assert!(read(directory.path(), &hash(&bytes), MODEL.id).is_err());
}

#[cfg(unix)]
#[test]
fn rejects_symlinks_and_hardlinked_packet_aliases() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("packet.json");
    let bytes = serde_json::to_vec(&packet(MODEL.id)).unwrap();
    std::fs::write(&path, &bytes).unwrap();
    let alias = directory.path().join("alias.json");
    std::os::unix::fs::symlink(&path, &alias).unwrap();
    assert!(read(&alias, &hash(&bytes), MODEL.id).is_err());
    let hardlink = directory.path().join("hardlink.json");
    std::fs::hard_link(&path, &hardlink).unwrap();
    assert!(read(&path, &hash(&bytes), MODEL.id).is_err());
    assert!(read(&hardlink, &hash(&bytes), MODEL.id).is_err());
}
