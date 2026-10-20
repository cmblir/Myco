//! Replace output representation only; retain original semantic instructions.

use super::{wire, DecoderCompactQa, Packet, VERSION};
use serde_json::Value;

const NATIVE_SYNTAX: &str = "Return only complete WikiClaimsV1 JSON with outcome and claims, without Markdown. outcome=claims requires nonempty claims. Each claim has action, anchorSpanId, supportSpanIds, actor {role,basis,subjectSpanId}, eventTime {value,basis,precision,uncertainty,supportSpanId}, speechAct, status, verificationId. Use only actual supplied span IDs; supportSpanIds must be unique and include anchorSpanId.";
const COMPACT_SYNTAX: &str = "Return only complete WikiClaimsCompactQaV1 JSON with version, packetSha256, outcome and claims, without Markdown. version is exactly WikiClaimsCompactQaV1 and packetSha256 is exactly the complete value supplied in the current input packet. outcome=claims requires nonempty claims. Each claim is an exact eight-slot tuple [action,anchorOrdinal,supportOrdinals,[role,basis,subjectOrdinal],[value,basis,precision,uncertainty,timeSupportOrdinal],speechAct,status,null]. All ordinals are integers from the actual supplied spanOrdinalDictionary; supportOrdinals must be unique and include anchorOrdinal. Nullable subjectOrdinal and timeSupportOrdinal use null rather than a guessed ordinal. The semantic field names in the following policy refer to the unchanged native expansion of these tuple slots: anchorSpanId/supportSpanIds/subjectSpanId/supportSpanId resolve through the supplied ordinal dictionary; actor, eventTime, speechAct, status, verificationId retain their original meanings.";
pub(super) const EMPTY_NATIVE: &str = r#"{"outcome":"insufficient_evidence","claims":[]}"#;
pub(super) const INPUT_MARKER: &str =
    "Fictional schema demonstration input (not current evidence):\n";
pub(super) const OUTPUT_MARKER: &str =
    "\nFictional schema demonstration output (not current answer):\n";
pub(super) const END_MARKER: &str = "\nEnd fictional schema demonstration.";

pub(super) fn empty_output(decoder: DecoderCompactQa) -> String {
    format!(
        r#"{{"version":"{VERSION}","packetSha256":"{}","outcome":"insufficient_evidence","claims":[]}}"#,
        decoder.digest_hex()
    )
}

pub(super) fn prepare(system: &str, decoder: DecoderCompactQa) -> Result<String, String> {
    for marker in [
        NATIVE_SYNTAX,
        EMPTY_NATIVE,
        INPUT_MARKER,
        OUTPUT_MARKER,
        END_MARKER,
    ] {
        if system.matches(marker).count() != 1 {
            return Err(
                "compact QA original system syntax or demonstration boundary changed".into(),
            );
        }
    }
    let empty_compact = empty_output(decoder);
    let rewritten =
        system
            .replacen(NATIVE_SYNTAX, COMPACT_SYNTAX, 1)
            .replacen(EMPTY_NATIVE, &empty_compact, 1);
    let (before, demonstration) = rewritten
        .split_once(INPUT_MARKER)
        .ok_or("compact QA fictional input marker is missing")?;
    let (input, output) = demonstration
        .split_once(OUTPUT_MARKER)
        .ok_or("compact QA fictional output marker is missing")?;
    let (output, after) = output
        .split_once(END_MARKER)
        .ok_or("compact QA fictional demonstration end is missing")?;
    let mut input: Value = serde_json::from_str(input)
        .map_err(|error| format!("invalid compact QA fictional original packet: {error}"))?;
    let span_ids: Vec<_> = input["originalSpans"]
        .as_array()
        .ok_or("compact QA fictional packet lacks originals")?
        .iter()
        .map(|span| {
            span["id"]
                .as_str()
                .map(str::to_owned)
                .ok_or("compact QA fictional original lacks its identity")
        })
        .collect::<Result<_, _>>()?;
    input
        .as_object_mut()
        .ok_or("compact QA fictional packet must be an object")?
        .insert("allowedSpanIds".into(), serde_json::json!(span_ids));
    let original = serde_json::to_string(&input)
        .map_err(|error| format!("serialize compact QA fictional original packet: {error}"))?;
    let packet = Packet::capture(&original)?;
    let compact_input = packet.augmented_user()?;
    let compact_output = wire::encode_native(&packet, output)?;
    Ok(format!(
        "{before}{INPUT_MARKER}{compact_input}{OUTPUT_MARKER}{compact_output}{END_MARKER}{after}"
    ))
}
