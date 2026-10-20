use super::*;
use crate::contract::{model, runtime, sampler};
use myco_lib::local_model::{GEMMA_CANDIDATE, MODEL};
use serde_json::{json, Value};

fn original_packet(id: &str) -> Value {
    let system = "  Exact system\nwith literal \\n and 한국어.\n";
    let user = "{\"originalSpans\":[{\"text\":\"synthetic evidence\"}]}\n";
    let mut historical_runtime = serde_json::to_value(runtime()).unwrap();
    historical_runtime["decoderSourceSha256"] = json!("e".repeat(64));
    json!({
        "version":1,"dataScope":"synthetic-native-activity-development",
        "source":{"recordSha256":"a".repeat(64),"buildReceiptSha256":"b".repeat(64),
            "sourceReceiptSha256":"c".repeat(64),"observationOrdinal":2,
            "requestId":"native-activity-recent_work-answer"},
        "model":model(id).unwrap(),"runtime":historical_runtime,"sampler":sampler(),
        "system":system,"systemSha256":hash(system.as_bytes()),
        "user":user,"userSha256":hash(user.as_bytes()),
        "contextTokens":4096,"originalOutputTokens":768,"originalPromptTokens":2213,
        "originalSchema":"wikiClaimsV1","originalLoopStop":"outputBudget",
    })
}

fn registration(packet: &Value, id: &str) -> Value {
    json!({
        "version":1,"treatment":"presence-only",
        "originalPacketSha256":hash(&serde_json::to_vec(packet).unwrap()),
        "originalInputProvenanceReceiptSha256":"1".repeat(64),
        "originalRuntime":packet["runtime"],"executionRuntime":execution_runtime(),
        "executionSourceReceiptSha256":"2".repeat(64),
        "executionBuildReceiptSha256":"3".repeat(64),
        "executionBinarySha256":"4".repeat(64),
        "approvedSourceDeltaReceiptSha256":"5".repeat(64),
        "profiles":PROFILES,"outputTokens":OUTPUT_TOKENS,"contextTokens":CONTEXT_TOKENS,
        "modelId":id,"armIds":["synthetic-baseline-1536","synthetic-no-presence-1536"],
    })
}

fn parse_value(value: &Value, id: &str) -> Result<Registration, String> {
    let bytes = serde_json::to_vec(value).unwrap();
    parse_registration(
        &bytes,
        &hash(&bytes),
        value["originalPacketSha256"].as_str().unwrap(),
        id,
    )
}

fn read_values(
    registration: &Value,
    packet: &Value,
    id: &str,
) -> Result<(Registration, Packet), String> {
    let directory = tempfile::tempdir().unwrap();
    let registration_path = directory.path().join("registration.json");
    let packet_path = directory.path().join("packet.json");
    let registration_bytes = serde_json::to_vec(registration).unwrap();
    let packet_bytes = serde_json::to_vec(packet).unwrap();
    std::fs::write(&registration_path, &registration_bytes).unwrap();
    std::fs::write(&packet_path, &packet_bytes).unwrap();
    read(
        &registration_path,
        &hash(&registration_bytes),
        &packet_path,
        &hash(&packet_bytes),
        id,
    )
}

#[test]
fn admits_registered_presence_pair_for_both_explicit_pinned_models() {
    for id in [MODEL.id, GEMMA_CANDIDATE.id] {
        let packet = original_packet(id);
        let value = registration(&packet, id);
        let parsed = parse_value(&value, id).unwrap();
        assert_eq!(parsed.model_id, id);
        assert_eq!(parsed.profiles, PROFILES.map(String::from));
        assert_eq!(parsed.arm_ids.len(), 2);
        assert_eq!(parsed.output_tokens, 1536);
        assert_eq!(parsed.context_tokens, 4096);
        assert_eq!(parsed.execution_runtime, execution_runtime());
    }
}

