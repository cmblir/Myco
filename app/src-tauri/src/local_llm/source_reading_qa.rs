//! Isolated prose-reading diagnostics; outputs carry no native source authority.

use super::*;

impl LocalLlm {
    /// Describe the fixed five-stage chain without loading a model or context.
    pub fn source_reading_qa_sampler_parameters() -> SourceReadingQaSamplerParameters {
        grounded_sampling::source_reading_qa_parameters()
    }

    /// Generate untrusted prose once with grounded numeric sampling and no grammar.
    /// Uses the normal chat template and fixed 768-output/4096-context admission.
    pub fn generate_source_reading_qa_measured(
        &self,
        system: &str,
        user: &str,
        cancelled: &AtomicBool,
    ) -> GenerationAttempt {
        let mut recorder = Recorder::new(None, 768, 4096);
        recorder.select_qa_profile(SamplerProfile::ExistingGroundedGrammarFreeQaV1);
        self.generate_structured_with_decode(
            system,
            user,
            StructuredDecode::GroundedProseReadingQa,
            cancelled,
            recorder,
        )
    }
}
