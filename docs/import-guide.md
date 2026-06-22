# Import Guide — Getting Conversations & Sessions Into Memex

This guide shows you, step by step, how to pull your AI conversations and coding
sessions into a Memex vault: **ChatGPT**, **Claude.ai**, **Claude Code**, and
**Codex CLI**. Every path is the same — *drop a file in one folder and walk away*.

> [!important] `raw/` is immutable. Nothing here ever edits it.
> Memex treats `<vault>/raw/` as **immutable source-of-truth**. You drop exports
> into a **staging inbox** (`<vault>/raw/imports/`), and Memex writes the parsed,
> normalized transcripts into `raw/conversations/...` — it **never overwrites,
> edits, or deletes** an existing `raw/` file. Re-dropping the same export is a
> safe no-op (see [Idempotency](#idempotency--re-dropping-is-safe)). If a source
> is wrong, the correction goes to a `wiki/` page, never back into `raw/`.

---

## The drop folder

Everything you export lands in **one** place:

```
<vault>/raw/imports/
```

`<vault>` is your Memex vault root (the folder containing `raw/`, `wiki/`,
`ingest-reports/`). The default is:

| OS | Default `<vault>` |
|----|-------------------|
| macOS | `~/Documents/Memex` |
| Windows | `%USERPROFILE%\Documents\Memex` |
| Linux | `~/Documents/Memex` |

To find or change it, open the app → **Settings → Account → current vault path →
Change…**. If you use a different folder, substitute it for `<vault>` everywhere
below.

Create the drop folder once:

```bash
mkdir -p ~/Documents/Memex/raw/imports
```

> [!note] The inbox is *staging*, not immutable content.
> `raw/imports/` is where you **drop** raw exports. Memex parses each file and
> writes the canonical transcript to `raw/conversations/<source>/<id>.md`. The
> dropped export is consumed (moved out of the inbox) once processed, so the
> inbox doubles as your "pending" tray. Your immutable wiki sources live under
> `raw/conversations/`, not in `imports/`.

---

## 1. ChatGPT (`conversations.json`)

### Export your data

1. Open [chatgpt.com](https://chatgpt.com) in a browser and sign in.
2. Click your profile (top-right) → **Settings**.
3. Go to **Data controls** → **Export data** → **Export**.
4. Confirm in the dialog. OpenAI emails you a download link (usually within
   minutes, sometimes up to 24 h). The link expires, so download promptly.
5. You receive a ZIP, e.g. `chatgpt-export-2026-06-08.zip`. Unzip it.

### Where `conversations.json` lands

Inside the unzipped folder you'll find:

```
chatgpt-export-2026-06-08/
├── conversations.json     ← this is the one you want (all your chats)
├── chat.html
├── message_feedback.json
├── model_comparisons.json
└── user.json
```

`conversations.json` is a **JSON array** of every conversation. That single file
is all Memex needs.

### Drop it in

```bash
cp ~/Downloads/chatgpt-export-2026-06-08/conversations.json \
   ~/Documents/Memex/raw/imports/chatgpt-conversations.json
```

> [!tip] Rename so you can tell sources apart.
> The file is generically named `conversations.json` for both ChatGPT and
> Claude. Renaming the dropped copy to `chatgpt-conversations.json` keeps your
> inbox readable. Memex auto-detects the source from the file's **contents**, so
> the name is only for your own sanity — but it helps.

That's it. Memex picks it up (see [What happens next](#what-memex-does-after-the-drop)).

---

## 2. Claude.ai (`conversations.json`)

### Export your data

1. Open [claude.ai](https://claude.ai) and sign in.
2. Click your name / initials (bottom-left) → **Settings**.
3. Go to **Privacy** (or **Account → Data**, depending on plan) → **Export
   data**.
4. Confirm. Anthropic emails you a download link. Download and unzip.
5. You receive a ZIP containing a `conversations.json` (some builds ship it as a
   one-object-per-line `.jsonl` instead — both work).

### Where it lands

```
claude-export/
├── conversations.json     ← (or conversations.jsonl)
├── projects.json
└── users.json
```

### Drop it in

```bash
cp ~/Downloads/claude-export/conversations.json \
   ~/Documents/Memex/raw/imports/claude-conversations.json
```

> [!warning] Don't overwrite the ChatGPT file.
> Both providers call the file `conversations.json`. If you dropped the ChatGPT
> one as `conversations.json`, copying the Claude one with the same name will
> clobber it **inside your Downloads/inbox** before Memex even sees it. Always
> give them distinct names (`chatgpt-conversations.json`,
> `claude-conversations.json`). Memex itself never overwrites `raw/` — but your
> own `cp` can overwrite a file in the inbox, so name them apart.

---

## 3. Claude Code sessions (`~/.claude/projects/.../*.jsonl`)

Claude Code stores every session as an **append-only JSONL** file on your disk —
no export step needed. They live at:

```
~/.claude/projects/<encoded-project>/<sessionId>.jsonl
```

`<encoded-project>` is the project's absolute path with every `/` and `.`
replaced by `-`. For example, work done in `/Users/yoo/project/Memex` lives under:

```
~/.claude/projects/-Users-yoo-project-Memex/
```

Each `<sessionId>.jsonl` (a UUID) is one session.

### Find the sessions you want

List your projects:

```bash
ls -1 ~/.claude/projects/
```

List the sessions for one project, newest last:

```bash
ls -lt ~/.claude/projects/-Users-yoo-project-Memex/
```

(Drop in the encoded name from the previous command for your own project.)

### Copy them into the drop folder

**One session:**

```bash
cp ~/.claude/projects/-Users-yoo-project-Memex/<sessionId>.jsonl \
   ~/Documents/Memex/raw/imports/
```

**All sessions for one project:**

```bash
cp ~/.claude/projects/-Users-yoo-project-Memex/*.jsonl \
   ~/Documents/Memex/raw/imports/
```

**Everything, across all projects** (recursive copy, flattening into the inbox):

```bash
find ~/.claude/projects -name '*.jsonl' \
  -exec cp {} ~/Documents/Memex/raw/imports/ \;
```

> [!note] Copy, don't move.
> Use `cp`, never `mv`. Leaving the originals in `~/.claude/projects/` means
> Claude Code keeps working normally, and active sessions can be re-imported
> later as updates. Memex reads the copies in the inbox.

> [!tip] Coding sessions become structured pages, not raw dumps.
> Memex extracts the *problem solved*, the repo/files touched, and the tools
> used — emitting `entity` pages (repos, files) and `technique`/`analysis` pages
> — rather than pasting the whole turn-by-turn log. Sidechain/sub-agent and
> internal-meta lines are filtered out automatically.

---

## 4. Codex CLI sessions (`~/.codex/`)

Codex CLI keeps its data under `$CODEX_HOME` (default `~/.codex/`). Two things
are useful:

```
~/.codex/
├── history.jsonl                                  ← flat global prompt log
└── sessions/
    └── YYYY/MM/DD/
        └── rollout-<ISO-ts>-<uuid>.jsonl          ← one session each
```

- **`sessions/.../rollout-*.jsonl`** — the full session transcripts (what you
  want for wikification).
- **`history.jsonl`** — a flat log of your prompts only; handy as a search/title
  aid. Optional. (May be empty if you set `history=none`.)

### Find recent sessions

```bash
find ~/.codex/sessions -name 'rollout-*.jsonl' | sort | tail -20
```

### Copy them into the drop folder

**One session:**

```bash
cp ~/.codex/sessions/2026/06/08/rollout-<ts>-<uuid>.jsonl \
   ~/Documents/Memex/raw/imports/
```

**All sessions:**

```bash
find ~/.codex/sessions -name 'rollout-*.jsonl' \
  -exec cp {} ~/Documents/Memex/raw/imports/ \;
```

**The global prompt history too (optional):**

```bash
cp ~/.codex/history.jsonl ~/Documents/Memex/raw/imports/codex-history.jsonl
```

Same rule as Claude Code: **`cp`, not `mv`** — keep your originals in place.

---

## What Memex does after the drop

Once a file settles in `<vault>/raw/imports/`, the pipeline runs end to end:

1. **Auto-detect** — Memex inspects the file's *contents* (not just its name) and
   classifies the source: ChatGPT array, Claude export, Claude Code JSONL, or
   Codex rollout. Date formats, message trees, and role names are normalized per
   source (e.g. Claude's `human` → `user`, ChatGPT's `current_node` thread is
   walked to the root).
2. **Normalize → `raw/`** — each conversation/session is serialized to one clean
   markdown transcript at:

   ```
   <vault>/raw/conversations/<source>/<id>.md
   ```

   where `<source>` ∈ `chatgpt | claude | claude-code | codex` and `<id>` is the
   vendor's stable id (conversation UUID / `sessionId`). **This write is
   guarded**: if a file for that id already exists, Memex refuses to overwrite it
   — `raw/` stays immutable. The consumed file leaves `raw/imports/`.
3. **Ingest (chunk → extract → merge → cite)** — the transcript is split on
   speaker-turn boundaries, facts and entities are extracted, then matched
   against your existing wiki. Each new fact is decided **ADD / UPDATE / MERGE /
   NOOP** so the same idea from two chats converges onto one page instead of
   duplicating.
4. **Wiki pages with citations** — `wiki/` pages are created or updated with
   inline citations pointing back at the exact source:

   ```
   This was decided in the 2026-03 planning chat.[^src-conv-<id>]

   [^src-conv-<id>]: [[source-conv-<id>]]
   ```

   Coding sessions cite `[^src-session-<sessionId>]`. Every citation resolves to
   the transcript page under `raw/conversations/...`, matching the vault's
   citation contract.
5. **Commit + report** — related page writes are grouped into a single
   `ingest: <title>` commit, a WHY report is written to `ingest-reports/`, and
   `wiki/index.md` + `wiki/log.md` are updated last.

> [!note] Contradictions are handled, not clobbered.
> If a new conversation contradicts an existing claim, Memex applies the vault's
> contradiction policy — moving the old claim to `## Historical claims`, opening
> a `## Disputed` section, or marking the old source `superseded` — with date
> stamps, rather than silently overwriting.

---

## Idempotency — re-dropping is safe

**You can re-drop the same export as many times as you like.** Memex keeps a
dedup ledger at:

```
<vault>/.memex/ledger.json   (gitignored)
```

It uses a two-level key:

1. **`<source>:<id>`** — the vendor's conversation/session id. If it's already
   imported, the drop is skipped: a no-op.
2. **Content SHA-256** of the normalized transcript — catches the *same*
   conversation re-exported under a different filename, and detects *edits*. A
   changed transcript (e.g. an active session that grew, or a chat you continued)
   re-ingests as an **UPDATE** to the existing page — never a duplicate.

Practical consequences:

- **Re-export ChatGPT/Claude monthly and re-drop the whole file** — only new and
  changed conversations are processed; everything already imported is skipped.
- **Re-copy your `~/.claude/projects` and `~/.codex/sessions`** repeatedly — same
  story. Growing sessions update in place.
- Page writes are **replace-over-page**, never blind append, so a crashed or
  partial run simply converges on the next drop. The import is resumable.

> [!important] Immutability + idempotency together
> Because `raw/` writes are pre-existence-checked **and** the ledger skips known
> ids, dropping the same export twice can neither corrupt `raw/` nor double-count
> your wiki. This is what makes "drop a folder and forget it" safe.

---

## Quick reference

| Source | Where it comes from | Drop into | Detected id |
|--------|--------------------|-----------|-------------|
| ChatGPT | Settings → Data controls → Export → `conversations.json` | `<vault>/raw/imports/` | conversation UUID |
| Claude.ai | Settings → Privacy → Export → `conversations.json`/`.jsonl` | `<vault>/raw/imports/` | conversation `uuid` |
| Claude Code | `~/.claude/projects/<encoded-project>/<sessionId>.jsonl` (copy) | `<vault>/raw/imports/` | `sessionId` |
| Codex CLI | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` (copy) | `<vault>/raw/imports/` | session UUID |

| Folder | Mutable? | Purpose |
|--------|----------|---------|
| `<vault>/raw/imports/` | yes (staging) | where **you** drop exports; consumed after parse |
| `<vault>/raw/conversations/` | **no — immutable** | normalized transcripts; never edited/overwritten |
| `<vault>/wiki/` | yes (Memex-owned) | generated pages with citations |
| `<vault>/.memex/ledger.json` | yes (gitignored) | dedup ledger for idempotent re-drops |

> [!warning] The one rule that never bends
> `raw/` is immutable. You drop into `raw/imports/`; Memex writes
> `raw/conversations/`; nobody edits or deletes existing `raw/` files. Fixes go
> to `wiki/`. Re-dropping is always safe.
