# Import Guide — Getting Sources Into Memex

How to get material into a Memex vault.

> [!note] Conversation import works now — via Settings? No: **Ingest → Import a
> conversation**.
> Pick a ChatGPT export, a Claude.ai export, or a Claude Code / Codex session,
> and Memex parses it, drops each conversation into `_inbox/` as a source doc,
> and the normal ingest pipeline turns them into wiki pages. A conversation whose
> text looks like it contains a secret (an API key, a token) is held back and
> reported, never written. Re-importing the same export is safe — a dedup ledger
> skips conversations already imported, so only new and changed ones are added.
>
> One caveat: the Claude.ai parser is written to Anthropic's documented export
> format but has not been checked against a real export yet, so verify the result
> on your first Claude.ai import.
>
> Older versions of this guide described a `raw/imports/` drop folder writing to
> `raw/conversations/`. That never existed and would have violated `raw/`
> immutability; the real drop zone is `_inbox/`, beside `raw/`.

---

## What works today

**Conversation import.** In the app, open **Ingest → Import a conversation** and
pick a file. Memex detects the format from its contents (not its name), splits it
into per-conversation source docs, scans each for secrets, and writes the clean
ones to `_inbox/` as `<source>-<id>.md`. Supported: ChatGPT `conversations.json`,
Claude Code sessions, Codex sessions. From `_inbox/` the pipeline below takes
over.

**Single-source ingest**, wikified by the model:

1. A source lands in `<vault>/_inbox/` (the importer above, the web clipper, or
   your own drop), or you paste one straight into the app (**Ingest a source**).
2. The source is copied to `raw/<slug>.md`, the citable original.
3. The model reads it with the vault's `CLAUDE.md` and writes into `wiki/`, with
   citations pointing back at the `raw/` copy.
4. An account of the run lands in `ingest-reports/`.

### `_inbox/` file types differ by drain

The importer writes `.md`, so it always works. But if you drop a raw file into
`_inbox/` YOURSELF, note the two drains accept different types:

| You drop | App (auto-ingest, while open) | `automation/autoingest.py` (headless) |
|---|---|---|
| `.md` `.markdown` | ✅ | ✅ |
| `.txt` `.csv` `.tsv` `.json` `.yaml` `.html` | ❌ **invisible** | ✅ read as text |
| `.pdf` `.xlsx` `.ods` | ❌ **invisible** | ✅ via the Memex binary (`--app-bin`) |
| `.jsonl` (raw session) | ❌ **invisible** | ❌ not handled |

The app's file listing is markdown-only (`vault::walk_dir` keeps only `.md`), so
a non-`.md` file dropped straight into `_inbox/` is not seen by the in-app pass.
This is why you use **Import a conversation** for a `.json`/`.jsonl` export rather
than copying it into `_inbox/` — the importer parses it to `.md` first.

### `raw/` is immutable — this part is true

Ingest **creates** `raw/<slug>.md` and nothing ever edits or deletes an existing
`raw/` file. Corrections go to a `wiki/` page, never back into `raw/`. That rule
holds and is enforced for the agent's tools (`vault::is_raw_path`).

The old guide had this backwards: it told you to `mkdir ~/Documents/Memex/raw/imports`
and drop exports *inside* `raw/`, then said the consumed file "leaves
`raw/imports/`" — i.e. a delete inside the immutable tree. Do not do that. The
inbox is `_inbox/`, which sits beside `raw/`, not in it.

> [!note] The app deletes a consumed inbox file; the daemon archives it.
> After a successful run the daemon moves the source to `_inbox/.archived/`,
> while the in-app pass deletes it. The content survives either way as
> `raw/<slug>.md`, but if a run half-fails the app path is the lossy one. Prefer
> the daemon for anything you cannot re-export.

---

## Where your vault is

`<vault>` is the folder containing `wiki/`, `raw/` and `ingest-reports/`. The
default:

| OS | Default `<vault>` |
|----|-------------------|
| macOS | `~/Documents/Memex` |
| Windows | `%USERPROFILE%\Documents\Memex` |
| Linux | `~/Documents/Memex` |

To find or change it: **Settings → Account → Vault path → Change…**

The inbox is created for you; if it is missing:

```bash
mkdir -p ~/Documents/Memex/_inbox
```

---

## Exporting your data

These steps are vendor-side and current. Do them now if you like — the files
keep, and they are what the importer will consume when it exists. Just know that
dropping the results into `_inbox/` today will not import them (see the table
above).

### ChatGPT (`conversations.json`)

