use super::*;
use crate::retrieval::Scope;
use crate::vault_session::AgentVaultSession;
use crate::wiki_claims::{
    ActorBasis, ActorRole, AppVerifiedFact, ClaimOutcome, ClaimProposal, ClaimStatus,
    ProposedActor, ProposedEventTime, SourceDocument, SourceSet, SpanInput, SpeechAct, TimeBasis,
    TimePrecision, TimeUncertainty,
};
use llama_cpp_2::token::{data::LlamaTokenData, data_array::LlamaTokenDataArray, LlamaToken};

const DAY: &str = "2026-10-08";
const INSTANT: &str = "2026-10-08T08:00:00Z";

// Serialize structs, not Value maps: the sampler contract has a fixed field order.
fn output(outcome: ClaimOutcome, claims: &[ClaimProposal]) -> String {
    #[derive(serde::Serialize)]
    struct Batch<'a> {
        outcome: ClaimOutcome,
        claims: &'a [ClaimProposal],
    }
    serde_json::to_string(&Batch { outcome, claims }).unwrap()
}

fn proposal() -> ClaimProposal {
    ClaimProposal {
        action: "Implementation has not been performed.".into(),
        anchor_span_id: "Q1".into(),
        support_span_ids: vec!["Q1".into()],
        actor: ProposedActor {
            role: ActorRole::User,
            basis: ActorBasis::Speaker,
            subject_span_id: None,
        },
        event_time: ProposedEventTime {
            value: None,
            basis: TimeBasis::Unknown,
            precision: TimePrecision::Unknown,
            uncertainty: TimeUncertainty::Unknown,
            support_span_id: None,
        },
        speech_act: SpeechAct::Report,
        status: ClaimStatus::Unknown,
        verification_id: None,
    }
}

fn origin() -> AgentVaultSession {
    AgentVaultSession {
        vault_path: "/synthetic/vocabulary".into(),
        opening_token: "synthetic-opening".into(),
    }
}

// Synthetic pure-validator fixture; no disk, IPC admission, or IO authority.
fn source_set(claim: &ClaimProposal, speaker: ActorRole) -> SourceSet {
    let original = format!("Implementation has not been performed. {DAY} {INSTANT}");
    source_set_with_time(claim, speaker, &original, INSTANT)
}

fn source_set_with_time(
    claim: &ClaimProposal,
    speaker: ActorRole,
    original: &str,
    turn_time: &str,
) -> SourceSet {
    let source = SourceDocument::bind(
        "S1".into(),
        "sessions/vocabulary.md".into(),
        "sessions/vocabulary.md".into(),
        original,
        None,
        vec![SpanInput {
            id: "Q1".into(),
            start: 0,
            end: original.len(),
            turn_id: "T1".into(),
            speaker,
            turn_time: Some(turn_time.into()),
        }],
    )
    .unwrap();
    let facts = if verified(claim.status) {
        vec![AppVerifiedFact {
            id: "V1".into(),
            canonical_statement: claim.action.clone(),
            status: claim.status,
            support_span_ids: vec!["Q1".into()],
        }]
    } else {
        vec![]
    };
    SourceSet::new(origin(), Scope::Sessions, vec![source], facts).unwrap()
}

// This is real vocabulary masking, not inference or semantic/source authorization.
// An incomplete accepted prefix must reject every actual EOG token, too.
fn assert_masking(model: &LlamaModel, ends: &[LlamaToken], output: &str, expected: bool) {
    let grammar = GenerationSchema::WikiClaimsV1.grammar();
    let mut sampler = LlamaSampler::grammar(model, &grammar, "root").unwrap();
    let allowed = |sampler: &mut LlamaSampler, token| {
        let mut choices =
            LlamaTokenDataArray::new(vec![LlamaTokenData::new(token, 0.0, 0.0)], false);
        sampler.apply(&mut choices);
        choices.data[0].logit().is_finite()
    };
    for token in model.str_to_token(output, AddBos::Never).unwrap() {
        if !allowed(&mut sampler, token) {
            assert!(!expected, "unexpected output-token rejection: {output}");
            return;
        }
        sampler.accept(token);
    }
    for end in ends {
        assert_eq!(
            allowed(&mut sampler, *end),
            expected,
            "unexpected EOG {end:?} admission: {output}"
        );
    }
}

