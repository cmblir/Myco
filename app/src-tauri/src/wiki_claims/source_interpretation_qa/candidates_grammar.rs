//! Versioned QA representations derived from the unchanged V1 syntax.

use super::CandidateQa;

const SINGLE_KIND: &str = r#",\"assertionKind\":" ws assertion-kind"#;
const FACETS: &str =
    r#",\"assertionKinds\":" ws "[" ws assertion-kind ("," ws assertion-kind){0,4} "]""#;
const UNIT_PREFIX: &str = r#""{\"relevance\":"#;

/// Preserve V1 field, Unicode and status rules while changing only the candidate
/// representation. Facet uniqueness and full-source binding remain native checks.
pub(super) fn grammar(count: usize, variant: CandidateQa) -> String {
    let original = super::super::grammar::grammar(count);
    match variant {
        CandidateQa::FacetsV2 => {
            assert_eq!(original.matches(SINGLE_KIND).count(), 1);
            original
                .replace(
                    "NativeSourceInterpretationQaV1",
                    "NativeSourceInterpretationFacetsQaV2",
                )
                .replace(SINGLE_KIND, FACETS)
        }
        CandidateQa::OrdinalV3 => ordinal_grammar(&original, count),
    }
}

fn ordinal_grammar(original: &str, count: usize) -> String {
    let (root, fields) = original
        .split_once("\nunit ::= ")
        .expect("V1 grammar must have one positional unit rule");
    let (unit, remaining_fields) = fields
        .split_once('\n')
        .expect("V1 unit rule must precede the unchanged field rules");
    assert!(unit.starts_with(UNIT_PREFIX));
    let original_rows = (0..count)
        .map(|_| "unit")
        .collect::<Vec<_>>()
        .join(" \",\" ws ");
    let ordinal_rows = (0..count)
        .map(|ordinal| format!("unit-{ordinal}"))
        .collect::<Vec<_>>()
        .join(" \",\" ws ");
    let original_array = format!(r#""[" ws {original_rows} "]}}" ws"#);
    let ordinal_array = format!(r#""[" ws {ordinal_rows} "]}}" ws"#);
    assert_eq!(root.matches(&original_array).count(), 1);
    let mut grammar = root
        .replace(
            "NativeSourceInterpretationQaV1",
            "NativeSourceInterpretationOrdinalQaV3",
        )
        .replace(&original_array, &ordinal_array);
    for ordinal in 0..count {
        let prefix = format!(r#""{{\"unitOrdinal\":{ordinal},\"relevance\":"#);
        grammar.push_str(&format!(
            "\nunit-{ordinal} ::= {}",
            unit.replacen(UNIT_PREFIX, &prefix, 1)
        ));
    }
    grammar.push('\n');
    grammar.push_str(remaining_fields);
    grammar
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn facets_change_only_version_and_the_bounded_kind_field() {
        for count in [1, 2, 16] {
            let candidate = grammar(count, CandidateQa::FacetsV2);
            assert!(candidate.contains(FACETS));
            assert!(!candidate.contains(SINGLE_KIND));
            assert!(!candidate.contains("unitOrdinal"));
            assert_eq!(
                candidate
                    .replace(
                        "NativeSourceInterpretationFacetsQaV2",
                        "NativeSourceInterpretationQaV1",
                    )
                    .replace(FACETS, SINGLE_KIND),
                super::super::super::grammar::grammar(count),
            );
        }
    }

    #[test]
    fn ordinals_are_fixed_for_every_row_and_other_field_rules_are_unchanged() {
        for count in [1, 2, 16] {
            let candidate = grammar(count, CandidateQa::OrdinalV3);
            let lines = candidate.lines().collect::<Vec<_>>();
            assert!(lines[0].contains("NativeSourceInterpretationOrdinalQaV3"));
            for ordinal in 0..count {
                let prefix =
                    format!(r#"unit-{ordinal} ::= "{{\"unitOrdinal\":{ordinal},\"relevance\":"#);
                assert!(lines[ordinal + 1].starts_with(&prefix));
            }
            assert!(!candidate.contains("\nunit ::= "));
            assert!(!candidate.contains(&format!("unit-{count} ::=")));
            assert!(!candidate.contains("assertionKinds"));
            let original = super::super::super::grammar::grammar(count);
            let original_fields = original.lines().skip(2).collect::<Vec<_>>();
            assert_eq!(&lines[count + 1..], original_fields.as_slice(),);
            let exact_rows = (0..count)
                .map(|ordinal| format!("unit-{ordinal}"))
                .collect::<Vec<_>>()
                .join(" \",\" ws ");
            assert!(lines[0].ends_with(&format!(r#""[" ws {exact_rows} "]}}" ws"#)));
        }
    }

    #[test]
    #[should_panic(expected = "requires 1 to 16 original units")]
    fn empty_candidate_input_is_not_admitted() {
        grammar(0, CandidateQa::FacetsV2);
    }

    #[test]
    #[should_panic(expected = "requires 1 to 16 original units")]
    fn excessive_candidate_input_is_not_admitted() {
        grammar(17, CandidateQa::OrdinalV3);
    }
}
