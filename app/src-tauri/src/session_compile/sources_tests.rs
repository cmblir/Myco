//! Source-budget regressions. Estimated-token hooks test the boundary only;
//! the ignored cached-model test uses the actual tokenizer without generation.

use super::*;

fn fixture(body: &str) -> (String, SourceBinding, AgentVaultSession) {
    let original = format!(
        "---\nsource: codex\nconversation_id: packet-budget-synthetic\ncreated: 2026-10-01\n---\n**User:**\n{body}\n"
    );
    let source = SourceBinding {
        key: "codex:packet-budget-synthetic".into(),
        raw_path: "raw/conversations/codex/packet-budget-synthetic.md".into(),
        source_revision: source_revision(&original),
    };
    let origin = AgentVaultSession {
        vault_path: "/synthetic/packet-budget".into(),
        opening_token: "packet-budget-opening".into(),
    };
    (original, source, origin)
}

#[test]
fn full_prompt_above_old_source_cap_still_fits_actual_decode_reserve() {
    let (original, source, origin) = fixture("Please prepare the synthetic exhibit.");
    let plan = prepare(&source, &original, &origin, "en", |system, user| {
        assert_eq!(
            system,
            crate::local_synthesis::claim_prompt::extraction_reading_system()
        );
        assert!(user.contains("originalSpans"));
        // A synthetic full-template estimate, not an actual tokenizer result.
        Ok(2200)
    })
    .unwrap();
    assert_eq!(plan.windows.len(), 1);
    assert_eq!(
        plan.eligible_bytes,
        "Please prepare the synthetic exhibit.\n".len()
    );
}

#[test]
fn source_plan_accepts_exact_context_reserve_and_rejects_one_token_over() {
    let (original, source, origin) = fixture("x");
    assert!(prepare(&source, &original, &origin, "en", |_, _| Ok(3320)).is_ok());
    let error = prepare(&source, &original, &origin, "en", |_, _| Ok(3321)).unwrap_err();
    assert_eq!(
        error,
        "compiler source metadata cannot fit selected model context"
    );
}

#[test]
fn instruction_overhead_windows_preserve_every_original_utf8_byte() {
    let body = "가🙂 synthetic activity; later cancellation remains. ".repeat(100);
    let (original, source, origin) = fixture(&body);
    let count = |_: &str, user: &str| -> Result<usize, String> {
        let payload: serde_json::Value = serde_json::from_str(user).unwrap();
        let text = payload["originalSpans"][0]["text"].as_str().unwrap();
        Ok(2100 + text.chars().count())
    };
    let plan = prepare(&source, &original, &origin, "ko", count).unwrap();
    assert!(plan.windows.len() > 1);
    let verified = CompilationOriginal::verify(&original, &source.source_revision).unwrap();
    let mut combined = String::new();
    let mut end = None;
    for (index, window) in plan.windows.iter().enumerate() {
        if let Some(previous) = end {
            assert_eq!(window.start, previous);
        }
        end = Some(window.end);
        let packet = plan.packet(index, &verified, &origin).unwrap();
        let user = extraction_payload(&plan, &packet, "ko").unwrap();
        assert!(count("", &user).unwrap() + 768 + 8 <= 4096);
        combined.push_str(packet.spans().next().unwrap().text());
    }
    assert_eq!(combined, format!("{body}\n"));
    assert_eq!(plan.eligible_bytes, combined.len());
    assert_eq!(end, Some(original.len()));
}

#[test]
fn tokenizer_failure_stays_an_error_without_a_source_plan() {
    let (original, source, origin) = fixture("Synthetic work.");
    let error = prepare(&source, &original, &origin, "en", |_, _| {
        Err("synthetic tokenizer unavailable".into())
    })
    .unwrap_err();
    assert_eq!(error, "synthetic tokenizer unavailable");
}