fn assert_claim(model: &LlamaModel, ends: &[LlamaToken], claim: &ClaimProposal, expected: bool) {
    let rendered = output(ClaimOutcome::Claims, std::slice::from_ref(claim));
    // Set the fixture speaker to the proposed role so this comparison isolates
    // field coupling. Actual selected speaker and ID checks remain native-only.
    let checked =
        source_set(claim, claim.actor.role).validate(&rendered, &origin(), Scope::Sessions);
    assert_eq!(
        checked.is_ok(),
        expected,
        "native structure table: {rendered}"
    );
    if let Ok(checked) = checked {
        assert!(checked.claims[0].semantic_review_required);
    }
    assert_masking(model, ends, &rendered, expected);
}

fn verified(status: ClaimStatus) -> bool {
    matches!(
        status,
        ClaimStatus::VerifiedCompleted | ClaimStatus::VerifiedFailed
    )
}

fn permits_status(act: SpeechAct, status: ClaimStatus) -> bool {
    use ClaimStatus::*;
    match act {
        SpeechAct::Unknown | SpeechAct::Question => status == Unknown,
        SpeechAct::Request => matches!(status, Unknown | Requested),
        SpeechAct::Plan => matches!(status, Unknown | Planned),
        SpeechAct::Report => matches!(
            status,
            Unknown
                | InProgress
                | ReportedCompleted
                | ReportedFailed
                | ReportedCancelled
                | ReportedRolledBack
        ),
        SpeechAct::Verification => matches!(
            status,
            Unknown | ReportedCompleted | ReportedFailed | VerifiedCompleted | VerifiedFailed
        ),
        SpeechAct::Retraction => {
            matches!(
                status,
                Unknown | Retracted | ReportedCancelled | ReportedRolledBack
            )
        }
    }
}

fn permits_time(
    basis: TimeBasis,
    value: Option<&str>,
    precision: TimePrecision,
    uncertainty: TimeUncertainty,
    support: bool,
) -> bool {
    if basis == TimeBasis::Unknown {
        value.is_none()
            && !support
            && precision == TimePrecision::Unknown
            && uncertainty == TimeUncertainty::Unknown
    } else {
        support
            && matches!(
                (value, precision),
                (Some(DAY), TimePrecision::Day) | (Some(INSTANT), TimePrecision::Instant)
            )
            && uncertainty
                == if basis == TimeBasis::Explicit {
                    TimeUncertainty::Specified
                } else {
                    TimeUncertainty::Inferred
                }
    }
}

fn assert_outcome_matrix(model: &LlamaModel, ends: &[LlamaToken]) {
    let base = proposal();
    let set = source_set(&base, ActorRole::User);
    for outcome in [ClaimOutcome::Claims, ClaimOutcome::InsufficientEvidence] {
        for count in 0..=17 {
            let rendered = output(outcome, &vec![base.clone(); count]);
            let expected = match outcome {
                ClaimOutcome::Claims => (1..=16).contains(&count),
                ClaimOutcome::InsufficientEvidence => count == 0,
            };
            assert_eq!(
                set.validate(&rendered, &origin(), Scope::Sessions).is_ok(),
                expected
            );
            assert_masking(model, ends, &rendered, expected);
        }
    }
}

fn assert_actor_matrix(model: &LlamaModel, ends: &[LlamaToken]) {
    let base = proposal();
    for role in [
        ActorRole::User,
        ActorRole::Assistant,
        ActorRole::System,
        ActorRole::Tool,
        ActorRole::Source,
        ActorRole::Unknown,
    ] {
        for basis in [
            ActorBasis::Speaker,
            ActorBasis::ExplicitSubject,
            ActorBasis::Unknown,
        ] {
            for subject in [false, true] {
                let mut claim = base.clone();
                claim.actor = ProposedActor {
                    role,
                    basis,
                    subject_span_id: subject.then(|| "Q1".into()),
                };
                let expected = match basis {
                    ActorBasis::Speaker => !subject,
                    ActorBasis::ExplicitSubject => role != ActorRole::Unknown && subject,
                    ActorBasis::Unknown => role == ActorRole::Unknown && !subject,
                };
                assert_claim(model, ends, &claim, expected);
            }
        }
    }
}

