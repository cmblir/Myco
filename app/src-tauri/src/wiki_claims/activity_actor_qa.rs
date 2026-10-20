//! Actor ordinals preserve captured references without choosing or repairing actors.

use crate::wiki_claims::{ActorBasis, ActorRole, ProposedActor};
use serde::Deserialize;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Actor {
    role: ActorRole,
    basis: ActorBasis,
    #[serde(deserialize_with = "super::required_nullable")]
    subject_ordinal: Option<usize>,
}

impl Actor {
    pub(super) fn into_native(self, ids: &[String]) -> Result<ProposedActor, String> {
        let subject_span_id = self
            .subject_ordinal
            .map(|ordinal| {
                ids.get(ordinal)
                    .cloned()
                    .ok_or("activity actor subject ordinal is outside captured originals")
            })
            .transpose()?;
        Ok(ProposedActor {
            role: self.role,
            basis: self.basis,
            subject_span_id,
        })
    }
}

/// Couple each positional row to its captured speaker; all cross-span explicit
/// subjects remain choices. Native validation still checks selected support IDs.
pub(super) fn grammar(original: String, speakers: &[ActorRole]) -> String {
    assert!((1..=8).contains(&speakers.len()));
    let interpretation = original
        .lines()
        .find(|line| line.starts_with("interpretation ::= "))
        .expect("activity grammar has its inherited interpretation rule");
    assert_eq!(interpretation.matches("ws actor ").count(), 1);
    let mut grammar = original
        .lines()
        .filter(|line| !line.starts_with("interpretation ::= ") && !line.starts_with("actor ::= "))
        .collect::<Vec<_>>()
        .join("\n");
    for (ordinal, speaker) in speakers.iter().enumerate() {
        let prefix = format!("unit-{ordinal} ::= ");
        let unit = original
            .lines()
            .find(|line| line.starts_with(&prefix))
            .expect("activity grammar has every fixed ordinal row");
        grammar = grammar.replacen(
            unit,
            &unit.replace(" interpretation", &format!(" interpretation-{ordinal}")),
            1,
        );
        grammar.push_str(&format!(
            "\n{}",
            interpretation
                .replacen(
                    "interpretation ::= ",
                    &format!("interpretation-{ordinal} ::= "),
                    1
                )
                .replacen("ws actor ", &format!("ws actor-{ordinal} "), 1)
        ));
        let role =
            serde_json::to_string(&serde_json::to_string(speaker).expect("speaker serializes"))
                .expect("speaker grammar literal serializes");
        grammar.push_str(&format!(r#"
actor-{ordinal} ::= "{{\"role\":" ws ({role} ",\"basis\":" ws "\"speaker\",\"subjectOrdinal\":" ws "null" | known-role ",\"basis\":" ws "\"explicit_subject\",\"subjectOrdinal\":" ws subject-ordinal | "\"unknown\",\"basis\":" ws "\"unknown\",\"subjectOrdinal\":" ws "null") "}}"
"#));
    }
    let ordinals = (0..speakers.len())
        .map(|ordinal| format!("\"{ordinal}\""))
        .collect::<Vec<_>>()
        .join(" | ");
    grammar.push_str(&format!("\nsubject-ordinal ::= {ordinals}\n"));
    grammar
}
