# myco UI audit — global chrome + Home (key: chrome-home)

Tree audited: `~/prj/karpathy-editor-build` @ `0f8eb86` (the installed build). Read-only.
Dev server: `npx vite --port 5471 --strictPort` from `app/` (killed at the end, port verified free).
Driver: Playwright headless Chromium, `http://localhost:5471/?mock=1`, `localStorage.myco-ui` seeded
with `{lang, theme, toolsOpen:true}`; viewports 1280×900 and 1024×700; light + dark; ko (primary) + en (one pass).
Secondary webviews: `?window=notch&notchMock=1&notchFrame=N` (11 frames), `?window=spotlight&mock=1`.

Scripts: `chrome-home-audit.mjs`, `chrome-home-audit2.mjs`, `chrome-home-split-repro.mjs` (same dir).
Logs: `shots/chrome-home/run.log`, `run2.log`, `chrome-home-run.out`. Screenshots: `shots/chrome-home/*.png` (118 files).

Mock caveats (memory: "?mock=1 is all wiki/"): no real `sessions/`, `create_file` writes nothing (the daily note
reads back as "Sample note."), no git history, no empty-vault flag. Findings that depend on those are marked.

## Console / stability

- **0 console errors, 0 page errors** in all 5 runs (`run.log` `ERRORS(0)` ×5) and in the notch/spotlight windows.
- Only warnings: `GL Driver Message … GPU stall due to ReadPixels` ×2 per run — headless-Chromium WebGL noise from the
  3D graph, not app code.
- One screenshot came back **fully white** (`17-split-ko-light-1280.png`) and `.pane-bar__close` was missing for 30 s.
  Cause verified, not an app bug: `vite-chrome-home.log` `6:31:06 AM [vite] ✨ new dependencies optimized: d3-force-3d …
  reloading` — the dev server's optimizer reloaded the page the first time the lazy graph chunk loaded. Re-run 3× clean
  (`chrome-home-split-repro.mjs`: `events=[]`, split present in every 500 ms sample). Dev-quality fix only:
  add `d3-force-3d` to `optimizeDeps.include`.

## Measured control inventory (run.log METRIC, run2.log PAGE-ALL-BUTTON-HEIGHTS, ko-light-1280)

| control | height | font | family |
|---|---|---|---|
| sidebar `.qbtn` / `.nav-item` / `.nav-leaf` | 32 | 14 | sidebar |
| sidebar `.ngl-add` (새 노트) | 22 | 12.5 | pill |
| sidebar `.auth-filter` | 23 | 11 | pill |
| topbar `.icon-btn` | 28 (25–28 on Home) | 14 | icon |
| topbar `.pill` (search, model, split) | 28 | 12.5 | pill |
| Home hero `.u-btn--primary` | **44** | 14 | u-btn |
| Home `.u-btn` elsewhere | 32 | 12.5 | u-btn |
| Home `.btn-primary` (이력 켜기, 지금 증류) | **38** | 14 | btn |
| Home `.hq-btn.btn-primary` (12개 수확) | 32 | 14 | btn |
| board-head `.btn` | 30 | 12.5 | btn |
| `.ovl-grip` | 28 | 14 | bespoke |
| help FAB | 34 | 17 | bespoke |
| page `h1.u-page__title` ("홈") | 22px/650 | | |
| hero `h2` | **32.8px/700** | | |
| `.section-title` ("최근 메모", "자동 정리") | 22px/600 | | |

Four primary buttons on one Home page: 44 / 38 / 32 / 38 px, three CSS families (`u-btn--primary`, `btn-primary`, `hq-btn`).

## Findings

Severity: H = blocks or misleads a normal task, M = friction on every visit, L = polish.

### Sidebar / SidebarTree / SidebarMenu