fn assert_time_matrix(model: &LlamaModel, ends: &[LlamaToken]) {
    let base = proposal();
    for basis in [
        TimeBasis::Unknown,
        TimeBasis::Explicit,
        TimeBasis::InferredFromTurn,
        TimeBasis::DateReference,
    ] {
        for value in [None, Some(DAY), Some(INSTANT)] {
            for precision in [
                TimePrecision::Unknown,
                TimePrecision::Day,
                TimePrecision::Instant,
            ] {
                for uncertainty in [
                    TimeUncertainty::Unknown,
                    TimeUncertainty::Specified,
                    TimeUncertainty::Inferred,
                ] {
                    for support in [false, true] {
                        let mut claim = base.clone();
                        claim.event_time = ProposedEventTime {
                            value: value.map(str::to_owned),
                            basis,
                            precision,
                            uncertainty,
                            support_span_id: support.then(|| "Q1".into()),
                        };
                        let expected = permits_time(basis, value, precision, uncertainty, support);
                        assert_claim(model, ends, &claim, expected);
                    }
                }
            }
        }
    }
}

fn assert_status_matrix(model: &LlamaModel, ends: &[LlamaToken]) {
    let base = proposal();
    for act in [
        SpeechAct::Unknown,
        SpeechAct::Request,
        SpeechAct::Plan,
        SpeechAct::Report,
        SpeechAct::Verification,
        SpeechAct::Retraction,
        SpeechAct::Question,
    ] {
        for status in [
            ClaimStatus::Unknown,
            ClaimStatus::Requested,
            ClaimStatus::Planned,
            ClaimStatus::InProgress,
            ClaimStatus::ReportedCompleted,
            ClaimStatus::ReportedFailed,
            ClaimStatus::ReportedCancelled,
            ClaimStatus::ReportedRolledBack,
            ClaimStatus::Retracted,
            ClaimStatus::VerifiedCompleted,
            ClaimStatus::VerifiedFailed,
        ] {
            for receipt in [false, true] {
                let mut claim = base.clone();
                claim.speech_act = act;
                claim.status = status;
                claim.verification_id = receipt.then(|| "V1".into());
                assert_claim(
                    model,
                    ends,
                    &claim,
                    permits_status(act, status) && receipt == verified(status),
                );
            }
        }
    }
}

fn assert_native_time_variants(model: &LlamaModel, ends: &[LlamaToken]) {
    // parse_iso8601 accepts lowercase separators, nonempty fractions and signed
    // HH:MM offsets. Inferred turn time retains the exact original string.
    for value in [
        "2026-10-08t08:00:00z",
        "2026-10-08T08:00:00.123Z",
        "2026-10-08T17:00:00+09:00",
        "2026-10-08T03:00:00-05:00",
    ] {
        assert!(crate::importers::parse_iso8601(value).is_some(), "{value}");
        let original = format!("Implementation has not been performed. {value}");
        for basis in [TimeBasis::Explicit, TimeBasis::InferredFromTurn] {
            let mut claim = proposal();
            claim.event_time = ProposedEventTime {
                value: Some(value.into()),
                basis,
                precision: TimePrecision::Instant,
                uncertainty: if basis == TimeBasis::Explicit {
                    TimeUncertainty::Specified
                } else {
                    TimeUncertainty::Inferred
                },
                support_span_id: Some("Q1".into()),
            };
            let rendered = output(ClaimOutcome::Claims, std::slice::from_ref(&claim));
            let checked = source_set_with_time(&claim, ActorRole::User, &original, value)
                .validate(&rendered, &origin(), Scope::Sessions)
                .unwrap();
            assert!(checked.claims[0].semantic_review_required);
            assert_masking(model, ends, &rendered, true);
        }
    }
}

