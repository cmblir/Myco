//! Native automatic-index policy, freshness and publication regressions.
use super::*;

fn write_auto_policy(dir: &Path, enabled: bool) {
    let settings = crate::settings::Settings {
        auto_reindex_enabled: enabled,
        ..Default::default()
    };
    std::fs::write(
        dir.join("settings.json"),
        serde_json::to_vec(&settings).unwrap(),
    )
    .unwrap();
}

#[test]
fn actor_dispatch_keeps_dense_pending_while_off_and_resumes_after_opt_in() {
    crate::settings::test_support::with_isolated_data("actor-auto-policy", |dir| {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .build()
            .unwrap();
        runtime.block_on(async {
            write_auto_policy(dir, false);
            let mut pending = PendingWork::default();
            pending.dirty.extend(["*".into(), "wiki/edited.md".into()]);
            let mut lexical_builds = 0;
            let mut dense_builds = 0;
            dispatch_pending(&mut pending, |batch, mode| {
                assert_eq!(mode, IndexMode::AutomaticLexical);
                assert!(batch.contains(&"*".into()));
                lexical_builds += 1;
                if mode.dense() {
                    dense_builds += 1;
                }
                std::future::ready(Ok(()))
            })
            .await
            .unwrap();
            assert_eq!((lexical_builds, dense_builds), (1, 0));
            assert!(pending.dirty.is_empty());
            assert_eq!(
                pending.dense.len(),
                2,
                "lexical publication cannot acknowledge dense"
            );
            dispatch_pending(&mut pending, |_, _| {
                panic!("off policy polls must not rerun the completed lexical build");
                #[allow(unreachable_code)]
                std::future::ready(Ok(()))
            })
            .await
            .unwrap();
            pending.dirty.insert("wiki/new.md".into());
            dispatch_pending(&mut pending, |batch, mode| {
                assert_eq!(mode, IndexMode::AutomaticLexical);
                assert_eq!(batch, vec!["wiki/new.md"]);
                std::future::ready(Ok(()))
            })
            .await
            .unwrap();
            write_auto_policy(dir, true);
            dispatch_pending(&mut pending, |batch, mode| {
                assert_eq!(mode, IndexMode::AutomaticDense);
                assert_eq!(batch.len(), 3);
                assert!(batch.contains(&"*".into()));
                assert!(batch.contains(&"wiki/edited.md".into()));
                assert!(batch.contains(&"wiki/new.md".into()));
                dense_builds += 1;
                std::future::ready(Ok(()))
            })
            .await
            .unwrap();
            assert_eq!(dense_builds, 1);
            assert!(pending.dirty.is_empty() && pending.dense.is_empty());
        });
    });
}

