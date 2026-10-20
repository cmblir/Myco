//! QA-only positional claim syntax; expansion is not semantic acceptance.

use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::HashSet;

#[path = "compact_qa_grammar.rs"]
mod grammar;
#[path = "compact_qa_prompt.rs"]
mod prompt;
#[path = "compact_qa_wire.rs"]
mod wire;

pub(crate) const VERSION: &str = "WikiClaimsCompactQaV1";

/// Only a captured packet can issue this decoder. Its digest binds the entire
/// original user JSON, not just the number or names of selected spans. This is
/// a QA representation binding, not authorization or source-based meaning.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct DecoderCompactQa {
    packet_sha256: [u8; 32],
    span_count: u8,
}

impl DecoderCompactQa {
    /// Decode only this exact packet's version, digest and ordinal range.
    pub fn grammar(self) -> String {
        grammar::grammar(&self.digest_hex(), self.span_count)
    }

    /// Expose the complete digest for QA records, without issuing a new decoder.
    pub fn packet_sha256(self) -> String {
        self.digest_hex()
    }

    /// Report the captured original count; native caller batch limits stay intact.
    pub fn span_count(self) -> usize {
        usize::from(self.span_count)
    }

    fn digest_hex(self) -> String {
        self.packet_sha256
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect()
    }
}

/// Freeze raw JSON, every ordered original snapshot and the ordinal dictionary
/// before generation. Native callers retain their existing batch size. Direct
/// QA can use up to eight complete originals without splitting a source case.
pub(crate) struct PreparedCompactQa {
    system: String,
    user: String,
    packet: Packet,
}

impl PreparedCompactQa {
    pub(crate) fn prepare(system: &str, user: &str) -> Result<Self, String> {
        let packet = Packet::capture(user)?;
        let compact_user = packet.augmented_user()?;
        let compact_system = prompt::prepare(system, packet.decoder)?;
        Ok(Self {
            system: compact_system,
            user: compact_user,
            packet,
        })
    }

    pub(crate) fn system(&self) -> &str {
        &self.system
    }

    pub(crate) fn user(&self) -> &str {
        &self.user
    }

    pub(crate) fn original_user(&self) -> &str {
        &self.packet.raw_user
    }

    pub(crate) fn decoder(&self) -> DecoderCompactQa {
        self.packet.decoder
    }

    /// Return unchanged native proposal fields after exact tuple projection.
    /// The caller must still validate its SourceSet and run mandatory original
    /// source review. No actor, time, action or status is repaired here.
    pub(crate) fn expand(&self, raw: &str) -> Result<String, String> {
        self.packet.verify_snapshot()?;
        wire::expand(&self.packet, raw)
    }
}

pub(super) struct Packet {
    raw_user: String,
    original_spans: Vec<Value>,
    span_ids: Vec<String>,
    decoder: DecoderCompactQa,
}

impl Packet {
    pub(super) fn original_spans(&self) -> &[Value] {
        &self.original_spans
    }
    pub(super) fn span_ids(&self) -> &[String] {
        &self.span_ids
    }
    pub(super) fn raw_user(&self) -> &str {
        &self.raw_user
    }
    pub(super) fn packet_sha256(&self) -> String {
        self.decoder.packet_sha256()
    }
    pub(super) fn capture(raw_user: &str) -> Result<Self, String> {
        if raw_user.is_empty() || raw_user.len() > super::MAX_TOTAL_BYTES {
            return Err("compact QA input exceeds original packet bounds".into());
        }
        let input: Value = serde_json::from_str(raw_user)
            .map_err(|error| format!("invalid compact QA original packet: {error}"))?;
        let object = input
            .as_object()
            .ok_or("compact QA original packet must be an object")?;
        if object.contains_key("spanOrdinalDictionary") || object.contains_key("packetSha256") {
            return Err("compact QA original packet contains reserved wire metadata".into());
        }
        if input["independentVerificationReceipts"]
            .as_array()
            .map_or(true, |receipts| !receipts.is_empty())
        {
            return Err(
                "compact QA requires explicit empty independent verification receipts".into(),
            );
        }
        let original_spans = input["originalSpans"]
            .as_array()
            .filter(|spans| (1..=super::MAX_SUPPORTS).contains(&spans.len()))
            .ok_or("compact QA requires one to eight complete original spans")?
            .clone();
        let allowed = input["allowedSpanIds"]
            .as_array()
            .ok_or("compact QA requires ordered allowedSpanIds")?;
        let mut span_ids = Vec::new();
        let mut seen = HashSet::new();
        for span in &original_spans {
            let id = span["id"]
                .as_str()
                .filter(|id| super::valid_id(id))
                .ok_or("compact QA original span has an invalid identity")?;
            if !seen.insert(id.to_owned())
                || span["text"].as_str().map_or(true, |text| {
                    text.is_empty() || text.len() > super::MAX_SOURCE_BYTES
                })
            {
                return Err(
                    "compact QA original spans duplicate an identity or exceed bounds".into(),
                );
            }
            span_ids.push(id.to_owned());
        }
        if allowed.len() != span_ids.len()
            || allowed
                .iter()
                .zip(&span_ids)
                .any(|(allowed_id, id)| allowed_id.as_str() != Some(id.as_str()))
        {
            return Err("compact QA allowedSpanIds differ from complete original order".into());
        }
        let packet_sha256 = Sha256::digest(raw_user.as_bytes()).into();
        let span_count = u8::try_from(span_ids.len())
            .map_err(|_| "compact QA original span count exceeds decoder bounds")?;
        Ok(Self {
            raw_user: raw_user.into(),
            original_spans,
            span_ids,
            decoder: DecoderCompactQa {
                packet_sha256,
                span_count,
            },
        })
    }

    pub(super) fn augmented_user(&self) -> Result<String, String> {
        let mut value: Value = serde_json::from_str(&self.raw_user)
            .map_err(|error| format!("read captured compact QA packet: {error}"))?;
        let object = value
            .as_object_mut()
            .ok_or("captured compact QA packet lost its object")?;
        object.insert(
            "packetSha256".into(),
            Value::String(self.decoder.digest_hex()),
        );
        object.insert(
            "spanOrdinalDictionary".into(),
            Value::Array(
                self.span_ids
                    .iter()
                    .enumerate()
                    .map(|(ordinal, id)| serde_json::json!({"ordinal":ordinal,"spanId":id}))
                    .collect(),
            ),
        );
        if value["originalSpans"].as_array() != Some(&self.original_spans) {
            return Err("compact QA preparation changed original snapshots".into());
        }
        serde_json::to_string(&value)
            .map_err(|error| format!("serialize compact QA ordinal packet: {error}"))
    }

    pub(super) fn verify_snapshot(&self) -> Result<(), String> {
        let current = Self::capture(&self.raw_user)?;
        if current.decoder != self.decoder
            || current.original_spans != self.original_spans
            || current.span_ids != self.span_ids
        {
            return Err("compact QA captured original packet changed".into());
        }
        Ok(())
    }
}

/// Reuse the exact unverified tuple projector for sibling QA representations.
pub(super) fn expand_captured(packet: &Packet, raw: &str) -> Result<String, String> {
    packet.verify_snapshot()?;
    wire::expand(packet, raw)
}

#[cfg(test)]
#[path = "compact_qa_tests.rs"]
mod tests;
