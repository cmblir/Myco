//! Closed source/answer bindings; preparation never tokenizes or generates.

use super::*;
use std::collections::BTreeMap;

pub(super) const CASE_COUNT: usize = 16;
const STOP: &str = "reviewer_qualification_input_prepared";
const RUNTIME_SHA: &str = "e4c91504befb91caceed75ac90b1f6342e21fa5104cfe8a6e8051e1bcd36139c";
const ORIGINAL_FIELDS: [&str; 14] = [
    "id",
    "sourceId",
    "sourcePath",
    "selectionPath",
    "sourceRevision",
    "recordTime",
    "start",
    "end",
    "sha256",
    "text",
    "turnId",
    "speaker",
    "turnTime",
    "sourcePhase",
];
const FALSE_FLAGS: [&str; 5] = [
    "native_io_authenticated",
    "product_role_authorized",
    "semantic_accepted",
    "production_accepted",
    "activityContractAccepted",
];

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct Wire {
    pub(super) system: String,
    pub(super) user: String,
}

pub(super) fn expected_ids() -> Vec<String> {
    (1..=8)
        .flat_map(|family| (1..=2).map(move |proposal| format!("F{family:02}-P{proposal:02}")))
        .collect()
}

fn metadata(case: &qualification::PreparedReviewCase) -> Result<Value, String> {
    let value = case.metadata();
    let object = value
        .as_object()
        .ok_or("qualification metadata object absent")?;
    let fields = [
        "caseId",
        "familyId",
        "proposalId",
        "fixedDraftSha256",
        "originalSpans",
        "context",
        "contextRevision",
        "declaredRecordPeriodContext",
        "sourcePacketRevision",
    ];
    if object.len() != fields.len() + FALSE_FLAGS.len()
        || fields.iter().any(|key| !object.contains_key(*key))
        || FALSE_FLAGS.iter().any(|key| value[*key] != false)
        || value["caseId"] != case.id()
        || value["familyId"] != case.family_id()
        || value["proposalId"] != case.proposal_id()
        || value["fixedDraftSha256"] != hash(case.raw_draft())
    {
        return Err(
            "qualification metadata identity, raw draft or authority fields changed".into(),
        );
    }
    let spans = value["originalSpans"]
        .as_array()
        .ok_or("qualification originals absent")?;
    if spans.len() != case.original_count()
        || spans.iter().any(|span| {
            span.as_object().map_or(true, |row| {
                row.len() != ORIGINAL_FIELDS.len()
                    || ORIGINAL_FIELDS.iter().any(|key| !row.contains_key(*key))
            })
        })
    {
        return Err("qualification fourteen-field original membership changed".into());
    }
    Ok(value)
}

pub(super) fn check_wire(
    case: &qualification::PreparedReviewCase,
    wire: &Wire,
) -> Result<(), String> {
    let meta = metadata(case)?;
    let payload: Value = serde_json::from_str(&wire.user).map_err(|error| error.to_string())?;
    let keys = [
        "context",
        "contextRevision",
        "answer",
        "answerInputRevision",
        "originalSpans",
        "citations",
        "independentVerificationReceipts",
    ];
    let object = payload
        .as_object()
        .ok_or("qualification reviewer object absent")?;
    if object.len() != keys.len()
        || keys.iter().any(|key| !object.contains_key(*key))
        || payload["originalSpans"] != meta["originalSpans"]
        || payload["context"] != meta["context"]
        || payload["contextRevision"] != meta["contextRevision"]
        || payload["context"]["answerReviewQualificationQa"]["declaredRecordPeriodContext"]
            != meta["declaredRecordPeriodContext"]
        || payload["answerInputRevision"] != meta["fixedDraftSha256"]
        || payload["independentVerificationReceipts"] != json!([])
    {
        return Err("qualification actual flat reviewer source/context/raw binding changed".into());
    }
    let draft: Value = serde_json::from_str(case.raw_draft()).map_err(|error| error.to_string())?;
    let raw_answer = draft["answer"]
        .as_str()
        .ok_or("qualification fixed answer absent")?
        .trim();
    // All sixteen frozen answers are link-free and use the current factored view.
    if raw_answer.contains("[[")
        || raw_answer.contains("]]")
        || payload["answer"]
            != json!({"proseWithoutModelLinkLabels":raw_answer,"sourceIds":draft["sources"]})
    {
        return Err("qualification answer view differs from its exact factored fixed draft".into());
    }
    Ok(())
}

fn capture(case: &qualification::PreparedReviewCase) -> Result<Wire, String> {
    let captured = RefCell::new(None);
    let generated = Cell::new(false);
    let result = case.run(
        |system, user| {
            if captured.borrow().is_some() {
                return Err("qualification preparation repeated".into());
            }
            let wire = Wire {
                system: system.into(),
                user: user.into(),
            };
            check_wire(case, &wire)?;
            *captured.borrow_mut() = Some(wire);
            // The real existing reviewer prepares this packet; no count value is fabricated.
            Err(STOP.into())
        },
        |_, _, _, _, _| {
            generated.set(true);
            Err("qualification preparation cannot generate".into())
        },
    );
    if generated.get()
        || !result.as_ref().is_err_and(|error| {
            error.code == "review_unavailable"
                && error.detail == format!("review_unavailable: {STOP}")
        })
    {
        return Err(format!(
            "qualification preflight did not stop at first count: {}",
            case.id()
        ));
    }
    captured
        .into_inner()
        .ok_or_else(|| "qualification prepared input absent".into())
}

pub(super) fn common_payload(wire: &Wire) -> Result<Value, String> {
    let mut value: Value = serde_json::from_str(&wire.user).map_err(|error| error.to_string())?;
    let object = value
        .as_object_mut()
        .ok_or("qualification common view absent")?;
    if object.remove("answer").is_none() || object.remove("answerInputRevision").is_none() {
        return Err("qualification common view lacks answer fields".into());
    }
    Ok(value)
}

pub(super) fn prepare_inputs(
    cases: &[qualification::PreparedReviewCase],
) -> Result<Vec<Wire>, String> {
    if qualification::RUNTIME_SHA256 != RUNTIME_SHA
        || cases.len() != CASE_COUNT
        || cases
            .iter()
            .map(|case| case.id())
            .ne(expected_ids().iter().map(String::as_str))
    {
        return Err("qualification frozen runtime or sixteen-case schedule changed".into());
    }
    let mut unique = BTreeMap::new();
    let mut bound = 0usize;
    let mut wires = Vec::new();
    for case in cases {
        let meta = metadata(case)?;
        for span in meta["originalSpans"]
            .as_array()
            .ok_or("qualification original array absent")?
        {
            let id = span["id"]
                .as_str()
                .ok_or("qualification original ID absent")?
                .to_owned();
            if unique
                .insert(id, span.clone())
                .is_some_and(|prior| prior != *span)
            {
                return Err("qualification reused original ID changed its fourteen fields".into());
            }
        }
        bound += case.original_count();
        wires.push(capture(case)?);
    }
    if bound != 52 || unique.len() != 26 {
        return Err("qualification bound original inventory changed".into());
    }
    for (family, pair) in cases.chunks_exact(2).enumerate() {
        let first = family * 2;
        if pair[0].family_id() != pair[1].family_id()
            || wires[first].system != wires[first + 1].system
            || common_payload(&wires[first])? != common_payload(&wires[first + 1])?
        {
            return Err(
                "qualification family variants changed shared SYSTEM/source/context".into(),
            );
        }
    }
    Ok(wires)
}