#[test]
fn actor_rebind_publishes_lexical_before_opted_in_dense_failure_and_retry() {
    crate::settings::test_support::with_isolated_data("actor-rebind-lexical-first", |dir| {
        write_auto_policy(dir, true);
        let scratch = tempfile::tempdir().unwrap();
        let root = scratch.path().canonicalize().unwrap();
        std::fs::create_dir(root.join("wiki")).unwrap();
        std::fs::write(root.join("wiki/current.md"), "searchable project decision").unwrap();
        std::fs::write(root.join("wiki/deferred.md"), "previously deferred context").unwrap();
        let (vault, origin) = open_test_vault(&root);
        let runtime = tokio::runtime::Builder::new_current_thread()
            .build()
            .unwrap();
        runtime.block_on(async {
            let mut pending = PendingWork::default();
            pending.dirty.extend(["*".into(), "wiki/current.md".into()]);
            pending.dense.insert("wiki/deferred.md".into());
            let dirty = pending.dirty.clone();
            let all = pending
                .dirty
                .union(&pending.dense)
                .cloned()
                .collect::<HashSet<_>>();
            dispatch_pending(&mut pending, |batch, mode| {
                assert_eq!(mode, IndexMode::AutomaticLexical);
                assert_eq!(batch.iter().cloned().collect::<HashSet<_>>(), dirty);
                assert!(reconcile_requested(&batch, false, false));
                // Publish through the same lexical/publication seams as the builder,
                // without resolving an embedding model or polling a dense future.
                let mut pair = crate::index_publication::load(&root).unwrap();
                let pages = captured_test_pages(&root);
                let existing = dense_sections(&pair.store);
                for (rel, stem, text) in &pages {
                    sync_lexical_page(
                        &mut pair.store,
                        &mut pair.lexical,
                        rel,
                        stem,
                        text.as_deref(),
                        &existing,
                    )
                    .unwrap();
                }
                pair.generation += 1;
                let staged = crate::index_publication::PreparedPair::prepare(&root, &pair).unwrap();
                commit_snapshot(&vault, &origin, &root, &pages, true, &batch, mode, staged)
                    .unwrap();
                std::future::ready(Ok(()))
            })
            .await
            .unwrap();
            assert!(pending.dirty.is_empty());
            assert_eq!(pending.dense, all);
            let published = crate::index_publication::load(&root).unwrap();
            assert!(published.store.records.is_empty() && published.store.model.is_empty());
            assert!(published
                .lexical
                .search("project decision", 10)
                .iter()
                .any(|hit| hit.page == "wiki/current.md"));
            assert!(published.lexical.pages().contains("wiki/deferred.md"));
            let path = crate::index_publication::path_for(&root.to_string_lossy()).unwrap();
            let lexical_bytes = std::fs::read(&path).unwrap();
            let result = dispatch_pending(&mut pending, |batch, mode| {
                assert_eq!(mode, IndexMode::AutomaticDense);
                assert_eq!(batch.into_iter().collect::<HashSet<_>>(), all);
                std::future::ready(Err("synthetic dense unavailable".into()))
            })
            .await;
            assert_eq!(result, Err("synthetic dense unavailable".into()));
            assert!(pending.dirty.is_empty());
            assert_eq!(pending.dense, all);
            assert_eq!(std::fs::read(&path).unwrap(), lexical_bytes);
            assert!(!crate::index_publication::load(&root)
                .unwrap()
                .lexical
                .search("project decision", 10)
                .is_empty());
            dispatch_pending(&mut pending, |batch, mode| {
                assert_eq!(mode, IndexMode::AutomaticDense);
                assert_eq!(batch.into_iter().collect::<HashSet<_>>(), all);
                std::future::ready(Ok(()))
            })
            .await
            .unwrap();
            assert!(pending.dirty.is_empty() && pending.dense.is_empty());
        });
    });
}

#[test]
fn actor_rebind_lexical_failure_retries_without_losing_either_queue() {
    crate::settings::test_support::with_isolated_data("actor-rebind-lexical-retry", |dir| {
        write_auto_policy(dir, true);
        let runtime = tokio::runtime::Builder::new_current_thread()
            .build()
            .unwrap();
        runtime.block_on(async {
            let mut pending = PendingWork::default();
            pending.dirty.extend(["*".into(), "wiki/edited.md".into()]);
            pending.dense.insert("wiki/deferred.md".into());
            let dirty = pending.dirty.clone();
            let dense = pending.dense.clone();
            let result = dispatch_pending(&mut pending, |batch, mode| {
                assert_eq!(mode, IndexMode::AutomaticLexical);
                assert_eq!(batch.into_iter().collect::<HashSet<_>>(), dirty);
                std::future::ready(Err("synthetic source changed before publication".into()))
            })
            .await;
            assert!(result.is_err());
            assert_eq!(pending.dirty, dirty);
            assert_eq!(pending.dense, dense);
            dispatch_pending(&mut pending, |batch, mode| {
                assert_eq!(mode, IndexMode::AutomaticLexical);
                assert_eq!(batch.into_iter().collect::<HashSet<_>>(), dirty);
                std::future::ready(Ok(()))
            })
            .await
            .unwrap();
            assert!(pending.dirty.is_empty());
            assert_eq!(
                pending.dense,
                dirty.union(&dense).cloned().collect::<HashSet<_>>()
            );
        });
    });
}

