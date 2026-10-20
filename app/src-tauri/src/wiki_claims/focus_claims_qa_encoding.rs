//! Capture-only QA decoder metadata and closed wire selection.

use super::{ActorRole, NAMED_VERSION, VERSION};
use serde::Serialize;

/// An explicit QA representation choice; neither encoding issues authority.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum Encoding {
    TupleV1,
    NamedV1,
}

impl Encoding {
    pub(crate) fn wire_version(self) -> &'static str {
        match self {
            Self::TupleV1 => VERSION,
            Self::NamedV1 => NAMED_VERSION,
        }
    }
}

/// Only preparation issues a decoder over the complete captured packet. The
/// speaker array constrains metadata consistency, not the described actor.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct DecoderFocusQa {
    pub(super) packet_sha256: [u8; 32],
    pub(super) speakers: [ActorRole; 8],
    pub(super) span_count: u8,
    pub(super) encoding: Encoding,
}

impl DecoderFocusQa {
    /// Preserve allowed unknown/third-party judgments inside a bound grammar.
    pub fn grammar(self) -> String {
        super::super::focus_claims_qa_grammar::grammar(
            &self.packet_sha256(),
            &self.speakers[..self.span_count()],
            self.encoding,
        )
    }

    /// Distinguish the captured QA wire without exposing a decoder constructor.
    pub fn wire_version(self) -> &'static str {
        self.encoding.wire_version()
    }

    /// Return the full original JSON digest for QA observations.
    pub fn packet_sha256(self) -> String {
        self.packet_sha256
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect()
    }

    /// Report complete originals without changing caller admission limits.
    pub fn span_count(self) -> usize {
        usize::from(self.span_count)
    }
}
