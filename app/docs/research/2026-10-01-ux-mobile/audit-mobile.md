# myco 폰·태블릿 폭 감사 (2026-10-01)

모바일 버전을 준비하려고, 지금의 myco UI가 폰과 태블릿 크기에서 어떻게 동작하는지 측정했습니다. 대상은 `feat/permit-editor-ux` 브랜치(`~/prj/karpathy-editor-build/app`)이고, 코드는 읽기만 했습니다.

- 코드 인용은 `src/...:줄번호` 형식이며 기준은 `~/prj/karpathy-editor-build/app/`입니다.
- 스크린샷 인용은 `shots/...` 형식이며 기준은 `<session-scratchpad>/ux-2026-10/audit-mobile/`입니다.
- 근거의 성격은 세 가지로 나눴습니다. **[검증]**은 이번에 실행해서 측정했거나 화면으로 본 것이고, **[코드]**는 소스를 읽고 확인한 것이며, **[추론]**은 실기기나 iOS WebKit 없이 판단한 것입니다.

## 요약

1. 88개 조합(뷰포트 4 × 언어·테마 2 × 경로 11)을 모두 돌렸고, 페이지 전체가 가로로 스크롤되는 곳은 하나도 없었습니다 [검증]. ≤768px 셸(오프캔버스 사이드바, 스크림, 44px 아이콘 버튼)은 이미 들어가 있어서 화면이 깨지지는 않습니다.
2. 문제는 레이아웃보다 **입력 방식**에 있습니다. 노트 안 링크는 ⌘/Ctrl 클릭으로만 열려서 터치로는 위키링크를 따라갈 수 없습니다 [검증]. 리스트 들여쓰기는 Tab 전용이고, 블록 핸들은 마우스 이동에만 나타나며, 할 일 보드 드래그는 마우스로는 되고 터치로는 되지 않습니다 [검증]. 홈의 "오늘의 노트에 적기"는 ⌘Enter 말고는 방법이 없습니다 [코드].
3. 그래프는 375px에서 캔버스가 y=426부터 시작하고 아래쪽 117px이 잘리는데, 페이지가 스크롤되지 않아 잘린 부분을 볼 수 없습니다 [검증]. ≤820px에서는 '빈 곳'과 '범례' 레일이 높이 0으로 접혀 사실상 쓸 수 없습니다 [검증].
4. iPad 폭(820, 1180)은 `max-width: 768px` 규칙 밖이라 데스크톱 크기의 작은 터치 대상이 그대로 나옵니다. 상단바 뒤로/앞으로 버튼은 26×26, 사이드바 토글은 28×28, 할 일 체크박스는 15×15입니다 [검증].
5. 모바일 앱으로 가려면 셸보다 백엔드가 더 큰 벽입니다. Tauri 모바일 진입점이 없고, LLM·전사·git을 외부 프로세스 실행에 기대는 Rust 모듈이 15개 있습니다 [코드]. 그래서 "iPad 터치 대응 먼저, 폰은 읽기·캡처·질문 중심의 얇은 셸" 순서를 권합니다.

## 측정 방법

| 항목 | 내용 |
|---|---|
| 서버 | `node node_modules/vite/bin/vite.js --port 6310 --strictPort` (백그라운드). 끝난 뒤 종료했고 `lsof`로 6310 포트가 비었음을 확인했습니다. |
| 브라우저 | Playwright 1.60.0 Chromium, `isMobile:true, hasTouch:true, deviceScaleFactor:2` |
| 뷰포트 | 375×812(iPhone), 393×852, 820×1180(iPad 세로), 1180×820(iPad 가로) |
| 조합 | ko + light, en + dark |
| 경로 | overview, ingest, query, graph, history, provenance, tasks, study, feedback, settings, `page:/myco/wiki/attention-mechanism.md` |
| 진입 | `localStorage`에 `myco.onboarded=1`, `myco-ui={route,lang,theme}`를 넣고 `http://localhost:6310/?mock=1`을 열었습니다. |
| 스크립트 | `sweep.mjs`(전 조합 스크린샷과 지표), `interact.mjs`·`interact2.mjs`·`interact3.mjs`(터치 탭, 드래그, 핀치, 메뉴), `probe2.mjs`(입력 글꼴 크기, 분할 화면, fixed 요소), `probe3.mjs`(레일 행 액션), `pinch.mjs`, `css_scan.py`(hover 노출 규칙, 고정 px 폭) |
| 산출물 | `shots/` 112장, `shots/i/` 37장, `shots/crops/`, `metrics-{375,393,820,1180}.json`, `interact-facts.json`, `interact2-facts.json`, `css_scan.txt` |

측정한 지표는 문서 가로 스크롤 여부(`scrollWidth > clientWidth`), 화면 밖으로 튀어나온 요소, 화면 안 상호작용 요소 중 44px 미만 개수, 내부 가로 스크롤 영역, 사이드바와 본문 위치입니다.

## 뷰포트별 한눈 보기

44px 미만 터치 대상 수 / 화면 안 상호작용 요소 수입니다(ko + light, 첫 화면 기준) [검증, `metrics-*.json`].

