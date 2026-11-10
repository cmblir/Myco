# myco UX backlog — 12 slices from the Mobbin research + three judges

Build tree: `~/prj/karpathy-editor-build/app` (HEAD `1f2e250`). Every file and
line below was read in that tree on 2026-09-26; judge-cited lines that drifted are
corrected here.

Gates per slice: `cd app && npm run lint && npx tsc -b && npx vitest run`, then a
browser check at `http://localhost:5173/?mock=1` (spotlight: `?window=spotlight&mock=1`).
Owner language is Korean: every new user-facing string lands in `lib/i18n.ts` for
en/ko/ja (the parity test fails otherwise).

`touches_permit_divergent_files = true` marks slices editing `PageGraph.tsx`,
`NotchPanel.tsx`, graph looks, or `Sidebar.tsx` — the owner has uncommitted work
there in another worktree. Those slices keep the edit surface small and never
reformat.

## What we learned from Mobbin

- **The palette starts with what you were just doing.** Notion ⌘K opens on
  recent pages with a folder subtitle and a preview pane
  (https://mobbin.com/screens/1ad05716-44a3-48d5-9150-5780546dd323); Obsidian's
  quick switcher creates the note from the typed name
  (https://mobbin.com/screens/dcb9db86-4207-4c0a-936c-8734b792e2e2); Vapi and
  Superhuman section the empty query into Actions / Recent / All
  (https://mobbin.com/screens/593d7acd-2e16-4365-bcd6-02ce52f48f3b,
  https://mobbin.com/screens/04a88f21-128b-416e-98c6-97e1db3b10af). myco's ⌘K
  opens on 2 actions + 10 routes and dead-ends on "No results".
- **The daily note is a timeline, not a file.** Craft pins today's note as the
  first card (https://mobbin.com/screens/d7acd3b4-7d9a-49cb-b847-8b93b79bcd3c);
  Reflect and Tana put ‹ › day navigation on the note
  (https://mobbin.com/screens/a2c5fe18-668a-4f0d-b6a7-917421fba32e,
  https://mobbin.com/screens/ad6644fa-6e1f-45a3-acee-0a22a27f0f86); Tana's home is
  one "Ask or Capture…" box (https://mobbin.com/screens/4297e674-95c8-4646-afe9-96cc77cd4635).
- **Backlinks show the sentence, not the title.** Obsidian
  (https://mobbin.com/screens/59932f82-a889-4b24-b5a6-75be8965334e), Bear
  (https://mobbin.com/screens/9e6cad2e-5927-42dc-8bde-3e4b90a2e0db) and Reflect
  (https://mobbin.com/screens/fdacd3ac-a6a7-45e9-b6dc-98a47338c16f) all render the
  referring line. For an LLM wiki whose answers quote the vault, the same rule
  applies to citations: Notion's inline citations expand to the exact source line
  (https://mobbin.com/screens/2c91507a-4037-445d-b67a-ccb63266e82e).
- **Actions live on the note being read.** Notion's page ··· menu
  (https://mobbin.com/screens/e7b668c8-648a-46c6-a32a-e65cd4c31dd7) and Reflect's
  note actions (https://mobbin.com/screens/9d0db79a-cef1-4b10-b7c6-a06ba916c0d6)
  carry favorite / rename / move / delete; Craft shows location as a clickable
  breadcrumb (https://mobbin.com/screens/a5110fb6-ce5e-4bee-90ea-7fcd69790899).
- **Formatting keys are table stakes.** Bear and Confluence bind ⌘B/⌘I and teach
  the markdown syntax in a cheat sheet
  (https://mobbin.com/screens/f42a17c8-2928-4329-9cd0-a83e58bc72e1,
  https://mobbin.com/screens/622c0046-0e05-4564-9ab2-347221d928cc). myco registers
  only Mod-s and swallows Tab on plain paragraphs.
- **Graphs explain their own encoding.** Obsidian's filter field and colour groups
  (https://mobbin.com/screens/ac93a668-ffbc-43dd-8437-8428767713a1,
  https://mobbin.com/screens/e63e0d58-44f1-4970-8eba-13eca5f54b4a)
  and Reflect's "Filters (2)" badge
  (https://mobbin.com/screens/bcf9fd6e-05ba-4fef-ab8b-6a61d3b86d5d) keep active
  filters visible; myco's legend footer is identical under all 4 questions × 11 looks.
- **Feedback shows a receipt; dialogs are in-app.** Notion confirms restores in an
  in-app dialog (https://mobbin.com/screens/e8ed9805-4357-4690-8bfc-9185f37c0a93);
  Perplexity/Notion acknowledge a rating
  (https://mobbin.com/screens/f1f7b09b-6fad-49fe-9eb5-032b808f6188); Linear and
  Superhuman toasts carry × and Undo
  (https://mobbin.com/screens/14cbb61d-2120-46fa-b29c-b7678e4b85cc,
  https://mobbin.com/screens/7833c5d5-299e-415f-adf4-7f53e586e11a). myco still calls
  `window.prompt/confirm/alert` at 7 sites in a WebView that swallows them.
- **mymind's Keep / Forget teaches the resurfacer from rejections**
  (https://mobbin.com/screens/0361886a-4368-4f6b-9a75-104fee349d49); myco's
  resurface floor only ever learns from accepts.

## Judge consensus (why this order)

| Item | J1 | J2 | J3 |
|---|---|---|---|
| Native dialogs → dialogStore | 8 | 9.5 | 10 |
| ⌘K recent / groups / no dead-end | 9, 9 | – | – |
| Promote Graph+Tasks, breadcrumbs, reveal, recent expanded | 7, 7, 8 | 8 | – |
| Tab fix + ⌘B/⌘I keymap + Read checkboxes | 6, 7, 7 | 7.8, 7.5 | 7 |
| Spotlight abstain / miss receipt / widen scope / range | 6, 6 | – | 9, 6.5, 7 |
| Reader identity + More menu + loading/not-found | 7 | 9, 6.3 | 5.5 |
| Home Ask/Capture + daily timeline + Keep/Later | 8, 8, 6 | – | – |
| Graph legend / filter chips / Esc | 6 | 7.3 | 5 |
| Onboarding focus, ErrorBoundary, toast ×, dark primary, tokens | – | 8.3, 7, 8, 8.5 | 7, 7, 5.5 |
| Korean glossary + lint | (hour 7+) | 9.2 | (out of lens) |
| Citation → passage + backlink snippets | 7, 8 | – | – |
| Ingest gate first / cancelled / refused | 6 | – | 8, 7.5, 5.5 |

Theme index: **stability/consistency** S1 S9 S10 · **navigation+search** S2 S3 ·
**editor look** S4 S6 · **ask/LLM loop** S5 S11 S12 · **home/dashboard** S7 · **graph** S8.

---

## S1 · Stability — no native dialogs; destructive actions confirm and show a receipt
**Theme:** stability/consistency · **Priority 1** · **est. 60 min** · divergent: no

**Goal.** Every prompt/confirm/alert goes through `dialogStore` (the WebView swallows
the native ones, so 새 보드 / 새 로드맵 are likely dead in the installed app), and
the one vault-rewriting button on History confirms first.

**Items** (evidence: Notion restore dialog
https://mobbin.com/screens/e8ed9805-4357-4690-8bfc-9185f37c0a93; audit
`its-audit-3.log.jsonl` confirm.focus lands on the danger button;
`ah-03.log` "confirm dialog after undo click: 0")
1. `components/OverviewBoard.tsx:393-395` `window\n.prompt(t.bd_new_board_prompt)` →
   `await promptText({ title: t.bd_new_board_prompt })`; `:416` `window.confirm(msg)` →
   `await confirmAction({ title: t.bd_delete_board, message: msg, danger: true })`.
2. `components/TaskComposer.tsx:110` and `pages/PageTasks.tsx:445` `window.prompt` →
   `promptText({ title: t.tasks_new_roadmap_ph })` (both handlers become async).
3. `pages/settings/Providers.tsx:61,66,104,132` `window.alert(...)` →
   `notice.warn(t.prov_cli_missing / t.prov_error, { sub: String(e) })` from
   `lib/notice`; add the two keys en/ko/ja (the current strings are hardcoded English).
4. `pages/PageHistory.tsx:135-146` `undoRun`: `confirmAction({ danger: true, title:
   t.set_distill_undo, message: t.history_undo_msg })` before `ipc.undoDistillRun`;
   button class `btn btn--danger` (row at `:234-244`); `notice.ok(t.history_undo_done)`
   on success. `setRunError` already surfaces failure.
5. `stores/dialogStore.ts` `DialogRequest` gains `confirmLabel?: string` (passed
   through `promptText`/`confirmAction`); `components/DialogHost.tsx:100-105` uses it
   before `dlg_create`; `:36-46` focuses the **cancel** button when `request.danger`.
   `components/SidebarMenu.tsx:114` rename prompt passes `confirmLabel: t.sb_rename`.

**Files.** `components/OverviewBoard.tsx`, `components/TaskComposer.tsx`,
`pages/PageTasks.tsx`, `pages/settings/Providers.tsx`, `pages/PageHistory.tsx`,
`stores/dialogStore.ts`, `components/DialogHost.tsx`, `components/SidebarMenu.tsx`,
`lib/i18n.ts`.

**Acceptance.**
- `grep -rnE "\.(prompt|confirm|alert)\(" src --include='*.ts*'` returns nothing
  (the OverviewBoard call is split across lines, so a `window\.prompt` grep misses it).
- `?mock=1` → 홈 → 관리 도구 → 새 보드: an in-app dialog appears; naming it creates and
  switches the board (mock `save_dashboard` exists). 보드 삭제 asks in-app.
- `?mock=1` → 히스토리 → 이 실행 되돌리기: confirm dialog opens with focus on 취소; Enter
  does NOT undo; confirming shows the ok toast.
- Rename from the tree's context menu: primary button reads 이름 바꾸기, not 만들기.
- `npx vitest run` green (no existing test asserts the native calls).

---

## S2 · ⌘K opens on what you were doing and never dead-ends
**Theme:** navigation+search · **Priority 2** · **est. 90 min** · divergent: no

**Goal.** Empty palette = Actions / Recent / Go to / Lenses with per-group caps and a
folder path under page rows; a miss offers "Create “{q}”" and "Ask the wiki: {q}";
the footer is a key legend.

**Items** (evidence: Notion search rows + preview
https://mobbin.com/screens/1ad05716-44a3-48d5-9150-5780546dd323; Obsidian find-or-create
https://mobbin.com/screens/dcb9db86-4207-4c0a-936c-8734b792e2e2; sectioned empty
palette https://mobbin.com/screens/593d7acd-2e16-4365-bcd6-02ce52f48f3b,
https://mobbin.com/screens/04a88f21-128b-416e-98c6-97e1db3b10af; Craft location
subtitle https://mobbin.com/screens/d370247f-a6ec-4e59-a67e-ddf2aa9aae8c; Reflect
"Create note" row https://mobbin.com/screens/40df0591-51c4-41b0-a14b-9d04e99aa5f3;
key-legend footer https://mobbin.com/screens/84169c57-5cd6-4495-bb71-93d37266f4c4;
Tana no-results https://mobbin.com/screens/51add4e7-c5a7-4fb8-9366-34dde8c5eeb9;
audit `shots/chrome-home/12-cmd-empty-ko-light-1280.png`, `13b-cmd-nohit-ko-light-1280.png`)
1. `lib/navHistory.ts`: pure `recentPages(h: NavHistory, n: number): RouteId[]` —
   last `n` distinct `page:` entries, newest first, excluding the current route.
   `components/CommandBar.tsx:160-198` builds `recent` from
   `useUIStore((s) => s.navHistory)` mapped onto `pages` (label from the file name).
2. No-query branch (`:229-233`): replace `base.slice(0, 12)` with grouped rendering —
   `cmd-group-label` rows (class exists at `:396`) for Actions (2), Recent (≤5),
   Go to (10), Lenses (4); the flat `filtered` list stays for typed queries.
3. Page rows (`:372-394`): add `<span className="cmd-path">` = vault-relative parent
   folder (`r.to.slice(5)` minus `currentVault.path`, minus the file name); tag
   `cb_tag_file` → "노트" in ko.
4. Zero hits (`:366-371`) or `q.trim().endsWith("?")`: prepend two action rows —
   `Create “{q}”` → `createNoteAndOpen(q)` (`lib/newNote.ts:33`) and `Ask the wiki:
   {q}` → `setQueryPrefill(q); setRoute("query")` (consumed at `pages/PageQuery.tsx:135`).
   They take part in arrow selection (`total` bookkeeping at `:236-241`).
5. Footer (`:466-473`): kbd chip row `↑↓ · ↵ 열기 · ⌥↵ 놓친 검색 기록 · esc` +
   `{total}건` right-aligned; move `cb_operator_hint` into the input placeholder.
   `cb_miss_done` receipt stays.

**Files.** `components/CommandBar.tsx`, `lib/navHistory.ts` (+ test in
`stores/uiStore.test.ts` or new `lib/navHistory.test.ts`), `lib/newNote.ts` (read
only), `lib/queryPrefill.ts` (read only), `lib/i18n.ts` (cb_group_actions/recent/goto/
lenses, cb_create_q, cb_ask_q, cb_key_open/miss, cb_results_n), `styles.css` (`.cmd-path`).

**Acceptance.**
- vitest: `recentPages` dedupes, excludes the current route, caps at n, ignores
  non-page routes.
- `?mock=1`: open two notes, press ⌘K → "Recent" group lists them newest first with
  their folder under the name; Actions / Go to / Lenses labels visible; no group
  exceeds its cap.
- Type `zzzq` → rows `Create “zzzq”` and `Ask the wiki: zzzq`; ↓↓↵ on the second
  lands on Ask with the question in the composer.
- Footer shows keycaps and a count; the operator hint is in the placeholder.
- `?mock=1` lens mode (pick 고립) still filters rows and Backspace drops the lens.

---

## S3 · Sidebar: Graph and Tasks are primary, the tree reveals the open note, Recent is open on first paint
**Theme:** navigation+search · **Priority 3** · **est. 75 min** · divergent: **yes** (Sidebar.tsx)

**Goal.** The feature the product is named for is one click away; the breadcrumb
names every page; opening a note from Recent/⌘K/citation expands its folder;
최근 수정 shows its 5 rows and a real count without a click.

**Items** (evidence: Obsidian ribbon keeps Graph one click away; Notion Recents always
expanded https://mobbin.com/screens/41f32a46-0aa4-4205-a6ab-627135308029; audit
patterns 156/158/160 — `shots/chrome-home/08-sidebar-tools-closed-ko-light-1280.png`,
`19-daily-note-ko-light-1280.png` (daily folder collapsed, no active row),
`05-sidebar-ko-light-1280.png` vs `09-status-open` count 0→5)
1. `components/Sidebar.tsx:38` `TOOL_ROUTES = ["study","history","provenance"]`; move
   the 그래프 and 할 일 `NavItem`s (`:352-365`) into the primary `nav-group` after
   정리 제안 without `indent`. `toolsBadge` unchanged (Study only).
2. `components/Topbar.tsx:509-531` `breadcrumbFor`: add `tasks` / `study` / `feedback`
   branches (icons check / sparkles / inbox as the sidebar uses); `page:` branch
   returns `[project, ...folderChain, stripExt(name)]` relative to the vault root
   (root from `useVaultStore` at the call site `:46`). Extend `Topbar.test.ts`.
3. Reveal: `Sidebar.tsx` effect on `route` — when `page:`, split the vault-relative
   path, set every ancestor `expandedFolders[abs] = true` (add
   `uiStore.expandFolders(ids: string[])` beside `toggleFolder` at `:274`), then
   `document.querySelector(`[data-path="${CSS.escape(path)}"]`)?.scrollIntoView({block:"nearest"})`.
   `components/SidebarTree.tsx:43-58` leaf button gets `data-path={node.path}`.
4. `Sidebar.tsx:49` `?? false` → `?? true`; the mtimes effect `:125-137` drops the
   `recentOpen` guard and depends on `[currentVault, fileTree]` (Overview already
   fetches the same list; one extra call per tree change is fine —
   `ponytail:` hoist to vaultStore if the double fetch ever shows in profiles).

**Files.** `components/Sidebar.tsx`, `components/SidebarTree.tsx`,
`components/Topbar.tsx` (+ `Topbar.test.ts`), `stores/uiStore.ts` (+ `uiStore.test.ts`).

**Acceptance.**
- `?mock=1`: 그래프 and 할 일 sit in the primary group; 더 보기 lists 학습/히스토리/출처.
- Tasks page breadcrumb reads `myco / 할 일`; a note under `wiki/` reads `myco / wiki / name` (no `.md`).
- ⌘K → open a note whose folder is collapsed → the folder expands and the row is in
  view with `.active`.
- On first load 최근 수정 is expanded with 5 rows and the count reads 5.
- `Topbar.test.ts`, `uiStore.test.ts` green; diff to Sidebar.tsx is additive (no reformat).

---

## S4 · Editor keyboard parity: Tab stops swallowing, ⌘B/⌘I/⌘E/⌘K/⌘⇧H marks, Read-mode checkboxes tick
**Theme:** editor look · **Priority 4** · **est. 75 min** · divergent: no

**Goal.** The three keyboard habits every Notion/Obsidian user brings on day one work,
and the one edit readers make (ticking a to-do) no longer forces a mode switch.

**Items** (evidence: Bear/Confluence formatting keys + cheat sheet
https://mobbin.com/screens/f42a17c8-2928-4329-9cd0-a83e58bc72e1,
https://mobbin.com/screens/622c0046-0e05-4564-9ab2-347221d928cc,
https://mobbin.com/screens/4df2e914-3742-4b59-bda4-a52ed23ee990; Obsidian Reading
view toggles tasks in place; audit `reader-editor/r3.log.json` "Tab on paragraph"
{changed:false, focus:cm-content}; `shots/reader-editor/r1-10-rich-read.png`)
1. `lib/editorBlocks.ts:1060-1067`: `run: (view) => acceptCompletion(view) ||
   run((s) => tabTr(s, 1))(view)` and the Shift-Tab twin — drop `|| true` so a null
   transaction lets the key through (WCAG 2.1.2). Add a case to the `tabTr` block in
   `lib/editorBlocks.test.ts:496` asserting the binding returns false on a paragraph.
2. New `lib/editorFormat.ts`: `wrapTr(state, left, right)` — wraps
   `selection.main` (or inserts an empty pair with the caret inside);
   `formatKeymap(): Extension` binding Mod-b `**`, Mod-i `*`, Mod-e `` ` ``, Mod-k
   `[[`/`]]`, Mod-Shift-h `==`. Register in `components/Editor.tsx:210` next to
   `Mod-s` (before `defaultKeymap`, which owns Mod-i/Mod-k otherwise). No toggle-off
   (YAGNI). Unit test `wrapTr` on a selection and on an empty caret.
3. `lib/markdown.ts:245`: `box.meta = { checked, line: inline.map[0] }` (`inline.map`
   is already guarded at `:237`);
   renderer `:333-334` emits `<input type="checkbox" data-line="N"${checked}>` (no
   `disabled`). `components/Viewer.tsx` `handleClick`: an
   `input[type=checkbox][data-line]` target calls new prop `onToggleTask?(line)`.
   `pages/PageReader.tsx:949` passes it: flip `[ ]`↔`[x]` on body line `line`
   (+ `lineOffset`) through `replaceLines` + `applyDocEdit` (`:443`).
4. `components/HelpWidget.tsx:63-77`: a third group "마크다운" listing the five keys
   plus `/`, `[[`; keys `hw_sc_bold/italic/code/link/highlight`.

**Files.** `lib/editorBlocks.ts` (+ test), new `lib/editorFormat.ts` (+ test),
`components/Editor.tsx`, `lib/markdown.ts`, `components/Viewer.tsx`,
`pages/PageReader.tsx`, `components/HelpWidget.tsx`, `lib/i18n.ts`.

**Acceptance.**
- vitest: Tab binding returns false on a plain paragraph and still nests a list
  item; `wrapTr("bold")` → `**bold**`; empty caret → `****` with caret at 2.
- `?mock=1` Write mode: select a word, ⌘B → `**word**`; ⌘K → `[[word]]`; Tab on a
  paragraph moves focus to the next control instead of nothing.
- Read mode on a note with `- [ ] x`: the box is enabled; clicking it rewrites the
  source line to `- [x] x` (visible after ⌘E), autosave fires.
- Help panel shows the Markdown group.

---

## S5 · Ask trust: Spotlight abstains honestly, miss-log shows a receipt, "widen" is one-off, abstain names the period
**Theme:** ask/LLM loop · **Priority 5** · **est. 60 min** · divergent: no

**Goal.** "Answers quote the vault or say nothing" holds on every surface, and the
feedback controls behave like controls.

**Items** (evidence: abstain-as-abstain
https://mobbin.com/screens/dd154cd6-e461-46c9-8cb3-38f6ddbc489e; feedback receipt
https://mobbin.com/screens/f1f7b09b-6fad-49fe-9eb5-032b808f6188; audit `ah-01.log`
"scope after widen: 전체; turns: 3", `ah-02.log` "miss button still present &
unchanged", `shots/ask-history/33-ask-miss-clicked.png`, `11-abstain-widen-result.png`,
`12-ask-range.png`, `35-spotlight-ask.png`)
1. `lib/spotlight.ts:32-41` `SpotlightAnswer.abstained?: boolean`; `:97-107` forwards
   `turn?.abstained`. `components/Spotlight.tsx:512-521`: when `abstained` render
   `t.q_abstain_title` + `t.spot_open_ask` hint instead of the verbatim label and
   Viewer (the `answer` there is reindex advice, not a quote).
2. `pages/PageQuery.tsx:515-531`: local `missLogged: Set<number>` state; on success
   add `i` → button `disabled` reading `t.q_miss_done` ("기록됨 ✓") with
   `role="status"`; on failure `notice.warn(t.q_miss_failed, { sub: String(e) })`.
   The `.catch(() => undefined)` goes away.
3. `stores/queryStore.ts:122` `ask(question, lang, copy, opts?: { scope?: AskScope })`;
   `:172` `const scope = opts?.scope ?? useUIStore.getState().askScope`.
   `PageQuery.tsx:486-492` `onWiden` → `askStore(turn.q, lang, askCopy(t), { scope: "all" })`,
   no `setAskScope`. Test in a new `stores/queryStore.test.ts`: widen leaves
   `uiStore.askScope` unchanged (mock `ipc` like `vaultStore.test.ts` does).
4. `components/AbstainCard.tsx` gets `range?: { start: string; end: string }`;
   subtitle uses `t.q_abstain_range_sub` ("{s}–{e} 사이에는 …") when present and the
   widen CTA reads `t.q_abstain_widen_range` ("기간 없이 다시 검색"); `PageQuery.tsx:477`
   passes `turn.range` (already rendered as a chip at `:451`).

**Files.** `lib/spotlight.ts`, `components/Spotlight.tsx`, `pages/PageQuery.tsx`,
`stores/queryStore.ts` (+ new test), `components/AbstainCard.tsx`, `lib/i18n.ts`.

**Acceptance.**
- vitest: `ask(..., { scope: "all" })` runs with scope all and `useUIStore.getState().askScope`
  is still `"wiki"`.
- `?mock=1` Ask a nonsense question → abstain card; click widen → segment stays on
  위키; the re-asked turn has scope chip 전체.
- Ask "attention" → click 기록하기 → button becomes 기록됨 ✓ and is disabled.
- `?window=spotlight&mock=1` (or the bridge payload in a unit test): an abstained
  turn shows the abstain title and no "From your notes (verbatim)" label.

---

## S6 · Reader identity: one name, folder breadcrumb, real loading/not-found, note actions + "Open in graph" in ···
**Theme:** editor look · **Priority 6** · **est. 90 min** · divergent: no

**Goal.** The first 100px of a note stop repeating its name four times; the reader
can favorite/rename/move/delete the note it shows and jump to its place in the graph.

**Items** (evidence: Notion page header + ··· menu
https://mobbin.com/screens/e7b668c8-648a-46c6-a32a-e65cd4c31dd7,
https://mobbin.com/screens/536cd46b-0e91-41e2-adaf-7da374e4587f; Reflect note actions
https://mobbin.com/screens/9d0db79a-cef1-4b10-b7c6-a06ba916c0d6; Craft location crumb
https://mobbin.com/screens/a5110fb6-ce5e-4bee-90ea-7fcd69790899; Tana type badge
https://mobbin.com/screens/73bcd93e-3c5d-4d0d-b5e9-7c292e116c34; audit
`shots/reader-editor/r1-01-write-default.png`, `g6.log graphLinks:[]`)
1. `pages/PageReader.tsx:714-717` typebadge → `fm.type ?? "note"` (`fm` at `:169`);
   delete the absolute-path `<span>` (`:718-730`); keep `title={path}` on the `<h1>`.
   The folder chain now lives in the Topbar breadcrumb (S3); no dependency — this
   slice only removes.
2. `:689-697`: `loading` (activeFile absent, no error) → `rd-skeleton` (title bar + 3
   muted lines, `aria-busy`); `error` → `t.rd_not_found` + two buttons: 사이드바에서
   찾기 (`toggleCmd`) and 홈으로 (`setRoute("overview")`). Add `rd_loading`, `rd_not_found`.
3. New `lib/noteActions.ts` with `favoriteNote(path)`, `renameNote(path, t)`,
   `moveNote(path, t)`, `deleteNote(path, t)` lifted from
   `components/SidebarMenu.tsx:93-140` (`handleFavorite/Move/Rename/Delete` become
   one-line calls; `FolderList` at `SidebarMenu.tsx:204` gets `export`). After
   rename/move the reader routes to the new path; after delete → overview.
4. `PageReader.tsx:812-860` More menu: add 즐겨찾기 (star / filled star), 이름 바꾸기,
   이동…, 삭제 (danger row), and 그래프에서 보기 → `openGraph("neighbors", path)`
   (`lib/graphLink.ts:18`). All disabled when `isRaw`.

**Files.** `pages/PageReader.tsx`, new `lib/noteActions.ts`,
`components/SidebarMenu.tsx`, `lib/graphLink.ts` (read), `lib/i18n.ts`, `styles.css`
(`.rd-skeleton`).

**Acceptance.**
- `?mock=1` open any note: badge reads the frontmatter type (or 노트), no absolute
  path row; ··· lists 5 new items.
- 그래프에서 보기 → Graph opens on the neighbours question with that note selected.
- 이름 바꾸기 → dialog (confirm label 이름 바꾸기) → reader shows the renamed note, tree
  updated. 삭제 → danger confirm → lands on 홈.
- `setRoute("page:/v/does-not-exist.md")` (mock falls back — verify with a path the
  mock refuses, or assert the branch in a small `PageReader` state test) shows the
  not-found copy, never "Loading…".
- Right-click menu in the tree still works (calls the same lib).

---

## S7 · Home: Ask/Capture box, daily-note timeline, reunion Keep/Later
**Theme:** home/dashboard · **Priority 7** · **est. 90 min** · divergent: no
(`Sidebar.tsx` is NOT edited — the daily-note helper is lifted into `lib/` and the
sidebar keeps its copy until the owner merges; dedupe noted below)

**Goal.** The first keystroke on Home already does something; yesterday is one click
from today; a "no" on a resurfaced note teaches the picker.

**Items** (evidence: Tana Ask-or-Capture + greeting
https://mobbin.com/screens/4297e674-95c8-4646-afe9-96cc77cd4635,
https://mobbin.com/screens/6f3f108c-92ad-445e-a28d-22bdab8f6e50; Notion iOS ask on home
https://mobbin.com/screens/d120561c-525c-42e5-a177-c5bfa948a721; Craft daily first card
https://mobbin.com/screens/d7acd3b4-7d9a-49cb-b847-8b93b79bcd3c,
https://mobbin.com/screens/c0e34ca5-a9e3-4eda-a15f-03b549cdccdf; Reflect/Tana ‹ ›
https://mobbin.com/screens/a2c5fe18-668a-4f0d-b6a7-917421fba32e,
https://mobbin.com/screens/ad6644fa-6e1f-45a3-acee-0a22a27f0f86; mymind Keep/Forget
https://mobbin.com/screens/0361886a-4368-4f6b-9a75-104fee349d49; audit
`shots/chrome-home/01-home-ko-light-1280.png`, pattern 92 MorningBand rows)
1. New `lib/dailyNote.ts`: `dailyPath(vault, isoDay)`, `openDailyNote(vault, isoDay)`
   (create-or-open, copied from `components/Sidebar.tsx:543-590` DailyNoteButton),
   `appendToDaily(vault, line)` (readFile → writeFile with `- HH:MM line`), and
   `shiftDay(isoDay, ±1)` (UTC-safe). Unit-test `shiftDay` across a month boundary.
2. `pages/PageOverview.tsx`: a `<textarea rows=1>` band at the top of the page body
   (above the existing blocks) with placeholder `t.home_ask_ph`; Enter →
   `queryStore.ask(v)` + `setRoute("query")` (the Ask page opens on the turn in
   flight); if an answer is already running, `setQueryPrefill(v)` instead; the chips
   ask the same way; ⌘/Ctrl+Enter → `appendToDaily` +
   `notice.ok(t.home_captured)`; three `intakeCopy.examples` chips beneath. Greeting
   line by hour (`t.home_greet_morning/afternoon/evening`) + `Intl.DateTimeFormat`
   weekday/date. No new store.
   *Decision (review of the S7 build, 2026-09-28):* Enter asks straight away instead
   of only prefilling (the Tana/Notion pattern the evidence shows), so one Enter on
   Home runs an answer with no confirm step on the Ask page. The owner may revert it
   to prefill-only; that means the code, `home_ask_keys` in en/ko/ja and the chips.
3. `pages/PageReader.tsx` header: when `path` matches `/daily\/(\d{4}-\d{2}-\d{2})\.md$/`
   render ‹ 어제 · 내일 › buttons calling `openDailyNote(vault, shiftDay(day, ±1))`.
   *As built after review:* only the vault's own `daily/` (and `daily/archive/<week>/`,
   where the weekly rollup moves a settled day) with a real calendar date — an
   impossible date such as `2026-09-31` throws in JSC during render.
4. `components/RecentNotes.tsx`: prepend today's `daily/<today>.md` row (calendar icon,
   label 오늘의 노트) — opens if in `entries`, else creates via `openDailyNote`.
5. `components/MorningBand.tsx:306-312`: reunion row gains two quiet `Button`s (same
   `ACTS` span the due row uses at `:321`) — `t.ritual_keep` (existing
   `openRitualPick`) and `t.ritual_later` (`useResurfaceStore.getState().snooze(ritualPick.page)`;
   `snooze` already drops the page from `picks`, `stores/resurfaceStore.ts:240-246`, so
   `resurfacePicks[0]` becomes the next pick).

**Files.** new `lib/dailyNote.ts` (+ test), `pages/PageOverview.tsx`,
`pages/PageReader.tsx`, `components/RecentNotes.tsx`, `components/MorningBand.tsx`,
`stores/resurfaceStore.ts` (read), `lib/intakeCopy.ts` (read), `lib/i18n.ts`.
Follow-up (not this slice): point `Sidebar.tsx` DailyNoteButton at `lib/dailyNote.ts`
once the owner's sidebar work lands.

**Acceptance.**
- vitest: `shiftDay("2026-10-01", -1) === "2026-09-30"`; `shiftDay("2026-12-31", 1) === "2027-01-01"`.
- `?mock=1` Home: type a question, Enter → Ask page shows the question answered (or
  waiting in the field when another answer is running). Type a line,
  ⌘Enter → toast; 오늘의 노트 shows a new `- HH:MM …` line.
- Open the daily note → ‹ › in the header; ‹ opens (creates) yesterday's file, › returns.
- RecentNotes first row is 오늘의 노트 with a calendar icon.
- 관리 도구 → reunion row shows Keep / Later; Later removes the pick and (with two
  picks in mock) shows the next one; `resurfaceStore.test.ts` green.

---

## S8 · Graph honesty: legend explains the question, filters are visible chips, Esc closes the top thing, "pick a note" banner
**Theme:** graph · **Priority 8** · **est. 75 min** · divergent: **yes** (PageGraph.tsx)

**Goal.** The picture can be read: the footer says what colour/size mean for the
active question, a persisted filter has a visible cause, and Esc does what the help
promises.

**Items** (evidence: Obsidian filter field + colour groups
https://mobbin.com/screens/ac93a668-ffbc-43dd-8437-8428767713a1 (mobbin-obsidian.md),
https://mobbin.com/screens/e63e0d58-44f1-4970-8eba-13eca5f54b4a; Reflect "Filters (2)"
https://mobbin.com/screens/bcf9fd6e-05ba-4fef-ab8b-6a61d3b86d5d; audit `g3.log`
legendFooter identical across 11 looks, `g2.log anyFilterIndicatorOutsideDrawer:false`,
`g5.log` "Esc with inspector open… still open", `shots/graph/07-q1-time.png`,
`32-tag-filter.png`, `90-neighbors-no-selection.png`)
1. `components/GraphLegend.tsx:25-30` props `question: Question`, `layout: string`;
   footer `:86-99` first line = `t[`gr_enc_${question}`]` (all 4 keys exist en/ko/ja,
   zero usages today), then `x = 마지막 수정일` when `layout === "strata"`, then the
   existing four lines. `pages/PageGraph.tsx:2089-2094` passes `settings.question`,
   `settings.layout`.
2. `PageGraph.tsx` bar (beside the question segment, near `:2064`): one `Chip` per
   non-default `settings.search / tagFilter / folderFilter / existingOnly` with × →
   `setSettings((p) => ({ ...p, <field>: default }))`. Labels `gr_chip_search/tag/folder/existing`.
3. `PageGraph.tsx:760-766` Esc handler (today only `if (popFrame())
   e.stopPropagation()`): `if (helpOpen) setHelpOpen(false); else if (selected)
   setSelected(null); else if (!popFrame()) return;` then `stopPropagation`. Fly mode
   already exits on Esc in its own handler (`:1423`) — leave it. Keep the
   input/textarea guard.
4. `components/GraphQuestions.tsx` (or the bar): when `settings.question ===
   "neighbors"` and nothing is selected render `t.gr_q_pick` as a small banner
   (`role="status"`) and focus the drawer search on click.

**Files.** `components/GraphLegend.tsx`, `pages/PageGraph.tsx`,
`components/GraphQuestions.tsx`, `lib/i18n.ts` (4 chip labels), `styles.css` if the
banner needs a rule. `GraphControls.test.ts` untouched.

**Acceptance.**
- `?mock=1` Graph: switch 질문 → legend footer's first line changes (4 distinct strings).
- Drawer → 필터 → pick a tag → close drawer: a chip `#tag ×` sits in the bar; × clears
  only the tag (search/folder untouched); chips persist across reload (settings are
  in localStorage).
- Open the inspector from a gap row → Esc closes it; Esc again pops the frame; Esc in
  fly mode exits fly.
- Select 이웃 with nothing selected → banner "노트를 하나 고르세요".
- Diff to PageGraph.tsx ≤ ~40 lines, no reformat; `GraphControls.test.ts` green.

---

## S9 · Chrome consistency: one modal focus contract, exits on the crash screen, toast ×, one primary button in dark, status tokens
**Theme:** stability/consistency · **Priority 9** · **est. 75 min** · divergent: no

**Goal.** The first screen a new user sees owns focus; every stuck state has an exit;
dark theme shows one primary per view; status colours come from tokens.

**Items** (evidence: Linear toast ×
https://mobbin.com/screens/14cbb61d-2120-46fa-b29c-b7678e4b85cc; Superhuman
https://mobbin.com/screens/7833c5d5-299e-415f-adf4-7f53e586e11a; Linear "every colour
is a token" https://mobbin.com/screens/efc1c7a1-c215-4de7-be32-4f68a1bb3e20; audit
`its-audit-3.log.jsonl` obFocus0:BODY, escClosesWizard:false, ebAfterRetry:true;
`shots/ingest-tasks-settings/onboarding-s0-ko-dark-1280.png` (two white buttons),
`errorboundary-graph-ko-dark-1280.png`)
1. Extract `components/DialogHost.tsx:29-98` (initial focus, restore, Tab trap,
   Escape) into `components/useModalFocus.ts` `useModalFocus(ref, { onEscape,
   initial })`; DialogHost and `components/OnboardingWizard.tsx:161-170` both call it
   (wizard: Escape = `onClose`, initial = the step's primary button).
2. `components/ErrorBoundary.tsx:80-101`: add 홈으로 (`useUIStore.getState().setRoute("overview")`
   then reset) and 리포트 복사 (`formatCrashReport` from `lib/crashReport.ts:14` →
   `navigator.clipboard.writeText`, `notice.ok`); raw `error.message` moves into a
   `<details>` 자세히.
3. `components/NoticeStack.tsx:131-142`: `IconButton` (from `./ui`) with
   `aria-label={t.ui_close}` calling `onClose()`; drop the opacity fade on
   `.is-depth-2` in `styles.css`.
4. `styles/ui.css:63-71` + `styles.css` dark block: `[data-theme="dark"] .u-btn--primary,
   [data-theme="dark"] .btn-primary { background: var(--accent-strong, #7c6cf0); color: #fff }`
   (pick the violet already used for focus rings) so 다음 ≠ 폴더 열기….
5. Mechanical: replace `#dc2626 → var(--danger)`, `#16a34a → var(--ok)`,
   `#b45309 → var(--warn)`, `#22c55e → var(--ok)` in the 20 files
   `grep -rl` lists (components/ModelSelect, AudioOverviewPanel, Topbar,
   ConversationImport, AgentPanel, OllamaSetup, PdfViewer, TaskBoard; pages/settings/
   Model, Account, Mcp, Distill, Providers; pages/PageProvenance, PageStudy, PageTasks,
   PageFeedback, PageQuery, PageHistory, PageOverview). Tokens exist at `styles.css:45,115,9036-9052`.

**Files.** new `components/useModalFocus.ts`, `components/DialogHost.tsx`,
`components/OnboardingWizard.tsx`, `components/ErrorBoundary.tsx`,
`components/NoticeStack.tsx`, `styles.css`, `styles/ui.css`, the 20 files above,
`lib/i18n.ts` (eb_home, eb_copy_report, eb_details).

**Acceptance.**
- `?mock=1` with `localStorage.removeItem("myco.onboarded")` and an empty vault
  (`?mock=1&empty=1` if the flag exists, else clear pages in devMock): wizard opens
  with focus on its primary button; Tab cycles inside; Esc closes it.
- Crash screen (throw from a component under `?mock=1` via React devtools, or a
  render test of `ErrorBoundary` with a throwing child): 홈으로 routes to overview;
  리포트 복사 shows the ok toast.
- Any toast has a × that removes it; three stacked toasts are fully opaque.
- Dark theme onboarding step 1: 다음 is visibly the only primary.
- `grep -rn '#dc2626\|#16a34a\|#b45309\|#22c55e' src --include='*.tsx'` → 0 hits;
  `noticeStore.test.ts`, `ui.test.ts` green.

---

## S10 · Korean glossary sweep + a string lint that keeps it
**Theme:** stability/consistency · **Priority 10** · **est. 60 min** · divergent: no

**Goal.** One word per concept across the ko UI — 볼트 · 노트 · 자료 추가 · 정리 ·
막힘 · 원문 — enforced by a vitest so drift cannot return.

**Items** (evidence: audit `chrome-home-run.out` TERMS (볼트/보관함/vault on one page),
`shots/chrome-home/22-new-note-dialog-ko-light-1280.png` ('새 노트' + '메모의 제목'),
`shots/ingest-tasks-settings/ingest-more-open-ko-dark-1280-full.png`; counts verified
in the ko block `lib/i18n.ts:3735-5628`: `vault` 20, `Ingest` 4, `인제스트` 15,
`메모` 15, `보관함` 2)
1. `lib/i18n.ts` ko block: `vault`/`보관함`/`메모 보관 폴더` → 볼트; `메모` → 노트
   (except 메모리); `Ingest`/`인제스트`/`가져오기 완료` → 자료 추가 (`ing_success_title`
   → "자료 추가 완료"; report labels "자료 추가 보고서"); `tasks_col_blocked` → 막힘;
   source-mode strings unify on 원문; `set_distill_*` tab/button labels → 정리 (leave
   the technical 증류 in Distill's advanced descriptions — 92 hits, out of budget).
   Same pass over `lib/everydayCopy.ts`, `lib/intakeCopy.ts`, `lib/graphLookCopy.ts` ko
   entries (노드/메모 → 노트 in user-facing labels).
2. New `lib/i18n.glossary.test.ts` beside `i18n.parity.test.ts`: iterate
   `Object.entries(STRINGS.ko)`, fail on `/\bvault\b|Ingest|인제스트|보관함|메모(?!리)/`
   with a small `ALLOW` set for keys that must keep the word (e.g. product names in
   `set_mcp_*` command strings). Print the offending key.

**Files.** `lib/i18n.ts`, `lib/everydayCopy.ts`, `lib/intakeCopy.ts`,
`lib/graphLookCopy.ts`, new `lib/i18n.glossary.test.ts`.

**Acceptance.**
- `npx vitest run src/lib/i18n` — glossary + parity green; reintroducing "vault" in a
  ko value fails with the key name.
- en/ja values untouched (`git diff --stat` shows only ko lines + the copy files).
- `?mock=1`: sidebar, 새 노트 dialog, Ingest page, Settings tabs show 볼트/노트/자료
  추가 consistently; no "Ingest" in the ko UI.

---

## S11 · Read the sources: a citation lands on its passage; backlinks show the linking sentence
**Theme:** ask/LLM loop · **Priority 11** · **est. 90 min** · divergent: no

**Goal.** Verifying a verbatim quote is one click and the eye lands on it; the
Connections rail says *why* a note links here.

**Items** (evidence: Notion inline citation → source line
https://mobbin.com/screens/2c91507a-4037-445d-b67a-ccb63266e82e; Perplexity source hover
https://mobbin.com/screens/9bd45c42-abfc-4488-b961-0acfa0a60c0a; Obsidian backlink
context https://mobbin.com/screens/59932f82-a889-4b24-b5a6-75be8965334e; Bear
https://mobbin.com/screens/9e6cad2e-5927-42dc-8bde-3e4b90a2e0db; Reflect
https://mobbin.com/screens/fdacd3ac-a6a7-45e9-b6dc-98a47338c16f; audit
`shots/ask-history/07-reader-from-cite.png` (lands at top, nothing highlighted))
1. `lib/pendingAnchor.ts`: add `setPendingLine(path, needle)` / `takePendingLine(path)`
   (same Map pattern). `pages/PageQuery.tsx:637` cite `onClick`: `setPendingLine(abs,
   firstNonEmptyLine(r.quote))` before `onOpenPage(r.page)` (`openPage` at `:194`
   builds the abs path — pass it through).
2. `pages/PageReader.tsx:384-390` effect: after the anchor, `const needle =
   takePendingLine(path)`; find `draft.split("\n").findIndex((l) => l.includes(needle))`
   (fallback: first 40 chars); `scrollToHeading({ line })` then add class `rd-flash`
   to the line element (Read: `[data-line]` nearest; Write: `view.lineBlockAt` DOM
   node) for 1.5 s. `styles.css`: `.rd-flash` keyframe, off under
   `prefers-reduced-motion`. Headings already carry `data-line`; paragraphs get it
   via `md.renderer.rules.paragraph_open` the same way as `heading_open`
   (`lib/markdown.ts:356-361`).
3. `lib/readerRail.ts` `ConnRow` gains `snippet?: string; line?: number`;
   `connectionRows` takes `hitsByPath?: Map<string, SearchHit>` and attaches the
   snippet to backlink rows (pure; test it).
4. `components/ConnectionsPanel.tsx`: `useEffect` on `filePath` →
   `ipc.searchVault(`[[${stem(filePath)}`, 50)` (`lib/ipc.ts:857`, mocked at
   `devMock.ts:1584`) → map by `hit.path`; render `row.snippet` as a `.meta` second
   line with the `[[…]]` wrapped in `<mark>`; group rows under three sub-headers
   `백링크 N · 관련 N · 제안 N` (kind order is already stable).

**Files.** `lib/pendingAnchor.ts` (+ test), `pages/PageQuery.tsx`,
`pages/PageReader.tsx`, `lib/markdown.ts`, `styles.css`, `lib/readerRail.ts` (+ test
`lib/readerRail.test.ts` if absent), `components/ConnectionsPanel.tsx`, `lib/i18n.ts`.

**Acceptance.**
- vitest: `takePendingLine` consumes once; `connectionRows` attaches `snippet` only to
  backlink rows whose path is in the map.
- `?mock=1` Ask "attention" → click citation ① → the reader is scrolled so the quoted
  line is in view and it flashes; ⌘[ returns to the answer.
- Open a note with backlinks (mock `transformer-architecture`): each backlink row shows
  the sentence containing the link with the link marked; sub-headers show counts;
  related/suggested rows unchanged; accepting a suggestion still works.

---

## S12 · Ingest: the plan gate is the first thing on screen; cancel and refusal have a state
**Theme:** ask/LLM loop (capture) · **Priority 12** · **est. 75 min** · divergent: no

**Goal.** A run paused for a human decision looks paused, the decision is above the
fold, and every terminal state (done / cancelled / refused) has one card with a next
action.

**Items** (evidence: audit `shots/ingest-tasks-settings/ingest-flow-gate.png` (gate at
y≈1000 while the hero animates "LLM 위키 작성 중"), `ingest-flow-cancelled.png` +
`its-audit.log.jsonl afterCancel:{form:true,body:1668}`, `ingest-flow-final.png`
(success ×3, open-index goes external), `ingest-flow-drop.png`; one-success-surface as
in Linear/Notion https://mobbin.com/screens/8a1cf5b7-c30b-419c-b601-280c9cf6b1d9)
1. `components/IngestProgress.tsx:75-79`: add `const waiting = stage === "plan-gate"`
   (keep `running` as is — it drives the elapsed ticker and the cancel button); title
   `:108-114` → `t.ing_gate_title` ("계획 검토 중 — 적용할 항목을 고르세요") when
   `waiting`; the orb's pulsing class is `running && !waiting`. Move `<PlanGateCard>`
   (`:162-163`) above `<IngestMiniGraph>` (`:160`) and `scrollIntoView({ block: "start" })`
   on mount.
2. `stores/ingestStore.ts:509-513`: gate resolved with `null` → `set({ stage:
   "cancelled" })` instead of idle (the `finally` still drops the listener); update
   the gate cases in `stores/ingestStore.test.ts`. `pages/PageIngest.tsx:777-796`
   cancelled card gains `t.ing_clear` (resets body/title via the existing form state
   setters) beside 다시 실행.
3. `PageIngest.tsx:745-770` success: drop the duplicate hero title once `stage ===
   "done"` (IngestProgress hides its title/ticker at done), list `touched`
   (`ingestStore.ts:234`) as `setRoute(`page:${root}/${t.path}`)` links with "N페이지
   갱신"; 위키 인덱스 열기 → `setRoute("page:<root>/wiki/index.md")`; keep 보고서 열기.
4. `stage === "refused"` branch (none exists in PageIngest): under the textarea show
   `refusal.reason` (`ingestStore.ts:253`) with 지우기 and 내용 더 붙여넣기 (focus the
   textarea); rail steps 3–5 render "—" via `gateState/runState` returning undefined
   for `refused` (`:836-846`).

**Files.** `components/IngestProgress.tsx`, `pages/PageIngest.tsx`,
`stores/ingestStore.ts` (+ `ingestStore.test.ts`), `lib/i18n.ts`
(ing_gate_title, ing_clear, ing_touched_n, ing_refused_more).

**Acceptance.**
- `ingestStore.test.ts`: cancelling at the gate leaves `stage === "cancelled"`.
- `?mock=1` Ingest → paste ≥ 300 chars → 자료 정리하기: at the gate the first card under
  the rail is the checkbox list, the hero title reads 계획 검토 중, no orb animation,
  the cancel button is enabled.
- Cancel at the gate → cancelled card with 다시 실행 / 내용 지우기; 내용 지우기 empties
  the form.
- Let it finish → one success card listing the touched pages as in-app links; clicking
  one opens the reader; no `openExternal` for the index.
- Paste 17 bytes → refused: reason under the textarea, rail steps 3–5 show "—".

---

## Cut from this backlog (with the reason)

- **Unlinked mentions + outgoing links in the rail** (J1 #15) — builds on S11's
  `searchVault` call; second pass once snippets ship.
- **Kbd component / shortcut registry / `?` sheet** (J2 #4, #20) — cosmetic
  unification with a wide blast radius (CommandBar, Button, HelpWidget, App.tsx keys);
  after S2/S4 settle the keys.
- **Switch component for Settings** (J2 #9), **SettingsRow**, **Tasks date/week-start**
  (J2 #17), **reader rail at 1024px** (J2 #18), **outline current section** (J2 #12),
  **page chrome order** (J2 #16) — real, but each is a polish item below the
  daily-loop wins above; queue for hour 7+.
- **raw/ lock in the context menu**, **MCP token mask**, **provider contextPages**
  (J3 #11, #13, #14) — S-sized; the first two fit any spare 20 minutes, the third
  waits for a decision on how provider answers are sourced.
- **Save-failure fourfold banner** (J3 #6) — needs a real EACCES path to verify; not
  reproducible at `?mock=1`.
- Everything the judges marked shipped, L-effort, backend-dependent, or speculative
  (their rejected lists) stays out.