1. **[H] The vault tree is squeezed out at 1024×700.** Pinned chrome (brand 44 + quick 70 + 워크스페이스 4 rows +
   더 보기 6 rows + 내 메모 label + 설정 + status 119) leaves the tree **50 px** of viewport; with the status details open
   the tree's top (y=490) is *below* the nav's bottom (y=411) — 0 px visible. `run2.log`
   `SIDEBAR-1024 closed={sideNavH:417,treeTop:490,navBottom:540}`, `statusOpen={navBottom:411}`.
   Shots `05-sidebar-ko-light-1024.png` (one half-cut "최근 수정" row), `09-status-open-ko-light-1024.png`.
   Even at 1280×900 `wiki 55` (the actual wiki) is below the fold (`05-sidebar-ko-light-1280.png`).
   → Make 워크스페이스 collapsible like 더 보기; collapse 더 보기 by default; reduce the status block to one 32 px row
   (dot + "인덱스 4개 뒤처짐 · 재인덱스"); give `.side-nav` `min-height: 40vh`; folders-first sort so `wiki` is near the top.

2. **[H] Graph is hidden under "더 보기".** `Sidebar.tsx:38 TOOL_ROUTES = ["graph","tasks",…]`. For an app whose
   identity is "graph shows the structure of knowledge", the graph is a second-level row behind a disclosure
   (`05-sidebar-ko-light-1280.png`, `08-sidebar-tools-closed-ko-light-1280.png` — collapsed, only a "3" badge remains).
   → Promote 그래프 to the primary group (see / ask / add / graph); keep 히스토리·출처·학습 under 더 보기.

3. **[M] Badges are three different things in three styles with no legend.** 홈 carries "12" (violet outline =
   harvest candidates), 정리 제안 "3" (violet fill = proposals), 학습 "3" (grey = due cards); `Sidebar.tsx:292-321`.
   A Notion/Obsidian user reads a badge on *Home* as unread activity, not "12 sessions to harvest"
   (`01-home-ko-light-1280.png`). → One badge style; move the harvest count to the row that hosts the queue, or replace it
   with the existing "검토할 항목 15개" line on the page; tooltip already exists, so the visual difference buys nothing.

4. **[M] "최근 수정" shows count `0` while collapsed, `5` when open.** mtimes are fetched only while the group is
   open (`Sidebar.tsx:125-137`), the synthetic group is built from `mtimes` (`Sidebar.tsx:168-176`), and
   `DirectoryRow` prints `countFiles` (`SidebarTree.tsx:95`). `05-sidebar-ko-light-1280.png` (0) vs
   `09-status-open-ko-light-1280.png` (5). → Fetch mtimes once per vault (Overview already does) or hide the count on
   synthetic groups until loaded.

5. **[M] No arrow-key navigation in the tree.** Focus on a leaf, ↓ and → do nothing (`run2.log TREE-ARROWS
   before="CLAUDE" afterDown="CLAUDE"`); rows are plain buttons reached by Tab only — 45 Tab presses to cross the
   sidebar (`run.log TABWALK`). Obsidian/Finder/Notion all do ↑↓←→. → `role="tree"` + roving tabindex: ↑↓ move,
   → expand / ← collapse or go to parent, Enter open, Space select (already), Home/End.

6. **[M] The active note is never revealed in the tree.** Opening a note from 최근 메모, ⌘K, or 오늘의 노트 leaves its
   folder collapsed (`19-daily-note-ko-light-1280.png`: `daily` collapsed, no active row anywhere; only the qbtn is
   highlighted). `activePath` only paints an already-visible leaf (`SidebarTree.tsx:40`). → On `page:` route change,
   expand ancestors in `expandedFolders` and `scrollIntoView` the leaf; optional "현재 노트 표시" menu item.

7. **[M] `raw/` looks like any folder and its context menu offers 이름 바꾸기 / 이동… / 삭제.** `06-sidebar-tree-
   ko-light-1280.png` (`raw 1`), `SidebarMenu.tsx:178-198` has no raw guard; the backend knows raw is immutable
   (`src-tauri/src/vault.rs:190,386`). Whether the backend rejects was not verified. → Lock glyph + "읽기 전용" title on
   `raw/`, hide destructive items for paths under it.

8. **[L] "기록상 사람만" pill: cryptic label, no visible effect.** Toggling it changed nothing in the mock (no
   authorship index ⇒ "the filter keeps everything", `Sidebar.tsx:98-101`), `aria-pressed` flips, no count, no title
   (`run2.log HUMANONLY`, `07b-sidebar-humanonly-ko-light-1280.png`). → "사람이 쓴 것만 (n/64)"; disable with a tooltip
   pointing at 이력 켜기 when no history exists.