| 경로 | 375 | 393 | 820 | 1180 |
|---|---|---|---|---|
| overview | 3/10 | 4/12 | 11/51 | 11/39 |
| ingest | 4/9 | 4/9 | 16/52 | 12/37 |
| query | 8/19 | 8/19 | 16/54 | 16/46 |
| graph | 56/59 | 60/63 | 96/125 | 81/102 |
| history | 11/17 | 11/17 | 22/51 | 22/43 |
| provenance | 7/16 | 7/17 | 15/57 | 15/44 |
| tasks | 35/38 | 37/40 | 54/83 | 43/64 |
| study | 6/12 | 6/12 | 14/46 | 14/38 |
| feedback | 14/17 | 14/17 | 22/51 | 22/43 |
| settings | 9/24 | 9/24 | 22/63 | 20/53 |
| note | 1/7 | 1/7 | 11/48 | 9/39 |

- 모든 조합에서 문서 가로 스크롤은 없었습니다(`hScroll=false`, 88/88).
- 820·1180에서 자주 나온 작은 대상은 `button.u-btn--quiet` 49×32(그래프 레일 액션), 할 일 체크박스 15×15, `button.ngl-add`(+ 새 노트) 71×22, `button.pill.auth-filter`(기록상 사람만) 82×23, `button.st-fix`(지금 재인덱스) 72×18, `button.icon-btn` 26×26·28×28, `pill-search` 73×28, `model-chip` 188×28, `help-widget__fab` 34×34입니다.
- ko와 en의 차이는 거의 없었습니다. en에서도 할 일 입력칸이 "Wha"로 잘립니다(`shots/375-en-dark-tasks.png`).

## 터치로 할 수 없는 기능

이 절의 항목은 화면이 아니라 기능 자체가 막히는 경우입니다. 모바일 버전에서 가장 먼저 풀어야 합니다.

**M-01 노트 안 링크를 탭해도 열리지 않음** [검증][코드]
- Live 에디터의 링크 열기는 `if (!(e.metaKey || e.ctrlKey)) return false;`로 수정키를 요구합니다(`src/lib/editorLive.ts:748-777`, 조건은 `:753`). 위키링크, 웹 링크, 각주 정의로 이동하는 경로가 모두 여기에 묶여 있습니다.
- 375px에서 "Transformer" 링크(232,471, 99×20)를 탭했더니 route가 `page:/myco/wiki/attention-mechanism.md` 그대로였습니다(`interact2-facts.json`, `shots/i/375-tap-wikilink.png`).
- 도움말 위젯도 "⌘click 포인터 아래 링크 열기"로 안내합니다(`shots/i/375-help.png`).
- 영향: 폰과 iPad에서 위키의 핵심 동작인 노트 사이 이동이 불가능합니다.

**M-02 리스트 들여쓰기와 블록 조작이 키보드·마우스 전용** [검증][코드]
- 들여쓰기와 내어쓰기는 `Tab`/`Shift-Tab` 키맵에만 있습니다(`src/lib/editorBlocks.ts:1215-1216`, `src/lib/editorLists.ts:293-305`). 블록 메뉴 항목은 Text, 제목 변환, 복제, 삭제, 위로, 아래로, 질문뿐이라 들여쓰기가 없습니다(`src/lib/editorBlockOps.ts:460-499`). iOS 소프트 키보드에는 Tab 키가 없습니다.
- 블록 메뉴를 여는 길은 `Mod-/`(`src/lib/editorBlockHandle.ts:28-44`)와 ⋮⋮ 핸들 두 가지입니다. 핸들은 `pointermove`와 `pointerleave`로만 나타나고 숨으며(`:77-78`), 스크롤로 geometry가 바뀌면 바로 숨습니다(`:116-120`). 폭은 20px입니다(`:47`).
- 375px에서 문단을 탭한 뒤에도, 손가락을 끌어 움직인 뒤에도 핸들은 `hidden:true`였습니다(`interact-facts.json`, `shots/i/375-editor-after-touchmove.png`).
- 영향: 터치에서는 블록 이동, 복제, 삭제, "이 블록에 대해 질문"을 열 수 없습니다. 슬래시 메뉴는 `/` 입력으로 열려서 이것만 터치로 쓸 수 있습니다.

**M-03 할 일 보드·캘린더 드래그가 터치에서 동작하지 않음** [검증][코드]
- 820×1180 보드에서 첫 카드("provenance panel")를 마지막 열로 끌었을 때 마우스 드래그는 열별 개수가 `[12,1,0,3]`에서 `[11,1,0,4]`로 바뀌었고, 같은 경로의 터치 드래그는 `[12,1,0,3]` 그대로였습니다(`interact3.mjs`, `interact2-facts.json`, `shots/i/820-board-after-drag.png`).
- 드래그는 포인터 이벤트 기반입니다(`src/lib/pointerDrag.ts:1-11`, `src/components/TaskBoard.tsx:76`). 그런데 `.task-card`에는 `touch-action`이 없어서(`src/styles.css:1498-1510`) 브라우저가 터치 이동을 스크롤로 가져가는 것으로 보입니다 [추론]. `touch-action: none`은 분할 구분선, 3D 캔버스, 인제스트 미니그래프, `.ovl-grip`에만 있습니다(`src/styles.css:923, 5023, 6873, 9233`).
- 영향: 상태 변경과 마감일 이동을 터치로 할 수 없습니다. 카드에 `touch-action: none`을 그냥 넣으면 보드 위에서 페이지 스크롤이 막히므로, 길게 눌러 집는 방식이나 손잡이가 필요합니다.

