//! Cached-vocabulary grammar admission; no context or forward inference is used.

use super::*;
use crate::commands::DateRange;
use crate::local_synthesis::claim_prompt::payload;
use crate::retrieval::Scope;
use crate::vault_session::AgentVaultSession;
use crate::wiki_claims::focus_claims_qa::{Encoding, PreparedFocusQa};
use crate::wiki_claims::{ActorRole, SourceDocument, SourceSet, SpanInput};
use llama_cpp_2::token::{data::LlamaTokenData, data_array::LlamaTokenDataArray, LlamaToken};
use serde_json::{json, Value};
use std::time::Instant;

#[path = "source_focus_token_costs_qa.rs"]
mod token_costs;

const VERSION: &str = "WikiSourceFocusClaimsQaV1";
const FOCUS: &str = "I have not verified it.";
const TEXT: &str =
    "The maintainer repaired the synthetic adapter on 2026-10-01. I have not verified it.";
const SPEAKERS: [ActorRole; 8] = [
    ActorRole::User,
    ActorRole::Assistant,
    ActorRole::System,
    ActorRole::Tool,
    ActorRole::Source,
    ActorRole::Unknown,
    ActorRole::User,
    ActorRole::Assistant,
];

// QA vocabulary selection never selects an application role or grants authority.
fn vocabulary_manifest(
    id: Option<&str>,
) -> Result<&'static crate::local_model::ModelManifest, String> {
    use crate::local_model::{GEMMA_CANDIDATE, MODEL, QWEN9B_CANDIDATE};
    match id {
        None => Ok(&MODEL),
        Some(id) if id == MODEL.id => Ok(&MODEL),
        Some(id) if id == GEMMA_CANDIDATE.id => Ok(&GEMMA_CANDIDATE),
        Some(id) if id == QWEN9B_CANDIDATE.id => Ok(&QWEN9B_CANDIDATE),
        _ => Err("unsupported source focus QA grammar model ID".into()),
    }
}

#[test]
fn vocabulary_manifest_defaults_to_qwen_and_accepts_only_exact_pinned_models() {
    use crate::local_model::{GEMMA_CANDIDATE, MODEL, QWEN9B_CANDIDATE};
    for (id, expected) in [
        (None, &MODEL),
        (Some(MODEL.id), &MODEL),
        (Some(GEMMA_CANDIDATE.id), &GEMMA_CANDIDATE),
        (Some(QWEN9B_CANDIDATE.id), &QWEN9B_CANDIDATE),
    ] {
        let selected = vocabulary_manifest(id).unwrap();
        assert_eq!(selected.id, expected.id);
        assert_eq!(selected.file, expected.file);
        assert_eq!(selected.revision, expected.revision);
        assert_eq!(selected.sha256, expected.sha256);
    }
}

#[test]
fn vocabulary_manifest_rejects_empty_unknown_alias_and_modified_ids() {
    for id in [
        "",
        "unknown",
        "gemma",
        "qwen3.5-2b-q4_k_m",
        " qwen3.5-4b-q4_k_m",
        "gemma-4-e4b-it-qat-q4_0\n",
        "qwen9b",
        "Qwen3.5-9B-Q4_K_M.gguf",
        "qwen3.5-9b-q4_k_m ",
    ] {
        assert!(vocabulary_manifest(Some(id)).is_err());
    }
}

fn origin() -> AgentVaultSession {
    AgentVaultSession {
        vault_path: "/synthetic/source-focus-vocabulary".into(),
        opening_token: "source-focus-vocabulary-opening".into(),
    }
}

fn prepared(count: usize, encoding: Encoding) -> (SourceSet, PreparedFocusQa) {
    let documents = SPEAKERS[..count]
        .iter()
        .enumerate()
        .map(|(ordinal, speaker)| {
            let path = format!("sessions/source-focus-{ordinal}.md");
            SourceDocument::bind(
                format!("S{ordinal}"),
                path.clone(),
                path,
                TEXT,
                Some("2026-10-04T09:00:00Z".into()),
                vec![SpanInput {
                    id: format!("Q{ordinal}"),
                    start: 0,
                    end: TEXT.len(),
                    turn_id: format!("T{ordinal}"),
                    speaker: *speaker,
                    turn_time: Some("2026-10-03T08:00:00Z".into()),
                }],
            )
            .unwrap()
        })
        .collect();
    let sources = SourceSet::new(origin(), Scope::All, documents, vec![]).unwrap();
    let range = DateRange {
        start: "2026-10-01".into(),
        end: "2026-10-04".into(),
        start_epoch: crate::importers::parse_iso8601("2026-09-30T15:00:00Z"),
        end_epoch: crate::importers::parse_iso8601("2026-10-04T15:00:00Z"),
    };
    let spans = sources.spans().collect::<Vec<_>>();
    let user = payload(
        "Interpret the complete supplied synthetic originals",
        "en",
        &range,
        &spans,
    )
    .unwrap();
    let packet = PreparedFocusQa::prepare_for(&user, encoding).unwrap();
    (sources, packet)
}

