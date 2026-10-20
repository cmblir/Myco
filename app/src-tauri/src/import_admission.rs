//! Opening-bound source and admitted-revision publication for native imports.

use super::{AgentVaultSession, FailedImport, ImportOutcome, ImportProgress, VaultRoot};
use crate::importers::{
    ledger::Ledger,
    wikify::{Pending, PendingItem},
};
use std::path::{Path, PathBuf};

// MCP already holds its opening transition guard; native imports acquire it
// here. Every publication takes opening -> import_lock, never the reverse.
enum Publisher<'a> {
    Native(&'a VaultRoot, &'a AgentVaultSession),
    BoundRoot(&'a Path),
}

impl Publisher<'_> {
    fn publish<T>(&self, action: impl FnOnce(&Path) -> Result<T, String>) -> Result<T, String> {
        let publish = |root: &Path| {
            let _guard = crate::importers::wikify::import_lock()?;
            action(root)
        };
        match self {
            Self::Native(state, origin) => state.with_origin(origin, publish),
            Self::BoundRoot(root) => {
                let root = root
                    .canonicalize()
                    .map_err(|error| format!("import vault unavailable: {error}"))?;
                publish(&root)
            }
        }
    }
}

pub(super) fn run(
    state: &VaultRoot,
    origin: &AgentVaultSession,
    files: &[PathBuf],
    dest: &str,
    should_queue: impl Fn() -> bool,
    on_progress: impl FnMut(ImportProgress),
) -> ImportOutcome {
    run_with(
        Publisher::Native(state, origin),
        files,
        dest,
        should_queue,
        on_progress,
    )
}

/// The caller must already hold its native MCP opening binding.
pub(super) fn run_explicit(root: &Path, files: &[PathBuf], dest: &str) -> ImportOutcome {
    run_with(Publisher::BoundRoot(root), files, dest, || true, |_| {})
}

struct QueuePublication {
    pending: Pending,
    path: PathBuf,
    expected: Option<String>,
}

impl QueuePublication {
    fn load(root: &Path) -> Result<Self, String> {
        let path = crate::vault::confine_delete_path(root, &Pending::path(root).to_string_lossy())?;
        let raw = super::import_projection::read_existing(&path)?;
        let pending = raw
            .as_deref()
            .map(serde_json::from_str)
            .transpose()
            .map_err(|error| format!("invalid wikify queue: {error}"))?
            .unwrap_or_default();
        Ok(Self {
            pending,
            path,
            expected: raw
                .as_deref()
                .map(crate::importers::wikify::source_revision),
        })
    }

    fn admit(
        &mut self,
        root: &Path,
        ledger: &Ledger,
        conversations: &[crate::importers::Conversation],
    ) -> Result<usize, String> {
        let mut queued = 0;
        for conversation in conversations {
            let key = format!("{}:{}", conversation.source.slug(), conversation.id);
            let body = conversation.to_inbox_doc();
            let fingerprint = crate::importers::ledger::fingerprint(&body);
            if !ledger.seen(&key, &fingerprint) {
                continue;
            }
            let raw_path = format!(
                "raw/conversations/{}/{}-{fingerprint}.md",
                conversation.source.slug(),
                conversation.doc_stem()
            );
            let path =
                crate::vault::confine_delete_path(root, &root.join(&raw_path).to_string_lossy())?;
            let actual = std::fs::read_to_string(path)
                .map_err(|error| format!("read admitted immutable revision: {error}"))?;
            let revision = crate::importers::wikify::source_revision(&body);
            if actual != body || crate::importers::wikify::source_revision(&actual) != revision {
                return Err("admitted source revision changed; retry the session import".into());
            }
            let legacy_known = self.pending.pending.iter().any(|item| {
                item.key == key && item.raw_path == raw_path && item.source_revision == revision
            }) || self.pending.receipts.iter().any(|receipt| {
                receipt.key == key
                    && receipt.raw_path == raw_path
                    && receipt.source_revision == revision
            });
            let stem = Path::new(&raw_path)
                .file_stem()
                .and_then(|stem| stem.to_str())
                .ok_or("invalid admitted source name")?;
            let item = PendingItem {
                key,
                raw_path: raw_path.clone(),
                src_slug: format!("src-{}", stem.replace('.', "-")),
                title: conversation.title.clone(),
                imported: crate::registry::today_utc(),
                source_revision: revision,
                read_ranges: Vec::new(),
            };
            // A citation reminder is independent of compiler work. Repair an
            // interrupted compiler admission without resetting legacy receipts.
            if legacy_known {
                queued += usize::from(self.pending.admit_compile_job(&item));
            } else {
                self.pending.push(item);
                queued += 1;
            }
        }
        Ok(queued)
    }

    fn save(&self) -> Result<(), String> {
        let body = serde_json::to_string_pretty(&self.pending)
            .map_err(|error| format!("serialize wikify queue: {error}"))?;
        crate::vault::write_file_if_unchanged(
            &self.path.to_string_lossy(),
            &body,
            self.expected.as_deref(),
        )
        .map_err(|error| format!("publish admitted source queue: {error}"))
    }
}