**M-04 홈의 "오늘의 노트에 적기"가 ⌘Enter 전용** [코드][검증]
- 홈 입력칸은 Enter로 질문하고 ⌘/Ctrl+Enter로 오늘의 노트에 적습니다(`src/pages/PageOverview.tsx:362-367`). 적기 버튼은 없고, 힌트 문구도 "Enter 질문하기 · ⌘Enter 오늘의 노트에 적기"입니다(`src/lib/i18n.ts:6218`, `shots/375-ko-light-overview.png`).
- 같은 입력칸에 `autoFocus`가 있어(`src/pages/PageOverview.tsx:360`) 375px에서 홈을 열면 바로 포커스가 갑니다(`activeElement=TEXTAREA.home-ask__input`, `probe2.mjs`). 노트를 열 때도 에디터가 포커스를 가져갑니다(`activeElement=DIV.cm-content`). 실기기에서는 화면에 들어올 때마다 키보드가 올라올 수 있습니다 [추론, iOS WebKit은 사용자 제스처 없는 포커스에서 키보드를 띄우지 않을 수도 있음].
- 1줄 textarea라서 375px에서 placeholder 둘째 줄 "보세요"가 반쯤 잘립니다(`shots/375-ko-light-overview.png`).

**M-05 사이드바 파일 작업이 우클릭 전용** [코드]
- 트리 행의 새 노트, 새 폴더, 즐겨찾기, 이동, 이름 바꾸기, 삭제는 `onContextMenu`로만 열립니다(`src/components/SidebarTree.tsx:58, 89`, `src/components/SidebarMenu.tsx:74-158`). 여러 개 선택은 ⌘ 클릭과 Shift 클릭뿐입니다(`src/components/Sidebar.tsx:207-220`).
- 지금 연 노트는 ⋯ 메뉴로 이름 바꾸기, 이동, 삭제를 할 수 있습니다(`shots/i/375-note-more.png`, 행 높이 44px). 하지만 폴더 작업과 다른 노트에 대한 작업은 길이 없습니다.
- iOS WebKit은 길게 누르기로 `contextmenu`를 보내지 않는 것으로 알고 있습니다 [추론, 실기기 미확인].

**M-06 키보드에만 있는 그 밖의 기능** [코드]
- 명령 팔레트의 "⌥⏎ 놓친 검색 기록"은 Alt+Enter로만 동작합니다(`src/components/CommandBar.tsx:448-455`). 팔레트 바닥줄도 ↑↓, ↵, ⌥↵, esc 키 안내만 보여 줍니다(`shots/i/375-commandbar.png`).
- RecallPicker의 임베드 삽입은 ⌘↵입니다(`src/components/RecallPicker.tsx:248`, 힌트 `src/lib/i18n.ts:5333`).
- 우주선 모드 등 그래프 도구 버튼은 이름이 `title`과 `aria-label`에만 있고 단축키가 붙어 있습니다("우주선 모드 (F)", "사이드바 토글 (⌘B)", `src/components/Topbar.tsx:59`). 375px 그래프에서 글자 없는 아이콘 버튼 13개를 셌습니다(`interact2-facts.json`). 터치에는 툴팁이 없어서 아이콘 뜻을 알 방법이 없습니다.

## 화면 구조 문제

**M-07 그래프: 375px에서 캔버스가 잘리고 레일이 사라짐** [검증][코드]
- 그래프 페이지는 `.workspace-wide { height: calc(100vh - var(--top-h)); overflow: hidden; }`로 화면 높이에 고정됩니다(`src/styles.css:886-895`). ≤768px에서는 캔버스가 `height: 60vh; min-height: 360px`이 됩니다(`src/styles.css:7144-7147`).
- 375×812에서 캔버스는 y=426에서 시작해 높이 503, 하단 929입니다. 화면 높이 812를 117px 넘고, 위로 밀어도 스크롤이 0에서 움직이지 않았습니다(`interact-facts.json` "375 graph clip"과 "swipe", `shots/375-ko-light-graph.png`, `shots/i/375-graph-after-swipe.png`).
- 캔버스 위 426px는 제목, 찾기 입력칸과 아이콘 8개(2줄), 질문 세그먼트(가로 스크롤 465/349), 크기 세그먼트와 체크박스, "씬 재빌드 3회 · 2652.8 ms" 성능 칩, 3줄 통계 문장이 차지합니다(`shots/375-ko-light-graph.png`).
- ≤820px에서 프레임이 레일을 `auto` 행으로 쌓는데(`src/styles/ui.css:411-433`), 375px에서는 두 `section.u-rail`의 높이가 0(50/0, 166/0)이었습니다(`interact-facts.json`). 접기·펼치기 컨트롤은 ≤820px에서 의도적으로 숨깁니다(`src/styles.css:4399-4406`). 그래서 폰과 iPad 세로에서는 '빈 곳(Gaps)'과 '범례'를 쓸 수 없습니다.
- 820×1180에서는 레일 두 개가 각각 높이 17px 띠로 남고, 헤더 글자가 위아래로 반쯤 잘려 보입니다(레일 y=358 h=17, y=1147 h=17, `shots/crops/820-graph-railbar.png`, `shots/820-ko-light-graph.png`).
- 375px에서 ≡ 서랍을 열면 캔버스 위를 351×422로 전부 덮습니다(`shots/i/375-graph-drawer.png`).