fn claim(anchor: usize, supports: &[usize]) -> Value {
    json!([
        anchor,
        FOCUS,
        "record_or_verification_limit",
        supports,
        [SPEAKERS[anchor], "speaker", null],
        [null, "unknown", "unknown", "unknown", null],
        "report",
        "unknown",
        null
    ])
}

fn vocabulary_encoding(id: Option<&str>) -> Result<Encoding, &'static str> {
    match id {
        None | Some("tuple") => Ok(Encoding::TupleV1),
        Some("named") => Ok(Encoding::NamedV1),
        _ => Err("unsupported source focus QA vocabulary encoding"),
    }
}

#[test]
fn vocabulary_encoding_keeps_tuple_default_and_requires_exact_named_selection() {
    assert_eq!(vocabulary_encoding(None), Ok(Encoding::TupleV1));
    assert_eq!(vocabulary_encoding(Some("tuple")), Ok(Encoding::TupleV1));
    assert_eq!(vocabulary_encoding(Some("named")), Ok(Encoding::NamedV1));
    for invalid in ["", "Named", "named ", "automatic", "unknown"] {
        assert!(vocabulary_encoding(Some(invalid)).is_err());
    }
}

// Keep field order for the real grammar. Missing/extra tuple fields stay
// missing/extra named keys so negative controls are never repaired.
fn named_fields(value: &Value, keys: &[&str]) -> String {
    let fields = value.as_array().expect("synthetic tuple control");
    let entries = fields
        .iter()
        .enumerate()
        .map(|(index, value)| {
            let extra = format!("extraField{index}");
            let key = keys.get(index).copied().unwrap_or(&extra);
            let raw = match key {
                "actor" => named_fields(value, &["role", "basis", "subjectOrdinal"]),
                "eventTime" => named_fields(
                    value,
                    &[
                        "value",
                        "basis",
                        "precision",
                        "uncertainty",
                        "timeSupportOrdinal",
                    ],
                ),
                _ => value.to_string(),
            };
            format!("{}:{raw}", json!(key))
        })
        .collect::<Vec<_>>();
    format!("{{{}}}", entries.join(","))
}

fn output(packet: &PreparedFocusQa, outcome: &str, claims: &[Value]) -> String {
    if packet.encoding() == Encoding::NamedV1 {
        let keys = [
            "anchorOrdinal",
            "focusQuote",
            "assertionKind",
            "supportOrdinals",
            "actor",
            "eventTime",
            "speechAct",
            "status",
            "verificationId",
        ];
        let raw = claims
            .iter()
            .map(|claim| named_fields(claim, &keys))
            .collect::<Vec<_>>()
            .join(",");
        return format!(
            "{{\"version\":{},\"packetSha256\":{},\"outcome\":{},\"claims\":[{raw}]}}",
            json!(packet.decoder().wire_version()),
            json!(packet.decoder().packet_sha256()),
            json!(outcome)
        );
    }

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

#[derive(Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct MaskMetrics {
    checks: usize,
    expected_accepted: usize,
    expected_rejected: usize,
    tested_output_tokens: usize,
    candidate_mask_calls: usize,
    tokenization_micros: u128,
    candidate_mask_micros: u128,
    token_accept_micros: u128,
    reset_micros: u128,
}

struct Probe<'a> {
    model: &'a LlamaModel,
    ends: &'a [LlamaToken],
    sampler: LlamaSampler,
    metrics: MaskMetrics,
}

