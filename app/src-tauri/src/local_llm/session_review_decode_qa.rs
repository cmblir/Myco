use super::*;

impl LocalLlm {
    /// Closed, exact-input QA decode; this grants no semantic or publication authority.
    pub fn generate_session_review_cancellable_measured_qa(
        &self,
        system: &str,
        user: &str,
        max_tokens: i32,
        context_tokens: u32,
        contract: &SessionReviewDecodeQa,
        cancelled: &AtomicBool,
    ) -> GenerationAttempt {
        let mut recorder = Recorder::new(
            Some(GenerationSchema::SessionReviewV1),
            max_tokens,
            context_tokens,
        );
        recorder.select_session_review_qa();
        self.generate_structured_with_decode(
            system,
            user,
            StructuredDecode::SessionReviewQa(contract),
            cancelled,
            recorder,
        )
    }
}
