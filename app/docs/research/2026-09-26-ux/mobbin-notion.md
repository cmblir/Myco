# Mobbin 리서치 — Notion (web + iOS) → myco 갭 분석

- 조사일: 2026-09-26
- 검색: Mobbin MCP 16회 (screens 15, flows 1). task_intent 고정: "Improve a local-first LLM wiki desktop app's dashboard, navigation, editor, graph and AI-answer UX by studying Notion, Obsidian and similar knowledge apps"
- 비교 대상 코드: `~/prj/karpathy-editor-build/app/src` (설치본 트리). 갭 주장은 전부 해당 파일을 읽고 확인함.

## Mobbin에 없거나 다른 것으로 대체한 항목 (정직하게 기록)

| 찾으려던 화면 | 결과 |
|---|---|
| Notion 웹 Home 탭 (Recently visited 카드 행, Upcoming events) | 웹 캡처에는 없음. 검색 결과는 데이터베이스 "Dashboard" 뷰(Team 페이지)만 반환. iOS Home의 Recents 카드 캐러셀([d120561c](https://mobbin.com/screens/d120561c-525c-42e5-a177-c5bfa948a721))로 대체. |
| Notion 웹 AI 답변의 인라인 인용 칩 | 웹 캡처는 신형 Notion AI 에이전트(인용 칩 없음). iOS 회의노트 요약의 `[1]` 칩 + "1 citation ▾" 펼침([2c91507a](https://mobbin.com/screens/2c91507a-4037-445d-b67a-ccb63266e82e))으로 대체. |
| 사이드바 접힘 + 호버 플로팅 | Notion 화면 없음 (Neon/Evernote/Fibery/Ditto만 반환). 기록만 함. |
| 검색 "No results" 빈 상태 | Notion 화면 없음. 대신 DB 빈 상태의 "Something went wrong · Try again" 인라인 오류([e00ca642](https://mobbin.com/screens/e00ca642-dcfd-4797-aec7-9ae0d780ec3d))를 확인 — myco Overview는 이미 동일 패턴 보유(`PageOverview.tsx:135-138`). |
| 페이지 상단 Properties 목록 | Notion 페이지 속성 화면은 없었고, 테이블의 "속성 추가" 타입 피커([4e6e1f98](https://mobbin.com/screens/4e6e1f98-a567-4370-b392-ac28802481c7))로 대체. |

## 실제로 본 화면 (요약)

- **사이드바 (모든 웹 캡처 공통, 예 [41f32a46](https://mobbin.com/screens/41f32a46-0aa4-4205-a6ab-627135308029))**: 워크스페이스 이름 ▾ → 아이콘 행(Home/채팅/캘린더/Inbox) → Trial → **Recents 5개(항상 펼침, 항목 옆 타입 태그 "Meeting instructions"/"AI Instructions")** → Favorites → Agents → Private(… More 접기) → Teamspaces("+ Add new" 행) → 하단 "Invite members" 카드 + "New chat ⌘O" 고정.
- **Inbox 모드 사이드바** [2d3fa125](https://mobbin.com/screens/2d3fa125-ebc1-4b23-b3d2-86bc778b9da0): 사이드바 열이 Inbox 목록으로 바뀜. "This week" 그룹, 미읽음 파란 점, "✓ Resolved" 상태, "1d" 상대시간.
- **페이지 Updates/Analytics 패널** [4cc47c52](https://mobbin.com/screens/4cc47c52-d4a1-4cef-8405-ef7e06d2d91c) / [ef8965c6](https://mobbin.com/screens/ef8965c6-72c3-4683-83b3-4b9e0d23e29f): "You deleted/locked/suggested…" 행에 취소선 diff 조각 인라인, Reply 버튼. Analytics는 28일 조회 라인차트 + Viewers/Editors 상대시간.
- **검색 모달** [1ad05716](https://mobbin.com/screens/1ad05716-44a3-48d5-9150-5780546dd323): 입력 "task" 아래 필터 칩 행(`Aa Title only` / `Created by ▾` / `In ▾` / `+ Filter`), "Search all sources with AI" 행, "Search results (2) · Best matches ▾", 결과 행 = 아이콘 + 이름 + 타입 태그("Database"/"Agent") + "samlee · Edited 2h ago" 또는 경로("Home · samlee"), **오른쪽에 선택 항목 미리보기 패널**, 푸터 "⌘↵ Open in new tab".
- **AI 홈** [a1d949f4](https://mobbin.com/screens/a1d949f4-fc76-450d-afe8-6477510a848b): 마스코트 + "Meow… what's your request?", 큰 입력창, 슬라이더 메뉴(Web access 토글 / My sources 2 › / Add sources / Can make changes / Personalize), 모델 "Auto ▾"([58188761](https://mobbin.com/screens/58188761-2d93-43a2-be51-df5fee96707a): Sonnet/Opus/Gemini/GPT 목록), "+" 메뉴([7f5c8c5c](https://mobbin.com/screens/7f5c8c5c-01c0-4b83-a505-cf3fe0bd49bc): Add images/PDFs · **Mention pages or people** · Create image · Research mode), 아래 "Recent chats — No chats yet" / "Suggested" 3개.
- **AI 답변 스레드** [fe636b00](https://mobbin.com/screens/fe636b00-83ba-4864-82ed-02cfb03d40fc) / [0c407e3c](https://mobbin.com/screens/0c407e3c-fb16-43d9-8be0-0c980374698d) / [85c67e9a](https://mobbin.com/screens/85c67e9a-2900-4097-9e7a-5fb04d510b31) / [031ca22c](https://mobbin.com/screens/031ca22c-4e38-4a3d-962d-b28df53f9c8d): 오른쪽 정렬 사용자 말풍선, "Thought ▾" 접기, 마크다운 답변, **답변 끝 액션 행(복사 / + / 👍 / 👎)** + "Response copied to clipboard" 토스트, 👍 클릭 시 "What did you like about this response?" 모달, **입력창은 하단 고정**, 스크롤 중엔 원형 "↓" 버튼.
- **iOS 인용** [2c91507a](https://mobbin.com/screens/2c91507a-4037-445d-b67a-ccb63266e82e): 요약 불릿 끝 `[1]` 칩, 카드 하단 "🔍 1 citation ▾ | 👍 👎" → 펼치면 "[1] 12:03 PM And we're taking the biggest leap eve…" (원문 인용 + 타임스탬프).
- **iOS Home** [d120561c](https://mobbin.com/screens/d120561c-525c-42e5-a177-c5bfa948a721): 상단 세그먼트(아바타/Home/Chats/Calendar/Inbox 빨간점), "Recents ▾" 가로 카드(아이콘+제목), Private 목록(타입 태그), 하단 검색 / "Ask AI" 필(마스코트+마이크) / 작성. Chats 탭 [ad288189](https://mobbin.com/screens/ad288189-8efc-4c78-abdc-665dc9f088f5): "Today — Search for Mobbin 36m ago".
- **슬래시 메뉴** [9c0c8998](https://mobbin.com/screens/9c0c8998-0a70-4bda-89b9-1b43e43751b7): "Suggested: AI Image" → "Basic blocks: Text / Heading 1 `#` / Heading 2 `##` / … / Bulleted list `-`" — **행 오른쪽에 마크다운 단축 표기**. [5840d7b8](https://mobbin.com/screens/5840d7b8-6098-4288-a55f-02f4232fd051): "Page" 항목 호버 시 오른쪽 미니 프리뷰 카드("Embed a sub-page inside this page"), 블록 안 플레이스홀더 "/Type to search", 푸터 "Close menu esc". 섹션: Media([4cb25201](https://mobbin.com/screens/4cb25201-e4e1-4446-a1f8-813eba8c43af)), Database/Image creation([c9388934](https://mobbin.com/screens/c9388934-7f88-4b5c-a22f-bfad8ac38942)), Advanced(TOC/Button/Breadcrumb/Tabs/Synced/Toggle heading, [b8778e0e](https://mobbin.com/screens/b8778e0e-13d3-49a6-9f01-3680ea66249b)).
- **블록 핸들 메뉴** [1b58f34a](https://mobbin.com/screens/1b58f34a-4b59-4472-a281-4b1ed312a63a): "Search actions…" → "Text: Turn into ▸ / Color ▸" → "Copy link to block ⌥⌘L / Duplicate ⌘D / Move to ⌥⌘P / Delete Del" → "Comment ⌘⇧M / Suggest edits / Present from here" → "Ask AI ⌘J" → **푸터 "Last edited by samlee Today at 9:46 AM"**. Turn into 서브메뉴: Text ✓, H1–H4, Page, 목록 3종, Toggle, Code, Quote, Callout, Equation, Synced, Toggle heading 1–3, 2/3 columns.
- **빈 페이지** [53285746](https://mobbin.com/screens/53285746-8593-4bc2-bc5d-9f39ee7f9044): 커버(호버 시 Generate/Change/Reposition) + 아이콘 + "Add comment" + 제목, 본문 비었을 때 **"Get started with: Ask AI / AI Meeting Notes / Database / Form / Templates / …" 칩**. 상단 "✓ Verified" 배지, "Private ▾" 스코프.
- **페이지 헤더/메뉴** [e7b668c8](https://mobbin.com/screens/e7b668c8-648a-46c6-a32a-e65cd4c31dd7) / [536cd46b](https://mobbin.com/screens/536cd46b-0e91-41e2-adaf-7da374e4587f): 브레드크럼 "samlee's Space HQ / 🎨 SLMobbin — Creative Stra… / ✓ Verified", 오른쪽 "Edited just now · 아바타 · Share · 댓글 · ⭐ · ···". ··· 메뉴: "Search actions…", 폰트 3종, Copy link ⌥⌘L / Copy page contents / Duplicate ⌘D / Move to / Archive / Move to Trash, Present, Small text·Full width 토글, Lock page, Use with AI, Suggest edits, Translate, Undo, Import/Export, Turn into wiki, Updates & analytics, Version history.
- **버전 기록** [780626a3](https://mobbin.com/screens/780626a3-20f5-4795-ac3b-bdbaef325210) / [e8ed9805](https://mobbin.com/screens/e8ed9805-4357-4690-8bfc-9185f37c0a93): 왼쪽 해당 버전의 페이지 미리보기, 오른쪽 "Today · 4:27 PM samlee / 4:07 PM / … / Yesterday · 4:08 PM" 목록, 파란 Restore → "Restore to this version?" 확인.
- **대시보드** [6f460796](https://mobbin.com/screens/6f460796-c4d9-4d90-8694-f7d7346f2b78): 빈 대시보드 = "Getting started with your dashboard" 일러스트 카드 3장(Ask Notion AI to build / Add charts, tables, lists / Learn about filters across multiple data sources) + Skip. [41f32a46](https://mobbin.com/screens/41f32a46-0aa4-4205-a6ab-627135308029): 위젯 카드(Chart 도넛 "4 Total", Timeline 월별, 라인 Chart, Table) **각 헤더에 필터/정렬 아이콘**, "Done" 편집 종료. [bb44b319](https://mobbin.com/screens/bb44b319-bbfe-4dd7-a199-dcc3d6143fe5): 도넛 호버 툴팁 "Full-time 2 (50%) · Click to view data". [0b94c9f8](https://mobbin.com/screens/0b94c9f8-5d71-4d6b-9058-74bf3e9f0b18): "+" → "New view" 팝오버(Table/Board/Gallery/List/Chart/Timeline/Feed/Map/Calendar 아이콘 목록). [2dccc406](https://mobbin.com/screens/2dccc406-a707-4d26-9453-9a8eeb2d4acb): "Count all 4" 큰 숫자 위젯.
- **속성 추가 피커** [4e6e1f98](https://mobbin.com/screens/4e6e1f98-a567-4370-b392-ac28802481c7): "Type property name…" + "Suggested: Team Members / Project Start Date / …" + "Select type" 아이콘 그리드(Text/Number/Select/Status/Date/Person/…).
- **설정** [d138214d](https://mobbin.com/screens/d138214d-5351-4bd6-a2bb-c7b3648ea6a5) / [557dfb84](https://mobbin.com/screens/557dfb84-ff40-425d-b473-f0487e6cfc3e): 모달, 왼쪽 그룹 nav(Account/Workspace/Features/Admin/Access & billing), 오른쪽 "Preferences — Choose how you want Notion to look and behave", 섹션 제목 아래 **행 = 굵은 제목 + 한 줄 설명 + 오른쪽 컨트롤**(Theme Dark ▾ / Use Enter to add a new line 토글 / Language / Number format / Start week on Monday / Date format Relative ▾).
- **온보딩** flow [7a12675f](https://mobbin.com/flows/7a12675f-80fc-4608-9feb-7ec412cf55c5) / [757b6888](https://mobbin.com/flows/757b6888-6eaa-498d-9b18-c013c9a2ef4a) / [5783ec26](https://mobbin.com/flows/5783ec26-460a-4486-ab8a-439156dbcffa): "How are you planning to use Notion?" 일러스트 3카드 → 워크스페이스 생성 "Getting ready…" → 초대 → **워크스페이스 안의 "Getting Started" 체크리스트 페이지**("Hit / to see all the types of content", "See the ⋮⋮ … Click and drag", "Click + New Page", 토글 블록 팁, "Click the ? at the bottom right"). [bbe96eb7](https://mobbin.com/screens/bbe96eb7-1f0c-4cb4-b64b-6947abec45a8): 사이드바 Trial 행 위 "Welcome to your trial" 팝오버 = 썸네일 체크리스트 4개 + 잠긴 보상("unlock a rare accessory").
- **Library** [3016a8cd](https://mobbin.com/screens/3016a8cd-0f3c-442d-b3b5-e8711dd66753): 전체 페이지 테이블(탭 Teamspaces/Recents/Favorites/Shared/Private, 열 Page name/Created by/Source/Last edited time). myco의 Views 페이지는 사용 0으로 제거된 이력이 있어 제안에서 제외.
- 타사 참고(핸들 메뉴 검색 중 딸려옴): Craft [e38590cb](https://mobbin.com/screens/e38590cb-d496-4a37-84dc-4ff75cf3f77b) 왼쪽 고정 TOC + 블록 메뉴, Dovetail [e95cfacc](https://mobbin.com/screens/e95cfacc-9626-4c50-b23e-821ea0407439) 슬래시 항목마다 설명 한 줄 + 오른쪽 AI 요약의 번호 인용 칩, Confluence [e5d6b988](https://mobbin.com/screens/e5d6b988-c4f4-4b06-9680-998ab1e7badc) "Uses AI. Verify results." 문구 + Discard/Refine/Insert below/Replace.

## myco 현황 (읽고 확인한 것)

| 영역 | 파일 | 확인 내용 |
|---|---|---|
| 사이드바 | `components/Sidebar.tsx:49,126-138,165-176` | Favorites는 항목이 있을 때만, "Recently edited"는 기본 접힘이고 열릴 때만 mtime 조회. 행은 아이콘+텍스트뿐(`SidebarTree.tsx:43-58`), 호버 액션 없음, 우클릭 메뉴(`SidebarMenu.tsx`)에 즐겨찾기/이름변경 등. 볼트 전환은 Settings > Account(`pages/settings/Account.tsx:78,153`). |
| ⌘K | `components/CommandBar.tsx:194,231` | 빈 입력 = `[...actions(2), ...navs(10), ...lenses, ...pages].slice(0,12)` → 액션 2 + 네비 10, 페이지·최근 0. 행 = 아이콘+라벨+범용 태그(`file/page/action/lens`, 372-394). 연산자(`path: tag: type:…`)는 푸터 힌트 한 줄(466-473). 미리보기 없음. |
| Spotlight | `components/Spotlight.tsx` | 별도 always-on-top 창, 질문 1개 + 답. 별개 표면이라 비교 제외. |
| 슬래시 | `lib/editorCompletions.ts:129-`, `components/Editor.tsx:221-249` | 항목에 `block` 접두("# ", "- [ ] ")가 있으나 메뉴는 글리프+이름만 렌더. 호버 프리뷰 없음. |
| 빈 줄/빈 노트 | `lib/editorLive.ts:404-412`, `lib/newNote.ts:33-46` | 플레이스홀더는 빈 제목 줄("Heading N")만. 새 노트는 빈 본문으로 Live 모드 진입, 힌트/시작 칩 없음. 템플릿은 ⌘K·우클릭에서만(`TemplatePicker.tsx`). |
| 블록 메뉴 | `components/BlockMenu.tsx`, `lib/editorBlockHandle.ts:32` | 검색 + Turn into + Actions(복제/삭제/위·아래). 단축키 표기 없음, 바인딩은 Mod-/ 하나. 블록 메타 푸터 없음(문단 authorship 데이터는 `PageReader.tsx` `paraRuns`에 존재). |
| Ask | `pages/PageQuery.tsx:242-289,198-203,406-434,515-531,628-640,807-815` | 컴포저 상단 고정, 답변이 아래로 쌓이며 `endRef`로 스크롤(컴포저가 화면 밖으로). 답변 액션 = "Not what you expected? Log it" 하나(복사·👍 없음). 빈 상태는 정적 예시. 인용 번호 버튼은 페이지로 이동; `NodePreview`는 AnswerGalaxy에서만. `stores/queryStore.ts`는 메모리만(persist 없음). 입력은 plain `<input>`(멘션 없음). |
| 홈 | `components/EverydayHome.tsx`, `pages/PageOverview.tsx:132-141,184-236`, `components/RecentNotes.tsx:38-58` | 히어로(추가 버튼→Ingest) + Ask/Write 카드 + 최근 4개(이름+상대일, 폴더/타입 없음). 보드는 "Manage workspace" 접기 안. |
| 보드 | `components/OverviewBoard.tsx:361-378,393,416,455-464,741` | 빈 상태 = 텍스트 버튼 1개. 위젯 추가 = `<select>`+버튼. 보드 생성/삭제에 `window.prompt`/`window.confirm` 사용(앱 자체 `dialogStore.promptText/confirmAction`이 `TemplatePicker.tsx:27-47`, `newNote.ts:51`에서 이미 쓰임). 필터 1개만. |
| 페이지 헤더 | `components/Topbar.tsx:527-531`, `pages/PageReader.tsx:749-846` | 브레드크럼 = [볼트, 파일명]. Reader 액션 = Live/Preview + 레일 토글 + More(Source/작성자/카드 만들기/오디오). ⭐·이름변경·이동·삭제·경로복사는 사이드바 우클릭에만. |
| 속성 | `components/PropertiesPanel.tsx:196-255` | 키/값 자유 입력, 제안 없음, 타입 아이콘 없음(type/status/confidence는 select). |
| 아웃라인 | `components/ReaderRail.tsx:46-51`, `components/OutlinePanel.tsx` | 레일 안 섹션. 레일 닫히면 아웃라인도 사라짐. |
| 알림 | `stores/noticeStore.ts:33,57`, `components/NoticeStack.tsx`, `components/Topbar.tsx:395-397` | 토스트 최대 3개·TTL 후 소멸, 완료 필은 페이지 방문 시 소거. 지난 알림 목록 없음. |
| 히스토리 | `pages/PageReader.tsx:518-519,992-993`, `pages/PageHistory.tsx` | Reader "See it in history" → 전역 History(ingest 리포트·런 목록). 페이지 단위 버전 목록/복원 없음. |
| 설정 | `pages/PageSettings.tsx`, `components/SettingsCard.tsx:27-57`, `pages/settings/Appearance.tsx:47-53` | 검색·Changed only·기본/고급 그룹은 있음. `SettingsCard`는 값 칩+children만 — 제목/설명 슬롯 없어 패널마다 레이아웃이 다름(Appearance는 3카드 그리드). |
| 온보딩 | `components/OnboardingWizard.tsx`, `components/HelpWidget.tsx:15-43` | 5단계 모달 1회. 이후엔 정적 팁만. |

## 패턴 → 제안 (우선순위순)

### 1. [home/sidebar] Recents 항상 노출 + 타입 태그 — impact high / S
- 근거: 모든 Notion 웹 캡처의 사이드바 Recents(예 [41f32a46](https://mobbin.com/screens/41f32a46-0aa4-4205-a6ab-627135308029)), iOS Recents 캐러셀 [d120561c](https://mobbin.com/screens/d120561c-525c-42e5-a177-c5bfa948a721).
- 갭: `Sidebar.tsx:49` 기본 접힘, `RecentNotes.tsx` 이름+날짜만.
- 제안: `expandedFolders[RECENT_ID]` 기본값 true(uiStore), Overview가 이미 받는 mtimes(`PageOverview.tsx:110`)를 vaultStore로 올려 공유, 행에 frontmatter `type` 칩(`adjacency.meta`) + 폴더명 추가.

### 2. [search] ⌘K 빈 상태 = 최근 페이지, 결과 행 메타 + 미리보기 패널 — high / M
- 근거: [1ad05716](https://mobbin.com/screens/1ad05716-44a3-48d5-9150-5780546dd323).
- 갭: `CommandBar.tsx:194,231` 빈 상태에 페이지 0개; 행 메타·미리보기 없음.
- 제안: 빈 입력 시 "최근" 5개(mtimes는 "recent" 렌즈용으로 이미 로드, 63-78) + 액션 2 + 네비; 페이지 행에 폴더 경로·상대 mtime; 폭 ≥ 900px에서 선택 행의 `NodePreview`를 오른쪽 패널로.

### 3. [ai] 컴포저 하단 고정 + "↓" 버튼 — high / M
- 근거: [fe636b00](https://mobbin.com/screens/fe636b00-83ba-4864-82ed-02cfb03d40fc), [0c407e3c](https://mobbin.com/screens/0c407e3c-fb16-43d9-8be0-0c980374698d).
- 갭: `PageQuery.tsx:242-289` 상단 컴포저, 첫 답변 후 스크롤 아웃.
- 제안: `.ask-composer`를 페이지 스크롤 컨테이너 안 `position: sticky; bottom: 0`으로, 턴 목록을 위로; 바닥이 아닐 때 원형 "↓" 버튼. 옵션 disclosure는 컴포저 위에 붙임.

### 4. [editor] 빈 줄 "/ 로 블록" 플레이스홀더 + 빈 노트 시작 칩 — high / M
- 근거: [5840d7b8](https://mobbin.com/screens/5840d7b8-6098-4288-a55f-02f4232fd051) 블록 안 "/Type to search", [53285746](https://mobbin.com/screens/53285746-8593-4bc2-bc5d-9f39ee7f9044) "Get started with…" 칩, flow [7a12675f](https://mobbin.com/flows/7a12675f-80fc-4608-9feb-7ec412cf55c5) "Hit / to see all the types of content".
- 갭: `editorLive.ts:404-412` 제목 줄만 플레이스홀더; `newNote.ts` 빈 본문 진입.
- 제안: `LiveSpec`에 `empty-body` 추가(본문 첫 빈 줄에 `data-placeholder`), 본문 0바이트면 PageReader 편집기 위에 칩 3개(템플릿으로 시작→`newNoteFromTemplate`, 이 제목으로 Ask→`setQueryPrefill`, 붙여넣기). 기존 함수만 연결.

### 5. [consistency] 페이지 헤더: ⭐, 폴더 브레드크럼, 페이지 ··· 메뉴 — high / M
- 근거: [e7b668c8](https://mobbin.com/screens/e7b668c8-648a-46c6-a32a-e65cd4c31dd7), [536cd46b](https://mobbin.com/screens/536cd46b-0e91-41e2-adaf-7da374e4587f).
- 갭: `Topbar.tsx:527-531` [볼트, 파일명]; `PageReader.tsx:749-846` More에 소스/작성자/카드/오디오만; 즐겨찾기·이름변경·이동·삭제는 `SidebarMenu.tsx`에만.
- 제안: 브레드크럼에 폴더 체인(클릭→사이드바 폴더 펼침), 제목 옆 ⭐(`toggleFavorite`), SidebarMenu의 rename/move/delete/copy-path 핸들러를 Reader More 메뉴로 재사용, "수정 N분 전"(mtime) 표시.

### 6. [stability] 보드의 `window.prompt/confirm` → 앱 다이얼로그 — high(잠재 버그) / S
- 근거: Notion은 인앱 확인 [e8ed9805](https://mobbin.com/screens/e8ed9805-4357-4690-8bfc-9185f37c0a93). 일관성 근거는 myco 자체(`TemplatePicker.tsx:27-47`).
- 갭: `OverviewBoard.tsx:393,416`. Tauri WKWebView는 JS prompt/confirm에 UI delegate가 없어 null/false를 돌려줄 가능성이 큼 → "New board"가 동작하지 않을 수 있음(런타임 미검증, 추론).
- 제안: `promptText`/`confirmAction`으로 교체. 2줄 diff.

### 7. [ai] 답변 액션 행(복사·👍·👎) — medium / S
- 근거: [85c67e9a](https://mobbin.com/screens/85c67e9a-2900-4097-9e7a-5fb04d510b31), [031ca22c](https://mobbin.com/screens/031ca22c-4e38-4a3d-962d-b28df53f9c8d), iOS [0f612952](https://mobbin.com/screens/0f612952-7e93-4c44-b1ae-8879847d69f5).
- 갭: `PageQuery.tsx:515-531` "Log it" 하나.
- 제안: ExtractiveAnswer 아래 행 — 복사(인용 + `[[stem]]` 마크다운, `navigator.clipboard`, `noticeStore.push` 토스트), 👎 = 기존 `recordRecallMiss`(아이콘+툴팁으로 축약). 👍 저장 IPC는 없으므로 로컬 카운트만 또는 생략.

### 8. [ai] 인용 칩 클릭 = 인라인 원문/미리보기 펼침 — medium / S
- 근거: iOS [2c91507a](https://mobbin.com/screens/2c91507a-4037-445d-b67a-ccb63266e82e), [1c807ff3](https://mobbin.com/screens/1c807ff3-120e-47ad-9e6b-66f2c6386e17).
- 갭: `PageQuery.tsx:628-640` 번호 버튼이 즉시 페이지 이동; `NodePreview`는 갤럭시 별 클릭에만(807-815).
- 제안: 칩 클릭은 해당 인용 아래 `NodePreview`(경로·주변 문맥·열기 버튼) 토글, ⌘클릭은 기존 이동 유지.

### 9. [ai] 최근 질문 목록(빈 상태) — medium / S
- 근거: [a1d949f4](https://mobbin.com/screens/a1d949f4-fc76-450d-afe8-6477510a848b) "Recent chats", iOS [ad288189](https://mobbin.com/screens/ad288189-8efc-4c78-abdc-665dc9f088f5).
- 갭: `queryStore.ts` 메모리 전용; `PageQuery.tsx:406-434` 정적 예시만.
- 제안: 볼트별 최근 질문 20개를 localStorage(`PROFILE_HINT_DISMISSED_KEY`와 같은 try/catch 패턴)에 저장, 빈 상태에 "최근 질문" 칩 3–5개를 예시 위에.

### 10. [ai] 컴포저에서 페이지 멘션으로 범위 지정 — medium / L
- 근거: [7f5c8c5c](https://mobbin.com/screens/7f5c8c5c-01c0-4b83-a505-cf3fe0bd49bc) "Mention pages or people", [a1d949f4](https://mobbin.com/screens/a1d949f4-fc76-450d-afe8-6477510a848b) "My sources 2 ›".
- 갭: `PageQuery.tsx:248-261` plain input. Editor에는 wikilink 자동완성이 있음.
- 제안: 입력을 1줄 CodeMirror(wikilink 완성 소스만)로 바꾸고 멘션된 stem을 `ask`의 페이지 필터로 전달. recall IPC가 페이지 필터를 받는지는 미확인(L 판정 이유).

### 11. [home] 빈 보드 = 시작 카드 3장 — medium / S
- 근거: [6f460796](https://mobbin.com/screens/6f460796-c4d9-4d90-8694-f7d7346f2b78).
- 갭: `OverviewBoard.tsx:455-464` 텍스트 버튼 1개.
- 제안: `BOARD_PRESETS` 앞 3개를 카드로(클릭=즉시 추가) + "직접 만들기"; `.everyday-actions` 스타일 재사용.

### 12. [editor] 슬래시 행 오른쪽에 마크다운 단축 표기 — medium / S
- 근거: [9c0c8998](https://mobbin.com/screens/9c0c8998-0a70-4bda-89b9-1b43e43751b7).
- 갭: `editorCompletions.ts` `block` 접두가 있으나 미표시(`Editor.tsx:221-249`).
- 제안: 완성 행 렌더러에 `block.trim()`을 `<kbd>`로 우측 정렬. 프리뷰 카드는 생략.

### 13. [editor] 블록 메뉴 단축키 + 블록 메타 푸터 — medium / M
- 근거: [1b58f34a](https://mobbin.com/screens/1b58f34a-4b59-4472-a281-4b1ed312a63a).
- 갭: `BlockMenu.tsx` 단축키 없음, `editorBlockHandle.ts:32` Mod-/만; 문단 작성자 데이터는 `PageReader` `paraRuns`에 있음.
- 제안: Mod-D→`duplicateBlockTr` 바인딩 + 행에 kbd; 푸터에 캐럿 블록의 "작성 · agent · 3일 전".

### 14. [onboarding] 마법사 이후 지속형 "시작하기" 체크리스트 — medium / M
- 근거: flow [7a12675f](https://mobbin.com/flows/7a12675f-80fc-4608-9feb-7ec412cf55c5), [bbe96eb7](https://mobbin.com/screens/bbe96eb7-1f0c-4cb4-b64b-6947abec45a8).
- 갭: `OnboardingWizard.tsx` 1회 모달, 이후 `HelpWidget.tsx:15-43` 정적 팁.
- 제안: EverydayHome에 닫을 수 있는 카드 — 실제 상태로 체크(볼트 연결 / `reindexStore.indexedPages>0` / 첫 노트 / 첫 질문 / `settings.vault_history_enabled`), 전부 완료 시 자동 소멸.

### 15. [other] 알림 인박스(지난 알림 보관) — medium / M
- 근거: [2d3fa125](https://mobbin.com/screens/2d3fa125-ebc1-4b23-b3d2-86bc778b9da0), [4cc47c52](https://mobbin.com/screens/4cc47c52-d4a1-4cef-8405-ef7e06d2d91c), [d197acab](https://mobbin.com/screens/d197acab-453b-4c1b-b46f-87ef523f814d).
- 갭: `noticeStore.ts:33,57` 토스트 3개·TTL, `Topbar.tsx:395-397` 필은 방문 시 소거 → 놓친 결과를 다시 볼 곳이 없음.
- 제안: `noticeStore`에 `log: Notice[]`(최근 50) 추가, ActivityChip 팝오버(`ActivityPanel` 공용 바디)에 "지난 알림" 섹션 + 미열람 점.

### 16. [other] 페이지 단위 버전 목록 + 복원 — medium / L
- 근거: [780626a3](https://mobbin.com/screens/780626a3-20f5-4795-ac3b-bdbaef325210), [e8ed9805](https://mobbin.com/screens/e8ed9805-4357-4690-8bfc-9185f37c0a93).
- 갭: `PageReader.tsx:518-519,992-993` 전역 History로 이동만.
- 제안: `vault_history_enabled`일 때 ReaderRail에 "버전" 섹션(파일 git log, `DiffView` 재사용, 복원은 `confirmAction`). 파일 단위 log IPC 존재 여부 미확인(L).

### 17. [search] 연산자를 칩으로 노출 — medium / S
- 근거: [1ad05716](https://mobbin.com/screens/1ad05716-44a3-48d5-9150-5780546dd323).
- 갭: `CommandBar.tsx:466-473` 푸터 힌트 한 줄.
- 제안: 입력 아래 `type ▾` `tag ▾` `path ▾` 칩(클릭 시 연산자 삽입, 값은 `facetValues`), 렌즈 칩(`cr-tag`, 347) 스타일 재사용.

### 18. [editor] 아웃라인 플로팅 인디케이터 — low / M
- 근거: [45a51bbd](https://mobbin.com/screens/45a51bbd-c469-4654-bc61-2d2ecafaa79c), [1574fef0](https://mobbin.com/screens/1574fef0-d39a-405f-8215-e5cea83b0172) 오른쪽 가장자리 선 묶음.
- 갭: `ReaderRail.tsx:46-51` 레일 닫히면 아웃라인 없음.
- 제안: 레일 닫힘 + 제목 ≥ 3일 때 우측 고정 미니 바(제목당 12px, 현재 강조), 호버 시 제목 펼침.

### 19. [home] 위젯 추가 팝오버 + 위젯 헤더 컨트롤 — low / S
- 근거: [0b94c9f8](https://mobbin.com/screens/0b94c9f8-5d71-4d6b-9058-74bf3e9f0b18), [41f32a46](https://mobbin.com/screens/41f32a46-0aa4-4205-a6ab-627135308029), [bb44b319](https://mobbin.com/screens/bb44b319-bbfe-4dd7-a199-dcc3d6143fe5).
- 갭: `OverviewBoard.tsx:361-378` `<select>`; 클릭 상세(488-491)에 어포던스 문구 없음.
- 제안: 프리셋 목록을 아이콘 팝오버로; 위젯 호버 시 "클릭하면 데이터 보기" 툴팁.

### 20. [settings] 설정 행 해부 통일(제목+설명+컨트롤) — low / M
- 근거: [d138214d](https://mobbin.com/screens/d138214d-5351-4bd6-a2bb-c7b3648ea6a5).
- 갭: `SettingsCard.tsx:27-57` 제목/설명 슬롯 없음, 패널별 레이아웃 상이.
- 제안: `SettingsCard`에 선택적 `title`/`desc` prop → `.s-row` 헤더, 패널 점진 이전.

### 21. [editor] 속성 키 제안 + 타입 아이콘 — low / S
- 근거: [4e6e1f98](https://mobbin.com/screens/4e6e1f98-a567-4370-b392-ac28802481c7).
- 갭: `PropertiesPanel.tsx:196-255` 자유 입력.
- 제안: 키 입력에 `<datalist>`(볼트 전역 frontmatter 키), 알려진 키(`FM_TYPES` 등)엔 아이콘.

### 22. [ai] 모델 칩에서 즉시 전환 — low / S
- 근거: [58188761](https://mobbin.com/screens/58188761-2d93-43a2-be51-df5fee96707a).
- 갭: `Topbar.tsx:302-346` 상태 표시 + 설정 이동만.
- 제안: 팝오버에 활성 프로바이더 라디오 행(`settingsStore.query_provider` 쓰기).

## 검증 범위 메모
- 위 갭은 전부 파일 열람으로 확인. 런타임(설치본 실행) 검증은 하지 않음. #6의 WKWebView prompt 동작은 추론.
- 스크린샷은 Mobbin 인라인 프리뷰를 직접 읽고 기술함(메타데이터 요약 아님).
