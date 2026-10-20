//! Actual cached vocabulary masking, not forward inference or meaning approval.

use super::*;
use crate::commands::DateRange;
use crate::local_synthesis::claim_prompt::{activity_system, payload};
use crate::retrieval::Scope;
use crate::vault_session::AgentVaultSession;
use crate::wiki_claims::compact_qa::PreparedCompactQa;
use crate::wiki_claims::{ActorRole, SourceDocument, SourceSet, SpanInput};
use llama_cpp_2::token::{data::LlamaTokenData, data_array::LlamaTokenDataArray, LlamaToken};
use serde_json::{json, Value};

const VERSION: &str = "WikiClaimsCompactQaV1";

fn origin() -> AgentVaultSession {
    AgentVaultSession {
        vault_path: "/synthetic/compact-vocabulary".into(),
        opening_token: "synthetic-compact-vocabulary-opening".into(),
    }
}

fn prepared() -> (SourceSet, PreparedCompactQa) {
    let originals = [
        (ActorRole::Assistant, "Implementation of the synthetic adapter has not been performed."),
        (ActorRole::User, "The maintainer repaired the synthetic adapter on 2026-10-01. I have not independently verified it."),
    ];
    let documents = originals
        .iter()
        .enumerate()
        .map(|(ordinal, (speaker, text))| {
            let path = format!("sessions/compact-vocabulary-{ordinal}.md");
            SourceDocument::bind(
                format!("S{ordinal}"),
                path.clone(),
                path,
                text,
                Some("2026-10-04T09:00:00Z".into()),
                vec![SpanInput {
                    id: format!("Q{ordinal}"),
                    start: 0,
                    end: text.len(),
                    turn_id: format!("T{ordinal}"),
                    speaker: *speaker,
                    turn_time: Some("2026-10-03T08:00:00Z".into()),
                }],
            )
            .unwrap()
        })
        .collect();
    let sources = SourceSet::new(origin(), Scope::All, documents, vec![]).unwrap();
    // Explicit synthetic helper period; this does not execute the local planner.
    let range = DateRange {
        start: "2026-10-01".into(),
        end: "2026-10-04".into(),
        start_epoch: crate::importers::parse_iso8601("2026-09-30T15:00:00Z"),
        end_epoch: crate::importers::parse_iso8601("2026-10-04T15:00:00Z"),
    };
    let spans = sources.spans().collect::<Vec<_>>();
    let user = payload(
        "Summarize only the supplied synthetic activities",
        "en",
        &range,
        &spans,
    )
    .unwrap();
    let packet = PreparedCompactQa::prepare(&activity_system(), &user).unwrap();
    (sources, packet)
}

fn claim() -> Value {
    json!([
        "Implementation of the synthetic adapter has not been performed.",
        0,
        [0],
        ["assistant", "speaker", null],
        [null, "unknown", "unknown", "unknown", null],
        "report",
        "unknown",
        null
    ])
}

fn output(packet: &PreparedCompactQa, outcome: &str, claims: &[Value]) -> String {
    // Struct serialization retains the sampler's exact outer field order.
    #[derive(serde::Serialize)]
    #[serde(rename_all = "camelCase")]
    struct Batch<'a> {
        version: &'static str,
        packet_sha256: String,
        outcome: &'a str,
        claims: &'a [Value],
    }
    serde_json::to_string(&Batch {
        version: VERSION,
        packet_sha256: packet.decoder().packet_sha256(),
        outcome,
        claims,
    })
    .unwrap()
}

