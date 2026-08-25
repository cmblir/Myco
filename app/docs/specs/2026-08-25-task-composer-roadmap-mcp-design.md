# Task composer, roadmap pages, MCP task tools

Status: approved by owner 2026-08-25 (category storage, roadmap shape, MCP
tool set, composer shape — each chosen explicitly; recorded under
"Decisions").

## Why

Adding a task is one line — title and a due date into today's daily note.
There is no way to say what kind of work it is, which project it belongs to,
or to put it anywhere other than the daily note. Development work in
particular runs off roadmaps: an ordered list of milestones per project that
a coding session should be able to read, check off, and extend — from inside
the session, over MCP — without opening the app.

What already exists (verified at HEAD, do not rebuild): the full scheduling
vocabulary on the task line (`🛫 ⏳ 📅 ✅ 🔁 ⏱ !pN`, taskLine.ts); the detail
panel, board, calendar bars, month hub pages; `writeTaskStatus` with ✅
stamping and recurrence insertion; the Rust scanner (`tasks.rs`) that reads
every checkbox in the vault and passes unknown tokens through verbatim; the
app-hosted MCP server (`mcp_native.rs`, 28 tools) with `read_page`,
`update_page`, `create_page`; `Adjacency.tags` (tag → pages) and the file
tree, both already in the frontend stores.

## Decisions (owner-approved)

1. **Categories are `#tags`** on the task line. Obsidian-compatible, zero new
   syntax, and the existing tag index is the autocomplete source — "is this
   related to an existing category" is answered by suggesting from tags the
   vault already has.
2. **A roadmap is a page**: `wiki/roadmaps/<slug>.md`, ordinary wiki page —
   `## milestone` headings with checkbox items under them. It is a graph node
   like any page, and its items surface in the Tasks list/calendar through
   the existing scanner with no new plumbing.
3. **MCP gets list + check + add** (`list_tasks`, `set_task_status`,
   `add_task`) on the app-hosted server, so a dev session can read its
   project's roadmap (existing `read_page`), check items off as work lands,
   and append follow-ups it discovers.
4. **Quick add stays quick**; a "자세히" toggle expands the same form into the
   full field set. An always-on full form would tax the common case (a
   one-line memo task).

"Tie sessions to the roadmap" means exactly this MCP surface — a session
checks and extends the roadmap through these tools. No session↔task link
records are stored.

## Data model

The task line stays the whole truth. Two conventions gain first-class
display, not new storage:

- category: `#dev`, `#design` … anywhere in the task text
- project: `[[project-page]]` anywhere in the task text

`lib/taskTokens.ts` (new, pure): `extractTags(text)` / `extractLinks(text)`
plus `stripTokens(text)` for display — list rows, board cards and the detail
panel show tags/links as chips instead of leaving them inline in the title.
`parseTaskMeta` itself is untouched: its `title` keeps carrying the raw text
minus scheduling markers, and callers that want chips strip further.

A roadmap page is:

```markdown
---
title: myco Q4
type: overview
source_type: primary
confidence: high
status: active
created: 2026-08-25
---

# myco Q4 로드맵

## M1 — trust surfaces
- [x] reader badge #dev [[myco-q4-roadmap]] ✅ 2026-08-20
- [ ] provenance panel #dev 📅 2026-09-04

## M2 — resurfacing
- [ ] reunion tuning #research
```

`type: overview` keeps it out of the wiki lint's required-citation rules
(META_TYPES skip, validator.rs) — same choice as the month hubs.

## Modules

| File | Responsibility |
|---|---|
| `lib/taskTokens.ts` (new) | extract/strip `#tags` and `[[links]]`; pure |
| `lib/roadmap.ts` (new) | list `wiki/roadmaps/*.md`; parse one into `{title, milestones: [{heading, tasks, done, total}]}`; `newRoadmapContent(title)` seed |
| `components/TaskComposer.tsx` (new) | quick row + 자세히 expansion; replaces the inline add form in PageTasks |
| `components/TaskRoadmap.tsx` (new) | the 로드맵 view: per-page cards, milestone checklists, progress bars |
| `pages/PageTasks.tsx` | 4th view tab; composer wiring; target-note add path |
| `src-tauri/src/tasks.rs` | `set_line_status` / `append_task_line` Rust helpers + unit tests |
| `src-tauri/src/mcp_native.rs` | the three tools |

## Composer

Collapsed: today's behavior exactly (title + DatePicker + 추가 → daily note).

