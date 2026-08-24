# Task scheduling — dates, detail panel, calendar bars, graph hub

Status: approved by owner 2026-08-24 (data model, edit surface, calendar
rendering, field set, graph integration — each recorded under "Decisions").

## Why

The board reads as four columns you can only push a card between, and a task is
a point on a due date rather than work that runs from one day to another. The
whole vocabulary of scheduling — when it starts, when it is meant to be worked,
how long it takes, whether it repeats — is missing, and the only way to change
an existing task is to drag it. Clicking a task finishes it; there is nowhere to
open it.

What already exists (verified at HEAD, do not rebuild): list / board / calendar
views in `PageTasks.tsx`; four checkbox marks as board columns
(`todo` `[ ]`, `doing` `[/]`, `blocked` `[-]`, `done` `[x]`) with HTML5 drag
between them; a month grid placing tasks on their due date with drag-to-
reschedule; `@YYYY-MM-DD` due dates and `!p1..!p3` priority in `taskLine.ts`;
`monthGrid()` / `parseIsoDate()` / `today()`; a `DatePicker` component;
due-date notifications (`taskNotifier.ts`); the stale-line guard shared by every
writer (`setLineStatus` / `setLineDue` return `null` when the scanned line is no
longer a checkbox, and callers rescan instead of editing the wrong line).

**The Rust scanner needs no change.** `tasks.rs::parse_task_line` returns the
text after the checkbox verbatim (`tasks.rs:116-135`); emoji tokens pass
through untouched, and `TaskItem` already carries `status`.

## Decisions (owner-approved)

1. **Obsidian Tasks emoji syntax** for the new fields, so the vault stays
   interoperable with the plugin ecosystem rather than growing a myco-only
   dialect. Existing `@date` / `!pN` keep being read.
2. **A detail panel** is the edit surface — clicking a task opens it, a separate
   checkbox completes it. Shared by all three views.
3. **Month bars**: a task with a start and a due renders as a bar spanning its
   days, wrapping at week boundaries.
4. **Field set**: start, scheduled, due, estimate, recurrence (on top of the
   existing status and priority).
5. **Graph hub pages**: a generated `wiki/tasks/<YYYY-MM>.md` per month, in the
   same spirit as digests / rollups / maps — scheduling becomes a graph node
   through ordinary wikilinks instead of app-only state.

## Data model

One line remains the whole truth:

```
- [/] 설계 문서 쓰기 🛫 2026-08-25 ⏳ 2026-08-26 📅 2026-08-28 🔁 every week ⏱ 2d !p1
```

| Field | Token | Notes |
|---|---|---|
| start | `🛫 YYYY-MM-DD` | Obsidian Tasks |
| scheduled | `⏳ YYYY-MM-DD` | Obsidian Tasks |
| due | `📅 YYYY-MM-DD` | Obsidian Tasks; time suffix `THH:MM` allowed |
| done date | `✅ YYYY-MM-DD` | written when a task is completed |
| recurrence | `🔁 <rule>` | Obsidian Tasks, subset below |
| estimate | `⏱ 2d` | **myco-specific** — Tasks has no estimate field; the plugin leaves it in the description, so nothing breaks |
| priority | `!p1..!p3` | unchanged |

**Read wide, write narrow.** The parser accepts the emoji set *and* the legacy
`@YYYY-MM-DD` (as due) *and* Tasks' priority emoji (`🔺⏫🔼🔽⏬` → 1..3, the two
extremes clamped). The writer emits emoji dates and `!pN`. A legacy `@date`
therefore migrates to `📅` the first time that task is edited — no bulk rewrite,
no migration step, nothing changes under a user who never opens the panel.
Priority stays `!pN` on write because it already works and churning existing
lines buys nothing.

Duration is `<n>(m|h|d|w)`, e.g. `90m`, `1.5h`, `2d`. Parsed to minutes for
sorting; rendered back in the unit the user typed.

**Field order on write** is fixed — title, `🛫`, `⏳`, `📅`, `🔁`, `⏱`, `!p`,
`✅` — so repeated edits produce no diff churn and the run log stays readable.

## Modules

Logic lives in pure functions because vitest runs node-only; components stay
thin.

| File | Responsibility |
|---|---|
| `lib/taskLine.ts` (extend) | one line ⇄ `TaskMeta`; `setLineFields(content, lineNo, patch)` rewrites exactly one line, same stale-line contract as today |
| `lib/taskDuration.ts` (new) | `parseDuration` / `formatDuration` |
| `lib/taskRecurrence.ts` (new) | parse `🔁` rules; `nextOccurrence(meta, rule)` |
| `lib/taskCalendar.ts` (new) | month-grid bar layout |
| `lib/taskHub.ts` (new) | render `wiki/tasks/<YYYY-MM>.md` from scanned tasks |
| `components/TaskDetail.tsx` (new) | the panel |
| `components/TaskBoard.tsx`, `components/TaskCalendar.tsx` (extracted) | the two heavy views, moved out of `PageTasks.tsx` |
| `pages/PageTasks.tsx` (shrink) | view switch, data load, actions, panel wiring |

