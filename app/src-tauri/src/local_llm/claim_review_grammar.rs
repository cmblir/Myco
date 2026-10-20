//! Exact decision syntax only; this contract confers no source or role authority.

const FIELDS: &str = r#"
disposition ::= "\"supported\"" | "\"unsupported\"" | "\"uncertain\""
coverage ::= "\"covered\"" | "\"missing\"" | "\"uncertain\""
id ::= "\"" [A-Za-z0-9_-]{1,64} "\""
reason ::= "\"" char{1,128} "\""
char ::= [^"\\\x00-\x1F] | "\\" (["\\/bfnrt] | "u" [0-9a-fA-F]{4})
ws ::= [ \t\n\r]{0,8}
"#;

/// Bounded app-issued C-index decisions, without caller-provided grammar or IDs.
/// Native source/permission checks and verdict validation remain mandatory.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ReviewDecisions {
    count: u8,
}

impl ReviewDecisions {
    pub(crate) fn new(count: usize) -> Result<Self, &'static str> {
        if count > 16 {
            return Err("claim review requires at most 16 decisions");
        }
        Ok(Self { count: count as u8 })
    }

    /// Exact number of decisions required by this decode contract.
    pub fn count(self) -> usize {
        usize::from(self.count)
    }

    pub(super) fn grammar(self) -> String {
        let mut grammar =
            String::from(r#"root ::= "{\"version\":\"WikiClaimReviewV1\",\"claims\":" ws "[" ws "#);
        grammar.push_str(
            &(0..self.count())
                .map(|index| format!("decision{index}"))
                .collect::<Vec<_>>()
                .join(" \",\" ws "),
        );
        grammar.push_str(r#" "],\"missingSpanIds\":" ws "[" ws (id ("," ws id){0,7})? "],\"sourceCoverage\":" ws coverage "}" ws"#);
        grammar.push('\n');
        for index in 0..self.count() {
            grammar.push_str(&format!("decision{index} ::= \"{{\\\"id\\\":\" ws \"\\\"C{index}\\\"\" \",\\\"disposition\\\":\" ws disposition \",\\\"reason\\\":\" ws reason \"}}\"\n"));
        }
        grammar.push_str(FIELDS);
        grammar
    }

    // Keep the production grammar above byte-identical for the paired QA trial.
    // Only key order differs; counts, JSON fields and native validation do not.
    #[cfg(feature = "native-index-probe")]
    pub(super) fn reason_first_qa_grammar(self) -> String {
        let mut grammar =
            String::from(r#"root ::= "{\"version\":\"WikiClaimReviewV1\",\"claims\":" ws "[" ws "#);
        grammar.push_str(
            &(0..self.count())
                .map(|index| format!("decision{index}"))
                .collect::<Vec<_>>()
                .join(" \",\" ws "),
        );
        grammar.push_str(r#" "],\"sourceCoverage\":" ws coverage ",\"missingSpanIds\":" ws "[" ws (id ("," ws id){0,7})? "]}" ws"#);
        grammar.push('\n');
        for index in 0..self.count() {
            grammar.push_str(&format!("decision{index} ::= \"{{\\\"id\\\":\" ws \"\\\"C{index}\\\"\" \",\\\"reason\\\":\" ws reason \",\\\"disposition\\\":\" ws disposition \"}}\"\n"));
        }
        grammar.push_str(FIELDS);
        grammar
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decision_count_is_bounded_before_any_model_access() {
        for count in 0..=16 {
            assert_eq!(ReviewDecisions::new(count).unwrap().count(), count);
        }
        assert!(ReviewDecisions::new(17).is_err());
        assert!(ReviewDecisions::new(usize::MAX).is_err());
    }
}
