# Tidy (정리) and collapsible graph rails

Owner request, 2026-09-28, on a screenshot of the Graph page: "좌우 갭이랑 범례도 안보이게
할 수 있는 설정도 넣어주고 (약간 펼치기 닫기 처럼) … 좌측처럼 claude-code-eqwiop 이렇게
되어있는데 이것들 aside의 정리하는 것처럼 정리할 수도 있게끔 해줘. 지금 보기가 어려워 (이건
위키 자체 정리기능 필요)" — then "aside의 tidy기능처럼". Aside is an AI browser. Its Tidy is one
button that proposes readable groups for a messy tab strip, which you accept or undo.

## What the real vault shows (measured 2026-09-28, read-only)

- `wiki/` holds 66 `source-claude-code-<uuid>.md` / `source-codex-<uuid>.md` summaries, titled
  `Source: claude-code-<uuid>`. They came from extractive ingest of session transcripts, and
  `extractiveSummary` (lib/extractiveIngest.ts) uses the slug as the title.
- Their `## Related` sections link `[[claude-code-<uuid>]]`, which is the transcript's stem.
  Transcripts live under `sessions/…` and `raw/archive/…`, not in `wiki/`, so every such link is
  dangling. That is the Graph page's "없는 페이지" (missing pages) gap group, 30 entries. The
  candidates come from `wikify_candidates`, which ranks transcripts.
- Each transcript opens with frontmatter (`source`, `conversation_id`, `created` epoch seconds)
  and then a `# <first user prompt>` heading, for example `# 서버 띄워봐.`. That heading is a
  verbatim, human-readable name for the session.

## Part A — collapsible graph rails

- The gaps rail (left) and the legend rail (right) on the Graph page each get a
  collapse/expand control in their header. It is a chevron button with an aria-label and
  `aria-expanded`, t keys en/ko/ja. A collapsed rail becomes a thin edge tab (about 28px) that
  shows its icon and count. Clicking the tab expands the rail again.
- While a rail is collapsed, the stage takes its space and the canvas resizes: the
  ResizeObserver path, with no letterbox.
- At 821–1240px the legend sits under the gaps rail in one left column. There a single
  fold gives the other rail the column's full height and leaves the stage where it is, at
  the same width; only folding both widens the stage. The legend's tab sits on the stage's
  left edge, under the gaps tab. At 820px and under, the frame stacks the rails in 0px rows,
  so no fold is offered: no chevron, no tab, and `[` / `]` do nothing. (Amended 2026-09-29
  after review; the first version said the stage takes the rail's width at every width.)
- The state is remembered per device in the graph settings store, and survives reload and look
  changes.
- Keyboard: `[` toggles the gaps rail and `]` toggles the legend. They do nothing while focus is
  in a text input or while any modal is open, and a held key toggles once. The shortcuts are
  listed in GraphHelp and in the Help panel on the Graph route.
- The graph settings drawer gets a "패널" (panels) row with the same two toggles.

## Part B — Tidy (정리)

### Display names (read path, no writes)

`lib/displayName.ts`: `displayName(stem, title?)` works as follows.
1. If a frontmatter title exists and is not an opaque id, use it.
2. If the stem or title is opaque (`/^(source-)?(claude-code|codex|chatgpt|claude)-[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}(-\d+)?$/`
   or a `Source: <that>` title), show `<agent> · <first 8 hex>`, for example `Claude Code · 064ddbe4`.
3. Otherwise use the stem.

Every place that lists pages by stem uses it: Graph gaps rail, legend, inspector, node labels,
sidebar tree, ⌘K rows, search results, backlinks and Connections rows. The full stem stays in
the `title` tooltip. The helper is pure and tested.

### Tidy run (write path, previewed, undoable)

Entry points:
- a "정리" button in the gaps rail header;
- a ⌘K command "볼트 정리 (Tidy)";
- Settings → 볼트 → 정리.

The Tidy sheet (DialogHost-style modal, focus-trapped) lists proposal groups. Each group has a
count, a checkbox, and a few before → after example rows, expandable to all rows:

1. **읽을 수 있는 제목 붙이기** — for each wiki page whose title is opaque, set `title:` to
   `<transcript first heading, trimmed to 60 chars, verbatim> · <Agent> · <YYYY-MM-DD from
   created>`. The H1 line of the page becomes the same text without the `Source: ` prefix. The
   transcript is found by `conversation_id` or stem under `sessions/**` or `raw/**`, read-only.
   A page with no transcript found is skipped and listed as skipped.
2. **끊어진 링크 고치기** — in wiki pages, rewrite `[[<transcript-stem>]]` to
   `[[source-<transcript-stem>]]` when that summary exists. A Related bullet whose target has
   no summary is removed. Only `## Related` bullets are touched, never prose or citations
   (`[^src-*]` definitions stay).
3. **세션 요약 모으기** — off by default. It moves `wiki/source-(claude-code|codex)-*.md` into
   `wiki/sessions/YYYY-MM/`, using the page's `created`. No link rewrite is needed because links
   resolve by stem (`move_path`).

Apply behaviour:
- Changes are written through existing IPC: `write_file` / `move_path`. It never writes
  `raw/**` or `sessions/**`, and the backend already refuses raw.
- Before writing, the sheet stores `.myco/tidy/<timestamp>.json` with each touched file's
  previous path, content and the sha256 of the new content.
- After apply, a receipt shows counts and offers "되돌리기" (undo). Undo restores each file only
  if its current content still hashes to what Tidy wrote. Otherwise that file is skipped and
  named, the same as distill's "modified since the run".
- The last run can also be undone from Settings → 볼트 → 정리 기록.

States:
- loading while scanning;
- empty: "정리할 것이 없습니다";
- error, with retry;
- partial success: lists the files that failed.

### Stop making the mess (ingest root cause)

- `extractiveSummary` receives a readable title: for a session source, it is the transcript's
  first heading plus agent and date, computed by the same pure helper Tidy uses.
- Its Related candidates map transcript stems to `source-<stem>` when that summary exists, and
  drop the stem otherwise. So new ingests never add dangling links.
- The Rust validator test pairing (validator.rs `offline_ingest_page_passes_validation`) is
  updated to match.

## Acceptance

- vitest:
  - `displayName` cases, including a `-2` suffix and `Source: ` titles;
  - the Tidy planner (pure: `planTidy(files)` returns groups) on fixtures: an opaque-title page,
    a dangling Related link, a page with no transcript, a page already tidy (no-op);
  - undo skipping a file that changed after the run;
  - `extractiveSummary` title and Related mapping.
- Browser (?mock=1; devMock gains two session transcripts under `sessions/2026-09/` and two
  opaque summaries with dangling Related links):
  - the gaps rail shows `Claude Code · xxxxxxxx`, not the uuid;
  - "정리" opens the sheet with the groups;
  - Apply changes the titles in the sidebar and graph, and the missing-pages count drops;
  - Undo restores the files byte for byte.
- Rails: collapse and expand each rail and check the canvas width grows or shrinks (at 1024×700
  a single fold keeps the width and the other rail takes the full height; folding both grows
  it). The state persists after reload. `[` and `]` work, and do nothing inside the graph
  search input. Checked at 1280×900 and 1024×700.
