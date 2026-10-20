//! Activity-only instructions reuse unchanged source, actor and event-time rules.

use super::activity_types::{ActivityTypeQa, WIRE_VERSION};
use crate::wiki_claims::source_interpretation_qa::CandidateQa;

const SOURCE_ONLY: &str = "This is source-only interpretation: there is no question or requested period in this input, and this task does not answer an Ask question or select its period.";
const ACTIVITY_TASK: &str = "Interpret every supplied original for the supplied question and application-selected activity period. Do not answer the question or choose its period. Preserve attributed activities and important qualifications even when they are unverified. The period selects records; it does not establish event dates, execution, current status or permission to drop negative qualifications.";
const DEFINITIONS: &str = "activityType selects exactly one of the 18 values in the exhaustive native mapping below. Emit only activityType, never assertionKind, speechAct or status. The mapping describes the unchanged native expansion, not additional output fields. Reported occurrence types describe what the complete original asserts occurred, including attributed events, decisions or state changes. reported_occurrence_status_unknown describes an asserted occurrence whose status is unknown; it must not replace a supported completion. reported_in_progress, reported_completion, reported_failure, reported_cancellation and reported_rollback preserve the corresponding reported state. Reported completion, including attributed Assistant/Tool completion, is never independently verified. retraction_status_unknown, retracted_occurrence, retracted_cancellation and retracted_rollback preserve the corresponding withdrawal and its status separately from later resumption. actor_nonperformance means the original asserts an activity was not performed, within its stated actor, time and scope. Explicit historical nonperformance does not establish today's state. record_or_verification_limit means the available record or verification cannot establish something; missing a record, a message result or independent verification does not establish actor nonperformance, failure or an unknown performer. requested_status_unknown and requested_work preserve requests; planned_status_unknown and planned_work preserve plans. Neither is execution. unresolved_statement and unresolved_question preserve an assertion that cannot be interpreted reliably. The unknown-status alternatives remain distinct from a reported completion, requested status or planned status. These are judgments about complete original meaning, not isolated keywords or a positive focus fragment.";
const FINAL_RULES: &str = "There are no independent verification receipts: verificationId must be null and independently verified statuses have no activityType. Lack of independent verification alone does not establish nonperformance or execution failure. A limit explicitly scoped to 'this message' stays within that message and does not establish nonperformance or absence across other records. Preserve separately supported activity and evidence-limit meanings. Do not discard a qualification or choose an unresolved type merely to fit the mapping. All nullable actor/time/verification keys are required even when null. Exact focus binding, a legal activityType, correct IDs and complete JSON do not establish source support, semantic coverage or a useful answer; every interpretation and important omitted qualification still requires separate full-original review.";
const ACTOR: &str = "actor has required role, basis and subjectOrdinal. Emit subjectOrdinal, never subjectSpanId in actor. basis=speaker requires this row's actual original speaker role and subjectOrdinal=null. A speaker with unknown role metadata may retain role=unknown with basis=speaker; that metadata does not identify a known performer. basis=explicit_subject requires a supported described actor, a non-unknown role and a numeric subjectOrdinal equal to the supporting originalSpans entry's unitOrdinal; its exact original ID must also be in supportSpanIds. All supplied originals may provide cross-span subject support; third-party actors may use role=source. basis=unknown requires role=unknown and subjectOrdinal=null. Nullable subjectOrdinal is JSON null, never the string \"null\". The ordinal is only an exact source pointer, not actor meaning or support approval. Do not assign the speaker as actor merely because they reported another person's activity.";

pub(super) fn system(input_version: &str) -> String {
    let mut system = CandidateQa::OrdinalV3.system();
    for (old, new) in [
        (SOURCE_ONLY, ACTIVITY_TASK),
        (CandidateQa::OrdinalV3.input_version(), input_version),
        (CandidateQa::OrdinalV3.output_version(), WIRE_VERSION),
        ("focusQuote, supportSpanIds, actor, eventTime, speechAct, status, assertionKind and verificationId, in that order.",
         "focusQuote, supportSpanIds, actor, eventTime, activityType and verificationId, in that order."),
        ("at most 2048 decoded Unicode scalar values", "at most 512 decoded Unicode scalar values"),
        ("Refer to original IDs only in supportSpanIds, subjectSpanId or eventTime.supportSpanId, never as output original metadata.",
         "Refer to original IDs only in supportSpanIds or eventTime.supportSpanId; actor.subjectOrdinal points to a supplied originalSpans entry. Never return output original metadata."),
    ] {
        assert_eq!(system.matches(old).count(), 1);
        system = system.replacen(old, new, 1);
    }
    system = replace_paragraph(&system, "assertionKind is ", DEFINITIONS);
    system = replace_paragraph(&system, "actor has role, basis and subjectSpanId.", ACTOR);
    system = replace_paragraph(
        &system,
        "Use compatible speechAct/status fields:",
        FINAL_RULES,
    );
    let mapping = ActivityTypeQa::ALL
        .into_iter()
        .map(|tag| {
            let name = serde_json::to_value(tag)
                .expect("activity tag serializes")
                .as_str()
                .expect("activity tag is a string")
                .to_owned();
            (
                name,
                serde_json::to_value(tag.triple()).expect("native triple serializes"),
            )
        })
        .collect::<serde_json::Map<_, _>>();
    system.push_str("\nActivity type native mapping (exhaustive; not output fields):\n");
    system.push_str(&serde_json::to_string(&mapping).expect("native mapping serializes"));
    system
}

fn replace_paragraph(system: &str, prefix: &str, replacement: &str) -> String {
    let paragraphs = system
        .lines()
        .filter(|line| line.starts_with(prefix))
        .collect::<Vec<_>>();
    assert_eq!(paragraphs.len(), 1);
    system.replacen(paragraphs[0], replacement, 1)
}
