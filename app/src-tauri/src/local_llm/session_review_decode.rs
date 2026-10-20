use super::*;

impl LocalLlm {
    /// Decode native-issued review IDs; source and meaning validation remain required.
    pub(crate) fn generate_session_review_cancellable(
        &self,
        system: &str,
        user: &str,
        max_tokens: i32,
        context_tokens: u32,
        contract: &SessionReviewDecode,
        cancelled: &AtomicBool,
    ) -> Result<String, String> {
        self.generate_session_review_cancellable_measured(
            system,
            user,
            max_tokens,
            context_tokens,
            contract,
            cancelled,
        )
        .into_result()
    }

    /// Retain safe observations from one exact-input, native-issued review decode.
    pub(crate) fn generate_session_review_cancellable_measured(
        &self,
        system: &str,
        user: &str,
        max_tokens: i32,
        context_tokens: u32,
        contract: &SessionReviewDecode,
        cancelled: &AtomicBool,
    ) -> GenerationAttempt {
        let recorder = Recorder::new(
            Some(GenerationSchema::SessionReviewV1),
            max_tokens,
            context_tokens,
        );
        self.generate_structured_with_decode(
            system,
            user,
            StructuredDecode::SessionReview(contract),
            cancelled,
            recorder,
        )
    }
}

#[cfg(test)]
#[path = "session_review_decode_tests.rs"]
mod tests;