**M-08 그래프 레일 행 액션이 터치에서 잘림 (iPad 가로)** [검증][코드]
- 터치 환경(`hover: none`)에서는 행 액션을 늘 보이게 합니다(`src/styles/ui.css:834-841`). 그런데 그래프 레일 폭은 216px이고(`src/styles.css:4219-4221`) 액션 띠는 행 위에 절대 위치로 겹칩니다(`src/styles/ui.css:798-808`).
- 1180×820 터치에서 레일 오른쪽 끝은 496인데 세 번째 버튼 "want"(수확 대상으로)가 468-523에 있어 27px 잘립니다. 노트 이름은 액션 띠에 가려 "CLAUDE", "welcom" 정도만 보입니다(`probe3.mjs` 출력, `shots/crops/1180-graph-gaps.png`). 버튼은 49×32입니다.

**M-09 그래프 핀치 줌이 불안정** [검증, 합성 터치라 확정 아님][코드]
- 카메라는 OrbitControls 기본값을 그대로 씁니다(`src/lib/graphScene.ts:1391-1404`). 그래프 코드 안에 터치 전용 처리는 찾지 못했습니다. 캔버스에는 `touch-action: none`이 있습니다(`src/styles.css:5018-5024`).
- CDP `Input.dispatchTouchEvent`로 두 손가락 핀치를 합성했더니 결과가 일정하지 않았습니다. 375px에서 벌리기는 거리 1072.3이 그대로였고 오므리기는 6178.8로 크게 튀었으며, 820px에서는 네 번 모두 변화가 없었습니다(`pinch.mjs` 출력). 한 손가락 드래그는 회전으로 동작했습니다(x -32.8에서 -817.4, `interact-facts.json`). +/- 버튼은 동작했습니다(8323.1에서 6658.5).
- 노드를 탭하면 인스펙터가 열렸습니다(375, 820 모두 `true`). 마우스를 올렸을 때의 이웃 강조는 터치에서 대신할 방법이 없습니다(`src/lib/graphScene.ts:149-150, 1288-1293`).
- 판단: 실기기(iPad Safari나 Tauri iOS)에서 다시 재야 합니다. 합성 이벤트의 한계일 수도 있습니다.

**M-10 노트 정보 레일이 폰에서 본문을 덮고 속성 값이 잘림** [검증][코드]
- 본문이 41.5rem보다 좁으면 레일이 서랍이 됩니다(`src/lib/readerRail.ts:334-344`). 서랍은 본문 오른쪽 위에 `width: min(18rem, 90%)`로 겹칩니다(`src/styles.css:9911-9923`).
- 375px에서 레일은 x=75, 폭 288로 본문의 82%를 덮고, 높이는 1849로 화면을 넘어갑니다(`interact-facts.json`, `shots/i/375-note-info.png`).
- 속성 행은 `grid-template-columns: 140px 1fr auto`라서(`src/styles.css:9432-9438`) 288px 서랍에서 값 칸이 약 56px만 남습니다. 화면에는 "Atter", "tech", "high", "acti"까지만 보이고 태그 칩은 "techni/que"로 두 줄이 됩니다(`shots/i/375-note-info.png`).
- 820px에서는 레일을 열면 사이드바가 접힙니다(`src/pages/PageReader.tsx:200-208`). 이때는 레일이 본문 옆에 나란히 섭니다(`shots/i/820-note-info.png`). 그 상태에서 사이드바를 다시 열면 레일이 본문 글자를 가립니다("Attention Mecl", `shots/i/820-sidebar-toggled.png`).

**M-11 상단바가 폰에서 옆으로 숨음** [검증][코드]
- ≤768px 상단바는 `overflow-x: auto`로 한 줄을 유지합니다(`src/styles.css:7083-7096`). 375px에서 내용 폭은 591px(설정 551, 노트 720)이라 검색 pill은 일부만 보이고 모델 칩(391-579)은 화면 밖에 있습니다(`interact-facts.json` "375 topbar children").
- 끝까지 밀어야 모델 칩이 보입니다(`shots/i/375-topbar-scrolled-end.png`). 숨은 컨트롤이 있다는 표시가 없습니다.
- 터치 기기에서도 `⌘K` 키 칩을 그립니다(`shots/375-ko-light-overview.png`, `shots/820-ko-light-overview.png`). 분할 화면 버튼도 375px에서 나오며, 누르면 383px짜리 패널 두 개가 위아래로 쌓입니다(`shots/i/375-split.png`, 분기 `src/App.tsx:117`).

**M-12 iPad는 터치 기준을 받지 못함** [검증][코드]
- 44px 규칙(`.nav-item`, `.nav-leaf`, `.qbtn`, `.icon-btn`, `.ngl-add`)은 `@media (max-width: 768px)` 안에만 있습니다(`src/styles.css:7166-7182`). `(any-pointer: coarse)`에는 사이드바 행 높이 하나만 걸려 있습니다(`src/styles.css:7057-7061`).
- 그래서 820과 1180 터치 환경에서 상단바 뒤로/앞으로는 26×26, 사이드바 토글은 28×28, + 새 노트는 71×22, 기록상 사람만은 82×23입니다(`metrics-820.json`, `metrics-1180.json`).
- 820px에서는 240px 사이드바가 늘 떠 있어 본문이 580px로 줄어듭니다(`interact-facts.json` "820 after toggle", `shots/820-ko-light-overview.png`).

