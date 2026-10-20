//! Metadata-bound QA syntax; grammar admission never establishes source meaning.

use super::focus_claims_qa::Encoding;
use crate::wiki_claims::ActorRole;
use std::fmt::Write;

const OUTCOMES: &str = r#"("\"claims\",\"claims\":" ws "[" ws claim ("," ws claim){0,15} "]}" | "\"insufficient_evidence\",\"claims\":" ws "[" ws "]}") ws"#;
const FIELDS: &str = r#"
limit-kind ::= "\"explicit_nonoccurrence\"" | "\"record_or_verification_limit\""
limit-speech ::= "\"report\"," ws "\"unknown\""
intention-speech ::= "\"request\"," ws ("\"requested\"" | "\"unknown\"") | "\"plan\"," ws ("\"planned\"" | "\"unknown\"")
uncertain-speech ::= ("\"unknown\"" | "\"question\"") "," ws "\"unknown\""
occurrence-speech ::= "\"report\"," ws report-status | "\"retraction\"," ws retraction-status
report-status ::= "\"unknown\"" | "\"in_progress\"" | "\"reported_completed\"" | "\"reported_failed\"" | "\"reported_cancelled\"" | "\"reported_rolled_back\""
retraction-status ::= "\"unknown\"" | "\"retracted\"" | "\"reported_cancelled\"" | "\"reported_rolled_back\""
known-role ::= "\"user\"" | "\"assistant\"" | "\"system\"" | "\"tool\"" | "\"source\""
focus ::= "\"" char{1,512} "\""
day-value ::= "\"" [0-9]{4} "-" ("0" [1-9] | "1" [0-2]) "-" ("0" [1-9] | [12] [0-9] | "3" [01]) "\""
instant-value ::= "\"" [0-9]{4} "-" ("0" [1-9] | "1" [0-2]) "-" ("0" [1-9] | [12] [0-9] | "3" [01]) [Tt] ([01] [0-9] | "2" [0-3]) ":" [0-5] [0-9] ":" [0-5] [0-9] ([Zz] | "." [0-9]{1,43} [Zz] | [+-] ([01] [0-9] | "2" [0-3]) ":" [0-5] [0-9] | "." [0-9]{1,38} [+-] ([01] [0-9] | "2" [0-3]) ":" [0-5] [0-9]) "\""
day-basis ::= "\"explicit\"," ws "\"day\"," ws "\"specified\"" | inferred-basis "," ws "\"day\"," ws "\"inferred\""
instant-basis ::= "\"explicit\"," ws "\"instant\"," ws "\"specified\"" | inferred-basis "," ws "\"instant\"," ws "\"inferred\""
inferred-basis ::= "\"inferred_from_turn\"" | "\"date_reference\""
char ::= [^"\\\x00-\x1F] | "\\" (["\\/bfnrt] | "u" [0-9a-fA-F]{4})
ws ::= [ \t\n\r]{0,8}
"#;

const NAMED_FIELDS: &str = r#"
limit-speech ::= "\"report\",\"status\":" ws "\"unknown\""
intention-speech ::= "\"request\",\"status\":" ws ("\"requested\"" | "\"unknown\"") | "\"plan\",\"status\":" ws ("\"planned\"" | "\"unknown\"")
uncertain-speech ::= ("\"unknown\"" | "\"question\"") ",\"status\":" ws "\"unknown\""
occurrence-speech ::= "\"report\",\"status\":" ws report-status | "\"retraction\",\"status\":" ws retraction-status
day-basis ::= "\"explicit\",\"precision\":" ws "\"day\",\"uncertainty\":" ws "\"specified\"" | inferred-basis ",\"precision\":" ws "\"day\",\"uncertainty\":" ws "\"inferred\""
instant-basis ::= "\"explicit\",\"precision\":" ws "\"instant\",\"uncertainty\":" ws "\"specified\"" | inferred-basis ",\"precision\":" ws "\"instant\",\"uncertainty\":" ws "\"inferred\""
"#;

