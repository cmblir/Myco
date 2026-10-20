//! Synthetic native Audio boundaries; fake generation is not a meaning gate.

use super::*;
use crate::role_authorization::{self, RoleId, RoleSelectionRequest, RoleUsage};
use crate::settings::test_support::with_isolated_data;
use crate::vault_session::{AgentVaultSession, VaultRoot};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

const PAGE: &str = "---\ntitle: Synthetic first\n---\n# First synthetic note\nThe synthetic valve is a draft, with no completed rollout recorded.\n";
const EDITED: &str = "---\ntitle: Synthetic edited\n---\nA newer human edit must be preserved.\n";
const DATE: &str = "2026-10-11T12:00:00.000Z";
const TITLE: &str = "Synthetic audio";

struct Fixture {
    _directory: tempfile::TempDir,
    root: PathBuf,
    vault: Arc<VaultRoot>,
    registry: Arc<AudioOverviewRegistry>,
    origin: AgentVaultSession,
}

impl Fixture {
    fn new() -> Self {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().canonicalize().unwrap();
        let vault = Arc::new(VaultRoot::default());
        open(&vault, &root);
        let origin = vault.snapshot().unwrap();
        let fixture = Self {
            _directory: directory,
            root,
            vault,
            registry: Arc::new(AudioOverviewRegistry::default()),
            origin,
        };
        fixture.write("wiki/first.md", PAGE);
        fixture
    }

    fn path(&self, relative: &str) -> String {
        self.root.join(relative).to_string_lossy().into_owned()
    }

    fn write(&self, relative: &str, content: &str) {
        let path = self.root.join(relative);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, content).unwrap();
    }

    fn begin(&self, relative: &[&str]) -> Result<JobContext, String> {
        let paths: Vec<_> = relative.iter().map(|path| self.path(path)).collect();
        begin(
            &self.vault,
            &self.registry,
            &self.origin,
            &paths,
            TITLE,
            DATE,
        )
    }

    fn target(&self) -> PathBuf {
        self.root.join("audio/synthetic-audio-2026-10-11.md")
    }
}

fn open(vault: &VaultRoot, root: &Path) {
    let generation = vault.begin_open().unwrap();
    vault
        .finish_open(generation, root.to_path_buf(), || ())
        .unwrap();
}

fn runtime() -> tokio::runtime::Runtime {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
}

fn hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn dialogue(citation: &str) -> String {
    json!([
        {"speaker":"A","text":"What does this synthetic note say?","cites":[citation]},
        {"speaker":"B","text":"It records a draft and does not record a completed rollout.","cites":[citation]}
    ])
    .to_string()
}

fn prompt_head() -> String {
    let heads: Value =
        serde_json::from_str(include_str!("../../../src/lib/mycoPromptHeads.json")).unwrap();
    heads["audioOverview"].as_str().unwrap().to_owned()
}

fn draft_context(draft: &Draft) -> DraftContext {
    serde_json::from_value(serde_json::to_value(draft).unwrap()["context"].clone()).unwrap()
}

async fn generated(fixture: &Fixture, job: &JobContext) -> Draft {
    generate_with(&fixture.vault, &fixture.registry, job, |input| {
        assert!(input.system.starts_with(&prompt_head()));
        assert_eq!(input.role_snapshot.role, RoleId::Audio);
        assert_eq!(input.role_snapshot.usage, RoleUsage::Foreground);
        assert!(!input.cancelled.load(Ordering::Acquire));
        std::future::ready(Ok(dialogue("[[first]]")))
    })
    .await
    .unwrap()
}

fn assert_no_transcript(fixture: &Fixture) {
    assert!(!fixture.target().exists());
    match std::fs::read_dir(fixture.root.join("audio")) {
        Ok(directory) => assert_eq!(directory.count(), 0),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => panic!("inspect synthetic audio directory: {error}"),
    }
}

#[test]
fn unchanged_sources_issue_only_native_draft_and_persisted_receipt() {
    with_isolated_data("audio-unchanged", |_| {
        runtime().block_on(async {
            let fixture = Fixture::new();
            let job = fixture.begin(&["wiki/first.md"]).unwrap();
            let draft = generated(&fixture, &job).await;
            assert_no_transcript(&fixture);
            let value = serde_json::to_value(&draft).unwrap();
            assert_eq!(value["sourcePages"], json!([fixture.path("wiki/first.md")]));
            assert_eq!(value["coverage"]["includedPages"], value["sourcePages"]);
            assert_eq!(value["coverage"]["selectedPages"], value["sourcePages"]);
            assert_eq!(value["coverage"]["omittedPages"], json!([]));
            assert_eq!(value["coverage"]["budgetBytes"], 24_000);
            assert_eq!(value["coverage"]["includedBodiesOnly"], true);
            let ranges = value["coverage"]["includedBodyRanges"].as_array().unwrap();
            assert_eq!(ranges.len(), 1);
            let start = ranges[0]["startByte"].as_u64().unwrap() as usize;
            let end = ranges[0]["endByte"].as_u64().unwrap() as usize;
            assert!(start < end && end <= PAGE.len());
            assert_eq!(ranges[0]["path"], fixture.path("wiki/first.md"));
            assert!(PAGE.is_char_boundary(start) && PAGE.is_char_boundary(end));
            let context = draft_context(&draft);
            let publication = publish(&fixture.vault, &fixture.registry, &context).unwrap();
            let receipt = serde_json::to_value(publication).unwrap();
            assert_eq!(receipt["state"], "persisted");
            assert_eq!(receipt["error"], Value::Null);
            assert_eq!(receipt["jobId"], job.job_id);
            assert_eq!(receipt["draftId"], context.draft_id);
            assert_eq!(
                receipt["origin"],
                serde_json::to_value(&fixture.origin).unwrap()
            );
            assert_eq!(receipt["path"], fixture.target().to_string_lossy().as_ref());
            let actual = std::fs::read(fixture.target()).unwrap();
            assert_eq!(receipt["revision"], hash(&actual));
            assert_eq!(
                std::fs::read(fixture.path("wiki/first.md")).unwrap(),
                PAGE.as_bytes()
            );
            let repeated = publish(&fixture.vault, &fixture.registry, &context).unwrap();
            assert_eq!(serde_json::to_value(repeated).unwrap(), receipt);
            assert_eq!(std::fs::read(fixture.target()).unwrap(), actual);
            assert_eq!(
                std::fs::read_dir(fixture.root.join("audio"))
                    .unwrap()
                    .count(),
                1
            );
        });
    });
}