fn assert_permitted_examples(model: &LlamaModel, ends: &[LlamaToken]) {
    let base = proposal();
    // These field combinations remain structurally permitted, requiring
    // semantic review. A negative report need not assert a failure/completion,
    // and a verification utterance need not carry an independent receipt.
    for (act, status) in [
        (SpeechAct::Report, ClaimStatus::Unknown),
        (SpeechAct::Request, ClaimStatus::Requested),
        (SpeechAct::Verification, ClaimStatus::ReportedCompleted),
    ] {
        let mut claim = base.clone();
        claim.speech_act = act;
        claim.status = status;
        assert_claim(model, ends, &claim, true);
    }
}

fn assert_source_boundaries(model: &LlamaModel, ends: &[LlamaToken]) {
    let base = proposal();
    // Grammar admits these syntactically coupled proposals. Native validation
    // rejects the unselected ID, wrong actual speaker, and unsupported date.
    for case in ["source-id", "actual-speaker", "date-entailment"] {
        let mut claim = base.clone();
        let speaker = if case == "actual-speaker" {
            ActorRole::Assistant
        } else {
            ActorRole::User
        };
        if case == "source-id" {
            claim.anchor_span_id = "UNSELECTED".into();
            claim.support_span_ids = vec!["UNSELECTED".into()];
        } else if case == "date-entailment" {
            claim.event_time = ProposedEventTime {
                value: Some("2026-10-07".into()),
                basis: TimeBasis::Explicit,
                precision: TimePrecision::Day,
                uncertainty: TimeUncertainty::Specified,
                support_span_id: Some("Q1".into()),
            };
        }
        let rendered = output(ClaimOutcome::Claims, &[claim.clone()]);
        assert!(
            source_set(&claim, speaker)
                .validate(&rendered, &origin(), Scope::Sessions)
                .is_err(),
            "{case}"
        );
        assert_masking(model, ends, &rendered, true);
    }
}

fn assert_completion_boundaries(model: &LlamaModel, ends: &[LlamaToken]) {
    let base = proposal();
    for rendered in [
        output(ClaimOutcome::InsufficientEvidence, &[]),
        output(ClaimOutcome::Claims, std::slice::from_ref(&base)),
        output(ClaimOutcome::Claims, &vec![base; 16]),
    ] {
        assert_masking(model, ends, &rendered, true);
        let array_start = rendered.find("\"claims\":[").unwrap() + "\"claims\":[".len();
        for prefix in [
            rendered.strip_suffix('}').unwrap(),
            &rendered[..array_start],
        ] {
            assert_masking(model, ends, prefix, false);
        }
        if let Some((before_actor, _)) = rendered.split_once(",\"actor\":") {
            assert_masking(model, ends, before_actor, false);
        }
    }
}

#[test]
#[ignore = "requires a verified GGUF via MYCO_CHAT_MODEL_PATH; vocabulary masking only, no inference"]
fn wiki_claims_sampler_matches_native_field_coupling_without_claiming_entailment() {
    let path = PathBuf::from(
        std::env::var_os("MYCO_CHAT_MODEL_PATH").expect("MYCO_CHAT_MODEL_PATH is required"),
    );
    let mut host = LocalLlm::load_embed_host().unwrap();
    host.ensure_chat_model(&path).unwrap();
    let model = host.chat_model().unwrap();
    let ends: Vec<_> = (0..model.n_vocab())
        .map(LlamaToken::new)
        .filter(|token| model.is_eog_token(*token))
        .collect();
    assert!(!ends.is_empty());
    assert_outcome_matrix(model, &ends);
    assert_actor_matrix(model, &ends);
    assert_time_matrix(model, &ends);
    assert_native_time_variants(model, &ends);
    assert_status_matrix(model, &ends);
    assert_permitted_examples(model, &ends);
    assert_source_boundaries(model, &ends);
    assert_completion_boundaries(model, &ends);
}