Expanded (자세히):
- **카테고리** — chip input; suggestions = `Object.keys(adjacency.tags)`
  filtered by contains-match; free text allowed (a new tag is legal).
  Written as `#tag` tokens after the title.
- **프로젝트** — same chip input over wiki page stems (from the file tree);
  written as `[[stem]]`.
- **대상 노트** — segmented: 오늘 데일리 (default) | each `wiki/roadmaps/*`
  page | ＋새 로드맵. New roadmap prompts for a title, writes
  `wiki/roadmaps/<slug>.md` from `newRoadmapContent`, then targets it.
  Appending to a roadmap goes under its LAST milestone heading (end of
  file); milestone-precise placement is done in the note itself.
- start / scheduled / due (three DatePickers), priority, estimate,
  recurrence — same widgets as TaskDetail.
- 추가 builds one line via `serializeTaskText` (+ tag/link tokens in the
  title) and appends to the chosen note with the existing `appendTaskLine`.

Field order in the written line: title, #tags, [[links]], then the fixed
scheduling-marker order — tags/links are part of the "title" as far as
taskLine.ts is concerned, so round-trips are stable by construction.

## Roadmap view

4th tab on the Tasks page. `roadmap.ts` lists `wiki/roadmaps/*.md` from the
tree, reads each (they are few), and renders per page: title, aggregate
progress bar (done/total), then each `## milestone` as a section with its
checkbox items and per-milestone progress. Items reuse TaskRow semantics:
checkbox toggles through the existing `writeTaskStatus` (✅ stamp +
recurrence, stale guard), the title opens the existing TaskDetail panel.
Empty state: no roadmaps yet → one-line hint + 새 로드맵 button (same flow
as the composer's).

No timeline lanes — the month calendar already owns the time axis; a dated
roadmap item appears there via the scanner with zero extra code.

## MCP tools (mcp_native.rs)

All three confine paths to the active vault and refuse `raw/`.

- `list_tasks { project?, tag?, status?, path_prefix? }` — runs the existing
  scanner, filters: `project` → text contains `[[project]]`, `tag` → text
  contains `#tag`, `status` → exact mark, `path_prefix` → page path prefix
  (`wiki/roadmaps/` = "the roadmap"). Returns
  `{page, line, status, text}` rows.
- `set_task_status { page, line, status, expect_text }` — reads the file,
  requires line `line` to be a checkbox whose text equals `expect_text`
  (the stale guard, same contract as the app's writers: a mismatch means
  the file changed since the caller's read — refuse, never guess). Rewrites
  the mark; on `done` appends `✅ <today>` (and drops it when leaving done).
  A line carrying `🔁` is still checked but the result carries
  `"warning": "recurring task — the next occurrence is inserted only when
  completed in the app"`.
  <!-- ponytail: recurrence advance is TS-only (taskRecurrence.ts); port to
  Rust if MCP check-off of recurring tasks becomes common -->
- `add_task { page, text, due? }` — appends a checkbox line to `page`
  (creating `wiki/roadmaps/` pages is `create_page`'s job, not this tool's).
  `due` becomes `📅 <due>`. Tags/links ride inside `text` — they are just
  text.

## Errors and edge cases

- MCP `set_task_status` on a non-checkbox line or mismatched `expect_text` →
  error result naming the current line text, nothing written.
- MCP writes to `raw/` or outside the vault → refused (existing confine).
- Composer with a roadmap target whose file vanished → error line, task not
  written elsewhere silently.
- A tag chip that duplicates one already typed in the title is not doubled:
  the composer dedupes tokens before serializing.
- Roadmap view with an unparseable page (no checkboxes) → shown with 0/0,
  not hidden.

## Testing

TS units: taskTokens (extract/strip/dedupe, Korean tags), roadmap parse
(milestone grouping, progress counts, no-heading page), composer line
building (tag+link+marker order round-trips through parseTaskMeta).
Rust: `set_line_status` (mark rewrite, ✅ stamp add/remove, stale mismatch,
non-checkbox refusal), `append_task_line`, MCP arg validation.
Browser (`?mock=1`): expand composer, add with category+project+roadmap
target, roadmap tab renders progress, check-off round-trips.
i18n parity (en/ko/ja) stays green.

## Not in scope

Timeline lane view (declined at approval), Rust-side recurrence insertion
(warned instead), session↔task link records, milestone-precise append
placement, tag renaming/merging, MCP tools on the standalone Python server
(`mcp-server/` — app-hosted server only, where the dev sessions live).