#[test]
fn admission_refuses_unreadable_later_selection_and_first_over_budget_page() {
    with_isolated_data("audio-admission-read-budget", |_| {
        let fixture = Fixture::new();
        let error = fixture
            .begin(&["wiki/first.md", "wiki/missing.md"])
            .unwrap_err();
        assert!(
            error.contains("source") || error.contains("read"),
            "{error}"
        );
        assert_eq!(fixture.registry.len(), 0);
        assert_no_transcript(&fixture);
        fixture.write(
            "wiki/large.md",
            &format!("# Synthetic oversized\n{}", "가".repeat(9_000)),
        );
        let error = fixture
            .begin(&["wiki/large.md", "wiki/first.md"])
            .unwrap_err();
        assert!(error.contains("budget"), "{error}");
        assert_eq!(fixture.registry.len(), 0);
        assert_no_transcript(&fixture);
    });
}

#[test]
fn unreadable_selection_after_budget_exclusion_is_not_silently_skipped() {
    with_isolated_data("audio-read-all-selections", |_| {
        let fixture = Fixture::new();
        fixture.write("wiki/excluded.md", &"x".repeat(24_000));
        let result = fixture.begin(&["wiki/first.md", "wiki/excluded.md", "wiki/missing.md"]);
        let error = result.unwrap_err();
        assert!(
            error.contains("source") || error.contains("read"),
            "{error}"
        );
        assert_no_transcript(&fixture);
    });
}

#[test]
fn excluded_source_citations_fail_both_format_attempts_without_draft_or_file() {
    with_isolated_data("audio-excluded-cites", |_| {
        runtime().block_on(async {
            let fixture = Fixture::new();
            fixture.write("wiki/excluded.md", &"x".repeat(24_000));
            let job = fixture
                .begin(&["wiki/first.md", "wiki/excluded.md"])
                .unwrap();
            let calls = AtomicUsize::new(0);
            let result = generate_with(&fixture.vault, &fixture.registry, &job, |input| {
                assert!(!input.user.contains(&"x".repeat(100)));
                calls.fetch_add(1, Ordering::SeqCst);
                std::future::ready(Ok(dialogue("[[excluded]]")))
            })
            .await;
            let error = result.unwrap_err();
            assert!(
                error.contains("dialogue") || error.contains("citation"),
                "{error}"
            );
            assert_eq!(calls.load(Ordering::SeqCst), 2);
            assert_eq!(fixture.registry.active_count(), 0);
            assert!(fixture.registry.draft_for_test(&job).unwrap().is_none());
            assert_no_transcript(&fixture);
        });
    });
}

#[test]
fn job_and_draft_contexts_cannot_supply_model_content_or_target_authority() {
    with_isolated_data("audio-closed-context", |_| {
        runtime().block_on(async {
            let fixture = Fixture::new();
            let job = fixture.begin(&["wiki/first.md"]).unwrap();
            let job_value = serde_json::to_value(&job).unwrap();
            for field in [
                "provider",
                "model",
                "roleSnapshot",
                "usage",
                "content",
                "target",
                "paths",
            ] {
                let mut forged = job_value.clone();
                forged[field] = json!("synthetic-forgery");
                assert!(
                    serde_json::from_value::<JobContext>(forged).is_err(),
                    "job accepted {field}"
                );
            }
            let draft = generated(&fixture, &job).await;
            let context = draft_context(&draft);
            let context_value = serde_json::to_value(&context).unwrap();
            for field in [
                "script",
                "content",
                "path",
                "target",
                "persisted",
                "revision",
                "roleSnapshot",
            ] {
                let mut forged = context_value.clone();
                forged[field] = json!("synthetic-forgery");
                assert!(
                    serde_json::from_value::<DraftContext>(forged).is_err(),
                    "draft accepted {field}"
                );
            }
            let mut wrong_job = job.clone();
            wrong_job.job_id = "synthetic-other-job".into();
            let calls = AtomicUsize::new(0);
            assert!(
                generate_with(&fixture.vault, &fixture.registry, &wrong_job, |_| {
                    calls.fetch_add(1, Ordering::SeqCst);
                    std::future::ready(Ok(dialogue("[[first]]")))
                })
                .await
                .is_err()
            );
            assert_eq!(calls.load(Ordering::SeqCst), 0);
            let mut wrong_draft = context.clone();
            wrong_draft.draft_id = "synthetic-other-draft".into();
            assert!(publish(&fixture.vault, &fixture.registry, &wrong_draft).is_err());
            assert_no_transcript(&fixture);
            publish(&fixture.vault, &fixture.registry, &context).unwrap();
        });
    });
}

#[derive(Clone, Copy, Debug)]
enum SourceMutation {
    Edit,
    ReplaceSameBytes,
    Delete,
}

