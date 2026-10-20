//! Exact served-prompt hashing; a digest never establishes source meaning.

use super::{correction, sha256, Encoding, FocusWitnessQa};
#[cfg(test)]
use super::{prompt, Packet};

#[cfg(test)]
pub(super) fn projection_revision(
    original_user: &str,
    canonical: &str,
    witnesses: &[FocusWitnessQa],
) -> Result<String, String> {
    projection_revision_for(
        original_user,
        canonical,
        witnesses,
        Encoding::TupleV1,
        &prompt::system_for(Encoding::TupleV1),
        &Packet::capture(original_user)?.augmented_user()?,
    )
}

fn projection_revision_for(
    original_user: &str,
    canonical: &str,
    witnesses: &[FocusWitnessQa],
    encoding: Encoding,
    system: &str,
    user: &str,
) -> Result<String, String> {
    // Both QA encodings bind the actual served prompt. Tuple receipts from an
    // earlier revision recipe cannot be reused as receipts for this frame.
    serde_json::to_vec(&(
        encoding.wire_version(),
        sha256(original_user.as_bytes()),
        canonical,
        witnesses,
        encoding,
        system,
        user,
    ))
    .map(|bytes| sha256(&bytes))
    .map_err(|error| error.to_string())
}

pub(super) fn bound_revision(
    original_user: &str,
    canonical: &str,
    witnesses: &[FocusWitnessQa],
    encoding: Encoding,
    system: &str,
    user: &str,
    correction: Option<&correction::CorrectionPromptQa>,
) -> Result<String, String> {
    let base =
        projection_revision_for(original_user, canonical, witnesses, encoding, system, user)?;
    match correction {
        Some(binding) => binding.revision(&base),
        None => Ok(base),
    }
}
