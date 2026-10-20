//! Closed activity QA sampling selection; no model or meaning authority.

use crate::local_llm::GenerationSchema;
use crate::wiki_claims::focus_claims_qa::ActivityTypesDecoderQa;

pub(super) fn gemma_activity_decoder(
    model_id: &str,
    ordinal_activity_qa: bool,
    schema: GenerationSchema,
) -> Option<ActivityTypesDecoderQa> {
    if !ordinal_activity_qa || model_id != crate::local_model::GEMMA_CANDIDATE.id {
        return None;
    }
    match schema {
        GenerationSchema::NativeActivityTypesQaV2(decoder) => Some(decoder),
        _ => None,
    }
}

pub(super) fn gemma12b_ordinal_profile(
    model_id: &str,
    ordinal_activity_qa: bool,
    schema: GenerationSchema,
) -> bool {
    ordinal_activity_qa
        && model_id == crate::local_model::GEMMA12B_CANDIDATE.id
        && crate::local_llm::gemma12b_ordinal_qa_schema(schema)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::local_llm::ReviewDecisions;
    use crate::retrieval::Scope;
    use crate::vault_session::AgentVaultSession;
    use crate::wiki_claims::focus_claims_qa::{PreparedFocusQa, PreparedOrdinalActivityQa};
    use crate::wiki_claims::source_interpretation_qa::{self, CandidateQa};
    use crate::wiki_claims::{ActorRole, SourceDocument, SourceSet, SpanInput};
    use serde_json::{json, Value};

    #[test]
    fn activity_sampler_qa_requires_exact_gemma_ordinal_mode_and_initial_schema() {
        let origin = AgentVaultSession {
            vault_path: "/synthetic/activity-sampler-selector".into(),
            opening_token: "synthetic-opening".into(),
        };
        let text = "The synthetic maintainer completed a draft.";
        let document = SourceDocument::bind(
            "S1".into(),
            "sessions/sampler.md".into(),
            "sessions/sampler.md".into(),
            text,
            Some("2026-10-03".into()),
            vec![SpanInput {
                id: "Q1".into(),
                start: 0,
                end: text.len(),
                turn_id: "T1".into(),
                speaker: ActorRole::User,
                turn_time: None,
            }],
        )
        .unwrap();
        let sources = SourceSet::new(origin.clone(), Scope::All, vec![document], vec![]).unwrap();
        let range = crate::commands::DateRange {
            start: "2026-10-01".into(),
            end: "2026-10-04".into(),
            start_epoch: None,
            end_epoch: None,
        };
        let user = crate::local_synthesis::claim_prompt::payload(
            "Summarize recent work",
            "en",
            &range,
            &sources.spans().collect::<Vec<_>>(),
        )
        .unwrap();
        let mut context: Value = serde_json::from_str(&user).unwrap();
        context["sourceFocusQaEncoding"] = json!("ordinal_activity_v3");
        let prepared = PreparedOrdinalActivityQa::prepare(
            &user,
            &sources,
            &origin,
            Scope::All,
            &context,
            &"0".repeat(64),
        )
        .unwrap();
        let decoder = prepared.decoder();
        let schema = GenerationSchema::NativeActivityTypesQaV2(decoder);
        let gemma = crate::local_model::GEMMA_CANDIDATE.id;
        let selected = gemma_activity_decoder(gemma, true, schema).unwrap();
        assert_eq!(selected, decoder);
        assert_eq!(selected.grammar(), decoder.grammar());
        assert_eq!(
            GenerationSchema::NativeActivityTypesQaV2(selected).qa_grammar_sha256(),
            schema.qa_grammar_sha256()
        );
        assert!(gemma_activity_decoder(gemma, false, schema).is_none());
        let gemma12b = crate::local_model::GEMMA12B_CANDIDATE.id;
        assert!(gemma12b_ordinal_profile(gemma12b, true, schema));
        assert!(!gemma12b_ordinal_profile(gemma12b, false, schema));
        assert!(gemma_activity_decoder(gemma12b, true, schema).is_none());
        for model in [
            crate::local_model::MODEL.id,
            crate::local_model::SMALL_MODEL.id,
            crate::local_model::QWEN9B_CANDIDATE.id,
            "gemma-4-e4b-it-qat-q4_0 ",
            "Gemma-4-e4b-it-qat-q4_0",
            crate::local_model::GEMMA_CANDIDATE.file,
            "gemma-4-12b-it-qat-q4_0 ",
            "Gemma-4-12b-it-qat-q4_0",
            crate::local_model::GEMMA12B_CANDIDATE.file,
            "",
        ] {
            assert!(
                gemma_activity_decoder(model, true, schema).is_none(),
                "{model}"
            );
            assert!(!gemma12b_ordinal_profile(model, true, schema), "{model}");
        }
        assert!(!gemma12b_ordinal_profile(gemma, true, schema));
        let decisions = ReviewDecisions::new(1).unwrap();
        let source_only = source_interpretation_qa::prepare(&sources, &origin, Scope::All).unwrap();
        let compact = crate::wiki_claims::compact_qa::PreparedCompactQa::prepare(
            crate::local_synthesis::claim_prompt::extraction_system(),
            &user,
        )
        .unwrap();
        let focus = PreparedFocusQa::prepare(&user).unwrap();
        for other in [
            GenerationSchema::WikiClaimsV1,
            GenerationSchema::WikiClaimsCompactQaV1(compact.decoder()),
            GenerationSchema::WikiSourceFocusClaimsQaV1(focus.decoder()),
            GenerationSchema::WikiQuotedClaimsQaV1,
            GenerationSchema::NativeSourceInterpretationQaV1(source_only.count()),
            GenerationSchema::WikiClaimReviewV1(decisions),
            GenerationSchema::WikiClaimReviewReasonFirstQaV1(decisions),
            GenerationSchema::WikiClaimFieldReviewQaV1,
            GenerationSchema::WikiSourceCoverageQaV1,
            GenerationSchema::AskAnswerV1,
            GenerationSchema::AskAnswerReviewV1,
            GenerationSchema::SessionCompilationV1,
            GenerationSchema::SessionStructureV1,
            GenerationSchema::SessionReviewV1,
        ] {
            assert!(
                gemma_activity_decoder(gemma, true, other).is_none(),
                "{other:?}"
            );
            let allowed_12b_stage = [
                GenerationSchema::WikiClaimsV1,
                GenerationSchema::WikiClaimReviewV1(decisions),
                GenerationSchema::AskAnswerV1,
                GenerationSchema::AskAnswerReviewV1,
            ]
            .contains(&other);
            assert_eq!(
                gemma12b_ordinal_profile(gemma12b, true, other),
                allowed_12b_stage,
                "{other:?}"
            );
            assert!(
                !gemma12b_ordinal_profile(gemma12b, false, other),
                "{other:?}"
            );
        }
        for variant in [CandidateQa::FacetsV2, CandidateQa::OrdinalV3] {
            let candidate =
                source_interpretation_qa::prepare_candidate(&sources, &origin, Scope::All, variant)
                    .unwrap();
            assert!(gemma_activity_decoder(
                gemma,
                true,
                GenerationSchema::NativeSourceInterpretationCandidateQa(candidate.count())
            )
            .is_none());
            assert!(!gemma12b_ordinal_profile(
                gemma12b,
                true,
                GenerationSchema::NativeSourceInterpretationCandidateQa(candidate.count())
            ));
        }
    }
}