fn mutate_source(fixture: &Fixture, mutation: SourceMutation) {
    let source = fixture.path("wiki/first.md");
    match mutation {
        SourceMutation::Edit => crate::vault::write_file(&source, EDITED).unwrap(),
        SourceMutation::ReplaceSameBytes => {
            std::fs::rename(&source, fixture.root.join("replaced-original.md")).unwrap();
            std::fs::write(&source, PAGE).unwrap();
        }
        SourceMutation::Delete => {
            crate::vault::remove_all(&[PathBuf::from(source)]).unwrap();
        }
    }
}

fn assert_source_preserved(fixture: &Fixture, mutation: SourceMutation) {
    let path = fixture.path("wiki/first.md");
    match mutation {
        SourceMutation::Edit => assert_eq!(std::fs::read(path).unwrap(), EDITED.as_bytes()),
        SourceMutation::ReplaceSameBytes => {
            assert_eq!(std::fs::read(path).unwrap(), PAGE.as_bytes());
            assert_eq!(
                std::fs::read(fixture.root.join("replaced-original.md")).unwrap(),
                PAGE.as_bytes()
            );
        }
        SourceMutation::Delete => assert!(!Path::new(&path).exists()),
    }
    assert_no_transcript(fixture);
}

#[test]
fn decode_and_repair_postcheck_actual_source_even_when_generation_returns_error() {
    with_isolated_data("audio-source-postchecks", |_| {
        runtime().block_on(async {
            for mutation in [SourceMutation::Edit, SourceMutation::ReplaceSameBytes, SourceMutation::Delete] {
                for changed_attempt in [0, 1] {
                    for transport_error in [false, true] {
                        let fixture = Fixture::new();
                        let job = fixture.begin(&["wiki/first.md"]).unwrap();
                        let calls = AtomicUsize::new(0);
                        let mut initial_binding: Option<(String, String, Value)> = None;
                        let result = generate_with(&fixture.vault, &fixture.registry, &job, |input| {
                            assert_eq!(input.attempt, calls.fetch_add(1, Ordering::SeqCst));
                            assert!(input.system.starts_with(&prompt_head()));
                            assert!(input.user.contains("no completed rollout recorded"));
                            assert_eq!(input.request_id, format!("audio-{}-{}", job.job_id, input.attempt));
                            let binding = (input.system.clone(), input.user.clone(), serde_json::to_value(&input.role_snapshot).unwrap());
                            if let Some(expected) = &initial_binding {
                                assert_eq!(&binding, expected, "repair recaptured initial authority");
                            } else {
                                initial_binding = Some(binding);
                            }
                            if input.attempt != changed_attempt {
                                return std::future::ready(Ok("not valid dialogue JSON".into()));
                            }
                            mutate_source(&fixture, mutation);
                            std::future::ready(if transport_error {
                                Err("synthetic transport failure".into())
                            } else {
                                Ok(dialogue("[[first]]"))
                            })
                        })
                        .await;
                        let error = result.unwrap_err();
                        assert!(error.contains("source"), "mutation={mutation:?} attempt={changed_attempt} transport={transport_error}: {error}");
                        assert_ne!(error, "synthetic transport failure");
                        assert_eq!(calls.load(Ordering::SeqCst), changed_attempt + 1);
                        assert_eq!(fixture.registry.active_count(), 0);
                        assert!(fixture.registry.draft_for_test(&job).unwrap().is_none());
                        assert_source_preserved(&fixture, mutation);
                    }
                }
            }
        });
    });
}

fn revoke_audio_role() {
    role_authorization::select_role(RoleSelectionRequest {
        role: RoleId::Audio,
        provider_id: "builtin-local".into(),
        model_id: crate::local_model::SMALL_MODEL.id.into(),
        effort: "(default)".into(),
        expected_authorization_revision: role_authorization::settings_snapshot()
            .unwrap()
            .role_authorization_revision,
    })
    .unwrap();
}

#[test]
fn genuine_other_role_and_automatic_grants_never_dispatch_manual_audio() {
    with_isolated_data("audio-exact-role-usage", |_| {
        runtime().block_on(async {
            for (role, usage) in [
                (RoleId::Ask, RoleUsage::Foreground),
                (RoleId::Audio, RoleUsage::Automatic),
            ] {
                let fixture = Fixture::new();
                let job = fixture.begin(&["wiki/first.md"]).unwrap();
                let grant =
                    role_authorization::capture_role_at(&fixture.origin, role, usage).unwrap();
                role_authorization::with_current_role_at(
                    &fixture.origin,
                    &grant,
                    role,
                    usage,
                    || Ok(()),
                )
                .unwrap();
                fixture
                    .registry
                    .replace_role_snapshot_for_test(&job, grant)
                    .unwrap();
                let calls = AtomicUsize::new(0);
                let result = generate_with(&fixture.vault, &fixture.registry, &job, |_| {
                    calls.fetch_add(1, Ordering::SeqCst);
                    std::future::ready(Ok(dialogue("[[first]]")))
                })
                .await;
                let error = result.unwrap_err();
                assert!(error.contains("role"), "{role:?}/{usage:?}: {error}");
                assert_eq!(calls.load(Ordering::SeqCst), 0);
                assert_no_transcript(&fixture);
            }
        });
    });
}

