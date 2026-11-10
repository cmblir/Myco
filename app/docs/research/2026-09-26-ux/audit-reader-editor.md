# myco UI audit — Reader page (Viewer, Live editor, rail panels)

Key: `reader-editor` · tree: `~/prj/karpathy-editor-build` (commit 0f8eb86, the installed build) · mock app at `http://localhost:5472/?mock=1` · headless Chromium via Playwright · 1280×900 and 1024×700 · dark + light · UI language ko (owner default) · 2026-09-26.

Screenshots: `shots/reader-editor/` (50 files). Scripts and JSON logs: `reader-editor/r1…r5*.mjs`, `r*.log.json`. Code citations are `app/src/…` paths in the audited tree. The Vite server was killed at the end; port 5472 is free.

Console: **0 errors, 0 warnings** across all runs (the single `localStorage` pageerror in r4 came from the harness navigating to `about:blank`, not the app).

## What was exercised

| Area | How | Evidence |
|---|---|---|
| Write (Live) default, rail closed/open | open `wiki/attention-mechanism.md` | r1-01, r1-02 |
| Read (Preview) | 읽기 toggle, ⌘E round-trip | r1-03, r1.log |
| Source mode | ··· → 마크다운 원문 편집 | r1-04, r1-05 |
| Slash menu, ko filter (`/표`), block menu (⌘/), ⋮⋮ handle | typed | r1-06, r1-07, r1-08, r1-08b |
| Rich note (callout, toggle, table, image, `![[embed]]`, code, tasks, nested list, `[toc]`, footnote) in Write and Read | `setDoc` | r1-09, r1-10 (full page), r4-05 (full page Write) |
| Properties add/invalid key, tags chips, selects | rail | r1-12, r1-13 |
| Connections rows, insert-at-cursor from Read | rail | r1-14, r3-01 |
| Autosave states (pending → saved), simulated write failure, ⌘S | timeline sampling | r1.log, r3.log, r3-02, r3-02b |
| 1024×700 light + dark, rail open/closed | r2 | r2-light-01…13, r2-dark-01/02 |
| Recall picker, On-this-day, `[[` completion, ⌘F panel | r2 | r2-light-09…13 |
| New note (production-shaped frontmatter seed), empty states | r4 | r4-01…04 |
| raw/ PDF, missing path, folder path | r3 | r3-06-* |
| Long note 297 KB / 3 207 lines / 401 headings: typing, mode switch, outline jump | r3 | r3-07, r3-08, r3-09, r3.log |
| Backspace after `## ` on a fresh note (suspected data loss) | r5 key-by-key | r5.log — **not a bug**: Enter → `## ` → ⌫⌫⌫ deletes a title char exactly like Notion (⌫1 drops the mark, ⌫2 removes the empty block, ⌫3 edits the previous block); ⌘Z restores |

## Findings

Severity = impact on a Notion/Obsidian user who writes in myco daily. Effort S < 1 day, M 1–3 days, L > 3 days.

### High

**H1 · Callouts and toggles are offered but never rendered.** The slash menu lists 콜아웃 and 토글 목록; both insert `> [!note] ` / `> [!note]- ` and that is all. Write shows a grey quote with the literal `[!note] Key idea`; Read shows the same literal text inside a blockquote, and the `-` toggle never folds. An Obsidian vault full of callouts reads as junk.
Evidence: `r1-09-rich-write.png`, `r1-10-rich-read.png`, `r2-light-06-rich-read.png`; `lib/editorCompletions.ts:131-132` ("Callout and toggle are plain text until their widgets land"); `lib/markdown.ts:194-282` (no container/callout rule); `lib/editorLive.ts:270-272` (Blockquote → `live-quote` only).
Proposal: Read: markdown-it rule that turns `> [!type][-+] Title` into `<div class="callout callout-type" data-fold>` with a title row (icon + title) and `<details>` when folded. Live: a `live-callout` line class per type with the `[!type]` marker replaced by an icon/title chip on non-caret lines and a caret to fold. Until that lands, hide the two slash items (they promise what the editor cannot show).

