//! App-owned filtering and exact provenance merging, never semantic deduplication.

use super::{
    sha256, valid_id, valid_path, valid_time, SourceDocument, SourceSet, SourceSpan, SpanInput,
};

/// Native-only verified bytes; packets cannot replace the full original SHA.
pub(crate) struct CompilationOriginal<'a> {
    text: &'a str,
    revision: String,
}

impl<'a> CompilationOriginal<'a> {
    pub(crate) fn verify(text: &'a str, expected_revision: &str) -> Result<Self, String> {
        if text.is_empty()
            || text.len() > 128 * 1024 * 1024
            || expected_revision.len() != 64
            || sha256(text.as_bytes()) != expected_revision
        {
            return Err("compiler original SHA or size changed".into());
        }
        Ok(Self {
            text,
            revision: expected_revision.into(),
        })
    }
}

impl SourceSpan {
    pub fn start(&self) -> usize {
        self.start
    }
    pub fn end(&self) -> usize {
        self.end
    }
    pub fn span_sha256(&self) -> &str {
        &self.sha256
    }
    pub fn record_time(&self) -> Option<&str> {
        self.record_time.as_deref()
    }
    pub fn source_phase(&self) -> Option<&str> {
        self.source_phase.as_deref()
    }
    pub(crate) fn same_original_turn(&self, other: &Self) -> bool {
        self.source_path == other.source_path
            && self.selection_path == other.selection_path
            && self.source_revision == other.source_revision
            && self.turn_id == other.turn_id
    }
}

impl SourceDocument {
    /// Bind a bounded compiler packet to the complete immutable original. The
    /// caller authenticates native origin/lineage before supplying these bytes;
    /// ordinary `bind` keeps its original 512 KiB document limit unchanged.
    pub(crate) fn bind_compilation_packet(
        id: String,
        path: String,
        original: &CompilationOriginal<'_>,
        expected_revision: &str,
        record_time: Option<String>,
        inputs: Vec<SpanInput>,
    ) -> Result<Self, String> {
        if inputs.is_empty()
            || inputs.len() > super::MAX_SPANS
            || !valid_id(&id)
            || !valid_path(&path)
            || expected_revision.len() != 64
            || original.revision != expected_revision
            || record_time.as_deref().is_some_and(|time| !valid_time(time))
        {
            return Err("compiler packet lacks its exact bounded original binding".into());
        }
        let mut spans = Vec::new();
        let mut ids = std::collections::HashSet::new();
        let mut selected_bytes = 0usize;
        for input in inputs {
            if !valid_id(&input.id)
                || !valid_id(&input.turn_id)
                || !ids.insert(input.id.clone())
                || input.start >= input.end
                || input
                    .turn_time
                    .as_deref()
                    .is_some_and(|time| !valid_time(time))
            {
                return Err("invalid compiler packet span metadata".into());
            }
            let text = original
                .text
                .get(input.start..input.end)
                .ok_or("compiler packet span exceeds original UTF-8 boundaries")?;
            selected_bytes = selected_bytes
                .checked_add(text.len())
                .ok_or("compiler packet byte budget overflow")?;
            if selected_bytes > super::MAX_SOURCE_BYTES {
                return Err("compiler packet exceeds selected-byte budget".into());
            }
            spans.push(SourceSpan {
                id: input.id,
                source_id: id.clone(),
                source_path: path.clone(),
                selection_path: path.clone(),
                source_revision: expected_revision.into(),
                start: input.start,
                end: input.end,
                sha256: sha256(text.as_bytes()),
                text: text.into(),
                turn_id: input.turn_id,
                speaker: input.speaker,
                record_time: record_time.clone(),
                turn_time: input.turn_time,
                source_phase: None,
            });
        }
        Ok(Self {
            id,
            path: path.clone(),
            selection_path: path,
            revision: expected_revision.into(),
            spans,
            bytes: selected_bytes,
        })
    }

    /// Preserve bounded original turn phase metadata; models cannot supply it.
    pub(crate) fn with_turn_phases(
        mut self,
        phases: &[(String, Option<String>)],
    ) -> Result<Self, String> {
        for span in &mut self.spans {
            if let Some((_, phase)) = phases.iter().find(|(id, _)| id == &span.turn_id) {
                if phase.as_ref().is_some_and(|phase| {
                    phase.is_empty()
                        || phase.chars().count() > 64
                        || phase.chars().any(char::is_control)
                }) {
                    return Err("invalid original transcript phase metadata".into());
                }
                span.source_phase = phase.clone();
            }
        }
        Ok(self)
    }
}

impl SourceSet {
    pub(crate) fn documents(&self) -> &[SourceDocument] {
        &self.sources
    }

    /// Remove unadmitted spans without changing the survivors' original bytes.
    pub(crate) fn retained(
        &self,
        mut keep: impl FnMut(&SourceSpan) -> bool,
    ) -> Result<Self, String> {
        if !self.verified_facts.is_empty() {
            return Err("claim filtering cannot rewrite verification receipts".into());
        }
        let mut sources = self.sources.clone();
        for source in &mut sources {
            source.spans.retain(|span| keep(span));
        }
        sources.retain(|source| !source.spans.is_empty());
        Self::new(self.origin.clone(), self.scope, sources, vec![])
    }

    /// Join only exact app-owned source identities. Different revisions or a
    /// repeated ID with different coordinates/metadata fail instead of winning.
    pub(crate) fn merged(&self, other: &Self) -> Result<Self, String> {
        if self.origin.vault_path != other.origin.vault_path
            || self.origin.opening_token != other.origin.opening_token
            || self.scope != other.scope
            || !self.verified_facts.is_empty()
            || !other.verified_facts.is_empty()
        {
            return Err("claim merge requires the same empty-verification source context".into());
        }
        let mut sources = self.sources.clone();
        for incoming in &other.sources {
            if let Some(existing) = sources.iter_mut().find(|source| source.id == incoming.id) {
                if existing.path != incoming.path
                    || existing.selection_path != incoming.selection_path
                    || existing.revision != incoming.revision
                    || existing.bytes != incoming.bytes
                {
                    return Err("claim source revision or identity changed during merge".into());
                }
                for span in &incoming.spans {
                    if let Some(old) = existing.spans.iter().find(|old| old.id == span.id) {
                        if old != span {
                            return Err("claim span identity changed during merge".into());
                        }
                    } else {
                        existing.spans.push(span.clone());
                    }
                }
            } else {
                sources.push(incoming.clone());
            }
        }
        Self::new(self.origin.clone(), self.scope, sources, vec![])
    }
}

#[cfg(test)]
#[path = "source_set_tests.rs"]
mod tests;
