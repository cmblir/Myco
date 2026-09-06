//! `<vault>/profile.md` — the owner's role, goals, interests and working
//! style. The distillation gate's identity layer reads its `## Interests`
//! (`distill::read_profile_interests`, a narrower scan of the same file) and
//! LLM calls get the whole thing injected when profile injection is on.
//!
//! Mirror of `app/src/lib/profile.ts`, the app's own editor for the file:
//! same header comment, same four headings, same newline-collapsing at
//! serialize (an item containing `\n## Working style\n...` must not reparse
//! as a heading). No code is shared across the language boundary, so change
//! both together.

use serde::{Deserialize, Serialize};
use std::path::Path;

/// Written by every serializer verbatim — a fixed sentence, not localised.
pub const HEADER: &str =
    "<!-- Sent to configured AI providers when profile injection is on (Settings → 증류). -->";

pub const FILE_NAME: &str = "profile.md";

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Profile {
    pub role: String,
    pub goals: Vec<String>,
    pub interests: Vec<String>,
    pub style: String,
}

impl Profile {
    pub fn is_blank(&self) -> bool {
        self.role.is_empty()
            && self.style.is_empty()
            && self.goals.is_empty()
            && self.interests.is_empty()
    }
}

/// The interview `setup_profile` hands a client that calls it with no
/// answers: (field, question).
pub const INTERVIEW: [(&str, &str); 4] = [
    ("role", "What is your role/profession?"),
    (
        "goals",
        "What are you working toward right now — top 2-3 goals?",
    ),
    (
        "interests",
        "Which topics should this knowledge base prioritize? List 3-8.",
    ),
    ("style", "How do you like answers — depth, format, tone?"),
];

#[derive(Clone, Copy)]
enum Section {
    Role,
    Goals,
    Interests,
    Style,
}

fn section_for(heading: &str) -> Option<Section> {
    match heading.trim().to_lowercase().as_str() {
        "role" => Some(Section::Role),
        "goals" => Some(Section::Goals),
        "interests" => Some(Section::Interests),
        "working style" => Some(Section::Style),
        _ => None,
    }
}

/// `## Goals` / `## Interests` collect bullet lines; `## Role` / `## Working
/// style` join every non-empty line under the heading into one line (a
/// hand-edited multi-line answer degrades to one sentence rather than losing
/// all but its first line). Text outside a recognised heading is ignored.
pub fn parse(raw: &str) -> Profile {
    let mut p = Profile::default();
    let mut section: Option<Section> = None;
    for line in raw.lines() {
        let s = line.trim();
        if let Some(h) = s.strip_prefix("## ") {
            section = section_for(h);
            continue;
        }
        match section {
            Some(Section::Goals) | Some(Section::Interests) => {
                let item = s
                    .strip_prefix("- ")
                    .or_else(|| s.strip_prefix("* "))
                    .map(str::trim)
                    .filter(|t| !t.is_empty());
                if let Some(item) = item {
                    match section {
                        Some(Section::Goals) => p.goals.push(item.to_string()),
                        _ => p.interests.push(item.to_string()),
                    }
                }
            }
            Some(Section::Role) | Some(Section::Style) if !s.is_empty() => {
                let field = match section {
                    Some(Section::Role) => &mut p.role,
                    _ => &mut p.style,
                };
                if field.is_empty() {
                    field.push_str(s);
                } else {
                    field.push(' ');
                    field.push_str(s);
                }
            }
            _ => {}
        }
    }
    p
}

/// Collapse embedded newlines (and the whitespace around them) to one space,
/// so a written value can never contain a line that reparses as a `##`
/// heading or a bullet. Applied to every field at serialize: the app's
/// textarea cannot produce these, but MCP's `setup_profile` takes raw
/// strings straight through.
pub fn sanitize_line(s: &str) -> String {
    s.lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
}

/// Inverse of `parse` — the only shape any writer of profile.md produces.
pub fn serialize(p: &Profile) -> String {
    let bullets = |items: &[String]| {
        items
            .iter()
            .map(|i| format!("- {}", sanitize_line(i)))
            .collect::<Vec<_>>()
            .join("\n")
    };
    format!(
        "{HEADER}\n\n## Role\n{}\n\n## Goals\n{}\n\n## Interests\n{}\n\n## Working style\n{}\n",
        sanitize_line(&p.role),
        bullets(&p.goals),
        bullets(&p.interests),
        sanitize_line(&p.style),
    )
}

/// `None` when `<vault>/profile.md` is missing or unreadable.
pub fn load(root: &Path) -> Option<Profile> {
    std::fs::read_to_string(root.join(FILE_NAME))
        .ok()
        .map(|raw| parse(&raw))
}

pub fn save(root: &Path, p: &Profile) -> Result<(), String> {
    std::fs::write(root.join(FILE_NAME), serialize(p))
        .map_err(|e| format!("write {FILE_NAME}: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_every_field() {
        let p = Profile {
            role: "Backend engineer".into(),
            goals: vec!["ship the gate".into()],
            interests: vec!["rust".into(), "ontologies".into()],
            style: "Concise".into(),
        };
        let text = serialize(&p);
        assert!(text.starts_with(HEADER), "{text}");
        assert!(text.contains("## Working style\nConcise\n"));
        assert_eq!(parse(&text), p);
    }

    // The reviewer's exact repro on the TS side: an interests item smuggling a
    // fake `##` heading line corrupted the round-trip — a later legit item was
    // dropped and the injected text landed under the wrong field.
    #[test]
    fn serialize_sanitizes_embedded_heading_injection() {
        let evil = Profile {
            role: "Engineer".into(),
            goals: vec!["real goal".into()],
            interests: vec![
                "first".into(),
                "evil\n## Working style\ninjected".into(),
                "third".into(),
            ],
            style: "Concise".into(),
        };
        let round_trip = parse(&serialize(&evil));
        assert_eq!(
            round_trip.interests,
            vec!["first", "evil ## Working style injected", "third"]
        );
        assert_eq!(round_trip.goals, vec!["real goal"]);
        assert_eq!(round_trip.role, "Engineer");
        assert_eq!(round_trip.style, "Concise");
    }

    #[test]
    fn parse_is_case_insensitive_on_headings_and_joins_multi_line_prose() {
        let p = parse(
            "## ROLE\nline one\nline two\n\n## goals\n* a\n- b\n\nstray text\n## Interests\n",
        );
        assert_eq!(p.role, "line one line two");
        assert_eq!(p.goals, vec!["a", "b"]);
        assert!(p.interests.is_empty());
        assert!(parse("no headings at all").is_blank());
    }

    #[test]
    fn load_is_none_without_a_file_and_save_writes_the_vault_root() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(load(dir.path()), None);
        save(
            dir.path(),
            &Profile {
                role: "x".into(),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(load(dir.path()).unwrap().role, "x");
    }
}