#[test]
fn actor_incremental_and_dense_only_rebind_work_do_not_repeat_lexical_bootstrap() {
    crate::settings::test_support::with_isolated_data("actor-no-repeated-bootstrap", |dir| {
        write_auto_policy(dir, true);
        let runtime = tokio::runtime::Builder::new_current_thread()
            .build()
            .unwrap();
        runtime.block_on(async {
            for (dirty_page, dense_rebind) in [(true, false), (true, true), (false, true)] {
                let mut pending = PendingWork::default();
                if dirty_page {
                    pending.dirty.insert("wiki/edited.md".into());
                }
                if dense_rebind {
                    pending.dense.insert("*".into());
                }
                let expected = pending
                    .dirty
                    .union(&pending.dense)
                    .cloned()
                    .collect::<HashSet<_>>();
                dispatch_pending(&mut pending, |batch, mode| {
                    assert_eq!(mode, IndexMode::AutomaticDense);
                    assert_eq!(batch.into_iter().collect::<HashSet<_>>(), expected);
                    std::future::ready(Ok(()))
                })
                .await
                .unwrap();
                assert!(pending.dirty.is_empty() && pending.dense.is_empty());
            }
        });
    });
}

#[test]
fn actor_rebind_does_not_bypass_checked_settings_for_lexical_bootstrap() {
    crate::settings::test_support::with_isolated_data("actor-rebind-corrupt-policy", |dir| {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .build()
            .unwrap();
        runtime.block_on(async {
            let mut pending = PendingWork::default();
            pending.dirty.insert("*".into());
            pending.dense.insert("wiki/deferred.md".into());
            std::fs::write(dir.join("settings.json"), b"{broken").unwrap();
            let mut dispatched = false;
            let result = dispatch_pending(&mut pending, |_, _| {
                dispatched = true;
                std::future::ready(Ok(()))
            })
            .await;
            assert!(result.unwrap_err().contains("parse settings"));
            assert!(!dispatched);
            assert_eq!(pending.dirty.len(), 1);
            assert!(pending.dirty.contains("*"));
            assert_eq!(pending.dense.len(), 1);
            assert!(pending.dense.contains("wiki/deferred.md"));
        });
    });
}

#[test]
fn actor_dispatch_preserves_both_queues_on_corrupt_settings_and_failed_build() {
    crate::settings::test_support::with_isolated_data("actor-policy-errors", |dir| {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .build()
            .unwrap();
        runtime.block_on(async {
            let mut pending = PendingWork::default();
            pending.dirty.insert("wiki/changed.md".into());
            pending.dense.insert("*".into());
            std::fs::write(dir.join("settings.json"), b"{broken").unwrap();
            let mut dispatched = false;
            let result = dispatch_pending(&mut pending, |_, _| {
                dispatched = true;
                std::future::ready(Ok(()))
            })
            .await;
            assert!(result.unwrap_err().contains("parse settings"));
            assert!(
                !dispatched,
                "corrupt settings must never admit a model builder"
            );
            assert_eq!(pending.dirty.len(), 1);
            assert_eq!(pending.dense.len(), 1);
            assert!(
                IndexMode::Manual.check_policy().is_ok(),
                "manual indexing does not borrow the automatic permission"
            );
            write_auto_policy(dir, true);
            let result = dispatch_pending(&mut pending, |_, mode| {
                assert_eq!(mode, IndexMode::AutomaticDense);
                std::future::ready(Err("vault switched or source read failed".into()))
            })
            .await;
            assert!(result.is_err());
            assert_eq!(pending.dirty.len(), 1);
            assert_eq!(pending.dense.len(), 1);
            pending.clear();
            assert!(
                pending.dirty.is_empty() && pending.dense.is_empty(),
                "unbind/rebind cannot carry work to another opening"
            );
        });
    });
}