#[test]
fn retains_historical_decoder_and_exact_original_message_bytes_without_rewriting() {
    for id in [MODEL.id, GEMMA_CANDIDATE.id] {
        let packet = original_packet(id);
        let value = registration(&packet, id);
        let (registered, retained) = read_values(&value, &packet, id).unwrap();
        assert_ne!(
            retained.runtime.decoder_source_sha256,
            runtime().decoder_source_sha256
        );
        assert_eq!(retained.runtime, registered.original_runtime);
        assert_eq!(
            retained.system.as_bytes(),
            packet["system"].as_str().unwrap().as_bytes()
        );
        assert_eq!(
            retained.user.as_bytes(),
            packet["user"].as_str().unwrap().as_bytes()
        );
        assert_eq!(retained.original_output_tokens, 768);
        assert_eq!(retained.original_prompt_tokens, 2213);
        assert_eq!(retained.sampler, sampler());
    }
}

#[test]
fn does_not_relax_ordinary_replay_runtime_pins() {
    let packet = original_packet(MODEL.id);
    let value = registration(&packet, MODEL.id);
    assert!(read_values(&value, &packet, MODEL.id).is_ok());
    let bytes = serde_json::to_vec(&packet).unwrap();
    assert!(crate::contract::parse(&bytes, &hash(&bytes), MODEL.id).is_err());
}

#[test]
fn rejects_stale_external_registration_and_packet_hashes() {
    let packet = original_packet(MODEL.id);
    let value = registration(&packet, MODEL.id);
    assert!(parse_value(&value, MODEL.id).is_ok());
    let bytes = serde_json::to_vec(&value).unwrap();
    let packet_sha = value["originalPacketSha256"].as_str().unwrap();
    for invalid in ["0".repeat(64), "A".repeat(64), String::new()] {
        assert!(parse_registration(&bytes, &invalid, packet_sha, MODEL.id).is_err());
        assert!(parse_registration(&bytes, &hash(&bytes), &invalid, MODEL.id).is_err());
    }
    let mut changed = value.clone();
    changed["armIds"][0] = json!("changed-registration");
    let changed = serde_json::to_vec(&changed).unwrap();
    assert!(parse_registration(&changed, &hash(&bytes), packet_sha, MODEL.id).is_err());
}

#[test]
fn rejects_every_changed_current_execution_source_pin() {
    let value = registration(&original_packet(MODEL.id), MODEL.id);
    assert!(parse_value(&value, MODEL.id).is_ok());
    for field in [
        "cargoLockSha256",
        "decoderSourceSha256",
        "gemmaTemplateSourceSha256",
        "grammarSha256",
    ] {
        let mut changed = value.clone();
        changed["executionRuntime"]["runtime"][field] = json!("f".repeat(64));
        assert!(
            parse_value(&changed, MODEL.id).is_err(),
            "accepted current {field}"
        );
    }
    for field in ["telemetrySourceSha256", "samplerSourceSha256"] {
        let mut changed = value.clone();
        changed["executionRuntime"][field] = json!("f".repeat(64));
        assert!(
            parse_value(&changed, MODEL.id).is_err(),
            "accepted current {field}"
        );
    }
}

#[test]
fn permits_only_decoder_history_change_in_original_runtime() {
    let value = registration(&original_packet(MODEL.id), MODEL.id);
    assert!(parse_value(&value, MODEL.id).is_ok());
    for field in [
        "cargoLockSha256",
        "gemmaTemplateSourceSha256",
        "grammarSha256",
    ] {
        let mut changed = value.clone();
        changed["originalRuntime"][field] = json!("f".repeat(64));
        assert!(
            parse_value(&changed, MODEL.id).is_err(),
            "accepted historical {field}"
        );
    }
    for invalid in ["", "E", "not-a-sha"] {
        let mut changed = value.clone();
        changed["originalRuntime"]["decoderSourceSha256"] = json!(invalid);
        assert!(parse_value(&changed, MODEL.id).is_err());
    }
}

#[test]
fn rejects_unbound_historical_packet_runtime() {
    let mut packet = original_packet(MODEL.id);
    let mut value = registration(&packet, MODEL.id);
    assert!(read_values(&value, &packet, MODEL.id).is_ok());
    packet["runtime"]["decoderSourceSha256"] = json!("f".repeat(64));
    value["originalPacketSha256"] = json!(hash(&serde_json::to_vec(&packet).unwrap()));
    assert!(read_values(&value, &packet, MODEL.id).is_err());
}