impl<'a> Probe<'a> {
    fn check(&mut self, raw: &str, expected: bool, label: &str) {
        let started = Instant::now();
        self.sampler.reset();
        self.metrics.reset_micros += started.elapsed().as_micros();
        let started = Instant::now();
        let tokens = self.model.str_to_token(raw, AddBos::Never).unwrap();
        self.metrics.tokenization_micros += started.elapsed().as_micros();
        let mut permitted = true;
        for token in tokens {
            self.metrics.tested_output_tokens += 1;
            if !self.allowed(token) {
                permitted = false;
                break;
            }
            let started = Instant::now();
            self.sampler.accept(token);
            self.metrics.token_accept_micros += started.elapsed().as_micros();
        }
        if permitted {
            let ends = self.ends;
            for end in ends {
                let allowed = self.allowed(*end);
                assert_eq!(allowed, expected, "actual EOG admission: {label}");
            }
        } else {
            assert!(!expected, "unexpected output-token rejection: {label}");
        }
        self.metrics.checks += 1;
        if expected {
            self.metrics.expected_accepted += 1;
        } else {
            self.metrics.expected_rejected += 1;
        }
    }

    fn allowed(&mut self, token: LlamaToken) -> bool {
        let mut choices =
            LlamaTokenDataArray::new(vec![LlamaTokenData::new(token, 0.0, 0.0)], false);
        let started = Instant::now();
        self.sampler.apply(&mut choices);
        self.metrics.candidate_mask_micros += started.elapsed().as_micros();
        self.metrics.candidate_mask_calls += 1;
        choices.data[0].logit().is_finite()
    }
}

fn speaker_alternatives(
    probe: &mut Probe<'_>,
    packet: &PreparedFocusQa,
    anchor: usize,
    supports: &[usize],
) {
    let base = claim(anchor, supports);
    for role in &SPEAKERS[..6] {
        let mut candidate = base.clone();
        candidate[4] = json!([role, "speaker", null]);
        probe.check(
            &output(packet, "claims", &[candidate]),
            *role == SPEAKERS[anchor],
            "exact anchor speaker",
        );
    }
    let mut unknown = base.clone();
    unknown[4] = json!(["unknown", "unknown", null]);
    probe.check(
        &output(packet, "claims", &[unknown]),
        true,
        "unknown actor remains an alternative",
    );
    for role in &SPEAKERS[..5] {
        let mut described = base.clone();
        described[4] = json!([role, "explicit_subject", anchor]);
        probe.check(
            &output(packet, "claims", &[described]),
            true,
            "described known actor remains an alternative",
        );
    }
}

fn support_sequences(count: usize, prefix: &mut Vec<usize>, sequences: &mut Vec<Vec<usize>>) {
    if !prefix.is_empty() {
        sequences.push(prefix.clone());
    }
    for ordinal in 0..count {
        if prefix.contains(&ordinal) {
            continue;
        }
        prefix.push(ordinal);
        support_sequences(count, prefix, sequences);
        prefix.pop();
    }
}

fn every_support_order(probe: &mut Probe<'_>, packet: &PreparedFocusQa, count: usize) {
    let mut sequences = Vec::new();
    support_sequences(count, &mut Vec::new(), &mut sequences);
    assert_eq!(sequences.len(), if count == 2 { 4 } else { 15 });
    for anchor in 0..count {
        for supports in &sequences {
            let base = claim(anchor, supports);
            probe.check(
                &output(packet, "claims", std::slice::from_ref(&base)),
                supports.contains(&anchor),
                "every unique support sequence/anchor",
            );
            if !supports.contains(&anchor) {
                continue;
            }
            let mut duplicate = base.clone();
            let mut repeated = supports.clone();
            repeated.push(supports[0]);
            duplicate[3] = json!(repeated);
            probe.check(
                &output(packet, "claims", &[duplicate]),
                false,
                "duplicate support",
            );
            for ordinal in 0..count {
                let mut subject = base.clone();
                subject[4] = json!(["source", "explicit_subject", ordinal]);
                probe.check(
                    &output(packet, "claims", &[subject]),
                    supports.contains(&ordinal),
                    "subject membership in exact selected supports",
                );
                let mut time = base.clone();
                time[5] = json!(["2026-10-01", "explicit", "day", "specified", ordinal]);
                probe.check(
                    &output(packet, "claims", &[time]),
                    supports.contains(&ordinal),
                    "time membership in exact selected supports",
                );
            }
        }
    }
}

