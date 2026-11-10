# Block editor roadmap — Notion-grade blocks over plain markdown

Owner request (2026-09-25): writing markdown should be as easy as Notion —
block type changes (`##` → `###`), many kinds of blocks, charts and ad-hoc
blocks from `/`, many plugins, and (because myco is an LLM wiki) searching past
records and inserting them. Research: artifact
https://claude.ai/artifact/DGCjy1t1cXjaBiCfDvuo9Z. Owner said "proceed with
all of it" and delegated the open questions below.

Already shipped (branch `feat/review-workflow-improvements`, local): Notion-style
block editing — `app/src/lib/editorBlocks.ts` (keys, input rules, slash apply,
caret snap), `editorMarks.ts` (line structure, hidden runs), `editorLists.ts`
(Tab, renumbering), `editorLive.ts` (Live decorations), `editorCompletions.ts`
(slash items). Read their tests before changing them.

## Decisions (owner-delegated, recorded here)

| # | Question | Decision | Why |
|---|---|---|---|
| Q1 | Portability to Obsidian/GitHub | Portable syntax first: callouts `> [!type]`, diagrams ` ```mermaid `, charts = GFM table + ` ```chart ` (obsidian-charts keys), embeds `![[note#Heading]]`. App-only blocks use a fence whose name says so. | The vault is an Obsidian vault; unknown fences degrade to code, never to garbage. |
| Q2 | Default when inserting a past record | **Quote** (owner): `> verbatim excerpt` + `— [[note#Heading]]`. Embeds are an explicit second choice. | Owner's answer. A snapshot never goes stale and reads everywhere. |
| Q3 | `>` = toggle (Notion) or quote (markdown) | `>` stays **quote**. Toggle = `/toggle` → `> [!note]-`. | The file must mean what it says in every markdown reader. |
| Q4 | Third-party plugins | Build stages 5 (declarative) and 6 (sandboxed Worker code, local install only). Defer stage 7 (iframe UI plugins) and any remote registry. | "Many plugins" first means many built-in blocks; UI iframes and remote installs carry unverified risks (WebRTC through CSP, custom-scheme CSP in WKWebView). |
| Q5 | Minimum macOS | Keep 10.15 → **mermaid pinned to 11.17.2** (≥ 11.15.0 for CVE-2026-41149; 12.x needs Safari 17.4). | No reason to drop users. |
| Q6 | Chart/query data | Page tables for charts; queries use the index fields that exist today (type, status, confidence, tags, path, text). Arbitrary frontmatter keys: later, needs Rust index work. | Ships without backend changes. |
| Q7 | Archived records in semantic search | Unchanged (excluded by default). "On this day" reads daily notes by file name instead. | Avoids a bigger, noisier index. |
| Q8 | LLM-written text in notes | Only verbatim retrieved excerpts with their source. No uncited synthesis. | Q4 trust spec anti-goal (`2026-08-21-q4-trust-recall-resurface-design.md`). |

## Invariants (every stage)

- The file is the document: an edit changes only what the user did. Unknown syntax
  round-trips byte-exact. Never write under any `raw/`.
- Live and Preview agree: every new syntax gets a Live rendering, a Preview
  (`app/src/lib/markdown.ts` `createRenderer`) rendering, and a parity test.
- Block widgets (anything replacing whole lines) are provided by a **StateField**
  (CM 6.42 throws for block/line-break-replacing decorations from a ViewPlugin);
  the caret entering a block shows its raw source. Line-only styling may stay in
  the ViewPlugin.
- Every renderer escapes vault text; no `innerHTML` of vault content, no eval
  (CSP has no `'unsafe-eval'`, and a renderer XSS reaches `write_file`/`delete_path`).
- Heavy renderers (`mermaid`, `katex`) load with `import()` inside the widget on
  first use; the initial bundle does not grow. Each new dependency is its own
  commit with the measured chunk size in the message.
- New user-visible strings: keys in en/ko/ja (`app/src/lib/i18n.ts`; the parity
  test fails otherwise). Korean is the owner's language — slash labels show the
  localized name first.
- Gates per commit: `cd app && npm run lint && npx tsc -b && npx vitest run`, plus
  a Playwright check on `?mock=1` for UI (pattern: drive `.cm-content`'s
  `cmTile.root.view`; wait ~9 s for the app). Rust changes: `cargo fmt --check &&
  cargo clippy --all-targets -- -D warnings && cargo test` in `app/src-tauri`.
