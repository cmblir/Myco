# myco UX 백로그 2차: S13–S55 (2026-10-01)

2026-10-01 라운드 보고서 7개를 합친 작업 단위입니다. 기준 트리는 `~/prj/karpathy-editor-build/app`(branch `feat/permit-editor-ux`, HEAD `d3f82ce`)입니다. 이미 출시한 S1–S12와 블록 에디터 0–6단계, 진행 중인 두 스펙(`docs/specs/2026-10-01-notion-blocks-one-editor.md`, `docs/specs/2026-10-01-graph-woven-and-visual-rules.md`)은 다시 넣지 않았습니다. 진행 중 스펙과 맞닿는 항목은 의존 칸에 적었습니다.

## 읽는 법

- 코드 경로는 `app/` 기준 `파일:줄`입니다. 스크린샷과 로그 경로는 `ux-2026-10/` 기준입니다. 근거 보고서는 다음 이름으로 줄여 씁니다: 데스크톱 감사(`audit-desktop.md`), 폰 감사(`audit-mobile.md`), 타당성(`mobile-feasibility.md`), ON(`mobbin-obsidian-notion.md`), WC(`mobbin-writing-capture.md`), PA(`mobbin-pkm-ai.md`), AM(`mobbin-ai-mobile.md`).
- 다른 앱에 대한 주장은 모두 이번 라운드 보고서가 실제로 받아 본 Mobbin 화면이나 플로우 URL입니다. myco 내부 결함만 다루는 슬라이스에는 Mobbin 근거를 달지 않았습니다.
- 보고서에 없고 제가 판단한 부분은 (추론)으로 표시했습니다.
- 크기는 S(하루 안), M(며칠), L(한 주 이상)입니다. 우선순위는 묶음 안에서 사용자 영향 순서이고, 1이 가장 먼저입니다.
- `divergent: 예`는 `PageGraph.tsx`, `NotchPanel.tsx`, 그래프 룩, `Sidebar.tsx`(와 `SidebarTree.tsx`)를 고치는 슬라이스입니다. 2026-09-26 기준으로 소유자가 다른 worktree에서 이 파일을 고치고 있었으므로, 이 슬라이스는 diff를 작게 유지하고 서식을 바꾸지 마십시오. 지금도 그런지는 확인하지 않았습니다.
- 슬라이스마다 게이트는 `cd app && npm run lint && npx tsc -b && npx vitest run`이고, Rust를 고치면 `cd app/src-tauri && cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo test`도 돌리십시오. 화면 확인은 `http://localhost:5173/?mock=1`에서 하고, 터치 확인은 Playwright `isMobile/hasTouch` 375·390·820·1180 폭에서 하십시오(측정 스크립트는 `audit-mobile/sweep.mjs`, `audit-mobile/interact*.mjs`). 새 문자열은 `lib/i18n.ts`의 en/ko/ja에 모두 넣어야 parity 테스트가 통과합니다.

## 소유자에게 먼저 올리는 블로커

### B1 자동 정리(distill)가 `raw/` 파일을 옮기고, 끝내 지울 수 있습니다

저장소 규칙은 "A user vault's `raw/` is **immutable** — never modify or delete through any path (app, MCP, agents)"입니다(`../CLAUDE.md:20`). 그런데 지금 코드의 distill에는 `raw/` 파일을 옮기는 길이 세 개 있습니다.

- **격리:** `scan`이 `_inbox/`, `raw/`, `sessions/`를 훑고(`src-tauri/src/distill.rs:474-490` `collect_candidates`), 격리 판정이 나면 그 파일을 `std::fs::rename`으로 `_inbox/quarantine/`에 옮깁니다(`src-tauri/src/distill.rs:682-694`). `raw/`에서 온 파일도 똑같이 옮겨집니다.
- **기한 만료와 영구 삭제:** 격리 기한은 30일입니다(`src-tauri/src/distill.rs:39-41`, `:664`). 기한이 지나면 Standard 강도에서는 파일을 `.myco/trash/<run-id>/`로 옮기고(`src-tauri/src/distill.rs:2741-2803`), 휴지통 폴더가 30일을 넘기면 `remove_dir_all`로 지웁니다(`src-tauri/src/distill.rs:767`, `:2808-2819`). 그래서 `raw/` 원문이 격리된 뒤 약 60일이면 디스크에서 사라질 수 있습니다. 그 전까지는 실행별 undo 기록이 있습니다(`src-tauri/src/distill.rs:2447-2455`).
- **보관 이동:** 이미 `wiki/source-<stem>.md`가 있는 `raw/<stem>.md`와 summary 등급 항목을 `raw/archive/YYYY-MM/`으로 옮깁니다(`src-tauri/src/distill.rs:2590-2678`, `:2680-2735`). distill 설계 스펙은 이것을 "retired sources (moved, never edited)"로 정해 두었습니다(`docs/specs/2026-08-13-ontology-distill-design.md:44`). 즉 스펙과 저장소 규칙이 서로 다릅니다.

기본값은 코드로 확인했습니다. `enabled`는 `d_true()`이고(`src-tauri/src/distill.rs:73`, `:108`), 강도 기본값은 `Intensity::Standard`라서(`src-tauri/src/distill.rs:31-33`) 실행하면 제안이 아니라 실제로 옮깁니다. 위키 페이지가 50쪽 미만이면 게이트가 꺼져 아무것도 판정하지 않습니다(`GATE_MIN_WIKI_PAGES`, `src-tauri/src/distill.rs:550`, `:584-592`). 실행은 홈 카드의 "지금 증류"(`src/pages/PageOverview.tsx:689`), 설정(`src/pages/settings/Distill.tsx:145`), 트레이(`src/lib/trayStatus.ts:575`)에서 시작됩니다. `distill_run` 명령은 `enabled`를 확인하지 않습니다(`src-tauri/src/commands.rs:2622-2652`). App에 자동 distill 스케줄러는 붙어 있지 않았습니다(`src/App.tsx:290-311`에는 import, ingest, reflect, reindex만 있습니다). 다만 주석은 schedule-due와 count-trigger 호출자를 말하고 있어서(`src/lib/distill.ts:457-460`), 백그라운드 스케줄(`src-tauri/src/schedules.rs:293` `install_background`) 경로는 이번에 끝까지 추적하지 못했습니다.

**결정할 것:** (1) `raw/`를 distill 후보에서 아예 빼서 저장소 규칙을 지킬지, (2) 스펙대로 `raw/archive/` 보관 이동만 허용하고 격리·휴지통은 금지할지, (3) 지금대로 둘지입니다. 권장은 (2)입니다. 격리와 휴지통은 되돌릴 수 없는 삭제로 이어지는데, 보관 이동은 내용을 바꾸지 않고 undo할 수 있습니다(추론). 이 결정 전에는 S25와 모바일 볼트 공유(`mobile-strategy.md`)를 확정할 수 없습니다. 모바일에서는 이 이동이 iCloud로 퍼져 폰 인덱스와 `[^src-*]` 인용 경로를 바꾸기 때문입니다.

## 권장 착수 순서

데스크톱 사용자에게 영향이 큰 순서입니다. 지금 데스크톱 창은 `minWidth: 800`이라서(`src-tauri/tauri.conf.json:20`) 모바일 준비 묶음(S46–S54)의 ≤768px 규칙은 출시 앱에서 쓰이지 않습니다. coarse 포인터 규칙도 터치 노트북에서만 효과가 있는데, 그 사용자 비율을 보여 주는 데이터는 없습니다. 그래서 모바일 준비 묶음은 폰 앱을 만들기로 결정하고 `mobile-strategy.md`의 SP-1~SP-3을 통과한 뒤로 미룹니다.

| 순서 | 슬라이스 | 크기 | 이유 |
|---|---|---|---|
| 0 | B1 `raw/` 이동 결정 | 결정 | 데이터 손실과 저장소 규칙 위반입니다. S25가 이 결정에 달려 있습니다 |
| 1 | S25 inflow 격리 전에 묻기 | M | 데이터 손실 등급입니다. 사용자가 넣은 음성 메모, 클립, 원문이 묻지 않고 격리되고 끝내 지워질 수 있습니다. 결정이 오기 전에는 2–4번을 먼저 진행하십시오 |
| 2 | S13 홈 적기 버튼 | S | 보고서 5개가 같은 결함을 찾았습니다 |
| 3 | S55 데스크톱에서 링크를 그냥 클릭해 열기 | S | 읽기 보기가 사라진 뒤 마우스 사용자가 링크를 따라가는 길이 ⌘클릭 하나뿐입니다. 소유자 결정이 필요합니다 |
| 4 | S26 비활성 버튼 | S | CSS 한 규칙으로 "고장 났다"는 인상을 없앱니다 |
| 5 | S30 기권 카드 | S | 제품의 신뢰 장치가 지금은 오류처럼 읽힙니다. Spotlight 기권도 같은 문구를 씁니다 |
| 6 | S18 첫 실행 마법사 | M | 처음 쓰는 사람의 길이 비어 있습니다 |
| 7 | S14 내부 용어 걷어내기 | M | 모든 화면의 첫인상입니다 |
| 8 | S36 질문 기록 | M | 앱을 다시 켜면 물어본 것이 모두 사라집니다 |
| 9 | S34 복습 큐 | M | 홈 숫자와 실제 복습량이 다릅니다 |
| 10 | S15 내 노트 분리 | M | 검색과 트리의 잡음이 줄어듭니다 |
| 11 | S31, S32 각주 번호와 짧은 답 | M | LLM 위키의 고유한 화면을 읽을 수 있게 만듭니다. S31은 소유자 결정이 필요합니다 |
| 보류 | S46–S54 모바일 준비 | S–L | 폰 앱 결정과 SP-1~SP-3 통과 뒤 `mobile-strategy.md` 2단계 첫 묶음으로 합니다 |

---

# 일반 사용자 사용성

## S13 홈 적기 버튼과 영수증
**묶음:** 일반 사용자 사용성 · **우선순위:** 1 · **크기:** S · **의존:** 없음(S26과 같이하면 비활성 표시도 맞습니다) · **divergent:** 아니오

**목표.** 단축키를 몰라도, 폰 키보드로도 "오늘의 노트에 적기"를 할 수 있고, 적은 뒤 그 줄로 바로 갈 수 있게 합니다.