#[test]
fn reopen_and_revocation_postcheck_decode_and_repair_even_on_error() {
    with_isolated_data("audio-authority-postchecks", |_| {
        runtime().block_on(async {
            for reopen in [false, true] {
                for changed_attempt in [0, 1] {
                    for transport_error in [false, true] {
                        let fixture = Fixture::new();
                        let job = fixture.begin(&["wiki/first.md"]).unwrap();
                        let calls = AtomicUsize::new(0);
                        let result =
                            generate_with(&fixture.vault, &fixture.registry, &job, |input| {
                                calls.fetch_add(1, Ordering::SeqCst);
                                if input.attempt != changed_attempt {
                                    return std::future::ready(Ok("invalid dialogue".into()));
                                }
                                if reopen {
                                    open(&fixture.vault, &fixture.root);
                                    let newer = fixture.vault.snapshot().unwrap();
                                    assert_eq!(newer.vault_path, fixture.origin.vault_path);
                                    assert_ne!(newer.opening_token, fixture.origin.opening_token);
                                } else {
                                    revoke_audio_role();
                                }
                                std::future::ready(if transport_error {
                                    Err("synthetic transport failure".into())
                                } else {
                                    Ok(dialogue("[[first]]"))
                                })
                            })
                            .await;
                        let error = result.unwrap_err();
                        if reopen {
                            assert!(error.contains("active vault changed"), "{error}");
                        } else {
                            assert!(
                                error.contains("snapshot_stale") || error.contains("role"),
                                "{error}"
                            );
                        }
                        assert_ne!(error, "synthetic transport failure");
                        assert_eq!(calls.load(Ordering::SeqCst), changed_attempt + 1);
                        assert_eq!(
                            std::fs::read(fixture.path("wiki/first.md")).unwrap(),
                            PAGE.as_bytes()
                        );
                        assert_no_transcript(&fixture);
                    }
                }
            }
        });
    });
}

#[test]
fn exact_cancel_during_decode_or_repair_rejects_late_result_without_cancelling_new_job() {
    with_isolated_data("audio-cancel-attempts", |_| {
        runtime().block_on(async {
            for cancelled_attempt in [0, 1] {
                let fixture = Fixture::new();
                let job = fixture.begin(&["wiki/first.md"]).unwrap();
                let newer = fixture.begin(&["wiki/first.md"]).unwrap();
                let calls = AtomicUsize::new(0);
                let result = generate_with(&fixture.vault, &fixture.registry, &job, |input| {
                    calls.fetch_add(1, Ordering::SeqCst);
                    if input.attempt != cancelled_attempt {
                        return std::future::ready(Ok("invalid dialogue".into()));
                    }
                    assert!(cancel(&fixture.registry, &job).unwrap());
                    assert!(input.cancelled.load(Ordering::Acquire));
                    std::future::ready(Ok(dialogue("[[first]]")))
                })
                .await;
                let error = result.unwrap_err();
                assert!(error.contains("cancel"), "{error}");
                assert_eq!(calls.load(Ordering::SeqCst), cancelled_attempt + 1);
                assert_no_transcript(&fixture);
                let draft = generated(&fixture, &newer).await;
                assert!(publish(&fixture.vault, &fixture.registry, &draft_context(&draft)).is_ok());
            }
        });
    });
}

#[test]
fn cancelled_late_begin_response_and_wrong_origin_never_adopt_or_dispatch() {
    with_isolated_data("audio-cancel-late-begin", |_| {
        runtime().block_on(async {
            let fixture = Fixture::new();
            let late_job = fixture.begin(&["wiki/first.md"]).unwrap();
            let mut forged = late_job.clone();
            forged.origin.opening_token = "synthetic-wrong-opening".into();
            assert!(cancel(&fixture.registry, &forged).is_err());
            assert!(cancel(&fixture.registry, &late_job).unwrap());
            let calls = AtomicUsize::new(0);
            let result = generate_with(&fixture.vault, &fixture.registry, &late_job, |_| {
                calls.fetch_add(1, Ordering::SeqCst);
                std::future::ready(Ok(dialogue("[[first]]")))
            })
            .await;
            assert!(result.unwrap_err().contains("cancel"));
            assert_eq!(calls.load(Ordering::SeqCst), 0);
            assert_no_transcript(&fixture);
        });
    });
}

#[test]
fn existing_human_transcript_is_preserved_after_valid_draft() {
    with_isolated_data("audio-human-target", |_| {
        runtime().block_on(async {
            let fixture = Fixture::new();
            let job = fixture.begin(&["wiki/first.md"]).unwrap();
            let draft = generated(&fixture, &job).await;
            fixture.write("audio/synthetic-audio-2026-10-11.md", EDITED);
            let result = publish(&fixture.vault, &fixture.registry, &draft_context(&draft));
            let error = result.unwrap_err();
            assert!(
                error.contains("conflict") || error.contains("exists"),
                "{error}"
            );
            assert_eq!(std::fs::read(fixture.target()).unwrap(), EDITED.as_bytes());
            assert_eq!(
                std::fs::read(fixture.path("wiki/first.md")).unwrap(),
                PAGE.as_bytes()
            );
        });
    });
}

