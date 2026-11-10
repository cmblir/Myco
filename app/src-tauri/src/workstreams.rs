//! Workstreams: deterministic project grouping of imported Claude Code and
//! Codex conversations (LLM wiki upgrade 2026-11-08, slice 1).
//!
//! A conversation's workstream is a pure key over its working folder
//! (`thread_key`, ported from the P0 measurement). A Codex sub-thread joins the
//! session of the thread it was spawned from (`root_of`), even when that
//! thread was never imported, and a Claude Code agent-team teammate joins its
//! lead's. `refresh` publishes the result twice:
//! `.myco/workstreams.json`, the facts Ask answers from without a model, and
//! one machine-owned page per workstream under `wiki/workstreams/`. A
//! workstream is titled by the person's `.myco/workstream-names.json` (only
//! read), else its project's README or package name, else a word its own
//! conversations use distinctively, else its key. It also carries the first
//! paragraph under that README title and the lines its latest sessions'
//! reports leave open (facts version 4), so Ask can explain a project and say
//! what is left without a model.
//!
//! Reads the import ledger, the vault's raw transcripts and sidecars, and for a
//! Codex working folder the vendor stores, read-only: `state_5.sqlite` opened
//! immutable, then the rollout's first line, then the parent chain. Writes only
//! the facts file and pages whose marker block is intact, each by
//! compare-and-swap; raw/ is never written. Only conversations that are new or
//! whose ledger fingerprint changed are read again; a Codex thread still
//! without a working folder is looked up in the vendor stores again. The facts
//! hold derived keys, never cwd strings, which carry the home path.

use crate::importers::{ledger::Ledger, secrets_scan};
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

/// Vault-relative folder of the machine-owned pages. Cold for every index,
/// evidence and MCP read path.
pub(crate) const PAGE_DIR: &str = "wiki/workstreams/";
const FACTS_FILE: &str = "workstreams.json";
/// The person's own names, `{"<key>": "<name>"}`; the app never writes it.
const NAMES_FILE: &str = "workstream-names.json";
/// The longest name that file may give.
const MAX_NAME_CHARS: usize = 80;
/// Facts of another version are treated as absent: everything is read again.
const VERSION: u32 = 4;
/// Open items a workstream keeps, from the reports of this many of its latest
/// sessions (the sessions a progress answer lists).
const OPEN_ITEMS: usize = 10;
const OPEN_SESSIONS: usize = 5;
/// A README summary keeps at most this many characters.
const SUMMARY_CHARS: usize = 400;
const MARKER_OPEN: &str = "<!-- myco:workstream:v1 ";
const MARKER_CLOSE: &str = "<!-- /myco:workstream -->";
/// Request and report hints keep one line of at most this many characters.
const HINT_CHARS: usize = 200;
/// A first line (a rollout's session_meta, a sidecar's first record) longer
/// than this is not read.
const MAX_FIRST_LINE: u64 = 16 * 1024 * 1024;
/// The facts reader (queryWorkstreams.ts) takes ids of at most 256 UTF-16
/// units; UTF-8 never has fewer bytes than that.
const MAX_ID_BYTES: usize = 256;
/// The largest integer a JSON reader in the app holds exactly (2^53 - 1).
const MAX_EPOCH: i64 = (1 << 53) - 1;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum CwdSource {
    Sidecar,
    State,
    Rollout,
    Inherited,
    #[default]
    #[serde(rename = "none")]
    Missing,
}

impl CwdSource {
    /// Read for this conversation itself rather than borrowed from a parent.
    fn is_own(self) -> bool {
        matches!(self, Self::Sidecar | Self::State | Self::Rollout)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum TitleSource {
    User,
    Readme,
    Package,
    Derived,
    Key,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub(crate) struct Report {
    epoch: i64,
    /// The same message's lines that say what is left (`open_lines`), kept so
    /// a later pass lists a workstream's open items without reading the
    /// transcript again. Ask reads the workstream's list, not these.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    open: Vec<String>,
    text: String,
}

/// A line a recent session's report leaves open.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub(crate) struct OpenItem {
    /// Ledger key of the conversation the report was read from.
    conversation: String,
    epoch: i64,
    text: String,
}

// Fields are declared in alphabetical order so the facts file has sorted keys.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub(crate) struct ConversationFacts {
    /// Started by a program, not the person: its first request is a machine
    /// prompt (`is_automated`), such as a dashboard helper's or a
    /// translator's. Left out of every count, page row and answer; the page
    /// counts these sessions.
    automated: bool,
    cwd_source: CwdSource,
    first_epoch: i64,
    fp: String,
    id: String,
    key: Option<String>,
    last_epoch: i64,
    /// The newest answer of the session's root thread that this sub-agent
    /// copied in when it forked from it (Codex), so what came back to the
    /// person survives when that thread was never imported. Kept only while
    /// the thread it forked from is the root: deeper down, the copy is
    /// another sub-agent's answer.
    parent_report: Option<Report>,
    raw: String,
    report: Option<Report>,
    request: Option<String>,
    /// Ledger key of the session's root: the topmost thread reached through
    /// parent links. It may be a thread that is not in the vault (a sub-agent
    /// whose parent was never imported); its own parent is unknown, so the
    /// chain ends there and siblings under it share it. A Claude Code team
    /// whose lead is not in the vault is rooted at `claude-code:<team name>`.
    root: String,
    /// A Codex sub-agent thread, or a Claude Code agent-team teammate.
    subagent: bool,
    vendor: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub(crate) struct WorkstreamFacts {
    conversations: usize,
    first_epoch: i64,
    last_epoch: i64,
    /// What the reports of the latest `OPEN_SESSIONS` sessions leave open
    /// (`open_items`), newest first.
    open_items: Vec<OpenItem>,
    page: String,
    roots: usize,
    /// The first paragraph under the README title the display name is read
    /// from (`readme_summary`), else `None`.
    summary: Option<String>,
    title: String,
    title_source: TitleSource,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub(crate) struct Facts {
    conversations: BTreeMap<String, ConversationFacts>,
    last_record_epoch: i64,
    unassigned: usize,
    version: u32,
    workstreams: BTreeMap<String, WorkstreamFacts>,
}

/// What one pass computed and the compare-and-swap writes that publish it.
#[derive(Default)]
pub(crate) struct Plan {
    facts: Facts,
    facts_write: Option<(String, Option<String>)>,
    pages: Vec<(String, String, Option<String>)>,
    /// Conversations read again because they are new or their revision changed.
    pub(crate) recomputed: usize,
    /// Tracked conversations without a raw transcript to read (imported
    /// before raw/conversations existed, or named another way).
    pub(crate) unread: usize,
    /// Codex state stores (or lookups in them) that could not be read.
    pub(crate) store_failures: usize,
    /// Entries of the person's names file that were not used (not a name of
    /// at most 80 characters that passes the secret scan), or 1 when the file
    /// itself is not a readable JSON object.
    pub(crate) names_ignored: usize,
}

/// Plan without any lock, publish through `publish` (which takes the
/// caller's opening and import guards), and plan again when a concurrent
/// writer won a compare-and-swap. Returns the files written and the plan.
pub(crate) fn refresh(
    root: &Path,
    codex_homes: &[PathBuf],
    publish: impl Fn(&Plan) -> Result<usize, String>,
) -> Result<(usize, Plan), String> {
    let mut lost = String::new();
    for _ in 0..3 {
        let plan = plan(root, codex_homes)?;
        if plan.facts_write.is_none() && plan.pages.is_empty() {
            return Ok((0, plan));
        }
        match publish(&plan) {
            Ok(written) => return Ok((written, plan)),
            Err(error) if error.contains("write conflict") => lost = error,
            Err(error) => return Err(error),
        }
    }
    Err(lost)
}

/// Compute without writing. Safe outside the import lock: `apply` publishes
/// by compare-and-swap, so a pass that raced another one fails instead of
/// overwriting it. Reads every tracked conversation that is new to the facts
/// or whose revision changed, so a pass that failed earlier is caught up.
pub(crate) fn plan(root: &Path, codex_homes: &[PathBuf]) -> Result<Plan, String> {
    let ledger = Ledger::load(root)?;
    let tracked: BTreeMap<&str, &str> = ledger
        .entries()
        .iter()
        .filter(|(key, fp)| {
            is_tracked(key)
                && is_fingerprint(fp)
                && key
                    .split_once(':')
                    .is_some_and(|(_, id)| id.len() <= MAX_ID_BYTES)
        })
        .map(|(key, fp)| (key.as_str(), fp.as_str()))
        .collect();
    let previous_text = read_existing(&facts_path(root))?;
    let previous = previous_text
        .as_deref()
        .and_then(|text| serde_json::from_str::<Facts>(text).ok())
        .filter(|facts| facts.version == VERSION)
        .unwrap_or_default();
    let mut plan = Plan::default();
    if tracked.is_empty() && previous_text.is_none() {
        return Ok(plan);
    }
    let mut conversations = previous.conversations;
    // An entry is kept only at the raw path its key and revision name, so an
    // edited facts file cannot point a later read anywhere else.
    conversations.retain(|key, c| {
        tracked.contains_key(key.as_str()) && raw_path(key, &c.fp).as_deref() == Some(&c.raw)
    });
    let mut stores = CodexStores::new(codex_homes);
    // Read this pass: parent thread id, and own working folders for names.
    let mut fresh: BTreeMap<String, Option<String>> = BTreeMap::new();
    let mut cwds: Vec<(String, i64, String)> = Vec::new();
    for (&key, &fp) in &tracked {
        if conversations.get(key).is_some_and(|known| known.fp == fp) {
            continue;
        }
        let Some((mut conversation, read)) = read_conversation(root, key, fp) else {
            plan.unread += 1;
            continue;
        };
        let mut cwd = read.cwd;
        if conversation.vendor == "codex" {
            if let Some((found, source)) = stores.cwd(&conversation.id) {
                conversation.key = project_key(&found);
                conversation.cwd_source = source;
                cwd = Some(found);
            }
        }
        // Rollouts get deleted; keep what an earlier pass read from them.
        if !conversation.cwd_source.is_own() {
            if let Some(known) = conversations.get(key).filter(|c| c.cwd_source.is_own()) {
                conversation.key = known.key.clone();
                conversation.cwd_source = known.cwd_source;
            }
        }
        if let Some(cwd) = cwd.filter(|_| conversation.cwd_source.is_own()) {
            cwds.push((key.to_string(), conversation.last_epoch, cwd));
        }
        conversations.insert(key.to_string(), conversation);
        fresh.insert(key.to_string(), read.parent);
    }
    // A thread with no folder of its own may have one now: its state row was
    // checkpointed since, or an Orca home holds its rollout.
    for (key, conversation) in conversations.iter_mut() {
        if conversation.vendor != "codex"
            || conversation.cwd_source.is_own()
            || fresh.contains_key(key)
        {
            continue;
        }
        if let Some((found, source)) = stores.cwd(&conversation.id) {
            conversation.key = project_key(&found);
            conversation.cwd_source = source;
            cwds.push((key.clone(), conversation.last_epoch, found));
        }
    }
    plan.recomputed = fresh.len();
    plan.store_failures = stores.failures;

    // Parents are not part of the facts contract; read them back each pass.
    let mut parents = BTreeMap::new();
    for (key, conversation) in &conversations {
        let parent = match fresh.get(key) {
            Some(parent) => parent.clone(),
            None if conversation.subagent => read_parent_key(root, conversation),
            None => None,
        };
        if let Some(parent) = parent {
            let parent = team_lead(&parent, &conversations).unwrap_or(parent);
            parents.insert(key.clone(), parent);
        }
    }
    let derived: Vec<_> = {
        let parent_of = |key: &str| {
            parents
                .get(key)
                .filter(|parent| conversations.contains_key(parent.as_str()))
                .cloned()
        };
        let own: BTreeMap<&str, Option<String>> = conversations
            .iter()
            .filter(|(_, c)| c.cwd_source.is_own())
            .map(|(key, c)| (key.as_str(), c.key.clone()))
            .collect();
        // A parent missing from the vault still roots its sub-threads: the
        // person's own thread is often the one never imported.
        let declared = |key: &str| parents.get(key).cloned();
        conversations
            .iter()
            .map(|(key, c)| {
                let inherited = (!c.cwd_source.is_own())
                    .then(|| inherited_key(key, parent_of, |at| own.get(at).cloned()));
                let root_key = root_of(key, declared);
                let forked_from_root = parents.get(key) == Some(&root_key);
                (key.clone(), root_key, forked_from_root, inherited)
            })
            .collect()
    };
    for (key, root_key, forked_from_root, inherited) in derived {
        let Some(conversation) = conversations.get_mut(&key) else {
            continue;
        };
        conversation.root = root_key;
        if !forked_from_root {
            conversation.parent_report = None;
        }
        match inherited {
            None => {}
            Some(Some(ancestor_key)) => {
                conversation.key = ancestor_key;
                conversation.cwd_source = CwdSource::Inherited;
            }
            Some(None) => {
                conversation.key = None;
                conversation.cwd_source = CwdSource::Missing;
            }
        }
    }

    let mut members: BTreeMap<&str, Vec<&ConversationFacts>> = BTreeMap::new();
    for conversation in conversations.values() {
        if let Some(key) = conversation.key.as_deref() {
            members.entry(key).or_default().push(conversation);
        }
    }
    let (user, names_ignored) = user_names(root);
    plan.names_ignored = names_ignored;
    let distinctive = derived_names(&conversations);
    let mut workstreams = BTreeMap::new();
    for (key, group) in &members {
        let mut named: Vec<(i64, String)> = cwds
            .iter()
            .filter(|(at, ..)| conversations[at].key.as_deref() == Some(*key))
            .map(|(_, epoch, cwd)| (*epoch, cwd.clone()))
            .collect();
        named.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.cmp(&b.1)));
        // Read for the summary even when the person named the workstream.
        let found = display_name(&named, root);
        let known = previous.workstreams.get(*key);
        // A name read before stays when the folder is gone (or no
        // conversation of it was read this pass); it is cleaned again
        // because the facts file may have been edited since.
        let (title, title_source) = user
            .get(*key)
            .map(|name| (name.clone(), TitleSource::User))
            .or_else(|| {
                found
                    .as_ref()
                    .map(|(title, source, _)| (title.clone(), *source))
            })
            .or_else(|| {
                let known = known.filter(|known| {
                    matches!(
                        known.title_source,
                        TitleSource::Readme | TitleSource::Package
                    )
                })?;
                Some((clean_title(&known.title)?, known.title_source))
            })
            .or_else(|| Some((distinctive.get(*key)?.clone(), TitleSource::Derived)))
            .unwrap_or_else(|| (key.to_string(), TitleSource::Key));
        // So does a summary, as the name does.
        let summary = match found {
            Some((.., summary)) => summary,
            None => known
                .and_then(|known| known.summary.as_deref())
                .and_then(summary_text),
        };
        // Counts and the span are the person's work; a workstream of
        // automated sessions only still spans their time.
        let person: Vec<&ConversationFacts> =
            group.iter().copied().filter(|c| !c.automated).collect();
        let timed = if person.is_empty() { group } else { &person };
        workstreams.insert(
            key.to_string(),
            WorkstreamFacts {
                conversations: person.len(),
                first_epoch: timed.iter().map(|c| c.first_epoch).min().unwrap_or(0),
                last_epoch: timed.iter().map(|c| c.last_epoch).max().unwrap_or(0),
                open_items: open_items(&sessions(key, &conversations)),
                page: format!("{PAGE_DIR}{}.md", page_name(key)),
                roots: person
                    .iter()
                    .map(|c| c.root.as_str())
                    .collect::<BTreeSet<_>>()
                    .len(),
                summary,
                title,
                title_source,
            },
        );
    }
    let person = || conversations.values().filter(|c| !c.automated);
    plan.facts = Facts {
        last_record_epoch: person().map(|c| c.last_epoch).max().unwrap_or(0),
        unassigned: person().filter(|c| c.key.is_none()).count(),
        version: VERSION,
        workstreams,
        conversations,
    };

    // ponytail: one JSON file for the whole vault. Ask reads it through
    // vault::read_file, which refuses files over 16 MB (roughly 10k-30k
    // conversations); split it per workstream before a vault nears that.
    let mut text = serde_json::to_string_pretty(&plan.facts)
        .map_err(|error| format!("serialize workstream facts: {error}"))?;
    text.push('\n');
    if previous_text.as_deref() != Some(text.as_str()) {
        let expected = previous_text
            .as_deref()
            .map(crate::importers::wikify::source_revision);
        plan.facts_write = Some((text, expected));
    }
    for (key, workstream) in &plan.facts.workstreams {
        let page = render_page(key, workstream, &plan.facts.conversations);
        // A page whose marker block is gone belongs to a person now.
        match read_existing(&root.join(&workstream.page)) {
            Ok(None) => plan.pages.push((workstream.page.clone(), page, None)),
            Ok(Some(existing)) if existing == page => {}
            Ok(Some(existing)) if is_owned(&existing) => {
                let expected = crate::importers::wikify::source_revision(&existing);
                plan.pages
                    .push((workstream.page.clone(), page, Some(expected)));
            }
            _ => {}
        }
    }
    Ok(plan)
}

/// Publish a plan, each file only over the exact bytes the plan read. The
/// facts go first: Ask reads them, and a page that failed is rendered again
/// from them on the next pass. Returns how many files were written.
pub(crate) fn apply(root: &Path, plan: &Plan) -> Result<usize, String> {
    let facts = plan
        .facts_write
        .as_ref()
        .map(|(body, expected)| (facts_rel(), body, expected));
    let pages = plan
        .pages
        .iter()
        .map(|(rel, body, expected)| (rel.clone(), body, expected));
    let mut written = 0;
    for (rel, body, expected) in facts.into_iter().chain(pages) {
        let path = crate::vault::confine_delete_path(root, &root.join(&rel).to_string_lossy())?;
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|error| format!("create workstream folder: {error}"))?;
        }
        crate::vault::write_file_if_unchanged(&path.to_string_lossy(), body, expected.as_deref())
            .map_err(|error| format!("publish workstreams: {error}"))?;
        written += 1;
    }
    Ok(written)
}