#[test]
fn rejects_invalid_receipt_digests_and_incomplete_registration() {
    let value = registration(&original_packet(MODEL.id), MODEL.id);
    assert!(parse_value(&value, MODEL.id).is_ok());
    for field in [
        "originalPacketSha256",
        "originalInputProvenanceReceiptSha256",
        "executionSourceReceiptSha256",
        "executionBuildReceiptSha256",
        "executionBinarySha256",
        "approvedSourceDeltaReceiptSha256",
    ] {
        for invalid in ["", "A", "xyz"] {
            let mut changed = value.clone();
            changed[field] = json!(invalid);
            assert!(
                parse_value(&changed, MODEL.id).is_err(),
                "accepted invalid {field}"
            );
        }
        let mut missing = value.clone();
        missing.as_object_mut().unwrap().remove(field);
        let bytes = serde_json::to_vec(&missing).unwrap();
        assert!(parse_registration(&bytes, &hash(&bytes), &"0".repeat(64), MODEL.id).is_err());
    }
}

#[test]
fn requires_exact_ordered_two_profiles_and_two_unique_bounded_arm_ids() {
    let value = registration(&original_packet(MODEL.id), MODEL.id);
    assert!(parse_value(&value, MODEL.id).is_ok());
    for invalid in [
        json!([]),
        json!([PROFILES[0]]),
        json!([PROFILES[1], PROFILES[0]]),
        json!([PROFILES[0], PROFILES[0]]),
        json!([PROFILES[0], PROFILES[1], "extra"]),
        json!([PROFILES[0], "arbitrary"]),
    ] {
        let mut changed = value.clone();
        changed["profiles"] = invalid;
        assert!(parse_value(&changed, MODEL.id).is_err());
    }
    for invalid in [
        json!([]),
        json!(["one"]),
        json!(["same", "same"]),
        json!(["", "second"]),
        json!(["  ", "second"]),
        json!(["a".repeat(129), "second"]),
        json!(["first", "second", "third"]),
    ] {
        let mut changed = value.clone();
        changed["armIds"] = invalid;
        assert!(parse_value(&changed, MODEL.id).is_err());
    }
}

#[test]
fn rejects_version_treatment_budget_context_and_model_overrides() {
    let value = registration(&original_packet(MODEL.id), MODEL.id);
    assert!(parse_value(&value, MODEL.id).is_ok());
    for (field, invalid) in [
        ("version", json!(2)),
        ("treatment", json!("other")),
        ("outputTokens", json!(768)),
        ("outputTokens", json!(0)),
        ("contextTokens", json!(8192)),
        ("modelId", json!(GEMMA_CANDIDATE.id)),
        ("modelId", json!("qwen")),
    ] {
        let mut changed = value.clone();
        changed[field] = invalid;
        assert!(parse_value(&changed, MODEL.id).is_err(), "accepted {field}");
    }
    assert!(parse_value(&value, GEMMA_CANDIDATE.id).is_err());
    assert!(parse_value(&value, "unsupported").is_err());
}

#[test]
fn rejects_gold_authority_arbitrary_parameters_unknown_nested_and_duplicate_fields() {
    let value = registration(&original_packet(MODEL.id), MODEL.id);
    assert!(parse_value(&value, MODEL.id).is_ok());
    for field in [
        "gold",
        "priorOutput",
        "semanticAccepted",
        "nativeIoAuthenticated",
        "presencePenalty",
        "seed",
    ] {
        let mut changed = value.clone();
        changed[field] = json!(true);
        assert!(parse_value(&changed, MODEL.id).is_err());
    }
    for path in [["originalRuntime", "ignored"], ["executionRuntime", "gold"]] {
        let mut changed = value.clone();
        changed[path[0]][path[1]] = json!(true);
        assert!(parse_value(&changed, MODEL.id).is_err());
    }
    let mut changed = value.clone();
    changed["executionRuntime"]["runtime"]["sampler"] = json!({"presencePenalty":0});
    assert!(parse_value(&changed, MODEL.id).is_err());
    let bytes = serde_json::to_string(&value).unwrap();
    for marker in ["\"version\":1", "\"treatment\":\"presence-only\"", "\"decoderSourceSha256\":\"eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee\""] {
        let duplicated = bytes.replacen(marker, &format!("{marker},{marker}"), 1);
        assert_ne!(duplicated, bytes);
        assert!(parse_registration(duplicated.as_bytes(), &hash(duplicated.as_bytes()), value["originalPacketSha256"].as_str().unwrap(), MODEL.id).is_err());
    }
}