**M-13 사이드바 서랍(375)** [검증]
- 잘 되는 점: 토글로 열면 폭 240, 스크림이 깔리고, 내비게이션 항목을 탭하면 닫힙니다(`collapsed=true`). 행은 모두 223×44입니다(`interact-facts.json`, `shots/i/375-sidebar-open.png`).
- 부족한 점: 왼쪽 가장자리를 밀어도 열리지 않습니다(`edge-swipe opens sidebar? false`). 하단 고정 영역(설정, 볼트 상태, 재인덱스 배너)이 커서 노트 트리가 보이는 높이가 약 1행입니다("최근 수정" 아래 행이 잘림, `shots/i/375-sidebar-open.png`). 고장 시뮬레이션 110×28, 지금 재인덱스 72×18도 작습니다.

**M-14 페이지별로 좁은 폭에서 깨지는 곳** [검증]
- 할 일 입력: 제목 입력, 날짜 선택, 자세히, 추가를 줄바꿈 없는 한 줄에 넣어서(`src/components/TaskComposer.tsx:127-162`) 375px에서 제목 입력칸이 35×30이 되고 placeholder가 "무엇을"까지만 보입니다(`metrics-375.json`, `shots/375-ko-light-tasks-full.png`). 날짜 버튼은 150px을 차지합니다.
- 할 일 목록: 제목이 "provenance p…"처럼 잘리는데, 출처 열은 820px에서도 "m…", "t.."입니다(`shots/375-ko-light-tasks-full.png`, `shots/820-en-dark-tasks.png`).
- 할 일 캘린더: 375px에서 칸 폭이 약 46px이라 칩이 "pr…", "ad…"가 되고 여러 날 걸친 막대가 칸을 넘칩니다(`shots/i/375-tasks-캘린더.png`). 보드는 열이 세로로 쌓여 읽을 만합니다(`shots/i/375-tasks-보드.png`).
- 히스토리: 실행 id가 "digest-/1755740000"으로, 보고서 제목이 "2026-/07-15-/attention" 세 줄로 접히고 버튼이 카드 오른쪽 끝에 붙습니다. 펼치기 버튼은 13×13입니다(`shots/375-ko-light-history.png`).
- 출처: 페이지 이름이 "transform…"으로 잘리는데, 막대, 퍼센트, "임계값 미만" 배지는 고정 폭을 차지합니다(`shots/crops/375-ko-light-provenance-full-0.png`).
- 설정: 모델 선택 3개가 한 줄이라 제공자 select가 67px, 표시가 "Claud"입니다(`shots/crops/375-ko-light-settings-full-0.png`).
- 질문: 입력칸이 페이지 위에 있어서 답이 길어지면 입력칸이 화면 밖으로 밀려납니다(`shots/i/375-query-answer.png`). 세그먼트 버튼은 26px 높이입니다.

**M-15 에디터의 슬래시 메뉴와 표 (진행 중 스펙에 넘길 제약)** [검증]
- 슬래시 메뉴는 375px에서 caret 아래 279×310으로 뜨고 행은 28px입니다(27개 항목, `shots/i/375-slash.png`). 소프트 키보드가 올라오면 화면 아래쪽 절반이 가려지므로 메뉴가 키보드 뒤에 놓일 가능성이 큽니다 [추론].
- 표는 375px에서 348px 폭으로 들어맞습니다(2열, 셀 263/83, `shots/i/375-table-rendered.png`). 셀을 탭하면 표 위젯이 사라지고 `| … |` 원문으로 바뀝니다(`table still rendered? false`). 셀 이동은 Tab입니다.
- `2026-10-01-notion-blocks-one-editor.md`에는 touch나 mobile 언급이 없습니다(grep 결과 0건). 표와 블록 패널 작업에 "터치로 셀 편집, Tab 없는 셀 이동"을 수용 조건으로 넣을 것을 권합니다. 새 기능을 다시 제안하는 것이 아니라 진행 중인 작업의 조건으로 넘깁니다.

**M-16 모달과 소프트 키보드** [코드][추론]
- 모달 배경은 `align-items: center`로 화면 가운데에 띄웁니다(`src/styles.css:3262-3270`). 375px에서 새 노트 대화상자는 y≈310-505, 폭 351입니다(`shots/i/375-newnote.png`). iPhone 키보드가 올라오면 입력칸과 버튼이 키보드 뒤로 갈 수 있습니다 [추론].
- 사이드바에서 새 노트를 열면 서랍이 뒤에 열린 채 남습니다(`shots/i/375-newnote.png`).
- `.myco-modal { min-width: 360px }`(`src/styles.css:3271-3278`)는 ≤375px에서만 풀립니다(`src/styles.css:7198-7203`). 376-392px 폭에서는 좌우 여백이 16px 아래로 줄어듭니다 [코드, 320px과 그 사이 폭은 측정하지 않음].
- 명령 팔레트(345×548), 모델 칩 팝오버(340×196), 도움말(320×323), ⋯ 메뉴(180×387)는 375px 안에 들어갔습니다(`interact-facts.json`).