#[test]
fn lexical_only_sync_updates_text_and_invalidates_changed_dense_without_claiming_new_model() {
    let old = "# Stable\nunchanged passage\n# Changed\nobsolete answer";
    let fresh = "# Inserted\nnew prefix\n# Stable\nunchanged passage\n# Changed\ncurrent answer";
    let old_chunks = crate::embeddings::chunk_page(old);
    assert_eq!(old_chunks.len(), 2);
    let mut store = VectorStore::default();
    store.ensure_signature("retired-model", "retired-representation");
    store
        .upsert_page(
            "wiki/note.md",
            "note",
            old_chunks
                .iter()
                .map(|text| (crate::embeddings::content_hash(text), vec![1.0, 0.0]))
                .collect(),
        )
        .unwrap();
    store
        .upsert_page("wiki/other.md", "other", vec![(99, vec![0.0, 1.0])])
        .unwrap();
    let mut lexical = Bm25Index::new();
    lexical.upsert_page("wiki/note.md", "note", &old_chunks);
    let sections = dense_sections(&store);
    assert!(sync_lexical_page(
        &mut store,
        &mut lexical,
        "wiki/note.md",
        "note",
        Some(fresh),
        &sections
    )
    .unwrap());
    assert_eq!(store.model, "retired-model");
    assert_eq!(store.signature, "retired-representation");
    let records: Vec<_> = store
        .records
        .iter()
        .filter(|record| record.page == "wiki/note.md")
        .collect();
    assert_eq!(
        records.len(),
        1,
        "obsolete answer must lose its vector immediately"
    );
    assert_eq!(
        records[0].section, 1,
        "unchanged text follows its shifted section"
    );
    assert!(lexical
        .search("current answer", 10)
        .iter()
        .any(|hit| hit.page == "wiki/note.md"));
    assert_eq!(
        lexical.page_hashes("wiki/note.md").unwrap(),
        crate::embeddings::chunk_page(fresh)
            .iter()
            .map(|text| crate::embeddings::content_hash(text))
            .collect::<Vec<_>>()
    );

    // Same surviving hash, different section: hashes-only comparison would
    // silently leave the citation pointing at the wrong source chunk.
    let shifted = "# Stable\nunchanged passage\n# Changed\ncurrent answer";
    let sections = dense_sections(&store);
    assert!(sync_lexical_page(
        &mut store,
        &mut lexical,
        "wiki/note.md",
        "note",
        Some(shifted),
        &sections
    )
    .unwrap());
    assert_eq!(
        store
            .records
            .iter()
            .find(|record| record.page == "wiki/note.md")
            .unwrap()
            .section,
        0
    );
    let sections = dense_sections(&store);
    assert!(!sync_lexical_page(
        &mut store,
        &mut lexical,
        "wiki/note.md",
        "note",
        Some(shifted),
        &sections
    )
    .unwrap());
    assert!(sync_lexical_page(
        &mut store,
        &mut lexical,
        "wiki/note.md",
        "note",
        None,
        &sections
    )
    .unwrap());
    assert!(!lexical.pages().contains("wiki/note.md"));
    assert_eq!(store.records.len(), 1);
    assert_eq!(store.records[0].page, "wiki/other.md");
}

fn open_test_vault(root: &Path) -> (crate::commands::VaultRoot, AgentVaultSession) {
    let vault = crate::commands::VaultRoot::default();
    let opening = vault.begin_open().unwrap();
    vault
        .finish_open(opening, root.canonicalize().unwrap(), || ())
        .unwrap();
    let origin = vault.snapshot().unwrap();
    (vault, origin)
}

fn captured_test_pages(root: &Path) -> Vec<(String, String, Option<String>)> {
    crate::commands::collect_wiki_pages_checked(root)
        .unwrap()
        .into_iter()
        .map(|(rel, stem, text)| (rel, stem, Some(text)))
        .collect()
}