/// Codex homes in lookup order: `$CODEX_HOME` (else `~/.codex`), then each
/// Orca account home. Only read, never written.
fn codex_homes() -> Vec<PathBuf> {
    let Ok(home) = std::env::var(if cfg!(windows) { "USERPROFILE" } else { "HOME" }) else {
        return Vec::new();
    };
    let home = PathBuf::from(home);
    let mut homes = vec![std::env::var_os("CODEX_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| home.join(".codex"))];
    let mut accounts: Vec<PathBuf> =
        std::fs::read_dir(home.join("Library/Application Support/orca/codex-accounts"))
            .map(|entries| {
                entries
                    .flatten()
                    .map(|entry| entry.path().join("home"))
                    .filter(|path| path.is_dir())
                    .collect()
            })
            .unwrap_or_default();
    accounts.sort();
    homes.extend(accounts);
    homes
}

#[cfg(not(test))]
pub(crate) fn default_codex_homes() -> Vec<PathBuf> {
    codex_homes()
}

// Tests never read this machine's Codex homes unless they name one.
#[cfg(test)]
thread_local! {
    static TEST_CODEX_HOMES: std::cell::RefCell<Vec<PathBuf>> = const { std::cell::RefCell::new(Vec::new()) };
}

#[cfg(test)]
pub(crate) fn default_codex_homes() -> Vec<PathBuf> {
    TEST_CODEX_HOMES.with(|homes| homes.borrow().clone())
}

#[cfg(test)]
pub(crate) fn set_test_codex_homes(homes: Vec<PathBuf>) {
    TEST_CODEX_HOMES.with(|slot| *slot.borrow_mut() = homes);
}

fn facts_rel() -> String {
    format!("{}/{FACTS_FILE}", crate::vault_dir::DIR_NAME)
}

fn facts_path(root: &Path) -> PathBuf {
    crate::vault_dir::dir(root).join(FACTS_FILE)
}

/// A ledger key this module groups: a Claude Code or Codex conversation.
pub(crate) fn is_tracked(key: &str) -> bool {
    key.starts_with("claude-code:") || key.starts_with("codex:")
}

/// A vault-relative path inside the machine-owned page folder, compared
/// without case (macOS and Windows paths are case-insensitive) and with '\'
/// as '/'. Allocation-free: every index pass asks for every page.
pub(crate) fn is_page_path(rel: &str) -> bool {
    rel.len() >= PAGE_DIR.len()
        && rel
            .bytes()
            .zip(PAGE_DIR.bytes())
            .all(|(have, want)| have.eq_ignore_ascii_case(&want) || (have, want) == (b'\\', b'/'))
}

/// The raw transcript of one ledger revision as the importer names it
/// (`import_projection`): `raw/conversations/<vendor>/<vendor>-<id>-<fp>.md`.
fn raw_path(key: &str, fp: &str) -> Option<String> {
    let (vendor, id) = key.split_once(':')?;
    Some(format!(
        "raw/conversations/{vendor}/{vendor}-{}-{fp}.md",
        crate::importers::sanitize(id)
    ))
}

/// A unix time the facts can carry: the reader takes non-negative safe
/// integers, so a timestamp before 1970 counts as missing.
fn epoch(seconds: i64) -> Option<i64> {
    (0..=MAX_EPOCH).contains(&seconds).then_some(seconds)
}

/// The project key of a working folder; the "(...)" buckets name none.
fn project_key(cwd: &str) -> Option<String> {
    thread_key(cwd).filter(|key| !key.starts_with('('))
}

/// `ledger::fingerprint` output; anything else must not reach a raw path.
fn is_fingerprint(fp: &str) -> bool {
    fp.len() == 16
        && fp
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn is_owned(page: &str) -> bool {
    page.contains(MARKER_OPEN) && page.contains(MARKER_CLOSE)
}

/// The page file name of a key: the key itself when every platform the app
/// ships on and a `[[wikilink]]` carry it unchanged ('#' starts a heading
/// anchor, '^' a block, '|' a label), else the key with each such character
/// as '-' and a short hash of the key, so two keys never share a page.
fn page_name(key: &str) -> String {
    let mut name: String = key
        .chars()
        .map(|c| match c {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' | '[' | ']' | '#' | '^' => '-',
            c if c.is_control() => '-',
            c => c,
        })
        .collect();
    if name.starts_with('.') {
        name.replace_range(..1, "-");
    }
    if name == key && !name.is_empty() && name.len() <= 200 && !name.ends_with([' ', '.']) {
        return name;
    }
    let mut cut = 120.min(name.len());
    while !name.is_char_boundary(cut) {
        cut -= 1;
    }
    let hash = crate::importers::ledger::fingerprint(key);
    format!("{}-{}", &name[..cut], &hash[..8])
}

fn read_existing(path: &Path) -> Result<Option<String>, String> {
    match std::fs::read_to_string(path) {
        Ok(text) => Ok(Some(text)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!("read workstream state: {error}")),
    }
}

fn read_capped(path: &Path, cap: u64) -> Option<String> {
    use std::io::Read;
    // A FIFO or device under that name would block the pass or never end.
    if !std::fs::metadata(path).ok()?.is_file() {
        return None;
    }
    let mut text = String::new();
    std::fs::File::open(path)
        .ok()?
        .take(cap)
        .read_to_string(&mut text)
        .ok()?;
    Some(text)
}

// ---- pure rules -------------------------------------------------------------

struct Patterns {
    slashes: Regex,
    tmp: Regex,
    home: Regex,
    home_in_text: Regex,
    container: Regex,
    worktree_suffix: Regex,
    image: Regex,
    link: Regex,
    tag: Regex,
    zone: Regex,
    attachment: Regex,
    json_key: Regex,
    field: Regex,
}

fn patterns() -> &'static Patterns {
    static P: OnceLock<Patterns> = OnceLock::new();
    P.get_or_init(|| Patterns {
        slashes: Regex::new(r"/+").unwrap(),
        tmp: Regex::new(r"^(?:/private)?/(?:tmp|var/folders|var/tmp)(?:/|$)").unwrap(),
        // Over a path with '/' separators; a Windows drive may lead.
        home: Regex::new(r"^(?:[A-Za-z]:)?/(?:Users|home)/[^/]+").unwrap(),
        home_in_text: Regex::new(r"(?:\b[A-Za-z]:)?[\\/](?:Users|home)[\\/][^\\/\s]+").unwrap(),
        container: Regex::new(
            r"(?i)^(?:projects?|prj|[\w.-]*projects|repos?|src|code|dev|developer|work|workspaces?|git|github|documents|desktop|downloads)$",
        )
        .unwrap(),
        worktree_suffix: Regex::new(r"(?i)[-_.]worktrees?(?:[-_.].*)?$").unwrap(),
        image: Regex::new(r"!\[[^\]]*\]\([^)]*\)").unwrap(),
        link: Regex::new(r"\[([^\]]*)\]\([^)]*\)").unwrap(),
        tag: Regex::new(r"<[^>]*>").unwrap(),
        // An IANA time zone such as Asia/Seoul.
        zone: Regex::new(
            r"\b(?:Africa|America|Antarctica|Asia|Atlantic|Australia|Europe|Indian|Pacific|Etc)/[A-Z]",
        )
        .unwrap(),
        // Claude Code's placeholders for an attached image or pasted text.
        attachment: Regex::new(r"\[(?:Image #\d+|Pasted text #\d+(?: \+\d+ lines)?)\]").unwrap(),
        // A line that opens with a quoted key: part of a JSON object.
        json_key: Regex::new(r#"^[\[{\s]*"[^"]*"\s*:"#).unwrap(),
        // A `field: value` line of a filled-in template (`주제: …`).
        field: Regex::new(r"^[\w-]{1,24}:(?:\s|$)").unwrap(),
    })
}

/// P0 `thread_key` (p0_measure.py): a pure map from a cwd string to a project
/// key. Reads no filesystem and expands nothing; a cwd that names no project
/// maps to a "(...)" bucket. Keys are lowercased and NFC because macOS paths
/// are case- and normalization-insensitive, and Windows paths may use '\'.
pub(crate) fn thread_key(cwd: &str) -> Option<String> {
    let cwd = cwd.trim();
    if cwd.is_empty() {
        return None;
    }
    let rx = patterns();
    let collapsed = rx
        .slashes
        .replace_all(&cwd.replace('\\', "/"), "/")
        .into_owned();
    let p = match collapsed.trim_end_matches('/') {
        "" => "/",
        trimmed => trimmed,
    };
    let bucket = |name: &str| Some(format!("({name})"));
    if rx.tmp.is_match(p) {
        return bucket("tmp");
    }
    let rel = if p == "~" || p.starts_with("~/") {
        &p[1..]
    } else if let Some(home) = rx.home.find(p) {
        &p[home.end()..]
    } else if p == "/root" || p.starts_with("/root/") {
        &p[5..]
    } else {
        return bucket("outside-home");
    };
    let mut parts: Vec<&str> = rel.split('/').filter(|part| !part.is_empty()).collect();
    if parts.is_empty() {
        return bucket("home");
    }
    let name = if parts[0] == ".codex" && parts.len() >= 4 && parts[1] == "worktrees" {
        parts[3] // ~/.codex/worktrees/<id>/<project>/...
    } else if parts[0].starts_with('.') {
        return bucket("tool-config");
    } else if matches!(parts[0], "Library" | "AppData") {
        return bucket("app-data");
    } else if parts[0] == "orca"
        && parts.len() >= 3
        && matches!(parts[1], "workspaces" | "projects")
    {
        parts[2] // ~/orca/workspaces/<project>/<workspace>/..., ~/orca/projects/<project>/...
    } else if parts[0].to_lowercase() == "documents" && parts.len() >= 2 && parts[1] == "Codex" {
        return bucket("codex-chat");
    } else {
        // <project>/.claude/worktrees/<x>/... belongs to <project>.
        if let Some(at) = (0..parts.len()).find(|&i| {
            matches!(parts[i], ".worktrees" | "worktrees")
                || (parts[i] == ".claude" && parts.get(i + 1) == Some(&"worktrees"))
        }) {
            parts.truncate(at);
        }
        if parts.is_empty() {
            return bucket("home");
        }
        if rx.container.is_match(parts[0]) {
            if parts.len() < 2 {
                return bucket("container");
            }
            parts[1]
        } else {
            parts[0]
        }
    };
    let stripped = rx.worktree_suffix.replace(name, "");
    let name = if stripped.is_empty() { name } else { &stripped };
    Some(crate::norm::nfc(&name.to_lowercase()).into_owned())
}

/// P0 `majority_key`: the key with the most votes. A tie, or a winning
/// non-project "(...)" bucket, assigns nothing.
pub(crate) fn majority(votes: &BTreeMap<String, usize>) -> Option<String> {
    let mut ranked: Vec<(&String, &usize)> = votes.iter().collect();
    ranked.sort_by(|a, b| b.1.cmp(a.1).then_with(|| a.0.cmp(b.0)));
    let (key, count) = *ranked.first()?;
    if ranked.get(1).is_some_and(|(_, next)| *next == count) || key.starts_with('(') {
        return None;
    }
    Some(key.clone())
}

/// The topmost ancestor reached through `parent`, which answers for every
/// thread in the vault, so the chain may end at a parent that is not in it:
/// that thread's own parent is unknown. A cycle has no top, so its smallest
/// member stands in; every member then agrees on one root.
pub(crate) fn root_of(key: &str, parent: impl Fn(&str) -> Option<String>) -> String {
    let mut chain = vec![key.to_string()];
    while let Some(next) = chain.last().and_then(|at| parent(at)) {
        if let Some(start) = chain.iter().position(|seen| *seen == next) {
            return chain[start..].iter().min().cloned().unwrap_or(next);
        }
        chain.push(next);
    }
    chain.pop().unwrap_or_else(|| key.to_string())
}

/// The lead of a Claude Code agent team named after its lead's session
/// (`claude-code:session-<the start of the lead's id>`): the one Claude Code
/// conversation in the vault whose id starts so. `None` keeps the team's own
/// key, so teammates whose lead was never imported still share one root.
fn team_lead(parent: &str, conversations: &BTreeMap<String, ConversationFacts>) -> Option<String> {
    let start = parent
        .strip_prefix("claude-code:session-")
        .filter(|start| !start.is_empty())?;
    let prefix = format!("claude-code:{start}");
    let mut leads = conversations
        .range(prefix.clone()..)
        .take_while(|(key, _)| key.starts_with(&prefix));
    let (lead, _) = leads.next()?;
    leads.next().is_none().then(|| lead.clone())
}

/// The key of the nearest present ancestor that has its own working folder
/// (`own` answers `Some` for those, possibly a `None` key), or `None` when no
/// ancestor has one.
fn inherited_key(
    key: &str,
    parent: impl Fn(&str) -> Option<String>,
    own: impl Fn(&str) -> Option<Option<String>>,
) -> Option<Option<String>> {
    let mut seen = BTreeSet::from([key.to_string()]);
    let mut at = key.to_string();
    while let Some(next) = parent(&at) {
        if !seen.insert(next.clone()) {
            return None;
        }
        if let Some(found) = own(&next) {
            return Some(found);
        }
        at = next;
    }
    None
}

/// Openings of user turns a harness writes as a whole (P0 HARNESS_PREFIXES).
const HARNESS_OPENINGS: &[&str] = &[
    "Another Claude session sent a message",
    "Base directory for this skill:",
    "This session is being continued from a previous conversation",
    "[Request interrupted by user",
    "Stop hook feedback:",
    "You just worked on the goal",
    "The following is the Codex agent history",
    "Caveat: The messages below were generated by the user while running local commands",
    "[Image: ",
    "[Usage limit ",
    "[Earlier usage",
    // A helper session that names a git branch after another session's work.
    "Generate a short git branch name that summarizes the coding task described below.",
];

/// How Claude Code's `/goal` hands the person's condition to the model; the
/// condition is what they typed.
const GOAL_OPENING: &str = "A session-scoped Stop hook is now active with condition: \"";

/// Harness blocks P0 found in user turns beyond `machine_session::strip_harness`
/// (a prefix, so numbered `external_codex_apps_*` variants match too).
const MORE_HARNESS_TAGS: &[&str] = &[
    "local-command-caveat",
    "command-name",
    "command-message",
    "command-args",
    "local-command-stdout",
    "permissions",
    "codex_internal_context",
    "teammate-message",
    "bash-stdout",
    "bash-stderr",
    "user_instructions",
    "user_shell_command",
    "in-app-browser-context",
    "artifact-content-authored-by-others",
    "external_codex_apps_",
];

/// One user turn without harness blocks or attachment placeholders, trimmed.
fn without_harness(turn: &str) -> String {
    let mut text = crate::machine_session::strip_harness(turn);
    for tag in MORE_HARNESS_TAGS {
        let (open, close) = (format!("<{tag}"), format!("</{tag}"));
        while let Some(start) = text.find(&open) {
            // Unclosed: drop to the end of the turn, as strip_harness does.
            let end = text[start..]
                .find(&close)
                .and_then(|at| text[start + at..].find('>').map(|gt| start + at + gt + 1))
                .unwrap_or(text.len());
            text.replace_range(start..end, "");
        }
    }
    patterns()
        .attachment
        .replace_all(&text, "")
        .trim()
        .to_string()
}

/// What a person typed in one user turn; empty when the harness wrote it all.
fn human_text(turn: &str) -> String {
    let text = without_harness(turn);
    let text = text.as_str();
    if let Some(rest) = text.strip_prefix(GOAL_OPENING) {
        // The harness sentence goes on after the closing `". `.
        let condition = rest
            .rsplit_once("\". ")
            .map_or(rest, |(condition, _)| condition);
        return condition.trim().to_string();
    }
    let slash_body = text
        .strip_prefix("# /")
        .is_some_and(|rest| rest.starts_with(|c: char| c.is_ascii_alphabetic()));
    if slash_body
        || HARNESS_OPENINGS
            .iter()
            .any(|opening| text.starts_with(opening))
    {
        return String::new();
    }
    text.to_string()
}

/// Openings of a request a program writes, never the person: Claude Code's
/// helpers and the person's own apps (a dashboard's translator, a team
/// runtime), found in the 2026-11-08 dry run.
const MACHINE_OPENINGS: &[&str] = &[
    "Translate each",
    "Summarize the following",
    "Generate a short",
    "You just finished task",
    "You just worked on the goal",
    "You are a ",
    "You are an ",
    "You are the ",
];

/// Korean openings that give a role or present data. They are a program's
/// only when the first sentence is written-style declarative ("당신은
/// …입니다", "너는 …다", "다음은 …목록이다"): a person writes to an agent in
/// speech style ("너는 …야", "다음은 …해줘").
const DECLARED_OPENINGS: &[&str] = &["당신은 ", "너는 ", "다음은 "];

/// Whether a conversation's first request was written by a program rather
/// than the person: a role or a fixed instruction at the very start, or a
/// payload that is mostly JSON or `field: value` lines.
// ponytail: opening lists, not a classifier; add an opening when a dry run
// finds another program's prompt among the person's sessions. Changing these
// rules needs a VERSION bump: plan() keeps the flag of conversations whose
// fingerprint is unchanged.
fn is_automated(request: &str) -> bool {
    let text = request.trim();
    MACHINE_OPENINGS
        .iter()
        .any(|opening| text.starts_with(opening))
        || (DECLARED_OPENINGS
            .iter()
            .any(|opening| text.starts_with(opening))
            && first_sentence(text).ends_with('다')
            // "다음은 …입니다." is a person writing politely, not a program's brief.
            && !(text.starts_with("다음은 ") && first_sentence(text).ends_with("니다")))
        || is_json_payload(text)
        || is_template_payload(text)
}

/// Up to the first line break or the first '.', '!', '?' or '。' that ends a
/// word ("v6.18.0" goes on), without a parenthetical that closes it
/// ("…목록이다(소스별)").
fn first_sentence(text: &str) -> &str {
    let end = text
        .char_indices()
        .find(|&(at, c)| {
            c == '\n'
                || (matches!(c, '.' | '!' | '?' | '。')
                    && text[at + c.len_utf8()..]
                        .chars()
                        .next()
                        .is_none_or(char::is_whitespace))
        })
        .map_or(text.len(), |(at, _)| at);
    let sentence = text[..end].trim_end();
    sentence
        .strip_suffix(')')
        .and_then(|inner| inner.rfind('(').map(|open| inner[..open].trim_end()))
        .unwrap_or(sentence)
}

/// A JSON value that starts the text and spans at least half of it.
fn is_json_payload(text: &str) -> bool {
    if !text.starts_with(['{', '[']) {
        return false;
    }
    let mut values = serde_json::Deserializer::from_str(text).into_iter::<serde_json::Value>();
    matches!(values.next(), Some(Ok(_))) && values.byte_offset() * 2 >= text.len()
}

/// At least three `field: value` lines (`주제: …`, `research: …`) that make
/// up at least half of the lines with text or that start the text.
fn is_template_payload(text: &str) -> bool {
    let lines: Vec<&str> = text
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .collect();
    let fields = lines
        .iter()
        .filter(|line| patterns().field.is_match(line))
        .count();
    // A filled-in template may carry long multi-line values (bullet lists under
    // `research:`), so a first line that is itself a field also counts.
    fields >= 3
        && (fields * 2 >= lines.len()
            || lines
                .first()
                .is_some_and(|line| patterns().field.is_match(line)))
}

/// Replies that say nothing about the work, compared as lowercase letters and
/// digits only ("Done!", "완료했습니다.").
const ACKNOWLEDGEMENTS: &[&str] = &[
    "ok",
    "okay",
    "done",
    "alldone",
    "finished",
    "complete",
    "completed",
    "fixed",
    "yes",
    "sure",
    "네",
    "예",
    "좋습니다",
    "알겠습니다",
    "완료",
    "완료했습니다",
    "완료됐습니다",
    "완료되었습니다",
    "작업완료",
    "작업완료했습니다",
    "작업을완료했습니다",
    "끝났습니다",
    "끝냈습니다",
    "다했습니다",
    "확인했습니다",
    "수정했습니다",
    "반영했습니다",
    "はい",
    "完了",
    "完了しました",
    "終わりました",
    "できました",
    "対応しました",
];

fn is_acknowledgement(line: &str) -> bool {
    let folded: String = line
        .chars()
        .filter(|c| c.is_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect();
    ACKNOWLEDGEMENTS.contains(&folded.as_str())
}

/// A report's most telling line, cut as `hint_line` cuts it: the first one
/// outside code that is not a heading, a table row, a lead-in ending in ':'
/// or a bare acknowledgement, else the first line with any text. JSON is
/// never the line, so a report of JSON only has none.
fn report_line(text: &str) -> Option<String> {
    let mut fenced = false;
    let mut first = None;
    for line in text.lines().map(str::trim) {
        if line.starts_with("```") || line.starts_with("~~~") {
            fenced = !fenced;
            continue;
        }
        if fenced || !line.chars().any(char::is_alphanumeric) || is_json_line(line) {
            continue;
        }
        first.get_or_insert(line);
        let heading = (line.starts_with('#') && line.trim_start_matches('#').starts_with(' '))
            || (line.len() > 4 && line.starts_with("**") && line.ends_with("**"));
        let table = line.starts_with('|');
        if !heading && !table && !line.ends_with([':', '：']) && !is_acknowledgement(line) {
            return hint_line(line);
        }
    }
    hint_line(first?)
}

/// JSON or a fragment of it: a line that starts with '{' or '[' and parses,
/// as an element of a longer list may with its trailing ',', or that opens
/// with a quoted key (`"title": …`).
fn is_json_line(line: &str) -> bool {
    let value = line.trim_end_matches(',');
    (value.starts_with(['{', '[']) && serde_json::from_str::<serde_json::Value>(value).is_ok())
        || patterns().json_key.is_match(line)
}

/// The first human turn's hint, else the `<objective>` of a Codex goal context.
fn request_hint<S: AsRef<str>>(user_turns: &[S]) -> Option<String> {
    let turns: Vec<&str> = user_turns.iter().map(|turn| turn.as_ref()).collect();
    match turns
        .iter()
        .map(|turn| human_text(turn))
        .find(|text| !text.is_empty())
    {
        Some(text) => hint_line(&text),
        None => turns.iter().find_map(|turn| {
            let (_, rest) = turn.split_once("<objective>")?;
            hint_line(rest.split_once("</objective>")?.0)
        }),
    }
}

/// The first line with a letter or digit, without list, heading or quote
/// markers and with whitespace collapsed, a home folder written as `~`, cut
/// to `HINT_CHARS`. `None` when that line looks like a secret or personal data.
fn hint_line(text: &str) -> Option<String> {
    let line = text
        .lines()
        .map(|line| {
            line.trim()
                .trim_start_matches(['#', '>', '-', '*', '•'])
                .trim()
        })
        .filter(|line| !line.starts_with("```") && !line.starts_with("~~~"))
        .find(|line| line.chars().any(char::is_alphanumeric))?;
    let line = line.replace("**", "");
    let line = line.split_whitespace().collect::<Vec<_>>().join(" ");
    // A path under /Users/<name> carries the account name; the facts never do.
    let line = patterns().home_in_text.replace_all(&line, "~").into_owned();
    if !secrets_scan::scan(&line).is_empty() || !secrets_scan::scan_pii(&line).is_empty() {
        return None;
    }
    Some(cut(line, HINT_CHARS))
}

/// At most `max` characters, the last one '…' when anything was cut.
fn cut(text: String, max: usize) -> String {
    if text.chars().count() <= max {
        return text;
    }
    let mut cut: String = text.chars().take(max - 1).collect();
    cut.push('…');
    cut
}

/// A sidecar record: the vendor line exactly as imported. Only the fields
/// the rules read are decoded; content is decoded once, for the chosen report.
#[derive(Deserialize)]
struct Record {
    cwd: Option<String>,
    message: Option<RecordMessage>,
    payload: Option<RecordPayload>,
    metadata: Option<RecordMetadata>,
}

#[derive(Deserialize)]
struct RecordMessage {
    stop_reason: Option<String>,
}

#[derive(Deserialize)]
struct RecordPayload {
    #[serde(rename = "type")]
    kind: Option<String>,
    role: Option<String>,
    phase: Option<String>,
}

#[derive(Deserialize)]
struct RecordMetadata {
    inherited_user_message: Option<serde_json::Value>,
}

/// Codex's final answer to a turn.
fn is_final_answer(record: &Record) -> bool {
    record.payload.as_ref().is_some_and(|payload| {
        payload.kind.as_deref() == Some("message")
            && payload.role.as_deref() == Some("assistant")
            && payload.phase.as_deref() == Some("final_answer")
    })
}

/// A report: Codex's final answer that was not copied in from a parent thread
/// when it forked; Claude Code's message that ended its turn.
fn is_report(record: &Record, codex: bool) -> bool {
    if codex {
        let inherited = record.metadata.as_ref().is_some_and(|metadata| {
            metadata.inherited_user_message == Some(serde_json::Value::Bool(true))
        });
        !inherited && is_final_answer(record)
    } else {
        record
            .message
            .as_ref()
            .is_some_and(|message| message.stop_reason.as_deref() == Some("end_turn"))
    }
}

#[derive(Default)]
struct SidecarScan<'a> {
    votes: BTreeMap<String, usize>,
    latest_cwd: BTreeMap<String, String>,
    saw_cwd: bool,
    report: Option<&'a str>,
    /// The last final answer copied in from the thread this one forked from.
    copied: Option<&'a str>,
}

fn scan_sidecar(text: &str, codex: bool) -> SidecarScan<'_> {
    let mut scan = SidecarScan::default();
    for line in text.lines().filter(|line| !line.trim().is_empty()) {
        let Ok(record) = serde_json::from_str::<Record>(line) else {
            continue;
        };
        if let Some(cwd) = record.cwd.as_deref().filter(|cwd| !cwd.trim().is_empty()) {
            scan.saw_cwd = true;
            if let Some(key) = thread_key(cwd) {
                *scan.votes.entry(key.clone()).or_default() += 1;
                scan.latest_cwd.insert(key, cwd.to_string());
            }
        }
        if is_report(&record, codex) {
            scan.report = Some(line);
        } else if codex && is_final_answer(&record) {
            scan.copied = Some(line);
        }
    }
    scan
}

fn report_from(line: &str, codex: bool, fallback_epoch: i64) -> Option<Report> {
    let record: serde_json::Value = serde_json::from_str(line).ok()?;
    let content = if codex {
        &record["payload"]["content"]
    } else {
        &record["message"]["content"]
    };
    let text = match content {
        serde_json::Value::String(text) => text.clone(),
        serde_json::Value::Array(blocks) => blocks
            .iter()
            .filter(|block| {
                matches!(
                    block["type"].as_str(),
                    Some("text" | "output_text" | "input_text")
                )
            })
            .filter_map(|block| block["text"].as_str())
            .collect::<Vec<_>>()
            .join("\n"),
        _ => return None,
    };
    let text = crate::importers::strip_session_harness(&text);
    Some(Report {
        epoch: record["timestamp"]
            .as_str()
            .and_then(crate::importers::parse_iso8601)
            .and_then(epoch)
            .unwrap_or(fallback_epoch),
        open: open_lines(&text),
        text: report_line(&text)?,
    })
}

// ---- open items -------------------------------------------------------------

struct OpenPatterns {
    line_open: Regex,
    head_open: Regex,
    closed: Regex,
    head_closed: Regex,
    section_weak: Regex,
    unchecked: Regex,
    checked: Regex,
    heading: Regex,
    lead: Regex,
    list_item: Regex,
    marker: Regex,
    code: Regex,
}

/// Nouns of work a Korean "남은 …" / "… 남았다" names.
const WORK: &str = r"(?:일|작업|업무|과제|문제|이슈|버그|오류|에러|실패|리스크|위험|항목|단계|검증|확인|테스트|구현|수정|정리|개선|확장|기능|부분|것|건|숙제|할\s*일|todo|TODO)";

// ponytail: keyword rules, not a classifier, tuned on the 2026-11-09 dry run
// (62 of the 69 lines listed were open work). Add a cue or a closing phrase when a
// dry run lists a wrong line; changing them needs a VERSION bump, as plan()
// keeps the reports of conversations whose fingerprint is unchanged.
fn open_patterns() -> &'static OpenPatterns {
    static P: OnceLock<OpenPatterns> = OnceLock::new();
    P.get_or_init(|| {
        // A line that states open work on its own.
        let line_open = [
            format!(r"남은\s*(?:\S+\s+)?{WORK}"),
            format!(r"{WORK}\s*(?:이|가|은|는|도|만)?\s*(?:아직\s*)?남(?:아|았|음|습|는다|겨)"),
            r"아직[^.!?。\n]{0,40}?(?:않|못|안\s|아니|아닙|미완|미구현|미검증|남아|남았)".into(),
            r"보류(?:했|함|중|됨|된|하고|하기로|로\s|\s*[.)。]|\s*$)|미완|다음\s*(?:단계|작업|할\s*일)|할\s*일|해야\s*할".into(),
            [
                r"(?i:\b(?:remaining|outstanding|open|pending|left)\s+(?:work|tasks?|items?|issues?|steps?|risks?|gaps?|todos?|questions?|bugs?|failures?)\b",
                r"\b(?:still|yet)\s+(?:to\s+(?:be\s+)?\w+|needs?|missing|pending|open|unverified|untested|failing|fails|not)\b",
                r"\bnot\s+(?:yet\s+)?(?:done|implemented|verified|tested|finished|run|built|wired|shipped|committed|pushed|installed|released|fixed)\b",
                r"\bnext steps?\b|\bblocked\b|\bblockers?\b|\bdeferred\b|\bon hold\b|\bpostponed\b",
                r"\bremains?\s+(?:to|open|unverified|untested|unfixed|unresolved|unclear|pending|blocked|outstanding)\b|\bpending\b)",
            ]
            .join("|"),
            r"(?:^|\s)(?:TODO|FIXME)\s*[:：]".into(),
        ]
        .join("|");
        // A heading or lead-in over a list of open work says it in fewer words.
        let head_open = format!(
            "{line_open}|{}",
            [
                r"보류|미완|미검증|미확인|안\s*(?:한|된|고친|했)\s*(?:것|일|작업|부분|항목)|하지\s*않은|못\s*한",
                r"막(?:힌|혀|는\s*것)|확인\s*필요|필요한\s*것|후속|남겨|남긴|다음\s*(?:권장|선택|스텝)|하셔야\s*할",
                r"(?i:\b(?:remaining|next|todo|to-do|pending|blocked|blockers?|left|follow[- ]?ups?|deferred|outstanding)\b",
                r"\bopen\s+(?:issues|items|questions)\b|\bnot\s+(?:done|yet)\b|\bknown\s+(?:issues|limitations|gaps)\b)",
            ]
            .join("|")
        );
        // What closes a cue: nothing is left, it was done, or it is a condition.
        let closed = [
            format!(r"(?:남은|남아\s*있는|보류(?:된|\s*중인)?|미완(?:료|성)?)\s*(?:\S+\s+)?{WORK}?\s*(?:은|는|이|가|도)?\s*(?:더\s*)?(?:없|0\s*(?:개|건))"),
            r"더\s*(?:할|남은)\s*(?:일|작업|것)\s*(?:은|는|이|가)?\s*없".into(),
            r"(?:남은|보류(?:했던|된|\s*중이던)?|미완(?:료|성)?(?:이던|인|된)?)[^.!?。\n]{0,60}?(?:(?:구현|완료|해결|처리|반영|적용|마무리|정리|수정|추가|통과)\s*(?:했|하였|됐|되었|함|완료)|마쳤|끝냈|끝났|고쳤)".into(),
            r"아직[^.!?。\n]{0,40}?(?:않으|못\s*하|안\s*\S{0,3}?)(?:시)?면|다음\s*단계로\s*(?:진행|넘어|이동)".into(),
            // An English cue word closed in Korean: "blocker는 없습니다".
            r"(?i:\b(?:blockers?|pending|todos?|remaining|open\s+issues?)\b)\s*(?:은|는|이|가|도)?\s*(?:더\s*)?(?:없|0\s*(?:개|건)|아니|아닙)".into(),
            [
                r"(?i:\bno\s+(?:more\s+)?(?:remaining|pending|open|outstanding|known|blocking)\b",
                r"\bnothing\s+(?:remaining|left|pending|outstanding|else)\b|\bnone\s+(?:remaining|left|pending)\b",
                r"\bno\s+blockers?\b|\bnot\s+blocked\b|\bunblocked\b|\b0\s+(?:remaining|pending|failures?|failing|open)\b|\bno\s+(?:todos?|next steps?)\b",
                r"\b(?:remaining|pending|outstanding|open|deferred)\b[^.!?\n]{0,60}?\b(?:were|was|are|is|have been|has been)\s+(?:now\s+)?(?:fixed|resolved|done|completed|implemented|addressed|closed|merged|handled)\b",
                r"\b(?:fixed|resolved|completed|addressed|closed|finished)\s+(?:all\s+)?(?:the\s+)?(?:remaining|pending|outstanding|open)\b)",
            ]
            .join("|"),
        ]
        .join("|");
        // A Unicode `\b` keeps the regex engine off its fast path on Korean
        // text (a debug-build plan of the 2026-11-09 dry run took 15 s, not
        // 5 s); English cue words need only ASCII boundaries.
        let words = |pattern: &str| Regex::new(&pattern.replace(r"\b", r"(?-u:\b)")).unwrap();
        OpenPatterns {
            line_open: words(&line_open),
            head_open: words(&head_open),
            closed: words(&closed),
            head_closed: words(r"완료|완성|해결|불필요|정상|(?i:\b(?:done|resolved|fixed|completed)\b)"),
            // A paragraph under an open heading still says something is not done.
            section_weak: words(
                r"않|못|안\s|없|미(?:완|검증|확인|구현|수행|정|판정)|아직|남|보류|필요|해야|막|(?i:\bnot\b|\bno\b|n't\b|\bpending\b|\bneed|\btodo\b|\bblocked\b)",
            ),
            unchecked: Regex::new(r"^\s*(?:[-*+]|\d+[.)])\s+\[ \]\s+").unwrap(),
            checked: Regex::new(r"^\s*(?:[-*+]|\d+[.)])\s+\[[xX]\]\s+").unwrap(),
            heading: Regex::new(r"^\s{0,3}(?:#{1,6}\s+|\*\*[^*]+\*\*\s*[:：]?\s*$)").unwrap(),
            lead: Regex::new(r"[:：]\s*$").unwrap(),
            list_item: Regex::new(r"^\s*(?:[-*+•]|\d+[.)])\s+").unwrap(),
            marker: Regex::new(r"^\s*(?:[-*+•]\s+|\d+[.)]\s+)?(?:\[[ xX]\]\s+)?").unwrap(),
            code: Regex::new(r"`[^`]*`").unwrap(),
        }
    })
}

/// The lines of a report that say what is left, next, pending, blocked,
/// deferred or not done, each cleaned as a hint is (at most `OPEN_ITEMS`):
/// - an unchecked `- [ ]` item;
/// - a list item under a heading or a lead-in ending in ':' that names open
///   work (`## 남은 작업`, `**Next steps:**`), or a paragraph under such a
///   heading that says something is not done;
/// - any other line with a cue of its own ("검증은 보류했습니다", "아직
///   커밋하지 않았습니다", "remaining issues: …").
///
/// Not a line that closes what it names ("남은 문제 없습니다", "no remaining
/// issues", "남은 작업은 직접 구현했습니다"), a checked `- [x]` item, code,
/// a table or a heading.
fn open_lines(text: &str) -> Vec<String> {
    let rx = open_patterns();
    let mut lines: Vec<String> = Vec::new();
    let mut fenced = false;
    // Some(true) under an open heading, until the next heading; Some(false)
    // under an open lead-in, until a line that is not a list item.
    let mut section: Option<bool> = None;
    for line in text.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with("```") || trimmed.starts_with("~~~") {
            fenced = !fenced;
            continue;
        }
        if fenced || trimmed.is_empty() || trimmed.starts_with('|') {
            continue;
        }
        let plain = rx
            .code
            .replace_all(trimmed, "")
            .replace("**", "")
            .replace("__", "");
        let listed = rx.list_item.is_match(line);
        let heading = rx.heading.is_match(line);
        if heading || (!listed && rx.lead.is_match(trimmed)) {
            let opens = rx.head_open.is_match(&plain)
                && !rx.head_closed.is_match(&plain)
                && !rx.closed.is_match(&plain);
            section = opens.then_some(heading);
            continue;
        }
        if section == Some(false) && !listed {
            section = None;
        }
        // The closing rules run only on a line some cue picked.
        let cued = (section.is_some() && (listed || rx.section_weak.is_match(&plain)))
            || rx.line_open.is_match(&plain);
        let open = rx.unchecked.is_match(line)
            || (cued && !rx.checked.is_match(line) && !rx.closed.is_match(&plain));
        if let Some(item) = open
            .then(|| hint_line(&rx.marker.replace(line, "")))
            .flatten()
        {
            if !lines.contains(&item) {
                lines.push(item);
            }
        }
        if lines.len() == OPEN_ITEMS {
            break;
        }
    }
    lines
}

