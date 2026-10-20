//! Bounded read-only previews for ingest and organization, independent of indexing.

use crate::local_synthesis::{self, Evidence, Prompt};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::io::Read;
use std::path::{Component, Path};

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Ingest,
    Organize,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Source {
    pub page: String,
    pub revision: String,
    pub text: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Request {
    pub request_id: String,
    pub expected_vault: String,
    pub kind: Kind,
    pub lang: String,
    pub model_id: Option<String>,
    #[serde(default)]
    pub origin: Option<crate::vault_session::AgentVaultSession>,
    #[serde(default)]
    pub role_snapshot: Option<crate::role_authorization::RoleSnapshot>,
    pub sources: Vec<Source>,
    #[serde(default)]
    pub(crate) session_compile: Option<crate::session_compile::SessionCompileContext>,
}

pub struct Checked {
    pub evidence: Vec<Evidence>,
    pub revisions: BTreeMap<String, String>,
}

fn allowed_path(page: &str) -> bool {
    page.len() <= 1024
        && page.ends_with(".md")
        && !page.contains(['[', ']', '|', '\\', '\r', '\n', '\0'])
        && Path::new(page).components().all(|part| {
            matches!(part, Component::Normal(name) if !name.to_string_lossy().starts_with('.'))
        })
        && ["raw/", "sessions/", "wiki/", "daily/", "weekly/", "monthly/"]
            .iter()
            .any(|prefix| page.starts_with(prefix))
}

fn recorded_date(value: &serde_json::Value) -> Option<&str> {
    let timestamp = value.as_str()?;
    (timestamp.len() <= 64
        && (crate::importers::parse_iso8601(timestamp).is_some()
            || (timestamp.len() == 10
                && crate::importers::parse_iso8601(&format!("{timestamp}T00:00:00Z")).is_some())))
    .then_some(timestamp)
}

/// Derive attribution from verified source bytes, never caller-provided labels.
fn attributed_passage(content: &str, excerpt: &str) -> String {
    let parsed =
        gray_matter::Matter::<gray_matter::engine::YAML>::new().parse::<serde_json::Value>(content);
    let mut attribution = serde_json::json!({"role":"Unknown", "timestamp":null});
    if let Ok(parsed) = parsed {
        let body = parsed.content;
        let metadata = parsed.data.unwrap_or(serde_json::Value::Null);
        let mut offset = 0;
        let mut headers = Vec::new();
        for line in body.split_inclusive('\n') {
            if crate::embeddings::is_transcript_turn_header(line) {
                headers.push((
                    offset,
                    line.trim().trim_start_matches("**").trim_end_matches(":**"),
                ));
            }
            offset += line.len();
        }
        if headers.is_empty() && body.contains(excerpt) {
            attribution = serde_json::json!({"role":"Source", "timestamp":recorded_date(&metadata["created"]), "date_basis":"document"});
        } else {
            let matches: Vec<_> = headers
                .iter()
                .enumerate()
                .filter(|(ordinal, (start, _))| {
                    let end = headers
                        .get(ordinal + 1)
                        .map_or(body.len(), |header| header.0);
                    body[*start..end].contains(excerpt)
                })
                .collect();
            let dates = metadata["turn_metadata"].as_array();
            let aligned = dates.filter(|dates| {
                dates.len() == headers.len() && dates.iter().all(serde_json::Value::is_object)
            });
            // Literal role markers in a turn can break the importer contract.
            // Neither the shifted speaker nor date is trustworthy in that case.
            if metadata.get("turn_metadata").is_some() && aligned.is_none() {
                attribution["ambiguous"] = serde_json::json!(true);
            } else if let [(ordinal, (_, role))] = matches.as_slice() {
                // An ordinal date requires the complete matching header contract.
                let timestamp =
                    aligned.and_then(|dates| recorded_date(&dates[*ordinal]["timestamp"]));
                attribution =
                    serde_json::json!({"role":role, "timestamp":timestamp, "date_basis":"turn"});
            } else if matches.len() > 1 {
                attribution["ambiguous"] = serde_json::json!(true);
            }
        }
    }
    // Unknown document-date boilerplate degraded the small model's citations.
    // A plain undated source has no extra attribution beyond its source ID/path.
    if attribution["role"] == "Source" && attribution["timestamp"].is_null() {
        excerpt.into()
    } else {
        format!("Recorded attribution: {attribution}\nVerbatim passage:\n{excerpt}")
    }
}

/// Bind every requested excerpt to current bytes; a valid revision is not evidence alone.
pub fn checked_sources(root: &Path, sources: &[Source]) -> Result<Checked, String> {
    if sources.is_empty() || sources.len() > 6 {
        return Err("local preview requires one to six source chunks".into());
    }
    let root = root
        .canonicalize()
        .map_err(|_| "preview vault unavailable")?;
    let mut contents = BTreeMap::new();
    let mut bytes = 0usize;
    let mut evidence = Vec::new();
    let mut revisions = BTreeMap::new();
    for (section, source) in sources.iter().enumerate() {
        if !allowed_path(&source.page)
            || source.revision.len() != 8
            || !source.revision.bytes().all(|byte| byte.is_ascii_hexdigit())
            || source.text.trim().is_empty()
            || source.text.chars().count() > 600
            || source.text.contains('\0')
        {
            return Err("invalid local preview source".into());
        }
        if !contents.contains_key(&source.page) {
            let path =
                crate::vault::confine_path(&root, &root.join(&source.page).to_string_lossy())?;
            let relative = path
                .strip_prefix(&root)
                .map_err(|_| "preview source escaped vault")?;
            if !allowed_path(&relative.to_string_lossy()) {
                return Err("resolved preview source is outside scope".into());
            }
            let metadata = std::fs::metadata(&path).map_err(|_| "preview source unavailable")?;
            if !metadata.is_file()
                || crate::vault::is_dataless(&metadata)
                || metadata.len() > 2 * 1024 * 1024
                || bytes + metadata.len() as usize > 8 * 1024 * 1024
            {
                return Err("preview source exceeds the read budget".into());
            }
            let mut content = String::new();
            std::fs::File::open(&path)
                .map_err(|_| "preview source unavailable")?
                .take(2 * 1024 * 1024 + 1)
                .read_to_string(&mut content)
                .map_err(|_| "preview source unreadable")?;
            bytes += content.len();
            if content.len() > 2 * 1024 * 1024 || bytes > 8 * 1024 * 1024 {
                return Err("preview source grew beyond the read budget".into());
            }
            revisions.insert(
                source.page.clone(),
                format!("{:x}", Sha256::digest(content.as_bytes())),
            );
            contents.insert(source.page.clone(), content);
        }
        let content = &contents[&source.page];
        if crate::distill::content_fingerprint(content.as_bytes()) != source.revision
            || !content.contains(&source.text)
        {
            return Err("preview source changed or excerpt was not found".into());
        }
        evidence.push(Evidence {
            title: None,
            compiled: None,
            page: source.page.clone(),
            stem: Path::new(&source.page)
                .file_stem()
                .and_then(|name| name.to_str())
                .ok_or("invalid preview filename")?
                .into(),
            section,
            text: attributed_passage(content, &source.text),
        });
    }
    Ok(Checked {
        evidence,
        revisions,
    })
}

/// Purpose-specific instructions; arbitrary agent/file-operation prompts are never accepted.
pub fn prepare(
    kind: Kind,
    lang: &str,
    evidence: &[Evidence],
    fits: impl Fn(&str, &str) -> Result<bool, String>,
) -> Result<Prompt, String> {
    let question = match (kind, lang) {
        (Kind::Ingest, "ko") => "이 자료에 명시된 핵심 사실과 결정은 무엇인가요? 요청·계획·보고된 결과를 구분하고, 최대 세 문장으로 요약하세요.",
        (Kind::Ingest, "en") => "What key facts and decisions are explicitly recorded in this source? Distinguish requests, plans and reported results. Summarize in at most three sentences.",
        (Kind::Ingest, "ja") => "この資料に明記された重要な事実と決定は何ですか？依頼・計画・報告された結果を区別し、三文以内で要約してください。",
        (Kind::Organize, "ko") => "이 기록들에 명시된 주요 사실·결정·상태 변경을 최대 세 문장으로 정리하세요. 이전 상태와 이후 변경, 요청과 보고된 결과를 구분하세요.",
        (Kind::Organize, "en") => "Organize the principal facts, decisions and status changes explicitly recorded here in at most three sentences. Distinguish earlier states from later changes and requests from reported results.",
        (Kind::Organize, "ja") => "これらの記録に明記された主要な事実・決定・状態の変更を三文以内で整理してください。以前の状態とその後の変更、依頼と報告された結果を区別してください。",
        _ => return Err("unsupported preview language".into()),
    };
    local_synthesis::prepare(question, None, lang, evidence, fits)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> (tempfile::TempDir, Source) {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir(dir.path().join("raw")).unwrap();
        let content =
            "# Synthetic source\n\nA proposed connector has no recorded implementation outcome.";
        std::fs::write(dir.path().join("raw/synthetic.md"), content).unwrap();
        let source = Source {
            page: "raw/synthetic.md".into(),
            revision: crate::distill::content_fingerprint(content.as_bytes()),
            text: "A proposed connector has no recorded implementation outcome.".into(),
        };
        (dir, source)
    }

    #[test]
    fn preview_verifies_current_raw_without_an_embedding_index() {
        let (dir, source) = fixture();
        let before = std::fs::read(dir.path().join(&source.page)).unwrap();
        let checked = checked_sources(dir.path(), &[source]).unwrap();
        assert_eq!(checked.evidence.len(), 1);
        assert_eq!(checked.revisions.len(), 1);
        assert_eq!(
            std::fs::read(dir.path().join("raw/synthetic.md")).unwrap(),
            before
        );
    }

    #[test]
    fn preview_keeps_original_speaker_and_turn_time_in_the_model_input() {
        let (dir, mut source) = fixture();
        let raw = "---\nturn_metadata: [{timestamp: '2026-10-04T10:00:00Z'}, {timestamp: '2026-10-05T10:00:00Z'}]\n---\n\n**User:**\n\nPlease add a connector.\n\n**Assistant:**\n\nThe connector is still a proposal.\n";
        std::fs::write(dir.path().join(&source.page), raw).unwrap();
        source.revision = crate::distill::content_fingerprint(raw.as_bytes());
        source.text = "The connector is still a proposal.".into();
        let checked = checked_sources(dir.path(), &[source]).unwrap();
        let prompt = prepare(Kind::Organize, "en", &checked.evidence, |_, _| Ok(true)).unwrap();
        let payload: serde_json::Value = serde_json::from_str(&prompt.user).unwrap();
        let passage = payload["sources"][0]["passage"].as_str().unwrap();
        assert!(passage.contains("\"role\":\"Assistant\""));
        assert!(passage.contains("2026-10-05T10:00:00Z"));
        assert!(!passage.contains("2026-10-04T10:00:00Z"));
        assert!(passage.contains("The connector is still a proposal."));
    }

    #[test]
    fn repeated_turn_text_never_inherits_the_first_turn_attribution() {
        let (dir, mut source) = fixture();
        let raw =
            "**User:**\n\nAn identical statement.\n\n**Assistant:**\n\nAn identical statement.\n";
        std::fs::write(dir.path().join(&source.page), raw).unwrap();
        source.revision = crate::distill::content_fingerprint(raw.as_bytes());
        source.text = "An identical statement.".into();
        let checked = checked_sources(dir.path(), &[source]).unwrap();
        assert!(checked.evidence[0].text.contains("\"role\":\"Unknown\""));
        assert!(checked.evidence[0].text.contains("\"ambiguous\":true"));
    }

    #[test]
    fn literal_role_header_collision_never_invents_a_tool_actor() {
        let raw = "---\nturn_metadata: [{timestamp: '2026-10-01T12:00:00Z'}, {timestamp: '2026-10-02T12:00:00Z'}]\n---\n\n**User:**\n\nA literal example follows.\n\n```text\n**Tool:**\n\nSYNTHETIC_HEADER_COLLISION decision\n```\n\n**Assistant:**\n\nActual assistant response.\n";
        let passage = attributed_passage(raw, "SYNTHETIC_HEADER_COLLISION decision");
        assert!(passage.contains("\"role\":\"Unknown\""));
        assert!(passage.contains("\"ambiguous\":true"));
        assert!(passage.contains("\"timestamp\":null"));
        for row in ["null", "'invalid'", "[]"] {
            let passage = attributed_passage(
                &format!(
                    "---\nturn_metadata: [{row}]\n---\n\n**Assistant:**\n\nA synthetic statement."
                ),
                "A synthetic statement.",
            );
            assert!(passage.contains("\"role\":\"Unknown\""));
            assert!(passage.contains("\"ambiguous\":true"));
        }
    }

    #[test]
    fn turn_dates_require_aligned_metadata_and_do_not_inherit_document_dates() {
        for (fields, role) in [
            ("created: '2026-10-01'\nturn_metadata: []", "Unknown"),
            (
                "created: '2026-10-01'\nturn_metadata: [{timestamp: 'invalid'}]",
                "Assistant",
            ),
        ] {
            let passage = attributed_passage(
                &format!("---\n{fields}\n---\n\n**Assistant:**\n\nStill a proposal.\n"),
                "Still a proposal.",
            );
            assert!(passage.contains(&format!("\"role\":\"{role}\"")));
            assert!(passage.contains("\"timestamp\":null"));
            assert!(!passage.contains("2026-10-01"));
        }
    }

    #[test]
    fn ordinary_source_dates_are_explicitly_document_dates() {
        let passage = attributed_passage(
            "---\ncreated: '2026-10-03'\n---\n\n# Synthetic\n\nA recorded fact.\n",
            "A recorded fact.",
        );
        assert!(passage.contains("\"role\":\"Source\""));
        assert!(passage.contains("\"date_basis\":\"document\""));
        assert!(passage.contains("2026-10-03"));
        assert_eq!(
            attributed_passage("# Synthetic\n\nA recorded fact.", "A recorded fact."),
            "A recorded fact."
        );
    }

    #[test]
    fn preview_rejects_stale_revisions_and_invented_excerpts() {
        let (dir, mut source) = fixture();
        let original = checked_sources(dir.path(), &[source.clone()])
            .unwrap()
            .revisions;
        source.text = "An unsupported completed connector.".into();
        assert!(checked_sources(dir.path(), &[source.clone()]).is_err());
        source.text = "A proposed connector has no recorded implementation outcome.".into();
        std::fs::write(
            dir.path().join(&source.page),
            format!("Changed\n{}", source.text),
        )
        .unwrap();
        assert!(checked_sources(dir.path(), &[source.clone()]).is_err());
        let changed = std::fs::read(dir.path().join(&source.page)).unwrap();
        source.revision = crate::distill::content_fingerprint(&changed);
        assert_ne!(
            checked_sources(dir.path(), &[source]).unwrap().revisions,
            original
        );
    }

    #[test]
    fn preview_bounds_paths_chunks_and_reads() {
        let (dir, source) = fixture();
        for page in [
            "../outside.md",
            "/tmp/outside.md",
            ".myco/settings.md",
            "raw/../wiki/a.md",
            "raw/[bad].md",
            "raw/a\\b.md",
        ] {
            let mut invalid = source.clone();
            invalid.page = page.into();
            assert!(checked_sources(dir.path(), &[invalid]).is_err(), "{page}");
        }
        assert!(checked_sources(dir.path(), &[]).is_err());
        assert!(checked_sources(dir.path(), &vec![source.clone(); 7]).is_err());
        let mut oversized = source;
        oversized.text = "x".repeat(601);
        assert!(checked_sources(dir.path(), &[oversized]).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn preview_rejects_an_outside_symlink() {
        let (dir, source) = fixture();
        let outside = tempfile::NamedTempFile::new().unwrap();
        std::fs::remove_file(dir.path().join(&source.page)).unwrap();
        std::os::unix::fs::symlink(outside.path(), dir.path().join(&source.page)).unwrap();
        assert!(checked_sources(dir.path(), &[source]).is_err());
    }

    #[test]
    fn preview_keeps_purpose_language_and_complete_evidence_under_budget() {
        let evidence = [Evidence {
            title: None,
            compiled: None,
            page: "raw/synthetic.md".into(),
            stem: "Synthetic".into(),
            section: 0,
            text: "SYNTHETIC_REQUEST_ONLY_NO_RECORDED_OUTCOME".into(),
        }];
        for kind in [Kind::Ingest, Kind::Organize] {
            for lang in ["ko", "en", "ja"] {
                let prompt = prepare(kind, lang, &evidence, |_, _| Ok(true)).unwrap();
                assert!(prompt.user.contains(&evidence[0].text));
                assert!(prompt.system.contains("never promote one into another"));
                assert!(prepare(kind, lang, &evidence, |_, _| Ok(false)).is_err());
            }
        }
    }
}
