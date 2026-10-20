//! Native-input-bound review syntax. This contract grants no source access,
//! semantic acceptance, compilation completion or publication authority.

use super::materializer::MaterializedSessionV1;
use super::schema::NativeClaim;
use super::sources::PacketPlan;
use crate::importers::wikify::source_revision;
use crate::wiki_claims::SourceSet;
use std::fmt;

/// No Deserialize or public constructor: only the native compiler issues IDs.
pub(crate) struct SessionReviewDecode {
    grammar: String,
    system: String,
    user: String,
}

impl fmt::Debug for SessionReviewDecode {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("SessionReviewDecode")
            .field("grammar_sha256", &self.grammar_sha256())
            .field("system_sha256", &source_revision(&self.system))
            .field("user_sha256", &source_revision(&self.user))
            .finish_non_exhaustive()
    }
}

impl SessionReviewDecode {
    /// Read the exact source-review instruction bound by the native issuer.
    pub(crate) fn system(&self) -> &str {
        &self.system
    }

    /// Read the exact input without issuing source or publication authority.
    pub(crate) fn user(&self) -> &str {
        &self.user
    }

    pub(crate) fn grammar(&self) -> &str {
        &self.grammar
    }

    /// Bind decoder observations to the actual native-issued grammar bytes.
    pub(crate) fn grammar_sha256(&self) -> String {
        source_revision(&self.grammar)
    }

    pub(crate) fn matches_input(&self, system: &str, user: &str) -> bool {
        source_revision(system) == source_revision(&self.system)
            && source_revision(user) == source_revision(&self.user)
    }

    /// Issue only after fresh native claim binding and private materialization.
    pub(in crate::session_compile) fn issue(
        plan: &PacketPlan,
        lang: &str,
        packet: &SourceSet,
        claims: &[NativeClaim],
        compilation: &MaterializedSessionV1,
    ) -> Result<Self, String> {
        let spans = packet.spans().collect::<Vec<_>>();
        if !matches!(lang, "ko" | "en" | "ja")
            || lang != plan.language
            || spans.len() != 1
            || spans.iter().any(|span| {
                span.source_revision() != plan.source.source_revision
                    || span.source_path() != plan.source.raw_path
                    || !plan.windows.iter().any(|window| {
                        window.id == span.id()
                            && window.speaker == span.speaker()
                            && window.turn_time.as_deref() == span.turn_time()
                    })
            })
            || claims.iter().any(|claim| {
                !claim.claim.structure_checked
                    || claim.claim.provenance.is_empty()
                    || claim
                        .claim
                        .provenance
                        .iter()
                        .any(|bound| !spans.contains(&bound))
            })
        {
            return Err("native session-review input does not match its packet plan".into());
        }
        let claim_ids = claims
            .iter()
            .map(|claim| claim.id.clone())
            .collect::<Vec<_>>();
        let view = compilation.as_view();
        if view.summaries.len() != claims.len()
            || view
                .summaries
                .iter()
                .zip(claims)
                .any(|(summary, claim)| summary.claim_id != claim.id)
        {
            return Err("native session-review materialization does not match fresh claims".into());
        }
        let expression_ids = super::schema::review_item_ids(view);
        let span_ids = spans
            .iter()
            .map(|span| span.id().to_owned())
            .collect::<Vec<_>>();
        Ok(Self {
            grammar: native_grammar(&claim_ids, &expression_ids, &span_ids)?,
            system: super::review::SYSTEM.into(),
            user: super::review::payload(plan, lang, packet, claims, view)?,
        })
    }
}

#[cfg(test)]
const LEGACY_REASON_RULES: &str = r#"reason ::= "\"" char{1,128} "\""
char ::= [^"\\\x00-\x1F] | "\\" (["\\/bfnrt] | "u" [0-9a-fA-F]{4})
"#;

// Each repetition decodes to one scalar, including a paired UTF-16 escape.
// Whitespace-only reasons remain invalid at the separate native review guard.
const NATIVE_REASON_RULES: &str = r#"reason ::= "\"" reason-char{1,128} "\""
reason-char ::= [\x20-\x21\x23-\x5B\x5D-\x7E\u00A0-\uD7FF\uE000-\U0010FFFF] | "\\" ["\\/] | "\\u" bmp | "\\u" [dD] [89a-bA-B] hex hex "\\u" [dD] [c-fC-F] hex hex
bmp ::= "00" ([2-6] hex | "7" [0-9a-eA-E] | [a-fA-F] hex) | "0" [1-9a-fA-F] hex hex | [1-9a-cA-Ce-fE-F] hex{3} | [dD] [0-7] hex hex
hex ::= [0-9a-fA-F]
"#;

#[cfg(test)]
pub(super) fn grammar(
    claims: &[String],
    expressions: &[String],
    spans: &[String],
) -> Result<String, String> {
    closed_grammar(claims, expressions, spans, LEGACY_REASON_RULES)
}

fn native_grammar(
    claims: &[String],
    expressions: &[String],
    spans: &[String],
) -> Result<String, String> {
    closed_grammar(claims, expressions, spans, NATIVE_REASON_RULES)
}

fn closed_grammar(
    claims: &[String],
    expressions: &[String],
    spans: &[String],
    reason_rules: &str,
) -> Result<String, String> {
    use std::collections::BTreeSet;
    let all: Vec<_> = claims.iter().chain(expressions).chain(spans).collect();
    if claims.len() > 16
        || expressions.len() > 25
        || spans.len() != 1
        || all.iter().any(|id| {
            !(1..=64).contains(&id.len())
                || !id
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
        })
        || all.iter().copied().collect::<BTreeSet<_>>().len() != all.len()
    {
        return Err("invalid native session-review QA decision contract".into());
    }
    let mut rules = String::from(
        r#"root ::= "{\"version\":\"SessionReviewV1\",\"claims\":" ws claims ",\"expressions\":" ws expressions ",\"missingSpanIds\":" ws tail "}" ws
tail ::= empty ",\"sourceCoverage\":" ws "\"covered\"" | missing ",\"sourceCoverage\":" ws other-coverage
empty ::= "[" ws "]"
missing ::= "[" ws (span-id)? "]"
other-coverage ::= "\"missing\"" | "\"uncertain\""
disposition ::= "\"supported\"" | "\"unsupported\"" | "\"uncertain\""
"#,
    );
    rules.push_str(reason_rules);
    rules.push_str(
        r#"ws ::= [ \t\n\r]{0,8}
"#,
    );
    // JSON-string content is quoted again as a GBNF terminal; rule names use
    // only internal indices, never source-controlled text.
    let terminal = |id: &str| -> Result<String, String> {
        serde_json::to_string(&serde_json::to_string(id).map_err(|error| error.to_string())?)
            .map_err(|error| error.to_string())
    };
    rules.push_str(&format!("span-id ::= {}\n", terminal(&spans[0])?));
    for (group, ids) in [("claims", claims), ("expressions", expressions)] {
        let decisions = (0..ids.len())
            .map(|index| format!("{group}-{index}"))
            .collect::<Vec<_>>()
            .join(" \",\" ws ");
        rules.push_str(&format!("{group} ::= \"[\" ws {decisions} \"]\"\n"));
        for (index, id) in ids.iter().enumerate() {
            rules.push_str(&format!(
                "{group}-{index} ::= \"{{\\\"id\\\":\" ws {} \",\\\"disposition\\\":\" ws disposition \",\\\"reason\\\":\" ws reason \"}}\"\n",
                terminal(id)?
            ));
        }
    }
    Ok(rules)
}

#[cfg(test)]
#[path = "review_decode_tests.rs"]
pub(crate) mod tests;
