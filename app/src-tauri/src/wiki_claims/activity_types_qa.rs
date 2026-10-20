//! Closed activity-only wire; expansion preserves proposals, never approves meaning.

use crate::wiki_claims::source_interpretation_qa::{
    AssertionKindQa, CandidateDecoderQa, CandidateQa, RelevanceQa,
};
use crate::wiki_claims::{
    ActorRole, ClaimStatus, ProposedActor, SpeechAct, TimeBasis, TimePrecision, TimeUncertainty,
};
use serde::{Deserialize, Serialize};

#[path = "activity_actor_qa.rs"]
mod actor;
use actor::Actor;

pub(super) const WIRE_VERSION: &str = "NativeActivityTypesQaV2";

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(super) enum ActivityTypeQa {
    ReportedOccurrenceStatusUnknown,
    ReportedInProgress,
    ReportedCompletion,
    ReportedFailure,
    ReportedCancellation,
    ReportedRollback,
    RetractionStatusUnknown,
    RetractedOccurrence,
    RetractedCancellation,
    RetractedRollback,
    ActorNonperformance,
    RequestedStatusUnknown,
    RequestedWork,
    PlannedStatusUnknown,
    PlannedWork,
    RecordOrVerificationLimit,
    UnresolvedStatement,
    UnresolvedQuestion,
}

impl ActivityTypeQa {
    pub(super) const ALL: [Self; 18] = [
        Self::ReportedOccurrenceStatusUnknown,
        Self::ReportedInProgress,
        Self::ReportedCompletion,
        Self::ReportedFailure,
        Self::ReportedCancellation,
        Self::ReportedRollback,
        Self::RetractionStatusUnknown,
        Self::RetractedOccurrence,
        Self::RetractedCancellation,
        Self::RetractedRollback,
        Self::ActorNonperformance,
        Self::RequestedStatusUnknown,
        Self::RequestedWork,
        Self::PlannedStatusUnknown,
        Self::PlannedWork,
        Self::RecordOrVerificationLimit,
        Self::UnresolvedStatement,
        Self::UnresolvedQuestion,
    ];

    pub(super) fn triple(self) -> (AssertionKindQa, SpeechAct, ClaimStatus) {
        use AssertionKindQa as Kind;
        use ClaimStatus as Status;
        use SpeechAct as Speech;
        match self {
            Self::ReportedOccurrenceStatusUnknown => {
                (Kind::AssertedOccurrence, Speech::Report, Status::Unknown)
            }
            Self::ReportedInProgress => {
                (Kind::AssertedOccurrence, Speech::Report, Status::InProgress)
            }
            Self::ReportedCompletion => (
                Kind::AssertedOccurrence,
                Speech::Report,
                Status::ReportedCompleted,
            ),
            Self::ReportedFailure => (
                Kind::AssertedOccurrence,
                Speech::Report,
                Status::ReportedFailed,
            ),
            Self::ReportedCancellation => (
                Kind::AssertedOccurrence,
                Speech::Report,
                Status::ReportedCancelled,
            ),
            Self::ReportedRollback => (
                Kind::AssertedOccurrence,
                Speech::Report,
                Status::ReportedRolledBack,
            ),
            Self::RetractionStatusUnknown => (
                Kind::AssertedOccurrence,
                Speech::Retraction,
                Status::Unknown,
            ),
            Self::RetractedOccurrence => (
                Kind::AssertedOccurrence,
                Speech::Retraction,
                Status::Retracted,
            ),
            Self::RetractedCancellation => (
                Kind::AssertedOccurrence,
                Speech::Retraction,
                Status::ReportedCancelled,
            ),
            Self::RetractedRollback => (
                Kind::AssertedOccurrence,
                Speech::Retraction,
                Status::ReportedRolledBack,
            ),
            Self::ActorNonperformance => {
                (Kind::ExplicitNonoccurrence, Speech::Report, Status::Unknown)
            }
            Self::RequestedStatusUnknown => (Kind::Intention, Speech::Request, Status::Unknown),
            Self::RequestedWork => (Kind::Intention, Speech::Request, Status::Requested),
            Self::PlannedStatusUnknown => (Kind::Intention, Speech::Plan, Status::Unknown),
            Self::PlannedWork => (Kind::Intention, Speech::Plan, Status::Planned),
            Self::RecordOrVerificationLimit => (
                Kind::RecordOrVerificationLimit,
                Speech::Report,
                Status::Unknown,
            ),
            Self::UnresolvedStatement => (Kind::Uncertain, Speech::Unknown, Status::Unknown),
            Self::UnresolvedQuestion => (Kind::Uncertain, Speech::Question, Status::Unknown),
        }
    }
}

/// Only a prepared ordinal capture can issue this activity-only decoder.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ActivityTypesDecoderQa {
    core: CandidateDecoderQa,
    speakers: [ActorRole; 8],
}

