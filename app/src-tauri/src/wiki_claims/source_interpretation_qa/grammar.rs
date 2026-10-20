//! QA-only syntax over the exact captured positional original-unit count.

const FIELDS: &str = r#"
unit ::= "{\"relevance\":" ws ("\"relevant\",\"interpretations\":" ws "[" ws interpretation ("," ws interpretation){0,15} "]}" | ("\"not_relevant\"" | "\"uncertain\"") ",\"interpretations\":" ws "[" ws "]}")
interpretation ::= "{\"focusQuote\":" ws focus ",\"supportSpanIds\":" ws "[" ws id ("," ws id){0,7} "],\"actor\":" ws actor ",\"eventTime\":" ws time ",\"speechAct\":" ws speech-status ",\"assertionKind\":" ws assertion-kind ",\"verificationId\":" ws "null}"
actor ::= "{\"role\":" ws (role ",\"basis\":" ws "\"speaker\",\"subjectSpanId\":" ws "null" | known-role ",\"basis\":" ws "\"explicit_subject\",\"subjectSpanId\":" ws id | "\"unknown\",\"basis\":" ws "\"unknown\",\"subjectSpanId\":" ws "null") "}"
role ::= known-role | "\"unknown\""
known-role ::= "\"user\"" | "\"assistant\"" | "\"system\"" | "\"tool\"" | "\"source\""
time ::= "{\"value\":" ws ("null,\"basis\":" ws "\"unknown\",\"precision\":" ws "\"unknown\",\"uncertainty\":" ws "\"unknown\",\"supportSpanId\":" ws "null" | day-value ",\"basis\":" ws day-basis ",\"supportSpanId\":" ws id | instant-value ",\"basis\":" ws instant-basis ",\"supportSpanId\":" ws id) "}"
day-value ::= "\"" scalar{10} "\""
instant-value ::= "\"" (scalar{1,9} | scalar{11,64}) "\""
day-basis ::= "\"explicit\",\"precision\":" ws "\"day\",\"uncertainty\":" ws "\"specified\"" | inferred-basis ",\"precision\":" ws "\"day\",\"uncertainty\":" ws "\"inferred\""
instant-basis ::= "\"explicit\",\"precision\":" ws "\"instant\",\"uncertainty\":" ws "\"specified\"" | inferred-basis ",\"precision\":" ws "\"instant\",\"uncertainty\":" ws "\"inferred\""
inferred-basis ::= "\"inferred_from_turn\"" | "\"date_reference\""
speech-status ::= ("\"unknown\"" | "\"question\"") unknown-status | "\"request\"" request-status | "\"plan\"" plan-status | "\"report\"" report-status | "\"verification\"" verification-status | "\"retraction\"" retraction-status
unknown-status ::= ",\"status\":" ws "\"unknown\""
request-status ::= ",\"status\":" ws ("\"unknown\"" | "\"requested\"")
plan-status ::= ",\"status\":" ws ("\"unknown\"" | "\"planned\"")
report-status ::= ",\"status\":" ws ("\"unknown\"" | "\"in_progress\"" | "\"reported_completed\"" | "\"reported_failed\"" | "\"reported_cancelled\"" | "\"reported_rolled_back\"")
verification-status ::= ",\"status\":" ws ("\"unknown\"" | "\"reported_completed\"" | "\"reported_failed\"")
retraction-status ::= ",\"status\":" ws ("\"unknown\"" | "\"retracted\"" | "\"reported_cancelled\"" | "\"reported_rolled_back\"")
assertion-kind ::= "\"asserted_occurrence\"" | "\"explicit_nonoccurrence\"" | "\"intention\"" | "\"record_or_verification_limit\"" | "\"uncertain\""
id ::= "\"" [A-Za-z0-9_-]{1,64} "\""
focus ::= "\"" focus-64{0,31} scalar{1,64} "\""
focus-64 ::= scalar{64}
scalar ::= [\x20-\x21\x23-\x5B\x5D-\uD7FF\uE000-\U0010FFFF] | "\\" ["\\/bfnrt] | "\\u" bmp | "\\u" [dD] [89a-bA-B] hex hex "\\u" [dD] [c-fC-F] hex hex
bmp ::= [0-9a-cA-Ce-fE-F] hex{3} | [dD] [0-7] hex hex
hex ::= [0-9a-fA-F]
ws ::= [ \t\n\r]{0,8}
"#;

/// Fix positional rows before decoding; native binding still checks IDs,
/// uniqueness, total interpretations, exact focus and source context.
/// JSON escapes may represent original controls; a surrogate pair is one scalar.
/// Meaning and coverage require a separate original-source review.
pub(super) fn grammar(unit_count: usize) -> String {
    assert!(
        (1..=16).contains(&unit_count),
        "source interpretation QA requires 1 to 16 original units"
    );
    let mut grammar = String::from(
        r#"root ::= "{\"version\":\"NativeSourceInterpretationQaV1\",\"units\":" ws "[" ws "#,
    );
    grammar.push_str(
        &(0..unit_count)
            .map(|_| "unit")
            .collect::<Vec<_>>()
            .join(" \",\" ws "),
    );
    grammar.push_str(r#" "]}" ws"#);
    grammar.push_str(FIELDS);
    grammar
}