#[test]
fn two_simultaneous_native_drafts_have_exactly_one_absence_cas_winner() {
    with_isolated_data("audio-two-publications", |_| {
        runtime().block_on(async {
            let fixture = Fixture::new();
            let first = fixture.begin(&["wiki/first.md"]).unwrap();
            let second = fixture.begin(&["wiki/first.md"]).unwrap();
            assert_ne!(first.job_id, second.job_id);
            let first = draft_context(&generated(&fixture, &first).await);
            let second = draft_context(&generated(&fixture, &second).await);
            let barrier = Arc::new(std::sync::Barrier::new(3));
            let mut workers = Vec::new();
            for context in [first, second] {
                let vault = fixture.vault.clone();
                let registry = fixture.registry.clone();
                let entered = barrier.clone();
                workers.push(std::thread::spawn(move || {
                    entered.wait();
                    publish(&vault, &registry, &context)
                }));
            }
            barrier.wait();
            let outcomes: Vec<_> = workers
                .into_iter()
                .map(|worker| worker.join().unwrap())
                .collect();
            assert_eq!(
                outcomes.iter().filter(|result| result.is_ok()).count(),
                1,
                "{outcomes:?}"
            );
            assert_eq!(outcomes.iter().filter(|result| result.is_err()).count(), 1);
            let winner = outcomes
                .iter()
                .find_map(|result| result.as_ref().ok())
                .unwrap();
            let winner = serde_json::to_value(winner).unwrap();
            assert_eq!(winner["state"], "persisted");
            assert_eq!(
                winner["revision"],
                hash(&std::fs::read(fixture.target()).unwrap())
            );
            let loser = outcomes
                .iter()
                .find_map(|result| result.as_ref().err())
                .unwrap();
            assert!(
                loser.contains("conflict") || loser.contains("exists"),
                "{loser}"
            );
            assert_eq!(
                std::fs::read_dir(fixture.root.join("audio"))
                    .unwrap()
                    .count(),
                1
            );
            assert_eq!(
                std::fs::read(fixture.path("wiki/first.md")).unwrap(),
                PAGE.as_bytes()
            );
        });
    });
}

#[test]
fn persisted_without_receipt_returns_sticky_partial_and_never_retry_overwrites() {
    with_isolated_data("audio-persist-receipt-failure", |_| {
        runtime().block_on(async {
            let fixture = Fixture::new();
            let job = fixture.begin(&["wiki/first.md"]).unwrap();
            let draft = generated(&fixture, &job).await;
            let context = draft_context(&draft);
            let calls = AtomicUsize::new(0);
            let partial = publish_with(
                &fixture.vault,
                &fixture.registry,
                &context,
                || {},
                |path| {
                    calls.fetch_add(1, Ordering::SeqCst);
                    assert_eq!(path, fixture.target());
                    assert!(std::fs::read(path)
                        .unwrap()
                        .starts_with(b"# Audio Overview"));
                    Err("synthetic receipt checkpoint failure".into())
                },
            )
            .unwrap();
            let partial = serde_json::to_value(partial).unwrap();
            assert_eq!(partial["state"], "partial");
            assert_eq!(partial["revision"], Value::Null);
            assert!(partial["error"]
                .as_str()
                .unwrap()
                .contains("receipt checkpoint"));
            assert_eq!(calls.load(Ordering::SeqCst), 1);
            let retained = fixture.registry.draft_for_test(&job).unwrap().unwrap();
            assert_eq!(
                serde_json::to_value(retained).unwrap(),
                serde_json::to_value(&draft).unwrap()
            );
            let initially_persisted = std::fs::read(fixture.target()).unwrap();
            assert!(String::from_utf8(initially_persisted)
                .unwrap()
                .contains("does not record a completed rollout"));
            crate::vault::write_file(&fixture.target().to_string_lossy(), EDITED).unwrap();
            let retried = publish_with(
                &fixture.vault,
                &fixture.registry,
                &context,
                || {},
                |_| {
                    calls.fetch_add(1, Ordering::SeqCst);
                    Ok(())
                },
            )
            .unwrap();
            assert_eq!(serde_json::to_value(retried).unwrap(), partial);
            assert_eq!(calls.load(Ordering::SeqCst), 1, "partial retry wrote again");
            assert_eq!(std::fs::read(fixture.target()).unwrap(), EDITED.as_bytes());
            assert_eq!(
                std::fs::read(fixture.path("wiki/first.md")).unwrap(),
                PAGE.as_bytes()
            );
            assert_eq!(
                serde_json::to_value(fixture.registry.draft_for_test(&job).unwrap().unwrap())
                    .unwrap(),
                serde_json::to_value(&draft).unwrap()
            );
        });
    });
}

#[test]
fn preview_source_changes_reopen_revocation_and_cancel_prevent_publication() {
    with_isolated_data("audio-preview-postchecks", |_| {
        runtime().block_on(async {
            for boundary in ["edit", "replace", "delete", "reopen", "revoke", "cancel"] {
                let fixture = Fixture::new();
                let job = fixture.begin(&["wiki/first.md"]).unwrap();
                let draft = generated(&fixture, &job).await;
                match boundary {
                    "edit" => mutate_source(&fixture, SourceMutation::Edit),
                    "replace" => mutate_source(&fixture, SourceMutation::ReplaceSameBytes),
                    "delete" => mutate_source(&fixture, SourceMutation::Delete),
                    "reopen" => open(&fixture.vault, &fixture.root),
                    "revoke" => revoke_audio_role(),
                    "cancel" => assert!(cancel(&fixture.registry, &job).unwrap()),
                    _ => unreachable!(),
                }
                let result = publish(&fixture.vault, &fixture.registry, &draft_context(&draft));
                let error = result.unwrap_err();
                match boundary {
                    "edit" | "replace" | "delete" => {
                        assert!(error.contains("source"), "{boundary}: {error}")
                    }
                    "reopen" => assert!(error.contains("active vault changed"), "{error}"),
                    "revoke" => assert!(
                        error.contains("snapshot_stale") || error.contains("role"),
                        "{error}"
                    ),
                    "cancel" => assert!(error.contains("cancel"), "{error}"),
                    _ => unreachable!(),
                }
                assert_no_transcript(&fixture);
            }
        });
    });
}