9. **[L] Tree polish.** Empty folders print `0` (`audio 0`, `daily 0`); root files (`CLAUDE`, `welcome`) sort above
   folders; the pinned 설정 row has no fade/shadow so a half-cut row (`daily`) reads as a rendering glitch
   (`07-sidebar-menu-ko-light-1280.png` bottom). → Hide zero counts, folders first, top/bottom scroll shadows.

10. **[L] New-note dialog mixes 노트/메모.** Title "새 노트", body "메모의 제목을 정해 주세요." (`i18n.ts:5230,5234`;
    `22-new-note-dialog-ko-light-1280.png`). See finding 22.

### StatusStrip

11. **[L] Two headers, odd disclosure glyph, unreadable model tile, English split row.** Summary "보관함 상태 · 메모 64개
    +" then an inner "상태" header (`StatusStrip.tsx:135-140`); the `+`/`−` marker (`everyday.css:214`) is the only
    disclosure in the app that is not a chevron; the model tile ellipsizes "Claude Code (CLI) · claude-sonnet-4-6" to
    "Claude…" (278 px in 56 px, `run.log SIDEBAR-ELLIPSIZED`); the split row says `sessions 0 · wiki 55` in ko
    (`StatusStrip.tsx:199`). `09-status-open-ko-light-1280.png`, `10-status-broken-ko-light-1280.png`.
    → Drop the inner header, chevron marker, two-line model tile (provider / model), "세션 · 위키".
    The amber warning row + recovery link works well (keep).

### Topbar

12. **[L] Two identical search entry points + duplicated page title.** Sidebar qbtn and topbar pill both read
    "검색하거나 이동… ⌘K" (`Sidebar.tsx:275-281`, `Topbar.tsx:100-106`); the breadcrumb ends in "홈" and the page h1 is
    "홈" 60 px below it (`01-home-ko-light-1280.png`). → One search affordance; turn the sidebar row into "새 노트 ⌘N";
    hide the h1 when it equals the last crumb.

13. **[L] Breadcrumb shows `2026-09-26.md`; every other surface strips `.md` and shows no folder.**
    `Topbar.tsx:527-531`; `19-daily-note-ko-light-1280.png` (crumb `.md`, title without). → `stripExt`, show
    `daily / 2026-09-26` (folder segments clickable).

14. **[M] Split view defaults to Graph and remounts the primary pane.** At a 520 px pane the 3D stage is a ~30 px
    strip with the loading tip rendered vertically (`17-split-ko-dark-1280.png`); at 391 px the canvas is 46 px tall
    with overlapping text (`17-split-ko-light-1024.png`). Opening split also resets Home's disclosure (관리 도구 closed,
    arrange off) because `primaryContent` moves into a new parent (`App.tsx:575-621`; `17r-split-run2-8s.png`).
    `Topbar.tsx:87-97` picks Graph. → Default the second pane to 질문 (the LLM-wiki pairing that fits half width); render
    the split wrapper always and toggle a class so the primary pane keeps its tree position; graph in a narrow pane
    hides its rails.

### CommandBar (⌘K)

15. **[M] Lenses are unreachable from the default list; no recent notes; tags inverted.** With an empty query the list
    is `base.slice(0, 12)` = 2 actions + 10 routes (`CommandBar.tsx:194,231`; `run2.log CMD-DEFAULT-ROWS n=12
    tags=["동작","페이지"]`), so 고립/출처 없음/분쟁/최근 lenses only appear if you already know their names. Routes are
    tagged "페이지" and wiki notes "파일" (`CommandBar.tsx:386-391`) — in a wiki the *note* is the page.
    `12-cmd-empty-ko-light-1280.png`. → Default list = 5 recent notes + actions + lenses (+ routes last); tags
    "이동" / "노트"; cap per group.

16. **[M] No-result dead end and dev jargon in the footer.** "결과 없음" with no escape (`CommandBar.tsx:366-371`,
    `13b-cmd-nohit-ko-light-1280.png`); footer always shows "따옴표는 정확 일치 · path: · tag: … · 기대한 문서가 없나요? ⌥⏎ 로
    이 검색을 평가 세트에 기록합니다" — "평가 세트" is an internal eval concept (`CommandBar.tsx:466-473`, `i18n.ts:5263`),
    and it stays under a lens where it is irrelevant. → On zero hits offer "'{q}' 새 노트 만들기 (⇧⏎)" and
    "'{q}' 질문하기"; move the ⌥⏎ hint to Help; reword "놓친 검색으로 기록".