#[test]
fn source_reading_named_packet_preserves_all_fourteen_original_values_and_counted_bytes() {
    let body = "Please prepare the synthetic exhibit.\r\n내일의 계획은 아직 검증하지 않았습니다. 🙂 \"sourceContext\": {\"text\": \"quoted only\"}";
    let (original, source, origin) = fixture(body);
    let mut counted = Vec::new();
    let plan = prepare(&source, &original, &origin, "ko", |system, user| {
        assert_eq!(
            system,
            crate::local_synthesis::claim_prompt::extraction_reading_system()
        );
        counted.push((system.to_string(), user.to_string()));
        // Fixed full-template counts exercise custody, not tokenizer quality.
        Ok(800)
    })
    .unwrap();
    assert_eq!(plan.windows.len(), 1);
    let verified = CompilationOriginal::verify(&original, &source.source_revision).unwrap();
    let packet = plan.packet(0, &verified, &origin).unwrap();
    let user = extraction_payload(&plan, &packet, "ko").unwrap();
    let payload: serde_json::Value = serde_json::from_str(&user).unwrap();
    let original_span = packet.spans().next().unwrap();
    let native = serde_json::to_value(original_span).unwrap();
    assert_eq!(native.as_object().unwrap().len(), 14);
    assert_eq!(original_span.text(), format!("{body}\n"));
    let model = &payload["originalSpans"][0];
    assert!(model["sourceContext"].is_object());
    assert!(model["provenance"].is_object());
    assert_eq!(model.as_object().unwrap().len(), 5);
    assert_eq!(model["sourceContext"].as_object().unwrap().len(), 4);
    assert_eq!(model["provenance"].as_object().unwrap().len(), 7);

    // Independently flatten the model view against the native flat SourceSpan.
    let mut flattened = serde_json::Map::new();
    for key in ["id", "speaker", "text"] {
        assert!(flattened.insert(key.into(), model[key].clone()).is_none());
    }
    for group in ["sourceContext", "provenance"] {
        for (key, value) in model[group].as_object().unwrap() {
            assert!(flattened.insert(key.clone(), value.clone()).is_none());
        }
    }
    assert_eq!(serde_json::Value::Object(flattened), native);
    let encode = |key: &str| serde_json::to_string(&native[key]).unwrap();
    let context = ["turnId", "turnTime", "sourcePhase", "recordTime"]
        .iter()
        .map(|key| format!("\"{key}\":{}", encode(key)))
        .collect::<Vec<_>>()
        .join(",");
    let provenance = [
        "sourceId",
        "sourcePath",
        "selectionPath",
        "sourceRevision",
        "start",
        "end",
        "sha256",
    ]
    .iter()
    .map(|key| format!("\"{key}\":{}", encode(key)))
    .collect::<Vec<_>>()
    .join(",");
    let expected_row = format!(
        "{{\"id\":{},\"speaker\":{},\"text\":{},\"sourceContext\":{{{context}}},\"provenance\":{{{provenance}}}}}",
        encode("id"), encode("speaker"), encode("text")
    );
    assert_eq!(
        user.matches(&format!("\"originalSpans\":[{expected_row}]"))
            .count(),
        1
    );
    assert_eq!(counted.last().unwrap().1, user);
    assert_eq!(
        counted.last().unwrap().0,
        crate::local_synthesis::claim_prompt::extraction_reading_system()
    );
}