/// A session's newest activity, its root and its conversations by ledger key.
type Session<'a> = (i64, &'a str, Vec<(&'a str, &'a ConversationFacts)>);

/// The person's sessions in a workstream, newest activity first (ties by
/// root). Automated sessions are left out.
fn sessions<'a>(key: &str, all: &'a BTreeMap<String, ConversationFacts>) -> Vec<Session<'a>> {
    let mut groups: BTreeMap<&str, Vec<(&str, &ConversationFacts)>> = BTreeMap::new();
    for (id, c) in all
        .iter()
        .filter(|(_, c)| c.key.as_deref() == Some(key) && !c.automated)
    {
        groups
            .entry(c.root.as_str())
            .or_default()
            .push((id.as_str(), c));
    }
    let mut sessions: Vec<Session> = groups
        .into_iter()
        .map(|(root, group)| {
            let newest = group.iter().map(|(_, c)| c.last_epoch).max().unwrap_or(0);
            (newest, root, group)
        })
        .collect();
    sessions.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.cmp(b.1)));
    sessions
}

/// What came back to the person in a session and the conversation it was
/// read from: their thread's own report, else its answer a sub-agent copied
/// in when it forked (the thread may not be here), else what a sub-agent
/// reported; the latest within each.
fn session_report<'a>(
    group: &[(&'a str, &'a ConversationFacts)],
) -> Option<(&'a str, &'a ConversationFacts, &'a Report)> {
    group
        .iter()
        .flat_map(|&(id, c)| {
            let own = (if c.subagent { 0 } else { 2 }, c.report.as_ref());
            [own, (1, c.parent_report.as_ref())]
                .into_iter()
                .filter_map(move |(tier, report)| Some((tier, report?.epoch, id, c, report?)))
        })
        .max_by(|a, b| (a.0, a.1, a.2).cmp(&(b.0, b.1, b.2)))
        .map(|(.., id, c, report)| (id, c, report))
}

/// The lines the reports of the latest `OPEN_SESSIONS` sessions leave open,
/// at most `OPEN_ITEMS`: the newest report's first, in the order it wrote
/// them, each line once (compared without case).
fn open_items(sessions: &[Session]) -> Vec<OpenItem> {
    let mut items: Vec<OpenItem> = sessions
        .iter()
        .take(OPEN_SESSIONS)
        .filter_map(|(.., group)| session_report(group))
        .flat_map(|(id, _, report)| {
            report.open.iter().map(move |text| OpenItem {
                conversation: id.to_string(),
                epoch: report.epoch,
                text: text.clone(),
            })
        })
        .collect();
    items.sort_by_key(|item| std::cmp::Reverse(item.epoch));
    let mut seen = BTreeSet::new();
    items.retain(|item| seen.insert(item.text.to_lowercase()));
    items.truncate(OPEN_ITEMS);
    items
}

/// What a raw transcript says, read the way the importer wrote it
/// (`Conversation::to_inbox_doc`): a header line counts only between blank
/// lines.
struct Transcript {
    created: Option<i64>,
    last_activity: Option<i64>,
    parent: Option<String>,
    user_turns: Vec<String>,
}

fn parse_transcript(text: &str) -> Transcript {
    let lines: Vec<&str> = text.split('\n').collect();
    let mut transcript = Transcript {
        created: None,
        last_activity: None,
        parent: None,
        user_turns: Vec::new(),
    };
    let mut body = 0;
    if lines.first() == Some(&"---") {
        for (at, line) in lines.iter().enumerate().skip(1) {
            if *line == "---" {
                body = at + 1;
                break;
            }
            match line.split_once(": ") {
                Some(("created", value)) => transcript.created = value.trim().parse().ok(),
                Some(("last_activity", value)) => {
                    transcript.last_activity = value.trim().parse().ok()
                }
                Some(("turn_metadata", value)) => {
                    transcript.parent = first_turn(value).and_then(|turn| parent_in(&turn))
                }
                _ => {}
            }
        }
    }
    let lines = &lines[body..];
    let is_head = |at: usize| {
        matches!(
            lines[at],
            "**User:**" | "**Assistant:**" | "**System:**" | "**Tool:**"
        ) && (at == 0 || lines[at - 1].is_empty())
            && lines.get(at + 1) == Some(&"")
    };
    let heads: Vec<usize> = (0..lines.len()).filter(|&at| is_head(at)).collect();
    for (n, &at) in heads.iter().enumerate() {
        if lines[at] == "**User:**" {
            let end = heads.get(n + 1).copied().unwrap_or(lines.len());
            let turn = lines[at + 2..end].join("\n");
            transcript.user_turns.push(turn.trim().to_string());
        }
    }
    transcript
}

/// The first element of a `turn_metadata:` value, decoded without reading
/// the rest of the array; `None` when it is cut off or malformed.
fn first_turn(metadata: &str) -> Option<serde_json::Value> {
    let elements = metadata.trim_start().strip_prefix('[')?;
    serde_json::Value::deserialize(&mut serde_json::Deserializer::from_str(elements)).ok()
}

/// `session_provenance[0].parent_thread_id`: the first turn holds the thread's
/// declarations, its own first and copies from a parent after (codex.rs).
fn parent_in(first_turn: &serde_json::Value) -> Option<String> {
    let parent = first_turn["session_provenance"][0]["parent_thread_id"]
        .as_str()?
        .trim();
    (!parent.is_empty()).then(|| parent.to_string())
}

/// The parent thread of an unchanged Codex conversation, from the head of its
/// raw transcript: `turn_metadata` is the fourth frontmatter line, so its
/// first element nearly always fits in the head.
fn read_parent(path: &Path) -> Option<String> {
    use std::io::Read;
    const HEAD: u64 = 16 * 1024;
    const FIELD: &str = "\nturn_metadata: ";
    let mut bytes = Vec::new();
    std::fs::File::open(path)
        .ok()?
        .take(HEAD)
        .read_to_end(&mut bytes)
        .ok()?;
    let head = String::from_utf8_lossy(&bytes);
    if let Some(turn) = head
        .find(FIELD)
        .and_then(|at| first_turn(&head[at + FIELD.len()..]))
    {
        return parent_in(&turn);
    }
    if (bytes.len() as u64) < HEAD {
        return None;
    }
    parse_transcript(&std::fs::read_to_string(path).ok()?).parent
}

/// The parent key of an unchanged sub-agent, read back each pass: a Codex
/// thread's from the head of its raw transcript, a Claude Code teammate's
/// team from its sidecar's first record.
fn read_parent_key(root: &Path, conversation: &ConversationFacts) -> Option<String> {
    let raw = root.join(&conversation.raw);
    if conversation.vendor == "codex" {
        return read_parent(&raw).map(|id| format!("codex:{id}"));
    }
    team_of(&first_line(&raw.with_extension("jsonl"))?).map(|team| format!("claude-code:{team}"))
}

/// The agent team of a Claude Code teammate session, from its sidecar's
/// first record: a teammate's records name its team and the teammate, its
/// lead's records neither.
fn team_of(first_record: &[u8]) -> Option<String> {
    #[derive(Deserialize)]
    struct Member {
        #[serde(rename = "teamName")]
        team: Option<String>,
        #[serde(rename = "agentName")]
        agent: Option<String>,
    }
    let member: Member = serde_json::from_slice(first_record).ok()?;
    member.agent.filter(|agent| !agent.trim().is_empty())?;
    let team = member.team?.trim().to_string();
    (!team.is_empty() && team.len() <= MAX_ID_BYTES).then_some(team)
}

/// A file's first line with its newline, read up to `MAX_FIRST_LINE` bytes.
fn first_line(path: &Path) -> Option<Vec<u8>> {
    use std::io::{BufRead, Read};
    let mut line = Vec::new();
    std::io::BufReader::new(std::fs::File::open(path).ok()?)
        .take(MAX_FIRST_LINE)
        .read_until(b'\n', &mut line)
        .ok()?;
    Some(line)
}

/// What reading a conversation learns but does not store: the key of the
/// thread it was spawned from (`codex:<parent thread>`, or
/// `claude-code:<team>` for a teammate) and the working folder of its key
/// (for the display name).
struct Read {
    parent: Option<String>,
    cwd: Option<String>,
}

/// Facts for one ledger revision from its raw transcript and sidecar. Codex
/// working folders come from the vendor stores, after this.
fn read_conversation(root: &Path, key: &str, fp: &str) -> Option<(ConversationFacts, Read)> {
    let (vendor, id) = key.split_once(':')?;
    let raw = raw_path(key, fp)?;
    let stem = raw.trim_end_matches(".md");
    let text = std::fs::read_to_string(root.join(&raw)).ok()?;
    let transcript = parse_transcript(&text);
    let created = transcript.created.and_then(epoch);
    let last_activity = transcript.last_activity.and_then(epoch);
    let start = created.or(last_activity)?;
    let end = last_activity.unwrap_or(start);
    let (first_epoch, last_epoch) = (start.min(end), start.max(end));
    let codex = vendor == "codex";
    let sidecar = std::fs::read_to_string(root.join(format!("{stem}.jsonl"))).unwrap_or_default();
    let scan = scan_sidecar(&sidecar, codex);
    let parent = if codex {
        transcript.parent.as_ref().map(|id| format!("codex:{id}"))
    } else {
        // As `read_parent_key` reads it back on a later pass.
        sidecar
            .split('\n')
            .next()
            .filter(|line| line.len() as u64 <= MAX_FIRST_LINE)
            .and_then(|line| team_of(line.as_bytes()))
            .map(|team| format!("claude-code:{team}"))
    };
    let mut read = Read {
        parent: parent.clone(),
        cwd: None,
    };
    let (own_key, cwd_source) = if codex {
        (None, CwdSource::Missing)
    } else {
        let own_key = majority(&scan.votes);
        read.cwd = own_key
            .as_ref()
            .and_then(|key| scan.latest_cwd.get(key))
            .cloned();
        let source = if scan.saw_cwd {
            CwdSource::Sidecar
        } else {
            CwdSource::Missing
        };
        (own_key, source)
    };
    // What started it, harness openings included: a helper that names a git
    // branch writes its whole first turn.
    let opening = transcript
        .user_turns
        .iter()
        .map(|turn| without_harness(turn))
        .find(|text| !text.is_empty());
    let conversation = ConversationFacts {
        automated: opening.as_deref().is_some_and(is_automated),
        cwd_source,
        first_epoch,
        fp: fp.to_string(),
        id: id.to_string(),
        key: own_key,
        last_epoch,
        // Copies predate the fork, so a missing time is its start.
        parent_report: scan
            .copied
            .and_then(|line| report_from(line, true, first_epoch)),
        raw: raw.clone(),
        report: scan
            .report
            .and_then(|line| report_from(line, codex, last_epoch)),
        request: request_hint(&transcript.user_turns),
        root: key.to_string(),
        subagent: parent.is_some(),
        vendor: vendor.to_string(),
    };
    Some((conversation, read))
}