**H2 · At 1024 px the 노트 정보 rail wraps below the note — off-screen.** `.reader-body--rail > section {flex: 1 1 30rem}` + `.reader-rail {flex: 1 1 18rem}` need 49.5 rem; with the 240 px sidebar the pane has 682 px, so the rail lands at y = 695 in a 700 px viewport. Clicking 노트 정보 lights the button and changes nothing visible; on a long note the rail sits after the whole body (r2-light-06). The mobile-first breakpoint (`@media (max-width: 899px)`) never fires because the window is 1024.
Evidence: `r2-light-01-1024-write-rail.png`, `r2-dark-01-1024-write-rail.png`, `r2-light-06-rich-read.png` (rail after the footnotes); r2.log `rail {x:291,y:695,w:682}`; `styles.css:8373-8395`.
Proposal: decide by pane width, not viewport: below ~56 rem of pane width open the rail as a fixed right-hand drawer over the note (Notion's "page info" panel), else beside. Cheapest: `section {flex: 1 1 22rem}`, `.reader-rail {flex: 0 1 16rem; min-width: 14rem}` keeps them side by side down to ~640 px pane, and auto-collapse the sidebar when the rail opens under 1100 px.

**H3 · Tables: raw pipes in Write, unpadded cells in Read.** Write shows `| Variant | Complexity |` lines in the prose face; Read renders `<table>` with no cell padding, borders or header background, so columns run together ("O(n) memory IO-aware"). Both Notion and Obsidian Live Preview show a grid.
Evidence: `r4-05-rich-write-full.png` (Table section), `r1-10-rich-read.png`, `r2-light-06-rich-read.png`; `styles.css:1376-1380` (only `display:block; overflow-x:auto`); `lib/editorLive.ts:240-300` (no Table node case).
Proposal: Read (S): `.prose th, .prose td {padding: .375rem .75rem; border-bottom: 1px solid var(--line)}`, `th {background: var(--bg-soft); text-align:left}`. Write (M): a `live-table` block decoration that draws the rows as a grid off the caret block (mono pipes stay on the caret line, like Obsidian), Tab/Shift-Tab already move between cells.

### Medium

**M4 · Tab is swallowed on any non-list line and can never leave the editor.** On a paragraph Tab and Shift-Tab do nothing (doc unchanged, focus stays); the keymap returns `true` unconditionally. Notion nests the block, Obsidian inserts a tab; myco does neither. The only way out with a keyboard is CodeMirror's undocumented Esc → Tab.
Evidence: r3.log `Tab on paragraph {changed:false, focus:"cm-content"}`, `Shift-Tab {focus:"cm-content"}`; `lib/editorBlocks.ts:898-905` (`|| true`); `lib/editorLists.ts:294-296`.
Proposal: on a paragraph that follows a list item, Tab turns it into a nested item of that list (Notion); on any other paragraph insert nothing but do not claim the key (return `false`) so Tab reaches the next control, and list Esc→Tab in the HelpWidget shortcuts.

**M5 · Toggling 쓰기 ↔ 읽기 shifts the text.** Same note: paragraph starts at x = 310 in Write and x = 304 in Read; the H1 sits at y = 281 vs y = 300; with frontmatter the Write view adds a whole "노트 속성 · 노트 정보에서 수정" line (y = 269) so the body drops ~60 px. Line-height differs (1.75 vs 1.7). The eye loses its place on every ⌘E.
Evidence: `r1-01-write-default.png` vs `r1-03-read-rail.png`; `r1-09-rich-write.png` vs `r1-10-rich-read.png`; `styles.css:1364-1370` (`.prose`), `3044-3049` (`.cm-content {padding:1rem 0}`), `8361-8365`.
Proposal: one column spec for both: same padding-inline (0), same padding-top, same line-height; move the frontmatter chip out of the text flow (a small pill in the reader header next to the save status that opens 속성) so Write and Read start at the same y.

**M6 · Save status churns on every keystroke.** Each edit flips the header to "자동 저장 대기 중…" for 2 s, then "저장됨"; the label's width changes and nudges the authorship badge (r1-06 shows the header mid-flip). Neither Notion nor Obsidian show a pending state.
Evidence: r1.log save timeline (`0…760 ms 대기 중 → 1016 ms 저장됨`), r3.log long-note timeline (2 s of 대기 중); `r1-06-slash.png` vs `r1-01`; `pages/PageReader.tsx:71, 685-692`.
Proposal: silent while pending and saving; after a successful write show "저장됨" for 1.5 s then fade; keep "저장 필요" (warn colour) and the banner for failures; give the slot a fixed min-width so nothing moves.

**M7 · A failed save is reported four times.** Header "저장 필요", the amber banner, a raw English line under it (`EACCES: permission denied (simulated)`), and the same string in red in the sidebar. The banner copy ("앱을 닫기 전에 다시 저장해 주세요") is good; the duplicates are noise and the raw error is untranslated.
Evidence: `r3-02-save-failed.png`, `r3-02b-save-failed-read.png`; `pages/PageReader.tsx:878-895` (banner + `{error}` paragraph); sidebar error from `vaultStore.error`.
Proposal: keep header + banner; fold the raw error into the banner as a collapsible "자세히" line; suppress the sidebar copy while the reader shows the banner. Cmd+S while failing should re-attempt with a visible spinner on 다시 저장 (it does retry, but the button text is the only cue).

**M8 · Read-mode checkboxes are dead.** Tasks render `<input disabled>`; you cannot tick a to-do while reading. Obsidian's Reading view toggles them.
Evidence: `lib/markdown.ts:222-223`; `r1-10-rich-read.png` (Tasks).
Proposal: emit `data-line` on `task-list-item` (the heading rule already does), render the box enabled, and on `change` flip `[ ]`/`[x]` on that source line through `applyDocEdit` (autosave follows).

**M9 · Note embeds `![[note]]` render as "!embeddings".** The embed rule only handles image extensions, so a note embed becomes a wikilink with a stray `!`; Write shows the raw text. The recall picker actively produces this with a button labelled literally `![[ ]]`.
Evidence: `r1-10-rich-read.png` ("!embeddings"), `r4-05-rich-write-full.png`; `lib/markdown.ts:69-96`; `r2-light-10-recall-results.png` (embed button glyph); `components/RecallPicker.tsx:294-297`.
Proposal: Read: render `![[note]]` / `![[note#Section]]` as a transclusion card (title, first ~6 lines, "열기" link) via `ipc.readFile`; Live: a `live-embed` block with the target title. Replace the `![[ ]]` glyph with an icon + tooltip "임베드로 넣기".

**M10 · Images never preview in Write.** `![alt](assets/x.png)` stays as text; a pasted screenshot becomes an opaque line the writer cannot see. Live returns `false` for `Image`.
Evidence: `r4-05-rich-write-full.png` (Media section); `lib/editorLive.ts:256-258`.
Proposal: block widget under the image line when the caret is off it (the Viewer's `resolveImageSrc` + `convertFileSrc` already do the URL mapping); alt text as caption.

**M11 · The rail scrolls invisibly and clips.** `.reader-rail` is sticky with `max-height: calc(100vh - 32px); overflow-y: auto`, and scrollbars are hidden app-wide, so the 연결 list ends mid-row with no cue; on a 401-heading note the 개요 list is 10 226 px tall inside the rail (scrollHeight 11 136).
Evidence: `r1-02-write-rail.png` (row cut at "positional-encoding"), `r1-14-rail-closeup.png`, `r3-09-long-outline-jump.png`; r3.log `rail scrollHeight {client:868, scroll:11136}`; `styles.css:133-141`, `8386-8395`.
Proposal: cap each Rail section's list (개요 and 연결 `max-height: 40vh`, own scroll, bottom fade) and show "+N 더 보기"; keep the rail itself unscrolled.

**M12 · The outline never says where you are.** No `aria-current`/active row; after a click the only highlight is hover. Notion and Obsidian both track the current heading.
Evidence: r3.log `outline active markers 0`; `components/OutlinePanel.tsx` (no active prop); `styles.css:8568-8586`.
Proposal: in Read an IntersectionObserver on `[data-line]` headings, in Write `view.viewport.from` → nearest heading; set `aria-current="true"` and a left bar on that row; auto-scroll the rail list to it.

**M13 · "커서 위치에 링크 넣기" in Read mode appends to the note's end.** With no editor the insert path falls back to `appendBlock`, so the link lands at the bottom, out of sight, with no toast.
Evidence: `r3-01-read-insert-result.png` (`[[transformer-architecture]]` appended), r3.log doc tail; `pages/PageReader.tsx:463-465`; `components/ConnectionsPanel.tsx:163-173`.
Proposal: in Read mode either hide the icon or relabel it "노트 끝에 링크 추가" and toast "노트 끝에 [[x]] 추가됨 · 보기"; best: switch to Write with the caret on the inserted link.

**M14 · An empty note gives no guidance.** After "# 제목" the caret sits on an empty line with no placeholder (only empty headings get "제목 2"); Read mode of the same note is just the title; the rail shows three empty tiles. A new Notion page says "'/'를 입력해 명령어 사용".
Evidence: `r4-01-new-note-write.png`, `r4-02-new-note-empty-line.png`, `r4-04-new-note-read.png`, `r3-04-empty-write.png`; `lib/editorLive.ts:405-411`.
Proposal: placeholder on the caret's empty paragraph when the body is empty ("'/'로 블록 추가 · [[ 로 노트 연결 · /기록 으로 지난 기록 인용"); Read-mode empty state ("아직 본문이 없습니다" + 쓰기 button); rail tiles can say what will appear ("제목을 쓰면 개요가 생깁니다").

**M15 · Four names for one note in the header.** "● File" (English, hardcoded) + full absolute path + serif filename title (`attention-mechanism`) + the body H1 (`Attention Mechanism`) + the topbar breadcrumb (`myco / attention-mechanism.md`). Notion shows one title; Obsidian one filename plus breadcrumb.
Evidence: `r1-01-write-default.png`; `pages/PageReader.tsx:697-714, 749`.
Proposal: drop the typebadge/path row (path → breadcrumb tooltip and a "Finder에서 보기" item in ···); page title = H1 or frontmatter `title`, falling back to the filename; localize the badge if it stays.

**M16 · Source mode is hidden and unrepresented.** Reachable only via ··· → 마크다운 원문 편집; while in it the segmented control still shows 쓰기 pressed (`aria-pressed=true`) and a full-width banner explains the state; ⌘E from Source goes to 읽기, not back to 쓰기.
Evidence: `r1-05-source.png`; r1.log `segmented state in source [["쓰기","active","true"],…]`; `pages/PageReader.tsx:275-289, 795-805, 851-861`.
Proposal: three-way segmented (쓰기 · 원문 · 읽기) or an Obsidian-style "원문" toggle inside 쓰기 with its own pressed state; remove the banner.

### Low

**L17 · Footnote ids as 30-character chips in Write.** `[^src-attention-is-all-you-need]` sits inline mid-sentence; Read shows `[1]`.
Evidence: `r1-01-write-default.png` vs `r1-03-read-rail.png`; `styles.css:3149-3157`; `lib/editorLive.ts:43-45`.
Proposal: Live renders `[^id]` as a numbered chip (definition order) with the id in a tooltip; the full id only on the caret line.

**L18 · Wikilinks in Write show no click affordance.** `cursor: auto`, no title; a plain click moves the caret, ⌘-click opens. Obsidian shows a hover preview; Notion opens on click.
Evidence: r4.log `wikilink style {cursor:"auto", title:""}`, `after plain click … title "빈 노트"`, `after Cmd+click … "embeddings"`; `lib/editorLive.ts:498-508`; `styles.css:3141-3148`.
Proposal: `cursor: pointer` + `title="⌘+클릭으로 열기"` on `.live-wikilink`; optionally a hover card (first lines) reusing the recall excerpt component.

**L19 · The frontmatter chip is inert.** "노트 속성 · 노트 정보에서 수정" is a plain span; clicking does nothing and the rail it names may be closed.
Evidence: r4.log `live-fm clickable? {cursor:"auto", role:null}`; `lib/editorLive.ts:345-361, 468-480`.
Proposal: make the widget a button that opens the rail and expands 속성.

**L20 · Dates are free text.** `created` is a text input (no picker); Sources shows `chatgpt · 1700000000` for an epoch `created`.
Evidence: `r1-09-rich-write.png` (created field), `r1-02-write-rail.png` ("1700000000"); `components/PropertiesPanel.tsx:106-114`; `components/SourcesPanel.tsx:90-91`.
Proposal: `type="date"` for `created|updated|date` keys; `Intl.DateTimeFormat` for `ref.created` when it parses.

**L21 · ⌘F panel is CodeMirror's stock layout over the topbar.** Translated labels, but raw checkboxes and buttons float in a strip that covers the breadcrumb.
Evidence: `r2-light-13-find.png`; `components/Editor.tsx:152` (`search({top:true})`), theme 189-198 colours only.
Proposal: style `.cm-panel.cm-search` with `.input`/`.btn-ghost`, chips for the three options, and mount it sticky under `.reader-actions`.

**L22 · Completion popups are styled two ways.** `[[` and `#tag` items show CM's "abc" type icon; the slash menu hides icons and uses a mono keyword column.
Evidence: `r2-light-12-wikilink-complete.png` vs `r1-06-slash.png`; `components/Editor.tsx:289-291, 704-710`.
Proposal: one `optionClass` for all sources; drop `type:"text"`.

**L23 · Slash menu misses what a Notion user types first.** No /이미지, /임베드, /목차, /수식, /북마크; `[toc]` renders literally.
Evidence: r1.log slash items (18); `r1-10-rich-read.png` ("[toc]"); `lib/editorCompletions.ts:140-236`.
Proposal: /이미지 → file picker → `ipc.writeAsset`; /임베드 → RecallPicker in embed mode; /목차 → inserted heading list (or a hint that 개요 lives in 노트 정보).

**L24 · No shortcut hints on the mode buttons.** 쓰기/읽기 have no `title`; ⌘E is undiscoverable; ··· items list no keys.
Evidence: r4.log `segmented titles [{title:""},…]`; `pages/PageReader.tsx:752-770`.
Proposal: `title="쓰기 (⌘E)"`, `"읽기 (⌘E)"`, and key hints in the menu rows.

**L25 · On a long note the reader actions scroll away.** The page (not the editor) scrolls, so the mode toggle, 노트 정보 and ··· leave the viewport; only ⌘E remains.
Evidence: `r3-09-long-outline-jump.png`; `pages/PageReader.tsx:694-695`.
Proposal: make `.reader-actions` sticky under the topbar, compacting to icons when stuck.

**L26 · Loading and not-found states.** "Loading…" is hardcoded English; a missing or unreadable file shows the same muted line (the mock masks it by returning a fallback note).
Evidence: `pages/PageReader.tsx:671-679`; `r3-06-does-not-exist.md.png` (mock fallback).
Proposal: `t.rd_loading` skeleton (title bar + 3 lines); distinct "노트를 찾을 수 없습니다" state with "사이드바에서 열기".

**L27 · ko wording.** "마지막 사람 손길 그저께" (literal "last human touch"), "돌아갈 판이 하나가 아닙니다", "자동 저장 대기 중…" (long for a header), "복합 값 — 소스에서 편집하세요" says 소스 while the menu says 마크다운 원문, "커서 위치에 링크 넣기" is false in Read.
Evidence: `lib/i18n.ts` ko block (offsets +919, +923, +962, +1023, +1055 from line 3704); `r1-01-write-default.png` header.
Proposal: "마지막 직접 수정 그저께", "여러 커밋이 쓴 문단이라 되돌릴 기준 판이 없습니다", "저장 대기…", unify 원문, and L13's relabel.

**L28 · Long-note feel is fine today; the rail recompute will not scale.** 297 KB / 3 207 lines: setDoc 139 ms, ~25 ms per typed character end-to-end (dispatch → paint 30–35 ms, i.e. within two frames), Write→Read 151 ms, Read→Write 89 ms. But every keystroke re-runs `parseFrontmatter`, `extractHeadings`, `claimCandidates`, `gutterRuns` over the whole draft in the page component and re-renders a 401-row outline.
Evidence: r3.log (`dispatch→2 frames` 29.9–35.3 ms, `switch to Read ms 151`); `pages/PageReader.tsx:169-182, 917-920`.
Proposal: debounce the rail-derived memos (~150 ms) behind `useDeferredValue`; keep `scheduleSave` synchronous.

## Things that work well (keep)

- Slash menu: Korean names lead, English keyword trails, `/표` and 2-beolsik `/ㅗ1` both match; "결과 없음" never swallows Enter (`r1-06`, r1.log).
- Block menu (⌘/ and ⋮⋮): search-first, sections only while browsing, disabled current kind, Esc returns focus to the editor (`r1-07`, `r1-08b`, r1.log).
- Properties: typed selects for the vault's enums, tag chips with suggestions, invalid-key alert inline (`r1-12`, `r1-13`).
- Save failure banner copy and retry, persisted into Read mode (`r3-02b`).
- Recall picker: scope chips, similarity %, floor message, keyboard footer (`r2-light-10`).
- Empty heading placeholders ("제목 2") and the frontmatter collapse keep YAML out of the prose (`r4-03`).
- raw/ files open read-only in the PDF viewer with no editor chrome (`r3-06-attention-is-all-you-need.pdf.png`).
- Zero console noise in every run.

## Coverage gaps

- Korean IME composition in the editor and block menu was not exercised (Playwright cannot compose Hangul); code paths guard `isComposing`.
- Real-vault-only behaviour (git authorship gutter clicks, revert, PDF pinpoint links, image paste to `assets/`) was read, not driven.
- `?mock=1` returns a fallback note for missing paths, so the true not-found state was inferred from code (L26).
