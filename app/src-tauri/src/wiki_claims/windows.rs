//! Byte-preserving model-context windows over frozen original span bindings.

use super::{sha256, SourceSet, SourceSpan, MAX_SPANS};

impl SourceSpan {
    pub(crate) fn context_window(&self, start: usize, end: usize) -> Result<Self, String> {
        let text = self
            .text
            .get(start..end)
            .filter(|text| !text.is_empty())
            .ok_or("claim context window is outside original UTF-8 bounds")?;
        let mut window = self.clone();
        window.start = self.start + start;
        window.end = self.start + end;
        window.id = format!(
            "Q-{}",
            &sha256(format!("{}:{}:{}", self.id, window.start, window.end).as_bytes())[..32]
        );
        window.sha256 = sha256(text.as_bytes());
        window.text = text.into();
        Ok(window)
    }
}

impl SourceSet {
    /// Split original spans without losing or normalizing source bytes. The
    /// application supplies the tokenizer; models never choose their bindings.
    pub fn windowed(
        &self,
        mut split: impl FnMut(&SourceSpan) -> Result<Vec<String>, String>,
    ) -> Result<Self, String> {
        if !self.verified_facts.is_empty() {
            return Err("claim windows cannot rewrite application verification receipts".into());
        }
        let mut documents = self.sources.clone();
        let mut count = 0;
        for document in &mut documents {
            let mut windowed = Vec::new();
            for span in &document.spans {
                let windows = split(span)?;
                if windows.is_empty() || windows.concat() != span.text {
                    return Err("claim windows must preserve every original byte in order".into());
                }
                let mut start = span.start;
                for text in windows {
                    count += 1;
                    if text.is_empty() || count > MAX_SPANS {
                        return Err("claim windows are empty or exceed span bounds".into());
                    }
                    let end = start + text.len();
                    windowed.push(span.context_window(start - span.start, end - span.start)?);
                    start = end;
                }
                if start != span.end {
                    return Err("claim window byte offsets changed".into());
                }
            }
            document.spans = windowed;
        }
        Self::new(self.origin.clone(), self.scope, documents, vec![])
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::retrieval::Scope;
    use crate::vault_session::AgentVaultSession;
    use crate::wiki_claims::{ActorRole, SourceDocument, SpanInput};

    fn original() -> SourceSet {
        let text = "prefix: 가 synthetic request; the later outcome is unknown.";
        let start = "prefix: ".len();
        SourceSet::new(
            AgentVaultSession {
                vault_path: "/synthetic/vault".into(),
                opening_token: "7".into(),
            },
            Scope::Sessions,
            vec![SourceDocument::bind(
                "S1".into(),
                "sessions/synthetic.md".into(),
                "sessions/synthetic.md".into(),
                text,
                Some("2026-10-08".into()),
                vec![SpanInput {
                    id: "Q1".into(),
                    start,
                    end: text.len(),
                    turn_id: "T1".into(),
                    speaker: ActorRole::User,
                    turn_time: Some("2026-10-03T08:00:00Z".into()),
                }],
            )
            .unwrap()],
            vec![],
        )
        .unwrap()
    }

    #[test]
    fn windows_preserve_hash_lineage_real_byte_offsets_speaker_and_time() {
        let original = original();
        let before = original.spans().next().unwrap();
        let windowed = original
            .windowed(|span| {
                let split = '가'.len_utf8();
                Ok(vec![
                    span.text()[..split].into(),
                    span.text()[split..].into(),
                ])
            })
            .unwrap();
        let spans: Vec<_> = windowed.spans().collect();
        assert_eq!(spans.len(), 2);
        assert_eq!(
            spans.iter().map(|span| span.text()).collect::<String>(),
            before.text()
        );
        assert_eq!(spans[0].start, before.start);
        assert_eq!(spans[0].end, before.start + '가'.len_utf8());
        assert_eq!(spans[1].start, spans[0].end);
        assert_eq!(spans[1].end, before.end);
        for span in spans {
            assert_eq!(span.source_revision(), before.source_revision());
            assert_eq!(span.speaker(), before.speaker());
            assert_eq!(span.turn_time(), before.turn_time());
            assert_eq!(span.sha256, sha256(span.text().as_bytes()));
            assert_ne!(span.id(), before.id());
        }
    }

    #[test]
    fn dropped_normalized_duplicated_or_empty_windows_are_rejected() {
        let original = original();
        for invalid in [
            vec![],
            vec!["가".into()],
            vec!["".into()],
            vec!["invented".into()],
        ] {
            assert!(original.windowed(|_| Ok(invalid.clone())).is_err());
        }
        assert!(original
            .windowed(|span| Ok(vec![span.text().into(), span.text().into()]))
            .is_err());
    }

    #[test]
    fn excessive_window_count_and_tokenizer_failure_remain_errors() {
        let original = original();
        assert_eq!(
            original
                .windowed(|_| Err("synthetic tokenizer unavailable".into()))
                .unwrap_err(),
            "synthetic tokenizer unavailable"
        );
        let long = "x".repeat(MAX_SPANS + 1);
        let source = SourceDocument::bind(
            "S1".into(),
            "sessions/a.md".into(),
            "sessions/a.md".into(),
            &long,
            None,
            vec![SpanInput {
                id: "Q1".into(),
                start: 0,
                end: long.len(),
                turn_id: "T1".into(),
                speaker: ActorRole::Unknown,
                turn_time: None,
            }],
        )
        .unwrap();
        let set = SourceSet::new(
            original.origin.clone(),
            Scope::Sessions,
            vec![source],
            vec![],
        )
        .unwrap();
        assert!(set
            .windowed(|span| Ok(span.text().chars().map(|ch| ch.to_string()).collect()))
            .is_err());
    }
}