fn assert_masking(
    model: &LlamaModel,
    ends: &[LlamaToken],
    grammar: &str,
    raw: &str,
    expected: bool,
) {
    let mut sampler = LlamaSampler::grammar(model, grammar, "root").unwrap();
    let allowed = |sampler: &mut LlamaSampler, token| {
        let mut choices =
            LlamaTokenDataArray::new(vec![LlamaTokenData::new(token, 0.0, 0.0)], false);
        sampler.apply(&mut choices);
        choices.data[0].logit().is_finite()
    };
    for token in model.str_to_token(raw, AddBos::Never).unwrap() {
        if !allowed(&mut sampler, token) {
            assert!(
                !expected,
                "unexpected compact output-token rejection: {raw}"
            );
            return;
        }
        sampler.accept(token);
    }
    // A grammar-accepted prefix is incomplete until every actual EOG token is
    // permitted. No manually invented end marker substitutes for vocabulary.
    for end in ends {
        assert_eq!(
            allowed(&mut sampler, *end),
            expected,
            "compact EOG {end:?} admission: {raw}"
        );
    }
}

fn assert_native_projection(sources: &SourceSet, packet: &PreparedCompactQa, raw: &str) {
    let expanded = packet.expand(raw).unwrap();
    let checked = sources.validate(&expanded, &origin(), Scope::All).unwrap();
    assert!(checked
        .claims
        .iter()
        .all(|claim| claim.structure_checked && claim.semantic_review_required));
}

fn assert_valid_outputs(
    model: &LlamaModel,
    ends: &[LlamaToken],
    sources: &SourceSet,
    packet: &PreparedCompactQa,
) {
    let grammar = packet.decoder().grammar();
    let base = claim();
    let mut unknown = base.clone();
    unknown[3] = json!(["unknown", "unknown", null]);
    let mut described_actor = base.clone();
    described_actor[0] = json!("The maintainer repaired the synthetic adapter");
    described_actor[1] = json!(1);
    described_actor[2] = json!([1]);
    described_actor[3] = json!(["source", "explicit_subject", 1]);
    described_actor[4] = json!(["2026-10-01", "explicit", "day", "specified", 1]);
    described_actor[6] = json!("reported_completed");
    let valid = [
        output(packet, "claims", &[base]),
        output(packet, "claims", &[unknown]),
        output(packet, "claims", &[described_actor]),
        output(packet, "insufficient_evidence", &[]),
    ];
    for raw in valid {
        assert_native_projection(sources, packet, &raw);
        assert_masking(model, ends, &grammar, &raw, true);
        let claims_start = raw.find("\"claims\":[").unwrap() + "\"claims\":[".len();
        for prefix in [raw.strip_suffix('}').unwrap(), &raw[..claims_start]] {
            assert!(packet.expand(prefix).is_err());
            assert_masking(model, ends, &grammar, prefix, false);
        }
    }
}

fn assert_invalid_outputs(model: &LlamaModel, ends: &[LlamaToken], packet: &PreparedCompactQa) {
    let grammar = packet.decoder().grammar();
    let base = claim();
    let valid = output(packet, "claims", std::slice::from_ref(&base));
    let mut malformed = vec![
        valid.replace(VERSION, "WikiClaimsV1"),
        valid.replace(&packet.decoder().packet_sha256(), &"0".repeat(64)),
        valid.replace(
            &packet.decoder().packet_sha256(),
            &packet.decoder().packet_sha256()[..32],
        ),
        valid.replace("\"outcome\":\"claims\"", "\"outcome\":\"unknown\""),
        valid.replace(
            "\"outcome\":\"claims\"",
            "\"outcome\":\"insufficient_evidence\"",
        ),
        output(packet, "claims", &[]),
    ];
    for slot in [vec![], vec![3], vec![4]] {
        for extra in [false, true] {
            let mut changed = base.clone();
            let mut tuple = &mut changed;
            for index in &slot {
                tuple = &mut tuple[*index];
            }
            let fields = tuple.as_array_mut().unwrap();
            if extra {
                fields.push(Value::Null);
            } else {
                fields.pop();
            }
            malformed.push(output(packet, "claims", &[changed]));
        }
    }
    for ordinal in [json!(-1), json!(0.5), json!("0"), json!(2)] {
        for reference in 0..4 {
            let mut changed = base.clone();
            match reference {
                0 => changed[1] = ordinal.clone(),
                1 => changed[2][0] = ordinal.clone(),
                2 => changed[3] = json!(["source", "explicit_subject", ordinal.clone()]),
                _ => {
                    changed[4] = json!([
                        "2026-10-01",
                        "explicit",
                        "day",
                        "specified",
                        ordinal.clone()
                    ])
                }
            }
            malformed.push(output(packet, "claims", &[changed]));
        }
    }
    for status in ["verified_completed", "verified_failed"] {
        let mut changed = base.clone();
        changed[5] = json!("verification");
        changed[6] = json!(status);
        malformed.push(output(packet, "claims", &[changed]));
    }
    for (slot, value) in [
        (7, json!("invented_receipt")),
        (3, json!(["assistant", "unknown", null])),
        (4, json!(["2026-10-01", "unknown", "day", "specified", 0])),
        (6, json!("planned")),
    ] {
        let mut changed = base.clone();
        changed[slot] = value;
        malformed.push(output(packet, "claims", &[changed]));
    }
    for raw in malformed {
        assert!(
            packet.expand(&raw).is_err(),
            "compact projection unexpectedly accepted: {raw}"
        );
        assert_masking(model, ends, &grammar, &raw, false);
    }
}

