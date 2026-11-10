# myco UI audit — Ingest · Tasks · Settings · Onboarding · DialogHost · ErrorBoundary

Key: `ingest-tasks-settings` · Tree: `~/prj/karpathy-editor-build` · Mock app on `http://localhost:5475/?mock=1` (Vite, port freed at the end) · Playwright headless Chromium · 1280×900 and 1024×700 · dark + light · UI language ko (en spot-checks).

Shots: `research/shots/ingest-tasks-settings/` (138 files). Raw logs: `its-audit.log.jsonl`, `its-audit-2.log.jsonl`, `its-audit-3.log.jsonl` next to this file. Scripts: `its-audit.mjs`, `its-audit-2.mjs`, `its-audit-3.mjs`.

Scope note: `IngestRecoveryPanel` does not exist in this tree (grep found no file or reference). `SourcesPanel` is the Reader's "Sources & trust" rail, not an Ingest component; it was read but not driven.

Console: no `console.error`, no `pageerror`, no warnings on any page or flow (every `{"page":…,"errors":[]}` row in the logs).

Legend for evidence paths below: `S/…png` = the shots directory above; `file:line` = path under `app/src/`.

---

## 1. Ingest (PageIngest, IngestProgress, IngestMiniGraph, SessionBackfill, ConversationImport, ZoteroImport)

Flows driven in mock: short paste → **drop**, medium paste → **log**, long paste → **harvest → plan gate → apply → done**, second run → **cancel at gate**. Idle in 4 combos, "다른 곳에서 가져오기" and "처리 설정" opened.