#[test]
fn preserves_all_original_packet_model_sampler_and_scope_checks() {
    let packet = original_packet(MODEL.id);
    assert!(read_values(&registration(&packet, MODEL.id), &packet, MODEL.id).is_ok());
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
        let mut changed = packet.clone();
        changed["model"][field] = if field == "bytes" {
            json!(1)
        } else {
            json!("changed")
        };
        assert!(
            read_values(&registration(&changed, MODEL.id), &changed, MODEL.id).is_err(),
            "accepted model {field}"
        );
    }
    for field in [
        "profile",
        "order",
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
        let mut changed = packet.clone();
        changed["sampler"][field] = if field == "order" {
            json!(["dist"])
        } else if field == "profile" {
            json!(PROFILES[1])
        } else if field == "frequencyPenalty" {
            json!(0.5)
        } else {
            json!(0)
        };
        assert!(
            read_values(&registration(&changed, MODEL.id), &changed, MODEL.id).is_err(),
            "accepted original sampler {field}"
        );
    }
    for (field, invalid) in [
        ("version", json!(2)),
        ("dataScope", json!("private-vault")),
        ("contextTokens", json!(2048)),
        ("originalOutputTokens", json!(1536)),
        ("originalPromptTokens", json!(0)),
        ("originalLoopStop", json!("eog")),
        ("originalSchema", json!("wikiClaimReviewV1")),
        ("gold", json!(true)),
    ] {
        let mut changed = packet.clone();
        changed[field] = invalid;
        assert!(
            read_values(&registration(&changed, MODEL.id), &changed, MODEL.id).is_err(),
            "accepted original {field}"
        );
    }
    for field in ["system", "user"] {
        let mut changed = packet.clone();
        changed[field] = json!(format!("{} ", changed[field].as_str().unwrap()));
        assert!(
            read_values(&registration(&changed, MODEL.id), &changed, MODEL.id).is_err(),
            "accepted changed {field}"
        );
    }
}

#[test]
fn reads_both_registered_files_once_and_rejects_empty_oversized_non_utf8_changed_files() {
    let directory = tempfile::tempdir().unwrap();
    let registration_path = directory.path().join("registration.json");
    let packet_path = directory.path().join("packet.json");
    let packet = original_packet(MODEL.id);
    let registration_bytes = serde_json::to_vec(&registration(&packet, MODEL.id)).unwrap();
    let packet_bytes = serde_json::to_vec(&packet).unwrap();
    let admit = || {
        read(
            &registration_path,
            &hash(&registration_bytes),
            &packet_path,
            &hash(&packet_bytes),
            MODEL.id,
        )
    };
    std::fs::write(&registration_path, &registration_bytes).unwrap();
    std::fs::write(&packet_path, &packet_bytes).unwrap();
    let (retained_registration, retained_packet) = admit().unwrap();
    for path in [&registration_path, &packet_path] {
        for invalid in [
            Vec::new(),
            vec![b' '; 256 * 1024 + 1],
            vec![0xff, 0xfe],
            b"changed".to_vec(),
        ] {
            std::fs::write(path, invalid).unwrap();
            assert!(admit().is_err());
        }
        std::fs::write(
            path,
            if path == &registration_path {
                &registration_bytes
            } else {
                &packet_bytes
            },
        )
        .unwrap();
        assert!(admit().is_ok());
    }
    assert_eq!(retained_registration.arm_ids.len(), 2);
    assert_eq!(retained_packet.user, packet["user"].as_str().unwrap());
}