/// Capture-issued metadata restricts references without selecting an actor,
/// inferring dates, interpreting a quotation or issuing a review receipt.
pub(super) fn grammar(packet_sha256: &str, speakers: &[ActorRole], encoding: Encoding) -> String {
    assert!(
        (1..=8).contains(&speakers.len()),
        "invalid focus QA original count"
    );
    assert!(
        packet_sha256.len() == 64
            && packet_sha256
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)),
        "invalid focus QA complete packet digest"
    );
    let version = encoding.wire_version();
    let prefix =
        format!("{{\"version\":\"{version}\",\"packetSha256\":\"{packet_sha256}\",\"outcome\":");
    let mut rules = format!("root ::= {} ws {OUTCOMES}\n", terminal(&prefix));
    let anchors = (0..speakers.len())
        .map(|anchor| format!("anchor-{anchor}"))
        .collect::<Vec<_>>();
    rule(
        &mut rules,
        "claim",
        &format!(
            "{} ws ({})",
            terminal(match encoding {
                Encoding::TupleV1 => "[",
                Encoding::NamedV1 => "{\"anchorOrdinal\":",
            }),
            anchors.join(" | ")
        ),
    );
    let bound = 1_u16 << speakers.len();
    for mask in 1..bound {
        mask_fields(&mut rules, mask, speakers.len(), encoding);
    }
    for (anchor, speaker) in speakers.iter().enumerate() {
        anchor_fields(&mut rules, anchor, speakers.len(), encoding);
        for mask in 1..bound {
            support_state(&mut rules, anchor, mask, speakers.len(), encoding);
            if mask & (1_u16 << anchor) != 0 {
                actor(&mut rules, anchor, mask, *speaker, encoding);
            }
        }
    }
    for line in FIELDS.lines() {
        let replacement = if encoding == Encoding::NamedV1 {
            let name = line.split(" ::=").next().unwrap_or(line);
            NAMED_FIELDS
                .lines()
                .find(|candidate| candidate.split(" ::=").next() == Some(name))
        } else {
            None
        };
        writeln!(rules, "{}", replacement.unwrap_or(line)).expect("write fixed focus QA fields");
    }
    rules
}

fn anchor_fields(rules: &mut String, anchor: usize, count: usize, encoding: Encoding) {
    // The call consumes supports, actor and time. Its return resumes the chosen
    // kind's speech/status rule, so the support DFA is not copied per kind.
    let supported = format!("supported-{anchor}");
    let support_key = separator(encoding, "supportOrdinals");
    let speech_key = separator(encoding, "speechAct");
    let kinds = [
        format!("limit-kind {support_key} ws {supported} {speech_key} ws limit-speech"),
        format!(
            "{} {support_key} ws {supported} {speech_key} ws intention-speech",
            terminal("\"intention\"")
        ),
        format!(
            "{} {support_key} ws {supported} {speech_key} ws uncertain-speech",
            terminal("\"uncertain\"")
        ),
        format!(
            "{} {support_key} ws {supported} {speech_key} ws occurrence-speech",
            terminal("\"asserted_occurrence\"")
        ),
    ];
    rule(
        rules,
        &format!("anchor-{anchor}"),
        &format!(
            "{} ws focus {} ws ({}) {} ws {}",
            terminal(&match encoding {
                Encoding::TupleV1 => format!("{anchor},"),
                Encoding::NamedV1 => format!("{anchor},\"focusQuote\":"),
            }),
            separator(encoding, "assertionKind"),
            kinds.join(" | "),
            separator(encoding, "verificationId"),
            terminal(match encoding {
                Encoding::TupleV1 => "null]",
                Encoding::NamedV1 => "null}",
            }),
        ),
    );
    let starts = (0..count)
        .map(|ordinal| format!("\"{ordinal}\" ws supports-{anchor}-{}", 1_u16 << ordinal))
        .collect::<Vec<_>>();
    rule(
        rules,
        &supported,
        &format!("\"[\" ws ({})", starts.join(" | ")),
    );
}

