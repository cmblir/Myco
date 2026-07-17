# Import Guide — Getting Sources Into Memex

How to get material into a Memex vault, and — just as importantly — what does
**not** work yet.

> [!warning] Read this first: bulk conversation import is not built.
> An earlier version of this guide described a full pipeline for ChatGPT /
> Claude / Claude Code / Codex exports: a `raw/imports/` drop folder,
> source auto-detection, normalized transcripts at `raw/conversations/<id>.md`,
> and a dedup ledger for safe re-drops.
>
> **None of that exists.** No code reads `raw/imports/`, there is no conversation
> parser, and there is no ledger. The guide was written ahead of the feature and
> never marked as such. If you followed it, nothing happened to your files —
> they are still sitting where you copied them.
>
> This page now describes only what actually runs. The export steps below are
> real and worth doing — they are vendor-side, and you will want the files when
> the parsers land.

---

## What works today

One source file at a time, wikified by the model:

1. You put a source into the vault's inbox — `<vault>/_inbox/` — or paste it
   straight into the app (**Ingest a source**).
2. The source is copied to `raw/<slug>.md`, which becomes the citable original.
3. The model reads it with the vault's `CLAUDE.md` as its instructions and
   writes into `wiki/`, with citations pointing back at the `raw/` copy.
4. An account of the run lands in `ingest-reports/`.

That pipeline is solid. What is missing is everything *upstream* of it: nothing
splits one big vendor export into per-conversation sources, so a 200 MB
`conversations.json` is one enormous "source" rather than 1,400 of them.

### The inbox is markdown-only in the app

This surprises people, so it is worth being blunt about. The two things that
drain `_inbox/` accept **different file types**:

| You drop | App (auto-ingest, while open) | `automation/autoingest.py` (headless) |
|---|---|---|
| `.md` `.markdown` | ✅ | ✅ |
| `.txt` `.csv` `.tsv` `.json` `.yaml` `.html` | ❌ **invisible** | ✅ read as text |
| `.pdf` `.xlsx` `.ods` | ❌ **invisible** | ✅ via the Memex binary (`--app-bin`) |
| `.jsonl` | ❌ **invisible** | ❌ **not handled** |

The app's file listing is markdown-only (`vault::walk_dir` keeps only `.md`), so
a non-`.md` file in `_inbox/` is not ignored on purpose — it is not seen at all.
The daemon is the broader path, and even it does not know `.jsonl`.

**Consequences for the exports below:** a ChatGPT/Claude `conversations.json`
can only be consumed by the daemon, and only as one raw blob. Claude Code and
Codex sessions are `.jsonl` and are consumed by **nothing**. Copying them into
`_inbox/` today does nothing at all.

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

Tracked, not promised. Roughly, in order:

1. **Conversation parsers** — split one vendor export into N per-conversation
   sources in `_inbox/`. This is the whole feature; everything else is a shell
   around it. Undecided: whether a `.jsonl` session is worth parsing per-session
   or per-project.
2. **A dedup ledger** — so re-dropping a monthly export skips what is already
   imported instead of producing `x-2.md`, `x-3.md`. Today re-dropping the same
   file really does duplicate.
3. **Bulk-import UX** — two-level progress and retry-failed, once there is a
   batch to run.
4. **Secret scanning on the way in** — today `scan_secrets` only guards the MCP
   path, so a source arriving through the app is not scanned. This matters much
   more once thousands of session transcripts land unattended in a git-committed
   tree.

When these land, this page gets the drop-a-folder-and-forget-it story it
promised prematurely.

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
| ChatGPT | Settings → Data controls → Export | ⚠️ daemon only, as one raw blob |
| Claude.ai | Settings → Privacy → Export | ⚠️ daemon only, as one raw blob |
| Claude Code | `~/.claude/projects/…/*.jsonl` (already on disk) | ❌ `.jsonl` is handled by nothing |
| Codex CLI | `~/.codex/sessions/…/rollout-*.jsonl` | ❌ `.jsonl` is handled by nothing |
| A markdown note | — | ✅ |
| PDF / spreadsheet / audio / video | — | ✅ (app, or daemon with `--app-bin`) |