| # | Finding | Evidence |
|---|---|---|
| I1 | **Plan gate is below the fold and mislabelled as running.** When the run pauses at the gate, the live panel above it says "LLM 위키 작성 중… / Claude 시작 중…" with a pulsing orb, but nothing is running — the user has to decide. The gate card sits under the results section and the live hero (y≈1000 of a 1432px page at a 900px viewport), while the only above-the-fold hint is the rail step "3 계획 게이트 검토 중". | `S/ingest-flow-gate.png`, `S/ingest-flow-cancel-gate.png`; `components/IngestProgress.tsx:75-79,108-114` (`running` includes `plan-gate`, title = `ing_live_title`), `pages/PageIngest.tsx:825-829` (IngestProgress rendered last) |
| I2 | **Cancelling at the gate is silent.** Stage flips to `idle`: rail disappears, form comes back with the 1,668-char body still in it, no toast, no card. The "가져오기가 취소되었습니다" card only exists for `stage === "cancelled"` (mid-agent cancel). | `S/ingest-flow-cancelled.png`, log `afterCancel:{form:true, body:1668}`; `stores/ingestStore.ts:509-513`, `pages/PageIngest.tsx:777-796` |
| I3 | **Done state says "가져오기 완료" three times and its primary follow-up leaves the app.** Success card + IngestProgress hero ("가져오기 완료 / session started / 0:00") + rail "실행 완료". "위키 인덱스 열기" calls `ipc.openExternal` (OS default app for `wiki/index.md`), and nothing links to the 3 pages the plan said it changed. | `S/ingest-flow-final.png`; `pages/PageIngest.tsx:752-761`, `components/IngestProgress.tsx:108-114` |
| I4 | **Verdict copy leaks engine internals into the ko UI.** Rows read "17 B < 200 B `junk_reason::min_bytes`", "350 B — below the wikify floor `backfill::MIN_BYTES`", "5 wiki page(s) changed `judge::pass`"; decision chips are `ADD / UPDATE / MERGE / NOOP`; the toasts repeat the byte math. (Mock reasons, but the real judge returns the same `{reason, rule}` shape and the UI prints both verbatim.) | `S/ingest-flow-drop.png`, `S/ingest-flow-log-excluded.png`, `S/ingest-flow-gate.png`; `pages/PageIngest.tsx:955-956`, `components/IngestProgress.tsx:181-192`, `stores/ingestStore.ts:396-403` |
| I5 | **A refusal is a dead end.** After drop/log the rejected text and title stay in the form, the rail still shows "3 계획 게이트 대기 중 · 4 실행 유휴" as if waiting, and there is no next step ("add more text", "keep as raw anyway", "clear"). The same refusal is listed twice (verdict row + "이번 세션 1건 자동 제외 — 이유 보기"). | `S/ingest-flow-drop.png` (bodyValue retained), `S/ingest-flow-log-excluded.png`; `pages/PageIngest.tsx:366,589-693,835-849` |
| I6 | **Zotero channel uses a raw native file input** ("Choose File / No file chosen", English, unstyled) beside a sibling card that uses the app's "파일 선택…" button. | `S/ingest-more-open-ko-dark-1280-full.png`; `components/ZoteroImport.tsx:67-69` vs `components/ConversationImport.tsx:67-74` |
| I7 | **Pipeline vocabulary drifts on one screen**: nav "자료 추가", button "자료 정리하기", "가져오기 완료", "인제스트 계획", "ingest 큐", "수확 가치 있음", "위키화됨", "세션 백필", eyebrow "5 · 백필 큐 — 이 화면에서 가장 큰 미개봉 입력", plus "증류" on Settings. Counts in ko strings: 증류 ×92, ingest ×23, 볼트 ×39, vault ×23. | `S/ingest-more-open-ko-dark-1280-full.png`; `lib/intakeCopy.ts`, `lib/i18n.ts` ko block (bf_*, hq_*, sv_*, ing_*) |
| I8 | **Channel rows are bare numbers with no action.** "세션 스윕 4", "웹 클리퍼 2", "MCP 도구 17", "Zotero —": no unit, no "what happens if I click", and rows without children (clipper, MCP) do nothing. | `S/ingest-more-open-ko-dark-1280-full.png`; `pages/PageIngest.tsx:477-488,896-930` |
| I9 | **Cancel button is enabled at the gate** (duplicating the gate's own two choices) and disabled during `writing-raw`/`indexing` with no reason shown. | log `cancelEnabledAtGate:true`; `components/IngestProgress.tsx:149-157` |
| I10 | 1024×700 holds: 2-column channel grid, no horizontal overflow. Light theme is consistent with dark. | `S/ingest-idle-ko-light-1024.png`, `S/ingest-more-open-ko-dark-1024-full.png` |

Unlabeled control: `<input type="file">` (Zotero) has no label (probe `ingest-idle-more-open`).

## 2. Tasks (PageTasks, TaskComposer, TaskDetail, TaskBoard, TaskCalendar, TaskRoadmap, DatePicker)

| # | Finding | Evidence |
|---|---|---|
| T1 | **Tasks is hidden under the collapsed "더 보기" disclosure** (default `toolsOpen:false`), and the breadcrumb on the page shows only "myco" (Ingest shows "myco / 자료 추가"). A Notion/Obsidian user looks for Tasks in the first-level nav. | `S/tasks-list-ko-dark-1280.png` (topbar), `S/errorboundary-graph-ko-dark-1280.png` (expanded list: 그래프/할 일/학습/히스토리/출처); `components/Sidebar.tsx:349-371`, `stores/uiStore.ts` (`toolsOpen: false`) |
| T2 | **The note column is unreadable**: "m…", "t..", "d.", "attenti…". The stem span gets `maxWidth: "40%"` inside an `auto` grid track, so it collapses to two characters. | `S/tasks-list-ko-dark-1280.png`; `pages/PageTasks.tsx:596-604,696-708` |
| T3 | **Board at 1024 hides the "완료" column below the fold.** `auto-fit, minmax(200px,1fr)` gives 3 tracks at 682px; the 4th column wraps under, and the sheet's own comment says scrollbars are hidden app-wide so `overflow-x:auto` is unreachable. At 700px height the Done column is simply not visible. | `S/tasks-board-ko-dark-1024.png`, log `boardMetrics1024:{cs:"219.2px 219.2px 219.2px", cols:4}`; `styles.css:1410-1425` |
| T4 | **Three date formats and two week starts in one flow.** List/board chips print raw ISO `2026-10-05`; the detail DatePicker prints "2026. 10. 5."; the calendar header "2026년 9월". TaskCalendar's grid starts on Monday (`monthGrid(month)` with no `weekStart`), DatePicker's on Sunday (`localeWeekStart("ko")`). | `S/tasks-list-ko-dark-1280.png`, `S/tasks-detail-ko-dark-1280.png`, `S/tasks-calendar-ko-dark-1280.png`, `S/tasks-datepicker-ko-dark-1280.png`; `components/TaskCalendar.tsx:42,132-135`, `components/DatePicker.tsx:149-155`, `pages/PageTasks.tsx:687` |
| T5 | **"보류" for Blocked** (= on hold / deferred, not blocked) and **"할 일" carries four meanings** on one screen: page title, eyebrow, the "To do" column, and the detail panel header. | `S/tasks-board-ko-dark-1280.png`, `S/tasks-detail-ko-dark-1280.png`; `lib/i18n.ts:3950`, `components/TaskBoard.tsx:16-19`, `pages/PageTasks.tsx:342-343`, `components/TaskDetail.tsx:132,142` |
| T6 | **Estimate/repeat parse English only**, with English placeholders ("2d", "every week") in the ko UI; typing "매주" is rejected and the hint lists only English forms. | `S/tasks-composer-full-ko-dark-1280.png`; `components/TaskComposer.tsx:262-295`, `lib/i18n.ts` ko `tasks_detail_estimate_hint`, `tasks_detail_recur_hint` |
| T7 | **Native `window.prompt` for "새 로드맵…"** in two places, while the app ships `DialogHost`/`promptText` for exactly this; `window.alert` ×4 in Providers and `window.confirm` in OverviewBoard. The codebase itself notes native dialogs "block the WebView". (Not verified in Tauri here.) | `components/TaskComposer.tsx:110`, `pages/PageTasks.tsx:445`, `pages/settings/Providers.tsx:61,66,104,132`, `components/OverviewBoard.tsx:416`, `components/OllamaSetup.tsx:399-400` |
| T8 | **Detail panel**: title is read-only (a Notion user expects inline edit), it floats over the still-interactive list with no backdrop, Escape only works while focus is inside. Completing a task collapses it into "완료 (n)" with no undo. | `S/tasks-detail-ko-dark-1280.png`, `S/tasks-after-toggle-ko-dark-1280.png`; `components/TaskDetail.tsx:129-153`, `pages/PageTasks.tsx:524-552` |
| T9 | **No visible focus ring on form controls.** Tab walk: buttons get a 1px ring, but `input.input`, `button.input.dp-trigger`, and every `<select>` report `outline:none` + transparent box-shadow. Segment buttons are 26px tall. | logs `tabwalk tasks-list` rows 3-4, `tabwalk settings-model` rows 8-15; probe `tasks-list.small` |
| T10 | Positives: empty state with hint (`tasks-empty`), stale-scan guard with rescan message, DatePicker keyboard works (Enter/arrows/Enter picked Sep 27), hub-update notice inline, calendar drag with `+N` overflow chip. | log `dpValue:"Sep 27, 2026"`, `hubNotice` |

## 3. Settings (PageSettings, settings/*, SettingsCard, ModelSelect, OllamaSetup)

All 8 tabs in 4 combos, `&ollama=1` and without, search hit/miss, changed-only, save banner, Cmd+F, key-entry flow.

| # | Finding | Evidence |
|---|---|---|
| S1 | **"변경 사항 저장됨" banner is permanent.** It is already on screen when Settings opens (nothing changed), on every tab, and toggling a switch produces no visible difference. `saved` becomes true after the first persisted change (something writes at boot in mock) and nothing ever clears it. | `S/settings-account-ko-dark-1280.png`, `S/settings-saving-ko-dark-1280.png`, log `saveBannerLater:"변경 사항 저장됨"` 3 s later; `stores/settingsStore.ts:79-82` (no reset/timeout) |
| S2 | **Switch placement is inconsistent and the value chip collides.** Long descriptions push the switch under the text at the left ("CLI 세션 자동 수집", "인덱스 자동 최신화") while short ones keep it at the right ("인박스 자동 인게스트"); the absolutely positioned "켜짐/꺼짐" chip sits on top of the switch / the "해제" button. Ten hand-rolled `role="switch"` copies (Model ×5, Distill ×3, Appearance ×2). | `S/settings-model-ko-dark-1280.png`, `S/settings-providers-ko-dark-1280.png`; `pages/settings/Model.tsx:317-367,545-589,654-698`, `components/SettingsCard.tsx:48-53` |
| S3 | **Default model row opens in "직접 입력…" mode** with a free-text `claude-sonnet-4-6` field because the stored id is not in the CLI catalog (`(default) fable opus sonnet haiku claude-opus-4-5`). First impression is an escape hatch. (Observed in mock; verify the real default.) | `S/settings-model-ko-dark-1280.png`; `components/ModelSelect.tsx:91-97,141-151` |
| S4 | **Untranslated strings on the ko Providers tab**: "Save" / "Cancel" on the key form, the keychain notice, `window.alert("CLI not found. Install it first.")`. | `S/settings-providers-keyinput-ko-dark-1280.png`, `S/settings-providers-ko-dark-1280.png`; `pages/settings/Providers.tsx:340,349,403,61` |
| S5 | **"켜짐 ● / ⚠ CLI 설치 안 됨 / 해제"** for Gemini and Codex CLI: an enabled provider that cannot run, whose only action is to disconnect; the purple "changed" dot is unexplained. The Ollama row shows the better pattern (install CTA). | `S/settings-providers-noollama-ko-dark-1280.png`; `pages/settings/Providers.tsx` status rows, `components/OllamaSetup.tsx:169-196` |
| S6 | **MCP bearer token printed in clear text twice** (command + JSON), copy buttons beside. | `S/settings-mcp-ko-dark-1280.png`; `pages/settings/Mcp.tsx:131,143` |
| S7 | **Dead "업데이트 확인" button** next to "업데이트 채널이 설정되지 않았습니다"; crash card shows a raw Rust panic with file path and no link from the ErrorBoundary. | `S/settings-about-ko-dark-1280.png` |
| S8 | **Page chrome repeats itself**: eyebrow "설정" over title "설정", intro note rendered *under* the tab rail (AppPage renders `note` after `bar`), then the banner, then an h2 repeating the tab label. Tasks does the same ("할 일" / "할 일"), Ingest does not ("워크스페이스" / "자료 추가"). | `S/settings-account-ko-dark-1280.png`, `S/tasks-list-ko-dark-1280.png`, `S/ingest-idle-ko-dark-1280.png`; `components/AppPage.tsx:78-90`, `pages/PageSettings.tsx:199-201`, `pages/PageTasks.tsx:342-343`, `pages/PageIngest.tsx:309-310` |
| S9 | **Distill tab**: 7 number inputs + 4 text fields with visual-only labels (no `for`/`aria-label`), 98×26 "이 실행 되돌리기" buttons, jargon ("격리 TTL (일)", "숙성 시간 (시간)", "실행당 LLM 항목 예산 (인제스트 + 지도 초안 합산)"), and a segmented "보수/표준/적극" beside pill switches — two toggle idioms in one card. | `S/settings-distill-ko-dark-1280.png`; probe `settings-distill.unlabeled` (11 controls), `pages/settings/Distill.tsx` |
| S10 | **Status colours are hardcoded** (`#dc2626`/`#16a34a`/`#b45309`/`#22c55e` — 25 hits across scope files) instead of `--danger`/`--ok`, so they ignore the theme. | `pages/PageTasks.tsx:433,684`, `pages/settings/Distill.tsx:553-1316`, `pages/settings/Mcp.tsx:97-148`, `components/OllamaSetup.tsx:469-580`, `components/ConversationImport.tsx:150-158` |
| S11 | **Vault has five names**: 볼트 (×39), vault (×23), 보관함 ("보관함 상태", "myco가 이미 아는 보관함"), "메모 보관 폴더", 프로젝트 (onboarding). | `S/settings-account-ko-dark-1280.png`, `S/onboarding-s0-ko-dark-1280.png`; `lib/i18n.ts:5445`, ko `s_vault_path`, `s_vault_known` |
| S12 | Unnamed/unlabeled controls: Ollama refresh button (icon only, no `aria-label`), provider/model `<select>`s, password key input, read-only vault path input. | probes `settings-providers.unnamed`, `settings-model.unlabeled`; `components/OllamaSetup.tsx:250-252`, `components/ModelSelect.tsx:102-140`, `pages/settings/Providers.tsx:333`, `pages/settings/Account.tsx:66-74` |
| S13 | Positives: search + "변경된 설정만" filter with counts ("설정 41개 중 6개"), empty state with "전체 설정 보기" CTA, Cmd+F focuses search, deep-link tab wins over stale filters, error banner with retry when settings fail to load. | `S/settings-search-miss-ko-dark-1280.png`, `S/settings-changed-only-ko-dark-1280.png`, log `cmdF:"INPUT."`, `pages/PageSettings.tsx:310-332` |

## 4. Onboarding (OnboardingWizard) — first-run experience

Rendered by clearing `myco.onboarded` and stubbing `list_files` → `[]` (ko and en, 1280 and 1024). Walked all 5 steps via "데모 볼트로 시작" → "Claude Code 세션 가져오기" → Next ×3.

| # | Finding | Evidence |
|---|---|---|
| O1 | **No focus management or trap, Escape does nothing.** On open `document.activeElement` is `BODY`; Tab walks the sidebar behind the overlay (brand → ⌘K → 오늘의 노트 → 홈 → …). DialogHost, which the wizard claims to mirror, traps focus and handles Escape. | logs `obFocus0:"BODY"`, `tabwalk onboarding-s0-*`, `escClosesWizard:false`; `components/OnboardingWizard.tsx:161-167` vs `components/DialogHost.tsx:29-51,69-98` |
| O2 | **Step 3 copy contradicts the step.** Title "첫 소스 추가하기 / Add your first source", body "파일을 드롭하거나 URL을 붙여넣거나 메모를 쓰세요…" — but the step only shows an 8% progress bar and "인덱스는 이 기기에서만 만들어집니다"; there is nothing to add. The code's own fallback string is "Reading your notes". | `S/onboarding-s2-ko-dark-1280.png`; `components/OnboardingWizard.tsx:312-324`, `lib/i18n.ts:3554-3555` (en), `5451-5452` (ko) |
| O3 | **Step 1 mixes 프로젝트 / 폴더 / vault / 볼트** and says "방금 만들어진 기본 vault를 그대로 사용하세요" + "연결됨: myco" while also offering "데모 볼트로 시작"; Next is enabled without any choice. | `S/onboarding-s0-ko-dark-1280.png`; `lib/i18n.ts:5445-5447` |
| O4 | **Two primaries per step in dark theme**: `.btn` (bg `--bg` on the dark card → white) and `.btn-primary` (bg `--ink` → white) are indistinguishable, so "폴더 열기…"+"다음" and "물어보기"+"완료" both read as the main action. App-wide. | `S/onboarding-s0-ko-dark-1280.png`, `S/onboarding-s4-ko-dark-1280.png`; `styles.css:1020-1047` |
| O5 | Progress dots are `aria-hidden` with no "2 / 5" text; step 2's import buttons give no busy state on a fast sweep. | `components/OnboardingWizard.tsx:175-179,239-256` |
| O6 | Positives: demo-vault path works end to end, quarantine count is surfaced, first question is prefilled from what was imported, 1024 layout fine. | `S/onboarding-s1-imported-ko-dark-1280.png`, `S/onboarding-s0-ko-dark-1024.png` |

## 5. DialogHost

Triggered from the sidebar context menu: rename (prompt), delete (danger confirm), new folder (prompt), move (pick).

| # | Finding | Evidence |
|---|---|---|
| D1 | **Rename dialog's confirm button says "만들기" (Create)** — `dlg_create` is used for every prompt. | `S/dialog-prompt-ko-dark-1280.png`; `components/DialogHost.tsx:100-105` |
| D2 | **Danger confirm auto-focuses the red "삭제"**, so Enter deletes immediately; convention is to focus Cancel for destructive confirms. | log `confirm.focus:"…btn--danger 삭제"`; `components/DialogHost.tsx:36-46` |
| D3 | **Move picker** lists folders as 9 full-width buttons in a 320px scroll box with no filter, no current-folder marking and no scroll affordance (work/feedback hidden). | `S/dialog-pick-move-ko-dark-1280.png`; `components/DialogHost.tsx:124-126` |
| D4 | Positives: focus trap cycles (취소 → 만들기 → input → 취소), Escape cancels, focus restores, empty submit resolves null, `aria-labelledby` set, light/dark consistent. | logs `tabwalk dialog-prompt-*`, `emptyEnterClosed:true`; `S/dialog-confirm-danger-ko-light-1280.png` |

## 6. ErrorBoundary

WebGL broken after load, then navigated to Graph (ko dark/light 1280, dark 1024).

| # | Finding | Evidence |
|---|---|---|
| E1 | Route-level boundary works: sidebar stays usable, ko copy "그래프에서 문제가 발생했습니다.", mascot still, button auto-focused. **But the only action is "다시 시도", which re-throws in a loop** (still on the error screen after retry) — no "홈으로", no "버그 리포트 복사" link to Settings › 정보 where the crash report UI lives. Raw `error.message` is the body. | `S/errorboundary-graph-ko-dark-1280.png`, `S/errorboundary-retry-ko-dark-1280.png`, log `ebAfterRetry:true`; `components/ErrorBoundary.tsx:80-101`, `pages/settings/About.tsx` crash card |

## 7. Cross-cutting

- **States matrix** (idle / loading / empty / error / success):
  - Ingest: idle ✓, loading ✓ (live panel), empty n/a, error ✓ (`pre` log card), success ✓ but triplicated; **cancel-at-gate ✗**, **refused: no next action**.
  - Tasks: idle ✓, loading ✓ ("노트 스캔 중…"), empty ✓, error ✓ (red card, hardcoded colour), success: hub notice only; **no undo**.
  - Settings: loading ✓ ("Loading…" untranslated in Model.tsx:33), error ✓ with retry, **saved state stuck on**, search empty ✓.
  - Onboarding: import progress ✓, index progress bar with no label, error text ✓.
- **Terminology**: see I7, T5, S11. One glossary (자료/소스, 정리하기/가져오기/인제스트, 볼트/보관함/폴더, 할 일/작업) would remove most of it.
- **Keyboard**: nav/buttons fine; form controls have no visible focus (T9); wizard has no trap (O1); Tasks segment 26px, several 18–26px ghost buttons.
- **Console**: clean everywhere.

## 8. Prioritised proposals (mirrored in the structured output)

1. Onboarding: initial focus + focus trap + Escape = Skip (O1). S.
2. Ingest: at `plan-gate` render the gate card first and retitle the live panel "계획 검토 중 — 적용할 항목을 고르세요"; put the whole decision above the fold (I1). M.
3. Ingest: cancel at gate → keep the rail, show the "취소됨" card with "다시 실행 / 내용 지우기" (I2). S.
4. Ingest: one success card: "N페이지 갱신 · 열기 → 각 페이지" (in-app routes), drop the duplicate hero title (I3). M.
5. Ingest: map `{rule, reason}` to ko sentences ("본문이 너무 짧아요 — 200자 이상이면 정리해요"), move the rule code to a tooltip; localise decision chips (추가/갱신/병합/변경 없음) (I4). M.
6. Ingest: after refusal offer "내용 더 붙여넣기 / 원문만 보관 / 지우기" and collapse the rail (I5). S.
7. Tasks: move Tasks into the primary nav group and add the breadcrumb (T1). S.
8. Tasks: `grid-template-columns: 18px minmax(0,1fr) minmax(8ch, 30%)` for the stem column (T2). S.
9. Tasks board: `grid-auto-flow: column; grid-auto-columns: minmax(200px,1fr); overflow-x: auto` with a visible scrollbar, or 2×2 with explicit "완료" always visible (T3). S.
10. Tasks: one `Intl.DateTimeFormat(lang, {dateStyle:"medium"})` helper for all chips; pass `localeWeekStart(lang)` into `monthGrid` in TaskCalendar (T4). S.
11. Tasks: "보류" → "막힘"; detail header "작업" (T5). S.
12. Tasks: accept "매일/매주/매월/매년", "2주마다", "90분/1.5시간/2일" in `parseRecurrence`/`parseDuration` and localise placeholders (T6). M.
13. Replace `window.prompt/alert/confirm` with `promptText`/`confirmAction`/`notice.warn` (T7). S.
14. Settings: clear `saved` after ~2 s (or on tab change); show "저장됨" only after a change in this session (S1). S.
15. Settings: one `<Switch>` component (label/description/`role=switch`), always right-aligned with `minWidth:0` on the text column; move the value chip into the header row (S2). M.
16. Settings: include the stored id in the model list ("claude-sonnet-4-6 (현재)") so the default install is not "직접 입력…" (S3). S.
17. Settings: translate Save/Cancel/keychain notice; "설치 안 됨" providers show "설치 안내" instead of "해제" and are not marked 켜짐 (S4, S5). S.
18. Settings › MCP: mask the token (`Bearer ••••cdef`) with a reveal toggle; copy still copies the full string (S6). S.
19. AppPage: render `note` above `bar`; stop passing the title as its own eyebrow (S8). S.
20. Distill: `<label htmlFor>` on every field, plain-language labels with the technical name in a tooltip, one toggle idiom (S9). M.
21. Tokens: replace hardcoded status hex with `var(--danger)`/`var(--ok)`/`var(--warn)` (S10). S.
22. DialogHost: `dlg_rename`/`dlg_save` per prompt kind; focus Cancel on danger confirms; folder picker with a filter input and current-folder marking (D1–D3). S/M.
23. ErrorBoundary: add "홈으로" and "버그 리포트 복사" (reuse `formatCrashReport`) beside "다시 시도" (E1). S.
24. Wizard: fix `ob_s2_title/body` in en/ko/ja to the indexing copy; add "n / 5" text (O2, O5). S.
25. Buttons: give `.btn-primary` the accent fill in dark theme (or a distinct `--btn-primary-bg`) so one primary per view is legible (O4). S.
