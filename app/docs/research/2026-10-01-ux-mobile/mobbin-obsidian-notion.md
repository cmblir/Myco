# Mobbin 리서치 — Obsidian · Notion (웹 + iOS) → myco 전체 사용성과 모바일

- 조사일: 2026-10-01. 키: `mobbin-obsidian-notion`
- Mobbin 검색 28회: flows 5회, screens 23회. iOS 25회, web 3회. `task_intent`는 모든 호출에서 같은 값을 썼다: "Compare Obsidian and Notion desktop and mobile UX to plan whole-app usability and a mobile version for a local-first knowledge wiki app"
- 비교 기준 코드: `~/prj/karpathy-editor-build/app` (branch `feat/permit-editor-ux`, HEAD `d3f82ce`). 읽기만 했고, 저장소에는 아무것도 쓰지 않았다.
- myco 폰 화면 캡처: `shots/oxn/*.png` (이 파일과 같은 폴더 기준). Playwright WebKit에 `devices["iPhone 13"]` 설정(CSS 뷰포트 390×664, 터치), `?mock=1` dev 서버(:6300), 한국어 UI로 찍었다. 스크립트는 `phone-shots.mjs`, `slash-shot.mjs`, `measure-drawer.mjs`(같은 폴더)이다.
  - 이 캡처의 한계: 실제 기기가 아니고 소프트 키보드가 뜨지 않는다. 데이터는 mock 볼트이다. 터치 결과는 Playwright `tap()` 기준이다.
- 표기 규칙: **[검증]**은 이번에 직접 보거나 실행한 것, **[추론]**은 근거에서 끌어낸 판단, **[미확인]**은 확인하지 못한 것이다.

## 0. Mobbin 커버리지 한계

