//! Closed QA decode syntax only; it grants no source, role or publication authority.

/// Per-field observations for one proposed claim; source meaning remains unverified.
pub const FIELD_REVIEW_JSON_GRAMMAR: &str = r#"
root ::= "{\"version\":\"WikiClaimFieldReviewQaV1\",\"claimId\":" ws id ",\"actor\":" ws field ",\"action\":" ws field ",\"eventTime\":" ws field ",\"speechAct\":" ws field ",\"status\":" ws field ",\"reason\":" ws reason "}" ws
field ::= "{\"disposition\":" ws disposition ",\"reason\":" ws reason ",\"evidenceSpanIds\":" ws "[" ws (id ("," ws id){0,7})? "]}" ws
disposition ::= "\"supported\"" | "\"unsupported\"" | "\"uncertain\""
id ::= "\"" [A-Za-z0-9_-]{1,64} "\""
reason ::= "\"" char{1,128} "\""
char ::= [^"\\\x00-\x1F] | "\\" (["\\/bfnrt] | "u" [0-9a-fA-F]{4})
ws ::= [ \t\n\r]{0,8}
"#;

/// Whole-original coverage observations, without validating IDs or entailment.
pub const SOURCE_COVERAGE_JSON_GRAMMAR: &str = r#"
root ::= "{\"version\":\"WikiSourceCoverageQaV1\",\"sourceCoverage\":" ws coverage ",\"missingSpanIds\":" ws "[" ws (id ("," ws id){0,511})? "],\"reason\":" ws reason "}" ws
coverage ::= "\"covered\"" | "\"missing\"" | "\"uncertain\""
id ::= "\"" [A-Za-z0-9_-]{1,64} "\""
reason ::= "\"" char{1,128} "\""
char ::= [^"\\\x00-\x1F] | "\\" (["\\/bfnrt] | "u" [0-9a-fA-F]{4})
ws ::= [ \t\n\r]{0,8}
"#;