#[test]
fn publisher_wins_writer_order_without_later_mutations_rewriting_transcript() {
    with_isolated_data("audio-cooperating-writer-wait", |_| {
        runtime().block_on(async {
            for operation in ["edit", "move", "delete", "archive"] {
                let fixture = Fixture::new();
                fixture.write("_inbox/first.md", PAGE);
                std::fs::create_dir_all(fixture.root.join("moved")).unwrap();
                let source = fixture.path("_inbox/first.md");
                let job = fixture.begin(&["_inbox/first.md"]).unwrap();
                let draft = generated(&fixture, &job).await;
                let context = draft_context(&draft);
                let vault = fixture.vault.clone();
                let registry = fixture.registry.clone();
                let (entered, reached) = std::sync::mpsc::channel();
                let guard = crate::vault::lock_file_mutation().unwrap();
                let publisher = std::thread::spawn(move || {
                    publish_with(
                        &vault,
                        &registry,
                        &context,
                        || entered.send(()).unwrap(),
                        |_| Ok(()),
                    )
                });
                let reached = reached.recv_timeout(Duration::from_secs(5));
                // The publisher owns earlier guards while it waits for FILE.
                // Release before any locking mutation and before assertions.
                drop(guard);
                let outcome = publisher.join().unwrap();
                reached.unwrap();
                // This ordering control must publish before later mutations;
                // the complementary source-wins case below uses real helpers.
                let receipt = outcome.unwrap();
                assert_eq!(serde_json::to_value(receipt).unwrap()["state"], "persisted");
                let transcript = std::fs::read(fixture.target()).unwrap();
                match operation {
                    "edit" => crate::vault::write_file(&source, EDITED).unwrap(),
                    "move" => {
                        crate::vault::move_path_checked_at(
                            &fixture.root,
                            &source,
                            &fixture.path("moved"),
                        )
                        .unwrap();
                    }
                    "delete" => crate::vault::remove_all(&[PathBuf::from(&source)]).unwrap(),
                    "archive" => {
                        crate::vault::archive_inbox_source_checked_at(
                            &fixture.root,
                            &source,
                            Some(&hash(PAGE.as_bytes())),
                        )
                        .unwrap();
                    }
                    _ => unreachable!(),
                }
                assert_eq!(std::fs::read(fixture.target()).unwrap(), transcript);
            }
        });
    });
}

#[test]
fn cooperating_editor_move_delete_and_archive_win_before_publication_writer() {
    with_isolated_data("audio-source-wins-writer", |_| {
        runtime().block_on(async {
            for operation in ["edit", "move", "delete", "archive"] {
                let fixture = Fixture::new();
                fixture.write("_inbox/first.md", PAGE);
                std::fs::create_dir_all(fixture.root.join("moved")).unwrap();
                let source = fixture.path("_inbox/first.md");
                // A separately opened native state avoids reacquiring the
                // publisher's held opening guard; both use the real FILE guard.
                let editor = VaultRoot::default();
                open(&editor, &fixture.root);
                let editor_origin = editor.snapshot().unwrap();
                let baseline = crate::editor_io::read(&editor, &source, &editor_origin).unwrap();
                let job = fixture.begin(&["_inbox/first.md"]).unwrap();
                let draft = generated(&fixture, &job).await;
                let context = draft_context(&draft);
                let vault = fixture.vault.clone();
                let registry = fixture.registry.clone();
                let (entered, reached) = std::sync::mpsc::channel();
                let (resume, resumed) = std::sync::mpsc::channel();
                let publisher = std::thread::spawn(move || {
                    publish_with(
                        &vault,
                        &registry,
                        &context,
                        || {
                            entered.send(()).unwrap();
                            resumed.recv_timeout(Duration::from_secs(5)).unwrap();
                        },
                        |_| Ok(()),
                    )
                });
                let reached = reached.recv_timeout(Duration::from_secs(5));
                let mutation = if reached.is_ok() {
                    match operation {
                        "edit" => crate::editor_io::write(
                            &editor,
                            &source,
                            EDITED,
                            &baseline.revision,
                            &editor_origin,
                        )
                        .map(|_| ()),
                        "move" => crate::vault::move_path_checked_at(
                            &fixture.root,
                            &source,
                            &fixture.path("moved"),
                        )
                        .map(|_| ()),
                        "delete" => crate::vault::remove_all(&[PathBuf::from(&source)]),
                        "archive" => crate::vault::archive_inbox_source_checked_at(
                            &fixture.root,
                            &source,
                            Some(&hash(PAGE.as_bytes())),
                        )
                        .map(|_| ()),
                        _ => unreachable!(),
                    }
                } else {
                    Err("synthetic publisher did not reach writer boundary".into())
                };
                // Release and join before assertions, including plumbing errors.
                let resumed = resume.send(());
                let outcome = publisher.join().unwrap();
                reached.unwrap();
                resumed.unwrap();
                mutation.unwrap();
                let error = outcome.unwrap_err();
                assert!(error.contains("source"), "{operation}: {error}");
                assert_no_transcript(&fixture);
                match operation {
                    "edit" => assert_eq!(std::fs::read(&source).unwrap(), EDITED.as_bytes()),
                    "move" => {
                        assert!(!Path::new(&source).exists());
                        assert_eq!(
                            std::fs::read(fixture.root.join("moved/first.md")).unwrap(),
                            PAGE.as_bytes()
                        );
                    }
                    "delete" => assert!(!Path::new(&source).exists()),
                    "archive" => {
                        assert!(!Path::new(&source).exists());
                        assert_eq!(
                            std::fs::read(fixture.root.join("_inbox/.archived/first.md")).unwrap(),
                            PAGE.as_bytes()
                        );
                    }
                    _ => unreachable!(),
                }
            }
        });
    });
}