#[test]
#[ignore = "requires an existing pinned model via MYCO_SESSION_PACKET_MODEL_ID and MYCO_SESSION_PACKET_MODEL_DIR; no inference"]
fn cached_local_tokenizer_can_prepare_complete_native_session_packets() {
    let id = std::env::var("MYCO_SESSION_PACKET_MODEL_ID").expect("model ID is required");
    let dir =
        std::env::var_os("MYCO_SESSION_PACKET_MODEL_DIR").expect("model directory is required");
    let manifest = crate::local_model::manifest_for(Some(&id)).unwrap();
    let path = crate::local_model::resolve_verified_artifact(std::path::Path::new(&dir), manifest)
        .expect("existing model must match the pinned manifest");
    let mut host = crate::local_llm::LocalLlm::load_embed_host().unwrap();
    host.ensure_chat_model(&path).unwrap();
    for (lang, body) in [
        ("en", "Please prepare the synthetic exhibit.".to_string()),
        (
            "ko",
            "가상의 전시 준비를 취소했습니다. 새 작업은 아직 하지 않았습니다.".to_string(),
        ),
        (
            "ko",
            "가상 원문을 보존합니다. ".repeat(300) + "마지막에 가상의 작업을 철회했습니다.",
        ),
    ] {
        let (original, source, origin) = fixture(&body);
        let mut observed = Vec::new();
        let result = prepare(&source, &original, &origin, lang, |system, user| {
            let tokens = host.chat_token_count(system, user)?;
            observed.push(tokens);
            Ok(tokens)
        });
        println!(
            "{}",
            serde_json::json!({"phase":"session_packet_tokenizer_prepare",
            "model":manifest,"language":lang,"sourceRevision":source.source_revision,
            "sourceBytes":original.len(),"candidatePromptTokens":observed,
            "systemSha256":source_revision(&crate::local_synthesis::claim_prompt::extraction_reading_system()),
            "error":result.as_ref().err(),"modelInference":false,"semanticAccepted":false})
        );
        let plan = result.expect("complete native source packet must fit the actual tokenizer");
        let verified = CompilationOriginal::verify(&original, &source.source_revision).unwrap();
        let mut combined = String::new();
        for (index, _) in plan.windows.iter().enumerate() {
            let packet = plan.packet(index, &verified, &origin).unwrap();
            let user = extraction_payload(&plan, &packet, lang).unwrap();
            let tokens = host
                .chat_token_count(
                    &crate::local_synthesis::claim_prompt::extraction_reading_system(),
                    &user,
                )
                .unwrap();
            assert!(tokens + 768 + 8 <= 4096);
            combined.push_str(packet.spans().next().unwrap().text());
            println!(
                "{}",
                serde_json::json!({"phase":"session_packet_tokenizer_fit",
                "modelId":id,"language":lang,"packetIndex":index,"packets":plan.windows.len(),
                "promptTokens":tokens,"outputTokens":768,"contextTokens":4096,"reserveTokens":8,
                "systemSha256":source_revision(&crate::local_synthesis::claim_prompt::extraction_reading_system()),
                "userSha256":source_revision(&user),"planRevision":plan.revision,
                "modelInference":false,"semanticAccepted":false})
            );
        }
        assert_eq!(combined, format!("{body}\n"));
        assert_eq!(plan.eligible_bytes, combined.len());
    }
    drop(host);
}

#[test]
fn codex_provider_prefix_and_all_later_turn_bytes_reach_actual_compiler_payloads() {
    let raw = crate::importers::codex::provenance_test_rollout();
    let conversation = crate::importers::codex::parse(&raw, "fallback").unwrap();
    let original = conversation.to_inbox_doc();
    let source = SourceBinding {
        key: "codex:synthetic-provenance-session".into(),
        raw_path: "raw/conversations/codex/synthetic-provenance.md".into(),
        source_revision: source_revision(&original),
    };
    let origin = AgentVaultSession {
        vault_path: "/synthetic/provenance-compiler".into(),
        opening_token: "synthetic-opening".into(),
    };
    let plan = prepare(&source, &original, &origin, "en", |_, _| Ok(1000)).unwrap();
    assert_eq!(plan.windows.len(), 4);
    let first =
        crate::activity_recall::compilation_original_turns(&original).unwrap()[0].header_start;
    let body = source_body(&original).unwrap().0;
    let prefix = &original[body..first];
    let verified = CompilationOriginal::verify(&original, &source.source_revision).unwrap();
    let mut prefix_count = 0;
    for (index, window) in plan.windows.iter().enumerate() {
        let packet = plan.packet(index, &verified, &origin).unwrap();
        let user = extraction_payload(&plan, &packet, "en").unwrap();
        let payload: serde_json::Value = serde_json::from_str(&user).unwrap();
        let row = &payload["originalSpans"][0];
        assert_eq!(row["text"], &original[window.start..window.end]);
        assert_eq!(row["provenance"]["sourceRevision"], source.source_revision);
        assert_eq!(row["provenance"]["start"], window.start);
        assert_eq!(row["provenance"]["end"], window.end);
        if window.turn_id == "T-preamble" {
            prefix_count += 1;
            assert_eq!(row["text"], prefix);
            assert_eq!(row["speaker"], "unknown");
            assert_eq!(row["sourceContext"]["turnTime"], serde_json::Value::Null);
        } else {
            let turn = &conversation.turns[index - 1];
            assert_eq!(row["text"].as_str().unwrap().trim(), turn.text);
            assert_eq!(
                row["sourceContext"]["turnTime"],
                serde_json::json!(turn.metadata.timestamp)
            );
        }
    }
    assert_eq!(prefix_count, 1);
    assert!(original.contains("Later tail: the synthetic deployment was cancelled"));
}