fn support_state(rules: &mut String, anchor: usize, mask: u16, count: usize, encoding: Encoding) {
    let mut choices = (0..count)
        .filter(|ordinal| mask & (1_u16 << *ordinal) == 0)
        .map(|ordinal| {
            format!(
                "\",\" ws \"{ordinal}\" ws supports-{anchor}-{}",
                mask | (1_u16 << ordinal)
            )
        })
        .collect::<Vec<_>>();
    if mask & (1_u16 << anchor) != 0 {
        choices.push(format!(
            "{} ws actor-{anchor}-{mask} {} ws time-{mask}",
            terminal(match encoding {
                Encoding::TupleV1 => "],",
                Encoding::NamedV1 => "],\"actor\":",
            }),
            separator(encoding, "eventTime"),
        ));
    }
    // Every nonempty mask can continue to the anchor or close with it present.
    // Ordinals already in the mask have no transition, preserving all unique
    // support orders without enumerating their factorially many permutations.
    rule(
        rules,
        &format!("supports-{anchor}-{mask}"),
        &choices.join(" | "),
    );
}

fn mask_fields(rules: &mut String, mask: u16, count: usize, encoding: Encoding) {
    let ordinals = (0..count)
        .filter(|ordinal| mask & (1_u16 << *ordinal) != 0)
        .map(|ordinal| format!("\"{ordinal}\""))
        .collect::<Vec<_>>();
    rule(rules, &format!("ordinals-{mask}"), &ordinals.join(" | "));
    let expression = match encoding {
        Encoding::TupleV1 => format!(
            "\"[\" ws (\"null,\" ws \"\\\"unknown\\\",\" ws \"\\\"unknown\\\",\" ws \"\\\"unknown\\\",\" ws \"null\" | day-value \",\" ws day-basis \",\" ws ordinals-{mask} | instant-value \",\" ws instant-basis \",\" ws ordinals-{mask}) \"]\""
        ),
        Encoding::NamedV1 => format!(
            "{} ws ({} ws {} ws {} ws {} ws \"null\" | day-value {} ws day-basis {} ws ordinals-{mask} | instant-value {} ws instant-basis {} ws ordinals-{mask}) {}",
            terminal("{\"value\":"), terminal("null,\"basis\":"),
            terminal("\"unknown\",\"precision\":"), terminal("\"unknown\",\"uncertainty\":"),
            terminal("\"unknown\",\"timeSupportOrdinal\":"),
            separator(encoding, "basis"), separator(encoding, "timeSupportOrdinal"),
            separator(encoding, "basis"), separator(encoding, "timeSupportOrdinal"), terminal("}"),
        ),
    };
    rule(rules, &format!("time-{mask}"), &expression);
}

fn actor(rules: &mut String, anchor: usize, mask: u16, speaker: ActorRole, encoding: Encoding) {
    let role = serde_json::to_string(&speaker).expect("closed focus QA speaker enum");
    let expression = match encoding {
        Encoding::TupleV1 => format!(
            "\"[\" ws ({} \",\" ws \"\\\"speaker\\\",\" ws \"null\" | known-role \",\" ws \"\\\"explicit_subject\\\",\" ws ordinals-{mask} | \"\\\"unknown\\\",\" ws \"\\\"unknown\\\",\" ws \"null\") \"]\"", terminal(&role)
        ),
        Encoding::NamedV1 => format!(
            "{} ws ({} {} ws {} ws \"null\" | known-role {} ws {} ws ordinals-{mask} | {} ws {} ws \"null\") {}",
            terminal("{\"role\":"), terminal(&role), separator(encoding, "basis"),
            terminal("\"speaker\",\"subjectOrdinal\":"), separator(encoding, "basis"),
            terminal("\"explicit_subject\",\"subjectOrdinal\":"),
            terminal("\"unknown\",\"basis\":"), terminal("\"unknown\",\"subjectOrdinal\":"), terminal("}"),
        ),
    };
    rule(rules, &format!("actor-{anchor}-{mask}"), &expression);
}

fn separator(encoding: Encoding, key: &str) -> String {
    terminal(&match encoding {
        Encoding::TupleV1 => ",".into(),
        Encoding::NamedV1 => format!(",\"{key}\":"),
    })
}

fn terminal(value: &str) -> String {
    serde_json::to_string(value).expect("fixed focus QA grammar literal")
}

fn rule(rules: &mut String, name: &str, expression: &str) {
    writeln!(rules, "{name} ::= {expression}").expect("write focus QA grammar into String");
}