`PageTasks.tsx` is 696 lines before this work and both views grow here; the
project's own rule flags a split past 300–500. The extraction is part of the
change, not a side quest.

## Calendar bars

`layoutMonthBars(tasks, weeks)` is pure and returns segments:

```ts
interface BarSegment {
  key: string;        // `${page}:${line}`
  weekIndex: number;  // row in the month grid
  startCol: number;   // 0..6
  span: number;       // 1..7
  lane: number;       // stacking row inside the week
  continuesLeft: boolean;
  continuesRight: boolean;
}
```

Per week: take the tasks overlapping it, sort by start then by longer span,
then greedily place each in the first lane whose occupied columns do not
intersect. A bar clipped by the week boundary sets `continuesLeft` /
`continuesRight` and reappears in the next week's row. Three lanes render; the
rest collapse into a `+N` chip that opens a day list.

Date-combination rules, chosen so nothing is silently invented:

| Start | Due | Render |
|---|---|---|
| yes | yes | bar `start..due` |
| no | yes | point on due |
| yes | no | point on start, marked `▷` (open-ended) |
| yes | yes, but `start > due` | point on due; the detail panel shows an inline validation line. The app never "fixes" the user's dates by rewriting them |

Scheduled (`⏳`) renders as a faint marker on its day, never as a bar — it is a
hint about when to work, not a commitment.

## Detail panel

Opens on click from any view; the completion checkbox is a separate control, so
pressing a task and finishing a task stop being the same gesture. Fields:
title, status, start, scheduled, due, priority, estimate, recurrence, and a link
to the source note (`page:<abs>` route). Dates use the existing `DatePicker`.

Each committed field change calls `setLineFields` on that one line, debounced
300 ms. A `null` return means the note changed since the scan: rescan and show
the existing `tasks_stale` message rather than writing to a line number that no
longer points at that checkbox.

## Recurrence

Supported: `every day|week|month|year` and `every N days|weeks|months`. Anything
else parses to `null` and is left in the line untouched — an unrecognized rule
must not be silently dropped from the user's file.

Completing a recurring task inserts the next occurrence directly above the
completed line (Obsidian Tasks' own behavior) with every present date advanced
by the interval; the completed line keeps `[x]` and gains `✅ <today>`. Month
arithmetic clamps to the last valid day (Jan 31 + 1 month = Feb 28). A task with
a rule but no dates has nothing to advance, so its rule is inert.

## Graph hub pages

`wiki/tasks/<YYYY-MM>.md`, generated — one node per month, wikilinked into the
graph like any other page:

```markdown
---
type: overview
source_type: primary
confidence: high
status: active
---

# 2026-08 일정

<!-- myco:task-hub 2026-08 -->

## 08-25 → 08-28
- 설계 문서 쓰기 — [[myco-q4-roadmap]] · daily/2026-08-24

## 08-24
- 리뷰 반영 — [[myco-q4-roadmap]]
```

- **Regeneration is whole-file and marker-guarded.** The file is rewritten only
  when the `myco:task-hub <month>` marker is present, so a page a user has taken
  over is never clobbered.
- **Only wiki pages become wikilinks.** `daily/` is deliberately outside the
  graph, so a task living there is named as plain text, not `[[…]]` — a link
  that resolves to nothing would show up in the citation lint as a defect.
- A task is attributed to a project by writing `[[project]]` in its own text;
  the hub passes those links through, which is what puts the month node next to
  the project node in the graph.
- Generated on demand from the Tasks page (a "일정 페이지 갱신" action) and after
  a task write that changes a date. Not on a timer — this is derived data, and
  regenerating it while the user types would churn the vault and the git history.
- Months with no dated tasks generate nothing, and an existing hub for a month
  that emptied is rewritten to an explicit empty state rather than deleted.

## Errors and edge cases

- Stale line → rescan + `tasks_stale`, never a blind write (existing contract).
- Unparseable date token → treated as absent for layout, left verbatim in the
  line, flagged in the panel.
- `start > due` → rendered as a due point plus a panel warning; never auto-fixed.
- Hub write failure → surfaced in the page's error line; task edits already
  succeeded and are not rolled back.
- Recurrence with no dates → inert, no insertion.

## Testing

Pure-function units: parse/serialize round-trip (emoji, legacy `@`, mixed,
unknown tokens preserved, field order stable); duration parse/format;
`layoutMonthBars` (week-boundary continuation, lane collision, >3 lanes → `+N`,
start-only and due-only, `start > due`); `nextOccurrence` (month-end clamp, leap
day, every-N); hub rendering (marker guard, daily/ not linked, empty month).
Existing task tests must stay green — the legacy `@` path is still live.

## Not in scope

Assignees (single-user app), sub-tasks and dependencies, a separate weekly Gantt
view (revisit after living with month bars), wiring start/scheduled into the
notifier (it stays due-based), `every weekday` / `on the 3rd Monday` rules, and
any change to which folders the graph includes.