impl ActivityTypesDecoderQa {
    pub(super) fn new(core: CandidateDecoderQa, speakers: [ActorRole; 8]) -> Self {
        assert_eq!(core.variant(), CandidateQa::OrdinalV3);
        assert!((1..=8).contains(&core.units()));
        Self { core, speakers }
    }

    /// Number of complete original rows fixed by the prepared capture.
    pub fn units(self) -> usize {
        self.core.units()
    }

    /// Bind actor references and speakers while preserving time/support/Unicode rules.
    pub fn grammar(self) -> String {
        const LEGACY: &str =
            r#",\"speechAct\":" ws speech-status ",\"assertionKind\":" ws assertion-kind"#;
        const TYPED: &str = r#",\"activityType\":" ws activity-type"#;
        let original = self.core.grammar();
        assert_eq!(original.matches(LEGACY).count(), 1);
        assert_eq!(original.matches("focus-64{0,31}").count(), 1);
        let grammar = original
            .replace(CandidateQa::OrdinalV3.output_version(), WIRE_VERSION)
            .replace(LEGACY, TYPED)
            .replace("focus-64{0,31}", "focus-64{0,7}");
        let obsolete = [
            "speech-status",
            "unknown-status",
            "request-status",
            "plan-status",
            "report-status",
            "verification-status",
            "retraction-status",
            "assertion-kind",
        ];
        let mut grammar = grammar
            .lines()
            .filter(|line| {
                !obsolete
                    .iter()
                    .any(|rule| line.starts_with(&format!("{rule} ::= ")))
            })
            .collect::<Vec<_>>()
            .join("\n");
        let tags = ActivityTypeQa::ALL
            .iter()
            .map(|tag| {
                serde_json::to_string(&serde_json::to_string(tag).expect("activity tag serializes"))
                    .expect("grammar literal serializes")
            })
            .collect::<Vec<_>>()
            .join(" | ");
        grammar.push_str(&format!("\nactivity-type ::= {tags}\n"));
        actor::grammar(grammar, &self.speakers[..self.units()])
    }
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Batch<I> {
    version: String,
    units: Vec<Unit<I>>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Unit<I> {
    unit_ordinal: usize,
    relevance: RelevanceQa,
    interpretations: Vec<I>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Interpretation {
    focus_quote: String,
    support_span_ids: Vec<String>,
    actor: Actor,
    event_time: EventTime,
    activity_type: ActivityTypeQa,
    #[serde(deserialize_with = "required_nullable")]
    verification_id: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ExpandedInterpretation {
    focus_quote: String,
    support_span_ids: Vec<String>,
    actor: ProposedActor,
    event_time: EventTime,
    speech_act: SpeechAct,
    status: ClaimStatus,
    assertion_kind: AssertionKindQa,
    verification_id: Option<String>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct EventTime {
    #[serde(deserialize_with = "required_nullable")]
    value: Option<String>,
    basis: TimeBasis,
    precision: TimePrecision,
    uncertainty: TimeUncertainty,
    #[serde(deserialize_with = "required_nullable")]
    support_span_id: Option<String>,
}

fn required_nullable<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(deserializer)
}

/// Deserialize every nested object before expansion, retaining duplicate/null checks.
pub(super) fn expand(raw: &str, ids: &[String]) -> Result<String, String> {
    if raw.len() > crate::wiki_claims::MAX_OUTPUT_BYTES {
        return Err("activity type output exceeds bounds".into());
    }
    let batch: Batch<Interpretation> = serde_json::from_str(raw)
        .map_err(|error| format!("invalid activity type JSON: {error}"))?;
    if batch.version != WIRE_VERSION {
        return Err("activity type output version changed".into());
    }
    let expanded = Batch {
        version: CandidateQa::OrdinalV3.output_version().into(),
        units: batch
            .units
            .into_iter()
            .map(|unit| {
                Ok(Unit {
                    unit_ordinal: unit.unit_ordinal,
                    relevance: unit.relevance,
                    interpretations: unit
                        .interpretations
                        .into_iter()
                        .map(|interpretation| {
                            let (assertion_kind, speech_act, status) =
                                interpretation.activity_type.triple();
                            Ok(ExpandedInterpretation {
                                focus_quote: interpretation.focus_quote,
                                support_span_ids: interpretation.support_span_ids,
                                actor: interpretation.actor.into_native(ids)?,
                                event_time: interpretation.event_time,
                                speech_act,
                                status,
                                assertion_kind,
                                verification_id: interpretation.verification_id,
                            })
                        })
                        .collect::<Result<Vec<_>, String>>()?,
                })
            })
            .collect::<Result<Vec<_>, String>>()?,
    };
    serde_json::to_string(&expanded).map_err(|error| error.to_string())
}