// ---- display names ----------------------------------------------------------

/// A display name, where it came from, and the summary under a README title.
type Named = (String, TitleSource, Option<String>);

/// From the working folders newest first, the first one still on disk and
/// allowed to be read that gives a name, walking up toward its home folder:
/// its first README.md `# ` heading (with the paragraph under it), else the
/// nearest package.json name. One key can span sibling folders
/// (`~/orca/workspaces/<key>/<workspace>`) of which only some have a README.
/// `None` when no folder gives one, so a caller keeps the name it had.
// ponytail: each distinct folder walks up on its own, so siblings reread a
// shared parent's README; cache per directory if a full pass gets slow.
fn display_name(cwds: &[(i64, String)], vault: &Path) -> Option<Named> {
    let mut tried = BTreeSet::new();
    cwds.iter().find_map(|(_, cwd)| {
        let cwd = cwd.replace('\\', "/");
        let home = patterns().home.find(&cwd)?.end();
        if !tried.insert(cwd.clone()) || !may_read(&cwd, home, vault) || !Path::new(&cwd).is_dir() {
            return None;
        }
        display_name_under(Path::new(&cwd), Path::new(&cwd[..home]))
    })
}

/// macOS asks the person before an app first reads ~/Desktop, ~/Documents
/// or ~/Downloads, and a background title lookup must not raise that prompt
/// (nor wait on it). Such a folder is read only when the vault lives there
/// too, so the app already holds that access.
fn may_read(cwd: &str, home_end: usize, vault: &Path) -> bool {
    if !cfg!(target_os = "macos") {
        return true;
    }
    let top = cwd[home_end..]
        .split('/')
        .find(|part| !part.is_empty())
        .unwrap_or("");
    if !["desktop", "documents", "downloads"].contains(&top.to_ascii_lowercase().as_str()) {
        return true;
    }
    let folder = format!("{}/{top}/", &cwd[..home_end]).to_lowercase();
    format!("{}/", vault.to_string_lossy().replace('\\', "/"))
        .to_lowercase()
        .starts_with(&folder)
}

fn display_name_under(cwd: &Path, home: &Path) -> Option<Named> {
    let dirs: Vec<&Path> = cwd
        .ancestors()
        .take_while(|dir| dir.starts_with(home) && *dir != home)
        .collect();
    dirs.iter()
        .find_map(|dir| readme(dir))
        .map(|(title, summary)| (title, TitleSource::Readme, summary))
        .or_else(|| {
            dirs.iter()
                .find_map(|dir| package_name(dir))
                .map(|name| (name, TitleSource::Package, None))
        })
}

/// A README's title, its first `# ` heading outside code that `clean_title`
/// keeps, and the summary under it (`readme_summary`).
fn readme(dir: &Path) -> Option<(String, Option<String>)> {
    let text = read_capped(&dir.join("README.md"), 256 * 1024)?;
    let lines: Vec<&str> = text.lines().collect();
    let mut fenced = false;
    for (at, line) in lines.iter().enumerate() {
        if line.trim_start().starts_with("```") || line.trim_start().starts_with("~~~") {
            fenced = !fenced;
        } else if let Some(heading) = line.strip_prefix("# ").filter(|_| !fenced) {
            if let Some(title) = clean_title(heading) {
                return Some((title, readme_summary(&lines[at + 1..])));
            }
        }
    }
    None
}

/// The first paragraph under a README title, before the next heading, as
/// plain text (`summary_text`). Lists, tables, code, rules and HTML comments
/// are no paragraph, nor is one with no text left once its markup is gone (a
/// row of badges, a logo); a blockquote is (a tagline).
fn readme_summary(lines: &[&str]) -> Option<String> {
    let mut paragraph: Vec<&str> = Vec::new();
    let (mut fenced, mut comment, mut block) = (false, false, false);
    for line in lines {
        let trimmed = line.trim();
        let quoted = trimmed.trim_start_matches('>').trim();
        let in_paragraph = if comment {
            comment = !trimmed.contains("-->");
            false
        } else if trimmed.starts_with("```") || trimmed.starts_with("~~~") {
            fenced = !fenced;
            false
        } else if fenced {
            false
        } else if (trimmed.starts_with('#') && trimmed.trim_start_matches('#').starts_with(' '))
            || (trimmed
                .get(..2)
                .is_some_and(|open| open.eq_ignore_ascii_case("<h"))
                && matches!(trimmed.as_bytes().get(2), Some(b'1'..=b'6')))
        {
            break;
        } else if trimmed.starts_with("<!--") {
            comment = !trimmed.contains("-->");
            false
        } else {
            // A list, a table or a rule runs to the next blank line.
            block = !quoted.is_empty()
                && (block
                    || open_patterns().list_item.is_match(quoted)
                    || quoted.starts_with('|')
                    || quoted.chars().all(|c| matches!(c, '-' | '*' | '_' | ' ')));
            !quoted.is_empty() && !block
        };
        if in_paragraph {
            paragraph.push(quoted);
            continue;
        }
        if let Some(summary) = paragraph_text(&paragraph) {
            return Some(summary);
        }
        paragraph.clear();
    }
    paragraph_text(&paragraph)
}

/// A paragraph's lines as one plain text, `None` when nothing is left.
fn paragraph_text(lines: &[&str]) -> Option<String> {
    let text = without_markup(&lines.join(" "));
    let text = [
        ("&nbsp;", " "),
        ("&lt;", "<"),
        ("&gt;", ">"),
        ("&quot;", "\""),
        ("&#39;", "'"),
        ("&amp;", "&"),
    ]
    .iter()
    .fold(text, |text, (entity, character)| {
        text.replace(entity, character)
    });
    summary_text(&text)
}

/// A summary as the facts keep it: whitespace collapsed, a home folder
/// written as `~`, at most `SUMMARY_CHARS` characters. `None` when no letter
/// or digit is left or it looks like a secret or personal data.
fn summary_text(text: &str) -> Option<String> {
    let text = text.split_whitespace().collect::<Vec<_>>().join(" ");
    let text = patterns().home_in_text.replace_all(&text, "~").into_owned();
    let clean = secrets_scan::scan(&text).is_empty() && secrets_scan::scan_pii(&text).is_empty();
    (clean && text.chars().any(char::is_alphanumeric)).then(|| cut(text, SUMMARY_CHARS))
}

fn package_name(dir: &Path) -> Option<String> {
    let text = read_capped(&dir.join("package.json"), 1024 * 1024)?;
    let package: serde_json::Value = serde_json::from_str(&text).ok()?;
    clean_title(package["name"].as_str()?)
}

/// Text without images, link targets, HTML tags, or emphasis and code marks.
fn without_markup(text: &str) -> String {
    let rx = patterns();
    let text = rx.image.replace_all(text, "");
    let text = rx.link.replace_all(&text, "$1");
    rx.tag
        .replace_all(&text, "")
        .chars()
        .filter(|c| !matches!(c, '*' | '`'))
        .collect()
}

/// A heading as a plain name: no images, link targets, HTML tags, emphasis
/// marks or emoji, whitespace collapsed. `None` when nothing is left or it
/// looks like a secret or personal data.
fn clean_title(text: &str) -> Option<String> {
    let text: String = without_markup(text)
        .chars()
        .filter(|&c| !is_emoji(c))
        .collect();
    let title = text
        .trim()
        .trim_end_matches('#')
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    let title: String = title.chars().take(120).collect();
    let clean = secrets_scan::scan(&title).is_empty() && secrets_scan::scan_pii(&title).is_empty();
    (clean && title.chars().any(char::is_alphanumeric)).then_some(title)
}

/// The person's own names from `.myco/workstream-names.json`, read and never
/// written: `{"<key>": "<name>"}`, each name at most 80 characters and
/// cleaned and scanned like a README heading. Returns the usable names and
/// how many entries were not (1 for a file that is not a JSON object).
fn user_names(root: &Path) -> (BTreeMap<String, String>, usize) {
    let path = crate::vault_dir::dir(root).join(NAMES_FILE);
    if !path.exists() {
        return (BTreeMap::new(), 0);
    }
    // Windows editors may save it with a byte order mark, which JSON forbids.
    let Some(entries) = read_capped(&path, 1024 * 1024).and_then(|text| {
        let text = text.strip_prefix('\u{feff}').unwrap_or(&text);
        serde_json::from_str::<serde_json::Map<String, serde_json::Value>>(text).ok()
    }) else {
        return (BTreeMap::new(), 1);
    };
    let mut names = BTreeMap::new();
    let mut ignored = 0;
    for (key, value) in entries {
        let name = value
            .as_str()
            .filter(|name| name.trim().chars().count() <= MAX_NAME_CHARS)
            .and_then(clean_title);
        match name {
            // Keys are lowercase NFC, as `thread_key` makes them.
            Some(name) => {
                names.insert(crate::norm::nfc(&key.to_lowercase()).into_owned(), name);
            }
            None => ignored += 1,
        }
    }
    (names, ignored)
}

/// Words that name no project, compared lowercased (words under four letters
/// are never read): tool and vendor names, the vocabulary of agent work and
/// its reports, schedules, and English function words.
const GENERIC_WORDS: &str = "
    codex claude readme anthropic openai chatgpt github orca
    goal goals implementation review reviews manager test tests testing build builds index json
    update updates status report reports agent agents subagent task tasks user users
    session sessions transcript transcripts conversation conversations thread threads
    prompt prompts title
    daily weekly monthly nightly hourly
    this that with from have what here just only then than when they them there their about
    after before which while where would should could into also some more most very been were
    will your done please";

/// Latin words of four or more letters, from the whitespace-separated tokens
/// that are not a URL, an address or handle ('@') or a time zone
/// (`TZ=Asia/Seoul`), never a run joined to a digit ("hunter2"). Every
/// other character splits, so `NIMBUS_IMPLEMENTATION_GOAL.md` gives NIMBUS,
/// IMPLEMENTATION and GOAL.
fn latin_words(text: &str) -> impl Iterator<Item = &str> {
    text.split_whitespace()
        .filter(|token| {
            !token.contains("://") && !token.contains('@') && !patterns().zone.is_match(token)
        })
        .flat_map(|token| token.split(|c: char| !c.is_ascii_alphanumeric()))
        .filter(|word| word.len() >= 4 && word.bytes().all(|b| b.is_ascii_alphabetic()))
}

/// Per workstream and word: the conversations using it, those asking with
/// it, and the sessions they belong to.
#[derive(Default)]
struct WordUse<'a> {
    used: usize,
    asked: usize,
    sessions: BTreeSet<&'a str>,
}

/// A name for a workstream from its own conversations' request and report
/// lines: the word the most of them use, taken only when
/// - at least three use it, in at least two sessions (one session's fan of
///   sub-agents repeats whatever they were told);
/// - at least 60% of every conversation with a project that uses it is in
///   this one, and that share is at least twice this workstream's share of
///   all of them (where one project holds most conversations, any word
///   clears 60%);
/// - at least three ask with it (report prose repeats process words such as
///   "sent" or "card" as often as any name);
/// - it is used at least 1.5 times as often as each word of the key (a
///   project its conversations call by its folder name keeps that name),
///   and is no word of another workstream's key;
/// - it is not a generic word.
///
/// Shown in its most common capitalized form, else capitalized ("Nimbus"
/// for NIMBUS).
fn derived_names(conversations: &BTreeMap<String, ConversationFacts>) -> BTreeMap<String, String> {
    let mut uses: BTreeMap<&str, BTreeMap<String, WordUse>> = BTreeMap::new();
    let mut sizes: BTreeMap<&str, usize> = BTreeMap::new();
    let mut total: BTreeMap<String, usize> = BTreeMap::new();
    let mut forms: BTreeMap<String, BTreeMap<&str, usize>> = BTreeMap::new();
    let generic: BTreeSet<&str> = GENERIC_WORDS.split_whitespace().collect();
    // A program's prompt repeats its own words; a name is the person's.
    for c in conversations.values().filter(|c| !c.automated) {
        let Some(key) = c.key.as_deref() else {
            continue;
        };
        *sizes.entry(key).or_default() += 1;
        let mut words: BTreeMap<String, bool> = BTreeMap::new();
        let texts = [
            (c.request.as_deref(), true),
            (c.report.as_ref().map(|r| r.text.as_str()), false),
        ];
        for (text, asked) in texts {
            for word in latin_words(text.unwrap_or("")) {
                let lower = word.to_ascii_lowercase();
                if generic.contains(lower.as_str()) {
                    continue;
                }
                *forms
                    .entry(lower.clone())
                    .or_default()
                    .entry(word)
                    .or_default() += 1;
                *words.entry(lower).or_default() |= asked;
            }
        }
        let counts = uses.entry(key).or_default();
        for (word, asked) in words {
            *total.entry(word.clone()).or_default() += 1;
            let count = counts.entry(word).or_default();
            count.used += 1;
            count.asked += usize::from(asked);
            count.sessions.insert(c.root.as_str());
        }
    }
    let key_words = |key: &str| {
        key.split(|c: char| !c.is_ascii_alphabetic())
            .map(str::to_ascii_lowercase)
            .collect::<Vec<_>>()
    };
    let assigned: usize = sizes.values().sum();
    let mut names = BTreeMap::new();
    for (key, counts) in &uses {
        // Most conversations, then the larger share, then the word.
        let Some((word, top)) = counts.iter().min_by_key(|(word, count)| {
            (std::cmp::Reverse(count.used), total[word.as_str()], *word)
        }) else {
            continue;
        };
        let used = top.used;
        let key_use = key_words(key)
            .iter()
            .filter_map(|part| counts.get(part))
            .map(|count| count.used)
            .max()
            .unwrap_or(0);
        let others_key = uses
            .keys()
            .any(|other| other != key && key_words(other).contains(word));
        if used < 3
            || top.sessions.len() < 2
            || used * 5 < total[word] * 3
            || used * assigned < 2 * sizes[key] * total[word]
            || top.asked < 3
            || used * 2 < key_use * 3
            || others_key
        {
            continue;
        }
        let shown = forms[word]
            .iter()
            .filter(|(form, _)| {
                form.starts_with(|c: char| c.is_ascii_uppercase())
                    && form.contains(|c: char| c.is_ascii_lowercase())
            })
            .max_by(|a, b| a.1.cmp(b.1).then_with(|| b.0.cmp(a.0)))
            .map(|(form, _)| form.to_string())
            .unwrap_or_else(|| word[..1].to_ascii_uppercase() + &word[1..]);
        names.insert(key.to_string(), shown);
    }
    names
}

fn is_emoji(c: char) -> bool {
    matches!(
        u32::from(c),
        0x1F000..=0x1FAFF | 0x2600..=0x27BF | 0x2B00..=0x2BFF | 0xFE00..=0xFE0F
            | 0x200D | 0x20E3 | 0xE0020..=0xE007F
    )
}

// ---- Codex stores -----------------------------------------------------------

/// Codex's own records of a thread, read only and lazily: nothing is opened
/// until a Codex conversation needs a working folder.
struct CodexStores<'a> {
    homes: &'a [PathBuf],
    states: Option<Vec<rusqlite::Connection>>,
    rollouts: Option<BTreeMap<String, PathBuf>>,
    failures: usize,
}

impl<'a> CodexStores<'a> {
    fn new(homes: &'a [PathBuf]) -> Self {
        Self {
            homes,
            states: None,
            rollouts: None,
            failures: 0,
        }
    }

    /// A thread's working folder: `threads.cwd` in the first home whose state
    /// store has the thread, else its rollout's first-line session_meta.
    fn cwd(&mut self, id: &str) -> Option<(String, CwdSource)> {
        let homes = self.homes;
        let failures = &mut self.failures;
        let states = self
            .states
            .get_or_insert_with(|| open_states(homes, failures));
        for state in states.iter() {
            let row = state.query_row("SELECT cwd FROM threads WHERE id = ?1", [id], |row| {
                row.get::<_, Option<String>>(0)
            });
            match row {
                Ok(Some(cwd)) if !cwd.trim().is_empty() => return Some((cwd, CwdSource::State)),
                Ok(_) | Err(rusqlite::Error::QueryReturnedNoRows) => {}
                Err(_) => *failures += 1,
            }
        }
        let rollouts = self.rollouts.get_or_insert_with(|| rollout_index(homes));
        Some((rollout_cwd(rollouts.get(id)?)?, CwdSource::Rollout))
    }
}

fn open_states(homes: &[PathBuf], failures: &mut usize) -> Vec<rusqlite::Connection> {
    let mut states = Vec::new();
    for path in homes.iter().map(|home| home.join("state_5.sqlite")) {
        if !path.is_file() {
            continue;
        }
        match open_immutable(&path) {
            Ok(state) => states.push(state),
            Err(_) => *failures += 1,
        }
    }
    states
}

/// `mode=ro&immutable=1`: no lock is taken and no -wal or -shm file is created
/// beside Codex's store. Rows that sit only in an uncheckpointed -wal are not
/// seen; a fresh thread's rollout still answers for it.
fn open_immutable(path: &Path) -> Result<rusqlite::Connection, String> {
    use rusqlite::OpenFlags;
    let url = url::Url::from_file_path(path).map_err(|_| "state store path is not absolute")?;
    let state = rusqlite::Connection::open_with_flags(
        format!("{url}?mode=ro&immutable=1"),
        OpenFlags::SQLITE_OPEN_READ_ONLY
            | OpenFlags::SQLITE_OPEN_URI
            | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|error| error.to_string())?;
    // Reading the schema now turns an unreadable store into one counted failure.
    state
        .prepare("SELECT cwd FROM threads WHERE id = ?1")
        .map_err(|error| error.to_string())?;
    Ok(state)
}

/// Rollout files by thread id over every home's `sessions/` (`.jsonl` only;
/// `.zst` is out of scope). The first home wins an id, so a file hardlinked
/// into several homes (Orca links ~/.codex sessions) is read once.
fn rollout_index(homes: &[PathBuf]) -> BTreeMap<String, PathBuf> {
    fn collect(dir: &Path, out: &mut Vec<PathBuf>, depth: u32) {
        let Ok(entries) = std::fs::read_dir(dir) else {
            return;
        };
        for entry in entries.flatten() {
            let Ok(kind) = entry.file_type() else {
                continue;
            };
            let path = entry.path();
            if kind.is_dir() && depth < 8 && !entry.file_name().to_string_lossy().starts_with('.') {
                collect(&path, out, depth + 1);
            } else if kind.is_file() && path.extension().is_some_and(|ext| ext == "jsonl") {
                out.push(path);
            }
        }
    }
    let mut index = BTreeMap::new();
    for home in homes {
        let mut files = Vec::new();
        collect(&home.join("sessions"), &mut files, 0);
        files.sort();
        for path in files {
            let id = path
                .file_stem()
                .and_then(|stem| stem.to_str())
                .and_then(|stem| stem.get(stem.len().checked_sub(36)?..))
                .filter(|id| is_uuid(id))
                .map(str::to_string);
            if let Some(id) = id {
                index.entry(id).or_insert(path);
            }
        }
    }
    index
}

fn is_uuid(id: &str) -> bool {
    id.len() == 36
        && id.char_indices().all(|(at, c)| match at {
            8 | 13 | 18 | 23 => c == '-',
            _ => c.is_ascii_hexdigit(),
        })
}

fn rollout_cwd(path: &Path) -> Option<String> {
    #[derive(Deserialize)]
    struct Line {
        #[serde(rename = "type")]
        kind: Option<String>,
        payload: Option<Meta>,
    }
    #[derive(Deserialize)]
    struct Meta {
        cwd: Option<String>,
    }
    let line: Line = serde_json::from_slice(&first_line(path)?).ok()?;
    if line.kind.as_deref() != Some("session_meta") {
        return None;
    }
    line.payload?.cwd.filter(|cwd| !cwd.trim().is_empty())
}

// ---- page -------------------------------------------------------------------

/// Local calendar date of a unix time by this machine's zone rules at that
/// instant, so work at 01:09 KST is not filed under the UTC day before.
fn local_date(epoch: i64) -> String {
    let (year, month, day, ..) = crate::distill::civil_datetime(epoch + utc_offset(epoch));
    format!("{year:04}-{month:02}-{day:02}")
}

#[cfg(unix)]
fn utc_offset(epoch: i64) -> i64 {
    // time_t is 64-bit on every unix target the app ships.
    let time = epoch as libc::time_t;
    // SAFETY: localtime_r only writes the zeroed `tm` we own; both pointers
    // are valid for the duration of the call.
    let mut tm: libc::tm = unsafe { std::mem::zeroed() };
    if unsafe { libc::localtime_r(&time, &mut tm) }.is_null() {
        return 0;
    }
    tm.tm_gmtoff
}

#[cfg(not(unix))]
fn utc_offset(_epoch: i64) -> i64 {
    0
}

/// Markdown-inert text: escapes what could start a link, emphasis, code or an
/// HTML comment (the `plainMarkdown` rule of sessionEvidence.ts). A markdown
/// escape the transcript already holds (`START\_HERE`) is undone first, so
/// it does not show as a backslash.
fn plain(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(mut c) = chars.next() {
        if c == '\\' {
            if let Some(escaped) = chars.next_if(char::is_ascii_punctuation) {
                c = escaped;
            }
        }
        if matches!(c, '\\' | '`' | '*' | '_' | '[' | ']' | '<' | '>') {
            out.push('\\');
        }
        out.push(c);
    }
    out
}