1. Open [chatgpt.com](https://chatgpt.com) and sign in.
2. Profile (top-right) → **Settings**.
3. **Data controls** → **Export data** → **Export**.
4. Confirm. OpenAI emails a download link (usually minutes, sometimes up to
   24 h). The link expires — download promptly.
5. Unzip. Inside:

```
chatgpt-export-2026-06-08/
├── conversations.json     ← every chat, as one JSON array
├── chat.html
├── message_feedback.json
├── model_comparisons.json
└── user.json
```

`conversations.json` is the only file the importer will need.

### Claude.ai (`conversations.json`)

1. Open [claude.ai](https://claude.ai) and sign in.
2. Your name / initials (bottom-left) → **Settings**.
3. **Privacy** (or **Account → Data**, depending on plan) → **Export data**.
4. Confirm, download, unzip. Some builds ship one-object-per-line `.jsonl`
   instead of `.json`.

```
claude-export/
├── conversations.json     ← (or conversations.jsonl)
├── projects.json
└── users.json
```

> [!tip] Rename them apart.
> Both vendors call the file `conversations.json`. Keep them distinct
> (`chatgpt-conversations.json`, `claude-conversations.json`) or your own `cp`
> will clobber one with the other before Memex is anywhere near it.

### Claude Code sessions

No export step — sessions are already on your disk as append-only JSONL:

```
~/.claude/projects/<encoded-project>/<sessionId>.jsonl
```

`<encoded-project>` is the project's absolute path with `/` and `.` replaced by
`-`, so `/Users/yoo/project/Memex` lives at
`~/.claude/projects/-Users-yoo-project-Memex/`. Each `<sessionId>.jsonl` (a
UUID) is one session.

```bash
ls -1 ~/.claude/projects/                                  # your projects
ls -lt ~/.claude/projects/-Users-yoo-project-Memex/        # sessions, newest first
```

### Codex CLI sessions

Under `$CODEX_HOME` (default `~/.codex/`):

```
~/.codex/
├── history.jsonl                                  ← flat prompt log (optional)
└── sessions/YYYY/MM/DD/rollout-<ISO-ts>-<uuid>.jsonl   ← one session each
```

```bash
find ~/.codex/sessions -name 'rollout-*.jsonl' | sort | tail -20
```

> [!note] Copy, never move.
> When the importer lands, it will read copies. Leaving the originals in
> `~/.claude/projects/` and `~/.codex/sessions/` keeps both tools working and
> lets a growing session be re-imported later.

---

## Ingesting one source, today

The path that works. Either:

**In the app** — **Ingest a source**, paste a title and the text, and watch the
run. This accepts anything you can paste, plus dropped files the extractor
understands (PDF, spreadsheets, audio/video via transcription).

**Via the inbox** — write or copy a `.md` file into `<vault>/_inbox/` and turn on
auto-ingest (**Settings → Model**), or run the headless daemon:

```bash
python3 automation/autoingest.py \
  --vault ~/Documents/Memex \
  --app-bin "/Applications/Memex.app/Contents/MacOS/Memex"
```

`--app-bin` points at the installed binary and is what enables PDF/spreadsheet
extraction. See `automation/README.md`.

If you want a conversation in the wiki *now*, the honest answer is: copy the
part you care about into a markdown file and ingest that. It is manual, and it
is the only thing that works.

---

## What is planned

Tracked, not promised.

Built and shipped: the four conversation parsers (ChatGPT, Claude.ai, Claude
Code, Codex), content-based format detection, secret quarantine on the import
path, and the dedup ledger (`.memex/ledger.json`) that makes re-importing an
export idempotent. The ledger also stamps each session file's (mtime, len), so a
re-sweep skips unchanged sessions **without reading them** — the second sweep of
a large history is near-instant, and only new or grown sessions are re-parsed.
The bulk-import card shows two-level progress (file X of Y with a running
imported/skipped/failed tally) and a retry-failed list; a one-click sweep imports
every session under `~/.claude/projects` and `~/.codex/sessions`.

Still open:

1. **Verify Claude.ai on a real export** — its parser is written to the
   documented format but has not been run against a real Anthropic export.
2. **Scheduled sweep** — the sweep is one click today; running it automatically
   on a schedule (so new sessions import without any click) is not wired yet.

---

## Quick reference

| Folder | Purpose | Mutable? |
|--------|---------|----------|
| `<vault>/_inbox/` | where you drop sources; consumed after ingest | yes (staging) |
| `<vault>/_inbox/.archived/` | sources the daemon has consumed | yes |
| `<vault>/raw/` | the citable originals, written by ingest | **created, never edited or deleted** |
| `<vault>/wiki/` | generated pages with citations | yes (Memex-owned) |
| `<vault>/ingest-reports/` | what each run did, and why | yes |

| Source | Export it from | Importable today? |
|--------|---------------|-------------------|
| ChatGPT | Settings → Data controls → Export | ✅ Ingest → Import a conversation |
| Claude Code | `~/.claude/projects/…/*.jsonl` (already on disk) | ✅ Ingest → Import a conversation |
| Codex CLI | `~/.codex/sessions/…/rollout-*.jsonl` | ✅ Ingest → Import a conversation |
| Claude.ai | Settings → Privacy → Export | ✅ Ingest → Import a conversation (verify on first use) |
| A markdown note | — | ✅ |
| PDF / spreadsheet / audio / video | — | ✅ (app, or daemon with `--app-bin`) |
