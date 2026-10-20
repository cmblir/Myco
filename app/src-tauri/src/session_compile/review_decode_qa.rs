//! Native-input-bound syntax QA only. This contract grants no opening, role,
//! semantic approval, compiler completion or publication authority.

#[cfg(test)]
use super::review_decode::grammar;
use crate::importers::wikify::source_revision;

/// No Deserialize or public constructor: IDs never come from caller JSON.
pub struct SessionReviewDecodeQa {
    grammar: String,
    system: String,
    user: String,
}

impl SessionReviewDecodeQa {
    /// Exact original review messages for a separately registered QA replay.
    pub fn system(&self) -> &str {
        &self.system
    }

    /// Read-only input; possession does not authorize source access or writes.
    pub fn user(&self) -> &str {
        &self.user
    }

    /// Bind a QA observation to the actual closed grammar bytes.
    pub fn grammar_sha256(&self) -> String {
        source_revision(&self.grammar)
    }

    pub(crate) fn grammar(&self) -> &str {
        &self.grammar
    }

    pub(crate) fn matches_input(&self, system: &str, user: &str) -> bool {
        source_revision(system) == source_revision(&self.system)
            && source_revision(user) == source_revision(&self.user)
    }

    // The initial issuer is confined to native unit QA. Product execution keeps
    // its existing source/role checks, grammar and whole-source validator.
    #[cfg(test)]
    pub(in crate::session_compile) fn issue(
        plan: &super::sources::PacketPlan,
        index: usize,
        original: &crate::wiki_claims::CompilationOriginal<'_>,
        origin: &crate::vault_session::AgentVaultSession,
        extraction: &str,
        compilation: &str,
    ) -> Result<Self, String> {
        let packet = plan.packet(index, original, origin)?;
        let claims = super::compiler::bind_claims(&packet, extraction, origin, index)?;
        let compilation = super::schema::validate(compilation, &claims)?;
        let claim_ids = claims
            .iter()
            .map(|claim| claim.id.clone())
            .collect::<Vec<_>>();
        let expression_ids = super::schema::review_item_ids(&compilation);
        let span_ids = packet
            .spans()
            .map(|span| span.id().to_owned())
            .collect::<Vec<_>>();
        Ok(Self {
            grammar: grammar(&claim_ids, &expression_ids, &span_ids)?,
            system: super::review::SYSTEM.into(),
            user: super::review::payload(plan, &plan.language, &packet, &claims, &compilation)?,
        })
    }
}

#[cfg(test)]
#[path = "review_decode_qa_model_tests.rs"]
mod model_tests;
#[cfg(test)]
#[path = "review_decode_qa_tests.rs"]
pub(crate) mod tests;