fn assert_nonsemantic_boundaries(
    model: &LlamaModel,
    ends: &[LlamaToken],
    sources: &SourceSet,
    packet: &PreparedCompactQa,
) {
    let grammar = packet.decoder().grammar();
    let mut wrong_speaker = claim();
    wrong_speaker[3] = json!(["user", "speaker", null]);
    let raw = output(packet, "claims", &[wrong_speaker]);
    assert_masking(model, ends, &grammar, &raw, true);
    let expanded = packet.expand(&raw).unwrap();
    assert!(sources.validate(&expanded, &origin(), Scope::All).is_err());
    // Uniqueness is checked by exact projection, not a regular grammar. No
    // grammar acceptance or pure native shape check grants semantic approval.
    let mut duplicate_support = claim();
    duplicate_support[2] = json!([0, 0]);
    let raw = output(packet, "claims", &[duplicate_support]);
    assert_masking(model, ends, &grammar, &raw, true);
    assert!(packet.expand(&raw).is_err());
}

#[test]
#[ignore = "requires verified MYCO_CHAT_MODEL_PATH; cached vocabulary masking only, no forward inference"]
fn compact_claims_vocabulary_enforces_packet_binding_tuple_fields_and_eog() {
    let path = PathBuf::from(
        std::env::var_os("MYCO_CHAT_MODEL_PATH").expect("MYCO_CHAT_MODEL_PATH is required"),
    );
    assert!(
        path.is_absolute(),
        "explicit cached GGUF path must be absolute"
    );
    let verified = crate::local_model::resolve_verified_artifact(
        path.parent().unwrap(),
        &crate::local_model::MODEL,
    )
    .unwrap();
    assert_eq!(
        verified.canonicalize().unwrap(),
        path.canonicalize().unwrap()
    );
    let mut host = LocalLlm::load_embed_host().unwrap();
    host.ensure_chat_model(&verified).unwrap();
    let model = host.chat_model().unwrap();
    let ends = (0..model.n_vocab())
        .map(LlamaToken::new)
        .filter(|token| model.is_eog_token(*token))
        .collect::<Vec<_>>();
    assert!(!ends.is_empty());
    let (sources, packet) = prepared();
    assert_eq!(packet.decoder().span_count(), 2);
    assert!(grounded_sampler(
        model,
        GenerationSchema::WikiClaimsCompactQaV1(packet.decoder())
    )
    .is_ok());
    assert_valid_outputs(model, &ends, &sources, &packet);
    assert_invalid_outputs(model, &ends, &packet);
    assert_nonsemantic_boundaries(model, &ends, &sources, &packet);
    // No LlamaContext, prefill, forward decode, generation API or judge is used.
    drop(host);
}
