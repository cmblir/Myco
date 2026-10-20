//! Packet-bound compact syntax; source and meaning checks remain separate.

const FIELDS: &str = r#"
claim ::= "[" ws action "," ws ordinal "," ws "[" ws ordinal ("," ws ordinal){0,7} "]," ws actor "," ws time "," ws speech-status "," ws "null]"
actor ::= "[" ws (role "," ws "\"speaker\"," ws "null" | known-role "," ws "\"explicit_subject\"," ws ordinal | "\"unknown\"," ws "\"unknown\"," ws "null") "]"
role ::= known-role | "\"unknown\""
known-role ::= "\"user\"" | "\"assistant\"" | "\"system\"" | "\"tool\"" | "\"source\""
time ::= "[" ws ("null," ws "\"unknown\"," ws "\"unknown\"," ws "\"unknown\"," ws "null" | day-value "," ws day-basis "," ws ordinal | instant-value "," ws instant-basis "," ws ordinal) "]"
day-value ::= "\"" char{10} "\""
instant-value ::= "\"" (char{1,9} | char{11,64}) "\""
day-basis ::= "\"explicit\"," ws "\"day\"," ws "\"specified\"" | inferred-basis "," ws "\"day\"," ws "\"inferred\""
instant-basis ::= "\"explicit\"," ws "\"instant\"," ws "\"specified\"" | inferred-basis "," ws "\"instant\"," ws "\"inferred\""
inferred-basis ::= "\"inferred_from_turn\"" | "\"date_reference\""
speech-status ::= ("\"unknown\"" | "\"question\"") unknown-status | "\"request\"" request-status | "\"plan\"" plan-status | "\"report\"" report-status | "\"verification\"" verification-status | "\"retraction\"" retraction-status
unknown-status ::= "," ws "\"unknown\""
request-status ::= "," ws ("\"unknown\"" | "\"requested\"")
plan-status ::= "," ws ("\"unknown\"" | "\"planned\"")
report-status ::= "," ws ("\"unknown\"" | "\"in_progress\"" | "\"reported_completed\"" | "\"reported_failed\"" | "\"reported_cancelled\"" | "\"reported_rolled_back\"")
verification-status ::= "," ws ("\"unknown\"" | "\"reported_completed\"" | "\"reported_failed\"")
retraction-status ::= "," ws ("\"unknown\"" | "\"retracted\"" | "\"reported_cancelled\"" | "\"reported_rolled_back\"")
action ::= "\"" char{1,512} "\""
char ::= [^"\\\x00-\x1F] | "\\" (["\\/bfnrt] | "u" [0-9a-fA-F]{4})
ws ::= [ \t\n\r]{0,8}
"#;

pub(super) fn grammar(packet_sha256: &str, span_count: u8) -> String {
    let prefix = format!(
        "{{\"version\":\"{}\",\"packetSha256\":\"{packet_sha256}\",\"outcome\":",
        super::VERSION
    );
    let literal = serde_json::to_string(&prefix).expect("fixed compact QA grammar literal");
    let ordinals = (0..span_count)
        .map(|ordinal| format!("\"{ordinal}\""))
        .collect::<Vec<_>>()
        .join(" | ");
    format!(
        r#"root ::= {literal} ws ("\"claims\",\"claims\":" ws "[" ws claim ("," ws claim){{0,15}} "]}}" | "\"insufficient_evidence\",\"claims\":" ws "[" ws "]}}") ws
ordinal ::= {ordinals}
{FIELDS}"#
    )
}