| 찾으려던 것 | 결과 |
|---|---|
| Obsidian 데스크톱/웹 | Mobbin에는 Obsidian이 **iOS로만** 있다(이전 보고서 `mobbin-obsidian.md`와 같다). 데스크톱 패턴은 이전 보고서를 참조했다. |
| Android | Mobbin MCP의 platform 값은 `ios`와 `web`뿐이다. Android 화면은 하나도 보지 못했다. 이 문서의 모바일 제안은 iOS 근거에만 기반한다. |
| 다른 앱에서 "공유" → 볼트/페이지로 저장(share extension) | 실제 공유 시트 화면은 없었다. 대신 Notion iOS 온보딩 팁 화면이 share extension 모형을 보여준다([f999e32c](https://mobbin.com/screens/f999e32c-f6d8-4251-846b-2da3a4d3df2d)). Obsidian은 관련 화면이 없다. |
| Obsidian 동기화 상태 표시 | "Setup Sync — You don't have any remote vaults." 빈 화면만 있다([2b88be24](https://mobbin.com/screens/2b88be24-d77e-4341-8645-dbf66e3bbc81)). 오른쪽 드로어 하단의 빨간 아이콘은 동기화 상태로 보이지만 라벨이 없어 **[추론]**으로 둔다. |
| Notion 모바일에서 `/` 입력 | 키보드 위 `+` 버튼이 슬래시 메뉴를 대신한다. 타이핑한 `/` 팝업 화면은 결과에 없었다. |
| Notion 모바일 페이지 백링크 목록 | 페이지 상단의 "↙ 1 backlink" 칩만 확인했다(flow [8f00f15f](https://mobbin.com/flows/8f00f15f-374f-4255-8f79-73d17ac45dd8)의 마지막 미리보기). 칩을 탭한 뒤의 목록 화면은 없었다. |

## 1. 핵심 결론

1. **모바일 셸은 엄지 영역 하단 바와 드로어를 함께 쓴다.** Obsidian iOS는 떠 있는 하단 바(‹ › 검색 + 탭수 ☰)와 좌우 드로어를 쓴다. Notion iOS는 하단 바(검색 | Ask AI 필 + 마이크 | 작성)와 상단 세그먼트(Home/Chats/Calendar/Inbox)를 쓴다. myco는 ≤768px에서 사이드바를 오프캔버스 드로어로 바꾼다. 하지만 모든 동작이 상단 한 줄(가로 스크롤 590px/390px)에 몰려 있고 하단 바가 없다. **[검증]**
2. **피커 입력창은 키보드 바로 위에 있다.** Obsidian 모바일의 빠른 전환기, 명령 팔레트, 템플릿·폴더 선택은 모두 입력창을 화면 아래, 결과를 그 위에 둔다. Notion 검색도 하단 입력창이다. myco ⌘K는 입력창이 위(top=106px)에 있고, 푸터에 `↑↓ ↵ ⌥↵ esc` 키 힌트를 그대로 보여준다. **[검증]**
3. **모바일 에디터의 핵심은 키보드 위 도구 막대이다.** Obsidian은 설정에서 바꿀 수 있는 가로 스크롤 명령 막대를 쓴다. Notion은 맥락에 따라 바뀌는 막대(제목/본문/선택/표 셀)를 쓰고, `+`를 누르면 키보드 자리에 2열 블록 타일 패널이 열린다. myco의 서식은 `Mod-b/i/e/k` 키뿐이고(`lib/editorFormat.ts:576-580`), 블록 핸들은 마우스 호버로만 나타난다(`lib/editorBlockHandle.ts:76-88`). 탭한 뒤에도 핸들은 `hidden`이었다(측정). **[검증]**
4. **모든 `···`와 길게 누르기 메뉴는 하단 시트로 열린다.** 두 앱 모두 그룹 카드 안에 파괴적 항목을 빨간색으로 두고, 시트 머리나 꼬리에 메타(수정 시각, 단어 수)를 둔다. myco는 드롭다운 메뉴(`PageReader.tsx:1022`)와 우클릭 전용 컨텍스트 메뉴(`SidebarTree.tsx:58,89`)를 쓴다. **[검증]**
5. **"작성"과 "질문"은 두 개의 보이는 버튼이다.** Notion iOS는 Ask AI 필과 작성 버튼을 나란히 둔다. myco 홈의 "오늘의 노트에 적기"는 `⌘/Ctrl+Enter`로만 실행된다(`PageOverview.tsx:361-366`). 키보드 단축키를 모르는 일반 사용자는 데스크톱에서도 이 기능을 찾지 못하고, 폰에서는 아예 실행할 수 없다. **[검증]** 이번 라운드에서 비용 대비 효과가 가장 큰 단일 수정이다.
6. **오프라인과 동기화는 상태 문구로 보여준다.** Notion은 "Working offline · Last sync on …" 토스트, 브레드크럼의 "Offline" 칩, 페이지별 "Available offline" 토글, 오프라인 페이지 목록의 "Downloading…"을 쓴다. Obsidian은 볼트를 만들 때 "Store in iCloud — This cannot be changed later."로 위치를 묻는다. myco는 로컬 앱이라 "저장됨/저장 대기 중"만 있으면 된다(`PageReader.tsx:904-911`). 모바일로 가면 **볼트가 어디 사는가**가 첫 결정이 된다. **[검증]**(근거), **[추론]**(결론)
7. **Tauri 모바일 빌드는 아직 준비되지 않았다.** `lib.rs:114 pub fn run()`에 `mobile_entry_point` 속성이 없다(grep 0건). 번들 타깃은 `dmg`/`nsis`뿐이고(`tauri.conf.json:36`), 창 `minWidth: 800`(`tauri.conf.json:20`)이다. 기본 질문 경로는 `claude` CLI 프로세스를 띄우는 방식이다(`src-tauri/src/claude.rs:101,304,684`). iOS 샌드박스는 외부 프로세스 실행을 허용하지 않는다. **[검증]**(코드), **[추론]**(플랫폼 제약)

---

## 2. myco 현재 상태, 폰 폭(390px) 실측

| 영역 | 증거 | 관찰 |
|---|---|---|
| 셸 | `styles.css:7057-7140`, `App.tsx:521-535`, `shots/oxn/02-home.png` | ≤768px에서 사이드바가 오프캔버스로 바뀌고 이동하면 자동으로 닫힌다. 상단 바는 한 줄 가로 스크롤이다. |
| 상단 바 폭 | `phone-shots.mjs` 측정: `clientWidth 390 / scrollWidth 590` | 사이드바, ←, →, 브레드크럼, 분할 보기(28×28), 검색 필(73×28, ⌘K), 모델 칩(188px)이 한 줄에 있다. 모델 칩은 화면 밖(x=391)에 있다. 폰에서 쓸 수 없는 **분할 보기** 버튼이 그대로 보인다(`Topbar.tsx:98`). |
| 드로어 | `measure-drawer.mjs` 측정, `shots/oxn/03-drawer.png` | 드로어 폭은 240px이다. 고정 영역(head 57 + quick 102 + tools 53 + status 131 = **343px**)이 664px의 절반 이상을 차지한다. 스크롤되는 목록은 321px 창에 1213px 콘텐츠가 들어 있다. 경계에서 "더 보기" 행이 잘려 보인다. 검색 행에 `⌘K` 칩이 보인다(`Sidebar.tsx:292`). |
| 홈 | `PageOverview.tsx:352-369`, `shots/oxn/02-home.png` | 입력 placeholder가 두 줄로 넘쳐 잘린다("…적어 보세 / 요"). 힌트 "Enter 질문하기 · ⌘Enter 오늘의 노트에 적기"가 폰에서도 보인다. "적기"를 실행할 버튼이 없다. |
| 도움말 FAB | `styles.css:8248-8256` | `position: fixed; right/bottom: 18px; 34×34px`이다. 44px보다 작고 safe-area를 반영하지 않는다. 질문 빈 상태 문구, 자료 추가 입력란과 겹친다(`04-ask.png`, `06-ingest.png`). |
| ⌘K | `CommandBar.tsx:656-670`, `shots/oxn/11-cmdk.png` | 입력창이 위(top 106px)에 있다. placeholder가 "…path:, tag:, ty…"에서 잘린다. 푸터에 키 힌트 4개가 보인다. 뷰 안에서 44px 미만인 탭 대상이 19개다(측정). |
| 에디터: 블록 핸들 | `lib/editorBlockHandle.ts:46,76-88`, `09-reader-focused.png` | 핸들은 `pointermove`로만 배치되고 폭은 20px(`HANDLE_W`)이다. 본문을 탭한 뒤 `hidden: true`로 남았다(측정). 다른 진입점은 `Mod-/`(29-44)뿐이다. |
| 에디터: 서식 | `lib/editorFormat.ts:576-580` | 서식은 `Mod-b`, `Mod-i`, `Mod-e`, `Mod-k` 키로만 넣는다. 선택 영역 툴바는 없다(`bubble|formatbar` grep에서 에디터 쪽 0건). |
| 에디터: `/` 팝업 | `shots/oxn/12-slash.png` | 캐럿 위쪽에 열린다(top 54, 높이 310). 행 높이 **28px**, 27행이다. |
| 에디터: `[[` 팝업 | `components/Editor.tsx:838-870`, `13-wikilink.png` | 행 높이 **19px**, 폭 373px로 화면 오른쪽 끝까지 닿는다. 각 행은 CodeMirror 기본 `abc` 아이콘(`type: "text"`)과 파일 stem(예: `2026-08-10-emerging-cluster-rope`)만 보여준다. 제목과 폴더는 없고 stem 기준으로 중복을 제거한다(848). |
| 리더 상단 | `PageReader.tsx:904-911`, `08-reader.png` | "저장됨 / 저장 대기 중… / 저장 실패" 상태가 오른쪽 위에 보인다. 이 패턴은 좋다. `···` 메뉴는 드롭다운이다(1022). |
| 읽기 전용 | `PageReader.tsx:271-276` | "preview(읽기 전용 Viewer)는 이제 raw/ 파일만 연다". 사용자가 켜는 잠금은 없다. |
| 그래프 | `shots/oxn/05-graph.png`, `GraphQuestions.tsx:146-149` | 컨트롤 9개, 질문 탭, 크기 토글, 체크박스, 긴 통계 문장이 위에 쌓인다. 캔버스는 화면 아래쪽에서 시작한다. 개발용 지표 "씬 재빌드 3회 · 203.0 ms" 칩이 일반 사용자에게도 항상 보인다. |
| 자료 추가 | `06-ingest.png` | 터치 기기에서도 제목이 "여기에 파일 드롭"이다. 사진이나 카메라 같은 입력 경로는 없다. |
| 설정 | `07-settings.png` | 카테고리 카드 2열 그리드 아래에 선택한 패널 본문이 이어진다. 폰에서는 한 화면에 두 단계가 섞인다. |
| 컨텍스트 메뉴 | `SidebarTree.tsx:58,89`, `Sidebar.tsx:231` | `onContextMenu`(우클릭)와 `Shift+F10`만 있다. long-press 처리는 없다(`touchstart|longpress` grep 0건). |
| 키보드 가림 처리 | grep `visualViewport\|virtualKeyboard` 0건 | 소프트 키보드 높이에 맞춘 레이아웃 처리가 없다. **[검증]**(코드에 없음), 실제 영향은 **[미확인]**(실기기 미측정) |
| 모바일 빌드 | `src-tauri/src/lib.rs:113-114`, `tauri.conf.json:20,36,84-88`, `Cargo.toml:22,29,69` | `mobile_entry_point`가 없다. 타깃은 dmg/nsis이고 minWidth는 800이다. deep-link scheme은 `desktop`만 있다. tray-icon, macos-private-api, updater, global-shortcut 같은 데스크톱 전용 의존성이 있다. |

---

## 3. 패턴 카탈로그

각 행은 앱·플랫폼, 하는 일, 일반 사용자에게 통하는 이유, Mobbin 링크 순서이다. 모든 화면은 반환된 이미지를 직접 보고 적었다.

### 3.1 첫 실행·온보딩

| 앱·플랫폼 | 하는 일 | 일반 사용자에게 왜 통하나 | Mobbin |
|---|---|---|---|
| Obsidian iOS | 볼트 목록 화면: "Setup Obsidian Sync / Create new vault / (기존 볼트들)". 볼트를 고르면 Open, Rename, Delete가 나온다. | 내 노트가 들어 있는 상자(볼트)를 첫 화면에 사물처럼 보여준다. 계정 없이 시작한다. | [d6dd92e4](https://mobbin.com/screens/d6dd92e4-9d3b-4bf8-a0be-706ef3708b40), [eab333b1](https://mobbin.com/screens/eab333b1-2243-4edf-a465-03bcc56ee00c) |
| Obsidian iOS | 볼트 만들기: 이름 입력 + "Store in iCloud — This cannot be changed later." 토글 | 되돌릴 수 없는 결정을 그 자리에서 한 줄로 경고한다. 저장 위치라는 개념을 처음 한 번만 묻는다. | flow [34928d68](https://mobbin.com/flows/34928d68-f70f-4fb2-8379-a5cf8f7303c6) |
| Obsidian iOS | 계정 화면 문구: "Creating an account is not required to download or use the app." 설정 General에도 "An account is only needed for Obsidian Sync, Publish…"라고 쓴다. | 가입 압박 없이 "무엇을 위해 필요한지"만 말한다. | flow [b21b6b48](https://mobbin.com/flows/b21b6b48-0b88-4dba-8df8-db79d01a7076), [c03b0276](https://mobbin.com/screens/c03b0276-6ba0-4384-a8e9-74dcddba4528) |
| Obsidian iOS | 볼트 삭제: 빨간 문구 "Deleting this vault will delete all files in it. This action is irreversible." + Delete | 파괴적 행동을 별도 화면에서 결과 중심으로 설명한다. | flow [285f00bf](https://mobbin.com/flows/285f00bf-5b07-4a6b-8f35-03be2f446436) |
| Notion iOS | 가입 후 팁 캐러셀: 진행 바 + "Keep your thoughts organized — Use the home tab to organize your pages." + Next | 기능 설명 대신 "어디서 무엇을 하는지"를 실제 앱 화면 모형으로 보여준다. | flow [5ed77200](https://mobbin.com/flows/5ed77200-e4f1-4053-b071-aa716a704569) |
| Notion iOS | "Some essential tips": "Touch and hold to reorder any content." / "Save web pages or local files into Notion."(공유 확장 모형: Cancel · Notion · Save, Add to, Workspace) | 터치 제스처와 공유 시트처럼 **눈에 보이지 않는 입구**를 온보딩에서 미리 알려준다. | flow [2ada33fc](https://mobbin.com/flows/2ada33fc-fedc-4d26-a89a-96714e261e81), [f999e32c](https://mobbin.com/screens/f999e32c-f6d8-4251-846b-2da3a4d3df2d) |
| Notion iOS | "What are some areas of interest? Select as many as you want." 타일 그리드 + Skip | 선택하면 바로 첫 콘텐츠가 생긴다. Skip을 숨기지 않는다. | flow [2ada33fc](https://mobbin.com/flows/2ada33fc-fedc-4d26-a89a-96714e261e81) |
| Notion iOS | 첫 워크스페이스의 "To Do List"가 팁을 할 일로 담는다("Check the box to mark items as done", "Click the due date to change it"…) | 설명서가 아니라 직접 눌러 보는 첫 문서이다. | flow [6e433dba](https://mobbin.com/flows/6e433dba-57db-40ee-8efa-36f36993fae9) |
| Notion iOS | 기능 소개 툴팁 투어: "Ready to upgrade? Add verification, owners, and tags to this page (you can undo this later)" · 점 4개 · Back / Try it out | 해 볼 수 있고 되돌릴 수 있다고 함께 말한다. | flow [6ba6d6d7](https://mobbin.com/flows/6ba6d6d7-2108-4afa-ba6c-63007f93abcb) |

### 3.2 홈

| 앱·플랫폼 | 하는 일 | 왜 통하나 | Mobbin |
|---|---|---|---|
| Notion iOS | 상단 세그먼트 [A] Home / Chats / Calendar / Inbox(빨간 점). Home = Recents 가로 카드 → Favorites → Private(정렬: Manual/Last edited) → Teamspaces | "최근 것"이 가장 위에 있다. 탭 4개로 앱 전체가 보인다. | [e7689c02](https://mobbin.com/screens/e7689c02-0bc0-49f7-bc5c-71f516844d33), [e20dff9f](https://mobbin.com/screens/e20dff9f-f089-4d08-8f54-d32decbca5e9), [0e1837f1](https://mobbin.com/screens/0e1837f1-ba32-447d-ad32-04461492235a) |
| Notion iOS | 아바타 메뉴: Switch Workspace / Upgrade plan / Settings / Trash / Help & support | 자주 안 쓰는 것을 아바타 하나 뒤에 모은다. | [39a94725](https://mobbin.com/screens/39a94725-425f-49c9-af53-a1071f24c53b) |
| Notion iOS | 닫을 수 있는 기능 카드 "Introducing AI Meeting Notes … Create new meeting note" | 새 기능을 행동 버튼 하나와 ×로 소개한다. | [1d364040](https://mobbin.com/screens/1d364040-ca74-40f4-a675-27492539f171) |
| Notion iOS | Inbox: "Last week" 묶음, 미읽음 파란 점, 리마인더 행 | 알림을 다시 볼 곳이 있다. | [d60253f9](https://mobbin.com/screens/d60253f9-da05-4c96-b846-7c0a7751da94) |
| Notion iOS(구버전) | 하단 탭 4개 Home / Search / Inbox / New + "Jump back in" + "Browse templates" | 과거의 4탭 구조이다. 지금은 위 세그먼트 + 하단 3버튼으로 바뀌었다. | flow [2ada33fc](https://mobbin.com/flows/2ada33fc-fedc-4d26-a89a-96714e261e81), flow [f8922836](https://mobbin.com/flows/f8922836-c66c-473d-b958-1ff84673f338) |
| Obsidian iOS | 홈이 따로 없다. 빈 탭에 "Create new note / Go to file / Close" | 빈 화면에서도 다음 행동 2–3개를 버튼으로 보여준다. | [93c23c06](https://mobbin.com/screens/93c23c06-f037-4143-a56d-e2a4d91ab315) |

### 3.3 내비게이션: 하단 바, 드로어, 탭

| 앱·플랫폼 | 하는 일 | 왜 통하나 | Mobbin |
|---|---|---|---|
| Obsidian iOS | 떠 있는 하단 바: ‹ › / 검색 / + 새 노트 / [n] 탭 수 / ☰ | 뒤로, 앞으로, 찾기, 만들기가 모두 엄지 아래에 있다. | [f1a6d4a1](https://mobbin.com/screens/f1a6d4a1-719d-43a3-8532-fe7261f6151e) |
| Obsidian iOS | ☰ = 하단 시트: Open quick switcher / Open graph view / Create new canvas / Open today's daily note / Insert template / Open command palette / Create new base | 데스크톱의 리본을 동사 목록 시트 하나로 옮겼다. | [e08955c4](https://mobbin.com/screens/e08955c4-1af5-44bd-bc5e-522d438071f0) |
| Obsidian iOS | 왼쪽 드로어: 파일 목록(타입 태그 BASE/CANVAS) → 하단에 새 노트·새 폴더·정렬·접기 → 창 전환 필 "Files ⌃⌄" → 볼트 이름 ▾ "4 files, 0 folders" + ⚙ | 드로어 하단 한 줄이 "어떤 목록을 보는지"를 바꾼다(Files / All properties). 고정 영역은 작다. | [4fb0ebc3](https://mobbin.com/screens/4fb0ebc3-a523-460a-af5d-713685a9b939), [c98bbb65](https://mobbin.com/screens/c98bbb65-e3c6-4c66-a48e-29bb70e469a5) |
| Obsidian iOS | 오른쪽 드로어: Backlinks(문맥 스니펫) / Outgoing links / Outline을 하단 필 피커로 바꾼다. 꼬리에 "노트명 · 87 words, 579 characters" | 노트에 딸린 정보는 오른쪽, 볼트 정보는 왼쪽으로 방향이 정해져 있다. | [59932f82](https://mobbin.com/screens/59932f82-a889-4b24-b5a6-75be8965334e), [88d24bae](https://mobbin.com/screens/88d24bae-ee98-42b9-9180-2421eb4af47e), [b74df2ce](https://mobbin.com/screens/b74df2ce-1701-451a-b5e2-ba2680e8ebb1) |
| Obsidian iOS | 탭 전환기: Safari처럼 썸네일 그리드 + 각각 ×, 하단 "+ / 5 tabs ▾ / Done". 탭 수를 길게 누르면 New tab / Undo close tab / Close 3 tabs | 폰에서는 분할 대신 탭으로 여러 문서를 오간다. | [bf5ae304](https://mobbin.com/screens/bf5ae304-2dc0-41b4-b5dc-156ecb889a7a), [d009ba54](https://mobbin.com/screens/d009ba54-32ac-40b1-aa5f-f7a2add3cb04) |
| Obsidian iOS | 드로어에서 파일을 끌면 "2 Day Trip Plan to NYC — Move into "Itinerary"" 라벨이 따라온다 | 놓기 전에 결과를 문장으로 보여준다. | [9a0771d2](https://mobbin.com/screens/9a0771d2-d259-416f-b986-469d4c626c71) |
| Notion iOS | 페이지 상단: ‹ / 공유 / 댓글 / ···. 위치는 상단 가운데 칩 "🔒 Private ›"이나 제목 아래 칩 "Home ▾"로 보여준다 | 폰에서 브레드크럼 대신 칩 하나로 위치를 보여준다. | [8c354deb](https://mobbin.com/screens/8c354deb-824f-409c-bb1f-41101da26be2), [bb04ea66](https://mobbin.com/screens/bb04ea66-02e0-43ff-97ca-21dca43e7947) |

### 3.4 빠른 기록

| 앱·플랫폼 | 하는 일 | 왜 통하나 | Mobbin |
|---|---|---|---|
| Notion iOS | 하단 고정 3버튼: 🔍 검색 / "Ask AI" 필(마스코트 + 🎤) / ✎ 작성 | 묻기와 쓰기를 각각 버튼 하나로 보여준다. 음성 입력도 바로 옆에 있다. | [e7689c02](https://mobbin.com/screens/e7689c02-0bc0-49f7-bc5c-71f516844d33) |
| Notion iOS | 작성 버튼 메뉴: AI Meeting Notes / Chat / Page | 만들 수 있는 것의 종류를 3개로 줄였다. | [1d364040](https://mobbin.com/screens/1d364040-ca74-40f4-a675-27492539f171) |
| Notion iOS | 빈 새 페이지 키보드 위에 템플릿 칩 "Meeting / Weekly plan / ···". 속성이 있는 DB 페이지에는 "Tap here to continue with an empty page, or create a template" | 빈 화면에서 망설일 때 시작점을 키보드 바로 위에 둔다. | [e1f4852b](https://mobbin.com/screens/e1f4852b-5b5c-4f70-858d-bb024afd4dc2), [bf2171ff](https://mobbin.com/screens/bf2171ff-ff70-4e91-b417-170af24a056c) |
| Notion iOS | "Add new page in" 시트: 검색 + Suggested + Teamspaces + Done | 새 페이지의 위치를 묻지만 제안 목록으로 결정을 쉽게 만든다. | [149d05a0](https://mobbin.com/screens/149d05a0-f1cf-483f-8703-9aa253c1a46b) |
| Notion iOS | AI 입력 첨부 시트: Photos("Choose from your Library") / Files("Analyze, summarize, or import to Notion") / Camera("Capture ideas into Notion") | 항목마다 한 줄로 "이걸로 무엇이 되는지"를 쓴다. | [d8873d9d](https://mobbin.com/screens/d8873d9d-0ce3-43a6-aa75-820d932ad1b1) |
| Notion web | 빈 페이지 하단 "Get started with: Ask AI / AI Meeting Notes / Database / Form / Templates / ···" | 데스크톱에서도 빈 페이지 칩은 아래쪽에 있다(이전 보고서의 53285746과 같은 패턴). | [8a1f646f](https://mobbin.com/screens/8a1f646f-da51-4baa-a89d-489e6e7035a5) |
| Obsidian iOS | ☰ 시트의 "Open today's daily note" | 오늘 노트가 한 번의 탭 거리에 있다. | [e08955c4](https://mobbin.com/screens/e08955c4-1af5-44bd-bc5e-522d438071f0) |

### 3.5 검색

| 앱·플랫폼 | 하는 일 | 왜 통하나 | Mobbin |
|---|---|---|---|
| Obsidian iOS | 빠른 전환기, 명령 팔레트, 템플릿, 폴더 선택: **입력창이 화면 하단(키보드 바로 위)**, 결과가 그 위에 쌓인다. 퍼지 일치 글자는 굵게 표시한다("File re**co**very: O**p**en local histor**y**"). | 엄지가 닿는 자리에 입력창이 있고, 결과는 키보드에 가리지 않는다. 같은 피커 모양을 네 군데서 재사용한다. | [e9aaa07a](https://mobbin.com/screens/e9aaa07a-ab80-4354-bd1c-a37bc9a3f404), [44992a64](https://mobbin.com/screens/44992a64-b821-48c5-ade2-c3e80525b978), [38e6939a](https://mobbin.com/screens/38e6939a-a8ac-4c6b-b8f1-5881f255b7c6), [a7f0bd8e](https://mobbin.com/screens/a7f0bd8e-4e3d-4782-a15f-e1bc25920381) |
| Obsidian iOS | 전체 검색 창(드로어): `tag:#Pizzas`, Aa(대소문자), 필터 아이콘, "1 result", 정렬 "File name (A to Z)", 결과 아래 일치한 줄 스니펫 | 결과가 왜 나왔는지 그 줄을 함께 보여준다. | [da212ff4](https://mobbin.com/screens/da212ff4-5852-49ae-968e-2dc23ece2c4a) |
| Obsidian iOS | 그룹 쿼리 입력에 "Search options" 드롭다운: `path:` match path / `file:` / `tag:` / `line:` / `section:` / `[property]`, 각각 한 줄 설명 | 연산자를 외우지 않아도 입력할 때 목록에서 고를 수 있다. | [ac93a668](https://mobbin.com/screens/ac93a668-ffbc-43dd-8437-8428767713a1) |
| Notion iOS | 검색: **하단 입력** "Search or ask AI" + 필터 + ×. 위에 "Ask AI anything in …" 행, 그 아래 Today/This week로 묶은 최근 페이지(부제 "in Private Pages") | 빈 검색어에서도 최근 위치를 보여준다. 결과마다 "어디에 있는지"를 부제로 단다. | [c119cf0c](https://mobbin.com/screens/c119cf0c-6553-47b2-aead-63d060159283) |
| Notion iOS | "Meeting"을 입력하면 첫 행이 'Ask AI "Meeting"'이고 그 아래가 Results | 검색어를 그대로 질문으로 넘길 수 있다. myco의 "검색하다 질문" 연결과 같은 생각이다. | [61d4d543](https://mobbin.com/screens/61d4d543-12c6-491d-9a81-e1c5adf6a55c) |

### 3.6 모바일 에디터

| 앱·플랫폼 | 하는 일 | 왜 통하나 | Mobbin |
|---|---|---|---|
| Obsidian iOS | 키보드 위 **가로 스크롤 명령 막대**: ↶ ↷ [[]] 임베드 태그 📎 H B … I S 하이라이트 코드 인용 링크 목록, 오른쪽 끝에 키보드 내리기. B를 누르면 `**Midtown**` 표식이 보이게 들어간다. | 단축키 없이 서식을 넣는다. 마크다운 원문은 그대로 유지된다. | [629a3a6a](https://mobbin.com/screens/629a3a6a-d55b-49a6-8914-945c900d5ee1), [540d9895](https://mobbin.com/screens/540d9895-30f8-4e4d-9466-5faf7ea8d4e5), [2994b4b9](https://mobbin.com/screens/2994b4b9-84f2-43d4-9ef7-8680b675c718) |
| Obsidian iOS | 설정 → Toolbar: 명령마다 ⊖ 제거와 ≡ 끌어서 순서 바꾸기, "More toolbar options"에서 ⊕ 추가. "Configure mobile Quick Action — 화면 위에서 아래로 당길 때 실행할 명령(현재: Command palette)" | 막대 구성을 사용자에게 맡긴다. 숨은 제스처를 설정에 이름으로 적어 둔다. | [ddf43f5d](https://mobbin.com/screens/ddf43f5d-2d0d-4ddd-bef7-0221f49af975), [6a1fb246](https://mobbin.com/screens/6a1fb246-0db7-4024-b80b-66eea0e67a03), [03aa4d6a](https://mobbin.com/screens/03aa4d6a-6864-4845-859a-503a969b3611) |
| Obsidian iOS | 📎 → Photo Library / Take Photo or Video / Choose File | 폰의 세 입력원을 그대로 쓴다. | [d2c92c5e](https://mobbin.com/screens/d2c92c5e-56cc-4071-a93d-9725c9287cba) |
| Obsidian iOS | 오른쪽 위 📖/✎로 읽기 보기와 편집 보기를 바꾼다. 설정 "Default view for new tabs: Reading view / Editing view" | 폰에서는 읽기가 기본일 수 있다. 탭하자마자 키보드가 뜨지 않는다. | [f1a6d4a1](https://mobbin.com/screens/f1a6d4a1-719d-43a3-8532-fe7261f6151e), [2241be30](https://mobbin.com/screens/2241be30-509f-4ecd-b57c-b1a4861bf696), [54c00af4](https://mobbin.com/screens/54c00af4-c143-4537-86a0-30acf08e709f) |
| Notion iOS | **맥락형 키보드 막대**: 본문에서 AI · 내어쓰기 · 들여쓰기 · ↑ · ↓ · + · Aa · 회의노트 · ⌨, 제목에서 회의노트 · 이미지 · @, 표 셀에서 ↶ B U I S @ 링크 💬 | 커서 위치에 맞는 도구만 보여준다. ↑↓ 버튼은 끌기 없이 블록을 옮기는 터치 대안이다. | [bb04ea66](https://mobbin.com/screens/bb04ea66-02e0-43ff-97ca-21dca43e7947), [58478632](https://mobbin.com/screens/58478632-42e4-4545-b49e-fd9177431940), [109b1095](https://mobbin.com/screens/109b1095-20e7-45bb-8a61-e4814d569000), [d53b3912](https://mobbin.com/screens/d53b3912-f60a-4bd1-872e-18276fe2acd5) |
| Notion iOS | 텍스트를 선택하면 막대가 « AI A(색) 💬 B I U ×로 바뀌고, A를 누르면 **키보드 자리에** "Background color" 타일 그리드가 열린다 | 팝오버 대신 키보드 영역을 패널로 바꿔 큰 타일로 고르게 한다. | [011e1303](https://mobbin.com/screens/011e1303-32b9-4882-8d28-71b5b233c517) |
| Notion iOS | `+` → **키보드 자리에 2열 타일 패널**: Basic blocks(Text, H1–H4, 목록 3종, To-do, Toggle, Page, Callout, Quote, Table, Divider, Link to page) → Media(Image, Video, Audio, Code, File, Web bookmark) → Database → Embeds → Advanced | 슬래시를 타이핑하지 않아도 모든 블록을 탭으로 넣는다. 타일은 손가락 크기이다. | [23ebacc5](https://mobbin.com/screens/23ebacc5-4ddd-4afc-ae8e-3a07063e80cd), [4f773fc9](https://mobbin.com/screens/4f773fc9-7d28-4915-998c-637ac1014804), [de033fb7](https://mobbin.com/screens/de033fb7-8d36-4c24-9e2d-40f95d1f7ff5), [b689e6c5](https://mobbin.com/screens/b689e6c5-62b4-48e9-83d0-76cc61b9966e) |
| Notion iOS | 블록 "Actions" 하단 시트: 머리는 **블록 타입별**(Table: Turn into database / Fit to width / Insert below / Header row·column 토글, Image: Replace / Caption / Alt text / View original), 공통 그룹 Copy link / Duplicate / Move to / **Delete(빨강)**, Comment, Ask AI, 꼬리 "Last edited by … Today at 3:59 PM" | 손가락 하나로 블록에 할 수 있는 일을 전부 본다. 지금 고른 블록에 맞는 동작이 맨 위에 온다. | [6ecea6c7](https://mobbin.com/screens/6ecea6c7-4682-4c35-b649-412a0a240738), [ffbb0bcf](https://mobbin.com/screens/ffbb0bcf-8417-4242-a446-dd95101be27f) |
| Notion iOS | 표: 셀을 선택하면 행 왼쪽 ⋮⋮와 열 위 ⠿ 핸들, 표 위 "↔ ···" 미니 막대. 열을 끌어 순서를 바꾸고, 넓은 표는 가로 스크롤(제목 열도 함께 밀려 사라진다) | 폰에서 표는 가로로 밀어 보는 것을 받아들인다. | flow [0f69ccce](https://mobbin.com/flows/0f69ccce-4227-4fe3-a020-c2c586369ade), [9813d2c0](https://mobbin.com/screens/9813d2c0-84ec-4c41-bfdc-8c2127914c91), [6494c048](https://mobbin.com/screens/6494c048-3824-413c-a5ca-3f3b0c8f21ee) |
| Notion iOS | Insert Media 시트: Photo library / Take photo or video / **Scan Document** / Choose Files | 종이 자료를 바로 스캔해 넣는다. | [3601882d](https://mobbin.com/screens/3601882d-0003-4794-bd98-d9eb9ccf2234) |
| Notion iOS | 웹 북마크: URL 붙여넣기 → "Create bookmark — Create a visual bookmark from a link." → 카드 | 링크 하나를 카드로 바꾸는 한 단계 흐름이다. | flow [36960591](https://mobbin.com/flows/36960591-02c3-491d-929f-5ff7524adef1) |
| Notion iOS | 페이지 ··· Actions 시트: Undo / **Lock page** 토글 / Use with AI / Translate / Export / Turn into wiki / Page updates / Version history / Notify me / Connections, 꼬리 "Word count: 16 words · Last edited by … Today at 9:05 AM" | 편집기가 하나여도 "잠금" 토글로 실수 편집을 막는다. | [daec87cc](https://mobbin.com/screens/daec87cc-e96b-4046-b14c-eff3ac281e29) |

### 3.7 링크·백링크

| 앱·플랫폼 | 하는 일 | 왜 통하나 | Mobbin |
|---|---|---|---|
| Obsidian iOS | `![[` 팝업 행에 노트명과 회색 폴더("Itinerary/") | 같은 이름의 노트를 구별할 수 있다. | [648fdde3](https://mobbin.com/screens/648fdde3-4975-40ba-a8d8-c9eec6fb5c0a) |
| Obsidian iOS | 오른쪽 드로어 Linked mentions: 문맥 문장 + 하이라이트, 비어 있어도 "Unlinked mentions" 머리 | 이미 S11에서 반영했다(백링크 문장). 모바일에서는 이것이 **오른쪽 드로어**에 들어간다는 점만 새롭다. | [59932f82](https://mobbin.com/screens/59932f82-a889-4b24-b5a6-75be8965334e) |
| Notion iOS | Link 시트: "Paste link or search pages" + Recents(제목 + 위치 부제 "Alex Smith's Space HQ") | 링크 붙여넣기와 페이지 찾기를 입력창 하나에서 한다. | [8448eb86](https://mobbin.com/screens/8448eb86-b663-41c1-9871-c60863335e69) |
| Notion iOS | 댓글의 `@`: Today — May 29 / Next Tuesday 3pm / 사람 / 페이지를 키보드 위 목록으로 | 날짜와 사람도 같은 `@` 하나로 넣는다. | [f25b2b41](https://mobbin.com/screens/f25b2b41-8ef6-49d5-8642-76aaf1ae88e8) |
| Notion iOS | 페이지 커버 아래 "↙ 1 backlink · Add comment" 칩 | 백링크 수를 제목 바로 위에 작게 보여준다. | flow [8f00f15f](https://mobbin.com/flows/8f00f15f-374f-4255-8f79-73d17ac45dd8) |

### 3.8 그래프(Obsidian 모바일)

| 앱·플랫폼 | 하는 일 | 왜 통하나 | Mobbin |
|---|---|---|---|
| Obsidian iOS | 그래프는 화면 전체를 쓴다. 설정은 오른쪽 위 **떠 있는 카드**(≈2/3 폭)에 접히는 섹션 Filters / Groups / Display / Forces와 ↻(초기화)·×로 들어간다. 하단 바는 그대로 남는다. | 캔버스가 주인공이다. 설정은 겹쳐 보다가 닫는다. | [750d7b56](https://mobbin.com/screens/750d7b56-5e9f-45d3-a43e-9160b4181c3c), [a4e27535](https://mobbin.com/screens/a4e27535-090f-40de-81c2-fa8e83703b8b), [6239ed2b](https://mobbin.com/screens/6239ed2b-70fd-4c8d-aa22-f8c7b467d4a8) |
| Obsidian iOS | Groups: 쿼리 + 색 점 + ×, 보라색 "New group" | 색으로 묶는 규칙을 한 줄씩 추가한다. | [71318baf](https://mobbin.com/screens/71318baf-b814-4435-806b-cdb772ee14a6) |
| Obsidian iOS(Canvas) | 빈 캔버스 안내 "Drag to pan / Pinch to zoom / Touch and hold to add / move / select" | 터치 제스처 세 가지를 첫 화면에 문장으로 가르친다. 그래프 화면에도 그대로 쓸 수 있는 패턴이다. | [58242b18](https://mobbin.com/screens/58242b18-6679-468e-b059-54f082a8de4d) |

### 3.9 설정

| 앱·플랫폼 | 하는 일 | 왜 통하나 | Mobbin |
|---|---|---|---|
| Obsidian iOS | iOS식 그룹 목록(General, Editor, **Toolbar**, Files and links, Appearance, Hotkeys, Keychain, Core plugins…) → 상세 화면은 ←와 ×, 카드 안 행 = 제목 + 한 줄 설명 + 컨트롤 | 목록에서 상세로 들어가는 두 단계가 분명하다. | [074d1d45](https://mobbin.com/screens/074d1d45-ec3a-4267-9dae-b53f4402f83e), [7f043fcb](https://mobbin.com/screens/7f043fcb-4094-43ad-b377-e88ca4aa74ee) |
| Obsidian iOS | "Vim key bindings … On mobile devices, this setting is per-device and is not synchronized" / 빨간 "Rebuild vault cache … could take a few seconds to a few minutes" | 이 설정이 어디까지 적용되는지, 얼마나 걸리는지 미리 말한다. | [3807f2b0](https://mobbin.com/screens/3807f2b0-21a0-4870-88f5-5234e8038674), [6260ec15](https://mobbin.com/screens/6260ec15-913d-47a8-93f8-c4bfdffb6907) |
| Notion iOS | 한 화면 스크롤 설정. Theme "Choose a theme for Notion **on this device**", External links "on this device" | 기기별 설정을 문구로 구분한다. | [d710fe22](https://mobbin.com/screens/d710fe22-f919-4fa8-8f2b-c57a5087ce17) |

### 3.10 동기화·오프라인 신호

| 앱·플랫폼 | 하는 일 | 왜 통하나 | Mobbin |
|---|---|---|---|
| Notion iOS | 토스트 "Working offline · Last sync on May 28, 2026 at 1:56 PM" | 지금 상태와 마지막으로 맞춘 시각을 한 문장으로 알린다. | [a335360d](https://mobbin.com/screens/a335360d-a12e-4032-8d58-c465a9fc181a) |
| Notion web | 브레드크럼 "Private ▾" 옆 "Offline" 칩, Share 비활성 | 지금 쓸 수 없는 기능을 숨기지 않고 흐리게 둔다. | [03c9e00d](https://mobbin.com/screens/03c9e00d-9d01-4f50-90e4-04f969e0442e) |
| Notion iOS | 설정 Offline: "Automatic downloads — Recents and Favorites for offline use" 토글, "Offline pages — Manage", 페이지별 "Available offline" 토글, 오프라인 목록의 "Downloading…" 스피너 | "무엇이 이 기기에 있는지"를 목록으로 확인할 수 있다. | [b86ac678](https://mobbin.com/screens/b86ac678-2438-4180-9fa6-efce9f1e43ea), [e9e94681](https://mobbin.com/screens/e9e94681-2120-4697-aadd-814c1f9464c1), [f72f259f](https://mobbin.com/screens/f72f259f-acd3-400f-a6ad-66f736d32aea) |
| Obsidian iOS | 작업 결과를 상단 토스트로 알린다: "Successfully renamed file." / "URL copied to your clipboard" | 짧은 확인 문구를 한 줄로 띄운다. | [73483ca7](https://mobbin.com/screens/73483ca7-6b4b-4550-a142-5f0ad94c1294), flow [ca1743cf](https://mobbin.com/flows/ca1743cf-40e6-4d18-b5ef-4d076737aaf0) |
| Notion iOS | 이동 후 하단 토스트 "Moved to Alex Smith's Space HQ · Undo" | 결과와 되돌리기를 같은 자리에 둔다. | flow [871bed26](https://mobbin.com/flows/871bed26-cd6c-4010-9113-c583945fc68b) |

### 3.11 공유 시트·위젯·가져오기

| 앱·플랫폼 | 하는 일 | 왜 통하나 | Mobbin |
|---|---|---|---|
| Notion iOS | 홈 화면 위젯: "Recently viewed" 목록 + ⊕, "Favorites" + ⊕, 단일 페이지 카드 | 앱을 열지 않고 최근 문서를 열거나 바로 새로 쓴다. | [ac92c17b](https://mobbin.com/screens/ac92c17b-2777-4f07-b061-8367f0eb503d) |
| Notion iOS | 공유 확장(온보딩 모형): Cancel · Notion · Save / 제목 "Douglas Engelbart - Wikipedia" / Add to "New My Links Database" / Workspace | 다른 앱에서 바로 보관할 수 있다. 목적지를 한 줄로 고른다. | [f999e32c](https://mobbin.com/screens/f999e32c-f6d8-4251-846b-2da3a4d3df2d) |
| Notion web | Import(설정 모달): "Import data from other apps and files" / 탭 **Discover · Completed** / 드롭존 "ZIP, CSV, PDF, text, markdown, or HTML … choose a file · ZIP max 5GB" / 카드 CSV · PDF("Extract content from PDF documents") · Text & Markdown · HTML · Word | 형식마다 "무엇이 되는지"를 한 줄로 쓴다. 완료한 가져오기 기록을 따로 볼 수 있다. | [244b511b](https://mobbin.com/screens/244b511b-a7ea-4a87-ab0e-024b867294cd) |
| Obsidian iOS | 노트 ··· 시트의 "Share", 파일 시트의 "Copy path ›"(as Obsidian URL / from vault folder) | 공유는 OS 시트에 맡기고, 앱은 경로 복사만 제공한다. | [09dec6de](https://mobbin.com/screens/09dec6de-5d1b-4020-922b-ad238e77263c), flow [ca1743cf](https://mobbin.com/flows/ca1743cf-40e6-4d18-b5ef-4d076737aaf0) |

### 3.12 하단 시트 공통 문법(두 앱 공통)

- Obsidian 노트 ··· 시트: 손잡이 → Close → (Backlinks in document / Reading view / Source mode) → (Pin / Rename / Move file to / Bookmark / Merge / Add file property) → … → Share → **Delete file(빨강)** — [2d7a3707](https://mobbin.com/screens/2d7a3707-09a1-4941-aaad-d65ee647341b), flow [ca1743cf](https://mobbin.com/flows/ca1743cf-40e6-4d18-b5ef-4d076737aaf0)
- Obsidian 파일 시트의 **메타 머리**: "Moodboard.md · Last modified at 2026-04-28 10:08 · Created at 2026-04-28 10:05" — [5964c921](https://mobbin.com/screens/5964c921-3ae7-4f36-9fcb-81f8df0ee624)
- Obsidian 확인 시트: "Merge file — Are you sure you want to merge … ? … will be deleted." Merge(빨강) / Cancel — flow [07fba263](https://mobbin.com/flows/07fba263-e731-4aa8-9fa3-46db294aa8c7)
- Notion 페이지 시트: 글꼴 Ag Default/Serif/Mono → Add to Favorites / Share / Copy link / Copy page contents / Duplicate / Move to / **Move to Trash(빨강)** → Available offline → … — [ee317f0a](https://mobbin.com/screens/ee317f0a-d52d-4dee-98db-60918c55de7b)
- Notion Move to 시트: 검색 "Move page to…" + Suggested(제목 + 위치 부제) + Teamspaces + Done — flow [871bed26](https://mobbin.com/flows/871bed26-cd6c-4010-9113-c583945fc68b)

일반 사용자에게 통하는 이유는 세 가지이다. 메뉴가 엄지 아래에서 열린다. 그룹 카드가 동작의 무게(보기 → 정리 → 위험)를 구분한다. 꼬리나 머리의 메타가 "이게 언제 것인지"를 알려준다.

---

## 4. 제안 A: 지금 데스크톱에서도 이득인 전체 사용성 개선

이미 출시한 S1–S12, 블록 에디터 0–6단계, 진행 중인 Notion 표/블록 패널과 Woven 그래프 스펙은 다시 제안하지 않았다. 모든 항목은 기존 함수와 스타일을 다시 쓰는 S/M 크기이다.

### A1. 홈 "적기"를 보이는 버튼으로 — impact **high** / effort **S**
- 근거: Notion iOS는 Ask AI 필과 ✎ 작성 버튼을 나란히 둔다([e7689c02](https://mobbin.com/screens/e7689c02-0bc0-49f7-bc5c-71f516844d33)). 작성 메뉴는 Page / Chat / Meeting Notes 셋이다([1d364040](https://mobbin.com/screens/1d364040-ca74-40f4-a675-27492539f171)).
- 갭: `PageOverview.tsx:361-366`은 `metaKey||ctrlKey`일 때만 `capture()`를 실행한다. 화면에는 힌트 문구만 있고(`PageOverview.tsx:369`, i18n `home_ask_keys`) 버튼은 없다. 폰에서는 실행할 방법이 없다(`02-home.png`).
- 제안: 입력란 아래에 버튼 두 개를 둔다. [질문하기](primary)와 [오늘의 노트에 적기]이다. 각 버튼은 기존 `ask(text)`와 `capture()`를 그대로 호출한다. 키 힌트는 `(hover: hover)`에서만 보인다(A4).

### A2. 피커 행을 "제목 + 위치"로 — impact **high** / effort **S**
- 근거: Notion Link 시트는 Recents 행에 제목과 위치 부제를 단다([8448eb86](https://mobbin.com/screens/8448eb86-b663-41c1-9871-c60863335e69)). Notion 검색도 "in Private Pages"를 쓴다([c119cf0c](https://mobbin.com/screens/c119cf0c-6553-47b2-aead-63d060159283)). Obsidian `[[` 팝업은 폴더를 회색으로 보여준다([648fdde3](https://mobbin.com/screens/648fdde3-4975-40ba-a8d8-c9eec6fb5c0a)).
- 갭: `Editor.tsx:848` stem 중복 제거, `858-863` `{label: stem, type: "text"}`. 그래서 행은 `abc` 아이콘 + `2026-08-10-emerging-cluster-rope` 같은 slug이고, 행 높이는 19px이다(`13-wikilink.png`). 이전 `mobbin-obsidian.md` #16(폴더 detail)도 아직 반영되지 않았다.
- 제안: 후보를 경로 단위로 유지한다. `label`은 frontmatter `title`(없으면 stem), `detail`은 폴더로 둔다. 링크에 넣는 `apply`는 기존 stem 그대로 두어 링크 형식을 바꾸지 않는다. `type`을 빼서 `abc` 아이콘을 없앤다. 행 높이는 A5에서 다룬다.

### A3. 그래프의 개발용 지표 칩 숨기기 — impact **medium** / effort **S**
- 근거: Obsidian 그래프 패널에는 사용자가 다루는 컨트롤(Filters/Groups/Display/Forces)만 있다([750d7b56](https://mobbin.com/screens/750d7b56-5e9f-45d3-a43e-9160b4181c3c), [a4e27535](https://mobbin.com/screens/a4e27535-090f-40de-81c2-fa8e83703b8b)).
- 갭: `GraphQuestions.tsx:146-149`이 "씬 재빌드 N회 · x ms" 칩을 항상 렌더한다. 주석은 이 칩이 "찾기 입력이 장면을 다시 빌드하지 않음을 확인하려고 사용자가 보는 숫자"라고 설명한다. 일반 사용자에게는 뜻이 없는 숫자이다(`05-graph.png`). 진행 중인 Woven 스펙에도 언급이 없다(grep 확인).
- 제안: `import.meta.env.DEV` 또는 설정 > 추가 설정의 "개발자 정보" 토글 뒤로 옮긴다. `scripts/`에서 `.graph-rebuilds`를 읽는 곳은 없다(grep 0건). 그래도 DEV에서는 계속 보이게 두면 개발자의 확인 용도는 남는다.

### A4. 입력 방식에 맞춘 힌트 — impact **medium** / effort **S**
- 근거: 두 앱의 모바일 화면에는 키 힌트가 하나도 없다. Obsidian 피커([e9aaa07a](https://mobbin.com/screens/e9aaa07a-ab80-4354-bd1c-a37bc9a3f404))와 Notion 검색([c119cf0c](https://mobbin.com/screens/c119cf0c-6553-47b2-aead-63d060159283))이 그렇다.
- 갭: ⌘K 푸터 `↑↓ ↵ ⌥↵ esc`(`CommandBar.tsx:656-670`), 홈 `⌘Enter` 힌트(`PageOverview.tsx:369`), 드로어 `⌘K` 칩(`Sidebar.tsx:292`), 상단 검색 필 `⌘K`(`Topbar.tsx:110-115`)가 터치에서도 보인다(`11-cmdk.png`, `03-drawer.png`).
- 제안: `@media (hover: none)`에서 `.kbd`, `.qkbd`, `.cmd-foot`, `.home-ask__keys`를 숨긴다. 앱은 이미 같은 미디어 쿼리를 쓴다(`styles/ui.css:834`). CSS만 바꾸면 된다.

### A5. 터치 타깃 최소 44px — impact **medium** / effort **S**
- 근거: Notion 모바일 블록 타일과 시트 행은 손가락 크기이다([23ebacc5](https://mobbin.com/screens/23ebacc5-4ddd-4afc-ae8e-3a07063e80cd), [6ecea6c7](https://mobbin.com/screens/6ecea6c7-4682-4c35-b649-412a0a240738)).
- 갭(측정): 도움말 FAB 34×34, safe-area 미반영(`styles.css:8248-8256`). `/` 행 28px, `[[` 행 19px, ⌘K 뷰 안 44px 미만 대상 19개. 기존 `(max-width: 768px), (any-pointer: coarse)` 블록(`styles.css:7057`)은 사이드바 행만 키운다.
- 제안: 같은 미디어 블록에 `.cm-tooltip-autocomplete li { min-height: 44px }`, `.help-widget__fab { 44px; bottom: calc(18px + env(safe-area-inset-bottom)) }`, ⌘K 행 높이를 추가한다.

### A6. 좁은 드로어의 고정 영역 줄이기 — impact **medium** / effort **S**
- 근거: Obsidian 드로어의 고정 영역은 하단 한 줄(창 전환 필)과 볼트 이름 한 줄뿐이다([4fb0ebc3](https://mobbin.com/screens/4fb0ebc3-a523-460a-af5d-713685a9b939)).
- 갭(측정): 664px 중 343px가 고정이고, 목록 창은 321px이다. `side-status`(`StatusStrip.tsx:133`)에 재인덱스 경고 카드가 들어가면 131px를 차지한다.
- 제안: ≤768px에서 `side-status`를 한 줄 요약("노트 71개 · ⚠ 6")으로 접고 탭하면 펼친다. `side-quick`의 검색 행은 하단 바(B1)가 생기면 뺀다.

### A7. 실수 편집 방지 "페이지 잠금" — impact **medium** / effort **S–M**
- 근거: Notion은 편집기가 하나이지만 Actions 시트에 "Lock page" 토글을 둔다([daec87cc](https://mobbin.com/screens/daec87cc-e96b-4046-b14c-eff3ac281e29), [ee317f0a](https://mobbin.com/screens/ee317f0a-d52d-4dee-98db-60918c55de7b)). Obsidian은 "Default view for new tabs: Reading view"를 둔다([54c00af4](https://mobbin.com/screens/54c00af4-c143-4537-86a0-30acf08e709f)).
- 갭: 읽기 전용 Viewer는 raw/ 파일만 연다(`PageReader.tsx:271-276`). 모바일에서는 본문을 한 번 탭하면 키보드가 뜬다 **[추론]**.
- 제안: Write/Read 모드를 되살리지 않고(one-editor 방향 유지), 리더 ··· 메뉴에 "잠금" 토글 하나를 둔다. 잠금은 기존 `mode = "preview"` 경로를 재사용하고, 노트별 값은 uiStore에 둔다. 이 항목은 one-editor 결정과 겹치므로 **소유자 확인이 필요하다**.

### A8. 자료 추가: 터치 기기의 문구와 입력원 — impact **low(데스크톱) / high(모바일)** / effort **S**
- 근거: Notion Insert Media "Photo library / Take photo or video / Scan Document / Choose Files"([3601882d](https://mobbin.com/screens/3601882d-0003-4794-bd98-d9eb9ccf2234)), Obsidian 📎 시트([d2c92c5e](https://mobbin.com/screens/d2c92c5e-56cc-4071-a93d-9725c9287cba)), Notion Import의 형식별 한 줄 설명과 Completed 탭([244b511b](https://mobbin.com/screens/244b511b-a7ea-4a87-ab0e-024b867294cd)).
- 갭: 터치 기기에서도 "여기에 파일 드롭"이 제목이다(`06-ingest.png`).
- 제안: `(hover: none)`에서 제목을 "파일 선택"으로 바꾸고 드롭 문구를 숨긴다. 모바일 빌드(B단계)에서 사진/카메라/스캔 항목을 추가한다.

---

## 5. 제안 B: 모바일 버전을 어떻게 할지

### B0. 먼저 정할 것(소유자 결정) — 범위 세 가지

| 선택지 | 내용 | 근거·제약 |
|---|---|---|
| **(a) 반응형 웹뷰만** | 지금의 ≤768px 규칙을 다듬는다. iPad, 좁은 창, 분할 화면용이다. 별도 앱은 만들지 않는다. | 가장 싸다. A1–A8과 B1–B4의 CSS 부분만으로 끝난다. 폰에 볼트가 없다는 문제는 그대로 남는다. |
| **(b) Tauri 2 iOS/Android 전체 앱** | 같은 React UI와 Rust 백엔드를 폰에서 돌린다. | `lib.rs:114`에 `mobile_entry_point`가 없다. 번들 타깃 추가가 필요하다(`tauri.conf.json:36`). 데스크톱 전용 의존성이 있다(`Cargo.toml:22,29,69`). 기본 질문 경로인 `claude` CLI(`claude.rs:101,304,684`)와 git 프로세스(`git_log.rs`, `vault_history.rs`)는 iOS에서 실행할 수 없다 **[추론: 플랫폼 제약]**. 폰에서 llama.cpp(`Cargo.toml:46`), `notify`, `trash`, `keyring`의 iOS 빌드 가능 여부는 **[미확인]**이다. |
| **(c) 동반 앱(권장 출발점)** | (b)의 빌드를 쓰되 범위를 **읽기 · 검색 · 질문 · 빠른 기록 · 공유 → `_inbox/`**로 줄인다. 무거운 편집, 증류, 그래프 연출은 데스크톱 몫으로 둔다. | Notion 모바일의 하단 바 3버튼(검색/질문/작성)과 공유 확장 팁([e7689c02](https://mobbin.com/screens/e7689c02-0bc0-49f7-bc5c-71f516844d33), [f999e32c](https://mobbin.com/screens/f999e32c-f6d8-4251-846b-2da3a4d3df2d))이 이 범위와 같다. myco의 웹 클리퍼도 이미 `_inbox/`로 저장하는 같은 입구를 쓴다(`App.tsx:362`). |

(c)를 권하는 이유: myco의 고유 가치는 볼트에서 그대로 인용하는 답과 들어온 자료의 정리이다. 폰에서 가장 자주 하는 일은 "묻기"와 "던져 넣기"이다(Notion iOS 홈 구성에서 끌어낸 판단, **[추론]**). 다만 (c)도 **"폰에서 답을 누가 계산하나"**가 정해져야 한다. 선택지는 폰 내 로컬 모델, API 키 프로바이더, 데스크톱 중계이고, 이는 제품·비용 결정이다. 볼트 위치(iCloud Drive / Files / 앱 내부)도 Obsidian처럼 만들 때 한 번만 묻고 "나중에 바꿀 수 없음"을 알려야 한다(flow [34928d68](https://mobbin.com/flows/34928d68-f70f-4fb2-8379-a5cf8f7303c6)).

### B1. 셸: 하단 바 + 드로어 + 시트 (CSS/React, 웹뷰에서도 유효)
- **하단 바(≤768px)**: [🔍 찾기] [질문하기 필 + 🎤] [✎ 적기]. Notion iOS 배치([e7689c02](https://mobbin.com/screens/e7689c02-0bc0-49f7-bc5c-71f516844d33))와 Obsidian 떠 있는 바([f1a6d4a1](https://mobbin.com/screens/f1a6d4a1-719d-43a3-8532-fe7261f6151e))를 근거로 한다. ←/→는 브라우저 제스처나 상단 ‹로 옮긴다. `padding-bottom: env(safe-area-inset-bottom)`을 적용한다.
- **상단 바(≤768px)**: [☰ 드로어] [위치 칩] [··· 페이지 시트]만 남긴다. 분할 보기 버튼(`Topbar.tsx:98`)과 모델 칩(`Topbar.tsx:117`)은 폰에서 숨긴다. 모델 칩 기능은 설정으로 옮긴다. 이렇게 하면 지금의 가로 스크롤(390/590)이 사라진다.
- **드로어**: 왼쪽은 볼트(홈 · 질문 · 자료 추가 · 정리 제안 · 그래프 · 할 일 · 폴더)이다. Obsidian처럼 노트 정보(연결/아웃라인/속성)는 **오른쪽 드로어**나 시트로 보낸다([59932f82](https://mobbin.com/screens/59932f82-a889-4b24-b5a6-75be8965334e), [88d24bae](https://mobbin.com/screens/88d24bae-ee98-42b9-9180-2421eb4af47e)).
- **모든 `···`와 컨텍스트 메뉴 → 하단 시트**: 같은 항목 배열을 쓰고 ≤768px에서 시트 레이아웃으로 렌더한다. 그룹 순서는 보기 → 정리 → 위험(빨강)으로 두고, 머리에 "수정 시각"을 단다. 리더 메뉴(`PageReader.tsx:1022`), 사이드바 메뉴(`SidebarMenu.tsx`), 블록 메뉴(`BlockMenu.tsx`)가 대상이다. 근거는 [2d7a3707](https://mobbin.com/screens/2d7a3707-09a1-4941-aaad-d65ee647341b), [5964c921](https://mobbin.com/screens/5964c921-3ae7-4f36-9fcb-81f8df0ee624), [daec87cc](https://mobbin.com/screens/daec87cc-e96b-4046-b14c-eff3ac281e29)이다.
- **long-press**: 사이드바 행에 길게 누르기(약 500ms, pointer 이벤트, 움직이면 취소)를 넣어 같은 시트를 연다. 지금은 `onContextMenu`뿐이다(`SidebarTree.tsx:58,89`). 기존 `lib/pointerDrag.ts`의 끌기와 충돌하지 않도록 이동 임계값을 공유해야 한다 **[추론]**.

### B2. 피커: 입력창은 아래, 결과는 위
- ⌘K, 템플릿 선택, 이동(폴더) 선택, 링크 선택을 ≤768px에서 **하단 입력 + 위로 쌓이는 결과** 레이아웃으로 바꾼다. 근거는 Obsidian 4종 피커([e9aaa07a](https://mobbin.com/screens/e9aaa07a-ab80-4354-bd1c-a37bc9a3f404), [44992a64](https://mobbin.com/screens/44992a64-b821-48c5-ade2-c3e80525b978), [38e6939a](https://mobbin.com/screens/38e6939a-a8ac-4c6b-b8f1-5881f255b7c6), [a7f0bd8e](https://mobbin.com/screens/a7f0bd8e-4e3d-4782-a15f-e1bc25920381))와 Notion 검색([c119cf0c](https://mobbin.com/screens/c119cf0c-6553-47b2-aead-63d060159283))이다.
- 빈 입력은 Today/This week로 묶은 최근 노트(+위치 부제)로 채운다. S2의 "최근" 섹션이 이미 있다(`CommandBar.tsx:264-269,328`, 순서는 동작 → 최근 → 이동 → 렌즈). 폰에서는 최근을 맨 위로 올리고 날짜 묶음 머리만 추가한다.
- 입력이 있으면 첫 행을 **"'…'를 내 노트에 질문하기"**로 둔다([61d4d543](https://mobbin.com/screens/61d4d543-12c6-491d-9a81-e1c5adf6a55c)). 연산자(`path:`, `tag:`, `type:`)는 Obsidian "Search options"처럼 입력 아래 목록으로 고르게 한다([ac93a668](https://mobbin.com/screens/ac93a668-ffbc-43dd-8437-8428767713a1)). 이전 Notion 보고서 #17의 칩 제안과 같은 방향이고, 모바일에서는 목록 형태가 더 맞는다.
- 키보드 높이: `window.visualViewport`의 `resize`에 맞춰 `--kb-h` CSS 변수를 갱신해 입력창을 그만큼 올린다. 지금 코드에는 관련 처리가 없다(grep 0건). WKWebView의 실제 동작은 **[미확인]**(실기기 필요)이다.

### B3. 모바일 에디터
- **키보드 위 도구 막대**(`visualViewport` 기반 고정): 기본 구성은 [실행취소] [[[링크]] [#태그] [📎] [H] [B] [I] [목록/할일] [↑] [↓] [+블록] [⌨ 내리기]이다. 기존 명령을 그대로 호출한다. 서식은 `formatKey(BOLD)` 등(`editorFormat.ts:576-580`), 블록 이동은 BlockMenu의 위·아래 동작, `+`는 slash 항목 목록을 쓴다. 근거는 Obsidian [629a3a6a](https://mobbin.com/screens/629a3a6a-d55b-49a6-8914-945c900d5ee1)와 Notion [bb04ea66](https://mobbin.com/screens/bb04ea66-02e0-43ff-97ca-21dca43e7947)이다.
  - 맥락 전환은 2단계로 나눈다. 1차는 고정 막대이다(Obsidian 방식, 가로 스크롤). 2차로 선택 영역이나 표 셀일 때 막대를 바꾼다(Notion [011e1303](https://mobbin.com/screens/011e1303-32b9-4882-8d28-71b5b233c517), [d53b3912](https://mobbin.com/screens/d53b3912-f60a-4bd1-872e-18276fe2acd5)).
  - 막대 구성 편집(Obsidian Toolbar 설정 [ddf43f5d](https://mobbin.com/screens/ddf43f5d-2d0d-4ddd-bef7-0221f49af975))은 쓰임이 확인될 때까지 미룬다(YAGNI).
- **`+` = 키보드 자리 블록 패널**: slash 항목(`editorCompletions.ts:162-` `slashItems`)을 섹션별 2열 타일로 렌더한다(Notion [23ebacc5](https://mobbin.com/screens/23ebacc5-4ddd-4afc-ae8e-3a07063e80cd)). 데이터는 그대로 두고 렌더만 새로 만든다. 지금의 `/` 팝업(28px 행, `12-slash.png`)은 하드웨어 키보드용으로 남긴다.
- **블록 핸들 → 탭**: `pointermove`로만 배치하는 지금 방식(`editorBlockHandle.ts:76-88`)에 `pointerdown`(pointerType이 `touch`일 때) 배치를 추가해, 캐럿이 있는 블록 옆에 44px 핸들을 띄운다. 핸들을 탭하면 B1의 **블록 Actions 시트**가 열리고, 맨 위에 블록 타입별 그룹이 온다(Notion [6ecea6c7](https://mobbin.com/screens/6ecea6c7-4682-4c35-b649-412a0a240738)).
- **재정렬은 ↑↓ 버튼부터**: Notion 막대의 ↑↓([bb04ea66](https://mobbin.com/screens/bb04ea66-02e0-43ff-97ca-21dca43e7947))를 근거로 한다. 터치 끌기는 그 뒤로 미룬다. WebKit에서 HTML5 DnD가 동작하지 않아 pointer 방식만 쓰는 현재 제약(`editorBlockHandle.ts:3`)을 고려했다.
- **표**: 진행 중인 Notion 표 스펙에 맡긴다. 폰에서 지켜야 할 기준만 근거로 남긴다. 가로 스크롤([9813d2c0](https://mobbin.com/screens/9813d2c0-84ec-4c41-bfdc-8c2127914c91)), 셀 선택 시 행/열 핸들([d53b3912](https://mobbin.com/screens/d53b3912-f60a-4bd1-872e-18276fe2acd5)), 표 Actions 시트의 Header row/column 토글([6ecea6c7](https://mobbin.com/screens/6ecea6c7-4682-4c35-b649-412a0a240738))이다.
- **잠금 기본값**: 폰에서 처음 연 노트를 잠금(A7)으로 열지는 소유자 결정이다. Obsidian은 설정으로 고르게 한다([54c00af4](https://mobbin.com/screens/54c00af4-c143-4537-86a0-30acf08e709f)).

### B4. 그래프 · 설정 · 질문 화면
- **그래프**: ≤768px에서 캔버스를 전체 화면(하단 바 위)으로 쓴다. 지금 위에 쌓인 컨트롤(`05-graph.png`)은 오른쪽 위 ⚙로 여는 **떠 있는 접이식 카드**로 옮긴다. 질문 탭과 필터 칩은 카드의 첫 섹션이 된다(Obsidian [750d7b56](https://mobbin.com/screens/750d7b56-5e9f-45d3-a43e-9160b4181c3c)). 처음 열 때는 "끌어서 회전 · 두 손가락으로 확대 · 별을 눌러 노트 보기" 안내를 한 번 보여준다(Obsidian Canvas [58242b18](https://mobbin.com/screens/58242b18-6679-468e-b059-54f082a8de4d)).
  - three.js `OrbitControls`(`lib/graphScene.ts:17,1391`)가 터치 회전과 핀치를 처리하는지 myco에서 터치로 검증하지 않았다 **[미확인]**.
  - 연속 렌더 루프는 소유자가 의도한 결정이므로 모바일에서도 바꾸자고 제안하지 않는다. 배터리 영향은 실기기 측정 전까지 **[미확인]**이다.
- **설정**: ≤768px에서 카테고리 카드 그리드(`07-settings.png`)를 **목록 → 상세 push(← / ×)**로 바꾼다(Obsidian [074d1d45](https://mobbin.com/screens/074d1d45-ec3a-4267-9dae-b53f4402f83e), [7f043fcb](https://mobbin.com/screens/7f043fcb-4094-43ad-b377-e88ca4aa74ee)). 모바일 빌드에서는 기기별 항목에 "이 기기에만 적용"을 단다(Notion [d710fe22](https://mobbin.com/screens/d710fe22-f919-4fa8-8f2b-c57a5087ce17), Obsidian [3807f2b0](https://mobbin.com/screens/3807f2b0-21a0-4870-88f5-5234e8038674)).
- **질문(Ask)**: 하단 바의 "질문하기" 필이 진입점이 된다. 페이지 안 컴포저 위치는 이전 Notion 보고서 #3(하단 고정) 제안이 그대로 유효하다. 폰에서는 도움말 FAB와 겹치는 문제(`04-ask.png`)가 추가로 확인되었다.

### B5. OS 입구: 공유 시트 · 위젯 · 온보딩 (모바일 빌드 단계)
- **공유 확장 → `_inbox/`**: 웹 클리퍼가 deep link로 `_inbox/`에 저장하는 흐름(`App.tsx:362`, `tauri.conf.json:84-88` scheme은 desktop만)을 모바일 공유 확장의 목적지로 재사용한다. 확장 화면은 Notion 모형처럼 [취소 · myco · 저장] + 제목 + "넣을 곳: 받은 자료"로 만든다([f999e32c](https://mobbin.com/screens/f999e32c-f6d8-4251-846b-2da3a4d3df2d)). `raw/`는 불변이므로 공유 확장은 `_inbox/`에만 쓴다. Tauri 2에서 iOS share extension을 어떻게 붙이는지(네이티브 타깃 추가 필요 여부)는 **[미확인]**이다.
- **위젯**: "오늘의 노트에 적기"와 "질문하기" 두 개로 시작한다. Notion 위젯의 Recently viewed + ⊕ 구성([ac92c17b](https://mobbin.com/screens/ac92c17b-2777-4f07-b061-8367f0eb503d))이 근거이다. 최근 목록 위젯은 쓰임을 확인한 뒤 추가한다.
- **모바일 첫 실행**: (1) 볼트 위치 선택("나중에 바꿀 수 없음" 한 줄, Obsidian flow [34928d68](https://mobbin.com/flows/34928d68-f70f-4fb2-8379-a5cf8f7303c6)) → (2) 팁 2장: "길게 눌러 메뉴 열기", "다른 앱에서 공유 → myco"(Notion flow [2ada33fc](https://mobbin.com/flows/2ada33fc-fedc-4d26-a89a-96714e261e81), [f999e32c](https://mobbin.com/screens/f999e32c-f6d8-4251-846b-2da3a4d3df2d)) → (3) 홈. 계정은 요구하지 않는다(Obsidian flow [b21b6b48](https://mobbin.com/flows/b21b6b48-0b88-4dba-8df8-db79d01a7076)).
- **동기화 신호**: myco 자체 동기화가 없는 동안에는 "저장됨"(`PageReader.tsx:904-911`)만 둔다. 동기화 방식이 정해지면 Notion처럼 "마지막 동기화 · 시각" 한 줄과 브레드크럼 칩을 단다([a335360d](https://mobbin.com/screens/a335360d-a12e-4032-8d58-c465a9fc181a), [03c9e00d](https://mobbin.com/screens/03c9e00d-9d01-4f50-90e4-04f969e0442e)). 동기화가 없는 상태에서 상태 칩부터 만들지는 않는다.

### B6. 순서 제안

| 단계 | 내용 | 웹뷰(a)에서도 유효? | 크기 |
|---|---|---|---|
| 1 | A1, A4, A5, A6 (CSS와 버튼 1개) | 예 | S |
| 2 | A2, A3, A8 문구 | 예 | S |
| 3 | B1 하단 바, 상단 바 정리, 하단 시트, long-press | 예 | M |
| 4 | B2 하단 입력 피커 + `visualViewport` | 예(키보드 동작은 실기기 검증) | M |
| 5 | B3 키보드 막대, `+` 패널, 탭 핸들 → Actions 시트, ↑↓ | 예 | M–L |
| 6 | B4 그래프 카드와 설정 목록 | 예 | M |
| 7 | B0 결정 → Tauri 모바일 스파이크(엔트리 포인트, 타깃, 데스크톱 전용 의존성 `cfg`) | 아니오 | L |
| 8 | B5 공유 확장, 위젯, 모바일 첫 실행, 볼트 위치 | 아니오 | L |

각 단계의 검증 기준: 375/390/768px에서 가로 스크롤 0(`scrollWidth == clientWidth`), 뷰 안 44px 미만 탭 대상 0, 하드웨어 키보드 경로(⌘K, `/`, `Mod-/`) 회귀 없음. 그다음 앱 게이트(`npm run lint && npx tsc -b && npx vitest run`)를 돌린다.

---

## 6. 검증 범위

- **[검증]**: 위에 인용한 Mobbin 화면과 플로우는 모두 이번 세션에서 반환된 미리보기 이미지를 직접 보고 적었다. 플로우 미리보기에서 화면 ID와 이미지가 1:1로 대응한다고 확신할 수 없을 때는 화면 대신 플로우 URL을 인용했다. myco의 file:line은 모두 이번 세션에서 열어 보았다. 폰 폭 측정값(상단 바 590/390, 드로어 343/664, 팝업 행 28/19px, 핸들 hidden, ⌘K top 106, 44px 미만 19개)은 `phone-shots.mjs`, `slash-shot.mjs`, `measure-drawer.mjs` 실행 출력에서 나왔다.
- **[미확인]**: 실기기 iOS/Android 동작, 소프트 키보드가 덮는 영역, WKWebView의 `visualViewport` 이벤트, `OrbitControls` 터치, Tauri iOS 빌드에서 각 Rust 의존성의 컴파일 가능 여부, iOS share extension을 Tauri 2에 붙이는 방법, 첫 실행 온보딩의 폰 폭 모양(mock에서 위저드가 뜨지 않아 `01-first-run.png`가 홈과 같다).
- **Android**: Mobbin MCP가 지원하지 않아 화면을 보지 못했다. 제안 B는 iOS 근거만으로 만들었다.
- 이 보고서는 저장소에 아무것도 쓰지 않았다. 산출물은 `scratchpad/ux-2026-10/` 아래 이 파일, 스크립트 3개, `shots/oxn/*.png`이다. 같은 `shots/` 폴더에 다른 작업자의 `m375-*.png`, `0N-phone-375-*.png`가 있다. 겹치지 않게 내 캡처는 `shots/oxn/`에만 두었다.