/// The whole page, rewritten whole while its marker block stays. No clock is
/// read, so the same facts render the same bytes. It holds only dates, the
/// conversations' own words and links: the app's UI language is not known
/// here, and Ask states the counts in that language from the facts.
/// One row per root session with a request or a report, newest first:
/// `- date · request → report [[raw]]`, the request and report taken as Ask
/// takes them (without its preference for the UI language), the link at the
/// transcript the report was read from, else at the session's newest
/// conversation. Automated sessions get no row, only one count line, which
/// names them in English, Korean and Japanese.
fn render_page(
    key: &str,
    workstream: &WorkstreamFacts,
    all: &BTreeMap<String, ConversationFacts>,
) -> String {
    let automated = all
        .values()
        .filter(|c| c.key.as_deref() == Some(key) && c.automated)
        .map(|c| c.root.as_str())
        .collect::<BTreeSet<_>>();
    let mut rows = Vec::new();
    for (newest, _, group) in &sessions(key, all) {
        // What the person asked last: their own thread's latest request,
        // else the latest a sub-agent was given (the thread may not be here).
        let request = group
            .iter()
            .filter_map(|(id, c)| {
                let request = c
                    .request
                    .as_deref()
                    .filter(|text| !text.trim().is_empty())?;
                Some((!c.subagent, c.first_epoch, *id, request))
            })
            .max()
            .map(|(.., request)| request);
        let report = session_report(group);
        let source = report
            .map(|(_, c, _)| c)
            .or_else(|| {
                group
                    .iter()
                    .max_by_key(|(id, c)| (c.last_epoch, *id))
                    .map(|(_, c)| *c)
            })
            .unwrap_or(group[0].1);
        let reported = report.map(|(.., report)| report);
        let said = match (request, reported) {
            (Some(request), Some(report)) => {
                format!(" · {} → {}", plain(request), plain(&report.text))
            }
            (Some(request), None) => format!(" · {}", plain(request)),
            (None, Some(report)) => format!(" · → {}", plain(&report.text)),
            // Nothing to show (a helper session that only named a branch),
            // as Ask leaves it out.
            (None, None) => continue,
        };
        rows.push(format!(
            "- {}{said} [[{}]]\n",
            local_date(*newest),
            source.raw.trim_end_matches(".md"),
        ));
    }
    // JSON escapes keep a key containing "-->" from closing the comment.
    let marker = serde_json::json!({ "key": key })
        .to_string()
        .replace('<', "\\u003c")
        .replace('>', "\\u003e")
        .replace('&', "\\u0026");
    let (first, last) = (
        local_date(workstream.first_epoch),
        local_date(workstream.last_epoch),
    );
    let span = if first == last {
        first
    } else {
        format!("{first} – {last}")
    };
    let mut page = format!(
        "---\ntitle: {}\ntype: overview\nworkstream_key: {}\n---\n\n# {}\n\n{MARKER_OPEN}{marker} -->\n{span}\n\n",
        serde_json::json!(workstream.title),
        serde_json::json!(key),
        plain(&workstream.title),
    );
    for line in rows {
        page.push_str(&line);
    }
    if !automated.is_empty() {
        page.push_str(&format!("\n{AUTOMATED_LABEL}: {}\n", automated.len()));
    }
    page.push_str(&format!("\n{MARKER_CLOSE}\n"));
    page
}

/// The page's count of automated sessions; the page has no UI language.
const AUTOMATED_LABEL: &str = "Automated sessions · 자동 실행 세션 · 自動実行セッション";

#[cfg(test)]
pub(crate) mod fixtures {
    use std::path::{Path, PathBuf};

    /// Enough distinct text to clear the importer's spoken-text floor.
    fn filler(seed: &str) -> String {
        format!("The {seed} fixture keeps this synthetic workstream above the import floor. ")
            .repeat(14)
    }

    pub(crate) fn claude_session(id: &str, cwd: &str, request: &str, report: &str) -> String {
        [
            serde_json::json!({"type":"user","uuid":format!("{id}-u"),"sessionId":id,"cwd":cwd,
                "timestamp":"2026-10-09T12:00:00Z",
                "message":{"role":"user","content":format!("{request}\n\n{}", filler(id))}}),
            serde_json::json!({"type":"assistant","uuid":format!("{id}-a"),"sessionId":id,"cwd":cwd,
                "timestamp":"2026-10-09T12:05:00Z",
                "message":{"role":"assistant","stop_reason":"end_turn",
                    "content":[{"type":"text","text":report}]}}),
        ]
        .map(|record| record.to_string())
        .join("\n")
    }

    pub(crate) fn codex_rollout(
        id: &str,
        cwd: &str,
        parent: Option<&str>,
        request: &str,
        report: &str,
    ) -> String {
        [
            serde_json::json!({"timestamp":"2026-10-10T09:00:00Z","type":"session_meta",
                "payload":{"id":id,"cwd":cwd,"source":"cli","parent_thread_id":parent,
                    "thread_source":if parent.is_some() { "subagent" } else { "user" }}}),
            serde_json::json!({"timestamp":"2026-10-10T09:00:00Z","type":"response_item",
                "payload":{"type":"message","role":"user",
                    "content":[{"type":"input_text","text":format!("{request}\n\n{}", filler(id))}]}}),
            serde_json::json!({"timestamp":"2026-10-10T09:30:00Z","type":"response_item",
                "payload":{"type":"message","role":"assistant","phase":"final_answer",
                    "content":[{"type":"output_text","text":report}]}}),
        ]
        .map(|record| record.to_string())
        .join("\n")
    }

    /// Put a rollout where a Codex home keeps it.
    pub(crate) fn write_rollout(home: &Path, id: &str, body: &str) -> PathBuf {
        let dir = home.join("sessions/2026/10/10");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(format!("rollout-2026-10-10T09-00-00-{id}.jsonl"));
        std::fs::write(&path, body).unwrap();
        path
    }
}

#[cfg(test)]
mod tests {
    use super::fixtures::*;
    use super::*;

    const CODEX_A: &str = "00000000-0000-4000-8000-00000000000a";
    const CODEX_B: &str = "00000000-0000-4000-8000-00000000000b";

    #[test]
    fn thread_key_matches_the_p0_table() {
        let t = |cwd: &str| thread_key(cwd);
        assert_eq!(
            t("/Users/someone/project/Memex/app/src/").as_deref(),
            Some("memex")
        );
        assert_eq!(
            t("~/orca/workspaces/prj_nimbus/harbor").as_deref(),
            Some("prj_nimbus")
        );
        assert_eq!(
            t("/Users/a/orca/projects/kiteMap/.claude/worktrees/kitemap-v1").as_deref(),
            Some("kitemap")
        );
        assert_eq!(
            t("/Users/a/project/harbor-run/.claude/worktrees/brave-x/harbor-run/app").as_deref(),
            Some("harbor-run")
        );
        assert_eq!(
            t("/Users/a/.codex/worktrees/abcd/Foo/src").as_deref(),
            Some("foo")
        );
        assert_eq!(t("/Users/a/project/Foo-worktree-2").as_deref(), Some("foo"));
        assert_eq!(t("/Users/a").as_deref(), Some("(home)"));
        assert_eq!(t("/Users/a/").as_deref(), Some("(home)"));
        assert_eq!(t("/private/tmp/x").as_deref(), Some("(tmp)"));
        assert_eq!(t("/var/folders/ab/T/x").as_deref(), Some("(tmp)"));
        assert_eq!(t("/Users/a/kiln/glaze").as_deref(), Some("kiln"));
        assert_eq!(
            t("/Users/a/Documents/Codex/2026-11-02/new-chat").as_deref(),
            Some("(codex-chat)")
        );
        assert_eq!(
            t("/Users/a/Library/Application Support/X").as_deref(),
            Some("(app-data)")
        );
        assert_eq!(t("/Users/a/.claude/x").as_deref(), Some("(tool-config)"));
        assert_eq!(t("/Users/a/projects").as_deref(), Some("(container)"));
        assert_eq!(t("/Users/a/worktrees/x").as_deref(), Some("(home)"));
        assert_eq!(t("/opt/x").as_deref(), Some("(outside-home)"));
        assert_eq!(t("/root/Repos/Alpha").as_deref(), Some("alpha"));
        assert_eq!(t("C:\\Users\\a\\GitHub\\Beta").as_deref(), Some("beta"));
        assert_eq!(
            t("C:\\Users\\a\\AppData\\Local\\Temp\\x").as_deref(),
            Some("(app-data)")
        );
        assert_eq!(t("D:\\work\\x").as_deref(), Some("(outside-home)"));
        assert_eq!(t("/home/a//Documents/Gamma/").as_deref(), Some("gamma"));
        // One folder written NFD (as some tools report macOS names) and NFC.
        let nfd: String = "노트"
            .chars()
            .flat_map(|c| {
                use unicode_normalization::UnicodeNormalization;
                std::iter::once(c).nfd().collect::<Vec<_>>()
            })
            .collect();
        assert_ne!(nfd, "노트");
        assert_eq!(
            t(&format!("/Users/a/projects/{nfd}")).as_deref(),
            Some("노트")
        );
        assert_eq!(t(""), None);
        assert_eq!(t("   "), None);
    }

    #[test]
    fn page_names_are_safe_files_and_wikilink_targets() {
        assert_eq!(page_name("prj_nimbus"), "prj_nimbus");
        assert_eq!(page_name("노트"), "노트");
        let hash = |key: &str| crate::importers::ledger::fingerprint(key)[..8].to_string();
        assert_eq!(
            page_name("foo [old]"),
            format!("foo -old--{}", hash("foo [old]"))
        );
        assert_eq!(page_name("c#"), format!("c--{}", hash("c#")));
        assert_eq!(page_name("a|b"), format!("a-b-{}", hash("a|b")));
        assert_eq!(
            page_name(".dotfiles"),
            format!("-dotfiles-{}", hash(".dotfiles"))
        );
        assert_eq!(page_name("x^y"), format!("x-y-{}", hash("x^y")));
        assert_eq!(
            page_name("tab\there"),
            format!("tab-here-{}", hash("tab\there"))
        );
        assert_eq!(page_name("end."), format!("end.-{}", hash("end.")));
        assert_ne!(
            page_name("a|b"),
            page_name("a*b"),
            "two keys never share a page"
        );
        let long = "가".repeat(100);
        let name = page_name(&long);
        assert!(name.len() <= 140 && name.ends_with(&hash(&long)), "{name}");
        for key in ["foo [old]", "c#", "a|b", ".dotfiles", &long] {
            let name = page_name(key);
            assert!(!name.starts_with('.'));
            assert!(!name.contains(['[', ']', '|', '#', '^', '/', '\\', ':']));
        }
    }

    #[test]
    fn majority_ties_and_non_project_winners_assign_nothing() {
        let votes = |pairs: &[(&str, usize)]| {
            pairs
                .iter()
                .map(|(key, n)| (key.to_string(), *n))
                .collect::<BTreeMap<_, _>>()
        };
        assert_eq!(majority(&votes(&[("a", 3), ("b", 3)])), None);
        assert_eq!(
            majority(&votes(&[("a", 4), ("(home)", 3)])).as_deref(),
            Some("a")
        );
        assert_eq!(majority(&votes(&[("(home)", 4), ("a", 3)])), None);
        assert_eq!(majority(&votes(&[])), None);
    }

    #[test]
    fn root_follows_parents_past_the_vault_and_a_cycle_still_ends() {
        // "m" and "far" are parents no imported thread is: their own parents
        // are unknown, so the chain ends there.
        let links = BTreeMap::from([
            ("c", "b"),
            ("b", "a"),
            ("x", "y"),
            ("y", "x"),
            ("s1", "m"),
            ("s2", "m"),
            ("s3", "s2"),
            ("t", "far"),
        ]);
        let parent = |key: &str| links.get(key).map(|p| p.to_string());
        assert_eq!(root_of("c", parent), "a");
        assert_eq!(root_of("a", parent), "a");
        assert_eq!(root_of("x", parent), "x");
        assert_eq!(root_of("y", parent), "x", "every cycle member agrees");
        for sibling in ["s1", "s2", "s3"] {
            assert_eq!(
                root_of(sibling, parent),
                "m",
                "{sibling} shares the missing parent"
            );
        }
        assert_eq!(root_of("t", parent), "far");
        let own = BTreeMap::from([("b", Some("proj".to_string()))]);
        let inherit = |key| inherited_key(key, parent, |at| own.get(at).cloned());
        assert_eq!(inherit("c"), Some(Some("proj".into())));
        assert_eq!(inherit("b"), None, "a has no own folder");
        assert_eq!(inherit("x"), None);
    }

    #[test]
    fn a_teammate_names_its_team_and_the_team_its_lead() {
        let record = |fields: serde_json::Value| fields.to_string().into_bytes();
        let teammate = record(
            serde_json::json!({"type":"user","teamName":"session-0a1b2c3d","agentName":"checker"}),
        );
        assert_eq!(team_of(&teammate).as_deref(), Some("session-0a1b2c3d"));
        // A lead's records name no agent, other sessions' no team.
        assert_eq!(
            team_of(&record(serde_json::json!({"teamName":"session-0a1b2c3d"}))),
            None
        );
        assert_eq!(team_of(&record(serde_json::json!({"cwd":"/x"}))), None);
        assert_eq!(team_of(b"not json"), None);
        let all: BTreeMap<String, ConversationFacts> = [
            "0a1b2c3d-0000-4000-8000-000000000001",
            "ffff0000-0000-4000-8000-000000000002",
            "ffff0000-0000-4000-8000-000000000003",
        ]
        .iter()
        .map(|id| {
            (
                format!("claude-code:{id}"),
                fact(id, Some("alpha"), None, None),
            )
        })
        .collect();
        assert_eq!(
            team_lead("claude-code:session-0a1b2c3d", &all).as_deref(),
            Some("claude-code:0a1b2c3d-0000-4000-8000-000000000001")
        );
        // Two sessions start alike, none does, or the team has another name:
        // the team keeps its own key.
        for team in [
            "claude-code:session-ffff0000",
            "claude-code:session-12345678",
            "claude-code:session-",
            "claude-code:review-team",
            "codex:0a1b2c3d",
        ] {
            assert_eq!(team_lead(team, &all), None, "{team}");
        }
    }

    #[test]
    fn teammates_join_their_leads_session_on_every_pass() {
        let vault = tempfile::tempdir().unwrap();
        set_test_codex_homes(Vec::new());
        let root = vault.path().canonicalize().unwrap();
        let cwd = "/Users/synthetic/projects/alpha";
        let times = "created: 1793066400\nlast_activity: 1793070000";
        let said = |text: &str, extra: serde_json::Value| {
            let mut first = serde_json::json!({"type":"user","cwd":cwd,"message":{"role":"user","content":"x"}});
            first
                .as_object_mut()
                .unwrap()
                .extend(extra.as_object().unwrap().clone());
            [
                first,
                serde_json::json!({"type":"assistant","cwd":cwd,"timestamp":"2026-10-27T03:00:00Z",
                    "message":{"stop_reason":"end_turn","content":[{"type":"text","text":text}]}}),
            ]
        };
        let lead = "claude-code:0a1b2c3d-0000-4000-8000-000000000001";
        let mut ledger = Ledger::load(&root).unwrap();
        seed(
            &root,
            lead,
            "0000000000000001",
            times,
            "Plan the alpha release",
            &said("Release planned", serde_json::json!({})),
        );
        ledger.record(lead.into(), "0000000000000001".into());
        let members = [
            (
                "claude-code:eeee0002-0000-4000-8000-000000000002",
                "session-0a1b2c3d",
            ),
            (
                "claude-code:eeee0003-0000-4000-8000-000000000003",
                "session-0a1b2c3d",
            ),
            (
                "claude-code:eeee0004-0000-4000-8000-000000000004",
                "session-99999999",
            ),
        ];
        for (n, (key, team)) in members.iter().enumerate() {
            let fp = format!("{:016x}", n + 2);
            seed(
                &root,
                key,
                &fp,
                times,
                "<teammate-message teammate_id=\"team-lead\">Check the build</teammate-message>",
                &said(
                    "Build checked",
                    serde_json::json!({"teamName":team,"agentName":"checker"}),
                ),
            );
            ledger.record(key.to_string(), fp);
        }
        ledger.save(&root).unwrap();
        assert!(reconcile(&root) > 0);
        let facts = facts(&root);
        let conversation = |key: &str| &facts["conversations"][key];
        assert_eq!(conversation(lead)["subagent"], false);
        assert_eq!(conversation(lead)["root"], lead);
        for (key, _) in &members[..2] {
            assert_eq!(conversation(key)["subagent"], true);
            assert_eq!(conversation(key)["root"], lead);
            assert_eq!(conversation(key)["request"], serde_json::Value::Null);
        }
        // Its lead was never imported: the team is the session.
        assert_eq!(
            conversation(members[2].0)["root"],
            "claude-code:session-99999999"
        );
        assert_eq!(facts["workstreams"]["alpha"]["roots"], 2);
        let page = std::fs::read_to_string(root.join("wiki/workstreams/alpha.md")).unwrap();
        assert!(
            page.contains(" · Plan the alpha release → Release planned [[raw/conversations/claude-code/claude-code-0a1b2c3d-"),
            "{page}"
        );
        // A later pass reads each teammate's team back from its sidecar.
        let before = snapshot(&root);
        assert_eq!(reconcile(&root), 0);
        assert_eq!(snapshot(&root), before);
    }

    #[test]
    fn hints_take_one_clean_line_without_harness() {
        assert_eq!(hint_line("\n## Ship it\nmore").as_deref(), Some("Ship it"));
        assert_eq!(
            hint_line("---\n- [x]   done  well").as_deref(),
            Some("[x] done well")
        );
        let long = "가".repeat(300);
        assert_eq!(hint_line(&long).unwrap().chars().count(), HINT_CHARS);
        assert_eq!(hint_line("mail me at someone@example.com"), None);
        assert_eq!(hint_line("key sk-abcdefghijklmnopqrstuvwxyz012345"), None);
        assert_eq!(hint_line("***"), None);
        assert_eq!(
            hint_line("```text\n**Done.** Tests pass.").as_deref(),
            Some("Done. Tests pass.")
        );
        // The account name in a home path never reaches the facts.
        assert_eq!(
            hint_line("Run it in /Users/someone/project/x and /home/other/y").as_deref(),
            Some("Run it in ~/project/x and ~/y")
        );
        assert_eq!(
            hint_line("Open C:\\Users\\someone\\GitHub\\z").as_deref(),
            Some("Open ~\\GitHub\\z")
        );
        let turns = [
            "<system-reminder>machine</system-reminder>",
            "This session is being continued from a previous conversation that ran out.",
            "<codex_internal_context source=\"goal\">\n<objective>\nShip the reader\n</objective>\n</codex_internal_context>",
            "# /loop 5m check",
            "<command-name>/clear</command-name>\nFix the importer please",
        ];
        assert_eq!(
            request_hint(&turns).as_deref(),
            Some("Fix the importer please")
        );
        assert_eq!(
            request_hint(&turns[..4]).as_deref(),
            Some("Ship the reader")
        );
        assert_eq!(request_hint(&turns[..2]), None);
        // `/goal` wraps what the person typed in its own sentence.
        let goal = format!(
            "{GOAL_OPENING}Ship \"the\" reader. Then polish it\nwith tests\". Briefly acknowledge the goal, \
             then immediately start (or continue) working toward it."
        );
        assert_eq!(
            human_text(&goal),
            "Ship \"the\" reader. Then polish it\nwith tests"
        );
        assert_eq!(
            request_hint(&[goal.as_str()]).as_deref(),
            Some("Ship \"the\" reader. Then polish it")
        );
        // A helper session naming a branch after another session's request.
        let helper = "Generate a short git branch name that summarizes the coding task described below.\n\
                      Output ONLY the branch name on a single line, nothing else.\n\nUser request:\nShip it";
        assert_eq!(request_hint(&[helper]), None);
        // Attachment placeholders are the harness's, not the person's words.
        assert_eq!(
            request_hint(&["Is it right? [Image #1] [Pasted text #2 +12 lines] Still odd"])
                .as_deref(),
            Some("Is it right? Still odd")
        );
        assert_eq!(
            request_hint(&["[Image #1]\n[Image #2]", "[Pasted text #1] Ship it"]).as_deref(),
            Some("Ship it")
        );
        assert_eq!(
            request_hint(&["[Image #1] [Pasted text #3 +40 lines]"]),
            None
        );
    }

    #[test]
    fn a_programs_prompt_marks_its_conversation_automated() {
        for prompt in [
            "당신은 Synthetic Control Center 대시보드 v6.18.0 의 안내 도우미입니다. 질문에 답하세요.",
            "Translate each skill description below into concise 한국어 (one line).",
            "Summarize the following notes.",
            "Generate a short title for this conversation.",
            "You are a software architect. Produce ONE JSON object.",
            "You just finished task \"Greet the team\" (id t_1). Here is the result.",
            "너는 스프린트를 이끄는 테크 리드다. 다음 스프린트를 계획해.",
            "다음은 오늘 수집한 트렌드 글 목록이다(소스별). 뉴스레터로 묶어라.",
            "{\n  \"topic\": \"Synthetic topic\",\n  \"research\": \"Three facts\",\n  \"panels\": 4\n}",
            "[{\"title\": \"Headline\", \"source\": \"Synthetic\"}]",
            "주제: 합성 주제\nresearch: 세 가지 사실\nimages: [a, b]\nsource: synthetic\nformat: A",
            // A template whose `research:` value runs over several bullet lines.
            "주제: 합성 주제\nresearch:\n- 첫째\n- 둘째\n- 셋째\n- 넷째\n- 다섯째\nimages: a\nsource: synthetic",
        ] {
            assert!(is_automated(prompt), "{prompt}");
        }
        for request in [
            // The person gives roles and points at things in speech style.
            "너는 지금부터 인테리어 인플루언서야. 이미지 기획을 도와줘.",
            "다음은 뭐 해야 해?",
            "다음은 로그인 화면 고쳐줘.",
            "당신은 누구입니까?",
            "You are right, the test still fails. Fix it.",
            "You're the best. Ship it.",
            "Translate this README into Korean.",
            // Some JSON, then the question that is most of the request.
            "{\"a\": 1} 이 응답이 왜 이렇게 오는지 확인하고 원인을 찾아서 고쳐줘. 로그도 같이 봐줘.",
            "[Image #1] 이런 거 안 뜨게 해줘",
            "Error: Cannot find module 'x'\n    at load (/x.js:1)\n이거 왜 그래?",
            "v6.18.0 에서 대시보드가 안 열린다. 확인해줘.",
            // Polite speech after "다음은", and a single field-like line.
            "다음은 빌드 에러 로그입니다.\nerror: x\n원인을 찾아 주세요.",
            "주제: 오늘 회의 정리해줘",
        ] {
            assert!(!is_automated(request), "{request}");
        }
        assert_eq!(
            first_sentence("다음은 목록이다(소스별). 그다음"),
            "다음은 목록이다"
        );
        assert_eq!(
            first_sentence("v6.18.0 의 도우미입니다. 끝"),
            "v6.18.0 의 도우미입니다"
        );
    }