fn kind_status_matrix(probe: &mut Probe<'_>, packet: &PreparedFocusQa) {
    let kinds = [
        "asserted_occurrence",
        "explicit_nonoccurrence",
        "record_or_verification_limit",
        "intention",
        "uncertain",
    ];
    let acts = [
        "unknown",
        "question",
        "request",
        "plan",
        "report",
        "verification",
        "retraction",
    ];
    let statuses = [
        "unknown",
        "requested",
        "planned",
        "in_progress",
        "reported_completed",
        "reported_failed",
        "reported_cancelled",
        "reported_rolled_back",
        "retracted",
        "verified_completed",
        "verified_failed",
    ];
    for kind in kinds {
        for act in acts {
            for status in statuses {
                let expected = match kind {
                    "explicit_nonoccurrence" | "record_or_verification_limit" => {
                        act == "report" && status == "unknown"
                    }
                    "intention" => {
                        (act == "request" && ["requested", "unknown"].contains(&status))
                            || (act == "plan" && ["planned", "unknown"].contains(&status))
                    }
                    "uncertain" => ["unknown", "question"].contains(&act) && status == "unknown",
                    "asserted_occurrence" => {
                        (act == "report"
                            && [
                                "unknown",
                                "in_progress",
                                "reported_completed",
                                "reported_failed",
                                "reported_cancelled",
                                "reported_rolled_back",
                            ]
                            .contains(&status))
                            || (act == "retraction"
                                && [
                                    "unknown",
                                    "retracted",
                                    "reported_cancelled",
                                    "reported_rolled_back",
                                ]
                                .contains(&status))
                    }
                    _ => unreachable!(),
                };
                let mut candidate = claim(0, &[0]);
                candidate[2] = json!(kind);
                candidate[6] = json!(act);
                candidate[7] = json!(status);
                probe.check(
                    &output(packet, "claims", &[candidate]),
                    expected,
                    "assertion-kind speech/status matrix",
                );
            }
        }
    }
}

fn packet_and_tuple_boundaries(probe: &mut Probe<'_>, packet: &PreparedFocusQa) {
    let base = claim(0, &[0]);
    let valid = output(packet, "claims", std::slice::from_ref(&base));
    for raw in [
        valid.replace(packet.decoder().wire_version(), "WikiClaimsV1"),
        valid.replace(&packet.decoder().packet_sha256(), &"0".repeat(64)),
        valid.replace(
            &packet.decoder().packet_sha256(),
            &packet.decoder().packet_sha256()[..32],
        ),
        output(packet, "claims", &[]),
        output(packet, "insufficient_evidence", std::slice::from_ref(&base)),
    ] {
        probe.check(&raw, false, "whole packet/version/outcome binding");
    }
    for raw in [
        &valid[..valid.len() - 1],
        &valid[..valid.find("\"claims\":[").unwrap() + 10],
    ] {
        probe.check(raw, false, "EOF cannot admit any actual EOG");
    }
    for slot in [None, Some(4), Some(5)] {
        for extra in [false, true] {
            let mut changed = base.clone();
            let tuple = match slot {
                None => &mut changed,
                Some(index) => &mut changed[index],
            };
            let fields = tuple.as_array_mut().unwrap();
            if extra {
                fields.push(Value::Null);
            } else {
                fields.pop();
            }
            probe.check(
                &output(packet, "claims", &[changed]),
                false,
                "exact nine/actor/time tuple cardinality",
            );
        }
    }
    for (focus, expected) in [
        (String::new(), false),
        ("q".repeat(512), true),
        ("q".repeat(513), false),
    ] {
        let mut changed = base.clone();
        changed[1] = json!(focus);
        probe.check(
            &output(packet, "claims", &[changed]),
            expected,
            "bounded focus syntax is not a source-quote receipt",
        );
    }
    for invalid in [json!(-1), json!(0.5), json!("0"), json!(2)] {
        for slot in 0..4 {
            let mut changed = base.clone();
            match slot {
                0 => changed[0] = invalid.clone(),
                1 => changed[3][0] = invalid.clone(),
                2 => changed[4] = json!(["source", "explicit_subject", invalid.clone()]),
                _ => {
                    changed[5] = json!([
                        "2026-10-01",
                        "explicit",
                        "day",
                        "specified",
                        invalid.clone()
                    ])
                }
            }
            probe.check(
                &output(packet, "claims", &[changed]),
                false,
                "closed integer ordinal dictionary",
            );
        }
    }
    for time in [
        json!(["2026-10-01", "explicit", "day", "specified", 0]),
        json!([
            "2026-10-03T08:00:00Z",
            "inferred_from_turn",
            "instant",
            "inferred",
            0
        ]),
        json!(["2026-10-03", "inferred_from_turn", "day", "inferred", 0]),
        json!(["2026-10-01", "date_reference", "day", "inferred", 0]),
    ] {
        let mut changed = base.clone();
        changed[5] = time;
        probe.check(
            &output(packet, "claims", &[changed]),
            true,
            "supported date-shape alternatives",
        );
    }
}