#[test]
fn lexical_bootstrap_publishes_atomically_and_prunes_missing_pages_without_dense_model() {
    crate::settings::test_support::with_isolated_data("lexical-auto-bootstrap", |dir| {
        write_auto_policy(dir, false);
        let scratch = tempfile::tempdir().unwrap();
        let root = scratch.path().canonicalize().unwrap();
        std::fs::create_dir(root.join("wiki")).unwrap();
        std::fs::write(
            root.join("wiki/current.md"),
            "fresh searchable project decision",
        )
        .unwrap();
        let (vault, origin) = open_test_vault(&root);
        let mut pair = crate::index_publication::IndexPair {
            generation: 1,
            store: VectorStore::default(),
            lexical: Bm25Index::new(),
        };
        pair.lexical
            .upsert_page("wiki/deleted.md", "deleted", &["removed note".into()]);
        let pages = captured_test_pages(&root);
        let existing = dense_sections(&pair.store);
        for (rel, stem, text) in &pages {
            sync_lexical_page(
                &mut pair.store,
                &mut pair.lexical,
                rel,
                stem,
                text.as_deref(),
                &existing,
            )
            .unwrap();
        }
        let present = pages.iter().map(|(rel, _, _)| rel.clone()).collect();
        pair.store.prune(&present);
        pair.lexical.prune(&present);
        let staged = crate::index_publication::PreparedPair::prepare(&root, &pair).unwrap();
        commit_snapshot(
            &vault,
            &origin,
            &root,
            &pages,
            true,
            &["*".into()],
            IndexMode::AutomaticLexical,
            staged,
        )
        .unwrap();
        let published = crate::index_publication::load(&root).unwrap();
        assert!(published.store.records.is_empty());
        assert!(
            published.store.model.is_empty(),
            "keyword bootstrap cannot claim an embedding model"
        );
        assert!(published
            .lexical
            .search("project decision", 10)
            .iter()
            .any(|hit| hit.page == "wiki/current.md"));
        assert!(!published.lexical.pages().contains("wiki/deleted.md"));
    });
}

#[test]
fn lexical_publication_rejects_changed_unreadable_or_switched_sources_and_retains_old_pair() {
    crate::settings::test_support::with_isolated_data("lexical-auto-commit-guards", |dir| {
        write_auto_policy(dir, false);
        for failure in ["changed", "unreadable", "vault", "settings", "dense-optout"] {
            let scratch = tempfile::tempdir().unwrap();
            let root = scratch.path().canonicalize().unwrap();
            std::fs::create_dir(root.join("wiki")).unwrap();
            std::fs::write(root.join("wiki/note.md"), "captured original").unwrap();
            let (vault, origin) = open_test_vault(&root);
            let mut pair = crate::index_publication::IndexPair {
                generation: 1,
                store: VectorStore::default(),
                lexical: Bm25Index::new(),
            };
            pair.lexical
                .upsert_page("wiki/note.md", "note", &["published baseline".into()]);
            let path = crate::index_publication::PreparedPair::prepare(&root, &pair)
                .unwrap()
                .commit()
                .unwrap();
            let before = std::fs::read(&path).unwrap();
            let pages = captured_test_pages(&root);
            pair.generation += 1;
            let existing = dense_sections(&pair.store);
            for (rel, stem, text) in &pages {
                sync_lexical_page(
                    &mut pair.store,
                    &mut pair.lexical,
                    rel,
                    stem,
                    text.as_deref(),
                    &existing,
                )
                .unwrap();
            }
            let staged = crate::index_publication::PreparedPair::prepare(&root, &pair).unwrap();
            match failure {
                "changed" => {
                    std::fs::write(root.join("wiki/note.md"), "changed after capture").unwrap()
                }
                "unreadable" => std::fs::write(root.join("wiki/note.md"), [0xff]).unwrap(),
                "vault" => {
                    vault.close().unwrap();
                }
                "settings" => std::fs::write(dir.join("settings.json"), b"{broken").unwrap(),
                "dense-optout" => write_auto_policy(dir, false),
                _ => unreachable!(),
            }
            let mode = if failure == "dense-optout" {
                IndexMode::AutomaticDense
            } else {
                IndexMode::AutomaticLexical
            };
            assert!(
                commit_snapshot(
                    &vault,
                    &origin,
                    &root,
                    &pages,
                    true,
                    &["*".into()],
                    mode,
                    staged
                )
                .is_err(),
                "{failure}"
            );
            assert_eq!(
                std::fs::read(&path).unwrap(),
                before,
                "{failure} must preserve the published pair"
            );
            write_auto_policy(dir, false);
        }
    });
}