fn run_with(
    publisher: Publisher<'_>,
    files: &[PathBuf],
    dest: &str,
    should_queue: impl Fn() -> bool,
    mut on_progress: impl FnMut(ImportProgress),
) -> ImportOutcome {
    let mut outcome = ImportOutcome {
        source: String::new(),
        imported: 0,
        skipped: 0,
        quarantined: Vec::new(),
        failed: Vec::new(),
    };
    if let Err(error) = super::import_dest(dest) {
        outcome.failed.extend(files.iter().map(|path| FailedImport {
            path: path.to_string_lossy().into_owned(),
            error: error.clone(),
        }));
        return outcome;
    }
    let mut legacy_locations = None;
    for (index, file) in files.iter().enumerate() {
        let path = file.to_string_lossy().into_owned();
        let stamp = super::file_stamp(file);
        let result = (|| {
            // Archive-only sweeps retain the existing fast path. An enabled
            // organization pass parses again to repair an interrupted queue
            // without trusting a prior file stamp as a completion receipt.
            let unchanged = publisher.publish(|root| {
                let ledger = Ledger::load(root)?;
                Ok(if should_queue() {
                    None
                } else {
                    stamp.and_then(|(mtime, len)| ledger.file_convs(&path, mtime, len))
                })
            })?;
            if let Some(count) = unchanged {
                outcome.skipped += count;
                return Ok(());
            }
            const MAX_BYTES: usize = 512 * 1024 * 1024;
            if stamp.is_some_and(|(_, len)| len > MAX_BYTES as u64) {
                return Err("too large; split the conversation export first".into());
            }
            // Source IO and parser work happen outside both mutation locks.
            let mut content = String::new();
            use std::io::Read;
            std::fs::File::open(file)
                .map_err(|error| format!("cannot read: {error}"))?
                .take(MAX_BYTES as u64 + 1)
                .read_to_string(&mut content)
                .map_err(|error| format!("cannot read: {error}"))?;
            if content.len() > MAX_BYTES {
                return Err("too large; split the conversation export first".into());
            }
            let conversations = crate::importers::detect_and_parse(&path, &content)?;
            #[cfg(any(test, feature = "native-index-probe"))]
            probe_hooks::after_parse();
            publisher.publish(|root| {
                let mut ledger = Ledger::load(root)?;
                let duplicates_before = ledger.duplicates();
                let mut queue = should_queue()
                    .then(|| QueuePublication::load(root))
                    .transpose()?;
                let plan = crate::importers::plan_conversations(&conversations, &ledger);
                let (imported, skipped, quarantined, source) =
                    super::apply_import_plan(root, &mut ledger, plan, dest, &mut legacy_locations)?;
                outcome.imported += imported;
                outcome.skipped += skipped;
                if outcome.source.is_empty() {
                    outcome.source = source;
                }
                let clean = quarantined.is_empty();
                outcome.quarantined.extend(quarantined);
                let stamp_changed = clean
                    && stamp.is_some_and(|(mtime, len)| {
                        ledger.file_convs(&path, mtime, len) != Some(imported + skipped)
                    });
                if stamp_changed {
                    if let Some((mtime, len)) = stamp {
                        ledger.record_file(path.clone(), mtime, len, imported + skipped);
                    }
                }
                // Save the verified source lineage before queue publication.
                // A queue failure is retryable; immutable sources and the
                // admitted projection remain intact and the next pass repairs it.
                if imported > 0 || stamp_changed || ledger.duplicates() != duplicates_before {
                    ledger.save(root).map_err(|error| {
                        format!("import publication incomplete; source retained for retry: {error}")
                    })?;
                }
                if let Some(queue) = queue.as_mut() {
                    if queue.admit(root, &ledger, &conversations)? > 0 {
                        queue.save()?;
                    }
                }
                crate::inflow_log::record_n(root, "import", dest, imported as u32);
                Ok(())
            })
        })();
        if let Err(error) = result {
            outcome.failed.push(FailedImport { path, error });
        }
        if index % 32 == 0 || index + 1 == files.len() {
            on_progress(ImportProgress {
                done: index + 1,
                total: files.len(),
                file: file
                    .file_name()
                    .map(|name| name.to_string_lossy().into_owned())
                    .unwrap_or_default(),
                imported: outcome.imported,
                skipped: outcome.skipped,
                failed: outcome.failed.len(),
                origin: None,
                request_id: None,
            });
        }
    }
    outcome
}

#[cfg(any(test, feature = "native-index-probe"))]
pub(crate) mod probe_hooks {
    #[cfg(test)]
    thread_local! { static HOOK: std::cell::RefCell<Option<Box<dyn FnOnce()>>> = const { std::cell::RefCell::new(None) }; }
    #[cfg(all(not(test), feature = "native-index-probe"))]
    static HOOK: std::sync::Mutex<Option<Box<dyn FnOnce() + Send>>> = std::sync::Mutex::new(None);

    #[cfg(test)]
    pub(crate) fn install_after_parse(hook: impl FnOnce() + 'static) {
        HOOK.with(|slot| *slot.borrow_mut() = Some(Box::new(hook)));
    }
    #[cfg(all(not(test), feature = "native-index-probe"))]
    pub(crate) fn install_after_parse(hook: impl FnOnce() + Send + 'static) {
        *HOOK.lock().unwrap() = Some(Box::new(hook));
    }

    pub(super) fn after_parse() {
        #[cfg(test)]
        let hook = HOOK.with(|slot| slot.borrow_mut().take());
        #[cfg(all(not(test), feature = "native-index-probe"))]
        let hook = HOOK.lock().unwrap().take();
        if let Some(hook) = hook {
            hook();
        }
    }
}

#[cfg(test)]
#[path = "commands_import_admission_tests.rs"]
mod tests;