#[cfg(unix)]
#[test]
fn rejects_symlinks_and_hardlink_aliases_for_each_registered_file() {
    let directory = tempfile::tempdir().unwrap();
    let registration_path = directory.path().join("registration.json");
    let packet_path = directory.path().join("packet.json");
    let packet = original_packet(MODEL.id);
    let registration_bytes = serde_json::to_vec(&registration(&packet, MODEL.id)).unwrap();
    let packet_bytes = serde_json::to_vec(&packet).unwrap();
    std::fs::write(&registration_path, &registration_bytes).unwrap();
    std::fs::write(&packet_path, &packet_bytes).unwrap();
    assert!(read(
        &registration_path,
        &hash(&registration_bytes),
        &packet_path,
        &hash(&packet_bytes),
        MODEL.id
    )
    .is_ok());
    for path in [&registration_path, &packet_path] {
        let symbolic = directory.path().join(if path == &registration_path {
            "registration-link"
        } else {
            "packet-link"
        });
        std::os::unix::fs::symlink(path, &symbolic).unwrap();
        let (r, p) = if path == &registration_path {
            (&symbolic, &packet_path)
        } else {
            (&registration_path, &symbolic)
        };
        assert!(read(
            r,
            &hash(&registration_bytes),
            p,
            &hash(&packet_bytes),
            MODEL.id
        )
        .is_err());
        let hard = directory.path().join(if path == &registration_path {
            "registration-hard"
        } else {
            "packet-hard"
        });
        std::fs::hard_link(path, &hard).unwrap();
        assert!(read(
            &registration_path,
            &hash(&registration_bytes),
            &packet_path,
            &hash(&packet_bytes),
            MODEL.id
        )
        .is_err());
        std::fs::remove_file(hard).unwrap();
    }
}

fn family_registration(packet: &Value, id: &str) -> Value {
    let mut value = registration(packet, id);
    value["treatment"] = json!("gemma-family-profile");
    value["profiles"] = json!(["existingGroundedV1", "gemmaInstructionFamilyQaV1"]);
    value["armIds"] = json!(["gemma-existing-1536", "gemma-family-1536"]);
    value
}

#[test]
fn admits_separate_gemma_family_registration() {
    let packet = original_packet(GEMMA_CANDIDATE.id);
    let value = family_registration(&packet, GEMMA_CANDIDATE.id);
    let parsed = parse_value(&value, GEMMA_CANDIDATE.id).unwrap();
    assert_eq!(parsed.treatment, "gemma-family-profile");
    assert_eq!(
        parsed.profiles,
        ["existingGroundedV1", "gemmaInstructionFamilyQaV1"]
    );
    assert_eq!(parsed.output_tokens, 1536);
    assert_eq!(parsed.context_tokens, 4096);
}

#[test]
fn family_trial_retains_original_message_bytes_and_historical_runtime() {
    let packet = original_packet(GEMMA_CANDIDATE.id);
    let value = family_registration(&packet, GEMMA_CANDIDATE.id);
    let (registered, retained) = read_values(&value, &packet, GEMMA_CANDIDATE.id).unwrap();
    assert_eq!(
        retained.system.as_bytes(),
        packet["system"].as_str().unwrap().as_bytes()
    );
    assert_eq!(
        retained.user.as_bytes(),
        packet["user"].as_str().unwrap().as_bytes()
    );
    assert_eq!(retained.runtime, registered.original_runtime);
    assert_eq!(retained.sampler, sampler());
    assert_eq!(retained.original_schema, "wikiClaimsV1");
}

#[test]
fn family_trial_rejects_cross_model_profiles_and_arbitrary_overrides() {
    let qwen = original_packet(MODEL.id);
    assert!(parse_value(&family_registration(&qwen, MODEL.id), MODEL.id).is_err());
    let packet = original_packet(GEMMA_CANDIDATE.id);
    let family = family_registration(&packet, GEMMA_CANDIDATE.id);
    let presence = registration(&packet, GEMMA_CANDIDATE.id);
    for (base, field, invalid) in [
        (&family, "profiles", json!(PROFILES)),
        (
            &family,
            "profiles",
            json!(["gemmaInstructionFamilyQaV1", "existingGroundedV1"]),
        ),
        (&presence, "profiles", family["profiles"].clone()),
        (&family, "temperature", json!(1.0)),
        (&family, "gold", json!(true)),
        (&family, "outputTokens", json!(768)),
        (&family, "contextTokens", json!(8192)),
    ] {
        let mut changed = base.clone();
        changed[field] = invalid;
        assert!(
            parse_value(&changed, GEMMA_CANDIDATE.id).is_err(),
            "accepted {field}"
        );
    }
}