#[test]
fn cancelled_pending_decode_and_repair_keep_owner_until_callback_reports_terminal() {
    with_isolated_data("audio-cancel-pending-owner", |_| {
        runtime().block_on(async {
            for blocked_attempt in [0, 1] {
                let fixture = Fixture::new();
                let job = fixture.begin(&["wiki/first.md"]).unwrap();
                let worker_job = job.clone();
                let vault = fixture.vault.clone();
                let registry = fixture.registry.clone();
                let (entered, reached) = tokio::sync::oneshot::channel();
                let (resume, resumed) = tokio::sync::oneshot::channel();
                let worker = tokio::spawn(async move {
                    let mut entered = Some(entered);
                    let mut resumed = Some(resumed);
                    generate_with(&vault, &registry, &worker_job, move |input| {
                        let blocked = input.attempt == blocked_attempt;
                        let wait = if blocked {
                            entered
                                .take()
                                .unwrap()
                                .send(input.cancelled.clone())
                                .unwrap();
                            Some(resumed.take().unwrap())
                        } else {
                            None
                        };
                        async move {
                            if let Some(wait) = wait {
                                wait.await.map_err(|_| {
                                    "synthetic callback terminal channel closed".to_string()
                                })?;
                            }
                            Ok(if blocked {
                                dialogue("[[first]]")
                            } else {
                                "invalid dialogue".into()
                            })
                        }
                    })
                    .await
                });
                let flag = tokio::time::timeout(Duration::from_secs(5), reached)
                    .await
                    .unwrap()
                    .unwrap();
                assert_eq!(fixture.registry.active_count(), 1);
                assert!(cancel(&fixture.registry, &job).unwrap());
                assert!(flag.load(Ordering::Acquire));
                tokio::task::yield_now().await;
                assert!(
                    !worker.is_finished(),
                    "cancel fabricated callback termination"
                );
                assert_eq!(fixture.registry.active_count(), 1);
                assert!(fixture.registry.draft_for_test(&job).unwrap().is_none());
                resume.send(()).unwrap();
                let result = tokio::time::timeout(Duration::from_secs(5), worker)
                    .await
                    .unwrap()
                    .unwrap();
                assert!(result.unwrap_err().contains("cancel"));
                assert_eq!(fixture.registry.active_count(), 0);
                assert!(fixture.registry.draft_for_test(&job).unwrap().is_none());
                assert_no_transcript(&fixture);
            }
        });
    });
}

#[test]
fn coverage_and_citations_use_included_body_bytes_not_all_selected_or_frontmatter() {
    with_isolated_data("audio-included-body-citations", |_| {
        runtime().block_on(async {
            let fixture = Fixture::new();
            const INCLUDED: &str = "---\ntitle: Synthetic first\nprivateCitation: '[^src-frontmatter]'\n---\n# Synthetic included body\nThis body supplies [^src-included].\n";
            fixture.write("wiki/first.md", INCLUDED);
            fixture.write("wiki/excluded.md", &format!("{}\n[^src-excluded]", "x".repeat(24_000)));
            let job = fixture.begin(&["wiki/first.md", "wiki/excluded.md"]).unwrap();
            let draft = generate_with(&fixture.vault, &fixture.registry, &job, |input| {
                assert!(input.user.contains("[^src-included]"));
                assert!(!input.user.contains("[^src-frontmatter]"));
                assert!(!input.user.contains("[^src-excluded]"));
                let notes = input.user.split_once("NOTES:\n").unwrap().1;
                assert!(notes.len() <= 24_000);
                std::future::ready(Ok(dialogue("[^src-included]")))
            }).await.unwrap();
            assert_eq!(draft.source_pages, vec![fixture.path("wiki/first.md")]);
            assert_eq!(draft.coverage.selected_pages, vec![fixture.path("wiki/first.md"), fixture.path("wiki/excluded.md")]);
            assert_eq!(draft.coverage.included_pages, draft.source_pages);
            assert_eq!(draft.coverage.omitted_pages, vec![fixture.path("wiki/excluded.md")]);
            let range = &draft.coverage.included_body_ranges[0];
            assert_eq!(&INCLUDED[range.start_byte..range.end_byte], "# Synthetic included body\nThis body supplies [^src-included].");
            let publication = publish(&fixture.vault, &fixture.registry, &draft.context).unwrap();
            assert_eq!(publication.state, PublicationState::Persisted);
            let transcript = std::fs::read_to_string(fixture.target()).unwrap();
            assert!(transcript.contains("[^src-included]"));
            assert!(!transcript.contains("src-frontmatter"));
            assert!(!transcript.contains("src-excluded"));
            assert!(!transcript.contains("[[excluded]]"));
            for citation in ["[^src-frontmatter]", "[^src-excluded]"] {
                let other = Fixture::new();
                other.write("wiki/first.md", INCLUDED);
                other.write("wiki/excluded.md", &"x".repeat(24_000));
                let job = other.begin(&["wiki/first.md", "wiki/excluded.md"]).unwrap();
                let calls = AtomicUsize::new(0);
                let result = generate_with(&other.vault, &other.registry, &job, |_| {
                    calls.fetch_add(1, Ordering::SeqCst);
                    std::future::ready(Ok(dialogue(citation)))
                }).await;
                assert!(result.unwrap_err().contains("unincluded citation"));
                assert_eq!(calls.load(Ordering::SeqCst), 2);
                assert!(other.registry.draft_for_test(&job).unwrap().is_none());
                assert_no_transcript(&other);
            }
        });
    });
}