fn time_value_output(packet: &PreparedFocusQa, value: &str) -> String {
    let mut candidate = claim(0, &[0]);
    candidate[5] = json!([
        value,
        "inferred_from_turn",
        if value.len() == 10 { "day" } else { "instant" },
        "inferred",
        0
    ]);
    output(packet, "claims", &[candidate])
}

fn time_value_boundaries(probe: &mut Probe<'_>, sources: &SourceSet, packet: &PreparedFocusQa) {
    for value in [
        "report",
        "unknown",
        "cancelled",
        "reopened",
        "2026x10x01",
        "2026-00-01",
        "2026-13-01",
        "2026-10-00",
        "2026-10-32",
        "2026-10-01T24:00:00Z",
        "2026-10-01T08:60:00Z",
        "2026-10-01T08:00:60Z",
        "2026-10-01T08:00:00",
        "2026-10-01T08:00:00.Z",
        "2026-10-01T08:00:00+24:00",
        "2026-10-01T08:00:00+00:60",
    ] {
        let raw = time_value_output(packet, value);
        let expanded = packet.expand(&raw).unwrap();
        let projection: Value = serde_json::from_str(expanded.canonical()).unwrap();
        assert_eq!(projection["claims"][0]["eventTime"]["value"], value);
        assert_eq!(
            sources
                .validate(expanded.canonical(), &origin(), Scope::All)
                .unwrap_err(),
            "claim time has invalid value or precision"
        );
        probe.check(&raw, false, "non-ISO or out-of-range time value");
    }
    for value in [
        "0000-01-01".to_owned(),
        "2024-02-29".to_owned(),
        "2026-10-03T08:00:00Z".to_owned(),
        "2026-10-03t08:00:00z".to_owned(),
        "2026-10-03T08:00:00+09:00".to_owned(),
        "2026-10-03T08:00:00-23:59".to_owned(),
        format!("2026-10-03T08:00:00.{}Z", "0".repeat(43)),
        format!("2026-10-03T08:00:00.{}+00:00", "0".repeat(38)),
    ] {
        probe.check(
            &time_value_output(packet, &value),
            true,
            "ISO lexical form remains a proposal, not a time receipt",
        );
    }
    for value in [
        format!("2026-10-03T08:00:00.{}Z", "0".repeat(44)),
        format!("2026-10-03T08:00:00.{}+00:00", "0".repeat(39)),
    ] {
        assert_eq!(value.len(), 65);
        let raw = time_value_output(packet, &value);
        assert!(packet.expand(&raw).is_err());
        probe.check(&raw, false, "time value exceeds existing 64-byte bound");
    }
    // Lexical ranges cannot establish a calendar date or an event's meaning.
    let raw = time_value_output(packet, "2026-02-30");
    probe.check(&raw, true, "native calendar validation remains required");
    let expanded = packet.expand(&raw).unwrap();
    assert_eq!(
        sources
            .validate(expanded.canonical(), &origin(), Scope::All)
            .unwrap_err(),
        "claim time has invalid value or precision"
    );
}