    #[test]
    fn reports_skip_copies_from_a_fork_and_unfinished_turns() {
        let codex = [
            serde_json::json!({"timestamp":"2026-10-10T09:30:00Z","type":"response_item",
                "payload":{"type":"message","role":"assistant","phase":"final_answer",
                    "content":[{"type":"output_text","text":"Own answer"}]}}),
            serde_json::json!({"timestamp":"2026-10-10T09:40:00Z","type":"response_item",
                "payload":{"type":"message","role":"assistant","phase":"final_answer",
                    "content":[{"type":"output_text","text":"Copied answer"}]},
                "metadata":{"inherited_user_message":true}}),
            serde_json::json!({"timestamp":"2026-10-10T09:50:00Z","type":"response_item",
                "payload":{"type":"message","role":"assistant","phase":"commentary",
                    "content":[{"type":"output_text","text":"Still working"}]}}),
        ]
        .map(|record| record.to_string())
        .join("\n");
        let scan = scan_sidecar(&codex, true);
        let report = report_from(scan.report.unwrap(), true, 0).unwrap();
        assert_eq!(report.text, "Own answer");
        assert_eq!(
            report.epoch,
            crate::importers::parse_iso8601("2026-10-10T09:30:00Z").unwrap()
        );
        // The copy is kept apart: what came back in the thread it forked from.
        let copied = report_from(scan.copied.unwrap(), true, 0).unwrap();
        assert_eq!(copied.text, "Copied answer");
        let claude = [
            serde_json::json!({"type":"assistant","cwd":"/Users/a/projects/alpha","timestamp":"2026-10-09T12:05:00Z",
                "message":{"stop_reason":"end_turn","content":[{"type":"text","text":"## Done\nAll green"}]}}),
            serde_json::json!({"type":"assistant","cwd":"/Users/a/projects/alpha",
                "message":{"stop_reason":"tool_use","content":[{"type":"text","text":"Running"}]}}),
        ]
        .map(|record| record.to_string())
        .join("\n");
        let scan = scan_sidecar(&claude, false);
        assert_eq!(
            report_from(scan.report.unwrap(), false, 0).unwrap().text,
            "All green"
        );
        assert_eq!(scan.votes.get("alpha"), Some(&2));
        assert_eq!(report_from("{\"payload\":{}}", true, 0), None);
        // A timestamp before 1970 falls back to the conversation's own time.
        let early = serde_json::json!({"timestamp":"1969-12-31T23:00:00Z",
            "message":{"stop_reason":"end_turn","content":"Shipped"}});
        assert_eq!(report_from(&early.to_string(), false, 7).unwrap().epoch, 7);
    }

    #[test]
    fn a_report_reads_from_its_most_telling_line() {
        let line = |text: &str| report_line(text);
        assert_eq!(
            line("완료했습니다.\n\n- 로그인 버그를 고쳤습니다\n- 테스트 통과").as_deref(),
            Some("로그인 버그를 고쳤습니다")
        );
        assert_eq!(
            line("## 디자인 전후\n버튼 간격을 8px로 맞췄습니다.").as_deref(),
            Some("버튼 간격을 8px로 맞췄습니다.")
        );
        assert_eq!(
            line(
                "OK — 이미 재현 가능:\n```sh\nnpm run demo\n```\n데모 절차를 README에 적었습니다."
            )
            .as_deref(),
            Some("데모 절차를 README에 적었습니다.")
        );
        assert_eq!(
            line("**Summary**\nDone!\n\nThe importer keeps cwd now.").as_deref(),
            Some("The importer keeps cwd now.")
        );
        assert_eq!(
            line("**Done.** Tests pass.").as_deref(),
            Some("Done. Tests pass.")
        );
        // Not a heading, so it is the line (hint_line drops leading '#'s).
        assert_eq!(line("#123 is fixed\nmore").as_deref(), Some("123 is fixed"));
        // Nothing more telling: the first line stays.
        assert_eq!(line("완료했습니다.").as_deref(), Some("완료했습니다."));
        assert_eq!(line("## Done\n\n```\nlog\n```").as_deref(), Some("Done"));
        assert_eq!(line("```\nonly code\n```"), None);
        // A table row says nothing on its own.
        assert_eq!(
            line("| Step | Time |\n|---|---|\n| Build | 2m |\n\nBuilt in two minutes.").as_deref(),
            Some("Built in two minutes.")
        );
        // The chosen line is still checked for secrets.
        assert_eq!(line("Done.\nmail someone@example.com"), None);
        // JSON, whole or in part, is never the line, not even the fallback.
        assert_eq!(line("{\"goalMet\": true, \"summary\": \"Done\"}"), None);
        assert_eq!(
            line("{\"translations\": {\n\"a\": \"가\",\n\"b\": \"나\"\n}}"),
            None
        );
        assert_eq!(
            line("[\"street\", \"crowd\"]\n번역을 마쳤습니다.").as_deref(),
            Some("번역을 마쳤습니다.")
        );
        // Elements of a longer list, each on its own line.
        assert_eq!(
            line("[\n  [\"headline\", \"subhead\"],\n  {\"panel\": 2},\n]"),
            None
        );
        assert_eq!(
            line("\"worldTitle\": {\n## Summary\nTitles translated.").as_deref(),
            Some("Titles translated.")
        );
        // A link that opens a line is not JSON.
        assert_eq!(
            line("[README.md](~/x/README.md) lists the steps.").as_deref(),
            Some("[README.md](~/x/README.md) lists the steps.")
        );
    }

    #[test]
    fn transcripts_read_like_the_importer_wrote_them() {
        let rollout = codex_rollout(
            CODEX_B,
            "/Users/a/projects/beta",
            Some(CODEX_A),
            "Port it",
            "Ported",
        );
        let doc = crate::importers::detect_and_parse("rollout.jsonl", &rollout).unwrap()[0]
            .to_inbox_doc();
        let transcript = parse_transcript(&doc);
        assert_eq!(transcript.parent.as_deref(), Some(CODEX_A));
        assert!(transcript.created.is_some() && transcript.last_activity.is_some());
        assert_eq!(transcript.user_turns.len(), 1);
        assert!(transcript.user_turns[0].starts_with("Port it\n\n"));
        let vault = tempfile::tempdir().unwrap();
        let path = vault.path().join("doc.md");
        std::fs::write(&path, &doc).unwrap();
        assert_eq!(read_parent(&path).as_deref(), Some(CODEX_A));
        // A first turn longer than the head is read whole.
        let wide = doc.replacen(
            "\"thread_source\"",
            &format!("\"pad\":\"{}\",\"thread_source\"", "x".repeat(20_000)),
            1,
        );
        std::fs::write(&path, wide).unwrap();
        assert_eq!(read_parent(&path).as_deref(), Some(CODEX_A));
    }