**M-17 안전 영역과 고정 요소** [코드][검증]
- `index.html:5`의 viewport는 `width=device-width, initial-scale=1.0`뿐이고 `viewport-fit=cover`가 없습니다. 이 상태에서 iOS는 `env(safe-area-inset-*)`를 0으로 줍니다 [추론, 플랫폼 동작]. 그래서 상단바의 `env(safe-area-inset-top)` 처리(`src/styles.css:7088-7091`)도 실제로는 효과가 없습니다.
- 그 밖의 fixed 요소는 안전 영역을 쓰지 않습니다. 도움말 버튼은 `right:18px; bottom:18px`(`src/styles.css:8248-8254`), 사이드바는 `height: 100vh`입니다(`src/styles.css:7096-7104`). 375px에서 측정한 fixed 요소는 sidebar, notice-stack(top 52), help-widget__fab(bottom 18)입니다(`probe2.mjs`).
- 도움말 버튼(34×34)은 여러 화면에서 내용을 가립니다. 질문 제안 화살표, 할 일 행, 설정 입력, 인제스트 textarea 모서리가 그렇습니다(`shots/375-ko-light-query-full.png`, `shots/375-ko-light-tasks-full.png`, `shots/crops/375-ko-light-settings-full-0.png`).
- `100vh`는 `src/styles.css`에 9번 나오고 `dvh`/`svh`는 0번입니다. 주소창이 있는 모바일 브라우저에서는 바닥이 가려집니다 [추론]. Tauri iOS 전체 화면 WebView라면 영향이 작습니다.

**M-18 입력칸 글꼴 14px** [검증][추론]
- `.input, .textarea, .select`는 `font-size: 14px`입니다(`src/styles.css:2809-2821`). 그래프 찾기 입력도 14px입니다(`src/styles.css:4802-4812`). 할 일, 그래프 찾기, 설정 11개 필드, 인제스트 3개 필드가 14px 이하로 측정됐습니다(`probe2.mjs`). 홈 입력과 질문 입력은 16px입니다.
- iOS WebKit은 16px 미만 입력칸에 포커스가 가면 화면을 확대합니다 [추론, 플랫폼 동작, 이 세션에서 WebKit으로 확인하지 않음].

## 다른 앱의 모바일 패턴 (Mobbin)

myco의 빈칸과 직접 맞닿는 화면만 골랐습니다. 아래 URL은 이번에 실제로 받아 본 화면입니다.