- Don't append to the end of `styles.css`; edit inside the section you own (the
  Live block after `/* Live preview */`), then run `src/styles.parse.test.ts`.

## Stage 0 — Preview fidelity + small gaps

- Footnote citations: `[^id]` references and `[^id]: …` definitions render as
  footnotes in Preview (superscript reference linking to a footnotes list at the
  end; definitions keep their inline markdown, so `[[source-x]]` stays a
  wikilink). Use `markdown-it-footnote` (MIT, verify version with `npm view`) or an
  equivalent small rule; references must not navigate the webview (Viewer's click
  handler intercepts only `data-link`/`data-external` — footnote anchors scroll
  within the viewer). Adjacent refs `[^a][^b]` both render.
- Live: `[^id]` references get a small superscript chip style (text stays; no
  hiding); definitions get a muted line style.
- Task lists in Preview: `- [ ]` / `- [x]` render as disabled checkboxes.
- HTML comments (`<!-- … -->`, block and inline) render as nothing in Preview
  (`html: false` stays); Live dims them.
- H4: slash item, placeholder label, Cmd+Opt… none (Notion has no H4 key).
- MCP `search` tool description still quotes the old 0.54/0.49 floors
  (`app/src-tauri/src/mcp_native.rs` ~1327) — state the current floor (0.42,
  `retrieval.rs`); fix the stale `bge-m3` wording in `ipc.ts` comments.

## Stage 1 — Turn-into menu, slash v2, past-record insertion

**Turn-into.** `Mod-/` opens a block menu at the caret's line: a search field,
then Turn into (Text, H1–H4, Bullet, Numbered, To-do, Quote, Callout, Toggle,
Code), Duplicate, Delete, Move up, Move down. The same menu opens from a `⋮⋮`
handle that appears in the left margin of the hovered block (pointer events,
not HTML5 DnD — dead under Tauri). Turn-into reuses `turnIntoTr` / `slashBlockEdit`;
multi-line blocks (a paragraph with soft lines) convert every line. Move up/down
moves whole blocks (a block = its lines, blank-line separated), keeping blank
lines between blocks. Keyboard: arrows + Enter, Esc closes and returns focus.

**Slash v2.** Items gain `section` (Basic, Media, Records, Advanced), a text
icon, a localized primary label (`displayLabel`), and aliases. Typing on a
Korean keyboard layout must still match (`/ㅗ1` → `h1`: map jamo to their
2-beolsik QWERTY keys before matching). Unknown query shows "no results" instead
of silently becoming text. New items as stages land (each with i18n keys):
Stage 1 adds h4, callout, toggle (both produce text now; widgets arrive in stage
2), link to note (`[[`), recall, on-this-day.