**문제와 근거.**
- 홈 입력창은 Enter로 질문하고 ⌘/Ctrl+Enter로만 적습니다(`src/pages/PageOverview.tsx:362-366`). 화면에는 "Enter 질문하기 · ⌘Enter 오늘의 노트에 적기" 안내뿐이고 버튼이 없습니다(`src/lib/i18n.ts:6218`, `shots/oxn/02-home.png`). 폰 감사 M-04, ON A1, WC W1, PA B 갭 1, AM C2가 각각 찾았습니다.
- 성공하면 `notice.ok(t.home_captured)` "오늘의 노트에 적었어요"만 뜨고 열기 동작이 없습니다(`src/pages/PageOverview.tsx:334`). `notice`는 이미 `action`을 지원합니다(`src/lib/notice.ts:1`, `src/components/NoticeStack.tsx:190-199`).
- `rows={1}`이라서 375px에서 placeholder 둘째 줄이 잘립니다(`src/pages/PageOverview.tsx:354`, `shots/m375-home.png`).
- 다른 앱: Notion iOS는 바닥에 "Ask AI" 필과 작성 버튼을 나란히 둡니다([e7689c02](https://mobbin.com/screens/e7689c02-0bc0-49f7-bc5c-71f516844d33)). Craft는 적은 뒤 "Added to Today, Tap to open" 토스트를 띄웁니다([2a6e4efc](https://mobbin.com/screens/2a6e4efc-8dde-4efa-ba2c-eb27267ee582), [quick note flow](https://mobbin.com/flows/1d332ade-dd11-4571-9300-00d060523a5f)).

**제안.**
1. 입력창 아래에 [질문하기](기본 버튼)와 [오늘의 노트에 적기] 버튼 두 개를 두십시오. 각각 지금의 `ask(text)`와 `capture()`를 그대로 부르고, 입력이 비면 둘 다 비활성으로 두십시오. Enter와 ⌘Enter는 그대로 유지하십시오.
2. 성공 토스트에 `action: { label: t.home_open_daily, run: () => openDailyNote(vault, today) }`를 다십시오(`src/lib/dailyNote.ts:69`, S7에서 만든 함수).
3. `.home-ask__keys` 안내는 `@media (hover: hover)`에서만 보이게 하십시오.
4. textarea는 내용에 맞춰 최대 4줄까지 늘어나게 하십시오.
5. 버튼은 textarea의 현재 DOM 값(`ref.current.value`)을 읽어 보내고, 한국어 조합이 진행 중이면(`compositionstart`~`compositionend` 사이) `compositionend`를 기다린 뒤 실행하십시오. Enter 경로는 지금의 `isComposingKey` 가드(`src/pages/PageOverview.tsx:363`, `src/lib/ime.ts:42-48`)를 그대로 둡니다. 조합 중에 버튼을 누르면 마지막 음절이 React 상태에 아직 없을 수 있습니다(추론, WKWebView 실기기 미확인).

**파일.** `src/pages/PageOverview.tsx`, `src/lib/i18n.ts`(버튼 라벨, 열기), `src/styles.css` 또는 `src/styles/everyday.css`.

**수용 기준.**
- `?mock=1` 홈에서 글을 쓰고 [오늘의 노트에 적기]를 누르면 토스트에 "열기"가 있고, 열기를 누르면 오늘의 노트에 `- HH:MM …` 줄이 보입니다.
- Enter는 여전히 질문하고 ⌘Enter는 여전히 적습니다.
- 조합 중 Enter나 버튼 탭이 미완성 음절을 잃지 않습니다. "회의 메모"를 두벌식으로 치고 마지막 "모"가 조합 중일 때 버튼을 누르면 "회의 메모" 전체가 적힙니다(데스크톱 WKWebView는 소유자가 설치 앱에서, iOS 소프트 키보드는 `mobile-strategy.md` SP-5에서 확인).
- 375px 터치 에뮬레이션에서 키 안내 줄이 보이지 않고, 두 버튼이 44px 이상입니다.
- i18n parity 테스트가 통과합니다.

## S55 데스크톱에서 렌더된 링크를 그냥 클릭해 열기
**묶음:** 일반 사용자 사용성 · **우선순위:** 2 · **크기:** S · **의존:** 소유자 결정(Live 렌더 규칙에 닿습니다). 터치 판별은 S46과 같은 diff가 편합니다 · **divergent:** 아니오

**목표.** 단축키를 모르는 데스크톱 마우스 사용자도 노트 안 위키링크, 웹 링크, 각주를 눌러 따라갑니다.

**문제와 근거.**
- one-editor 병합으로 읽기 보기가 없어졌습니다. 이제 `raw/` 파일이 아니면 모든 노트가 Live로 열리고(`src/pages/PageReader.tsx:271-276`, "preview is the read-only Viewer, which only a raw/ file opens in now"), 예전에 Read를 고른 기기도 Live로 바뀝니다(`src/stores/uiStore.test.ts:176-182`).
- Live의 링크 열기는 `mousedown` 핸들러 안에서 `if (!(e.metaKey || e.ctrlKey)) return false;`로 수정키를 요구합니다(`src/lib/editorLive.ts:748`, `:753`). 위키링크, 웹 링크, 각주 정의로 가는 길이 모두 여기에 묶여 있습니다(`src/lib/editorLive.ts:756-777`). 그래서 마우스 사용자가 링크를 따라가는 길은 ⌘클릭 하나뿐입니다. 읽기 보기가 있을 때는 Viewer의 클릭이 이 길이었습니다(블록 에디터 로드맵 0단계, `docs/specs/2026-09-25-block-editor-roadmap.md:55-62`).
- 링크 모양은 그대로 보입니다. 캐럿이 링크 밖에 있으면 `[[`가 숨고 링크만 보입니다. 이것은 2026-09-25 소유자 결정입니다(one-editor 스펙 Out of scope, `docs/specs/2026-10-01-notion-blocks-one-editor.md:146-147`). 그런데 눌러도 캐럿만 놓이니, 링크처럼 보이지만 링크처럼 동작하지 않습니다(`audit-desktop/shots/flow/51-reader-info-ko-dark-1280.png`의 밑줄 링크 "Transformer", "self-attention").
- 다른 앱 근거는 이번에 받아 보지 않았습니다. 이 슬라이스의 근거는 코드와 one-editor 병합으로 생긴 회귀입니다.

**제안.**
1. 캐럿이 그 링크 범위 안에 없을 때는, 렌더된 링크를 수정키 없이 클릭하면 이동하게 하십시오. 캐럿이 이미 링크 안에 있으면(원문이 드러난 상태) 지금처럼 캐럿만 옮깁니다.
2. 링크를 고치는 방법은 셋으로 둡니다. 방향키로 캐럿을 링크 안에 넣기, 링크 바로 옆을 클릭한 뒤 방향키로 들어가기, ⌘클릭 없이 링크 위에서 끌어 선택하기(끌기는 이동하지 않습니다). 이 동작은 도움말과 `/` 메뉴 설명에 한 줄로 적으십시오.
3. 클릭 판정은 `mousedown`이 아니라 `click`(같은 자리에서 누르고 뗀 경우)에서 하십시오. 그래야 끌어 선택하기와 구분됩니다.

**파일.** `src/lib/editorLive.ts`(링크 클릭 처리), `src/lib/i18n.ts`(도움말 한 줄), 도움말 위치.

**수용 기준.**
- vitest(jsdom 또는 순수 함수): 캐럿 밖 링크 클릭은 `onLinkClick`을 부르고, 캐럿 안 링크 클릭과 끌어 선택은 부르지 않습니다.
- `?mock=1` 1280에서 `attention-mechanism`의 "Transformer" 링크를 수정키 없이 누르면 그 노트로 갑니다. 방향키로 링크 안에 들어가면 `[[…]]` 원문이 보이고 고칠 수 있습니다.
- 기존 에디터 스위트(`editor-audit/10-verify-blocks.mjs`)가 통과합니다.

## S14 일상 화면의 내부 용어와 진단 숫자
**묶음:** 일반 사용자 사용성 · **우선순위:** 4 · **크기:** M · **의존:** 기권 카드는 S30, ⌘K 연산자는 S23이 맡습니다 · **divergent:** 아니오

**목표.** 모든 화면의 기본 문구가 "무슨 일이 있었고 다음에 무엇을 하면 되는지"를 말하고, 수치와 내부 이름은 펼침 영역이나 개발 모드로 갑니다. S10은 같은 개념의 이름을 하나로 맞췄고, 이 슬라이스는 그 개념을 사용자에게 보여 줄지를 다룹니다.

**문제와 근거.** (데스크톱 감사 순위 1)
- 그래프 상단 칩 "씬 재빌드 3회 · 242.2 ms"가 늘 보이고, 1024 다크에서는 "8732.9 ms"까지 찍힙니다(`src/components/GraphQuestions.tsx:146-149`, `src/lib/i18n.ts:4614`, `audit-desktop/shots/sweep/graph-ko-dark-1024.png`). 폰에서는 "2652.8 ms"입니다(`audit-mobile/shots/375-ko-light-graph.png`). 같은 화면의 통계 문단과 "갭", "밝기 = 홉 거리"도 설명이 필요한 말입니다(`src/lib/i18n.ts:4616`, `:4867`, `:4632`).
- 자료 추가 단계 표시가 "유입 · 판정 버림 0 · 기록 0 · 수확 0 · 계획 게이트 · 실행 유휴 · 백필 큐 2건 대기"이고, 계획 카드가 UPDATE/ADD/MERGE/NOOP 작업 코드를 씁니다(`audit-desktop/shots/flow/91-ingest-run-0-ko-dark-1280.png`, `src/lib/i18n.ts:4564-4567`, `:5728`).
- 사이드바 하단 경고 "위키 6개가 인덱스 밖에 있습니다 — 질문에서 검색되지 않습니다. 지금 재인덱스"가 모든 화면에 있습니다(`src/lib/i18n.ts:5963`).
- 노트 머리에 "사람 62% · 에이전트 38% · 마지막 사람 손길 그저께"가 붙습니다(`src/pages/PageReader.tsx:954`, `src/lib/i18n.ts:6239`).
- 정리 제안 설명문이 "자동 정리가 새 페이지를 위키의 온톨로지에 접어넣으며 작성한 제안입니다"입니다(`src/lib/i18n.ts:5606`). Ask 입력창 예시는 "BPE는 무엇인가요? 미드트레이닝은…"입니다(`src/lib/i18n.ts:4584`).
- Spotlight 창(`?window=spotlight`)의 답은 노트 이름 옆에 "· 71%", "· 58%"를 붙이고, 영어 머리는 "FROM YOUR NOTES (TOP MATCHES, VERBATIM)"입니다(`audit-desktop/shots/aux/spotlight-asked-en-dark.png`). 이 백분율은 Ask와 같은 `formatExtractiveAnswer`가 만들고, 주석에 "Relevance is shown because it is now a REAL number"라고 적힌 의도된 결정입니다(`src/lib/extractive.ts:268-273`). 이번 라운드에 세 보조 창을 처음 찍었습니다(`aux-windows.mjs`, `audit-desktop/shots/aux/`).
- 다른 앱: Obsidian iOS 그래프 패널에는 사용자가 다루는 컨트롤(Filters/Groups/Display/Forces)만 있습니다([750d7b56](https://mobbin.com/screens/750d7b56-5e9f-45d3-a43e-9160b4181c3c), [a4e27535](https://mobbin.com/screens/a4e27535-090f-40de-81c2-fa8e83703b8b)). Obsidian은 무거운 동작을 "could take a few seconds to a few minutes"처럼 사용자 말로 설명합니다([6260ec15](https://mobbin.com/screens/6260ec15-913d-47a8-93f8-c4bfdffb6907)).

**제안.**
1. 그래프 재빌드 칩을 `import.meta.env.DEV`로 감싸십시오. 사이드바 '고장 시뮬레이션'이 이미 같은 방식입니다(`src/components/StatusStrip.tsx:70-71`). `scripts/`에서 `.graph-rebuilds`를 읽는 곳은 없습니다(ON A3, grep 0건).
2. 그래프 통계 문단은 한 줄 요약("내 노트 10개, 연결이 빠진 곳 7개")으로 줄이고, 나머지는 범례의 "자세히"로 옮기십시오. "갭"은 "연결이 빠진 곳", "홉 거리"는 "가까울수록 밝게"로 바꾸십시오.
3. 자료 추가 단계 표시는 사용자에게 의미 있는 세 상태(읽는 중, 고를 차례, 끝)만 남기고, 나머지 카운터는 "세부 정보"로 접으십시오. 작업 코드는 "고침 / 새로 만듦 / 합침 / 이미 있음"으로 표시하십시오.
4. 인덱스 경고는 자동 재인덱스가 도는 중이면 숨기고, 실패했을 때만 "질문에서 찾지 못하는 노트가 6개 있어요 · 다시 색인"으로 보이십시오.
5. 작성 비율 줄은 노트 머리에서 빼서 "노트 정보" 레일로 옮기십시오.
6. 정리 제안 설명문과 Ask 예시를 사용자 말로 바꾸십시오. Ask 예시는 홈 칩과 같은 `intakeCopy.examples`를 쓰십시오.
7. 답의 백분율(Ask와 Spotlight 공통)을 기본 화면에서 뺄지는 소유자 결정입니다. 권장은 "자세히" 아래로 옮기는 것입니다. 일반 사용자에게 71%는 "71% 맞다"로 읽힐 수 있습니다(추론).
8. `src/lib/i18n.glossary.test.ts`(S10)의 금지어에 `바닥선|코사인|게이트|백필|NOOP|온톨로지|홉`을 더하고, "자세히"·고급 설정 키는 `ALLOW`에 넣으십시오.

**파일.** `src/components/GraphQuestions.tsx`, `src/components/IngestProgress.tsx`(단계 표시 위치는 확인 필요), `src/components/StatusStrip.tsx`, `src/pages/PageReader.tsx`, `src/lib/i18n.ts`, `src/lib/i18n.glossary.test.ts`, `src/lib/extractive.ts`(7번).

**수용 기준.**
- `npx vite build` 결과물에는 재빌드 칩이 없고, dev 서버에서는 보입니다. 7번을 하기로 정하면 `?mock=1&window=spotlight`와 Ask에서 영어 질문의 답 기본 화면에 백분율이 없고 "자세히"에 있습니다(스크린샷으로 확인).
- glossary 테스트에 "바닥선"을 ko 일반 키로 넣으면 키 이름과 함께 실패합니다.
- `?mock=1` 자료 추가 계획 검토에서 영어 작업 코드가 보이지 않습니다. 노트 머리에 작성 비율 줄이 없고, 노트 정보에는 있습니다.

## S15 내 노트와 myco가 관리하는 폴더
**묶음:** 일반 사용자 사용성 · **우선순위:** 5 · **크기:** M · **의존:** 없음 · **divergent:** 예(`Sidebar.tsx`)

**목표.** 사용자가 자기가 쓴 것과 앱이 쓴 것을 구분하고, 찾는 노트가 검색 첫 줄에 오며, 새 노트가 어디에 들어가는지 압니다.

**문제와 근거.** (데스크톱 감사 순위 2. 2026-09-26 audit-chrome-home 1번이 지적했지만 S1–S12에 들어가지 않았습니다)
- "내 노트"는 볼트 트리를 그대로 보여 주고(`src/components/Sidebar.tsx:145-148`, `:189`), `CLAUDE`, `_inbox`, `audio`, `cards`, `daily`, `ingest-reports`, `raw`, `sessions`, `templates`, `wiki`, `work`가 같은 무게로 나옵니다(`audit-desktop/shots/sweep/reader-ko-light-1280.png`).
- ⌘K에서 "atten"의 첫 결과가 `work/feedback`의 "2026-08-12-map-candidate-attention"이고, `ingest-reports`와 `cards`의 같은 이름 파일이 섞입니다(`audit-desktop/shots/flow/09-cmdk-atten-ko-dark.png`).
- 새 노트는 폴더를 묻지 않고 `wiki/`에 만들어집니다(`src/lib/newNote.ts:4`, `:29`, `audit-desktop/shots/flow/31-newnote-open-ko-dark-1280.png`).
- 다른 앱: Obsidian iOS 서랍은 행에 BASE/CANVAS 같은 종류 라벨을 답니다([4fb0ebc3](https://mobbin.com/screens/4fb0ebc3-a523-460a-af5d-713685a9b939)). Apple Notes는 개수가 붙은 폴더 몇 개와 태그 줄만 보여 줍니다([6a0eb785](https://mobbin.com/screens/6a0eb785-daad-49db-be8d-b0866ebc7f5c)). Notion iOS와 Evernote web은 새 페이지를 만들 때 넣을 곳을 제안 목록으로 보여 줍니다([149d05a0](https://mobbin.com/screens/149d05a0-f1cf-483f-8703-9aa253c1a46b), [78342f98](https://mobbin.com/screens/78342f98-a7a1-4d22-9bf5-a9d30aa3f742)).

- 폴더만으로는 내 노트와 앱이 쓴 노트를 가를 수 없습니다. 볼트 스키마는 `wiki/`를 "LLM-maintained pages"로 정하는데(`src-tauri/src/vault.rs:290`, `:398`), 사용자의 새 노트도 `wiki/`에 들어갑니다(`src/lib/newNote.ts:4`, `:29`). 출처 각주가 달린 LLM식 페이지 `wiki/attention-mechanism`(`audit-desktop/shots/flow/51-reader-info-ko-dark-1280.png`)과 사용자가 ⌘N으로 만든 노트가 같은 폴더에 섞입니다.
- 앱이 쓴 줄을 가리는 데이터는 이미 있습니다. 변경 이력(git)이 켜져 있으면 커밋 작성자가 `agent@myco.invalid`인지로 줄을 나누고(`src-tauri/src/vault_history.rs:8`, `:265-299`), 파일 단위 색인 `authorship_index`(`src-tauri/src/commands.rs:2858-2864`)를 사이드바 "기록상 사람만" 필터가 씁니다(`src/lib/authorship.ts:37-58`). 다만 git이 없으면 결과가 없고("no repo ... unknown, not a claim", `src-tauri/src/vault_history.rs:265-273`), 변경 이력은 opt-in입니다(`src/components/VaultHistoryBanner.tsx:1-3`).

**제안.**
1. 순수 함수 `classifyTopLevel(name): "mine" | "managed"`를 `lib/`에 두고, `raw`, `sessions`, `cards`, `ingest-reports`, `work`, `_inbox`, `templates`, `audio`, `CLAUDE.md`를 "managed"로 분류하십시오. `wiki`와 `daily`는 "mine" 후보로 두십시오.
2. "mine" 후보 안의 파일은 작성 기록으로 한 번 더 나누십시오. `authorship_index`에서 에이전트가 커밋한 파일(`touched[rel] === true`, `src/lib/authorship.ts:52`)에는 "myco가 씀" 표시를 붙이고 ⌘K에서 사람이 쓴 노트 뒤로 보내십시오. git이 없거나 기록이 없는 파일은 표시 없이 내 노트로 둡니다. 모르는 것을 앱이 썼다고 단정하지 않기 위해서입니다. 노트 머리의 사람 비율(`src/pages/PageReader.tsx:940-959`)은 같은 git 데이터의 줄 단위 판이라 이 분류에는 파일 단위 색인이 더 맞습니다(추론).
3. 트리를 "내 노트"와 접힌 "myco가 관리하는 폴더" 두 구역으로 그리십시오. 디스크의 파일은 그대로 둡니다. Obsidian 호환성은 바뀌지 않습니다.
4. ⌘K는 사람이 쓴 노트, 표시 없는 내 노트, "myco가 씀" 노트, managed 결과 순으로 정렬하고, managed 결과에는 폴더 대신 종류 이름("학습 카드", "자료 추가 보고서", "정리 후보")을 붙이십시오.
5. 새 노트의 기본 위치를 지금 연 노트의 폴더로 바꾸고(managed 폴더면 `wiki/`), 브레드크럼의 폴더 칩을 눌러 옮길 수 있게 하십시오(S6의 `moveNotes`, `src/lib/noteActions.tsx:35` 재사용).
6. 변경 이력이 꺼진 볼트에서는 "myco가 쓴 노트를 구분하려면 변경 이력을 켜세요" 한 줄을 managed 구역 머리에 두십시오. git 없이 가르는 방법(예: `write_page`가 frontmatter에 작성자를 남기기)은 볼트 형식을 바꾸므로 소유자 결정입니다.

**파일.** 새 `src/lib/vaultAreas.ts`(+ test), `src/components/Sidebar.tsx`, `src/components/CommandBar.tsx`, `src/lib/newNote.ts`, `src/lib/i18n.ts`.

**수용 기준.**
- vitest: `classifyTopLevel`이 위 목록을 managed로, `wiki`·`daily`·사용자 폴더를 mine 후보로 돌려줍니다. 정렬 함수는 같은 점수에서 사람이 쓴 노트를 "myco가 씀" 노트보다 앞에 둡니다.
- `?mock=1` 사이드바에 두 구역이 보이고 managed 구역은 접혀 있습니다. mock의 `authorship_index`는 지금 빈 객체이고 `page_authorship`은 모든 노트에 62/38 고정값을 돌려주므로(`src/lib/devMock.ts:1948-1967`) 이 확인용 고정값을 따로 둬야 합니다. 그 `authorship_index`에 `wiki/attention-mechanism.md`를 에이전트 파일로, 사람이 만든 `wiki/` 노트 하나를 사람 파일로 넣으면 ⌘K "atten"의 첫 결과는 사람이 쓴 노트이고, `attention-mechanism`에는 "myco가 씀" 표시가 있습니다.
- `daily/` 노트를 연 채 ⌘N을 누르면 새 노트가 `daily/`에, `cards/` 카드를 연 채 누르면 `wiki/`에 생깁니다.
- `Sidebar.tsx` diff가 추가 위주이고 서식 변경이 없습니다.

## S16 제목을 그 자리에서 고치고 이름은 하나만
**묶음:** 일반 사용자 사용성 · **우선순위:** 6 · **크기:** M · **의존:** S6 `src/lib/noteActions.tsx`(출시됨). 큰 제목을 `listedName`에서 `displayName`으로 바꾸는 부분은 소유자 결정입니다(아래 1번). 본문 첫 H1을 숨기는 부분은 one-editor 스펙 담당과 렌더 규칙을 맞춰야 합니다 · **divergent:** 아니오

**목표.** 사용자가 제목을 눌러 고치고, 한 노트가 한 이름으로만 보이며, 새 노트는 대화상자 없이 바로 씁니다.

**문제와 근거.** (데스크톱 감사 순위 4)
- 큰 제목은 `h1.page-title`이고 편집할 수 없습니다(`src/pages/PageReader.tsx:963`, `audit-desktop/flow5-ko.log`). 이름 바꾸기는 ··· 메뉴에 있습니다(`audit-desktop/shots/flow/43-more-menu-ko-dark-1280.png`).
- LLM이 쓴 노트는 파일 이름 `attention-mechanism`, 속성 `title` "Attention Mechanism", 본문 H1 "Attention Mechanism"으로 한 화면에 이름이 세 번 나옵니다(`audit-desktop/shots/flow/51-reader-info-ko-dark-1280.png`). 오늘의 노트도 날짜가 두 번 나옵니다(`audit-desktop/shots/flow/56-daily-ko-dark-1280.png`).
- 새 노트는 "노트 제목을 정해 주세요." 대화상자를 먼저 거칩니다(`src/lib/newNote.ts:52-58`, `audit-desktop/shots/flow/30-newnote-dialog-ko-dark-1280.png`).
- 출시된 S6과의 관계: S6의 목표는 "The first 100px of a note stop repeating its name four times"였고, 노트 머리의 종류 배지 경로와 절대 경로 줄을 지웠습니다(`docs/research/2026-09-26-ux/backlog.md:322-336`). S6이 손대지 않은 것은 이름의 원천입니다. 큰 제목은 `listedName(stem, title)`로 그리는데(`src/pages/PageReader.tsx:963-964`), `listedName`은 "A readable stem keeps showing the file name, as those lists always have"라는 결정대로 읽을 수 있는 stem이면 속성 `title`을 무시합니다(`src/lib/displayName.ts:40-45`). 그래서 큰 제목은 stem, 속성 칸은 `title`, 본문은 H1을 보여 이름이 세 번 남습니다.
- 다른 앱: Notion은 제목을 문서 첫 줄의 큰 글씨로 두고 새 페이지 아래에 시작 칩을 보여 줍니다([f13ba85e](https://mobbin.com/screens/f13ba85e-b673-4583-a5a6-164a0b7228ab), [e7603296](https://mobbin.com/screens/e7603296-81cf-4983-89c2-7bd849892786)). Obsidian iOS는 이름을 그 자리에서 바꿉니다([67f6cae9](https://mobbin.com/screens/67f6cae9-9c20-4d3a-812f-a7d0ac5ad3a1)).

**제안.**
1. 새 규칙 함수를 만들지 말고 이미 있는 `displayName(stem, title)`(`src/lib/displayName.ts:34-38`, 테스트 `src/lib/displayName.test.ts`)을 큰 제목에 쓰십시오. 이 함수가 이미 "읽을 수 있는 `title`이 있으면 그것, 없으면 stem" 규칙입니다. 큰 제목을 `listedName`에서 `displayName`으로 바꾸는 것은 `listedName`의 결정 문장과 다르므로 소유자 결정입니다. 트리, 그래프, ⌘K 목록(`listedName`을 쓰는 곳)을 같이 바꿀지도 같은 결정에 넣으십시오.
2. 큰 제목을 한 줄 입력으로 바꾸십시오. Enter 처리에는 홈과 같은 `isComposingKey` 가드(`src/pages/PageOverview.tsx:363`)를 거십시오. Enter나 포커스 이탈 때, 속성 `title`이 있으면 그 값을 고치고 없으면 파일 이름을 바꾸십시오. 파일 이름 변경은 `src/lib/noteActions.tsx`에 대화상자 없는 `renameNoteTo(path, name)`을 더해(지금 `renameNote`는 대화상자를 엽니다, `:19`) 백링크 갱신 경로를 그대로 쓰십시오. 어느 쪽을 고칠지는 소유자 확인이 필요합니다(추론).
3. Live에서 본문 첫 H1이 표시 이름과 같으면 그 줄을 접어 숨기십시오(저장 내용은 그대로).
4. 새 노트는 대화상자 없이 "제목 없음"(중복이면 "제목 없음 2")으로 만들고 커서를 제목 입력에 두십시오.

**파일.** `src/pages/PageReader.tsx`, `src/lib/noteActions.tsx`, `src/lib/newNote.ts`, `src/lib/displayName.ts`(읽기만, 바꾸지 않음), Live H1 처리 위치(one-editor 담당과 확인).

**수용 기준.**
- vitest: "제목 없음" 중복 번호. 표시 이름 규칙은 기존 `displayName.test.ts`가 맡습니다.
- 조합 중 Enter가 미완성 음절을 잃지 않습니다. 제목에 "회의 메모"를 치고 "모"가 조합 중일 때 Enter를 누르면 조합만 확정되고 이름은 아직 바뀌지 않으며, 다음 Enter에서 "회의 메모"로 바뀝니다. "회의 메" 같은 잘린 이름이 생기지 않습니다(설치 앱에서 소유자 확인, iOS는 SP-5).
- `?mock=1`에서 제목을 눌러 고치고 Enter를 누르면 트리와 브레드크럼이 새 이름을 보여 줍니다. ⌘N은 대화상자 없이 새 노트를 열고 제목 입력에 포커스가 있습니다.
- `attention-mechanism`을 열면 이름이 한 번만 보입니다. mock은 새 노트 본문을 쓰지 않으므로(데스크톱 감사 "mock의 한계") 이름 변경의 파일 결과는 실제 앱에서 한 번 더 확인하십시오.

## S17 `[[` 후보에 제목과 폴더
**묶음:** 일반 사용자 사용성 · **우선순위:** 7 · **크기:** S · **의존:** 제목 표시는 S16의 `listedName` 소유자 결정(행 높이는 S47) · **divergent:** 아니오

**목표.** 링크를 걸 때 slug가 아니라 사람이 읽는 이름과 위치로 고릅니다.

**문제와 근거.**
- 후보는 stem 기준으로 중복을 지우고 `{label: stem, type: "text"}`로 만듭니다(`src/components/Editor.tsx:848`, `:858-863`). 그래서 행마다 CodeMirror 기본 `abc` 아이콘과 `2026-08-10-emerging-cluster-rope` 같은 stem만 보이고, 행 높이는 19px입니다(`shots/oxn/13-wikilink.png`).
- 첫 후보가 노트가 아니라 PDF이고, "노트 내용에서" 구역은 "transformer-architecture#Transformer Architecture 68%"처럼 앵커와 백분율을 보여 줍니다(`audit-desktop/shots/flow/36-wikilink-ko-dark-1280.png`).
- 2026-09-26 mobbin-obsidian #16(폴더 표시)이 반영되지 않았습니다(ON A2).
- 다른 앱: Obsidian iOS `[[` 팝업은 노트 이름 아래에 폴더 "Itinerary/"를 보여 줍니다([648fdde3](https://mobbin.com/screens/648fdde3-4975-40ba-a8d8-c9eec6fb5c0a), [99d28878](https://mobbin.com/screens/99d28878-15e3-4630-9add-02990ad1626f)). Notion Link 시트는 제목 아래 위치 부제를 답니다([8448eb86](https://mobbin.com/screens/8448eb86-b663-41c1-9871-c60863335e69)).

**제안.**
1. stem 중복 제거는 그대로 두되(링크는 stem으로 풀리므로), `detail`은 링크가 실제로 가리키는 노트의 폴더로 바꾸십시오. `apply`는 지금 stem 그대로 두어 링크 형식을 바꾸지 마십시오. 폴더 표시는 결정 없이 할 수 있습니다.
2. `label`을 제목으로 바꾸는 것은 목록에서 stem을 보여 온 `listedName` 결정(`src/lib/displayName.ts:40-45`)을 바꾸는 일이라 S16과 같은 소유자 결정입니다. 바꾸기로 하면 새 함수를 만들지 말고 `displayName(stem, title)`(`src/lib/displayName.ts:34`)을 쓰십시오. 지금 후보는 파일 트리만 읽어(`src/components/Editor.tsx:847-848`) frontmatter `title`이 없으므로 title을 어디서 받을지(색인 데이터 등)는 확인이 필요합니다.
3. `type`을 빼서 `abc` 아이콘을 없애고, 노트를 PDF보다 앞에 두십시오.
4. "노트 내용에서" 행은 백분율을 숨기고 제목과 문장 조각만 보이십시오.

**파일.** `src/components/Editor.tsx`(후보 생성부를 순수 함수로 빼서 test).

**수용 기준.**
- vitest: 같은 stem 두 노트에서 행 하나, detail은 링크 대상의 폴더, apply는 stem입니다.
- `?mock=1`에서 `[[att`를 치면 폴더가 보이고(2번을 하기로 했다면 제목도) `abc` 아이콘과 백분율이 없습니다.

## S18 첫 실행 마법사 세 단계
**묶음:** 일반 사용자 사용성 · **우선순위:** 3 · **크기:** M · **의존:** S9 `useModalFocus`(출시됨) · **divergent:** 아니오

**목표.** 처음 여는 사람이 폴더를 고르고, 노트를 하나 쓰거나 자료를 하나 넣고, 그 노트에 질문을 한 번 해 보면서 끝납니다.

**문제와 근거.** (데스크톱 감사 "첫 실행 마법사")
- 1단계 제목은 "프로젝트 만들기 또는 열기"인데 본문은 "볼트"를 씁니다(`src/lib/i18n.ts:6087`, `audit-desktop/shots/flow/120-onboard-s0-ko-dark-1280.png`).
- 2단계는 "Claude Code 세션 가져오기"를 기본 버튼으로 둡니다(`src/lib/i18n.ts:6111`, `audit-desktop/shots/flow/120-onboard-s1-ko-dark-1280.png`). 가져온 뒤 포커스가 BODY로 빠집니다(`audit-desktop/flow12-ko.log`).
- 3단계 "첫 자료 추가하기"에는 추가할 곳이 없고 진행 막대만 있습니다(`src/components/OnboardingWizard.tsx:324-345`, `src/lib/i18n.ts:6093-6095`, `audit-desktop/shots/flow/120-onboard-s3-ko-dark-1280.png`). 2026-09-26 감사 O2가 지적했지만 남아 있습니다.
- 4단계는 git 이력을 설명합니다(`src/lib/i18n.ts:6120`).
- 다른 앱: Mintlify는 "Step 2/4"와 "Skip for now"를 함께 둡니다([3abddd12](https://mobbin.com/screens/3abddd12-6ef2-4abb-a075-4f4c6216d781)). Obsidian iOS 첫 화면은 "노트는 이 기기의 볼트라는 폴더에 있다"는 약속부터 말합니다([e77414c6](https://mobbin.com/screens/e77414c6-2bee-4455-be64-60b7887b75f5)). Notion은 첫 문서를 직접 눌러 보는 할 일 목록으로 만듭니다([6e433dba](https://mobbin.com/flows/6e433dba-57db-40ee-8efa-36f36993fae9)).

**제안.**
1. 단계를 셋으로 줄이십시오: 폴더 고르기(로컬 약속 한 문장), 첫 노트 쓰기 또는 자료 넣기(마법사 안의 입력칸과 파일 선택), 그 노트에 질문 한 번(미리 채운 질문으로 Ask를 엽니다).
2. 세션 가져오기와 변경 이력은 홈 안내 카드와 설정으로 옮기십시오.
3. 각 단계에 "1/3" 글자 진행 표시와 "건너뛰기"를 두고, 동작 뒤에도 포커스가 마법사 안에 남게 하십시오.

**파일.** `src/components/OnboardingWizard.tsx`, `src/lib/i18n.ts`, 홈 안내 카드 위치(`src/pages/PageOverview.tsx`).

**수용 기준.**
- `localStorage.removeItem("myco.onboarded")`와 `list_files` 빈 배열로 띄우면 단계가 셋이고 "1/3"이 보입니다.
- 2단계 입력칸에 쓰고 다음을 누르면 노트가 생기고, 3단계가 끝나면 Ask에 답 턴이 있습니다.
- 마법사에 Claude Code 버튼이 없고, 각 동작 뒤 Tab이 마법사 안에서 돕니다.

## S19 홈 배지와 관리 도구
**묶음:** 일반 사용자 사용성 · **우선순위:** 8 · **크기:** S · **의존:** 없음 · **divergent:** 예(`Sidebar.tsx:154`)

**목표.** 홈의 숫자는 "오늘 내가 할 일"만 세고, 관리 도구를 펼쳐도 화면 구조가 바뀌지 않습니다.

**문제와 근거.** (데스크톱 감사 "홈")
- 첫 화면에 숫자 네 개가 서로 다른 뜻입니다. 홈 옆 12는 수확 후보 세션 수이고 설명은 툴팁에만 있습니다(`src/components/Sidebar.tsx:154`, `src/lib/i18n.ts:5952`, `audit-desktop/shots/flow/01-home-full-ko-dark.png`).
- "검토하고 정리하기"를 펼치면 페이지 전체가 두 칸으로 바뀌고 "막힌 페이지 · scaling-laws 분쟁 표시된 페이지입니다 · 해소: active · superseded로", "배치 편집", "런 보기"가 쌓입니다(`audit-desktop/shots/flow/13-manage-0-ko-dark.png`, `src/lib/i18n.ts:6179-6180`, `:6199-6200`).
- 질문 입구가 셋(입력창, 예시 칩, "내 노트에 질문하기" 카드)입니다(`audit-desktop/shots/flow/01-home-full-ko-dark.png`).
- 다른 앱: Notion iOS 홈은 알림이 있는 Inbox에만 점을 찍습니다([e7689c02](https://mobbin.com/screens/e7689c02-0bc0-49f7-bc5c-71f516844d33), [d60253f9](https://mobbin.com/screens/d60253f9-da05-4c96-b846-7c0a7751da94)). Headway는 할 일을 "Repeat 3 cards" 버튼 하나로 보여 줍니다([3d987534](https://mobbin.com/flows/3d987534-1fb1-4502-872e-49e765b79e85)).

**제안.**
1. 배지는 기한 복습 카드와 사용자 확인이 필요한 제안만 세십시오. 수확 후보 세션 수는 자료 추가 화면 안으로 옮기십시오.
2. 관리 도구는 같은 칸 안에서 펼치고 레이아웃을 바꾸지 마십시오. "막힌 페이지" 행은 "두 노트의 내용이 서로 달라요 · 확인하기"처럼 쓰십시오.
3. 홈 입력창이 있으면 "내 노트에 질문하기" 카드를 빼십시오.

**수용 기준.**
- `?mock=1` 홈 사이드바의 홈 항목에 세션 수 배지가 없습니다. 관리 도구를 펼쳐도 첫 칸의 폭이 그대로입니다.
- 홈에서 질문 입구는 입력창과 칩 두 가지입니다.

## S20 정리 제안: 펼쳐 본 뒤 승인
**묶음:** 일반 사용자 사용성 · **우선순위:** 9 · **크기:** S · **의존:** 없음 · **divergent:** 아니오

**목표.** 무엇을 승인하는지 보고 나서 승인하고, 메뉴 이름과 페이지 이름이 같습니다.

**문제와 근거.**
- 카드가 내용을 펼치지 않은 채 "승인 / 무시"를 보여 주고, 내용은 오른쪽 끝 작은 화살표로만 펼쳐지며 제목을 눌러도 반응이 없습니다(`src/pages/PageFeedback.tsx:252-262`, `:276-283`, `audit-desktop/shots/flow/87b-feedback-expand-ko-dark-1280.png`).
- 메뉴는 "정리 제안", 페이지 제목은 "수확함"이고, 영어도 "Review suggestions"와 "Harvest box"로 다릅니다(`src/lib/i18n.ts:5595`, `:5604`, `audit-desktop/shots/sweep/feedback-en-dark-1280.png`).
- 다른 앱: Obsidian iOS는 파일을 끄는 동안 "Move into "Itinerary"" 결과 문장을 보여 주고([9a0771d2](https://mobbin.com/screens/9a0771d2-d259-416f-b986-469d4c626c71)), 합치기 확인 시트에서 무엇이 지워지는지 말합니다([07fba263](https://mobbin.com/flows/07fba263-e731-4aa8-9fa3-46db294aa8c7)). Notion은 이동 뒤 "Moved to … · Undo"를 띄웁니다([871bed26](https://mobbin.com/flows/871bed26-cd6c-4010-9113-c583945fc68b)).

**제안.**
1. 카드 머리 전체를 펼침 버튼으로 만들고, 펼치기 전에는 "내용 보기"만 보이고 펼친 뒤에 "승인"을 기본 버튼으로 보이십시오.
2. 승인 버튼 옆에 결과 문장("노트 2개를 보관 폴더로 옮깁니다")을 제안 종류에서 만들어 적으십시오.
3. 페이지 제목을 메뉴 이름에 맞추십시오(ko, en, ja).

**수용 기준.**
- `?mock=1` 정리 제안에서 펼치기 전에는 "승인"이 보이지 않고, 제목을 누르면 펼쳐집니다.
- 페이지 머리가 ko "정리 제안", en "Review suggestions"입니다.

## S21 할 일: 한국어 날짜와 읽히는 목록
**묶음:** 일반 사용자 사용성 · **우선순위:** 10 · **크기:** M · **의존:** 없음 · **divergent:** 아니오

**목표.** "내일 오후 3시"를 날짜로 읽고, 목록의 출처가 읽히며, 세부 입력이 한국어로 안내됩니다.

**문제와 근거.**
- "치과 예약 내일 오후 3시"가 마감일 없이 들어가고 목록 중간에 강조 없이 끼어듭니다(`audit-desktop/shots/flow/100-task-typing-ko-dark-1280.png`, `audit-desktop/shots/flow/101-task-added-ko-dark-1280.png`).
- 출처 열이 "m…", "t.."로 잘립니다(`src/pages/PageTasks.tsx:695-706`, `audit-desktop/shots/sweep/tasks-ko-light-1280.png`).
- "자세히"가 입력 9개를 열고 자리표시자가 "#dev", "[[project]]", "2d", "every week"이며(`src/components/TaskComposer.tsx:176`, `:188`, `:267`, `:285`, `src/components/TaskDetail.tsx:255`, `:266`), 열린 상태가 캘린더까지 따라옵니다(`audit-desktop/shots/flow/105-calendar-ko-dark-1280.png`).
- 다른 앱: Evernote iOS 할 일 빠른 추가는 Due today / Due tomorrow / Repeat 칩을 둡니다([ecec3dd6](https://mobbin.com/screens/ecec3dd6-7f30-4a30-87da-2ca3b2c848ae)). Notion `@`는 "Today", "Next Tuesday 3pm"을 같은 목록에서 고르게 합니다([f25b2b41](https://mobbin.com/screens/f25b2b41-8ef6-49d5-8642-76aaf1ae88e8)).

**제안.**
1. 순수 함수 `parseKoDue(text, now)`로 "오늘, 내일, 모레, 월~일요일, 다음 주 X요일, 오전/오후 N시(반)"를 읽고, 입력 중 날짜 칩으로 미리 보이며, 추가할 때 제목에서 그 부분을 빼십시오. 미리 보기는 한국어 조합이 끝난 값(`compositionend` 뒤, 또는 `isComposing`이 아닌 `input`)으로만 다시 계산하고, 조합 중에는 입력칸 값을 고치지 마십시오. 추가 Enter는 지금처럼 `isComposingKey`로 막습니다(`src/components/TaskComposer.tsx`가 이미 씁니다).
2. 추가한 행을 1.5초 강조하십시오(`prefers-reduced-motion`에서는 끄기).
3. 출처 열은 최소 폭을 보장하거나 제목 아래 작은 글씨로 옮기십시오.
4. 자리표시자를 ko 문자열("예: 2일", "예: 매주")로 옮기고, 보기 전환 때 세부 입력을 닫으십시오.

**수용 기준.**
- vitest: "내일 오후 3시"(월말 포함), "다음 주 월요일", 날짜 없는 문장, "3시간"처럼 날짜가 아닌 숫자.
- `?mock=1`에서 "치과 예약 내일 오후 3시"를 추가하면 제목 "치과 예약", 마감 내일 15:00 칩이 붙고 행이 잠깐 강조됩니다.
- 조합 중 Enter나 탭이 미완성 음절을 잃지 않습니다. "내일 오후 3시"를 두벌식으로 치는 동안 칩 계산이 입력칸 글자를 바꾸지 않고, "시"가 조합 중일 때 [추가]를 눌러도 "3시"가 온전히 읽힙니다(설치 앱에서 소유자 확인, iOS는 SP-5).

## S22 설정: 첫 화면과 글자 크기
**묶음:** 일반 사용자 사용성 · **우선순위:** 11 · **크기:** M · **의존:** 없음 · **divergent:** 아니오

**목표.** 설정을 열었을 때 일반 사용자가 바꾸는 것(테마, 글자 크기)이 먼저 보이고, 글자 크기는 기본으로 OS 설정을 따르며, AI 모델은 기본값으로 시작합니다.

**문제와 근거.**
- 설정은 "AI 설정" 탭으로 열리고 첫 카드가 select 세 개와 "claude-sonnet-4-6" 입력입니다(`audit-desktop/shots/sweep/settings-ko-light-1280.png`). 375px에서는 제공자 select가 67px입니다(`audit-mobile/shots/crops/375-ko-light-settings-full-0.png`).
- "AI 연결" 탭의 "켜짐/꺼짐" 글자가 "연결" 버튼과 겹치고, 하단 안내가 영어로 하드코딩돼 있습니다(`audit-desktop/shots/flow/112-settings-AI_연결-ko-dark-1280.png`, `src/pages/settings/Providers.tsx:411-412`).
- 설정 검색 "글꼴"이 0건이고 글자 크기를 바꿀 수 없습니다(`audit-desktop/shots/flow/113-settings-search-font-ko-dark-1280.png`).
- 글자 크기가 거의 모두 px로 고정돼 있어 OS 글자 크기가 전해지지 않습니다. 스타일시트의 `font-size`는 px 431곳, rem 28곳, `var()` 43곳입니다(`src/styles.css`, `src/styles/*.css`를 grep으로 셈).
- "플러그인" 탭이 `contributes.fences[0].renderer` 검증 오류를 그대로 보여 줍니다(`audit-desktop/shots/flow/112-settings-플러그인-ko-dark-1280.png`).
- 다른 앱: Telegram iOS의 Text Size 화면은 "Use System Text Size" 스위치와 그 아래 슬라이더를 둡니다([c4324f74](https://mobbin.com/screens/c4324f74-c637-4e49-b9e8-c30e59b05bed)). Appearance 목록에서 Text Size 행은 색 테마 묶음 아래에 있고, 값이 "System"으로 보입니다([6683d9ce](https://mobbin.com/screens/6683d9ce-cc3e-40a0-86b2-2cd55ea81e48)). 사용자가 바꾸면 "19pt / 17pt"처럼 바뀐 값이 보입니다([bebcbe7f](https://mobbin.com/screens/bebcbe7f-6f5b-46c2-acf0-615a2117c8fe)). Perplexity 모델 시트는 기본값 "Best"를 맨 위에 둡니다([bd574396](https://mobbin.com/screens/bd574396-3374-46b8-ba9c-a2867782643a)).

**제안.**
1. 기본 탭을 "테마"로 바꾸십시오. 글자 크기는 "시스템 설정 따르기"(기본)와 "직접 고르기"(작게/보통/크게) 두 단계로 두고, 직접 고르기는 OS 값을 덮어쓰는 용도로만 쓰십시오. 노트와 Ask 본문 크기는 CSS 변수 하나에서 계산하십시오.
   - iOS 빌드에서 "시스템 따르기"는 WebKit의 `font: -apple-system-body`가 Dynamic Type 크기를 주는 성질을 기준으로 삼을 수 있습니다(https://furbo.org/2024/07/04/dynamic-type-on-the-web/, https://useyourloaf.com/blog/using-dynamic-type-with-web-views/). 이 값은 글꼴도 시스템 글꼴로 바꾸므로 `font-family`는 따로 다시 지정해야 합니다(같은 출처). WKWebView에서 실제로 동작하는지는 SP-5에서 확인하십시오.
   - 데스크톱 macOS에서 "시스템 따르기"를 무엇에 맞출지는 확인하지 못했습니다. 그때까지 데스크톱 기본은 지금 크기입니다.
   - 어느 쪽이든 본문과 Ask의 px 크기를 변수 기반으로 옮겨야 OS나 앱 설정이 전해집니다.
2. AI 모델 카드는 "추천 설정 사용"(기본)과 "직접 고르기"로 나누고, 직접 고르기를 고를 때만 select를 보이십시오.
3. 상태 글자와 연결 버튼을 스위치 하나로 합치고, `Providers.tsx`의 영어 문자열을 i18n 키로 옮기십시오.
4. 플러그인 검증 오류는 "자세히" 아래로 내리고 기본 문구는 "이 플러그인을 불러오지 못했어요"로 쓰십시오.

**수용 기준.**
- `?mock=1` 설정이 "테마" 탭으로 열리고, 글자 크기 기본값이 "시스템 설정 따르기"입니다. "직접 고르기 · 크게"를 고르면 노트와 Ask 본문 크기가 바뀝니다. 설정 검색 "글자"가 그 항목을 찾습니다.
- iOS 빌드(SP-5): 설정 앱의 글자 크기를 가장 크게 바꾸면 "시스템 설정 따르기" 상태에서 노트 본문이 커지고, 가로 넘침이 없습니다.
- `Providers.tsx`에 사용자에게 보이는 영어 리터럴이 없습니다.

## S23 찾기 칩과 사이드바 태그
**묶음:** 일반 사용자 사용성 · **우선순위:** 12 · **크기:** S · **의존:** 없음 · **divergent:** 예(`Sidebar.tsx`)

**목표.** `tag:`, `path:` 문법을 몰라도 칩을 눌러 좁히고, 태그로 노트를 찾습니다.

**문제와 근거.**
- ⌘K 입력창 안내가 `검색하거나 이동 — "정확히", path:, tag:, type:`이고(`src/lib/i18n.ts:5948`), 연산자 설명은 input `title` 툴팁에만 있습니다(`src/components/CommandBar.tsx:491`, `src/lib/i18n.ts:3822`). 375px에서는 안내가 "…path:, tag:, ty…"에서 잘립니다(`shots/oxn/11-cmdk.png`).
- 사이드바에 태그가 없습니다(`src/components/Sidebar.tsx`에서 "tag" 0건, WC 0절). 2026-09-26 craft-bear #4가 제안했지만 S1–S12에 없습니다.
- 다른 앱: Evernote iOS는 빈 검색에 APPLY FILTER를, 결과 위에 점선 "+" 추천 필터 칩을 둡니다([bdc7e0b5](https://mobbin.com/screens/bdc7e0b5-08fc-4b75-aec3-1fe81026de9d), [2952cb28](https://mobbin.com/screens/2952cb28-ffd2-4c40-abcf-9342b1d7e7d0)). Obsidian은 입력하는 동안 연산자 목록을 설명과 함께 보여 줍니다([ac93a668](https://mobbin.com/screens/ac93a668-ffbc-43dd-8437-8428767713a1)). Apple Notes는 폴더 아래 태그 칩 줄을 둡니다([6a0eb785](https://mobbin.com/screens/6a0eb785-daad-49db-be8d-b0866ebc7f5c)).

**제안.**
1. 빈 쿼리와 결과 위에 칩 줄(태그 · 폴더 · 종류 · 출처 없음)을 두고, 누르면 접두어가 입력칸에 들어가 지금의 `parseSearchQuery` 경로를 타게 하십시오. 렌즈 행은 그대로 둡니다.
2. 입력창 안내는 "노트 찾기 또는 이동"으로 줄이십시오.
3. 사이드바에 접힌 "태그" 그룹을 두고 상위 N개를 개수와 함께 칩으로 보이십시오. 누르면 `tag:` 칩이 켜진 ⌘K가 열립니다. 새 라우트는 만들지 않습니다.

**수용 기준.**
- `?mock=1` ⌘K를 빈 채로 열면 칩 줄이 보이고, "태그"를 누르면 입력칸이 `tag:`가 되며 태그 후보가 나옵니다.
- 사이드바 태그 칩을 누르면 그 태그로 걸러진 ⌘K가 열립니다.

## S24 빈 노트와 빈 오늘의 노트의 시작 칩
**묶음:** 일반 사용자 사용성 · **우선순위:** 13 · **크기:** S · **의존:** 블록 에디터 슬래시 템플릿(출시됨) · **divergent:** 아니오

**목표.** 빈 화면에서 망설일 때 슬래시를 몰라도 시작점이 보입니다.

**문제와 근거.**
- 빈 줄에는 "'/'를 입력해 블록 선택" 안내만 있습니다(`shots/05-phone-375-note-editing.png`). 템플릿은 슬래시 항목으로만 쓸 수 있습니다(WC W6).
- 빈 오늘의 노트는 날짜 H1만 있습니다(`audit-desktop/shots/flow/56-daily-ko-dark-1280.png`).
- 다른 앱: Evernote iOS 빈 노트는 키보드 위에 템플릿 칩을 둡니다([9056e48b](https://mobbin.com/screens/9056e48b-833b-4627-a072-aa6cf6420aab)). Goodnotes는 "Skip the blank page"와 템플릿 카드를 보여 줍니다([976b45a2](https://mobbin.com/screens/976b45a2-7ede-410d-a78d-f8fcfb90ae55)). Notion web 빈 페이지는 "Get started with" 칩을 둡니다([8a1f646f](https://mobbin.com/screens/8a1f646f-da51-4baa-a89d-489e6e7035a5)).

**제안.** 본문이 비어 있을 때만 안내 아래에 `templates/`의 `slash:` 항목 2–3개를 칩으로 보이고, 첫 입력에서 사라지게 하십시오. 오늘의 노트에는 "오늘 할 일 / 회의 메모 / 생각 정리" 칩을 같은 방식으로 두십시오.

**수용 기준.** `?mock=1`에서 빈 새 노트에 칩이 보이고, 누르면 템플릿 내용이 들어가며, 한 글자를 치면 칩이 사라집니다.

---

# 일관성/안정성

## S25 자동 정리가 사용자가 넣은 자료를 치우기 전에 묻기
**묶음:** 일관성/안정성 · **우선순위:** 1(데이터 손실 등급) · **크기:** M · **의존:** B1 소유자 결정(`raw/` 이동). 아래 1번의 (가)/(나) 선택 · **divergent:** 아니오

**목표.** 사용자가 넣은 음성 메모, 웹 클립, 끌어다 놓은 파일, 원문(`raw/`)이 묻지 않고 격리되거나 휴지통을 거쳐 지워지지 않습니다.

**문제와 근거.**
- distill이 판정하는 것은 inflow입니다. `_inbox/`, `raw/`, `sessions/`만 훑고(`src-tauri/src/distill.rs:474-490` `collect_candidates`, 하위 폴더는 `_inbox/quarantine/`, `raw/archive/`, `sessions/archive/`만 뺍니다) `wiki/`와 `daily/`는 보지 않습니다. 그래서 편집기에서 쓴 노트(`wiki/`, `daily/`)는 이 경로로 격리되지 않습니다. 앞 판의 "편집기에서 쓴 개인 노트를 격리한다"는 주장은 철회합니다.
- 사용자가 직접 넣은 것은 이 inflow에 있습니다. Spotlight와 노치의 음성 메모는 `source: voice` frontmatter를 달고 `_inbox/voice-<시각>.md`로 들어가고(`src-tauri/src/commands.rs:511`, `:517-521`, `src/components/Spotlight.tsx:7-10`), 웹 클립은 `source: clipper`로 `_inbox/`에 들어갑니다(`src-tauri/src/clip.rs:2-4`, `:205`). 끌어다 놓은 파일도 `copy_into_inbox`로 `_inbox/`에 들어갑니다(`src-tauri/src/commands.rs:1164`). 자료 추가의 원문은 `raw/`에 남습니다.
- 판정이 격리면 파일을 `_inbox/quarantine/`으로 옮기고(`src-tauri/src/distill.rs:682-694`), 30일 뒤(`:39-41`, `:664`) Standard 강도에서는 `.myco/trash/<run-id>/`로, 그 30일 뒤에는 `remove_dir_all`로 지웁니다(`:767`, `:2741-2819`). summary 등급은 첫 줄을 오늘 노트에 "(low confidence)"로 붙이고 파일을 `raw/archive/`로 옮깁니다(`:2590-2678`). 200바이트 미만은 junk로 reject되어 제자리에 남습니다(`:275`, `:311-317`, `:716-719`).
- 기본값: `enabled: d_true()`(`src-tauri/src/distill.rs:73`, `:108`), 강도 `Standard`(`:31-33`), 격리 기한 30일, 위키 50쪽 미만이면 게이트가 꺼져 아무것도 판정하지 않습니다(`GATE_MIN_WIKI_PAGES`, `:550`, `:584-592`). 실행 경로와 `enabled`를 보지 않는 점은 B1에 적었습니다.
- 화면: 정리 제안의 "격리" 탭은 "주제 불일치: 유사도 0.31 · 기준 0.38 (가장 가까운 주제: transformers) · 12일 남음", "기한 만료 — 다음 실행에서 휴지통으로 옮겨질 수 있습니다"로 보입니다(`audit-desktop/shots/flow/88-feedback-quarantine-ko-dark-1280.png`, `src/lib/i18n.ts:5626`). 이 화면의 항목 `mortgage-rates-2026.md`, `sourdough-log.md`는 mock이 격리 탭을 그리려고 심은 가짜 데이터입니다("seeded so ?mock=1 renders the Feedback page's quarantine tab", `src/lib/devMock.ts:775-801`). 화면 문구의 근거로만 쓰고, 실제로 그런 파일이 격리됐다는 근거로는 쓰지 않습니다.
- 격리가 생겨도 사이드바 배지와 정리 제안 첫 탭에는 따로 드러나지 않습니다(`audit-desktop/shots/sweep/feedback-ko-light-1280.png`).
- 다른 앱: Obsidian iOS는 볼트 삭제 전에 "This action is irreversible"를 빨간 글로 따로 보여 줍니다([285f00bf](https://mobbin.com/flows/285f00bf-5b07-4a6b-8f35-03be2f446436)). Notion은 이동 뒤 같은 자리에 Undo를 둡니다([871bed26](https://mobbin.com/flows/871bed26-cd6c-4010-9113-c583945fc68b)).

**제안.**
1. 소유자에게 둘 중 하나를 정해 받으십시오. 판단 기준은 작성 비율이 아니라 inflow의 출처입니다.
   - (가) 사용자가 넣은 inflow는 자동 격리에서 뺍니다. 대상은 frontmatter `source`가 `voice` 또는 `clipper`인 파일과 앞으로의 폰 캡처(`kind: capture`, `mobile-strategy.md`)입니다. 끌어다 놓은 `.md` 파일에는 지금 출처 표시가 없어 가를 수 없습니다. 표시를 남기려면 사용자 파일 내용을 바꿔야 하므로, 그런 파일까지 지키려면 (나)가 더 안전합니다(추론). `raw/`는 B1 결정을 따릅니다(권장: 격리 대상에서 뺌). 이런 파일은 판정만 기록하고 제자리에 둔 채 "정리할까요?" 목록에 올립니다. `sessions/`(자동으로 들어온 작업 기록)는 지금처럼 둡니다.
   - (나) 출처와 상관없이 격리 전에 "이 자료를 위키 정리에서 빼 둘까요?"라고 묻고, 확인한 것만 옮깁니다.
2. 어느 쪽이든 휴지통 이동(`src-tauri/src/distill.rs:2741-2803`)은 사용자가 `confirmAction({ danger: true })`로 확인한 경우에만 하십시오. 기한 만료는 "확인 필요" 상태로만 바꿉니다. 휴지통 폴더의 30일 영구 삭제(`src-tauri/src/distill.rs:2808-2819`)는 사용자가 확인해 넣은 항목에만 적용하십시오.
3. 격리 항목이 생기면 홈 첫 화면에 한 줄("정리에서 빼 둔 자료 2개 · 확인")로 알리고, 숫자(유사도·기준)는 "자세히" 아래로 내리십시오.

**파일.** `src-tauri/src/distill.rs`(`scan`의 격리 분기, TTL 단계), `src/pages/PageFeedback.tsx`(격리 탭), `src/pages/PageOverview.tsx`(알림 줄), `src/lib/i18n.ts`.

**수용 기준.**
- `cargo test`(distill): 50쪽 이상 위키가 있는 임시 볼트에서, (가)라면 `source: voice`와 `source: clipper` 파일은 격리 판정이 나도 제자리에 있고 판정 기록만 남습니다. B1에서 (1)이나 (2)를 골랐다면 `raw/` 파일은 `_inbox/quarantine/`으로 옮겨지지 않습니다.
- `cargo test`: 기한이 지난 격리 항목은 확인 없이 `.myco/trash/`로 가지 않고, 확인한 항목만 갑니다.
- `?mock=1` 홈에 격리 알림 줄이 보이고, 누르면 격리 탭이 열립니다.

## S26 비활성 버튼과 막힌 탭
**묶음:** 일관성/안정성 · **우선순위:** 2 · **크기:** S · **의존:** 없음 · **divergent:** 아니오

**목표.** 눌리지 않는 버튼은 눌리지 않게 보이고, 조건이 안 맞는 화면은 고칠 곳으로 가는 길을 줍니다.

**문제와 근거.** (데스크톱 감사 순위 5)
- `.btn-primary`(`src/styles.css:1075`)에는 `:disabled` 규칙이 없고, `.u-btn:disabled`(`src/styles/ui.css:58`)와 `.hq-btn.btn:disabled`(`src/styles.css:10147`)에만 있습니다. Ask "질문하기"는 비활성일 때도 배경색, 불투명도 1, `cursor: pointer`가 활성과 같습니다(`audit-desktop/dis.log`).
- 에이전트 탭은 "에이전트 모드에는 Anthropic API 또는 OpenAI 호환 제공자가 필요합니다. 현재: anthropic-cli."라고만 쓰고 설정으로 가는 길이 없습니다(`audit-desktop/shots/flow/25-ask-agent-ko-dark-1280.png`, `audit-desktop/agent.log`).
- 다른 앱: Mintlify는 선택 전 Continue를 흐리게 두고 "Skip for now"를 따로 줍니다([3abddd12](https://mobbin.com/screens/3abddd12-6ef2-4abb-a075-4f4c6216d781)). Claude iOS는 모델을 쓸 수 없을 때 입력창 위 띠에 "Learn more"를 답니다([2f4b2424](https://mobbin.com/screens/2f4b2424-da04-4326-8bc4-a01e30724ebb)).

**제안.**
1. `.btn:disabled, .btn-primary:disabled`에 `.u-btn:disabled`와 같은 흐림과 `cursor: not-allowed`를 주십시오.
2. 에이전트 탭은 조건이 안 맞으면 [AI 연결 열기] 버튼으로 설정의 AI 연결 탭을 여십시오.

**수용 기준.**
- 입력이 빈 Ask에서 "질문하기"의 computed `opacity`가 1보다 작고 `cursor`가 `not-allowed`입니다(`audit-desktop/dis.mjs` 재사용).
- 에이전트 탭에서 [AI 연결 열기]를 누르면 설정 AI 연결 탭이 열립니다.

## S27 저장 상태와 읽지 못한 파일
**묶음:** 일관성/안정성 · **우선순위:** 3 · **크기:** M · **의존:** 없음(모바일 iCloud 단계의 선행 작업) · **divergent:** 아니오

**목표.** 볼트가 어디 있고, 무엇을 읽지 못했고, 변경 이력이 켜져 있는지를 사용자가 확인할 수 있습니다. 빠진 파일을 조용히 넘기지 않습니다.

**문제와 근거.**
- 인덱스 빌드는 읽지 못한 파일을 조용히 건너뜁니다. 주석은 그 예로 "an un-downloaded iCloud placeholder"를 듭니다(`src-tauri/src/index.rs:88-98`, WC 0절 7).
- 내려받지 않은 파일의 모양은 OS마다 다릅니다. macOS Sonoma부터 iCloud Drive는 숨은 `.icloud` stub 대신 원래 이름 그대로인 dataless 파일을 남기고, 읽으면 내려받아 채웁니다(https://eclecticlight.co/2024/03/07/icloud-drive-in-sonoma-clones-sparse-files-versions-and-more/). 그래서 지금 Mac에서는 `walk_dir`이 dataless 파일을 `.md` 이름 그대로 내보내고(`src-tauri/src/vault.rs:1226-1230`), 그 파일을 읽는 순간 내려받기가 시작되거나 오프라인이면 읽기가 실패합니다(실패 쪽은 추론). `.note.md.icloud` 같은 stub 이름은 지금 Mac에서는 거의 나오지 않을 것으로 봅니다(추론). iOS가 어느 쪽을 쓰는지는 확인하지 못했습니다.
- 저장 상태는 노트 단위로만 있고(`src/pages/PageReader.tsx:904-911`), 변경 이력은 opt-in 배너로만 안내됩니다(`src/components/VaultHistoryBanner.tsx:1-3`).
- 다른 앱: Crouton은 체크 행 네 줄로 동기화 상태를 보여 줍니다([2ec1d29c](https://mobbin.com/screens/2ec1d29c-8a03-4e15-9022-bdbc2c9de4dd)). MD Vinyl은 "Last synced at …" 한 줄을 둡니다([2451dc46](https://mobbin.com/screens/2451dc46-c58d-472e-ba63-802790b155bc)). Obsidian iOS는 볼트를 만든 직후 "다른 기기에서 보려면 동기화를 켜야 한다"고 설명합니다([c464d280](https://mobbin.com/screens/c464d280-72a1-4984-b7b9-02bed72b99db)).

**제안.**
1. Rust 쪽 `walk_dir`(또는 `list_files`)이 "아직 내려받지 않은 파일" 개수와 경로를 따로 돌려주게 하십시오. 판별 후보는 둘입니다. (a) `stat`의 `st_flags`에 `SF_DATALESS`(0x40000000)가 켜져 있는지 봅니다(chflags(2), https://keith.github.io/xcode-man-pages/chflags.2.html). Rust에서는 `std::os::macos::fs::MetadataExt::st_flags()`로 읽을 수 있고, 이 기계에서 컴파일과 실행을 확인했습니다(`scratchpad/stflags/m.rs`). 파일을 열지 않으므로 내려받기를 일으키지 않습니다(추론). (b) Foundation의 `NSURLUbiquitousItemDownloadingStatusKey`를 Swift 쪽에서 읽습니다. iOS 앱에는 (b)가 필요할 수 있습니다. `.*.icloud` stub 이름 규칙은 실제 iOS 볼트에서 쓰이는 것이 확인될 때만 보조로 두십시오.
2. 인덱스와 그래프 빌드는 dataless 파일을 읽지 말고 건너뛰십시오. 지금처럼 읽으면 볼트 전체를 내려받게 만들 수 있습니다(추론).
3. 설정과 사이드바 볼트 상태에 "저장 상태" 행을 두십시오: 볼트 위치(경로로 iCloud Drive·Dropbox 판별), 아직 내려받지 않았거나 읽지 못한 파일 n개(목록 링크), 변경 이력 켜짐/꺼짐, 마지막 저장 시각.
4. myco 자체 동기화가 없으므로 "동기화됨" 칩은 만들지 마십시오(ON B5).

**수용 기준.**
- `cargo test`: 판별 함수(`st_flags`, `st_blocks`, 길이를 받는 순수 함수)가 `SF_DATALESS`가 켜진 값을 "내려받지 않음"으로, 꺼진 값을 "있음"으로 분류합니다. dataless 파일을 테스트에서 직접 만들 수는 없으므로(플래그는 사용자 공간에서 설정할 수 없습니다, chflags(2)) 실제 동작은 아래 수동 확인으로 봅니다.
- 수동 확인(필수): "Mac 저장 공간 최적화"를 켠 iCloud Drive 볼트에서 Finder로 노트 몇 개를 "다운로드 제거"한 뒤, 저장 상태 행의 개수가 그 수와 같고, 인덱스 빌드 뒤에도 그 파일들이 여전히 내려받지 않은 상태인지 확인하십시오.
- `?mock=1` 설정에 저장 상태 행 네 줄이 보입니다(mock에 내려받지 않은 파일 개수를 추가).

## S28 키보드: 트리 방향키와 화면 이동 후 포커스
**묶음:** 일관성/안정성 · **우선순위:** 4 · **크기:** M · **의존:** 없음(그래프 캔버스 포커스는 S44) · **divergent:** 예(`Sidebar.tsx`, `SidebarTree.tsx`)

**목표.** 키보드만 쓰는 사람이 트리를 방향키로 움직이고, 화면을 옮기면 포커스가 본문으로 갑니다.

**문제와 근거.** (데스크톱 감사 순위 17)
- 트리는 방향키로 움직이지 않고 모든 행이 Tab 정지점이라 `wiki`를 펼치면 57행을 Tab으로 지나야 합니다(`audit-desktop/flow13-ko.log`).
- ⌘K로 그래프에 가도 포커스가 사이드바에 남고, 본문으로 건너뛰는 링크가 없습니다(`audit-desktop/flow13-ko.log` "GRAPH TAB").

**제안.**
1. `SidebarTree`에 roving tabindex를 넣으십시오: 트리 전체가 Tab 정지점 하나, ↑↓ 이동, → 펼치기와 첫 자식, ← 접기와 부모, Enter 열기.
2. 라우트가 바뀌면 입력칸이나 모달에 포커스가 없을 때 본문 제목(`tabIndex=-1`)으로 포커스를 옮기십시오.
3. 첫 Tab 위치에 "본문으로 건너뛰기" 링크를 두십시오.

**수용 기준.**
- vitest: 다음 포커스를 계산하는 순수 함수(펼친 폴더, 마지막 행, 부모로 가기).
- Playwright: Tab 한 번으로 트리에 들어가 ArrowDown이 행을 옮기고, 다음 Tab이 트리를 벗어납니다. ⌘K로 그래프에 간 뒤 Tab이 본문에서 시작합니다.

## S29 작은 불일치 묶음
**묶음:** 일관성/안정성 · **우선순위:** 5 · **크기:** S · **의존:** 없음 · **divergent:** 예(5번만, `Sidebar.tsx:418-425`)

**목표.** 한 번씩 눈에 걸리는 표기 문제를 한 diff로 정리합니다.

**문제와 제안.** 각 줄이 하나의 수용 기준입니다.
1. 라이트 테마 Ask 답 안의 위키 링크가 rgb(0,0,238), 곧 브라우저 기본 파랑입니다(`audit-desktop/shots/flow/21-ask-attention-ko-light-1024.png`). 답은 `Viewer`로 그리는데(`src/pages/PageQuery.tsx:753`) 원인 CSS는 찾지 못했습니다. 노트 화면과 같은 링크 색 토큰이 걸리게 하십시오. 수용: 라이트 Ask 답 링크 색이 노트 링크 색과 같습니다.
2. 주간 막대의 요일 글자가 브라우저 로캘을 따라 "F S S M T W T"로 나옵니다(`src/components/VaultPulse.tsx:259`의 `Intl.DateTimeFormat(undefined, …)`). `useUIStore`의 `lang`을 넘기십시오. 수용: ko에서 "금 토 일 …".
3. 히스토리 실행 이름이 "digest-1755740000"이고 버튼 "WHY 리포트"와 설명 "WHY 보고서"가 다릅니다(`audit-desktop/shots/sweep/history-ko-light-1280.png`, `src/lib/i18n.ts:6227`, `:4906`). 실행 이름은 날짜와 종류로 그리고, 낱말을 하나로 맞추십시오. 출처 행의 날짜 원값 "chatgpt · 1700000000"(`src/components/SourcesPanel.tsx:91`)도 `Intl.DateTimeFormat`으로 그리십시오(실데이터에서도 그런지는 확인하지 못했습니다).
4. 페이지 머리 작은 글씨가 일정하지 않습니다. 그래프는 "더 보기", 자료 추가는 "워크스페이스", 나머지는 페이지 이름을 반복합니다(`audit-desktop/shots/sweep/graph-ko-light-1280.png`, `audit-desktop/shots/sweep/ingest-ko-light-1280.png`). 사이드바 그룹 이름 하나로 맞추십시오.
5. 사이드바 "기록상 사람만"은 툴팁이 없고 눌러도 트리에 변화가 없었습니다(`src/components/Sidebar.tsx:418-425`, `audit-desktop/shots/flow/05-human-only-ko-dark.png`). 툴팁과 켜진 상태 표시를 더하고, 변화가 없는 이유를 확인하십시오.
6. 슬래시 메뉴 27개 항목 오른쪽에 영어 별칭이 보이고, "오늘의 과거"와 "과거의 오늘 쿼리", "기록 찾기"와 "쿼리"를 이름만으로 구분하기 어렵습니다(`audit-desktop/shots/flow/32-slash-ko-dark-1280.png`). ko에서는 별칭을 검색에만 쓰고 표시하지 마십시오. 비슷한 두 쌍은 한 줄 설명을 붙이십시오.

---

# LLM 위키 고유 경험

## S30 기권 카드를 쉬운 말로, "적어 두기"를 주 버튼으로
**묶음:** LLM 위키 고유 경험 · **우선순위:** 1 · **크기:** S · **의존:** S5(출시됨), 홈 적기 경로 `ipc.captureNote`(출시됨) · **divergent:** 아니오

**목표.** "모르면 말하지 않는다"는 신뢰 장치가 오류가 아니라 다음 한 걸음으로 읽힙니다. 답을 지어내지 않는 원칙은 그대로입니다.

**문제와 근거.**
- 기권 카드 문구가 "이 질문에 답할 근거가 볼트에 없습니다.", "색인된 51쪽 중 관련도 바닥선 0.42을 넘은 구절이 없습니다", "기권도 답입니다 — 기록된 공백은 다음 수확이 채울 수 있습니다", 버튼 "이 질문을 수확 대상으로"입니다(`src/lib/i18n.ts:5885-5900`, `audit-desktop/shots/flow/21-ask-abstain-ko-dark-1280.png`).
- 근접 결과는 파일 stem, 경로, 막대, `0.400` 같은 숫자로 보입니다(`src/components/AbstainCard.tsx:55-96`). 375px에서는 112px 오브 옆 30px 제목이 2~3글자씩 끊깁니다(`shots-ai-mobile/05-ask-abstain.png`, `src/styles.css:12079-12111`).
- 사용자가 그 질문을 바로 적어 두는 길이 카드에 없습니다(AM M5).
- Spotlight 창도 같은 제목 키 `q_abstain_title`을 쓰고(`src/components/Spotlight.tsx:557`), 그 아래 "인용할 구절이 없습니다. 가장 가까웠던 노트는 myco의 질문 페이지에서 볼 수 있습니다."와 [질문 페이지에서 보기]를 둡니다(`src/lib/i18n.ts:6021-6022`, `audit-desktop/shots/aux/spotlight-offtopic-ko-dark.png`). 적어 두는 버튼은 여기에도 없습니다. Spotlight는 테마와 상관없이 어두운 카드로 그립니다(`src/components/Spotlight.tsx:15-18`, light와 dark 스크린샷이 같음).
- 다른 앱: Bond는 기억에 없을 때 "저장해 둘까요?"를 제안합니다([4b5284ea](https://mobbin.com/screens/4b5284ea-7e34-4b49-bb4d-ac4736afb9fd)). Monese는 이유, 해결, 주 버튼, "나중에" 순서로 보여 줍니다([41c7ac9f](https://mobbin.com/screens/41c7ac9f-3724-4534-8c06-bb9575312ae6)). 반면교사로 ClickUp은 "No updates in the last NaN days."를 그대로 보여 줍니다([06904e8e](https://mobbin.com/screens/06904e8e-9a1b-4ee8-98dd-3756f6927b9a)).

**제안.**
1. 제목을 "내 노트에서 이 내용을 찾지 못했어요", 부제를 "비슷한 노트는 있었지만 답이 될 만큼 가깝지 않았어요"로 바꾸십시오. 쪽수, 바닥선, 근접 결과 목록은 "자세히" 아래로 내리십시오.
2. 주 버튼 "이 질문을 오늘 노트에 적어 두기"는 홈 적기와 같은 `ipc.captureNote(line)`(`src/pages/PageOverview.tsx:332`, 데스크톱 `capture_note` 명령)에 `"질문: " + q`를 넘기고 S13의 열기 토스트를 띄우십시오. 질문 텍스트와 시각만 쓰고 답은 쓰지 않습니다.
3. 보조 버튼은 "범위 넓혀 다시 찾기"(지금의 `onWiden`), 세 번째 텍스트 버튼은 지금의 recall-miss를 "나중에 채울 질문으로 표시"로 바꾼 것입니다.
4. 좁은 폭(컨테이너 기준)에서는 오브를 숨기거나 48px로 줄이고 제목을 22px로 두십시오.

**수용 기준.**
- `?mock=1`(`__mycoMock.settings({query_provider:"builtin-local"})`)에서 엉뚱한 질문을 하면 새 제목이 보이고, "적어 두기"를 누르면 오늘의 노트에 `- HH:MM 질문: …`이 생깁니다.
- "자세히"를 펼치면 바닥선 숫자와 근접 결과가 보입니다. 375px에서 제목이 두 줄 이하입니다.
- `?mock=1&window=spotlight`에서 "주말 등산 코스 추천"(ko)과 "weekend hiking routes"(en)를 물으면 새 제목이 보입니다. 스크린샷을 찍어 눈으로 확인하십시오(`aux-windows.mjs`로 다시 찍을 수 있습니다). 지금 상태는 `audit-desktop/shots/aux/spotlight-offtopic-{ko,en}-dark.png`입니다.

## S31 인용 각주를 번호로 그리고 누르면 원문
**묶음:** LLM 위키 고유 경험 · **우선순위:** 4 · **크기:** M · **의존:** **소유자 결정. 출시된 블록 에디터 0단계의 Live 결정을 뒤집습니다**(아래 근거 첫 줄). one-editor 스펙 담당과도 맞춰야 합니다. 폰 시트는 S49 · **divergent:** 아니오

**목표.** LLM이 쓴 위키 페이지가 사람이 읽는 글처럼 보이고, 근거는 번호 하나를 눌러 확인합니다. 저장 형식은 바꾸지 않습니다.

**문제와 근거.**
- 0단계 결정과 회귀: 블록 에디터 로드맵 0단계는 각주를 두 곳에서 다르게 그리기로 했습니다. Preview는 위첨자 번호와 끝의 각주 목록으로 그리고(`docs/specs/2026-09-25-block-editor-roadmap.md:55-62`), Live는 "`[^id]` references get a small superscript chip style (text stays; no hiding)"로 원문을 남깁니다(`:63-64`). 번호 각주는 읽기 보기(Preview)가 맡았던 것입니다. one-editor 병합으로 읽기 보기가 `raw/` 전용이 되면서(`src/pages/PageReader.tsx:271-276`) 일반 노트에서 번호 각주가 사라졌습니다. 이 슬라이스는 그 회귀를 Live에서 메우는 것이고, "text stays; no hiding"을 뒤집는 결정이 먼저 필요합니다. one-editor 스펙의 Out of scope는 문단 안 표기(`**`, `[[`, `` ` ``)가 캐럿이 안에 있을 때 보이는 2026-09-25 결정을 유지한다고 적었고(`docs/specs/2026-10-01-notion-blocks-one-editor.md:146-147`), 각주는 이름으로 다루지 않습니다.
- Live 편집기는 `[^src-attention-is-all-you-need]`를 회색 칩으로 감싸기만 하고 라벨 원문을 그대로 보여 주며(`src/lib/editorLive.ts:267`의 `live-fnref`), 정의 줄도 흐린 원문으로 남깁니다(`src/lib/editorLive.ts:178`). 한 문단에 칩이 여러 번 줄을 바꿔 끼어듭니다(`audit-desktop/shots/flow/51-reader-info-ko-dark-1280.png`, `audit-desktop/shots/flow/140-narrow-reader-390.png`, `shots/m375-note.png`, `shots/06-ipad-portrait-768-note.png`).
- 보고서 넷(데스크톱 감사 순위 3, PA E 갭 1, WC 범위 밖 관찰, AM)이 따로 찾았습니다.
- 다른 앱: Copilot은 답 아래 "References 31"에 번호 칩과 출처 제목을 나란히 둡니다([ae62408b](https://mobbin.com/screens/ae62408b-0082-4e4b-a874-4eb1058be971)). Notion iOS 요약은 불릿 끝에 원 안의 작은 숫자를 답니다([91018867](https://mobbin.com/screens/91018867-e081-4c8f-b370-250159b7badc)). ChatGPT iOS는 출처를 아래 시트로 엽니다([3eaf4e44](https://mobbin.com/screens/3eaf4e44-fdce-48bc-965b-b194ed9c43ac)).

**제안.**
1. Live 장식에서 `[^src-*]` 참조를 처음 나온 순서의 위첨자 번호 위젯으로 바꾸십시오. 같은 라벨은 같은 번호입니다.
2. 번호에 포커스하거나 마우스를 올리면(데스크톱) 출처 이름과 인용 줄, [원문 열기]가 있는 팝오버를, 터치에서는 S49 시트를 여십시오. [원문 열기]는 S11의 `setPendingLine` 경로를 쓰십시오.
3. 정의 줄은 본문 끝 "출처" 목록 하나로 묶어 그리십시오.
4. 캐럿이 번호 안에 들어가면 원문 `[^src-…]`를 보이십시오. 다른 문단 안 표기와 같은 규칙입니다(`docs/specs/2026-10-01-notion-blocks-one-editor.md:146-147`).

**수용 기준.**
- vitest: 참조 두 개는 1, 2로, 같은 라벨 두 번은 같은 번호로 장식됩니다.
- `?mock=1` `attention-mechanism`을 Live로 열면 `[^src-`가 화면에 없고, 번호를 누르면 출처가 보입니다.
- 노트를 열고 저장해도 파일 바이트가 그대로입니다(round-trip).

## S32 Ask: 입력창은 아래, 답은 첫 구절 먼저
**묶음:** LLM 위키 고유 경험 · **우선순위:** 5 · **크기:** M · **의존:** 없음(도움말 버튼 정리는 S48과 같은 diff가 편합니다) · **divergent:** 아니오

**목표.** 답을 다 읽은 자리에서 다음 질문을 하고, 답 하나가 한두 화면 안에 들어옵니다. 원문 그대로 인용하는 원칙은 지키고 요약하지 않고 접기만 합니다.

**문제와 근거.**
- 1280에서 답 하나가 약 2,950px입니다. 큰 세리프로 원문 단락 5개, 출처 12개, "참조된 소스 · 13", 미니 그래프가 붙고 "검색 세부정보"가 두 번 나옵니다(`audit-desktop/shots/flow/21b-ask-attention-full-ko-dark-1280.png`). 입력창이 위라 후속 질문이 아래에 쌓입니다(`audit-desktop/shots/flow/23-ask-followup-ko-dark-1280.png`).
- 375px에서는 문서 높이가 5,199px이고 입력창은 y=198, 출처 레일은 y=3,018부터 1,870px입니다(`measure-ask.mjs`, `shots-ai-mobile/03-ask-answer-top.png`, `shots-ai-mobile/04-ask-answer-scrolled.png`). 본문은 22px serif, 줄간격 1.7이고(`src/styles.css:11500-11505`), 최대 5쪽을 인용합니다(`src/pages/PageQuery.tsx:66` `QUOTED_PAGES = 5`).
- 도움말 버튼(34×34)이 모든 화면 오른쪽 아래에서 본문과 겹칩니다(`src/styles.css:8248-8257`).
- 2026-09-26 mobbin-ai-answers §1과 mobbin-notion #3이 아래 입력창을 제안했지만 코드에 없습니다(AM 머리말).
- 다른 앱: ChatGPT·Claude iOS는 입력창을 바닥에 고정합니다([8cf567ec](https://mobbin.com/screens/8cf567ec-633b-4d0b-81b8-4e05de5fdb9c), [7f9374bd](https://mobbin.com/screens/7f9374bd-79d3-4552-9fe0-bd26e76c94f9)). ChatGPT와 Perplexity는 부가 정보를 "Read SKILL.md ›", "2 steps completed ›" 한 줄로 접고 ↓ 버튼을 띄웁니다([0c55f827](https://mobbin.com/screens/0c55f827-6928-446b-93f5-41c38ea8fee0), [b7355c29](https://mobbin.com/screens/b7355c29-b0a6-40f7-b41e-cba3c173428a)).

**제안.**
1. `.ask-composer`를 턴 목록 아래로 옮기고, 좁은 컨테이너(이미 쓰는 container query 패턴, `src/styles.css:1911`)에서는 `position: sticky; bottom: 0`과 `padding-bottom: env(safe-area-inset-bottom)`을 주십시오.
2. 첫 턴이 생기면 페이지 머리(eyebrow, 제목, 리드)를 접으십시오.
3. 1번 구절은 전부 보이고, 2–5번 구절은 3줄로 잘라 "구절 더 보기(4)"로 두십시오. 접힌 구절 머리에 노트 제목과 번호를 남기십시오. 좁은 폭에서 본문은 17–18px로 낮추십시오.
4. "검색 세부정보"는 한 번만 보이고, 답이 화면보다 길면 입력창으로 가는 ↓ 버튼을 띄우십시오.
5. 좁은 폭의 Ask에서는 도움말 버튼을 숨기십시오.

**수용 기준.**
- Playwright 375: 답을 받은 뒤 스크롤하지 않고 입력창이 보이고, 문서 높이가 접힌 상태에서 2화면 이하입니다.
- 펼친 구절의 텍스트가 원본 노트의 해당 구절과 문자열로 같습니다.
- 1280: 입력창이 답 아래에 있고 후속 질문 흐름(`src/stores/queryStore.ts:207-212`)이 그대로 동작합니다.

**375 높이 기록(2026-10-03).** 데스크톱 부분을 마친 뒤 375×812 mock(`?mock=1`, 질문 "what is attention?", 구절 접힘)에서 재면 입력창은 스크롤 없이 보이지만 문서 높이는 2,437px이고 한도는 1,624px(2화면)입니다. 접기 전에는 5,251px였습니다. 턴 1,999px 가운데 답이 1,033px(1번 구절 전부 362px, 접힌 구절 넷이 각 116px), 답 아래로 쌓인 출처 레일이 648px, 미니 그래프가 175px입니다. 이 기준은 `mobile-strategy.md`의 "S32·S33의 폰 부분"(2단계, S49 뒤)에 속하므로 데스크톱 부분만으로 충족했다고 보지 않습니다. 좁은 폭에서 레일을 "출처 N개" 칩 하나로 줄이고(S33 제안 2, S49 시트) 미니 그래프를 접고 마우스용 안내 문장을 숨기는 세 가지를 스타일 주입으로 어림하면 1,659px로 여전히 한도를 넘고, 칩만 쓰면 1,841px입니다. mock 구절은 짧아서 실제 볼트에서는 더 깁니다. 1번 구절을 전부 보이는 설계(제안 3)와 2화면 기준이 부딪치므로, 폰 부분을 시작하기 전에 기준을 고칠지 1번 구절도 접을지 정하십시오.

## S33 Ask: 출처는 시트로, 범위는 사람 말로
**묶음:** LLM 위키 고유 경험 · **우선순위:** 6 · **크기:** M · **의존:** S49(시트). 데스크톱 부분은 먼저 할 수 있습니다 · **divergent:** 아니오

**목표.** 손가락으로 출처를 확인해도 읽던 자리를 잃지 않고, 검색 범위를 사람이 아는 말로 고릅니다.

**문제와 근거.**
- 인용 번호 pill은 24×21px이고 탭하면 곧바로 노트로 이동합니다. pill과 레일 행을 잇는 강조와 행 툴팁은 hover/focus에만 걸려 있습니다(`src/pages/PageQuery.tsx:730-735`, `:764-776`, `src/components/SourceLadder.tsx:191`, `:193-196`).
- 범위 라벨이 "위키 / 세션 / 전체"이고 설명은 화면 밖 sr 문단에 있으며 "설정 › 시맨틱 검색에서 켜면…"을 씁니다(`src/lib/i18n.ts:5838-5842`, `src/pages/PageQuery.tsx:333-355`).
- 다른 앱: ChatGPT iOS는 출처를 아래 시트로, 긴 답은 "Citations · 23"으로 묶어 보여 줍니다([3eaf4e44](https://mobbin.com/screens/3eaf4e44-fdce-48bc-965b-b194ed9c43ac), [57a5fc2b](https://mobbin.com/screens/57a5fc2b-4f37-4b1b-9006-579e4a3df0c7)). Perplexity iOS는 "10 sources" 칩과 번호 목록 시트를 씁니다([fe1aa2bb](https://mobbin.com/screens/fe1aa2bb-e46b-45b2-ac6f-e2cb4916cbf1), [95249214](https://mobbin.com/screens/95249214-093e-4d7a-afc1-6bbb951ea9ff)). Gemini iOS는 출처 선택을 체크 시트로 합니다([d6bb7092](https://mobbin.com/screens/d6bb7092-79e2-4627-bc41-9e35b3061620)).

**제안.**
1. 터치(`any-pointer: coarse`)나 좁은 컨테이너에서 pill 탭은 시트를 여십시오: 노트 제목, 폴더, tier 칩, 그 구절, [노트 열기](지금의 `onOpenPage(r.page, passage)`), [노트에 인용](`onQuote`).
2. 답 아래 "출처 N개" 칩 하나가 SourceLadder 전체를 시트로 엽니다. 데스크톱에서는 SourceLadder를 상위 3개만 펼치십시오.
3. 범위 세그먼트를 입력창 안 칩 "범위 · 내 노트 ▾"로 줄이고, 누르면 "내 노트(정리된 노트·맵)", "대화 기록", "둘 다"를 한 줄 설명과 함께 보이십시오. 기본값을 맨 위에 둡니다. `AskScope` 데이터 모델은 그대로 둡니다.

**수용 기준.**
- 터치 에뮬레이션에서 ①을 탭하면 시트가 열리고 라우트는 그대로입니다. [노트 열기]는 S11처럼 그 구절로 갑니다.
- 1280 마우스에서 hover 강조가 그대로 동작합니다. 범위 칩으로 범위를 바꾸면 다음 질문의 범위 칩이 바뀝니다.

## S34 복습: 하나의 큐, 두 버튼, 다음 복습일
**묶음:** LLM 위키 고유 경험 · **우선순위:** 3 · **크기:** M · **의존:** 없음 · **divergent:** 아니오

**목표.** 홈에 적힌 숫자만큼 복습하고, "기억나나"만 고르며, 끝나면 다음이 언제인지 압니다.

**문제와 근거.**
- 홈 문구는 모든 덱의 기한 카드 합계를 세는데(`src/components/MorningBand.tsx:347-354`, `src/lib/i18n.ts:6213`), "복습 시작"은 `studyDecks.find((d) => d.due > 0)` 한 덱만 엽니다(`src/components/MorningBand.tsx:192`, `:198-201`). 덱은 노트마다 하나라서(`docs/specs/2026-09-29-study-from-the-wiki.md:46`) "12장"이라고 보이고 3장만 복습하고 끝날 수 있습니다(PA D 갭 1).
- 학습 페이지에도 전체 복습 버튼이 없습니다(`src/pages/PageStudy.tsx:149-185`).
- 채점 버튼이 "다시 / 어려움 / 좋음 / 쉬움" 넷이고 다음 간격이 없습니다(`src/pages/PageStudy.tsx:341-352`, `audit-desktop/shots/flow/84-study-revealed-ko-dark-1280.png`). 끝 화면에 다음 복습일이 없습니다(`src/pages/PageStudy.tsx:390-409`).
- 키 처리기가 없어 Space나 숫자 키로 넘길 수 없고 정답 보기 뒤 포커스가 BODY에 남습니다(`audit-desktop/flow9-ko.log`, `audit-desktop/flow10-ko.log`).
- 덱 저장 실패를 `catch {}`로 삼킵니다(`src/pages/PageStudy.tsx:300-304`).
- 설명이 "간격 반복 플래시카드", "근거 없는 카드 3장"입니다(`src/lib/i18n.ts:5359`, `:5384`).
- 다른 앱: Headway는 "Repeat 3 cards" 버튼 하나, Yes/No 두 버튼, 끝난 뒤 "Next repetition in 1 day"를 보여 줍니다([3d987534](https://mobbin.com/flows/3d987534-1fb1-4502-872e-49e765b79e85), [e109ca23](https://mobbin.com/screens/e109ca23-95a1-4edd-94d8-704a97ad043b)). Quizlet은 좌우로 밀어 채점합니다([5dacac8f](https://mobbin.com/screens/5dacac8f-b958-417c-bae8-e70c4ac3273f)).

**제안.**
1. 덱 경계 없는 "오늘 복습" 큐를 만들어 홈 버튼과 학습 페이지 상단이 같이 쓰게 하십시오(`dueCards`, `useStudyStore.dueTotal` 재사용). 카드 출처는 각 카드의 `sourceRef`로 계속 보입니다.
2. 기본 채점을 [기억 안 남](FSRS Again)과 [기억남](Good) 두 개로 하고, 네 단계는 설정 "세밀하게 평가"로 남기십시오. 버튼 아래에 다음 간격("10분", "4일")을 `lib/fsrs.ts`로 계산해 적으십시오.
3. 끝 화면에 "다음 복습: 내일 3장"을 보이십시오.
4. Space로 정답 보기, 1/2(세밀 모드는 1–4)로 채점하고, 정답 보기 뒤 포커스를 [기억남]에 두십시오.
5. 저장 실패는 `notice.warn`으로 알리고, 설명을 "읽은 노트에서 문장을 골라 카드로 만들고, 잊을 때쯤 다시 보여 줘요"로 바꾸십시오.

**수용 기준.**
- vitest: 큐가 여러 덱의 기한 카드를 기한 순으로 합칩니다. 두 버튼이 FSRS 등급으로 바뀝니다. 다음 간격 라벨이 계산됩니다.
- `?mock=1` 홈 "복습 시작"으로 시작한 세션의 카드 수가 홈 숫자와 같습니다. Space와 숫자 키가 동작합니다.
- 저장 IPC를 실패시키면 경고 토스트가 뜹니다.

## S35 자료 추가: 짧은 메모 받기, 기다리는 동안 멈춘 시계, 입력원 먼저
**묶음:** LLM 위키 고유 경험 · **우선순위:** 7 · **크기:** M · **의존:** S12(출시됨, 타이머 설계를 바꿉니다) · **divergent:** 아니오

**목표.** 짧은 메모가 거절이 아니라 노트로 가고, 사용자가 고를 차례에는 앱이 기다리는 것처럼 보이며, 폰과 마우스 없는 기기에서도 넣는 방법이 먼저 보입니다.

**문제와 근거.** (데스크톱 감사 순위 11)
- "짧은 메모"(13바이트)를 넣으면 "내용이 없어 저장하지 않았습니다 · 13 B < 200 B"가 나옵니다. 내용은 있었고 짧았을 뿐입니다(`audit-desktop/shots/flow/94-ingest-short-ko-dark-1280.png`, `src/lib/i18n.ts:5719`).
- 계획 검토 단계에서 붙여 넣은 원문이 사라지고 경과 시간이 0:01에서 0:15로 계속 오르며 계획 제목 옆에 로딩 아이콘이 붙습니다(`audit-desktop/shots/flow/91-ingest-run-0-ko-dark-1280.png`, `audit-desktop/shots/flow/92-ingest-later-ko-dark-1280.png`). S12는 `running`이 타이머를 계속 돌리게 두었는데, 이번 감사에서 이것이 로딩처럼 읽혔습니다.
- "3개만 적용"과 "이 계획대로 전부"의 차이 설명이 없고(`src/lib/i18n.ts:4564-4565`), 대기 상태 버튼에 반짝이 아이콘이 붙습니다(`src/pages/PageIngest.tsx:503`).
- "다른 곳에서 가져오기"가 "세션 스윕, MCP 도구, _inbox 대기열, 세션 백필 · 모델 호출 ≈ 20회"를 보여 줍니다(`audit-desktop/shots/flow/93-ingest-more-full-ko-dark-1280.png`).
- 터치 기기에서도 첫 문장이 "여기에 파일 드롭"입니다(`src/lib/i18n.ts:4517`, `shots/m375-ingest.png`, `shots/08-phone-375-ingest.png`).
- 다른 앱: Delphi "Add Knowledge"는 File, Quick Note, URL 등을 한 시트에 두고 "Added to your mind" 토스트를 띄웁니다([61a2b2c5](https://mobbin.com/screens/61a2b2c5-7b3f-4e44-bba1-042e8fd950cd)). Claude iOS는 Camera / Photos / Files 큰 타일 세 개를 둡니다([58bcab7a](https://mobbin.com/screens/58bcab7a-f050-487f-bba8-d129de43cce3)). Notion iOS는 사진, 촬영, 문서 스캔, 파일 선택을 한 시트에 둡니다([3601882d](https://mobbin.com/screens/3601882d-0003-4794-bd98-d9eb9ccf2234)).

**제안.**
1. 바닥선보다 짧은 입력은 거절 대신 "짧은 메모는 노트로 바로 저장할 수 있어요"와 [오늘의 노트에 적기](`ipc.captureNote`), [새 노트로 저장]을 보이십시오.
2. `stage === "plan-gate"` 동안 경과 시계를 멈추고 "선택을 기다리는 중"으로 쓰십시오. 취소 버튼은 그대로 켜 두고, 원문은 접힌 상태로 남기십시오.
3. 적용 버튼을 "고른 3개만 적용"과 "전부 적용(5개)"로 쓰고, 대기 버튼의 반짝이 아이콘을 빼십시오.
4. 개발자용 채널(세션 스윕, MCP, 백필)은 "고급" 접힘 안으로 옮기십시오.
5. `(pointer: coarse)`에서는 첫 문장을 "파일 고르기"로 바꾸고 타일(사진·카메라 / 파일 / 링크 붙여넣기 / 글 붙여넣기)을 먼저 보이십시오.

**수용 기준.**
- `ingestStore.test.ts`: plan-gate 동안 경과 시간이 늘지 않습니다.
- `?mock=1`에서 13바이트를 넣으면 저장 버튼 두 개가 있는 카드가 나오고, [오늘의 노트에 적기]가 오늘의 노트에 줄을 씁니다.
- 터치 에뮬레이션에서 "여기에 파일 드롭"이 보이지 않습니다.

## S36 질문 기록, 다시 시도, 멈추기
**묶음:** LLM 위키 고유 경험 · **우선순위:** 2 · **크기:** M · **의존:** 없음 · **divergent:** 아니오

**목표.** 앱을 다시 켜도 아까 물어본 것을 찾고, 실패한 질문은 그 자리에서 다시 보내며, 오래 걸리는 답은 멈춥니다.

**문제와 근거.**
- 질문 기록은 메모리에만 있어 앱을 다시 켜거나 `clear()`하면 사라집니다(`src/stores/queryStore.ts:185-190`, `:382`).
- 오류 턴은 빨간 글자 한 줄뿐이고 다시 시도 버튼이 없습니다(`src/pages/PageQuery.tsx:572-574`).
- 전송 중 버튼은 "…"로만 바뀌고 멈출 수 없습니다(`src/pages/PageQuery.tsx:325-331`). `queryStore.ts`에 AbortController가 없고 `src/stores/agentStore.ts:79`, `:112`에만 있습니다.
- 2026-09-26 mobbin-ai-answers §4(기록)와 §5(중단)가 반영되지 않았습니다(AM 머리말).
- 다른 앱: ChatGPT iOS는 Recents 목록, 바닥 검색, 빈 상태 문구를 둡니다([ab1d0c55](https://mobbin.com/screens/ab1d0c55-4180-4ad4-b9b6-5a21242092f1), [2db4384c](https://mobbin.com/screens/2db4384c-4fd7-4b23-8612-251c6b59a99e), [9cacfecd](https://mobbin.com/screens/9cacfecd-ef8a-4feb-9327-2dc5b8642ad2)). Alan은 턴 안에 Retry 카드를 넣습니다([d2fd4e09](https://mobbin.com/screens/d2fd4e09-8370-44f4-837c-108b9380edae)). ChatGPT는 실행 중 ■ 버튼과 "Research stopped" 카드를 씁니다([1e0d754c](https://mobbin.com/screens/1e0d754c-569d-4767-89b7-36bf956dc8b7), [2add2805](https://mobbin.com/screens/2add2805-fa2c-406b-bc82-fb3d6682d926)).

**제안.**
1. 턴을 볼트별 append-only 로그로 저장하십시오. 위치는 볼트 밖 앱 데이터 디렉터리로 두기를 권합니다. 기기마다 따로 남고, 동기화 충돌과 `raw/` 규칙에 닿지 않습니다(추론). 볼트 안에 둘지는 소유자 결정입니다.
2. 질문 탭 상단 "기록" 목록(질문, 상대 시간, 인용 노트 수, 기권 여부)과 검색을 두십시오.
3. 오류 턴에 [다시 시도](같은 질문, 같은 범위)를 두십시오.
4. provider와 Ollama 경로에 `agentStore`의 AbortController 패턴으로 ■ 멈춤을 넣고, 멈춘 턴은 "멈춤" 카드로 남기십시오. 추출형 경로는 IPC 한 번이라 멈춤이 필요 없습니다.

**수용 기준.**
- `queryStore.test.ts`: 저장소를 다시 만들어도 턴이 복원됩니다. 다시 시도가 같은 범위로 묻습니다. abort 뒤 턴 상태가 "멈춤"입니다.
- `?mock=1` 새로고침 뒤에도 기록 목록에 이전 질문이 있습니다.

## S37 이 노트에 묻기
**묶음:** LLM 위키 고유 경험 · **우선순위:** 8 · **크기:** M · **의존:** 검색 쪽 경로 필터(Rust, 이번에 읽지 않음) · **divergent:** 아니오

**목표.** 읽던 노트와 그 이웃만 놓고 질문합니다. 추출형과 기권 규칙은 그대로입니다.

**문제와 근거.**
- 질문 범위가 위키 / 세션 / 전체뿐이고 "이 노트에 대해"가 없습니다(`src/pages/PageQuery.tsx:333-347`). 2026-09-26 mobbin-reflect-mem-heptabase #18이 제안했지만 S1–S12에 없습니다(PA E 갭 3).
- 다른 앱: Granola는 노트 하단에 "Chat with note" 버튼을 두고, 그 노트로 범위가 정해진 채팅을 엽니다([6c2cfb1b](https://mobbin.com/screens/6c2cfb1b-3b86-4a51-90fd-c9f215b20d86), [70b3a6e2](https://mobbin.com/flows/70b3a6e2-0eac-43f9-a2a0-e24b0b45d7ee)).

**제안.** 노트 ··· 메뉴(폰에서는 노트 하단)에 "이 노트에 묻기"를 두고, 범위를 그 노트와 1단계 링크 이웃으로 정한 Ask를 여십시오. 입력창 범위 칩에 노트 제목을 보이십시오. 검색 쪽에 경로 집합 필터가 필요합니다.

**수용 기준.**
- 검색 테스트: 경로 필터를 주면 그 밖의 노트 구절은 결과에 없습니다.
- `?mock=1`에서 노트 ··· "이 노트에 묻기"를 누르면 Ask 범위 칩이 노트 제목을 보여 줍니다.

## S38 일반 웹 링크 가져오기
**묶음:** LLM 위키 고유 경험 · **우선순위:** 9 · **크기:** M · **의존:** 보안 검토(SSRF) · **divergent:** 아니오

**목표.** 기사 링크를 붙여 넣으면 YouTube처럼 글을 가져옵니다. 브라우저 확장이 없는 사람도, 나중의 폰 공유 확장도 같은 길을 씁니다.

**문제와 근거.**
- 붙여넣기 칸은 YouTube 링크일 때만 "가져오기" 버튼을 띄웁니다(`src/pages/PageIngest.tsx:468-477`, 판별 `:1171-1175`). 일반 URL을 가져오는 IPC는 찾지 못했습니다(PA, `fetch_url|fetchArticle|readability|web_fetch` grep 0건). 웹 기사는 데스크톱 브라우저 확장이나 북마클릿으로만 들어옵니다(`clipper/README.md:25-27`, `:37`, `:47`).
- 다른 앱: NotebookLM은 링크 대화상자에서 "보이는 글만 가져옴, 유료 기사 불가, 실패하면 이유 보기"를 미리 말합니다([7b363f63](https://mobbin.com/screens/7b363f63-caa2-4688-93ed-d72e19d9ae30)).

**제안.**
1. Rust에 URL 가져오기 명령을 더하고 SSRF 방어를 넣으십시오: http/https만, 주소를 풀어 loopback·사설·link-local IP 차단, 리다이렉트마다 다시 검사, 크기와 시간 제한.
2. 본문 추출 방법은 의존성 검토 뒤 정하십시오(큰 라이브러리를 더하기 전에 크기와 유지보수를 확인).
3. 결과는 기존 ingest로 넘기고, 원문 보관은 지금의 `raw/` 규칙을 그대로 따르십시오. 화면에는 규칙 세 줄을 보이십시오.

**수용 기준.**
- `cargo test`: `file://`, `http://127.0.0.1`, `http://10.0.0.1`, `169.254.169.254`로 리다이렉트하는 응답을 모두 거절합니다.
- `?mock=1`에서 일반 URL을 붙여 넣으면 "가져오기" 버튼과 규칙 세 줄이 보입니다.

## S39 캡처 영수증 통일과 클리퍼 메모 한 줄
**묶음:** LLM 위키 고유 경험 · **우선순위:** 10 · **크기:** M · **의존:** S13(영수증 문구) · **divergent:** 아니오

**목표.** 어디로 넣든 "어디에 들어갔고, 다음에 무슨 일이 일어나며, 어떻게 여는지"가 같은 모양으로 보이고, 링크와 함께 왜 저장했는지 한 줄을 남깁니다.

**문제와 근거.**
- Spotlight 음성 저장 칩은 "{rel} — 다음 자료 추가 때 함께 처리됩니다"로 경로만 보이고 받아 적은 내용은 보이지 않습니다(`src/lib/i18n.ts:6028`, `src/components/Spotlight.tsx:421-427`).
- 노치 빠른 기록은 저장 뒤 "저장했습니다"와 경로 `daily/2026-08-25.md`만 보이고 여는 동작이 없습니다(`audit-desktop/shots/aux/notch-f7-ko-dark.png`). 같은 노치의 자료 추가 완료 화면에는 "⏎ 열기"가 있습니다(`audit-desktop/shots/aux/notch-f5-ko-dark.png`). 노치 기록 칸의 안내는 "⏎ 데일리 노트"인데(`src/lib/i18n.ts:6257`, `audit-desktop/shots/aux/notch-f6-ko-dark.png`) 사이드바와 홈은 "오늘의 노트"를 씁니다(`src/lib/i18n.ts:5908`, `:6219`). 노치 첫 줄 "떨구거나, 클릭해서 노트 쓰기"(`src/lib/i18n.ts:6244`)는 좁은 칸에서 "떨구거나, 클릭해서 노트 …"로 잘립니다(`audit-desktop/shots/aux/notch-f1-ko-dark.png`).
- 웹 클리퍼는 `url`, `title`, `selection`만 보냅니다(`clipper/background.js:9-14`).
- 다른 앱: Fabric 링크 시트는 "Say something about it… (optional)"과 목적지 칩을 둡니다([dfbd43eb](https://mobbin.com/screens/dfbd43eb-2e0d-482c-8924-72e57d939a9f)). Fabric 음성 노트는 녹음 중 받아 적은 글을 바로 보여 줍니다([3c069b65](https://mobbin.com/flows/3c069b65-da04-47ec-a852-5165ac63562b)). Craft는 모드마다 목적지 칩을 보여 줍니다([60b123cd](https://mobbin.com/screens/60b123cd-6636-4286-8f12-2958e6dc0f13)).

**제안.**
1. 홈 적기, Spotlight 음성, 노치 빠른 기록, 클립의 영수증을 하나의 문구 틀(어디에 · 다음에 · 열기)로 맞추십시오. 노치의 "데일리 노트"는 "오늘의 노트"로 바꾸고, 첫 줄은 잘리지 않는 짧은 문장("놓거나 눌러서 적기")으로 바꾸십시오.
2. 음성 칩에 받아 적은 첫 줄을 덧붙이십시오.
3. 클리퍼 팝업에 선택 입력 한 줄을 두고 `note=` 파라미터로 보내, 앱이 클립 본문 앞에 "> 내 메모: …"로 넣게 하십시오(`clip.rs` 수정 필요). 이 줄이 폰 공유 확장의 메모 칸과 같은 계약이 됩니다.

**수용 기준.** 네 경로의 영수증이 같은 틀이고 모두 열기 동작이 있습니다. Spotlight와 노치는 `?mock=1&window=spotlight`, `?mock=1&window=notch&notchMock=1&notchFrame=7`을 ko·en으로 찍어 눈으로 확인하십시오(`aux-windows.mjs`). `note=`가 있는 딥링크로 만든 `_inbox/` 파일 첫 줄이 "> 내 메모:"입니다.

## S40 홈 타임라인의 "오늘 생긴 연결"
**묶음:** LLM 위키 고유 경험 · **우선순위:** 11 · **크기:** M · **의존:** S7 타임라인(출시됨) · **divergent:** 아니오

**목표.** 링크를 따로 걸지 않았어도 내 기록이 이어지고 있다는 것이 하루 단위로 보입니다. 모델을 쓰지 않습니다.

**문제와 근거.**
- 홈 일간 타임라인에 그날 생긴 연결이 없습니다(PA F).
- `src/lib/digests.ts`는 생성형 프롬프트를 쓰는데(`:9-12`) `runDigest`(`:77`)를 부르는 곳이 정의 파일과 테스트뿐입니다. 데드 코드로 보고만 하고 삭제는 소유자 판단에 맡깁니다.
- 다른 앱: Dot은 하루 카드 안에 주제를 밑줄 링크로 넣고 "Chronicles are updated every night"로 갱신 시점을 밝힙니다([29acf4e2](https://mobbin.com/screens/29acf4e2-acbe-4aa0-9bef-2d4b44ac17a0)). 반면교사로 Fabric 하루 요약은 "likely saved to support your personal projects"처럼 추측을 섞습니다([b0de8bea](https://mobbin.com/screens/b0de8bea-341f-4846-b4d8-bc73e87331f6)).

**제안.** 날짜마다 그날 저장된 파일에서 새 `[[링크]]` 쌍과 새 인용 수를 세어 "transformer-architecture와 attention-mechanism이 이어졌어요 · 새 인용 3개" 한 줄로 보이십시오. 노트 이름은 밑줄 링크이고, "노트 저장 때 갱신"이라고 적으십시오. 생성 요약은 넣지 마십시오.

**수용 기준.** vitest: 전날과 오늘 링크 집합의 차이로 새 쌍을 셉니다. `?mock=1` 타임라인에 연결 줄이 보입니다.

## S41 마크다운 원문 하이라이트에서 인용 한 줄로
**묶음:** LLM 위키 고유 경험 · **우선순위:** 12 · **크기:** L · **의존:** 2026-09-29 study 스펙 Part 1(인용 문장에서 cloze 생성) · **divergent:** 아니오

**목표.** 원문을 읽다 밑줄을 그으면 그 문장이 출처가 달린 한 줄로 노트에 들어가고, 곧 복습 카드 재료가 됩니다.

**문제와 근거.**
- 하이라이트 sidecar는 PDF 원문 전용이고 페이지 번호와 사각형 좌표를 씁니다(`src/lib/annotations.ts:1-5`). 클리퍼로 들어온 마크다운 원문에 대한 하이라이트 경로는 찾지 못했습니다(PA C).
- 다른 앱: Matter는 문장을 고르면 떠 있는 바에서 형광펜을 칠하고, 하이라이트를 눌러 메모를 남기며, Notebook에 모읍니다([134cfe08](https://mobbin.com/flows/134cfe08-4be1-4b53-8e66-804abcc94095), [a036686e](https://mobbin.com/flows/a036686e-02ed-48e5-b8c3-b2a745b2470a), [01f20888](https://mobbin.com/screens/01f20888-4bcf-41dc-ab36-6785fd0b91fb)).

**제안.** 마크다운 원문에도 텍스트 앵커 sidecar(`wiki/.annotations/`)를 쓰고 `raw/`는 건드리지 마십시오. 하이라이트 메뉴는 [노트로 옮기기] 하나로 시작하고, 선택 문장을 `[^src-*]` 인용이 달린 한 줄로 오늘 노트에 붙이십시오.

**수용 기준.** `raw/` 파일 바이트가 하이라이트 전후로 같습니다. 옮긴 줄이 extractive cloze 생성기의 입력으로 카드가 됩니다.

---

# 데스크톱 레이아웃

## S42 분할 보기: 좁은 칸에서 읽히는 기본값
**묶음:** 데스크톱 레이아웃 · **우선순위:** 1 · **크기:** M · **의존:** 없음 · **divergent:** 예(그래프 레일 접기가 `PageGraph.tsx`에 닿으면)

**목표.** 분할 버튼을 눌러도 두 칸 모두 읽힙니다.

**문제와 근거.** (데스크톱 감사 순위 7)
- 분할 버튼은 지금 화면이 그래프가 아니면 오른쪽에 그래프를 엽니다(`src/components/Topbar.tsx:100`). 1280×900에서 레일이 그대로 들어가 캔버스가 약 30px로 줄고 "별자리를 정렬하는 중…"이 한 글자씩 세로로 찍힙니다(`audit-desktop/shots/flow/117-split-ko-dark-1280.png`). 1024×700에서는 레일이 20px 남짓으로 잘립니다(`audit-desktop/shots/flow/117-split-ko-light-1024.png`).
- 폰 폭에서도 분할 버튼이 나오고 383px 패널 두 개가 위아래로 쌓입니다(`audit-mobile/shots/i/375-split.png`, `src/App.tsx:117`).
- 다른 앱: Obsidian iOS는 폰에서 분할 대신 탭으로 여러 문서를 오갑니다([bf5ae304](https://mobbin.com/screens/bf5ae304-2dc0-41b4-b5dc-156ecb889a7a)).

**제안.**
1. 칸 너비가 기준보다 좁으면(container query) 그래프 레일을 기본으로 접고 캔버스만 보이십시오.
2. 분할 기본 화면을 그래프 대신 "지금 노트의 연결" 또는 "최근 노트"로 바꾸십시오.
3. 폰 셸 폭(≤768px, 아래 "모바일 준비" 머리의 폭 규칙)에서는 분할 버튼을 숨기십시오. 769–1023px(iPad 세로 820·834px 포함)은 데스크톱 레이아웃이므로 분할 버튼을 남기되, 1번의 container query가 좁은 칸을 맡습니다.

**수용 기준.** 1280 분할에서 그래프 캔버스가 칸 폭의 절반 이상이고 세로로 찍힌 글자가 없습니다. 375에서 분할 버튼이 없고, 820에서는 있으며 분할해도 세로로 찍힌 글자가 없습니다.

## S43 사이드바 고정 영역 줄이기
**묶음:** 데스크톱 레이아웃 · **우선순위:** 2 · **크기:** S · **의존:** 폰 서랍의 워크스페이스 행 이동은 S50 · **divergent:** 예(`Sidebar.tsx`)

**목표.** 1024×700 노트북과 폰 서랍에서도 노트 트리가 보입니다.

**문제와 근거.**
- 1024×700에서 고정된 메뉴와 상태 영역 때문에 트리가 2~3줄만 보입니다(`audit-desktop/shots/sweep/overview-ko-dark-1024.png`, `audit-desktop/shots/sweep/settings-en-dark-1024.png`).
- 폰 서랍은 664px 중 343px가 고정이고 목록 창은 321px입니다(`measure-drawer.mjs`, `shots/oxn/03-drawer.png`). 재인덱스 경고 카드가 들어가면 상태 영역이 131px입니다(`src/components/StatusStrip.tsx:133`). "고장 시뮬레이션" 110×28, "지금 재인덱스" 72×18도 작습니다(폰 감사 M-13).
- 다른 앱: Obsidian iOS 서랍의 고정 영역은 하단 한 줄과 볼트 이름 한 줄뿐입니다([4fb0ebc3](https://mobbin.com/screens/4fb0ebc3-a523-460a-af5d-713685a9b939), [b932b2a2](https://mobbin.com/screens/b932b2a2-f404-45ae-a0d1-1b3aab5bed62)).

**제안.** 볼트 상태를 한 줄 요약("노트 71개 · ⚠ 6")으로 접고 누르면 펼치십시오. 설정은 사이드바 머리의 톱니로 옮기고, 워크스페이스 그룹은 접을 수 있게 하고 상태를 기억하십시오.

**수용 기준.** 1024×700에서 트리가 8행 이상 보입니다. 375 서랍에서 목록 영역이 서랍 높이의 절반 이상입니다.

## S44 그래프의 틀: 보기 위치, 툴바, 팁, 키보드
**묶음:** 데스크톱 레이아웃 · **우선순위:** 3 · **크기:** M · **의존:** 없음. 룩 렌더링은 woven 스펙 범위라서 다루지 않습니다 · **divergent:** 예(`PageGraph.tsx`)

**목표.** "그래프에서 보기"가 그 노트와 이웃을 한눈에 보여 주고, 툴바와 팁이 화면을 가리지 않으며, 키보드로 캔버스에 닿습니다.

**문제와 근거.** (데스크톱 감사 순위 14)
- "그래프에서 보기"를 누르면 2~6초 동안 "노트를 하나 고르세요"가 보이고, 그 뒤 카메라가 노드에 너무 붙어 이웃이 보이지 않습니다(`audit-desktop/shots/flow/54-open-in-graph-ko-dark-1280.png`, `audit-desktop/shots/flow/65-open-in-graph-12000-ko-dark-1280.png`).
- 툴바는 이름 없는 아이콘 8개입니다(`audit-desktop/flow7-ko.log`, `src/lib/i18n.ts:4791-4792`). 노드를 누르면 "MYCO 팁"이 인스펙터 기본 버튼을 덮고, 갭 레일 행 버튼이 노트 이름을 "2026-…"로 잘라 먹습니다(`audit-desktop/shots/flow/74-graph-click-ko-dark-1280.png`).
- 캔버스에 `tabindex`와 `aria-label`이 없고, 갭 레일은 행마다 Tab 정지점이 4개입니다(`audit-desktop/flow7-ko.log`, `audit-desktop/flow13-ko.log`).
- 다른 앱: Obsidian iOS 그래프 설정은 접히는 섹션 카드에 들어가고 캔버스가 주인공입니다([750d7b56](https://mobbin.com/screens/750d7b56-5e9f-45d3-a43e-9160b4181c3c), [a4e27535](https://mobbin.com/screens/a4e27535-090f-40de-81c2-fa8e83703b8b)).

**제안.**
1. "그래프에서 보기"는 선택 노드와 1단계 이웃이 모두 들어오는 거리로 맞추고, 선택이 대기 중이면 "노트를 하나 고르세요" 배너를 숨기십시오.
2. 툴바는 축소, 맞춤, 확대만 남기고 나머지는 이름이 붙은 "더 보기" 메뉴로 옮기십시오.
3. 인스펙터가 열려 있으면 팁 말풍선을 띄우지 마십시오. 갭 레일 행은 Tab 정지점 하나로 두고 동작은 Enter나 메뉴로 여십시오.
4. 캔버스에 `tabIndex=0`과 요약 `aria-label`("노트 71개, 선택: attention-mechanism")을 주십시오.

**수용 기준.** 노트에서 "그래프에서 보기"를 누르면 선택 노드와 이웃이 화면 안에 있습니다(스크린샷). 그래프 찾기 입력에서 Tab 5번 안에 캔버스와 레일에 닿습니다. diff가 작고 서식 변경이 없습니다.

## S45 노트 정보 레일과 사이드바
**묶음:** 데스크톱 레이아웃 · **우선순위:** 4 · **크기:** S · **의존:** 없음 · **divergent:** 아니오

**목표.** 노트 정보를 열고 닫아도 사이드바가 원래대로 돌아오고, 레일이 본문을 가리지 않습니다.

**문제와 근거.**
- 1024에서 "노트 정보"를 열면 사이드바가 접히는데 닫아도 다시 펴지지 않습니다. 접기만 하는 코드입니다(`src/pages/PageReader.tsx:200-206`, `audit-desktop/shots/flow/42-note-info-ko-light-1024.png`).
- 820에서 레일을 연 채 사이드바를 다시 열면 레일이 본문 글자를 가립니다(`audit-mobile/shots/i/820-sidebar-toggled.png`).
- 다른 앱: Obsidian iOS는 노트에 딸린 정보를 오른쪽 서랍으로 겹쳐 엽니다([59932f82](https://mobbin.com/screens/59932f82-a889-4b24-b5a6-75be8965334e), [88d24bae](https://mobbin.com/screens/88d24bae-ee98-42b9-9180-2421eb4af47e)).

**제안.** 자동으로 접기 전의 사이드바 상태를 기억했다가 레일을 닫을 때 되돌리십시오. 레일이 열린 채 사이드바를 다시 열면 레일을 지금의 서랍 모드(`src/lib/readerRail.ts:334-344`)로 바꾸십시오.

**수용 기준.** 1024에서 노트 정보를 열고 닫으면 사이드바가 다시 펴집니다. 820에서 사이드바와 레일을 함께 열어도 본문 글자가 가려지지 않습니다.

---

# 모바일 준비(반응형/터치)

이 묶음은 네이티브 앱 없이 웹 레이어에서 하는 일입니다. 지금 데스크톱 앱 창은 `minWidth: 800`이라서(`src-tauri/tauri.conf.json:20`) ≤768px 규칙은 출시 앱에서 쓰이지 않습니다. `(any-pointer: coarse)` 규칙은 터치 노트북에서만 효과가 있는데 그 사용자 비율 데이터는 없습니다. 그래서 이 묶음은 **보류**입니다. 폰 앱을 만들기로 결정하고 `mobile-strategy.md`의 SP-1~SP-3을 통과한 뒤 그 문서 2단계의 첫 묶음으로 하십시오. 예외는 데스크톱에도 효과가 있는 부분(S42의 container query, S48의 도움말 버튼 겹침)입니다.

**폭 규칙(이 묶음과 S42, `mobile-strategy.md` 공통).** 폰 셸은 ≤768px입니다. 769–1023px(iPad 세로 820·834px 포함)은 데스크톱 레이아웃에 coarse 포인터 터치 대상(S47)을 적용합니다. ≥1024px은 데스크톱입니다. 이미 코드에 있는 820px 레이아웃 규칙(레일을 아래로 쌓기, `src/styles/ui.css:411-433`)은 데스크톱 레이아웃 안의 규칙으로 남습니다.

**접근성(이 묶음 공통).** 터치에서 숨은 제스처(길게 누르기, 끌기)만으로 닿는 기능을 만들지 않습니다. 모든 동작에는 보이는 버튼 경로가 있어야 하고, 그 버튼에는 접근성 이름이 있어야 합니다. VoiceOver와 큰 글자 확인은 `mobile-strategy.md` SP-5에서 합니다.

공통 검증은 375·390·768·820·1180에서 문서 가로 스크롤 0(`scrollWidth == clientWidth`), 터치 에뮬레이션에서 화면 안 44px 미만 대상 0, 하드웨어 키보드 경로(⌘K, `/`, `Mod-/`) 회귀 없음입니다(ON B6).

## S46 터치로 링크 열기
**묶음:** 모바일 준비 · **우선순위:** 1 · **크기:** S · **의존:** 없음 · **divergent:** 아니오

**목표.** 손가락으로 위키링크를 누르면 그 노트로 갑니다.

**문제와 근거.**
- Live 에디터의 링크 열기는 `if (!(e.metaKey || e.ctrlKey)) return false;`로 수정키를 요구합니다(`src/lib/editorLive.ts:748-777`, 조건 `:753`). 위키링크, 웹 링크, 각주 정의로 가는 길이 모두 여기에 묶여 있습니다.
- 375px에서 "Transformer" 링크를 탭해도 라우트가 바뀌지 않았습니다(`audit-mobile/interact2-facts.json`, `audit-mobile/shots/i/375-tap-wikilink.png`). 도움말도 "⌘click"으로 안내합니다(`audit-mobile/shots/i/375-help.png`).
- 다른 앱: Obsidian iOS는 읽기 보기와 편집 보기를 나누고 새 탭의 기본을 읽기로 고를 수 있게 합니다([f1a6d4a1](https://mobbin.com/screens/f1a6d4a1-719d-43a3-8532-fe7261f6151e), [54c00af4](https://mobbin.com/screens/54c00af4-c143-4537-86a0-30acf08e709f)). 탭 한 번이 링크 이동이 되는 근거는 Mobbin 화면이 아니라 터치 입력에서 수정키가 없다는 사실입니다.

**제안.** 데스크톱 마우스의 클릭 규칙은 S55가 정합니다. 이 슬라이스는 터치를 맡습니다.
1. 링크 핸들러는 `mousedown`이라 MouseEvent를 받고(`src/lib/editorLive.ts:748`), MouseEvent에는 `pointerType`이 없습니다. 같은 `eventHandlers`에 `pointerdown` 리스너를 더해 마지막 `e.pointerType`을 기록해 두고, 링크 판정(S55를 따르면 `click`)에서 그 값이 `"touch"`이면 수정키 없이, 캐럿 위치와 상관없이 링크를 여십시오.
2. 터치에서 링크를 고치는 길은 S51 막대의 "링크 편집"과, 링크 옆을 탭한 뒤 커서를 옮기는 방법입니다. 길게 누르기는 iOS 기본 텍스트 선택에 남겨 둡니다.
3. 도움말 문구는 입력 방식에 따라 고르십시오.

**수용 기준.** Playwright `hasTouch`에서 위키링크를 탭하면 라우트가 바뀝니다. 마우스 클릭의 동작은 S55의 수용 기준을 따릅니다(S55를 하지 않기로 했다면 마우스로 ⌘ 없이 누를 때 지금처럼 캐럿만 놓입니다). 단위 테스트에서 `pointerdown`의 `pointerType: "touch"` 뒤 `click`이 `onLinkClick`을 부릅니다.

## S47 터치 기준을 coarse 포인터로
**묶음:** 모바일 준비 · **우선순위:** 2 · **크기:** S · **의존:** 없음 · **divergent:** 예(`Sidebar.tsx:292` kbd 칩은 CSS로만 숨기면 손대지 않아도 됩니다)

**목표.** iPad와 터치 노트북도 44px 터치 영역을 받고, 터치에서는 키보드 단축키 안내가 보이지 않습니다.

**문제와 근거.**
- 44px 규칙(`.nav-item`, `.nav-leaf`, `.qbtn`, `.icon-btn`, `.ngl-add`)이 `@media (max-width: 768px)` 안에만 있고(`src/styles.css:7166-7182`), `(any-pointer: coarse)`에는 사이드바 행 높이만 있습니다(`src/styles.css:7057-7061`). 820·1180 터치에서 뒤로/앞으로 26×26, 사이드바 토글 28×28, "+ 새 노트" 71×22, 할 일 체크박스 15×15입니다(`audit-mobile/metrics-820.json`, `audit-mobile/metrics-1180.json`).
- `/` 메뉴 행 28px, `[[` 행 19px, ⌘K 화면 안 44px 미만 대상 19개, Ask 인용 pill 24×21입니다(`shots/oxn/12-slash.png`, `shots/oxn/13-wikilink.png`, ON 2절, AM 1절 D).
- 터치에서도 `⌘K` 칩과 "⌘Enter", ⌘K 바닥줄 `↑↓ ↵ ⌥↵ esc`가 보입니다(`src/components/CommandBar.tsx:656-670`, `src/components/Topbar.tsx:110-115`, `src/pages/PageOverview.tsx:369`, `shots/oxn/11-cmdk.png`, `shots/oxn/03-drawer.png`).
- 홈 입력창의 `autoFocus`(`src/pages/PageOverview.tsx:360`)는 폰에서 화면에 들어올 때마다 키보드를 올릴 수 있습니다(추론, 실기기 미확인).
- 다른 앱: Obsidian과 Notion iOS 피커에는 키 힌트가 없고([e9aaa07a](https://mobbin.com/screens/e9aaa07a-ab80-4354-bd1c-a37bc9a3f404), [c119cf0c](https://mobbin.com/screens/c119cf0c-6553-47b2-aead-63d060159283)), Notion 블록 타일은 손가락 크기입니다([23ebacc5](https://mobbin.com/screens/23ebacc5-4ddd-4afc-ae8e-3a07063e80cd)).

**제안.**
1. 44px 블록을 `@media (max-width: 768px), (any-pointer: coarse)`로 옮기고 `.cm-tooltip-autocomplete li`, ⌘K 행, `.ask-cite`, 할 일 체크박스에 `::after` hit-area를 더하십시오(보이는 크기는 그대로).
2. `@media (hover: none)`에서 `.kbd`, `.qkbd`, `.cmd-foot`의 키 안내, `.home-ask__keys`를 숨기십시오.
3. 홈 `autoFocus`는 `matchMedia("(pointer: fine)")`일 때만 거십시오.

**수용 기준.** 820·1180 터치 에뮬레이션에서 overview, query, note의 44px 미만 대상이 0입니다(`audit-mobile/sweep.mjs` 지표). 1280 마우스 화면은 그대로입니다. 터치에서 kbd 칩이 보이지 않습니다.

## S48 viewport, 안전 영역, 입력 글꼴
**묶음:** 모바일 준비 · **우선순위:** 3 · **크기:** S · **의존:** 없음(실기기 확인은 mobile-strategy 스파이크 SP-5) · **divergent:** 아니오

**목표.** 노치와 홈 인디케이터 아래로 버튼이 숨지 않고, 입력칸을 누를 때 화면이 확대되지 않으며, 떠 있는 버튼이 본문을 가리지 않습니다.

**문제와 근거.**
- `index.html:5` viewport에 `viewport-fit=cover`가 없어서, iOS는 `env(safe-area-inset-*)`를 0으로 줍니다(WebKit 블로그, 타당성 2절, 추론). 상단바의 안전 영역 처리(`src/styles.css:7088-7091`)가 실제로는 효과가 없을 가능성이 큽니다.
- 도움말 버튼은 `right:18px; bottom:18px`, 34×34이고 질문 제안, 할 일 행, 설정 입력, 자료 추가 입력을 가립니다(`src/styles.css:8248-8256`, `audit-mobile/shots/375-ko-light-query-full.png`, `audit-mobile/shots/375-ko-light-tasks-full.png`).
- `100vh`가 9번, `dvh`가 0번입니다. 사이드바는 `height: 100vh`입니다(`src/styles.css:7096-7104`).
- `.input, .textarea, .select`가 14px이고(`src/styles.css:2809-2821`), 그래프 찾기도 14px입니다(`:4802-4812`). iOS WebKit은 16px 미만 입력에 포커스가 가면 확대합니다(추론, 플랫폼 동작).
- `index.html:12-15`가 Google Fonts를 네트워크에서 불러옵니다. 오프라인 첫 실행에서는 대체 글꼴이 쓰입니다(타당성 2절, 추론).

**제안.** `viewport-fit=cover`를 넣고, 하단 고정 요소에 `env(safe-area-inset-bottom)`을 더하십시오. 도움말 버튼은 44px로 키우고 아래 막대나 아래 입력창이 있는 화면에서는 숨기십시오. `100vh`는 `100dvh`로(대체값 유지), coarse 포인터의 입력칸은 16px로 올리십시오. 글꼴은 번들하는 방향을 검토하십시오(크기 확인 뒤).

**수용 기준.** `index.html`에 `viewport-fit=cover`가 있습니다. 터치 에뮬레이션에서 입력칸 computed `font-size`가 16px 이상입니다. Playwright WebKit iPhone 프리셋에서 하단이 잘리지 않습니다.

## S49 공용 아래 시트, 보이는 ⋯ 버튼, 보조 길게 누르기
**묶음:** 모바일 준비 · **우선순위:** 4 · **크기:** M · **의존:** S9 `useModalFocus`(출시됨) · **divergent:** 예(`SidebarTree.tsx`, `Sidebar.tsx`)

**목표.** 폰과 터치에서 모든 ··· 메뉴, 우클릭 메뉴, 모달이 엄지 쪽에서 올라오는 시트 하나로 열립니다. 우클릭 대신 행에 보이는 ⋯ 버튼으로 열고, 길게 누르기는 보조 수단입니다.

**문제와 근거.**
- 시트는 할 일 상세 하나뿐이고 그것도 640px CSS 규칙입니다(`src/styles.css:1834-1845`). `TidySheet.tsx`는 이름과 달리 모달입니다(AM C3).
- 노트 ··· 메뉴는 드롭다운이고(`src/pages/PageReader.tsx:1022`), 트리 파일 작업은 `onContextMenu`와 Shift+F10에만 있으며(`src/components/SidebarTree.tsx:58`, `:89`, `src/components/SidebarMenu.tsx:74-158`), 여러 개 선택은 ⌘/Shift 클릭뿐입니다(`src/components/Sidebar.tsx:207-220`). 길게 누르기 처리는 없습니다(ON 2절, grep 0건). iOS WebKit은 길게 누르기로 `contextmenu`를 보내지 않는 것으로 압니다(폰 감사 M-05, 추론).
- 모달은 화면 가운데에 뜨고(`src/styles.css:3262-3270`) 서랍에서 새 노트를 열면 서랍이 뒤에 열린 채 남습니다(`audit-mobile/shots/i/375-newnote.png`). `.myco-modal { min-width: 360px }`는 ≤375px에서만 풀립니다(`src/styles.css:3271-3278`, `:7198-7203`).
- 길게 누르기만 두면 요약이 비판한 "숨은 동작"을 되풀이하고, VoiceOver 사용자는 이 길을 쓰기 어렵습니다(추론).
- 다른 앱: Google Drive iOS는 파일 목록의 행마다 ⋯ 버튼을 보이게 둡니다([ec124a18](https://mobbin.com/screens/ec124a18-9daf-4974-a3b2-632a0ab703a9), [eaee9635](https://mobbin.com/screens/eaee9635-ac37-49ad-a720-db2d16d3cdb0)). Obsidian iOS 노트 ··· 시트와 파일 시트의 메타 머리([2d7a3707](https://mobbin.com/screens/2d7a3707-09a1-4941-aaad-d65ee647341b), [5964c921](https://mobbin.com/screens/5964c921-3ae7-4f36-9fcb-81f8df0ee624)), Notion 페이지 시트([ee317f0a](https://mobbin.com/screens/ee317f0a-d52d-4dee-98db-60918c55de7b)), 위험 동작을 따로 빨간 그룹에 두는 Fabric([fb35f50d](https://mobbin.com/screens/fb35f50d-bccd-4f2c-88d2-16e42dc12ab6)), 검색 가능한 Linear 필터 시트([2f215b52](https://mobbin.com/screens/2f215b52-9a22-4ee9-b192-88e2de993521)).

**제안.**
1. `components/ui`에 `Sheet` 하나를 만드십시오: 손잡이, 아래로 밀거나 Esc로 닫기, `useModalFocus`, 안전 영역, `visualViewport` 높이 맞춤. 쓰는 곳이 다섯 군데(S33 출처, S33 범위, 노트 ···, 트리 메뉴, DialogHost 좁은 폭)라서 추상화할 이유가 있습니다.
2. 같은 항목 배열을 ≤768px이나 coarse 포인터에서 시트로 그리고, 그룹을 보기, 정리, 위험(빨강) 순서로, 머리에 수정 시각을 두십시오.
3. 기본 경로는 트리 행 끝의 ⋯ 버튼입니다. coarse 포인터에서는 늘 보이고 44px hit-area를 가지며, fine 포인터에서는 hover와 키보드 포커스 때 보입니다. 접근성 이름은 "<노트 이름> 메뉴"입니다. 누르면 같은 항목 배열로 시트를 엽니다.
4. 보조 경로로 길게 누르기 훅(약 500ms, 일정 거리 이상 움직이면 취소)을 트리 행에만 거십시오. `lib/pointerDrag.ts`와 이동 임계값을 공유하십시오. Ask 구절에는 걸지 않습니다. 구절은 iOS 기본 텍스트 선택(길게 눌러 단어 고르기와 복사)이 먼저입니다. 구절 동작은 구절 머리의 ⋯ 버튼으로 엽니다(S33 시트와 같은 항목).
5. 서랍에서 대화상자를 열면 서랍을 닫으십시오.

**수용 기준.**
- vitest: 길게 누르기 훅이 500ms 뒤 한 번 호출되고, 임계값 이상 움직이면 호출되지 않습니다.
- 터치 에뮬레이션에서 트리 행의 ⋯를 누르면 이름 바꾸기·이동·삭제가 있는 시트가 열립니다. 같은 행을 길게 눌러도 같은 시트가 열립니다. 375 노트 ···도 시트로 열립니다. 1280 마우스에서는 드롭다운 그대로이고, 행에 키보드 포커스가 가면 ⋯가 보입니다. 닫으면 포커스가 원래 자리로 돌아갑니다.
- 접근성 트리(Playwright `page.accessibility` 또는 `getByRole("button", { name: /메뉴/ })`)에서 트리 행마다 ⋯ 버튼이 이름과 함께 잡힙니다. VoiceOver 실기기 확인은 SP-5에서 합니다.

## S50 폰 셸: 아래 막대, 짧은 상단바, 아래 입력 피커
**묶음:** 모바일 준비 · **우선순위:** 5 · **크기:** M · **의존:** S47, S48, S49 · **divergent:** 예(`Sidebar.tsx`의 워크스페이스 행)

**목표.** 폰 폭에서 자주 하는 일이 엄지 아래 한 번에 닿고, 상단바가 옆으로 숨지 않으며, 검색 입력이 키보드 바로 위에 있습니다.

**문제와 근거.**
- 375px 상단바 내용 폭이 591px이라 검색 pill이 일부만 보이고 모델 칩은 화면 밖에 있습니다. 숨은 컨트롤 표시가 없습니다(`audit-mobile/interact-facts.json`, `audit-mobile/shots/i/375-topbar-scrolled-end.png`). 뒤로/앞으로 화살표가 시스템 뒤로 제스처와 겹칩니다(`mobile-shots/03-note.png`).
- 이동은 모두 왼쪽 위 서랍 안에 있고 하단 막대가 없습니다(`shots/m375-drawer.png`). 가장자리를 밀어도 서랍이 열리지 않습니다(폰 감사 M-13).
- ⌘K 입력창이 위(top 106px)에 있습니다(`shots/oxn/11-cmdk.png`).
- 다른 앱: Obsidian iOS는 바닥에 뒤로, 앞으로, 검색, +, 탭 수, ≡를 띄우고 위에는 제목과 ⋯만 둡니다([f1a6d4a1](https://mobbin.com/screens/f1a6d4a1-719d-43a3-8532-fe7261f6151e), [06a17971](https://mobbin.com/screens/06a17971-bcd0-445d-a6aa-bc50c5c62c2b)). Notion iOS는 바닥에 검색, Ask, 새 페이지를 둡니다([e7689c02](https://mobbin.com/screens/e7689c02-0bc0-49f7-bc5c-71f516844d33)). Linear는 탭 4개와 따로 떨어진 검색 버튼을 씁니다([3d9ccfd8](https://mobbin.com/screens/3d9ccfd8-2425-49e9-a00b-27189140d3a3)). Obsidian 피커와 Notion 검색은 입력창을 화면 아래에 두고 결과를 위로 쌓습니다([e9aaa07a](https://mobbin.com/screens/e9aaa07a-ab80-4354-bd1c-a37bc9a3f404), [44992a64](https://mobbin.com/screens/44992a64-b821-48c5-ade2-c3e80525b978), [c119cf0c](https://mobbin.com/screens/c119cf0c-6553-47b2-aead-63d060159283)).

**제안.**
1. ≤768px 상단바는 ☰, 위치 칩, ⋯만 남기고 뒤로/앞으로, 분할, 모델 칩(설정으로 이동)을 숨기십시오.
2. 아래 막대를 `mobile-strategy.md`의 정보 구조대로 두십시오(오늘 · 노트 · ＋ · 질문). 웹 레이어에서는 지금 라우트로 연결합니다.
3. ⌘K와 템플릿·이동·링크 피커는 ≤768px에서 입력창을 아래(`visualViewport`로 `--kb-h` 갱신), 결과를 위에 두십시오. 빈 입력은 최근 노트를 "오늘 / 이번 주"로 묶으십시오.

**수용 기준.** 375·390에서 상단바 `scrollWidth == clientWidth`이고 아래 막대 항목이 44px 이상입니다. ⌘K 입력창이 화면 아래쪽에 있습니다. 769px 이상은 그대로입니다.
- 조합 중 Enter나 탭이 미완성 음절을 잃지 않습니다. 아래로 옮긴 피커도 지금 ⌘K의 `isComposingKey` 가드(`src/components/CommandBar.tsx`)를 그대로 쓰고, "어텐"을 치는 중 마지막 음절이 조합 중일 때 Enter는 행을 고르지 않고 조합만 확정합니다. 조합 중 `visualViewport` 높이가 바뀌어도 입력칸을 다시 만들지 않습니다(iOS 두벌식·천지인은 SP-5).

## S51 키보드 위 도구 막대와 탭으로 여는 블록 메뉴
**묶음:** 모바일 준비 · **우선순위:** 6 · **크기:** L · **의존:** S49. 진행 중 블록 패널 스펙의 블록 툴바는 "Pointer hover and keyboard selection"에서만 뜨므로(`docs/specs/2026-10-01-notion-blocks-one-editor.md:113`) 탭 트리거를 그 스펙과 맞추십시오 · **divergent:** 아니오

**목표.** 폰 소프트 키보드로도 서식, 링크, 들여쓰기, 블록 이동, 블록 추가를 버튼으로 합니다. 새 서식은 만들지 않고 이미 있는 명령만 부릅니다.

**문제와 근거.**
- 서식은 `Mod-b/i/e/k` 키뿐이고(`src/lib/editorFormat.ts:572-580`) 선택 툴바가 없습니다(ON 2절).
- 블록 핸들은 `pointermove`/`pointerleave`로만 나타나고(`src/lib/editorBlockHandle.ts:77-78`) 폭은 20px이며(`:47`), 탭한 뒤에도 `hidden: true`였습니다(`audit-mobile/interact-facts.json`, `shots/oxn/09-reader-focused.png`). 다른 입구는 `Mod-/`뿐입니다(`:28-44`).
- 들여쓰기는 Tab 전용이고(`src/lib/editorBlocks.ts:1215-1216`, `src/lib/editorLists.ts:293-305`) 블록 메뉴에 들여쓰기 항목이 없습니다(`src/lib/editorBlockOps.ts:460-499`). iOS 소프트 키보드에는 Tab이 없습니다.
- 키보드 인식 처리(`visualViewport|virtualKeyboard`)가 0건입니다(타당성 2절). 슬래시 메뉴가 키보드 뒤에 놓일 가능성이 큽니다(`audit-mobile/shots/i/375-slash.png`, 추론).
- 다른 앱: Obsidian iOS 한 줄 가로 스크롤 막대와 선택 시 서식 막대([2092380b](https://mobbin.com/screens/2092380b-d5a6-48c2-910a-671dd80ed973), [629a3a6a](https://mobbin.com/screens/629a3a6a-d55b-49a6-8914-945c900d5ee1), [1c499b24](https://mobbin.com/screens/1c499b24-8d6b-4b13-8e7b-3bd58693ba21)), 내어쓰기·들여쓰기·↑·↓·+가 있는 Notion 막대([bb04ea66](https://mobbin.com/screens/bb04ea66-02e0-43ff-97ca-21dca43e7947)), 선택 시 바뀌는 Notion 막대([011e1303](https://mobbin.com/screens/011e1303-32b9-4882-8d28-71b5b233c517)), 키보드 자리에 여는 2열 블록 타일([23ebacc5](https://mobbin.com/screens/23ebacc5-4ddd-4afc-ae8e-3a07063e80cd), [b689e6c5](https://mobbin.com/screens/b689e6c5-62b4-48e9-83d0-76cc61b9966e)), 블록 Actions 시트([6ecea6c7](https://mobbin.com/screens/6ecea6c7-4682-4c35-b649-412a0a240738)).

**제안.**
1. 키보드 위(`visualViewport` 기준)에 가로 스크롤 막대 하나를 두십시오: 되돌리기, `[[`, `#`, 체크, 제목, 내어쓰기, 들여쓰기, ↑, ↓, + 블록, ⋮⋮ 블록 메뉴, 키보드 내리기. 텍스트를 고르면 B, I, 형광, 코드, 링크로 바꾸십시오(기존 `formatTr`).
2. "+ 블록"은 `slashItems`(`src/lib/editorCompletions.ts:162-`)를 섹션별 2열 타일로 키보드 자리에 그리십시오. 지금의 `/` 팝업은 하드웨어 키보드용으로 남깁니다.
3. 터치에서는 캐럿이 있는 블록 옆에 44px 핸들을 띄우고, 누르면 S49 시트로 블록 메뉴를 여십시오. 블록 메뉴에 들여쓰기와 내어쓰기를 더하십시오.
4. 재정렬은 ↑↓ 버튼으로 시작하고 터치 끌기는 미루십시오. 막대 구성 편집도 미룹니다.
5. 막대 버튼은 한국어 조합 중에 CM transaction을 보내지 마십시오. one-editor 불변식 "A write waits for `compositionend`"(`docs/specs/2026-10-01-notion-blocks-one-editor.md:50-53`)와 같은 규칙입니다. 이미 있는 패턴은 `if (view.composing) return false;`입니다(`src/lib/editorBlockHandle.ts:35`, `src/lib/editorBlocks.ts:1174`, `@codemirror/view` 6.42.1의 `EditorView.composing`). 조합 중에 누른 버튼은 `compositionend` 뒤 한 번 실행하거나, 실행하지 않고 버튼을 잠깐 흐리게 보이십시오. 버튼 `pointerdown`에서 `preventDefault()`로 에디터 포커스를 지켜 키보드가 내려가지 않게 하십시오(추론, 실기기 확인 필요).

**수용 기준.** 터치 에뮬레이션에서 에디터에 포커스하면 막대가 보이고, 목록 항목에서 "들여쓰기"를 누르면 문서 텍스트가 한 단계 들여써집니다. ⋮⋮를 누르면 시트가 열리고 "위로"가 블록을 옮깁니다. 기존 에디터 테스트와 `editor-audit` 스위트가 통과합니다.
- 조합 중 Enter나 탭이 미완성 음절을 잃지 않습니다. vitest: `view.composing`이 참일 때 막대 명령은 transaction을 보내지 않습니다. 실기기(SP-5): "회의"의 "의"가 조합 중일 때 [체크]를 눌러도 "회의"가 온전히 남고 체크 항목이 됩니다.

## S52 할 일 보드: 상태 칩과 보조 길게 눌러 옮기기
**묶음:** 모바일 준비 · **우선순위:** 7 · **크기:** S · **의존:** S49 길게 누르기 훅 · **divergent:** 아니오

**목표.** 손가락으로 카드 상태와 마감일을 옮기고, 끌지 못하는 사람도 같은 일을 버튼으로 합니다.

**문제와 근거.**
- 820×1180 보드에서 마우스 드래그는 열별 개수를 `[12,1,0,3]`에서 `[11,1,0,4]`로 바꿨고, 같은 경로의 터치 드래그는 그대로였습니다(`audit-mobile/interact3.mjs`, `audit-mobile/interact2-facts.json`, `audit-mobile/shots/i/820-board-after-drag.png`). 드래그는 pointer 이벤트 기반이고(`src/lib/pointerDrag.ts:1-11`, `src/components/TaskBoard.tsx:76`) `.task-card`에 `touch-action`이 없습니다(`src/styles.css:1498-1510`). 타당성 보고서는 터치에서도 될 것으로 추론했지만 측정 결과가 다릅니다.
- 끌지 않는 경로는 이미 있습니다. 카드를 누르면 할 일 상세가 열리고(`src/components/TaskBoard.tsx:72-80` `onOpen`), 상세에는 상태 버튼 네 개가 `aria-pressed`와 함께 있습니다(`src/components/TaskDetail.tsx:183-191`). 다만 보드 위에서는 이 길이 드러나지 않고, 터치에서 확인한 적이 없습니다.
- 다른 앱: Notion iOS 온보딩은 "Touch and hold to reorder any content."를 가르칩니다([2ada33fc](https://mobbin.com/flows/2ada33fc-fedc-4d26-a89a-96714e261e81)). Things 3는 +를 끌어다 놓은 자리에 새 항목을 만듭니다([d6e7f013](https://mobbin.com/screens/d6e7f013-e95c-4203-b98f-dfe27bac343d)). 끌지 않는 대안으로 Notion iOS는 상태를 아래 시트에서 고르고([8d6dcf3b](https://mobbin.com/screens/8d6dcf3b-3197-4244-86b6-f901f7df6079)), Jira Cloud iOS는 상세 머리의 "To Do ▾" 칩을 눌러 "Select a status" 시트를 엽니다([fa2d33e6](https://mobbin.com/screens/fa2d33e6-7b28-4a34-b36a-db7509af9b70)).

**제안.**
1. 기본 경로: 카드에 상태 칩("할 일 ▾")을 두고, 누르면 S49 시트에서 상태를 고르게 하십시오. 항목은 상세의 상태 버튼과 같은 배열(`src/components/TaskDetail.tsx:33-36`)을 씁니다. 캘린더 막대의 마감일은 상세의 날짜 입력으로 바꿉니다.
2. 보조 경로: 카드와 캘린더 막대를 약 300ms 길게 눌러 집고, 집은 동안만 `touch-action: none`을 켜십시오. 짧게 미는 동작은 페이지 스크롤로 남깁니다.

**수용 기준.** 터치 에뮬레이션에서 카드의 상태 칩으로 "완료"를 고르면 열별 개수가 `[11,1,0,4]`로 바뀝니다. 길게 눌러 끌어도 같은 결과이고, 짧게 밀면 페이지가 스크롤됩니다. 상태 칩은 접근성 이름("상태: 할 일")을 가집니다. VoiceOver로 끌기 없이 상태를 바꾸는 확인은 SP-5에서 합니다.

## S53 그래프 폰 레이아웃
**묶음:** 모바일 준비 · **우선순위:** 8 · **크기:** M · **의존:** S49, S50 · **divergent:** 예(`PageGraph.tsx`)

**목표.** 폰(≤768px)에서 캔버스가 화면을 쓰고, '빈 곳'과 범례를 다시 쓸 수 있습니다. iPad 세로(769–1023px)는 데스크톱 레이아웃 그대로 두되 레일이 높이 0이나 17px로 눌리지 않습니다.

**문제와 근거.**
- 그래프 페이지는 화면 높이에 고정되고(`src/styles.css:886-895`), ≤768px 캔버스는 `60vh; min-height: 360px`입니다(`:7144-7147`). 375×812에서 캔버스가 y=426에서 929까지라 아래 117px이 잘리는데 페이지가 스크롤되지 않습니다(`audit-mobile/interact-facts.json`, `audit-mobile/shots/375-ko-light-graph.png`, `audit-mobile/shots/i/375-graph-after-swipe.png`).
- ≤820px에서 레일 두 개의 높이가 375px에서 0, 820px에서 17px입니다(`src/styles/ui.css:411-433`, `src/styles.css:4399-4406`, `audit-mobile/shots/crops/820-graph-railbar.png`).
- 1180 터치에서 레일 행 액션의 세 번째 버튼이 27px 잘리고 노트 이름이 가려집니다(`src/styles.css:4219-4221`, `src/styles/ui.css:798-808`, `:834-841`, `audit-mobile/shots/crops/1180-graph-gaps.png`).
- 이웃 강조는 hover로만 됩니다(`src/lib/graphScene.ts:149-150`, `:1288-1293`). 핀치 줌은 합성 터치에서 결과가 일정하지 않았습니다(`audit-mobile/pinch.mjs` 출력, 실기기 재측정 필요).
- 다른 앱: Obsidian iOS 그래프는 화면 전체를 쓰고 설정을 떠 있는 접이식 카드에 넣습니다([750d7b56](https://mobbin.com/screens/750d7b56-5e9f-45d3-a43e-9160b4181c3c), [6239ed2b](https://mobbin.com/screens/6239ed2b-70fd-4c8d-aa22-f8c7b467d4a8)). Obsidian Canvas는 빈 화면에 "Drag to pan / Pinch to zoom / Touch and hold"를 적습니다([58242b18](https://mobbin.com/screens/58242b18-6679-468e-b059-54f082a8de4d)).

**제안.**
1. ≤768px에서 캔버스를 상단바와 아래 막대 사이 전체로 쓰고, 찾기·질문·크기 컨트롤은 ⚙로 여는 떠 있는 카드로 옮기십시오.
2. '빈 곳'과 범례는 시트의 두 탭으로 되살리십시오. 769–1023px에서는 820px 쌓기 규칙(`src/styles/ui.css:411-433`) 안에서 레일에 최소 높이를 주십시오.
3. coarse 포인터에서는 레일 행 액션을 행의 ⋯ 하나(S49 시트)로 묶으십시오.
4. 노드 탭이 선택과 이웃 강조를 함께 하게 하고, 첫 방문에 제스처 안내를 한 번 보이십시오.
5. 연속 렌더 루프는 소유자가 의도한 결정이므로 바꾸지 마십시오. 배터리 영향은 실기기 스파이크에서 재십시오.

**수용 기준.** 375에서 캔버스 아래 끝이 아래 막대 위에 있고, '빈 곳' 시트에 항목이 보입니다. 820에서 두 레일의 높이가 각각 한 행 이상입니다. 1180 터치에서 레일 행 액션이 잘리지 않습니다.

## S54 좁은 폭 페이지별 정리
**묶음:** 모바일 준비 · **우선순위:** 9 · **크기:** M · **의존:** S49 · **divergent:** 아니오

**목표.** 할 일, 캘린더, 히스토리, 출처, 설정, 노트 정보가 375px에서 잘리지 않고 읽힙니다.

**문제와 근거.**
- 할 일 입력은 제목, 날짜, 자세히, 추가를 줄바꿈 없는 한 줄에 넣어 제목 칸이 35×30이 됩니다(`src/components/TaskComposer.tsx:127-162`, `audit-mobile/shots/375-ko-light-tasks-full.png`). 캘린더 칸은 약 46px입니다(`audit-mobile/shots/i/375-tasks-캘린더.png`).
- 히스토리 실행 id와 보고서 제목이 세 줄로 접히고 펼치기 버튼이 13×13입니다(`audit-mobile/shots/375-ko-light-history.png`). 출처 페이지 이름이 "transform…"으로 잘립니다(`audit-mobile/shots/crops/375-ko-light-provenance-full-0.png`).
- 설정은 카테고리 카드 그리드 아래에 패널 본문이 이어져 두 단계가 한 화면에 섞입니다(`shots/oxn/07-settings.png`).
- 노트 정보 서랍이 본문의 82%를 덮고, 속성 행 `grid-template-columns: 140px 1fr auto` 때문에 값 칸이 약 56px입니다(`src/lib/readerRail.ts:334-344`, `src/styles.css:9911-9923`, `:9432-9438`, `audit-mobile/shots/i/375-note-info.png`).
- 노트 머리가 첫 화면의 약 40%를 차지합니다(`shots/05-phone-375-note-editing.png`).
- 다른 앱: Obsidian iOS 설정은 목록에서 상세로 들어가는 두 단계입니다([074d1d45](https://mobbin.com/screens/074d1d45-ec3a-4267-9dae-b53f4402f83e), [7f043fcb](https://mobbin.com/screens/7f043fcb-4094-43ad-b377-e88ca4aa74ee)). Apple Notes는 본문 위에 날짜 한 줄만 둡니다([243b2ee1](https://mobbin.com/flows/243b2ee1-b668-4d16-a4af-70fabe323188)).

**제안.** 할 일 입력을 두 줄(제목 / 날짜·자세히·추가)로 감싸고, 캘린더는 ≤480px에서 주간이나 목록 보기로 바꾸십시오. 히스토리·출처·설정 모델 행은 세로로 쌓으십시오. 설정은 ≤768px에서 목록 다음 상세(뒤로)로 바꾸십시오. 노트 정보는 ≤768px에서 아래 시트로 열고 속성을 키 위에 값을 쌓는 1열로 두십시오. 노트 머리는 작성 비율(S14 이후 남아 있다면)과 동작 줄을 ⋯ 하나로 접고 저장 상태를 제목 끝 점으로 바꾸십시오.

**수용 기준.** 375에서 할 일 제목 입력이 폭의 60% 이상이고, 20자 속성 값이 잘리지 않으며, 설정이 목록과 상세로 나뉘고 뒤로 버튼이 있습니다.

---

## 진행 중 스펙에 넘길 조건

새 슬라이스가 아니라 진행 중인 작업의 수용 조건으로 넘깁니다.

- `2026-10-01-notion-blocks-one-editor.md`(표·블록 패널): 이 스펙에는 touch와 mobile 언급이 없습니다(폰 감사 M-15, grep 0건). 375px에서 표 셀을 탭하면 표 위젯이 사라지고 `| … |` 원문으로 바뀌며, 셀 이동은 Tab입니다(`audit-mobile/shots/i/375-table-rendered.png`). 넘길 조건: 셀을 탭해서 원문을 보이지 않고 편집하기, Tab 없이 다음 셀로 가기, 넓은 표는 가로 스크롤([9813d2c0](https://mobbin.com/screens/9813d2c0-84ec-4c41-bfdc-8c2127914c91)), 셀을 고르면 행·열 핸들([d53b3912](https://mobbin.com/screens/d53b3912-f60a-4bd1-872e-18276fe2acd5)), 블록 툴바의 탭 트리거(S51), 패널이 `visualViewport` 안에 들어오기, iOS 소프트 키보드의 한국어 두벌식·천지인으로 셀을 입력할 때 마지막 음절이 남기(그 스펙은 WKWebView 한국어 조합을 "Not checkable here"로 남겼습니다, `docs/specs/2026-10-01-notion-blocks-one-editor.md:177-178`. 폰 확인은 `mobile-strategy.md` SP-5).
- `2026-10-01-graph-woven-and-visual-rules.md`: 모바일에서 넘길 조건은 없습니다. 이 스펙은 룩 렌더링 규칙만 다루고 레일, 툴바, 디버그 칩, 카메라는 다루지 않으므로(grep 확인) S14, S42, S44, S53과 겹치지 않습니다.

## 보고만 하는 것

- `src/lib/digests.ts:77` `runDigest`는 정의 파일과 테스트 밖에서 부르는 곳이 없습니다(PA). 삭제는 소유자 승인 뒤에 하십시오.
- 타당성 보고서는 할 일 드래그가 터치에서도 될 것으로 추론했지만(1-A), 폰 감사 측정(M-03)은 되지 않았습니다. S52는 측정을 따릅니다.
- 타당성 보고서는 iPad 834·1194px 레이아웃이 그대로 쓸 만하다고 봤고(`mobile-shots/09-ipad-*`), 폰 감사는 같은 폭의 터치 대상이 26–28px라고 쟀습니다(M-12). 둘 다 맞고, S47이 그 차이를 메웁니다.
- 보조 창 세 개를 이번에 처음 찍었습니다(`aux-windows.mjs`, `audit-desktop/shots/aux/`, ko·en × light·dark). 트레이, Spotlight, 노치는 테마와 상관없이 어두운 팔레트로 그리도록 의도돼 있어(`src/components/Spotlight.tsx:15-18`, `src/components/NotchPanel.tsx:21-23`) light와 dark가 같습니다. mock의 트레이는 ko에서도 "Open myco", "Quit myco"로 보이는데, 이는 mock 고정값(`src/lib/devMock.ts:2137-2138`) 때문이고 실제 앱은 `t.tray_open`(`src/lib/trayStatus.ts:196`, ko "myco 열기" `src/lib/i18n.ts:6012`)을 씁니다. 결함으로 올리지 않았습니다. Spotlight와 노치에서 찾은 것은 S14, S30, S39에 넣었습니다.

## 이번에 뺀 것

- Gemini식 문장 단위 근거 표시(AM M13): provider 답변에만 해당하고 문장 수만큼 검색 호출이 늘어나 비용을 먼저 재야 합니다(L).
- 음성 대화 모드(AM M7): 원문 인용 최대 5개를 소리로 읽는 대화는 맞지 않습니다(AM 판단). 폰에서는 OS 키보드 받아쓰기만 둡니다.
- 페이지 잠금 토글(ON A7): one-editor 결정과 겹칩니다. 폰 첫 버전은 읽기 전용으로 여는 것으로 대신합니다(`mobile-strategy.md`).
- 도구 막대 구성 편집, Bear식 키보드 대체 전체 패널: 막대 쓰임을 확인한 뒤로 미룹니다.
- 공유 확장, 위젯, 볼트 위치 선택, 페어링: 네이티브 작업이라 `mobile-strategy.md`의 단계 계획에 있습니다.
- 햅틱(AM C6)과 Heptabase식 화이트보드: Mobbin 근거가 없습니다.