| myco의 빈칸 | 다른 앱의 방식 | 근거 |
|---|---|---|
| Tab 없는 들여쓰기, 블록 메뉴 진입 (M-02) | Notion iOS는 키보드 위 막대에 내어쓰기, 들여쓰기, 위로, 아래로, +(블록 추가), Aa를 둡니다. +를 누르면 키보드 자리에 2열 블록 목록이 열립니다. | [23ebacc5](https://mobbin.com/screens/23ebacc5-4ddd-4afc-ae8e-3a07063e80cd), [b689e6c5](https://mobbin.com/screens/b689e6c5-62b4-48e9-83d0-76cc61b9966e) |
| 선택 영역 서식 (⌘B 등) | Notion iOS는 텍스트를 선택하면 키보드 막대가 B, I, U, S, 링크, 코드, 수식으로 바뀝니다. | [39700986](https://mobbin.com/screens/39700986-5ab0-4ed9-b654-5d1a6ac92f38), [011e1303](https://mobbin.com/screens/011e1303-32b9-4882-8d28-71b5b233c517) |
| 위키링크 입력과 마크다운 서식 | Obsidian iOS는 키보드 위 막대에 실행 취소, 다시 실행, `[ ]`(링크), 파일, 태그, 첨부, H, B를 두고, 넘기면 B, I, S, 형광펜, 코드, 인용, 링크, 목록이 나옵니다. `[[` 제안은 caret 바로 아래 작은 팝오버로 뜹니다. | [2092380b](https://mobbin.com/screens/2092380b-d5a6-48c2-910a-671dd80ed973), [9141117b](https://mobbin.com/screens/9141117b-2677-4c5b-8fdf-98faecaefb87), [648fdde3](https://mobbin.com/screens/648fdde3-4975-40ba-a8d8-c9eec6fb5c0a) |
| 우클릭 전용 파일 작업 (M-05) | Obsidian iOS는 파일을 길게 누르면 아래에서 시트가 올라와 새 탭에서 열기, 복제, 이동, 북마크, 경로 복사, 버전 기록, 공유를 보여 줍니다. | [5964c921](https://mobbin.com/screens/5964c921-3ae7-4f36-9fcb-81f8df0ee624) |
| 사이드바 서랍 (M-13) | Obsidian iOS 서랍은 목록 아래에 새 노트, 새 폴더, 정렬, 접기 아이콘 줄을 두고, 그 아래 보기 전환과 볼트 이름, 설정을 둡니다. | [4eecb022](https://mobbin.com/screens/4eecb022-3a53-4ff9-9642-41fd637999ae), [b932b2a2](https://mobbin.com/screens/b932b2a2-f404-45ae-a0d1-1b3aab5bed62) |
| 숨은 상단바 컨트롤 (M-11) | Obsidian iOS는 노트와 그래프 화면 아래에 뒤로, 앞으로, 검색, +, 탭 수, ≡ 막대를 띄우고 위에는 제목과 ⋯만 둡니다. | [06a17971](https://mobbin.com/screens/06a17971-bcd0-445d-a6aa-bc50c5c62c2b), [4712f33b](https://mobbin.com/screens/4712f33b-ad9e-4b86-bd91-7f49219d0ced) |
| 홈 질문과 ⌘Enter 적기 (M-04) | Notion iOS 홈과 페이지 화면 바닥에는 검색 버튼, 마이크가 붙은 "Ask AI" 입력, 새 페이지 버튼이 늘 떠 있습니다. | [e7689c02](https://mobbin.com/screens/e7689c02-0bc0-49f7-bc5c-71f516844d33), [c25d9bc0](https://mobbin.com/screens/c25d9bc0-5aa2-4c6e-89a1-71d3e6c6c6b4) |
| 그래프 화면의 426px 머리 (M-07) | Obsidian iOS 그래프는 캔버스가 화면 전체를 쓰고, 설정은 캔버스 위 접이식 패널(Filters, Groups, Display, Forces)로 겹칩니다. | [750d7b56](https://mobbin.com/screens/750d7b56-5e9f-45d3-a43e-9160b4181c3c), [a4e27535](https://mobbin.com/screens/a4e27535-090f-40de-81c2-fa8e83703b8b) |

## 개선 제안

진행 중인 두 스펙(노션 표·블록 패널, 그래프 woven·시각 규칙)과 이미 끝낸 백로그 S1-S12, 블록 에디터 0-6단계는 다시 제안하지 않았습니다. 크기는 S(하루 안), M(며칠), L(한 주 이상)로 어림했습니다.

### 1단계: iPad와 터치 노트북에서 막힌 기능 풀기

| ID | 제안 | 해결하는 문제 | 크기 |
|---|---|---|---|
| P-01 | 포인터가 터치(`pointerType === "touch"`)일 때는 수정키 없이 링크를 엽니다. caret을 링크 안에 두는 편집은 키보드 막대(P-02)나 길게 누르기로 옮깁니다. | M-01 | S |
| P-02 | 소프트 키보드 위에 막대를 하나 둡니다. 실행 취소, 다시 실행, `[[`, 들여쓰기, 내어쓰기, 블록 위/아래, + 블록, 블록 메뉴(⋮⋮)를 넣고, 선택 중에는 서식 버튼으로 바꿉니다(Notion [23ebacc5](https://mobbin.com/screens/23ebacc5-4ddd-4afc-ae8e-3a07063e80cd), Obsidian [2092380b](https://mobbin.com/screens/2092380b-d5a6-48c2-910a-671dd80ed973)). 블록 메뉴에는 들여쓰기와 내어쓰기 항목도 더합니다(`src/lib/editorBlockOps.ts:460-499`). | M-02, M-06 | M |
| P-03 | 보드 카드와 캘린더 막대는 길게 눌러(약 300ms) 집고, 그동안만 `touch-action: none`을 켭니다. 손잡이를 따로 두는 방법도 있습니다. | M-03 | S-M |
| P-04 | 44px 규칙을 `(any-pointer: coarse)`에도 적용하고(`src/styles.css:7166-7182`), 정밀 포인터가 없으면 `⌘K` 칩과 단축키 힌트를 숨깁니다. | M-11, M-12 | S |
| P-05 | 터치에서는 그래프 레일 행 액션을 행 아래 줄로 내리거나 ⋯ 하나로 묶습니다(`src/styles/ui.css:834-841`). | M-08 | S |
| P-06 | `viewport-fit=cover`를 넣고(`index.html:5`) 하단 fixed 요소에 `env(safe-area-inset-bottom)`을 더합니다. 입력칸은 터치에서 16px 이상으로 올립니다(`src/styles.css:2809-2821, 4802-4812`). | M-17, M-18 | S |

### 2단계: 폰 폭 레이아웃 정리

| ID | 제안 | 해결하는 문제 | 크기 |
|---|---|---|---|
| P-07 | ≤768px 그래프는 캔버스를 화면 전체로 쓰고, 찾기·질문 세그먼트·설정은 캔버스 위 떠 있는 패널이나 아래 시트로 옮깁니다(Obsidian [750d7b56](https://mobbin.com/screens/750d7b56-5e9f-45d3-a43e-9160b4181c3c)). '빈 곳'과 범례는 시트 탭으로 되살립니다. 성능 칩은 개발 모드에서만 보입니다. | M-07 | M |
| P-08 | 상단바를 위에는 ☰, 제목, ⋯만 남기고, 뒤로, 앞으로, 검색, 새 노트는 아래 막대로 옮깁니다(Obsidian [06a17971](https://mobbin.com/screens/06a17971-bcd0-445d-a6aa-bc50c5c62c2b)). 분할 화면 버튼은 ≤820px에서 숨깁니다. | M-11 | M |
| P-09 | 아래 막대 가운데에 "질문하거나 적기" 입력을 늘 띄우고, 적기를 ⌘Enter 대신 눈에 보이는 버튼으로 만듭니다(Notion [e7689c02](https://mobbin.com/screens/e7689c02-0bc0-49f7-bc5c-71f516844d33)). myco는 질문과 캡처가 핵심이라 이 자리가 가장 잘 맞습니다. 홈의 `autoFocus`는 터치에서 끕니다(`src/pages/PageOverview.tsx:360`). | M-04 | M |
| P-10 | 노트 정보는 ≤768px에서 아래 시트로 열고, 속성 행은 키 위에 값을 쌓는 1열로 바꿉니다(`src/styles.css:9432-9438`). | M-10 | S-M |
| P-11 | 파일 작업은 트리 행 길게 누르기와 행의 ⋯ 버튼으로 아래 시트를 엽니다(Obsidian [5964c921](https://mobbin.com/screens/5964c921-3ae7-4f36-9fcb-81f8df0ee624)). 서랍 하단 고정 영역은 접어서 트리 높이를 돌려줍니다. | M-05, M-13 | M |
| P-12 | 할 일 입력은 375px에서 두 줄(제목 / 날짜·자세히·추가)로 감싸고, 캘린더는 ≤480px에서 주간이나 목록 보기로 바꿉니다. 히스토리, 출처, 설정 모델 행은 좁은 폭에서 세로로 쌓습니다. | M-14 | S-M |
| P-13 | 모달은 ≤768px에서 아래 시트로 띄우고 `visualViewport` 높이에 맞춥니다. 슬래시 메뉴도 키보드 위 시트로 엽니다(Notion [23ebacc5](https://mobbin.com/screens/23ebacc5-4ddd-4afc-ae8e-3a07063e80cd)). | M-15, M-16 | M |

### 3단계: 모바일 앱의 범위

- 사실 [코드]: Tauri 쪽에 모바일 진입점이 없습니다(`src-tauri/src/lib.rs`에 `mobile_entry_point` 없음). `src-tauri/gen/schemas`에는 `desktop-schema.json`, `macOS-schema.json`만 있습니다. tray-icon, macos-private-api, global-shortcut 같은 데스크톱 기능에 의존합니다(`src-tauri/Cargo.toml:22, 69`).
- 사실 [코드]: `std::process::Command`를 쓰는 Rust 모듈이 15개입니다(claude.rs, cli_agent.rs, commands.rs, crash.rs, diarize.rs, distill.rs, extract.rs, git_log.rs, index_updater.rs, mcp_native.rs, ollama.rs, schedules.rs, tray.rs, vault_history.rs, whisper.rs). 설정의 기본 모델도 "Claude Code (CLI)"입니다(`shots/crops/375-ko-light-settings-full-0.png`).
- 추론: iOS 샌드박스에서는 외부 프로세스를 띄울 수 없으므로 CLI 제공자, 로컬 Ollama, whisper 전사, git 기록, MCP 서버 호스팅은 폰에서 그대로 옮길 수 없습니다.
- 권하는 순서는 다음과 같습니다.
  1. 1단계를 먼저 끝내서 터치 노트북과 iPad(데스크톱 앱이나 원격 화면)에서 막히는 일을 없앱니다.
  2. 폰 앱은 "읽기, 링크 따라가기, 빠른 캡처, 질문"으로 범위를 좁힙니다. 질문은 HTTP 제공자로만 보내고, 인제스트와 정리는 데스크톱이 맡습니다. 볼트는 평범한 마크다운 파일이라 동기화는 사용자가 이미 쓰는 iCloud나 Obsidian Sync 폴더에 맡길 수 있습니다 [추론, 검증하지 않음].
  3. 2단계 레이아웃은 그 폰 셸과 같은 웹 코드에 들어가므로 데스크톱 좁은 창에서도 이득을 봅니다.
- 결정이 필요한 점: 폰에서 Ask를 무엇으로 돌릴지(사용자 API 키를 쓰는 HTTP 제공자인지, 데스크톱에 원격으로 붙는지)는 주인이 정해야 합니다. 이 결정 없이 폰 앱 범위를 확정할 수 없습니다.

## 잘 되는 점

- 88개 조합 모두 문서 가로 스크롤이 없습니다. `.app`이 `minmax(0, 1fr)` 열을 쓰고 상단바와 설정 칩 줄이 내부 스크롤로 넘침을 받기 때문입니다(`src/styles.css:7063-7082`) [검증].
- ≤768px 오프캔버스 사이드바, 스크림, 경로 이동 시 자동 닫힘이 동작합니다(`src/App.tsx:517-535`, `shots/i/375-sidebar-open.png`) [검증].
- ⋯ 메뉴, 명령 팔레트, 모델 팝오버, 도움말은 375px 안에 들어가고 ⋯ 메뉴 행은 44px입니다 [검증].
- 할 일 보드는 375px에서 열이 세로로 쌓이고, 학습 복습 카드와 정리 제안 카드는 폰에서도 읽기 좋습니다(`shots/i/375-tasks-보드.png`, `shots/i/375-study-review.png`, `shots/375-ko-light-feedback.png`) [검증].
- 그래프 노드 탭이 인스펙터를 엽니다. 터치에서 레일 행 액션을 보이게 하는 `(hover: none)` 처리도 이미 있습니다. 다만 M-08처럼 216px 안에 다 들어가지 않습니다 [검증].

## 검증하지 못한 것

- iOS WebKit과 실기기에서는 확인하지 않았습니다. 이번 측정은 모두 Chromium 터치 에뮬레이션입니다. WebKit 바이너리(`webkit-2287`)는 설치돼 있지만 과제 지시대로 Chromium만 썼습니다.
- 소프트 키보드를 띄울 수 없어서 M-15 슬래시 메뉴, M-16 모달, M-04 autoFocus 키보드는 추론입니다.
- 핀치 줌(M-09)은 CDP 합성 터치로만 쟀고 결과가 일정하지 않았습니다. 실기기에서 다시 재야 합니다.
- 노치와 홈 인디케이터 같은 안전 영역은 Chromium에서 흉내 낼 수 없어서 코드로만 판단했습니다(M-17).
- 길게 누르기가 `contextmenu`를 보내는지(M-05)와 16px 미만 입력의 확대(M-18)는 플랫폼 지식에 기댄 추론입니다.
- 320px 폭, 폰 가로 방향, ja 언어, 시스템 테마는 측정하지 않았습니다.
- `?mock=1` 볼트에는 wiki 위주의 데이터만 있어서 sessions, raw, _inbox, PDF 보기, 오디오 개요, 에이전트 패널, 온보딩 마법사는 폰 폭에서 따로 열어 보지 않았습니다.
- 표(M-15)는 2열로만 시험했습니다. 열이 많은 표가 375px에서 어떻게 넘치는지는 재지 않았습니다.