**`/recall` (`/기록`).** A small picker at the caret (reuse the claim "find a
source" popover styling in `PageReader.tsx`): query field; results from
`retrieveChunks` with similarity shown (judge by `similarity`, floor 0.42;
`score` is not a confidence); empty → "nothing found" plus the closest
below-floor hits. Scope chips: all / wiki / sessions, and time phrases via
`parseTimeQuery` ("지난주"). Choosing inserts, as one undo step at the caret
(its own block):

```markdown
> verbatim excerpt chosen by quoteBody (never synthesized)
— [[note-stem#Section]]
```

The `#Section` comes from the hit's `section`; omit it when absent. Never copy a
`[^src-*]` without its definition. A second action on each result inserts
`![[note#Section]]` (embed) instead.

**`[[` content search.** Section 1: file names (today's behaviour). Section 2:
"In notes" — async `semanticSearch` (≥ 3 chars, 160 ms debounce), each with an
info preview of the chunk; applying inserts `[[stem#Section]]`. Typing
`[[note#` lists that note's headings.

**Insert buttons.** Connections rail rows, resurfaced notes, and Ask answers get
"insert at cursor" (link, or quote for Ask) through the existing
`applyDocEdit`/`insertionRange` path (caret and undo kept).

**On this day (`/오늘의 과거`).** Lists links to daily notes of the same month-day
in past years (`daily/YYYY-MM-DD.md`, `daily/archive/**`), newest first; nothing
found → a short "no past entries" line is not inserted, the picker says so.

**Dev mock.** `semantic_search` in `devMock.ts` returns placeholder text; give it
real body text from the mock notes so insertion can be verified.

## Stage 2 — Block widget foundation and portable blocks

- `app/src/lib/blocks/` registry: `{ id, match (fence info or node), slash?,
  template, parse, renderStatic(parsed) → HTML string (Preview), mount(el,
  parsed, ctx) (Live widget, may be async), estimatedHeight }`. Live has one
  StateField that asks the registry for widgets on fenced blocks / matched nodes,
  hides them while a selection end is inside (raw source shown), keeps IME
  composition safe (no rebuild while `view.composing`), and remeasures after
  async renders. Preview dispatches fences through the same registry.
  Parity test: every registry template → Lezer node type and markdown-it token
  agree, and renderStatic output is escaped.
- Callout `> [!type] Title` (note, tip, info, warning, danger, success, quote —
  GitHub's five plus Obsidian's common ones): `BlockWrapper` box with icon and
  colour, `[!type]` hidden unless the caret is on the first line. Toggle
  `> [!type]- Title`: collapsible, collapsed by default when `-`; the fold state
  is view-only (never written).
- Image `![alt](assets/x.png)` and `![[x.png|300]]`: rendered image widget, width
  from `|N`; caret on the line shows the source. Preview honours `|N`.
- Table: rendered table widget when the caret is outside; a click on a cell puts
  the caret at that cell's source position.
- Embed `![[note#Heading]]` / `![[note]]`: widget renders the target section via
  the existing renderer (read-only), with a header linking to it; missing target
  or heading → "section not found". Preview renders the same. No `^block-id`.
- TOC ` ```toc `: renders the page outline (`extractHeadings`) as links.
- Cmd+Opt+7 → toggle, Cmd+Opt+8 → code block; slash items for callout/toggle/
  image (file picker → assets)/embed/toc.

## Stage 2.5 — Ask inside the editor + Notion-look polish

Owner report (2026-09-26): "llm wiki 사용이 안되고 있고 (질문 결과 가져오기라던가
질문하기 등이 없음) … md로 저장되긴하지만, 실제로 쓸때는 노션처럼 보기 좋게 써져야해."
Two parts. Both keep the file plain markdown (Invariants apply).

### 2.5a `/질문` (`/ask`) — ask the vault from the caret

- Slash item: label `ask`, detail `t.sl_ask` (en "Ask the vault", ko "볼트에 질문",
  ja "ノートに質問"), icon `?`, aliases `question`, `answer`, `질문`, `물어보기`, `답`,
  section `records`, `picker: "ask"` — `SlashPicker` gains `"ask"`
  (app/src/lib/editorCompletions.ts). `/recall` gains aliases `검색`, `찾기`, `불러오기`.
- Picker: RecallPicker in `ask` mode (app/src/components/RecallPicker.tsx). Input
  placeholder `t.rc_ask` ("Ask a question…" / "질문을 입력…" / "質問を入力…"). Enter runs a
  new `askSearch(question, scope, now, lang, retrieve)` in app/src/lib/editorRecall.ts,
  a sibling of `recallSearch`: `parseTimeQuery` for a time window, `retrieveChunks(text,
  12, undefined, range, scope)`, same `stale` / `failed` / `no-index` / `none` views.
  Hits are already floor-judged by `similarity` (RELEVANCE_FLOOR in lib/chat.ts).
- The answer is ONE portable callout built only from vault text — Decision Q8: verbatim
  quotes, no generated prose. `answerBlock(question, hits)` (pure, tested) returns:

  ```
  > [!question] <question exactly as typed>
  > **[[stem#Section]]** · 68%
  >
  > <quoteBody lines of that page's hits, verbatim, ≤ 400 chars per page>
  >
  > **[[stem2]]** · 52%
  >
  > <…>
  ```

  (The `>` line under each link keeps the quote a block of its own: a table or `---`
  right under the link line would otherwise be read into its paragraph.)

  Group by page like `formatExtractiveAnswer` (lib/extractive.ts: `groupByPage`,
  `quoteBody`), max 3 pages; the link is `[[stem#Section]]` when `recallTarget` finds a
  heading, else `[[stem]]`; a lexical-only hit (similarity null) gets no percentage.
  Stage 2's callout widget draws it in Live; Preview renders it through the callout
  rule. Quote lines must round-trip: a vault line that starts with `>` or `#` inside
  the callout stays a literal (escape as the callout plugin expects; test it).
- Picker states: loading row while retrieving; a preview of the callout text (read-only)
  with Enter = insert, Esc = close; `none` shows `t.rc_none` with the floor and the
  near-misses (as recall does) and inserts nothing — there is no "insert anyway";
  `stale` / `failed` / `no-index` reuse recall's rows. Confidence band
  (`confidenceBand(best)`) is shown in the picker header, not written to the note.
- Insert: `insertBlockTr` at `req.pos` (blank line before/after like `/recall`); one
  undo step; focus returns to the editor after the caret.
- Block menu (⋮⋮ / Mod-/, app/src/components/BlockMenu.tsx, lib/editorBlockOps.ts):
  new action `ask` — `t.bm_ask` (en "Ask about this block", ko "이 블록으로 질문하기",
  ja "このブロックで質問"). Opens the ask picker with the block's text as the question
  (marks stripped with `bodyText`; a list item = that item; a callout = its title line),
  insertion position = a new line after the block. Disabled on empty blocks and inside
  fenced code / frontmatter.
- Tests (vitest, node): `answerBlock` exact strings (two pages, a lexical-only hit, a
  line starting with `>`); `askSearch` with a fake `retrieve` for hits / none / stale /
  failed / no-index and a Korean time phrase producing a range; block-menu ask prefill
  from a heading, a list item, a quote (marks stripped); insertion transaction (blank
  line separation) and single-step undo. Browser (?mock=1, devMock has recall data):
  `/질문` → question → Enter inserts the callout, drawn as a widget; a nonsense question
  abstains and inserts nothing; block menu → "이 블록으로 질문하기" opens the picker
  prefilled.

### 2.5b Notion-look polish (Live)

Goal: a note typed in Live reads like a Notion page. CSS lives in the Live section of
app/src/styles.css (styles.parse.test.ts guards it); line classes come from `liveSpecs`
(app/src/lib/editorLive.ts) so they are unit-testable.

1. **Block gap.** A blank line that is not inside fenced code or frontmatter gets line
   class `live-gap`: height/line-height 0.75em, no padding — the file's blank line reads
   as Notion's paragraph spacing. The line that holds the caret (any caret) keeps full
   height, so a fresh block opened with Enter looks like Notion's new block.
2. **Vertical caret movement skips gaps.** ArrowUp/ArrowDown (without Shift): run CM's
   `cursorLineUp/Down`; while the head lands on a `live-gap` line that is not the
   document's first/last line, run it again (goal column is preserved by CM's
   `goalColumn`). Shift-selection and Home/End are unchanged. A pure
   `isGapLine(state, lineNumber)` is the tested predicate; the command is verified in
   the browser. Backspace/Delete behaviour from fix/blank-line-backspace stays; add the
   case "blank line right after a widget block (image/embed/table/toc/callout)": Backspace
   removes the blank line and puts the caret at the end of the block's last line (the
   block turns to source, as stage 2 decided for a caret on it).
3. **Fenced code.** Caret outside the fence: the ``` runs are hidden like other block
   marks (hiddenRuns), the info string is drawn as a chip (`live-lang`: 11px, uppercase,
   `--ink-4`) at the top-right of the first line, the closing fence line gets
   `live-fence-end` (height 0.5em). Caret on a fence line shows it as source. Code lines
   get padding 2px 12px and the first/last lines get `live-code-first` / `live-code-last`
   with rounded corners so the block reads as one card (`--bg-soft`).
4. **Headings.** Keep sizes (H1 30 / H2 22 / H3 17); add `padding-top` 1.2em / 1em /
   0.8em, line-height 1.3, and `live-first` on the first content line (line 1, or the
   first line after frontmatter) with `padding-top: 0`.
5. **Empty-block placeholder.** The caret's empty line (only when the editor has focus)
   gets `data-placeholder` = `t.live_ph_block` (en "Type '/' for blocks", ko "'/'를 입력해
   블록 선택", ja "「/」でブロックを選択"), same mechanism as the empty-heading placeholder.
   Not on fence/frontmatter lines.
6. **Lists.** Nested indent 1.5em per level; ordered numbers right-aligned in a 1.5em
   box; the to-do checkbox toggles `[ ]`/`[x]` in the file on click (verify; fix if not).
7. **Inline.** `live-link`: `--ink-2`, underline on hover; inline code chip unchanged;
   `live-quote` no italics.
8. **Divider.** HorizontalRule widget: 1px `--line`, 1em vertical margin.
9. **Tables (stage 2 widget).** Header row `--bg-soft`, cells 6px 10px, borders
   `--line`, radius `--r-md`, `overflow-x: auto`.
10. **Paragraph rhythm.** Body line-height 1.6, max content width unchanged.

Acceptance (browser, ?mock=1, 1280×900 and 1024×700):
- "문단1⏎문단2" → file `문단1\n\n문단2`; the blank line draws short; ArrowUp from 문단2
  lands on 문단1; caret on the blank line → full height + placeholder.
- ```` ```js⏎code⏎``` ```` with caret below: backticks hidden, `JS` chip visible, block is
  one card; caret on the opening fence: backticks visible.
- H1 over a paragraph has top spacing; the note's first line has none.
- 10-verify-blocks stays all-PASS; stage 2 scripts stay all-PASS.

## Stage 3 — Charts, diagrams, math

- ` ```chart ` (flat YAML, obsidian-charts compatible keys: `type`
  bar|line|pie|… , `id` or `labels`/`series`, `title`, `layout`): data from the
  table tagged `^id` above it or inline series. Rendered with the existing
  `DashCharts` (0 KB) for bar/line; pie as an SVG donut added to DashCharts.
  Parse errors show a clear inline message, never throw.
- ` ```mermaid `: `mermaid@11.17.2` loaded with `import()` on first render,
  `securityLevel: 'strict'`, theme following the app theme; render into the
  widget; errors shown inline. Record chunk size.
- Math `$…$` / `$$…$$` (GitHub rules: no `$5 and $10` false positives): Lezer +
  markdown-it extensions, KaTeX (`throwOnError:false`, trust off) lazy-loaded;
  fonts served from the app bundle (CSP `'self'`).
- Slash items: chart (inserts a sample table + chart fence), mermaid (sample
  flowchart), math block.

## Stage 4 — Query blocks

- ` ```myco-query ` with one line of ⌘K operators (`"phrase"`, `tag:`, `type:`,
  `status:`, `confidence:`, `path:`) plus optional `sort:`/`limit:`/`view:
  list|table|count`. Live and Preview render results from the existing
  Views/search index (`queryViews.ts` `runView`, `searchQuery.ts`); `view: count`
  draws a bar per group (DashCharts). The current page is excluded.
- Bake: a "bake" button writes the result as a plain link list between
  `<!-- myco:query <query> -->` and `<!-- /myco:query -->` (links only, never
  quotes), replacing a previous bake in place; Preview hides the markers.
- Slash: query, on-this-day as a query preset.

## Stage 5 — Declarative plugins

- Templates: a template file with frontmatter `slash: meeting` (+ optional
  `slash_label`, `slash_section`) becomes a slash item that inserts its body
  (template variables as today, `${}` caret).
- `.myco/plugins/<id>/manifest.json`: `{ id, name, version, contributes: {
  slash: [{ label, detail, template | fence }], fences: [{ lang, renderer:
  "builtin:chart"|"builtin:mermaid"|"builtin:query"|"builtin:code" }] } }`,
  validated with TS guards; invalid manifests show in Settings with the reason.
  No code runs. Settings lists plugins with enable/disable. A vault's plugins are
  off until the user trusts the vault ("Trust this vault's plugins").

## Stage 6 — Sandboxed code plugins (local)

- `main.js` in a plugin folder runs in a dedicated Web Worker (blob URL); host ↔
  worker over MessagePort RPC with per-call timeout, `terminate()` on repeated
  failure. Syscall allowlist: `editor.insertAtCursor(text)`,
  `editor.replaceSelection(text)`, `editor.selection()`, `vault.readPage(path)`
  (wiki/ only), `recall(query, k)`, `search(query)`, `ui.notify(text)`.
  No file writes, no raw/, no network beyond what the CSP already allows (note it).
- A plugin contributes slash commands whose handler runs in the worker.
- Regression test that a worker cannot reach Tauri IPC (`__TAURI_INTERNALS__`
  absent in the worker global).
- Install = the user copies a folder (no remote registry). Enable requires trust
  (stage 5) plus a per-plugin permission prompt listing its syscalls.

## Deferred

iframe UI plugins, remote registry/signing, synced blocks, columns, buttons,
tabs, `^block-id` references, bookmark previews (CSP blocks webview fetches),
arbitrary-frontmatter queries (Rust index), H4 key.