#[test]
#[ignore = "requires verified MYCO_CHAT_MODEL_PATH; real vocabulary masking, no forward inference"]
fn source_focus_vocabulary_enforces_metadata_supports_kinds_and_eog() {
    let model_id = match std::env::var("MYCO_QA_GRAMMAR_MODEL_ID") {
        Ok(id) => Some(id),
        Err(std::env::VarError::NotPresent) => None,
        Err(std::env::VarError::NotUnicode(_)) => {
            panic!("MYCO_QA_GRAMMAR_MODEL_ID must be valid UTF-8")
        }
    };
    let encoding_id = match std::env::var("MYCO_QA_FOCUS_ENCODING") {
        Ok(id) => Some(id),
        Err(std::env::VarError::NotPresent) => None,
        Err(std::env::VarError::NotUnicode(_)) => panic!("MYCO_QA_FOCUS_ENCODING must be UTF-8"),
    };
    let encoding = vocabulary_encoding(encoding_id.as_deref()).unwrap();
    let manifest = vocabulary_manifest(model_id.as_deref()).unwrap();
    let path = PathBuf::from(
        std::env::var_os("MYCO_CHAT_MODEL_PATH").expect("MYCO_CHAT_MODEL_PATH is required"),
    );
    assert!(path.is_absolute());
    let verified =
        crate::local_model::resolve_verified_artifact(path.parent().unwrap(), manifest).unwrap();
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
    for count in 1..=8 {
        let (sources, packet) = prepared(count, encoding);
        let started = Instant::now();
        let grammar = GenerationSchema::WikiSourceFocusClaimsQaV1(packet.decoder())
            .grammar()
            .into_owned();
        let construction_micros = started.elapsed().as_micros();
        let rule_count = grammar
            .lines()
            .filter(|line| line.contains(" ::= "))
            .count();
        assert!(
            grammar.len() <= 1024 * 1024 && rule_count <= 3608,
            "bounded mask-DFA grammar"
        );
        let started = Instant::now();
        let sampler = LlamaSampler::grammar(model, &grammar, "root").unwrap();
        let parser_micros = started.elapsed().as_micros();
        let mut probe = Probe {
            model,
            ends: &ends,
            sampler,
            metrics: MaskMetrics::default(),
        };
        let supports = (0..count).rev().collect::<Vec<_>>();
        let anchor = count - 1;
        probe.check(
            &output(&packet, "claims", &[claim(anchor, &supports)]),
            true,
            "representative all-support reverse order",
        );
        probe.check(
            &output(&packet, "insufficient_evidence", &[]),
            true,
            "empty outcome remains explicit",
        );
        speaker_alternatives(&mut probe, &packet, anchor, &supports);
        if count == 2 || count == 3 {
            every_support_order(&mut probe, &packet, count);
        }
        if count == 2 {
            time_value_boundaries(&mut probe, &sources, &packet);
            kind_status_matrix(&mut probe, &packet);
            packet_and_tuple_boundaries(&mut probe, &packet);
            // A false kind is still a semantic proposal: grammar cannot decide
            // whether a literal negative focus describes an occurrence.
            let mut false_kind = claim(0, &[0]);
            false_kind[2] = json!("asserted_occurrence");
            false_kind[7] = json!("reported_completed");
            let raw = output(&packet, "claims", &[false_kind]);
            probe.check(
                &raw,
                true,
                "structural admission does not prove focus meaning",
            );
            let projection = packet.expand(&raw).unwrap();
            let checked = sources
                .validate(projection.canonical(), &origin(), Scope::All)
                .unwrap();
            assert!(checked
                .claims
                .iter()
                .all(|claim| claim.structure_checked && claim.semantic_review_required));
            assert_eq!(
                serde_json::to_value(&projection).unwrap()["semanticAccepted"],
                json!(false)
            );
        }
        println!(
            "{}",
            json!({"phase":"source_focus_vocabulary_grammar","originalCount":count,
            "selectedModelId":manifest.id,"manifestSha256":manifest.sha256,"wireVersion":packet.decoder().wire_version(),
            "grammarBytes":grammar.len(),"grammarRules":rule_count,"supportDfaStates":count*((1_usize<<count)-1),
            "grammarConstructionMicros":construction_micros,"grammarParserMicros":parser_micros,
            "metrics":probe.metrics,"actualEogTokens":ends.len(),"allUniqueSupportOrdersExhaustive":count==2||count==3,
            "forwardInference":false,"modelGeneration":false,"modelContextCreated":false,"nativeSourceAuthority":false,
            "semanticAccepted":false,"fullPromptsLogged":false,"hardLatencyThreshold":false})
        );
    }
    token_costs::observe(&host, model);
    // No LlamaContext, prefill, decode, generate API or model judge is called.
    drop(host);
}
