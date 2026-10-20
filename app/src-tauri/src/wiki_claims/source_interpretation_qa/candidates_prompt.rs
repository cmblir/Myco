//! Candidate prompts change representation, never repair a model's judgments.

use super::CandidateQa;

const OUTPUT: &str =
    "Return only complete NativeSourceInterpretationQaV1 JSON with version and units.";
const FIELDS: &str = "status, assertionKind and verificationId, in that order.";
const KIND: &str = "assertionKind is asserted_occurrence, explicit_nonoccurrence, intention, record_or_verification_limit or uncertain.";
const DISTINCT: &str = "Keep distinct facts in a mixed utterance as separate interpretations, with at most 16 interpretations across all rows.";
const QUALIFICATIONS: &str = "Preserve multiple interpretations when one sentence contains different activities or qualifications.";
const ROW: &str = "Each row has relevance and interpretations.";

/// Derive the versioned QA instruction from V1 without adding fixture examples,
/// meaning gold, rewritten actions or a source/review/publication capability.
pub(super) fn system(variant: CandidateQa) -> String {
    let original = super::super::prompt::SYSTEM;
    match variant {
        CandidateQa::FacetsV2 => {
            let system = replace_once(
                original,
                OUTPUT,
                "The supplied input is NativeSourceInterpretationFacetsQaInputV2. Return only complete NativeSourceInterpretationFacetsQaV2 JSON with version and units.",
            );
            let system = replace_once(
                &system,
                FIELDS,
                "status, assertionKinds and verificationId, in that order.",
            );
            let system = replace_once(
                &system,
                KIND,
                "assertionKinds is a set of 1 to 5 unique values from asserted_occurrence, explicit_nonoccurrence, intention, record_or_verification_limit and uncertain. Return every supported facet of this interpretation, without duplicates or unknown values; do not return the singular assertionKind field. One exact focus can support multiple compatible facets without turning a qualification into execution evidence.",
            );
            let system = replace_once(
                &system,
                DISTINCT,
                "Keep activities with different actors, times, objects or scopes as separate interpretations; compatible facets of one focus may share an interpretation, with at most 16 interpretations across all rows.",
            );
            replace_once(
                &system,
                QUALIFICATIONS,
                "Preserve multiple interpretations when one sentence contains different activities, actors, times, objects or scopes. Compatible qualifications of one focus may share its assertionKinds set.",
            )
        }
        CandidateQa::OrdinalV3 => {
            let system = replace_once(
                original,
                OUTPUT,
                "The supplied input is NativeSourceInterpretationOrdinalQaInputV3. Return only complete NativeSourceInterpretationOrdinalQaV3 JSON with version and units.",
            );
            replace_once(
                &system,
                ROW,
                "Each row has unitOrdinal, relevance and interpretations, in that order. Each input originalSpans entry contains the application-issued unitOrdinal and its complete original. Return that exact zero-based ordinal for this row; never choose, swap or reorder unit ordinals, originals, IDs or metadata. The ordinal identifies the retained complete original and does not establish its meaning or repair a mismatched focus.",
            )
        }
    }
}

fn replace_once(text: &str, original: &str, replacement: &str) -> String {
    assert_eq!(text.matches(original).count(), 1);
    text.replacen(original, replacement, 1)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn facets_describe_a_set_without_changing_record_or_verification_meaning() {
        let candidate = system(CandidateQa::FacetsV2);
        assert!(candidate.contains("NativeSourceInterpretationFacetsQaInputV2"));
        assert!(candidate.contains("NativeSourceInterpretationFacetsQaV2"));
        assert!(candidate.contains("status, assertionKinds and verificationId, in that order."));
        assert!(candidate.contains("a set of 1 to 5 unique values"));
        assert!(candidate.contains("different actors, times, objects or scopes"));
        assert!(!candidate.contains(KIND));
        assert!(!candidate.contains("unitOrdinal"));
        let definitions = super::super::super::prompt::SYSTEM
            .split_once(KIND)
            .expect("V1 assertion definitions are required")
            .1
            .split('\n')
            .next()
            .expect("V1 assertion definitions follow the field description");
        assert!(candidate.contains(definitions));
        for paragraph in super::super::super::prompt::SYSTEM.split('\n').skip(4) {
            assert!(candidate.contains(paragraph));
        }
    }

    #[test]
    fn ordinal_prompt_changes_only_versions_and_source_association_instructions() {
        let candidate = system(CandidateQa::OrdinalV3);
        assert!(candidate.contains("NativeSourceInterpretationOrdinalQaInputV3"));
        assert!(candidate.contains("NativeSourceInterpretationOrdinalQaV3"));
        assert!(candidate.contains("unitOrdinal, relevance and interpretations, in that order."));
        assert!(candidate.contains("that exact zero-based ordinal"));
        assert!(candidate.contains(KIND));
        assert!(!candidate.contains("assertionKinds"));
        for paragraph in super::super::super::prompt::SYSTEM.split('\n').skip(2) {
            assert!(candidate.contains(paragraph));
        }
    }
}