### Home (Overview)

17. **[H] Opening "검토하고 정리하기" moves 최근 메모 ~1,500 px down and grows the page to 4,100–5,000 px.**
    `PageOverview.tsx:185` renders `recentContent` inline only while management is closed; open, it becomes a block after
    the 12-row harvest queue (`01-home-ko-light-1280.png` vs `02-home-manage-ko-light-1280.png` 1280×4140,
    `02-home-manage-ko-light-1024.png` 1024×5004). The thing the user was looking at leaves the screen. → Keep 최근 메모
    anchored; render the tools as tabs (수확 / 제안·모순 / 보드 / 자동 정리) rather than one stacked column; cap the queue
    at 5 rows + "더 보기".

18. **[M] Heading scale is inverted and section titles compete with the page title.** Hero `h2` 32.8 px > page `h1` 22
    px; "최근 메모" `.section-title` 22 px = h1 (`run.log METRIC`; `01-home-ko-light-1280.png`). Same 22 px title is used
    for "자동 정리" which then repeats as the card's own title (`02-home-manage-…`, `PageOverview.tsx:228,577`).
    → One scale: page 22 > hero 26 > section 17; drop the duplicate 자동 정리 heading.

19. **[M] Four primary buttons, three families.** 자료 추가하기 (`u-btn` 44), 이력 켜기 (`btn-primary` 38), 12개 수확
    (`hq-btn` 32), 지금 증류 (`btn-primary` 38) — `run2.log PAGE-PRIMARY-BUTTONS`; plus `.btn` 30/32/38, `.icon-btn`
    25–28 on the same page. `VaultHistoryBanner.tsx:61-83` and `PageOverview.tsx:601-612` still use `.btn`. → Use
    `Button` (u-btn) for all of them; one primary per viewport (the hero's).

20. **[L] Arrange mode drags across a 4,600 px page.** Nine `⠿ … 1/3 1/2 전체` bars, two "여기에 놓기" zones
    (`03-home-arrange-ko-light-1280.png`). The keyboard path works (`ARRANGE-ANNOUNCE "볼트 맥박: 본문 2/5"`). → Arrange in a
    compact outline (block names with ↑↓ + width) in a side sheet; keep pointer drag for the board only.

21. **[L] Two "recent" lists, two names, two counts, no "more".** Home 최근 메모 (4, `PageOverview.tsx:140`,
    `RecentNotes.tsx:28-31` has no footer) vs sidebar 최근 수정 (5). → Same name, same source, "모두 보기 →" opening the
    palette's 최근 lens.

22. **[H] Terminology drifts across the chrome (ko).** Visible on one Home page: 볼트 ×1, 보관함 ×2, vault ×3
    (`run2.log TERMS`). Pairs: vault = 볼트 (`i18n.ts:5467`) / 보관함 (`everydayCopy.ts:31`) / "vault" (`i18n.ts:5372`);
    note = 노트 (`5230`) / 메모 (`everydayCopy.ts:39`, `5234`); ingest = 자료 추가 (nav) / 가져오기용 모델 (topbar) /
    인제스트 중 (notch, `5548`); distill = 자동 정리 (`4846`) / 지금 증류 (`4878`) in the *same card*; proposals = 정리 제안
    (`4933`) / 승격 제안 (`5267`); daily = 오늘의 노트 (`5233`) / ⏎ 데일리 노트 (`5555`); "런 보기" (`5491`), "Reflect 제안",
    "해소: active" / "superseded로" (`5511-5512`, right rail in `07-sidebar-menu-ko-light-1280.png`).
    → One glossary sweep: 보관함, 노트, 자료 추가/가져오기, 정리, 제안, 오늘의 노트; "런 보기"→"실행 기록", "Reflect"→"점검",
    "해소: 유효 / 대체됨으로 표시".

23. **[M] Board: modal ignores Esc, chart renders empty, editor clipped, remove labelled 닫기, native prompt/confirm.**
    Detail modal's `onKeyDown` sits on the backdrop that never has focus (`OverviewBoard.tsx:564-573`;
    `run2.log BOARD-DETAIL focus:"BODY"`, `after-esc open=1`) — only clicking closes it; its chart area shows axis labels
    and no bars (`04c-board-detail-ko-light-1280.png`); the in-cell widget editor is cut off after 보기 — 기간/색/0이면 숨김
    need a manual resize (`04b-board-widget-editor-ko-light-1280.png`); the ✕ that deletes a widget has
    `aria-label={t.ui_close}` = "닫기" and no undo (`OverviewBoard.tsx:518`); board name shows the raw file name
    `overview` (`:339-343`) and filter fields are English `type/confidence/status/tag/sourceCount`
    (`run2.log WIDGET-EDITOR`); 새 보드/보드 삭제 use `window.prompt`/`window.confirm` (`:393-395,416`) while the rest of the
    app uses `promptText`/`confirmAction` (`SidebarMenu.tsx:80,124`). The range segment renders for an empty board
    (`04-board-edit-ko-light-1280.png`). → Focus the dialog on open + window-level Esc; fixed-height chart box; grow the
    cell while editing or edit in a side sheet; "위젯 제거" + undo toast; localise field names; use DialogHost.