#[test]
fn omitted_selected_original_stays_bound_through_generation() {
    with_isolated_data("audio-omitted-source-change", |_| {
        runtime().block_on(async {
            let fixture = Fixture::new();
            fixture.write("wiki/excluded.md", &"x".repeat(24_000));
            let job = fixture
                .begin(&["wiki/first.md", "wiki/excluded.md"])
                .unwrap();
            let calls = AtomicUsize::new(0);
            let result = generate_with(&fixture.vault, &fixture.registry, &job, |input| {
                calls.fetch_add(1, Ordering::SeqCst);
                assert!(!input.user.contains(&"x".repeat(100)));
                crate::vault::write_file(&fixture.path("wiki/excluded.md"), EDITED).unwrap();
                std::future::ready(Err("synthetic transport failure".into()))
            })
            .await;
            let error = result.unwrap_err();
            assert!(error.contains("source"), "{error}");
            assert_ne!(error, "synthetic transport failure");
            assert_eq!(calls.load(Ordering::SeqCst), 1);
            assert!(fixture.registry.draft_for_test(&job).unwrap().is_none());
            assert_eq!(
                std::fs::read(fixture.path("wiki/excluded.md")).unwrap(),
                EDITED.as_bytes()
            );
            assert_no_transcript(&fixture);
        });
    });
}

#[test]
fn unchanged_decode_and_repair_transport_errors_are_preserved_without_extra_retry() {
    with_isolated_data("audio-first-transport-error", |_| {
        runtime().block_on(async {
            for failed_attempt in [0, 1] {
                let fixture = Fixture::new();
                let job = fixture.begin(&["wiki/first.md"]).unwrap();
                let calls = AtomicUsize::new(0);
                let result = generate_with(&fixture.vault, &fixture.registry, &job, |input| {
                    assert!(input.system.starts_with(&prompt_head()));
                    calls.fetch_add(1, Ordering::SeqCst);
                    std::future::ready(if input.attempt == failed_attempt {
                        Err("synthetic first transport error".into())
                    } else {
                        Ok("invalid dialogue".into())
                    })
                })
                .await;
                assert_eq!(result.unwrap_err(), "synthetic first transport error");
                assert_eq!(calls.load(Ordering::SeqCst), failed_attempt + 1);
                assert_eq!(fixture.registry.active_count(), 0);
                assert!(fixture.registry.draft_for_test(&job).unwrap().is_none());
                assert_eq!(
                    std::fs::read(fixture.path("wiki/first.md")).unwrap(),
                    PAGE.as_bytes()
                );
                assert_no_transcript(&fixture);
            }
        });
    });
}

#[test]
fn changed_source_after_success_cannot_adopt_a_cached_persisted_receipt() {
    with_isolated_data("audio-persisted-source-recheck", |_| {
        runtime().block_on(async {
            for mutation in [
                SourceMutation::Edit,
                SourceMutation::ReplaceSameBytes,
                SourceMutation::Delete,
            ] {
                let fixture = Fixture::new();
                let job = fixture.begin(&["wiki/first.md"]).unwrap();
                let draft = generated(&fixture, &job).await;
                let receipt = publish(&fixture.vault, &fixture.registry, &draft.context).unwrap();
                assert_eq!(receipt.state, PublicationState::Persisted);
                let transcript = std::fs::read(fixture.target()).unwrap();
                mutate_source(&fixture, mutation);
                let result = publish(&fixture.vault, &fixture.registry, &draft.context);
                let error = result.unwrap_err();
                assert!(error.contains("source"), "{mutation:?}: {error}");
                assert_eq!(std::fs::read(fixture.target()).unwrap(), transcript);
                match mutation {
                    SourceMutation::Edit => assert_eq!(
                        std::fs::read(fixture.path("wiki/first.md")).unwrap(),
                        EDITED.as_bytes()
                    ),
                    SourceMutation::ReplaceSameBytes => assert_eq!(
                        std::fs::read(fixture.path("wiki/first.md")).unwrap(),
                        PAGE.as_bytes()
                    ),
                    SourceMutation::Delete => {
                        assert!(!Path::new(&fixture.path("wiki/first.md")).exists())
                    }
                }
            }
        });
    });
}

#[test]
fn human_edited_or_same_byte_replaced_transcript_refuses_cached_persisted_adoption() {
    with_isolated_data("audio-persisted-target-recheck", |_| {
        runtime().block_on(async {
            for replaced in [false, true] {
                let fixture = Fixture::new();
                let job = fixture.begin(&["wiki/first.md"]).unwrap();
                let draft = generated(&fixture, &job).await;
                let receipt = publish(&fixture.vault, &fixture.registry, &draft.context).unwrap();
                assert_eq!(receipt.state, PublicationState::Persisted);
                let transcript = std::fs::read(fixture.target()).unwrap();
                let preserved = if replaced {
                    std::fs::rename(fixture.target(), fixture.root.join("replaced-audio.md"))
                        .unwrap();
                    std::fs::write(fixture.target(), &transcript).unwrap();
                    transcript.clone()
                } else {
                    crate::vault::write_file(&fixture.target().to_string_lossy(), EDITED).unwrap();
                    EDITED.as_bytes().to_vec()
                };
                let result = publish(&fixture.vault, &fixture.registry, &draft.context);
                let error = result.unwrap_err();
                assert!(
                    error.contains("publication") && error.contains("changed"),
                    "replaced={replaced}: {error}"
                );
                assert_eq!(std::fs::read(fixture.target()).unwrap(), preserved);
                if replaced {
                    assert_eq!(
                        std::fs::read(fixture.root.join("replaced-audio.md")).unwrap(),
                        transcript
                    );
                }
                assert_eq!(
                    std::fs::read(fixture.path("wiki/first.md")).unwrap(),
                    PAGE.as_bytes()
                );
                assert_eq!(
                    serde_json::to_value(fixture.registry.draft_for_test(&job).unwrap().unwrap())
                        .unwrap(),
                    serde_json::to_value(&draft).unwrap()
                );
            }
        });
    });
}
