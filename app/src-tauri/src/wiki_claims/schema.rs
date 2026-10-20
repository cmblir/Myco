//! App-owned JSON proposals and output schema; never model-owned provenance.

use super::SourceSpan;
use serde::{Deserialize, Serialize};

/// Closed, application-owned WikiClaimsV1 syntax with source-independent field
/// coupling. Decode budgets may require fewer atomic claims; acceptance still
/// needs native source/receipt checks and semantic review, not just this grammar.
pub const WIKI_CLAIMS_JSON_GRAMMAR: &str = r#"
root ::= ("{\"outcome\":" ws "\"claims\",\"claims\":" ws "[" ws claim ("," ws claim){0,15} "]}" | "{\"outcome\":" ws "\"insufficient_evidence\",\"claims\":" ws "[" ws "]}") ws
claim ::= "{\"action\":" ws action ",\"anchorSpanId\":" ws id ",\"supportSpanIds\":" ws "[" ws id ("," ws id){0,7} "],\"actor\":" ws actor ",\"eventTime\":" ws time ",\"speechAct\":" ws speech-status "}"
actor ::= "{\"role\":" ws (role ",\"basis\":" ws "\"speaker\",\"subjectSpanId\":" ws "null" | known-role ",\"basis\":" ws "\"explicit_subject\",\"subjectSpanId\":" ws id | "\"unknown\",\"basis\":" ws "\"unknown\",\"subjectSpanId\":" ws "null") "}"
role ::= known-role | "\"unknown\""
known-role ::= "\"user\"" | "\"assistant\"" | "\"system\"" | "\"tool\"" | "\"source\""
time ::= "{\"value\":" ws ("null,\"basis\":" ws "\"unknown\",\"precision\":" ws "\"unknown\",\"uncertainty\":" ws "\"unknown\",\"supportSpanId\":" ws "null" | day-value ",\"basis\":" ws day-basis ",\"supportSpanId\":" ws id | instant-value ",\"basis\":" ws instant-basis ",\"supportSpanId\":" ws id) "}"
day-value ::= "\"" char{10} "\""
instant-value ::= "\"" (char{1,9} | char{11,64}) "\""
day-basis ::= "\"explicit\",\"precision\":" ws "\"day\",\"uncertainty\":" ws "\"specified\"" | inferred-basis ",\"precision\":" ws "\"day\",\"uncertainty\":" ws "\"inferred\""
instant-basis ::= "\"explicit\",\"precision\":" ws "\"instant\",\"uncertainty\":" ws "\"specified\"" | inferred-basis ",\"precision\":" ws "\"instant\",\"uncertainty\":" ws "\"inferred\""
inferred-basis ::= "\"inferred_from_turn\"" | "\"date_reference\""
speech-status ::= ("\"unknown\"" | "\"question\"") unknown-status | "\"request\"" request-status | "\"plan\"" plan-status | "\"report\"" report-status | "\"verification\"" verification-status | "\"retraction\"" retraction-status
unknown-status ::= ",\"status\":" ws "\"unknown\"" unverified
request-status ::= ",\"status\":" ws ("\"unknown\"" | "\"requested\"") unverified
plan-status ::= ",\"status\":" ws ("\"unknown\"" | "\"planned\"") unverified
report-status ::= ",\"status\":" ws ("\"unknown\"" | "\"in_progress\"" | "\"reported_completed\"" | "\"reported_failed\"" | "\"reported_cancelled\"" | "\"reported_rolled_back\"") unverified
verification-status ::= ",\"status\":" ws (("\"unknown\"" | "\"reported_completed\"" | "\"reported_failed\"") unverified | ("\"verified_completed\"" | "\"verified_failed\"") verified)
retraction-status ::= ",\"status\":" ws ("\"unknown\"" | "\"retracted\"" | "\"reported_cancelled\"" | "\"reported_rolled_back\"") unverified
unverified ::= ",\"verificationId\":" ws "null"
verified ::= ",\"verificationId\":" ws id
id ::= "\"" [A-Za-z0-9_-]{1,64} "\""
action ::= "\"" char{1,512} "\""
char ::= [^"\\\x00-\x1F] | "\\" (["\\/bfnrt] | "u" [0-9a-fA-F]{4})
ws ::= [ \t\n\r]{0,8}
"#;

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ActorRole {
    User,
    Assistant,
    System,
    Tool,
    Source,
    Unknown,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ActorBasis {
    Speaker,
    ExplicitSubject,
    Unknown,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProposedActor {
    pub role: ActorRole,
    pub basis: ActorBasis,
    pub subject_span_id: Option<String>,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TimeBasis {
    Unknown,
    Explicit,
    InferredFromTurn,
    DateReference,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TimePrecision {
    Unknown,
    Day,
    Instant,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TimeUncertainty {
    Unknown,
    Specified,
    Inferred,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProposedEventTime {
    pub value: Option<String>,
    pub basis: TimeBasis,
    pub precision: TimePrecision,
    pub uncertainty: TimeUncertainty,
    pub support_span_id: Option<String>,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SpeechAct {
    Unknown,
    Request,
    Plan,
    Report,
    Verification,
    Retraction,
    Question,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ClaimStatus {
    Unknown,
    Requested,
    Planned,
    InProgress,
    ReportedCompleted,
    ReportedFailed,
    ReportedCancelled,
    ReportedRolledBack,
    Retracted,
    VerifiedCompleted,
    VerifiedFailed,
}

impl ClaimStatus {
    pub(super) fn is_verified(self) -> bool {
        matches!(self, Self::VerifiedCompleted | Self::VerifiedFailed)
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ClaimProposal {
    pub action: String,
    pub anchor_span_id: String,
    pub support_span_ids: Vec<String>,
    pub actor: ProposedActor,
    pub event_time: ProposedEventTime,
    pub speech_act: SpeechAct,
    pub status: ClaimStatus,
    pub verification_id: Option<String>,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ClaimOutcome {
    Claims,
    InsufficientEvidence,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckedClaim {
    pub proposal: ClaimProposal,
    pub provenance: Vec<SourceSpan>,
    pub structure_checked: bool,
    pub semantic_review_required: bool,
}

#[derive(Clone, Debug, Serialize)]
pub struct CheckedClaims {
    pub outcome: ClaimOutcome,
    pub claims: Vec<CheckedClaim>,
}