24. **[L] Empty/disabled states on Home are text-only.** No vault: sidebar prints "선택된 볼트가 없습니다" with no button
    (`Sidebar.tsx:430-436`); the two everyday cards go 50 % opacity with no hint (`EverydayHome.tsx:51,66`). Not
    screenshot-able in the mock (always has a vault) — code-only. → "폴더 선택" button under the message; disabled cards
    carry "먼저 보관함을 선택하세요".

### NoticeStack / HelpWidget

25. **[L] Toasts cannot be dismissed except by waiting or by their action.** No ✕; the only focusable thing is the action
    button (`NoticeStack.tsx:131-144`); the third toast is scaled to 0.94 at 60 % opacity over page content
    (`styles.css:6898-6905`; `18-notices-ko-light-1280.png`). → Add an icon ✕ to every toast; stack without opacity fade.

26. **[L] Help tips cover 4 routes; the rest get the ⌘K line.** `HelpWidget.tsx:36-42`; ⌥Space / ⌥M are listed even in a
    plain window where they cannot work (`15-help-ko-light-1280.png`). → One tip per route incl. reader/tasks/settings;
    mark shell-only keys.

### NotchPanel / Spotlight (secondary webviews)

27. **[L] Rejected state truncates the one fact that matters.** "이 형식은 아직 읽지 못합니다 (..." — the extension is
    ellipsized in the 188 px panel (`20-notch-f11.png`, `NotchPanel.tsx:836-858`); lip copy uses the mono face so
    "떨구거나,  클릭해서  메모" gets wide gaps (`20-notch-f1.png`); "인제스트 중" (`20-notch-f4.png`) and "⏎ 데일리 노트"
    (`20-notch-f6.png`) contradict the main window's words; the saving frame prints "받아쓰는 중…" three times
    (`20-notch-f9.png`). → Extension first ("(.epub)은 아직 읽지 못해요"), allow a 2-line wrap in rejected, "가져오는 중",
    "⏎ 오늘의 노트", one stage label.
    Spotlight (`21-spotlight-empty.png`, `21b-spotlight-answer.png`) is clean: extractive label, verbatim quotes, %.

### Things that are fine (checked, no finding)

Dark theme parity on every chrome surface (`*-ko-dark-*.png`); Esc closes palette / help / menu / model popover;
palette has a proper combobox/listbox with `aria-activedescendant`; Tab is trapped inside the palette
(`CMD-TAB focus=INPUT`); toast life pauses on hover; the 1024 topbar collapses the search label to the icon; no
horizontal scroll at either width (`scrollW == clientW`); the arrange keyboard path announces moves.

## Not verified

- Backend refusal of rename/delete under `raw/` (UI-only observation).
- Real-vault sizes (1,121 files) — the sidebar squeeze is worse there, not better.
- Native `window.prompt` behaviour inside the Tauri webview (flagged as an inconsistency regardless).