    #[test]
    fn display_names_come_from_readme_then_package_up_to_home() {
        let home = tempfile::tempdir().unwrap();
        let repo = home.path().join("projects/alpha");
        let cwd = repo.join("app/src");
        std::fs::create_dir_all(&cwd).unwrap();
        std::fs::write(repo.join("app/package.json"), r#"{"name":"alpha-app"}"#).unwrap();
        assert_eq!(
            display_name_under(&cwd, home.path()),
            Some(("alpha-app".into(), TitleSource::Package, None))
        );
        std::fs::write(
            repo.join("README.md"),
            "```sh\n# install first\n```\n# 🚀\n# 🌙 **Alpha** [Reader](https://x.test) <img src=\"a.png\"> 🌙\n",
        )
        .unwrap();
        assert_eq!(
            display_name_under(&cwd, home.path()),
            Some(("Alpha Reader".into(), TitleSource::Readme, None))
        );
        // The summary is the paragraph under the title the name came from.
        std::fs::write(
            repo.join("README.md"),
            "# 🚀\n\nNot under a title.\n\n# Alpha\n\n<img src=\"logo.png\">\n\nReads **synthetic** notes.\nKeeps them [local](https://x.test).\n\n## Install\n",
        )
        .unwrap();
        assert_eq!(
            display_name_under(&cwd, home.path()),
            Some((
                "Alpha".into(),
                TitleSource::Readme,
                Some("Reads synthetic notes. Keeps them local.".into())
            ))
        );
        // The home folder itself is never read.
        std::fs::write(home.path().join("README.md"), "# Home\n").unwrap();
        std::fs::remove_file(repo.join("README.md")).unwrap();
        std::fs::remove_file(repo.join("app/package.json")).unwrap();
        assert_eq!(display_name_under(&cwd, home.path()), None);
        // A directory under the README name is not read as one.
        std::fs::create_dir(repo.join("README.md")).unwrap();
        assert_eq!(read_capped(&repo.join("README.md"), 1024), None);
    }

    #[test]
    fn a_readme_summary_is_the_first_paragraph_under_its_title() {
        let summary = |text: &str| readme_summary(&text.lines().collect::<Vec<_>>());
        // A blockquote tagline, up to its blank quote line.
        assert_eq!(
            summary("\n> **Synthetic desk** · [site](https://x.test)\n>\n> More detail.\n")
                .as_deref(),
            Some("Synthetic desk · site")
        );
        // Badges, a logo, a list, a table, a rule, code and a comment are no paragraph.
        let skipped = "<div align=\"center\">\n\n[![CI](https://x.test/b.svg)](https://x.test)&nbsp;<img src=\"a.png\">\n\n\
                       - one\n  two\n\n| a | b |\n\n---\n\n```sh\nnpm i\n```\n\n<!--\nmachine notes\n-->\nPlain words &amp; more.\n";
        assert_eq!(summary(skipped).as_deref(), Some("Plain words & more."));
        // The next heading ends the search.
        assert_eq!(summary("\n## Install\n\nRun it.\n"), None);
        assert_eq!(summary("\n<h2>Install</h2>\nRun it.\n"), None);
        assert_eq!(summary(""), None);
        // Cut, the account name in a home path, and personal data.
        let long = "가".repeat(500);
        assert_eq!(summary(&long).unwrap().chars().count(), SUMMARY_CHARS);
        assert!(summary(&long).unwrap().ends_with('…'));
        assert_eq!(
            summary("Built in /Users/someone/project/x.").as_deref(),
            Some("Built in ~/project/x.")
        );
        assert_eq!(summary("Write to someone@example.com for access."), None);
        assert_eq!(summary("key sk-abcdefghijklmnopqrstuvwxyz012345"), None);
    }

    #[test]
    fn open_lines_say_what_is_left_and_not_what_was_closed() {
        let report = "## 완료\n- 로그인 버그를 고쳤습니다\n- 남은 문제 없습니다\n\n\
            ## 남은 작업\n- 검색 색인 재구축\n1. 문서 갱신\n\n마이크 검증은 보류했습니다.\n아직 커밋하지 않았습니다.\n\
            아직 마음에 안 드시면 말씀해 주세요.\n남은 작업은 직접 구현했습니다.\n- [ ] 링크 확인 다시 실행\n- [x] 테스트 통과\n\n\
            **Next steps:**\n- Re-run the eval\n\nNo remaining issues.\nAll remaining failures were fixed.\n\
            The remaining work: port the picker.\n```\n남은 작업: 코드 안\n```\n| 보류 | 표 |\n";
        assert_eq!(
            open_lines(report),
            [
                "검색 색인 재구축",
                "문서 갱신",
                "마이크 검증은 보류했습니다.",
                "아직 커밋하지 않았습니다.",
                "링크 확인 다시 실행",
                "Re-run the eval",
                "The remaining work: port the picker.",
            ]
        );
        // A lead-in's list ends at the first line that is not an item; a
        // heading that names finished work opens nothing.
        assert_eq!(
            open_lines(
                "남은 것:\n- 색인 정리\n이제 끝입니다.\n## 보류 해결 완료\n- 다시 열지 않음\n"
            ),
            ["색인 정리"]
        );
        // Closed in other words.
        for closed in [
            "남은 작업은 없습니다.",
            "남은 작업 0개",
            "blocker는 없습니다.",
            "더 이상 pending이 아닙니다.",
            "TODO 0개",
            "더 할 일은 없습니다.",
            "보류했던 로그인 수정을 완료했습니다.",
            "There are no remaining issues.",
            "Nothing left to do.",
            "No blockers.",
            "중간 단계 완료 시 다음 단계로 진행",
            "- [x] Ship the reader",
        ] {
            assert_eq!(open_lines(closed), Vec::<String>::new(), "{closed}");
        }
        for open in [
            "TODO: wire the picker",
            "Still needs a device check.",
            "Not yet verified on Windows.",
            "남은 일: 문서 갱신",
            "실제 기기 검증이 아직 남아 있습니다.",
            "미완: 다국어 7종",
        ] {
            assert_eq!(open_lines(open).len(), 1, "{open}");
        }
        // Scanned like any hint, and at most ten.
        assert_eq!(
            open_lines("- [ ] mail someone@example.com"),
            Vec::<String>::new()
        );
        let many: String = (0..12).map(|n| format!("- [ ] step {n}\n")).collect();
        assert_eq!(open_lines(&many).len(), OPEN_ITEMS);
    }

    #[test]
    fn open_items_come_from_the_latest_sessions_reports_newest_first() {
        let with_open = |id: &str, root: &str, subagent: bool, epoch: i64, open: &[&str]| {
            let mut c = fact(id, Some("alpha"), Some("Ask"), Some((epoch, "Reported")));
            (c.root, c.subagent, c.last_epoch) = (format!("codex:{root}"), subagent, epoch);
            c.report.as_mut().unwrap().open = open.iter().map(|text| text.to_string()).collect();
            (format!("codex:{id}"), c)
        };
        let mut helper = with_open("h1", "h1", false, 1_795_000_000, &["A program's line"]);
        helper.1.automated = true;
        let all = BTreeMap::from([
            // The person's thread reported; its sub-agent's later report is
            // not what came back in the session.
            with_open(
                "p1",
                "p1",
                false,
                1_790_000_600,
                &["Port the picker", "Write the docs"],
            ),
            with_open("q1", "p1", true, 1_790_000_900, &["Sub-agent detail"]),
            // Said again in an older session: listed once, at the newest.
            with_open(
                "p2",
                "p2",
                false,
                1_790_000_500,
                &["port the picker", "Fix the guard"],
            ),
            with_open("p3", "p3", false, 1_790_000_400, &[]),
            with_open("p4", "p4", false, 1_790_000_300, &["Fourth session"]),
            with_open("p5", "p5", false, 1_790_000_200, &["Fifth session"]),
            // Older than the five sessions a progress answer lists.
            with_open("p6", "p6", false, 1_790_000_100, &["Sixth session"]),
            // A program's session is not the person's work.
            helper,
        ]);
        let items = open_items(&sessions("alpha", &all));
        let texts: Vec<&str> = items.iter().map(|item| item.text.as_str()).collect();
        assert_eq!(
            texts,
            [
                "Port the picker",
                "Write the docs",
                "Fix the guard",
                "Fourth session",
                "Fifth session"
            ]
        );
        assert_eq!(
            (items[0].conversation.as_str(), items[0].epoch),
            ("codex:p1", 1_790_000_600)
        );
        assert_eq!(items[2].conversation, "codex:p2");
        // At most ten.
        let lines: Vec<String> = (0..8).map(|n| format!("Step {n}")).collect();
        let lines: Vec<&str> = lines.iter().map(String::as_str).collect();
        let full = BTreeMap::from([
            with_open("a1", "a1", false, 1_790_000_600, &lines),
            with_open(
                "a2",
                "a2",
                false,
                1_790_000_500,
                &["Other 1", "Other 2", "Other 3"],
            ),
        ]);
        let items = open_items(&sessions("alpha", &full));
        assert_eq!(items.len(), OPEN_ITEMS);
        assert_eq!(items[9].text, "Other 2");
    }

    #[test]
    fn protected_folders_are_read_only_beside_the_vault() {
        let vault = Path::new("/Users/a/Documents/vault");
        let allowed = |cwd: &str| may_read(cwd, "/Users/a".len(), vault);
        assert!(allowed("/Users/a/projects/x"));
        assert!(allowed("/Users/a/Documents/x"), "the vault's own folder");
        assert_eq!(allowed("/Users/a/Desktop/x"), !cfg!(target_os = "macos"));
        assert_eq!(allowed("/Users/a/downloads/x"), !cfg!(target_os = "macos"));
        let elsewhere = Path::new("/Users/a/vaults/v");
        assert_eq!(
            may_read("/Users/a/Documents/x", "/Users/a".len(), elsewhere),
            !cfg!(target_os = "macos")
        );
    }

    #[test]
    fn page_renders_the_same_bytes_and_escapes_text() {
        let conversation =
            |id: &str, root: &str, epoch: i64, report: Option<&str>| ConversationFacts {
                automated: false,
                cwd_source: CwdSource::Rollout,
                first_epoch: epoch,
                fp: "0123456789abcdef".into(),
                id: id.into(),
                key: Some("alpha".into()),
                last_epoch: epoch + 60,
                parent_report: None,
                raw: format!("raw/conversations/codex/codex-{id}-0123456789abcdef.md"),
                report: report.map(|text| Report {
                    epoch: epoch + 30,
                    open: Vec::new(),
                    text: text.into(),
                }),
                request: Some(format!("Do [[{id}]] <!-- x -->")),
                root: format!("codex:{root}"),
                subagent: id != root,
                vendor: "codex".into(),
            };
        let all = BTreeMap::from([
            (
                "codex:r1".to_string(),
                conversation("r1", "r1", 1_790_000_000, None),
            ),
            (
                "codex:s1".to_string(),
                conversation("s1", "r1", 1_790_100_000, Some("Shipped *it*")),
            ),
            (
                "codex:r2".to_string(),
                conversation("r2", "r2", 1_780_000_000, None),
            ),
        ]);
        let workstream = WorkstreamFacts {
            conversations: 3,
            first_epoch: 1_780_000_000,
            last_epoch: 1_790_100_060,
            open_items: Vec::new(),
            page: format!("{PAGE_DIR}alpha.md"),
            roots: 2,
            summary: None,
            title: "Alpha \"Reader\"".into(),
            title_source: TitleSource::Readme,
        };
        let page = render_page("alpha", &workstream, &all);
        assert_eq!(page, render_page("alpha", &workstream, &all));
        assert!(page.starts_with("---\ntitle: \"Alpha \\\"Reader\\\"\"\ntype: overview\nworkstream_key: \"alpha\"\n---\n"));
        assert!(is_owned(&page));
        assert_eq!(page.matches(MARKER_OPEN).count(), 1);
        let rows: Vec<&str> = page.lines().filter(|line| line.starts_with("- ")).collect();
        assert_eq!(rows.len(), 2);
        // Newest root first; its subagent's later report, cited at that raw.
        assert_eq!(
            rows[0],
            format!(
                "- {} · Do \\[\\[r1\\]\\] \\<!-- x --\\> → Shipped \\*it\\* \
                 [[raw/conversations/codex/codex-s1-0123456789abcdef]]",
                local_date(1_790_100_060)
            )
        );
        assert_eq!(
            rows[1],
            format!(
                "- {} · Do \\[\\[r2\\]\\] \\<!-- x --\\> [[raw/conversations/codex/codex-r2-0123456789abcdef]]",
                local_date(1_780_000_060)
            )
        );
        let span = format!(
            "\n{} – {}\n",
            local_date(1_780_000_000),
            local_date(1_790_100_060)
        );
        assert!(page.contains(&span), "{page}");
        // No words a reader of another language would need translated.
        for english in [
            " conversations",
            "session",
            "reported",
            "no report",
            "request not",
            "Without",
        ] {
            assert!(!page.contains(english), "{english} in {page}");
        }
        assert!(page.ends_with("\n\n<!-- /myco:workstream -->\n"));
        // An escape the transcript already holds is shown once, without a
        // backslash; other backslashes stay visible.
        assert_eq!(plain(r"Read START\_HERE.txt"), r"Read START\_HERE.txt");
        assert_eq!(plain(r"a \\ b \* c"), r"a \\ b \* c");
        assert_eq!(plain(r"C:\Users\x"), r"C:\\Users\\x");
        assert_eq!(plain("tail \\"), "tail \\\\");
    }

    #[test]
    fn state_store_is_read_immutable_and_a_broken_one_is_counted() {
        let base = tempfile::tempdir().unwrap();
        let good = base.path().join("Application Support/good");
        let broken = base.path().join("broken");
        for home in [&good, &broken] {
            std::fs::create_dir_all(home).unwrap();
        }
        let path = good.join("state_5.sqlite");
        let writer = rusqlite::Connection::open(&path).unwrap();
        writer
            .execute_batch(&format!(
                "CREATE TABLE threads (id TEXT PRIMARY KEY, cwd TEXT);
                 INSERT INTO threads VALUES ('{CODEX_A}', '/Users/a/projects/alpha');"
            ))
            .unwrap();
        drop(writer);
        std::fs::write(broken.join("state_5.sqlite"), "not a database").unwrap();
        let before: BTreeSet<_> = std::fs::read_dir(&good)
            .unwrap()
            .flatten()
            .map(|e| e.file_name())
            .collect();
        let homes = [broken.clone(), good.clone()];
        let mut stores = CodexStores::new(&homes);
        assert_eq!(
            stores.cwd(CODEX_A),
            Some(("/Users/a/projects/alpha".into(), CwdSource::State))
        );
        assert_eq!(stores.failures, 1);
        assert_eq!(stores.cwd(CODEX_B), None);
        drop(stores);
        let after: BTreeSet<_> = std::fs::read_dir(&good)
            .unwrap()
            .flatten()
            .map(|e| e.file_name())
            .collect();
        assert_eq!(before, after, "no -wal or -shm beside the store");
        write_rollout(
            &broken,
            CODEX_B,
            &codex_rollout(CODEX_B, "/Users/a/projects/beta", None, "x", "y"),
        );
        let mut stores = CodexStores::new(&homes);
        assert_eq!(
            stores.cwd(CODEX_B),
            Some(("/Users/a/projects/beta".into(), CwdSource::Rollout))
        );
    }

    /// Codex keeps its store in WAL mode with a writer open. A row still only
    /// in the -wal is not seen (its rollout answers), and the store, its -wal
    /// and its -shm keep their bytes.
    #[test]
    fn a_live_wal_store_is_read_without_touching_it() {
        let home = tempfile::tempdir().unwrap();
        let path = home.path().join("state_5.sqlite");
        let writer = rusqlite::Connection::open(&path).unwrap();
        let mode: String = writer
            .query_row("PRAGMA journal_mode=WAL", [], |row| row.get(0))
            .unwrap();
        assert_eq!(mode, "wal");
        let _: i64 = writer
            .query_row("PRAGMA wal_autocheckpoint=0", [], |row| row.get(0))
            .unwrap();
        writer
            .execute_batch(&format!(
                "CREATE TABLE threads (id TEXT PRIMARY KEY, cwd TEXT);
                 INSERT INTO threads VALUES ('{CODEX_A}', '/Users/a/projects/alpha');"
            ))
            .unwrap();
        let _: (i64, i64, i64) = writer
            .query_row("PRAGMA wal_checkpoint(FULL)", [], |row| {
                Ok((row.get(0)?, row.get(1)?, row.get(2)?))
            })
            .unwrap();
        writer
            .execute(
                "INSERT INTO threads VALUES (?1, '/Users/a/projects/late')",
                [CODEX_B],
            )
            .unwrap();
        write_rollout(
            home.path(),
            CODEX_B,
            &codex_rollout(CODEX_B, "/Users/a/projects/beta", None, "x", "y"),
        );
        let files = || -> BTreeMap<String, Vec<u8>> {
            ["state_5.sqlite", "state_5.sqlite-wal", "state_5.sqlite-shm"]
                .into_iter()
                .map(|name| {
                    let bytes = std::fs::read(home.path().join(name)).unwrap_or_default();
                    (name.to_string(), bytes)
                })
                .collect()
        };
        let before = files();
        assert!(
            !before["state_5.sqlite-wal"].is_empty(),
            "the late row is in the -wal"
        );
        let homes = [home.path().to_path_buf()];
        let mut stores = CodexStores::new(&homes);
        assert_eq!(
            stores.cwd(CODEX_A),
            Some(("/Users/a/projects/alpha".into(), CwdSource::State))
        );
        assert_eq!(
            stores.cwd(CODEX_B),
            Some(("/Users/a/projects/beta".into(), CwdSource::Rollout))
        );
        assert_eq!(stores.failures, 0);
        drop(stores);
        assert_eq!(files(), before);
        drop(writer);
    }

    // ---- tempdir vaults, imported through the native admission path ----

    fn import(vault: &Path, file: &Path) {
        let outcome = crate::commands::run_import_admitted(
            vault,
            &[file.to_path_buf()],
            crate::commands::DEST_SESSIONS,
        );
        let failed: Vec<_> = outcome.failed.iter().map(|f| f.error.clone()).collect();
        assert!(failed.is_empty(), "{failed:?}");
        assert_eq!(outcome.imported, 1);
    }

    fn facts(vault: &Path) -> serde_json::Value {
        serde_json::from_str(&std::fs::read_to_string(facts_path(vault)).unwrap()).unwrap()
    }

    /// A refresh with no guards to take, as tests run it.
    fn reconcile(root: &Path) -> usize {
        refresh(root, &default_codex_homes(), |plan| apply(root, plan))
            .unwrap()
            .0
    }

    fn snapshot(dir: &Path) -> BTreeMap<PathBuf, Vec<u8>> {
        let mut out = BTreeMap::new();
        let mut pending = vec![dir.to_path_buf()];
        while let Some(at) = pending.pop() {
            for entry in std::fs::read_dir(&at).into_iter().flatten().flatten() {
                if entry.file_type().unwrap().is_dir() {
                    pending.push(entry.path());
                } else {
                    out.insert(entry.path(), std::fs::read(entry.path()).unwrap());
                }
            }
        }
        out
    }

    /// One Claude Code session in `alpha` and a Codex root with a sub-thread
    /// in `beta`, found through a synthetic Codex home.
    fn vault_with_sessions() -> (tempfile::TempDir, tempfile::TempDir) {
        let vault = tempfile::tempdir().unwrap();
        let home = tempfile::tempdir().unwrap();
        set_test_codex_homes(vec![home.path().to_path_buf()]);
        let claude = vault.path().join("claude.jsonl");
        std::fs::write(
            &claude,
            claude_session(
                "cc-1",
                "/Users/synthetic/projects/alpha",
                "Build the alpha reader",
                "Alpha reader built",
            ),
        )
        .unwrap();
        import(vault.path(), &claude);
        let root = codex_rollout(
            CODEX_A,
            "/Users/synthetic/projects/beta",
            None,
            "Plan beta",
            "Beta planned",
        );
        import(vault.path(), &write_rollout(home.path(), CODEX_A, &root));
        // The sub-thread has no rollout and no state row: it inherits.
        let child = vault.path().join("child.jsonl");
        std::fs::write(
            &child,
            codex_rollout(CODEX_B, "/x", Some(CODEX_A), "Check beta", "Beta checked"),
        )
        .unwrap();
        import(vault.path(), &child);
        (vault, home)
    }

    #[test]
    fn imports_publish_facts_and_pages_and_a_second_pass_writes_nothing() {
        let (vault, _home) = vault_with_sessions();
        let root = vault.path().canonicalize().unwrap();
        let facts = facts(&root);
        assert_eq!(facts["version"], 4);
        assert_eq!(facts["unassigned"], 0);
        let claude = &facts["conversations"]["claude-code:cc-1"];
        assert_eq!(claude["key"], "alpha");
        assert_eq!(claude["cwd_source"], "sidecar");
        assert_eq!(claude["request"], "Build the alpha reader");
        assert_eq!(claude["report"]["text"], "Alpha reader built");
        let parent = &facts["conversations"][format!("codex:{CODEX_A}")];
        assert_eq!(parent["cwd_source"], "rollout");
        assert_eq!(parent["subagent"], false);
        let child = &facts["conversations"][format!("codex:{CODEX_B}")];
        assert_eq!(child["key"], "beta");
        assert_eq!(child["cwd_source"], "inherited");
        assert_eq!(child["subagent"], true);
        assert_eq!(child["root"], format!("codex:{CODEX_A}"));
        let beta = &facts["workstreams"]["beta"];
        assert_eq!(
            (beta["conversations"].as_u64(), beta["roots"].as_u64()),
            (Some(2), Some(1))
        );
        assert_eq!(beta["title_source"], "key");
        assert_eq!(beta["page"], "wiki/workstreams/beta.md");
        let text = std::fs::read_to_string(facts_path(&root)).unwrap();
        assert!(!text.contains("/Users/"), "no cwd string reaches the facts");
        let page = std::fs::read_to_string(root.join("wiki/workstreams/beta.md")).unwrap();
        // The root thread's own report, not its sub-thread's later one.
        assert!(
            page.contains(&format!(
                " · Plan beta → Beta planned [[raw/conversations/codex/codex-{CODEX_A}-"
            )),
            "{page}"
        );
        let before = snapshot(&root);
        assert_eq!(reconcile(&root), 0);
        assert_eq!(snapshot(&root), before);
    }

    #[test]
    fn a_later_pass_catches_up_what_an_earlier_one_missed() {
        let (vault, home) = vault_with_sessions();
        let root = vault.path().canonicalize().unwrap();
        // As if the refresh after the Claude Code import had failed.
        let mut known = facts(&root);
        known["conversations"]
            .as_object_mut()
            .unwrap()
            .remove("claude-code:cc-1");
        std::fs::write(facts_path(&root), known.to_string()).unwrap();
        // A tracked revision without a raw transcript is counted, not read.
        let mut ledger = Ledger::load(&root).unwrap();
        ledger.record("claude-code:no-raw".into(), "0123456789abcdef".into());
        ledger.save(&root).unwrap();
        let next = "00000000-0000-4000-8000-00000000000d";
        let rollout = codex_rollout(
            next,
            "/Users/synthetic/projects/gamma",
            None,
            "Start gamma",
            "Gamma started",
        );
        import(&root, &write_rollout(home.path(), next, &rollout));
        let facts = facts(&root);
        assert_eq!(facts["conversations"]["claude-code:cc-1"]["key"], "alpha");
        assert_eq!(
            facts["conversations"][format!("codex:{next}")]["key"],
            "gamma"
        );
        assert!(facts["conversations"].get("claude-code:no-raw").is_none());
        let plan = plan(&root, &default_codex_homes()).unwrap();
        assert_eq!((plan.recomputed, plan.unread), (0, 1));
    }

    #[test]
    fn a_thread_without_a_folder_is_looked_up_again() {
        let (vault, home) = vault_with_sessions();
        let root = vault.path().canonicalize().unwrap();
        let late = "00000000-0000-4000-8000-00000000000e";
        let rollout = codex_rollout(
            late,
            "/Users/synthetic/projects/delta",
            None,
            "Plan delta",
            "Delta planned",
        );
        // Imported from a copy no Codex home holds yet.
        let copy = root.join("late.jsonl");
        std::fs::write(&copy, &rollout).unwrap();
        import(&root, &copy);
        let key = format!("codex:{late}");
        assert_eq!(facts(&root)["conversations"][&key]["cwd_source"], "none");
        // Its rollout turns up in a home later (an Orca account, say).
        write_rollout(home.path(), late, &rollout);
        assert!(reconcile(&root) > 0);
        let facts = facts(&root);
        assert_eq!(facts["conversations"][&key]["key"], "delta");
        assert_eq!(facts["conversations"][&key]["cwd_source"], "rollout");
        assert!(root.join("wiki/workstreams/delta.md").is_file());
    }

    #[test]
    fn a_pass_that_lost_a_compare_and_swap_plans_again() {
        let (vault, _home) = vault_with_sessions();
        let root = vault.path().canonicalize().unwrap();
        let expected = std::fs::read(facts_path(&root)).unwrap();
        std::fs::remove_file(facts_path(&root)).unwrap();
        // Another writer lands between the plan and the first publish.
        let homes = default_codex_homes();
        let calls = std::cell::Cell::new(0);
        let (written, _) = refresh(&root, &homes, |plan| {
            calls.set(calls.get() + 1);
            if calls.get() == 1 {
                std::fs::write(facts_path(&root), "{}").unwrap();
            }
            apply(&root, plan)
        })
        .unwrap();
        assert_eq!(calls.get(), 2);
        assert!(written > 0);
        assert_eq!(std::fs::read(facts_path(&root)).unwrap(), expected);
        // A writer that always wins: three plans, then the conflict is told.
        let calls = std::cell::Cell::new(0);
        std::fs::remove_file(facts_path(&root)).unwrap();
        let Err(error) = refresh(&root, &homes, |plan| {
            calls.set(calls.get() + 1);
            std::fs::write(facts_path(&root), format!("{{\"n\":{}}}", calls.get())).unwrap();
            apply(&root, plan)
        }) else {
            panic!("a pass that always loses must not report success");
        };
        assert_eq!(calls.get(), 3);
        assert!(error.contains("write conflict"), "{error}");
    }

    /// Writes one raw revision and its sidecar the way the importer names them.
    fn seed(
        root: &Path,
        key: &str,
        fp: &str,
        frontmatter: &str,
        user: &str,
        sidecar: &[serde_json::Value],
    ) {
        let raw = root.join(raw_path(key, fp).unwrap());
        std::fs::create_dir_all(raw.parent().unwrap()).unwrap();
        std::fs::write(
            &raw,
            format!("---\n{frontmatter}\n---\n\n# Synthetic\n\n**User:**\n\n{user}\n\n**Assistant:**\n\nWorking on it.\n"),
        )
        .unwrap();
        let lines: Vec<String> = sidecar.iter().map(|record| record.to_string()).collect();
        std::fs::write(raw.with_extension("jsonl"), lines.join("\n")).unwrap();
    }

    /// The facts file the TypeScript reader is tested against
    /// (queryWorkstreams.test.ts reads the same file): folder names a page
    /// path or wikilink cannot carry as they are, an NFD name, a home path in
    /// a request, a report that opens with an acknowledgement, a time before
    /// 1970, a Codex sub-thread, two sub-threads of a parent never imported
    /// (one reporting in Korean, one carrying the parent's copied answer), a
    /// Claude Code teammate, a helper session a program started, a derived
    /// and a user-given title, an unassigned and an unreadable conversation.
    #[test]
    fn facts_match_the_shared_reader_fixture() {
        let vault = tempfile::tempdir().unwrap();
        let home = tempfile::tempdir().unwrap();
        set_test_codex_homes(vec![home.path().to_path_buf()]);
        let root = vault.path().canonicalize().unwrap();
        let nfd: String = {
            use unicode_normalization::UnicodeNormalization;
            "노트".nfd().collect()
        };
        let claude = |cwd: &str, report: Option<&str>| {
            let mut records = vec![serde_json::json!({"type":"user","cwd":cwd,
                "message":{"role":"user","content":"synthetic"}})];
            if let Some(report) = report {
                records.push(serde_json::json!({"type":"assistant","cwd":cwd,
                    "timestamp":"2026-10-27T03:00:00Z",
                    "message":{"stop_reason":"end_turn","content":[{"type":"text","text":report}]}}));
            }
            records
        };
        // 2026-10-27 02:00 to 03:00 UTC; each report lands at its turn's end.
        let times = "created: 1793066400\nlast_activity: 1793070000";
        let cases = [
            (
                "claude-code:fx-bracket",
                "foo [old]",
                "Rename the [old] folder",
                Some("## Summary\nRenamed the folder; tests pass.\n\n## Next steps\n- Update the [old] links in the docs\n- [x] Re-run the tests\n\nNo remaining issues in the parser."),
            ),
            (
                "claude-code:fx-hash",
                "c#",
                "Port the parser",
                Some("완료했습니다.\n\n- 파서를 옮겼습니다"),
            ),
            (
                "claude-code:fx-dot",
                ".dotfiles",
                "Sync /Users/synthetic/.zshrc to the repo",
                Some("Done."),
            ),
            ("claude-code:fx-nfd", nfd.as_str(), "노트 앱 정리", None),
            (
                "claude-code:fx-pipe",
                "a|b",
                "Check the pipe name",
                Some("Checked the pipe name."),
            ),
        ];
        let mut ledger = Ledger::load(&root).unwrap();
        for (n, (key, folder, request, report)) in cases.into_iter().enumerate() {
            let fp = format!("{:016x}", n + 1);
            let cwd = format!("/Users/synthetic/projects/{folder}");
            seed(&root, key, &fp, times, request, &claude(&cwd, report));
            ledger.record(key.into(), fp);
        }
        seed(
            &root,
            "claude-code:fx-tmp",
            "0000000000000006",
            "created: -5\nlast_activity: 1793073600",
            "Scratch work",
            &claude("/tmp/scratch", Some("Scratched.")),
        );
        ledger.record("claude-code:fx-tmp".into(), "0000000000000006".into());
        // An agent-team teammate of the fx-bracket session.
        let mut teammate = claude(
            "/Users/synthetic/projects/foo [old]",
            Some("Checked the rename."),
        );
        teammate[0]["teamName"] = "session-fx-brack".into();
        teammate[0]["agentName"] = "checker".into();
        seed(
            &root,
            "claude-code:fx-teammate",
            "000000000000000d",
            times,
            "<teammate-message teammate_id=\"team-lead\">Check the rename</teammate-message>",
            &teammate,
        );
        ledger.record("claude-code:fx-teammate".into(), "000000000000000d".into());
        // A dashboard's helper session in the lab's folder, which a program
        // started: only counted, on the lab's page.
        seed(
            &root,
            "claude-code:fx-helper",
            "000000000000000e",
            times,
            "[Image #1] 당신은 Orbital 대시보드의 안내 도우미입니다. 사용자의 질문에 답하세요.",
            &claude(
                "/Users/synthetic/orca/workspaces/fixture-lab/main",
                Some("대시보드 사용법을 안내했습니다."),
            ),
        );
        ledger.record("claude-code:fx-helper".into(), "000000000000000e".into());
        let (lab, sub) = (
            "00000000-0000-4000-8000-0000000000f1",
            "00000000-0000-4000-8000-0000000000f2",
        );
        let answer = |at: &str, text: &str, inherited: bool| {
            let mut record = serde_json::json!({"timestamp":at,"type":"response_item",
                "payload":{"type":"message","role":"assistant","phase":"final_answer",
                    "content":[{"type":"output_text","text":text}]}});
            if inherited {
                record["metadata"] = serde_json::json!({"inherited_user_message": true});
            }
            record
        };
        seed(
            &root,
            &format!("codex:{lab}"),
            "0000000000000007",
            "created: 1793073600\nlast_activity: 1793077200",
            "Set up the lab from ORBITAL_LAB_GOAL.md",
            &[answer(
                "2026-10-27T05:00:00Z",
                "Lab ready\nPending: the review of the sensors.",
                false,
            )],
        );
        ledger.record(format!("codex:{lab}"), "0000000000000007".into());
        write_rollout(
            home.path(),
            lab,
            &codex_rollout(
                lab,
                "/Users/synthetic/orca/workspaces/fixture-lab/main",
                None,
                "x",
                "y",
            ),
        );
        seed(&root, &format!("codex:{sub}"), "0000000000000008",
            &format!("created: 1793077200\nlast_activity: 1793080800\nturn_metadata: [{{\"session_provenance\":[{{\"parent_thread_id\":\"{lab}\"}}]}}]"),
            "Review the lab",
            &[answer("2026-10-27T05:00:00Z", "Lab ready", true), answer("2026-10-27T06:00:00Z", "Review found one issue", false)]);
        ledger.record(format!("codex:{sub}"), "0000000000000008".into());
        // Two sub-threads of a parent that was never imported, with their own
        // folder in fixture-lab: one session rooted at that parent. One of
        // them copied in the parent's last answer when it forked.
        let unseen = "00000000-0000-4000-8000-0000000000f9";
        let siblings = [
            (
                "00000000-0000-4000-8000-0000000000f3",
                "000000000000000b",
                "created: 1793084400\nlast_activity: 1793086200",
                vec![
                    answer(
                        "2026-10-27T06:40:00Z",
                        "궤도 계획을 확정했습니다.\n\n- [ ] 궤도 시뮬레이션 실행\n남은 문제는 없습니다.",
                        true,
                    ),
                    answer("2026-10-27T07:30:00Z", "Orbital checks pass", false),
                ],
            ),
            (
                "00000000-0000-4000-8000-0000000000f4",
                "000000000000000c",
                "created: 1793082600\nlast_activity: 1793084400",
                vec![answer(
                    "2026-10-27T06:50:00Z",
                    "궤도 점검을 마쳤습니다.",
                    false,
                )],
            ),
        ];
        for (id, fp, times, records) in &siblings {
            let key = format!("codex:{id}");
            seed(&root, &key, fp,
                &format!("{times}\nturn_metadata: [{{\"session_provenance\":[{{\"parent_thread_id\":\"{unseen}\"}}]}}]"),
                "ORBITAL_LAB_GOAL.md", records);
            ledger.record(key, fp.to_string());
            write_rollout(
                home.path(),
                id,
                &codex_rollout(
                    id,
                    "/Users/synthetic/orca/workspaces/fixture-lab/side",
                    Some(unseen),
                    "x",
                    "y",
                ),
            );
        }
        ledger.record("claude-code:fx-missing".into(), "0000000000000009".into());
        ledger.record(
            format!("claude-code:{}", "x".repeat(300)),
            "000000000000000a".into(),
        );
        ledger.save(&root).unwrap();
        let names = crate::vault_dir::dir(&root).join(NAMES_FILE);
        std::fs::create_dir_all(names.parent().unwrap()).unwrap();
        std::fs::write(&names, r#"{"C#": "C Sharp Port", "a|b": 7}"#).unwrap();

        assert!(reconcile(&root) > 0);
        let text = std::fs::read_to_string(facts_path(&root)).unwrap();
        assert!(
            text == include_str!("../../src/lib/workstreamFacts.fixture.json"),
            "src/lib/workstreamFacts.fixture.json is out of date; the writer now produces:\n{text}"
        );
        let facts = facts(&root);
        let lab_facts = &facts["workstreams"]["fixture-lab"];
        assert_eq!(
            (
                lab_facts["title"].as_str(),
                lab_facts["title_source"].as_str()
            ),
            (Some("Orbital"), Some("derived"))
        );
        assert_eq!(
            (
                lab_facts["conversations"].as_u64(),
                lab_facts["roots"].as_u64()
            ),
            (Some(4), Some(2))
        );
        assert_eq!(facts["workstreams"]["c#"]["title_source"], "user");
        let helper = &facts["conversations"]["claude-code:fx-helper"];
        assert_eq!(
            (helper["automated"].as_bool(), helper["key"].as_str()),
            (Some(true), Some("fixture-lab"))
        );
        let lab_page =
            std::fs::read_to_string(root.join("wiki/workstreams/fixture-lab.md")).unwrap();
        assert!(
            lab_page.contains(&format!("\n{AUTOMATED_LABEL}: 1\n")) && !lab_page.contains("도우미"),
            "{lab_page}"
        );
        for (id, ..) in &siblings {
            assert_eq!(
                facts["conversations"][format!("codex:{id}")]["root"],
                format!("codex:{unseen}")
            );
        }
        let conversation = |key: &str| &facts["conversations"][key];
        assert_eq!(
            conversation(&format!("codex:{}", siblings[0].0))["parent_report"]["text"],
            "궤도 계획을 확정했습니다."
        );
        assert_eq!(
            conversation(&format!("codex:{sub}"))["parent_report"]["text"],
            "Lab ready"
        );
        let teammate = conversation("claude-code:fx-teammate");
        assert_eq!(
            (teammate["subagent"].as_bool(), teammate["root"].as_str()),
            (Some(true), Some("claude-code:fx-bracket"))
        );
        assert_eq!(facts["workstreams"]["foo [old]"]["roots"], 1);
        // What the sessions' reports leave open, newest first: the copied
        // answer a sub-agent carries, then the lab thread's own report.
        let open: Vec<(&str, &str)> = lab_facts["open_items"]
            .as_array()
            .unwrap()
            .iter()
            .map(|item| {
                (
                    item["text"].as_str().unwrap(),
                    item["conversation"].as_str().unwrap(),
                )
            })
            .collect();
        let (f3, lab_key) = (format!("codex:{}", siblings[0].0), format!("codex:{lab}"));
        assert_eq!(
            open,
            [
                ("궤도 시뮬레이션 실행", f3.as_str()),
                ("Pending: the review of the sensors.", lab_key.as_str())
            ]
        );
        assert_eq!(
            facts["workstreams"]["foo [old]"]["open_items"],
            serde_json::json!([{"conversation": "claude-code:fx-bracket", "epoch": 1793070000,
                "text": "Update the [old] links in the docs"}])
        );
        // No folder of the fixture is on disk, so no README gives a summary.
        assert!(facts["workstreams"]
            .as_object()
            .unwrap()
            .values()
            .all(|workstream| workstream["summary"].is_null()));
        assert_eq!(
            plan(&root, &default_codex_homes()).unwrap().names_ignored,
            1
        );
        for workstream in facts["workstreams"].as_object().unwrap().values() {
            let page =
                std::fs::read_to_string(root.join(workstream["page"].as_str().unwrap())).unwrap();
            assert!(is_owned(&page), "{page}");
        }
        assert!(!text.contains("/Users/"));
        assert_eq!(plan(&root, &default_codex_homes()).unwrap().unread, 1);
    }

    #[test]
    fn a_full_rebuild_leaves_raw_bytes_and_ignores_unledgered_sources() {
        let (vault, _home) = vault_with_sessions();
        let root = vault.path().canonicalize().unwrap();
        let stray = root.join("raw/conversations/codex/codex-stray-0123456789abcdef.md");
        std::fs::write(&stray, "---\nsource: codex\nconversation_id: \"stray\"\ncreated: 1\n---\n\n# Stray\n\n**User:**\n\nnot in the ledger\n\n").unwrap();
        let raw = snapshot(&root.join("raw"));
        let expected = std::fs::read(facts_path(&root)).unwrap();
        std::fs::remove_file(facts_path(&root)).unwrap();
        assert!(reconcile(&root) > 0);
        assert_eq!(snapshot(&root.join("raw")), raw);
        assert_eq!(std::fs::read(facts_path(&root)).unwrap(), expected);
        assert!(facts(&root)["conversations"].get("codex:stray").is_none());
    }

    #[test]
    fn a_vanished_rollout_keeps_the_key_and_title_already_read() {
        let (vault, home) = vault_with_sessions();
        let root = vault.path().canonicalize().unwrap();
        let mut known = facts(&root);
        known["workstreams"]["beta"]["title"] = "Beta Planner".into();
        known["workstreams"]["beta"]["title_source"] = "readme".into();
        // Edited since: the summary is cleaned again, as the title is.
        known["workstreams"]["beta"]["summary"] = "Plans   synthetic trips.".into();
        std::fs::write(
            facts_path(&root),
            serde_json::to_string_pretty(&known).unwrap(),
        )
        .unwrap();
        let rollout = home.path().join(format!(
            "sessions/2026/10/10/rollout-2026-10-10T09-00-00-{CODEX_A}.jsonl"
        ));
        let grown = format!(
            "{}\n{}",
            std::fs::read_to_string(&rollout).unwrap(),
            serde_json::json!({"timestamp":"2026-10-11T09:00:00Z","type":"response_item",
                "payload":{"type":"message","role":"assistant","phase":"final_answer",
                    "content":[{"type":"output_text","text":"Beta shipped"}]}})
        );
        std::fs::remove_file(&rollout).unwrap();
        let copy = root.join("grown.jsonl");
        std::fs::write(&copy, grown).unwrap();
        import(&root, &copy);
        let facts = facts(&root);
        let parent = &facts["conversations"][format!("codex:{CODEX_A}")];
        assert_eq!(
            parent["report"]["text"], "Beta shipped",
            "the new revision was read"
        );
        assert_eq!(parent["key"], "beta");
        assert_eq!(parent["cwd_source"], "rollout");
        assert_eq!(facts["workstreams"]["beta"]["title"], "Beta Planner");
        assert_eq!(facts["workstreams"]["beta"]["title_source"], "readme");
        assert_eq!(
            facts["workstreams"]["beta"]["summary"],
            "Plans synthetic trips."
        );
    }

    #[test]
    fn a_page_without_its_marker_belongs_to_a_person() {
        let (vault, home) = vault_with_sessions();
        let root = vault.path().canonicalize().unwrap();
        let page = root.join("wiki/workstreams/beta.md");
        std::fs::write(&page, "# Beta\n\nMy own notes.\n").unwrap();
        let next = "00000000-0000-4000-8000-00000000000c";
        let rollout = codex_rollout(
            next,
            "/Users/synthetic/projects/beta",
            None,
            "Next beta step",
            "Done",
        );
        import(&root, &write_rollout(home.path(), next, &rollout));
        assert_eq!(
            std::fs::read_to_string(&page).unwrap(),
            "# Beta\n\nMy own notes.\n"
        );
        assert_eq!(facts(&root)["workstreams"]["beta"]["conversations"], 3);
    }

    /// A conversation fact for the pure rules; synthetic words only.
    fn fact(
        id: &str,
        key: Option<&str>,
        request: Option<&str>,
        report: Option<(i64, &str)>,
    ) -> ConversationFacts {
        ConversationFacts {
            automated: false,
            cwd_source: CwdSource::Rollout,
            first_epoch: 1_790_000_000,
            fp: "0123456789abcdef".into(),
            id: id.into(),
            key: key.map(str::to_string),
            last_epoch: 1_790_000_060,
            parent_report: None,
            raw: format!("raw/conversations/codex/codex-{id}-0123456789abcdef.md"),
            report: report.map(|(epoch, text)| Report {
                epoch,
                open: Vec::new(),
                text: text.into(),
            }),
            request: request.map(str::to_string),
            root: format!("codex:{id}"),
            subagent: false,
            vendor: "codex".into(),
        }
    }

    #[test]
    fn a_name_is_a_word_its_own_conversations_ask_with_and_others_do_not() {
        let goal = Some("NIMBUS_IMPLEMENTATION_GOAL.md");
        let rows = [
            // Like a folder keyed prj_halo whose work is all about one app.
            (
                "h1",
                "prj_halo",
                goal,
                Some((1, "UI case crashed on the catalog hash check.")),
            ),
            (
                "h2",
                "prj_halo",
                goal,
                Some((2, "Runner sealed the catalog stage.")),
            ),
            ("h3", "prj_halo", goal, None),
            (
                "h4",
                "prj_halo",
                Some("Polish the nimbus onboarding"),
                Some((4, "Onboarding polished.")),
            ),
            // Generic words only, however often: no name ("title" is a
            // field of the JSON a program asks for).
            (
                "g1",
                "beta",
                Some("Review the status report title"),
                Some((1, "Review done; status report updated.")),
            ),
            (
                "g2",
                "beta",
                Some("Review the status report title"),
                Some((2, "Review done.")),
            ),
            ("g3", "beta", Some("Review the status report title"), None),
            // A word two projects share as much: no name for either.
            ("s1", "gamma", Some("Tune the orbital engine"), None),
            ("s2", "gamma", Some("Tune the orbital engine"), None),
            ("s3", "gamma", Some("Tune the orbital engine"), None),
            ("t1", "delta", Some("Tune the orbital engine"), None),
            ("t2", "delta", Some("Tune the orbital engine"), None),
            ("t3", "delta", Some("Tune the orbital engine"), None),
            // Only in what agents reported back, never asked with: no name.
            (
                "r1",
                "epsilon",
                Some("Do it"),
                Some((1, "Sent the lead a draft.")),
            ),
            (
                "r2",
                "epsilon",
                Some("Do it"),
                Some((2, "Sent the lead the fix.")),
            ),
            (
                "r3",
                "epsilon",
                Some("Do it"),
                Some((3, "Sent the lead notes.")),
            ),
            // Already a word of the key: no name.
            ("k1", "time-keeper", Some("keeper"), None),
            ("k2", "time-keeper", Some("keeper"), None),
            ("k3", "time-keeper", Some("Keeper"), None),
            // An observed capitalized form is kept as written.
            ("z1", "prj_wind", Some("Ship ZEPHYR_GOAL.md"), None),
            ("z2", "prj_wind", Some("Zephyr screens"), None),
            ("z3", "prj_wind", Some("zephyr build"), None),
            // Not in any workstream: it neither names nor dilutes.
            ("u1", "", Some("Tune the orbital engine"), None),
        ];
        let all: BTreeMap<String, ConversationFacts> = rows
            .iter()
            .map(|(id, key, request, report)| {
                let key = Some(*key).filter(|key| !key.is_empty());
                (format!("codex:{id}"), fact(id, key, *request, *report))
            })
            .collect();
        let names = derived_names(&all);
        assert_eq!(
            names.get("prj_halo").map(String::as_str),
            Some("Nimbus"),
            "not NIMBUS"
        );
        assert_eq!(names.get("prj_wind").map(String::as_str), Some("Zephyr"));
        for key in ["beta", "gamma", "delta", "epsilon", "time-keeper"] {
            assert_eq!(names.get(key), None, "{key}");
        }
        // Two of three conversations with the word is not 60%.
        let mut spread = all.clone();
        spread.insert(
            "codex:t4".into(),
            fact("t4", Some("delta"), Some("Nimbus notes"), None),
        );
        spread.insert(
            "codex:t5".into(),
            fact("t5", Some("delta"), Some("Nimbus notes"), None),
        );
        spread.insert(
            "codex:t6".into(),
            fact("t6", Some("delta"), Some("Nimbus notes"), None),
        );
        assert_eq!(derived_names(&spread).get("prj_halo"), None);
    }

    #[test]
    fn a_derived_name_needs_spread_a_lead_over_the_key_and_a_minority_project() {
        let row = |id: &str, key: &str, root: &str, request: &str| {
            let mut c = fact(id, Some(key), Some(request), None);
            c.root = format!("codex:{root}");
            (format!("codex:{id}"), c)
        };
        let ids =
            |prefix: &str, n: usize| (0..n).map(|i| format!("{prefix}{i}")).collect::<Vec<_>>();
        // Quiet projects, so no single one holds most conversations.
        let mut all: BTreeMap<String, ConversationFacts> = ids("q", 20)
            .into_iter()
            .map(|id| row(&id, &format!("quiet-{id}"), &id, "Do it"))
            .collect();
        // One session's fan of sub-agents, all told the same thing.
        all.extend(
            ids("f", 5)
                .into_iter()
                .map(|id| row(&id, "prj_fan", "fan", "Read VEGA_GOAL.md")),
        );
        // The same evidence over separate sessions names its project.
        all.extend(
            ids("s", 3)
                .into_iter()
                .map(|id| row(&id, "prj_spread", &id, "Read LYRA_GOAL.md")),
        );
        // A word said barely more often than the folder's own name.
        all.extend(
            ids("k", 3)
                .into_iter()
                .map(|id| row(&id, "lazybox", &id, "lazybox kestrel")),
        );
        all.extend([row("k3", "lazybox", "k3", "kestrel")]);
        // A word that is another project's folder name.
        all.extend(
            ids("a", 3)
                .into_iter()
                .map(|id| row(&id, "prj_one", &id, "Map the atlas")),
        );
        all.extend([row("a3", "atlas-app", "a3", "Do it")]);
        let names = derived_names(&all);
        assert_eq!(names.get("prj_spread").map(String::as_str), Some("Lyra"));
        for key in ["prj_fan", "lazybox", "prj_one"] {
            assert_eq!(names.get(key), None, "{key}");
        }
        // Half again as often as the folder's name is a name.
        all.extend(
            ids("m", 2)
                .into_iter()
                .map(|id| row(&id, "lazybox", &id, "kestrel")),
        );
        assert_eq!(
            derived_names(&all).get("lazybox").map(String::as_str),
            Some("Kestrel")
        );
        // Where one project holds most conversations, every word it uses
        // clears 60%; it must also be twice as concentrated as the project.
        let mut big: BTreeMap<String, ConversationFacts> = ids("b", 10)
            .into_iter()
            .map(|id| row(&id, "prj_big", &id, "Polish the screen"))
            .collect();
        big.extend([row("x0", "small", "x0", "Do it")]);
        assert_eq!(derived_names(&big).get("prj_big"), None);
        // Addresses, handles, time zones and runs joined to digits are no words.
        assert_eq!(
            latin_words(
                "Open https://x.test/handle/Repo with @handle TZ=Asia/Seoul hunter2 v1beta MIRA_GOAL.md Nimbus의"
            )
            .collect::<Vec<_>>(),
            ["Open", "with", "MIRA", "GOAL", "Nimbus"]
        );
    }

    #[test]
    fn the_persons_names_file_titles_a_workstream_and_is_only_read() {
        let (vault, _home) = vault_with_sessions();
        let root = vault.path().canonicalize().unwrap();
        let names = crate::vault_dir::dir(&root).join(NAMES_FILE);
        let body = serde_json::json!({
            "Beta": "Beta **Planner**",
            "alpha": 7,
            "gamma": "x".repeat(81),
            "delta": "mail someone@example.com",
            "missing": "Not a workstream",
        })
        .to_string();
        std::fs::write(&names, &body).unwrap();
        assert!(reconcile(&root) > 0);
        let known = facts(&root);
        assert_eq!(known["workstreams"]["beta"]["title"], "Beta Planner");
        assert_eq!(known["workstreams"]["beta"]["title_source"], "user");
        assert_eq!(known["workstreams"]["alpha"]["title_source"], "key");
        let page = std::fs::read_to_string(root.join("wiki/workstreams/beta.md")).unwrap();
        assert!(page.starts_with("---\ntitle: \"Beta Planner\"\n"), "{page}");
        assert_eq!(
            plan(&root, &default_codex_homes()).unwrap().names_ignored,
            3
        );
        assert_eq!(std::fs::read_to_string(&names).unwrap(), body);
        // A file that is not a JSON object is counted once; the key returns.
        std::fs::write(&names, "[\"Beta\"]").unwrap();
        assert!(reconcile(&root) > 0);
        assert_eq!(facts(&root)["workstreams"]["beta"]["title_source"], "key");
        assert_eq!(
            plan(&root, &default_codex_homes()).unwrap().names_ignored,
            1
        );
        // Saved with a byte order mark, as Windows editors may.
        std::fs::write(&names, format!("\u{feff}{body}")).unwrap();
        assert!(reconcile(&root) > 0);
        assert_eq!(facts(&root)["workstreams"]["beta"]["title_source"], "user");
        assert_eq!(
            plan(&root, &default_codex_homes()).unwrap().names_ignored,
            3
        );
    }

    #[test]
    fn a_page_row_asks_the_latest_request_and_prefers_the_persons_thread() {
        let member = |id: &str, root: &str, subagent: bool, epoch: i64, report: Option<&str>| {
            let request = format!("Ask {id}");
            let mut c = fact(
                id,
                Some("alpha"),
                Some(request.as_str()),
                report.map(|text| (epoch, text)),
            );
            (c.root, c.subagent, c.first_epoch, c.last_epoch) =
                (format!("codex:{root}"), subagent, epoch, epoch + 60);
            (format!("codex:{id}"), c)
        };
        // A parent never imported whose answer a sub-agent copied in when it
        // forked: that copy before any sub-agent's own, later report.
        let mut copied = member("w2", "lost", true, 1_760_000_000, None);
        copied.1.parent_report = Some(Report {
            epoch: 1_759_000_000,
            open: Vec::new(),
            text: "What came back before".into(),
        });
        // The latest sub-agent was given nothing to read: an earlier request.
        let mut blank = member("v3", "gone", true, 1_780_200_000, None);
        blank.1.request = Some("  ".into());
        // A program's sessions: counted on the page, never a row.
        let mut helper = member("h1", "h1", false, 1_795_000_000, Some("Helped"));
        helper.1.automated = true;
        let mut helper_sub = member("h2", "h1", true, 1_795_000_100, Some("Helped more"));
        helper_sub.1.automated = true;
        let all = BTreeMap::from([
            // The person's thread first, although its sub-agent asked later.
            member("p1", "p1", false, 1_790_000_000, Some("What came back")),
            member("q1", "p1", true, 1_790_100_000, Some("Sub-agent detail")),
            // A parent never imported: sub-agents only; the latest request
            // and the latest report.
            member("v1", "gone", true, 1_780_000_000, Some("Earlier detail")),
            member("v2", "gone", true, 1_780_100_000, Some("Later detail")),
            blank,
            // No report: the link goes to the newest conversation.
            member("n1", "absent", true, 1_770_000_000, None),
            member("n2", "absent", true, 1_770_100_000, None),
            member("w1", "lost", true, 1_760_100_000, Some("Inner detail")),
            copied,
            // Nothing asked or reported (a helper that named a branch): no row.
            ("codex:e1".into(), fact("e1", Some("alpha"), None, None)),
            helper,
            helper_sub,
        ]);
        let workstream = WorkstreamFacts {
            conversations: all.len(),
            first_epoch: 1_760_000_000,
            last_epoch: 1_790_100_060,
            open_items: Vec::new(),
            page: format!("{PAGE_DIR}alpha.md"),
            roots: 5,
            summary: None,
            title: "Alpha".into(),
            title_source: TitleSource::Key,
        };
        let page = render_page("alpha", &workstream, &all);
        let rows: Vec<&str> = page.lines().filter(|line| line.starts_with("- ")).collect();
        let raw = |id: &str| format!("[[raw/conversations/codex/codex-{id}-0123456789abcdef]]");
        assert_eq!(rows.len(), 4, "{page}");
        assert!(
            rows[3].ends_with(&format!(" · Ask w1 → What came back before {}", raw("w2"))),
            "{}",
            rows[3]
        );
        assert!(
            rows[0].ends_with(&format!(" · Ask p1 → What came back {}", raw("p1"))),
            "{}",
            rows[0]
        );
        assert!(
            rows[1].ends_with(&format!(" · Ask v2 → Later detail {}", raw("v2"))),
            "{}",
            rows[1]
        );
        assert!(
            rows[2].ends_with(&format!(" · Ask n2 {}", raw("n2"))),
            "{}",
            rows[2]
        );
        assert!(!page.contains("Helped"), "{page}");
        assert!(
            page.ends_with(&format!("\n\n{AUTOMATED_LABEL}: 1\n\n{MARKER_CLOSE}\n")),
            "{page}"
        );
    }

    #[test]
    fn facts_of_another_version_are_read_again_in_full() {
        let (vault, _home) = vault_with_sessions();
        let root = vault.path().canonicalize().unwrap();
        let expected = std::fs::read(facts_path(&root)).unwrap();
        // As version 3 wrote them: no summary or open items, and no open
        // lines on a report.
        let mut old = facts(&root);
        old["version"] = 3.into();
        for workstream in old["workstreams"].as_object_mut().unwrap().values_mut() {
            let workstream = workstream.as_object_mut().unwrap();
            workstream.remove("summary");
            workstream.remove("open_items");
        }
        old["conversations"]["claude-code:cc-1"]["request"] = "Stale request [Image #1]".into();
        std::fs::write(
            facts_path(&root),
            serde_json::to_string_pretty(&old).unwrap(),
        )
        .unwrap();
        let again = plan(&root, &default_codex_homes()).unwrap();
        assert_eq!(again.recomputed, 3, "every conversation is read again");
        assert!(reconcile(&root) > 0);
        assert_eq!(std::fs::read(facts_path(&root)).unwrap(), expected);
    }

    #[test]
    #[ignore = "reads the vault named by MYCO_WORKSTREAMS_VAULT and this machine's Codex stores; writes nothing"]
    fn reconcile_dry_run_from_env() {
        let vault = std::env::var_os("MYCO_WORKSTREAMS_VAULT")
            .expect("MYCO_WORKSTREAMS_VAULT names the vault to measure");
        let root = PathBuf::from(vault).canonicalize().unwrap();
        let started = std::time::Instant::now();
        let plan = plan(&root, &codex_homes()).unwrap();
        let elapsed_ms = started.elapsed().as_millis();
        let mut by_source = BTreeMap::new();
        for conversation in plan.facts.conversations.values() {
            let label = serde_json::to_value(conversation.cwd_source).unwrap();
            *by_source
                .entry(label.as_str().unwrap_or("?").to_string())
                .or_insert(0usize) += 1;
        }
        println!(
            "workstreams={} conversations={} by_cwd_source={by_source:?} unassigned={} \
             recomputed={} unread={} store_failures={} names_ignored={} elapsed_ms={elapsed_ms}",
            plan.facts.workstreams.len(),
            plan.facts.conversations.len(),
            plan.facts.unassigned,
            plan.recomputed,
            plan.unread,
            plan.store_failures,
            plan.names_ignored,
        );
        let mut ranked: Vec<_> = plan.facts.workstreams.iter().collect();
        ranked.sort_by(|a, b| b.1.conversations.cmp(&a.1.conversations).then(a.0.cmp(b.0)));
        for (key, workstream) in ranked.into_iter().filter(|(_, w)| w.conversations >= 10) {
            let source = serde_json::to_value(workstream.title_source).unwrap();
            println!(
                "workstream key={key:?} conversations={} roots={} title={:?} title_source={}",
                workstream.conversations,
                workstream.roots,
                workstream.title,
                source.as_str().unwrap_or("?"),
            );
        }
    }
}
