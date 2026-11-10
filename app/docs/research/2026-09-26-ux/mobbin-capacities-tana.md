# Mobbin UX 리서치 — Capacities · Tana · Anytype 계열 (key: capacities-tana)

- 날짜: 2026-09-26
- 방법: Mobbin MCP 검색 16회 (screens 15 + flows 1). task_intent 고정: "Improve a local-first LLM wiki desktop app's dashboard, navigation, editor, graph and AI-answer UX by studying Notion, Obsidian and similar knowledge apps". platform web 우선, Obsidian·Logseq 계열만 ios.
- 비교 대상 코드: `~/prj/karpathy-editor-build/app/src` (설치본). 모든 갭은 해당 파일을 읽고 확인함.

## 0. 가용성 (없는 앱은 없다고 적음)

| 앱 | Mobbin | 비고 |
|---|---|---|
| Capacities | 없음 | web 질의 → Zillow/Klaviyo/HubSpot/Attio, ios 질의 → Retro/Journal/Bevel 등 무관한 앱만 반환 |
| Anytype | 없음 | web → HubSpot/Twenty/Fibery/Supabase, ios → Mammoth/ClickUp/Notion/Attio |
| Tana | 있음 (web) | Today, Library, To-Do, Activity, Search, AI Chat, Meetings, Space, Doc, onboarding flow까지 풍부 → 이 계열의 1차 근거 |
| Notion | 있음 (web/ios) | database·property·AI Q&A·Customize page 프록시 |
| Obsidian | 있음 (ios) | graph view 컨트롤·backlinks pane 프록시 |
| Logseq / Roam | 없음 | ios 질의 → stoic./Dot/Journal 등 저널 앱만 반환. 일간 노트 근거는 Tana Today로 대체 |
| 빈 상태 프록시 | Fabric, Attio, Evernote, Twenty | 노트/워크스페이스 빈 화면 |

## 1. 화면에서 실제로 본 것 (요약)

### Tana
- **Today** ([4297e674](https://mobbin.com/screens/4297e674-95c8-4646-afe9-96cc77cd4635)): 세리프 "Good Morning, Alex Smith" 제목, 우측 ‹ 📅 › 날짜 이동, "Ask or Capture..." 한 줄 입력(체크박스·@·이미지·마이크·전송 아이콘), 아래 Meet / Create / Search 칩, 섹션 Next Up(9:00 AM 회의 + 연결 문서 카드 2장) / Past / Pinned(+) / Chats. 달력 아이콘은 월 캘린더 팝오버 ([ad6644fa](https://mobbin.com/screens/ad6644fa-6e1f-45a3-acee-0a22a27f0f86)). 데이터 없을 때 본문 한가운데 "More please, — Sync your Calendar" 한 줄 넛지 ([04101346](https://mobbin.com/screens/04101346-6ff0-4e6f-a4e7-32d9784e43fa)).
- **Ask 입력에 컨텍스트 칩** ([6f3f108c](https://mobbin.com/screens/6f3f108c-92ad-445e-a28d-22bdab8f6e50), [cfff96f7](https://mobbin.com/screens/cfff96f7-c7b2-49ba-b7b1-8fac900caa30)): 프롬프트 위에 "Generate PRD · Skill", "Sync with design team… · In Progress", 이미지 썸네일 칩이 붙고, `@`를 치면 타입 배지(Checkpoints/Meeting Note/Decision)가 달린 객체 검색 드롭다운.
- **Create new… 메뉴** ([572a2ee5](https://mobbin.com/screens/572a2ee5-025a-4fcc-89a4-3b6fb354df19)): 연필 버튼 하나 → Meeting / Doc / Canvas / Task / Chat / Type / Space / Skill.
- **Library(프로필) 목록** ([427e3fb4](https://mobbin.com/screens/427e3fb4-2eb1-496a-91a4-6d1e2527253a)): Space ▾ / All types ▾ 필터, Today / Yesterday로 그룹, 열 = 제목 · Type(Chat, Meeting Note 배지, Decision, Skill, Canvas) · Lives in(Library/Team Hub) · 자물쇠.
- **검색 팔레트** ([7830189f](https://mobbin.com/screens/7830189f-0b30-4d2c-b3cf-4a23f42b5425), [91e0b7f8](https://mobbin.com/screens/91e0b7f8-65be-4bcb-811a-551a735b66d6), [39e2361c](https://mobbin.com/screens/39e2361c-0cb4-4a9c-86a9-3ca111111b3e)): 입력 아래 칩 Meetings / Chats / ⋮ / Created by ▾ / Visibility ▾. 빈 질의는 Spaces · Meetings(Recent 정렬) · Types · Agents · People · Skills 섹션 + "See all ›". 결과 표는 Title / Type / Lives in 열. 무결과 ([51add4e7](https://mobbin.com/screens/51add4e7-c5a7-4fb8-9366-34dde8c5eeb9)): 돋보기 아이콘 + "No results found" + "Try a different search term or adjust your filters".
- **AI 채팅** ([254e49a0](https://mobbin.com/screens/254e49a0-cf54-4a7c-8206-c706a58c6346), [cfd6099e](https://mobbin.com/screens/cfd6099e-a08b-482b-831f-7d818fec2ccc), [1f809649](https://mobbin.com/screens/1f809649-ac28-47c4-90fb-70a93a1d4720), [46b7ca98](https://mobbin.com/screens/46b7ca98-7f7f-4c1a-b089-1668560b688a)): 사용자 메시지 위에 첨부 컨텍스트 목록(Skill, 태스크, 이미지). 응답은 "Thought for 16 seconds ›" 접힘, 본문에 객체 인라인 참조, 그 아래 결과 카드("Shipment Delay Management System — PRD · Doc · Library" + 휴지통 + **Keep** 배지, 또는 **Update** 배지). 다음 화면엔 "Alex Smith accepted 1 change" 감사 줄. 중단 시 노란 배너 "AI response appears to have stopped. Reset".
- **Doc 페이지** ([73bcd93e](https://mobbin.com/screens/73bcd93e-3c5d-4d0d-b5e9-7c292e116c34), [df73c242](https://mobbin.com/screens/df73c242-3ec5-4f3e-9d29-8adc00694a88)): 제목 아래 타입 배지 "Meeting Note", 필드 행 Date / Attendees(아바타) / Related Project(배지). 우측 레일 = Table of Contents("No headings in this document") / Backlinks("Mentioned in ASMobbin Stand Up · Jun 12, 9:00 AM"; 빈 상태 아이콘 + "Other docs that link to this one will show up here") / Changes(시계 아이콘 + "Edits and updates will appear here as they happen").
- **To-Do** ([8f7056a0](https://mobbin.com/screens/8f7056a0-fe49-4cdd-820c-78147a8edcd2), [440bf8eb](https://mobbin.com/screens/440bf8eb-523f-4bde-84f5-241ee96e3606), [7169e4f9](https://mobbin.com/screens/7169e4f9-157e-405c-bcc8-9b46d30d4530)): 필터 칩 Assigned to / Created by / Type / Space, 표 열 Title · Type · Status · Assigned · Updated, 타입(Checkpoint)별 그룹, 상태 드롭다운 Inbox / In Progress / Completed / Later(아이콘). 타입 페이지 ([f757eeb2](https://mobbin.com/screens/f757eeb2-8424-4f6a-b963-c1ef040ece59))는 Active/Completed/Later 탭 + 칸반.
- **Activity** ([cefac3a7](https://mobbin.com/screens/cefac3a7-7b7c-4be2-9e27-cd79f641a3bb), [1802fe90](https://mobbin.com/screens/1802fe90-50d5-4bec-acb8-dfbc09dd237b)): 좌 Recents 표(Space/Meetings/Chats 필터, Today/Yesterday 그룹, Type 열), 우 Notifications("Mark all read", Unread ▾). 비었을 때 체크 아이콘 + "You're all caught up" + "No unread notifications — nicely done."
- **Space 페이지** ([efa214d0](https://mobbin.com/screens/efa214d0-93d4-48f9-a6cf-2c3b0053f351), flow [e3bd6954](https://mobbin.com/flows/e3bd6954-0235-4662-9cad-f5316954c5e5)): Pinned / Meetings / Types / Agents / Docs 섹션(See all), "Configure Space" 패널 = Title, Description, Color, Default Agent, AI Instructions textarea. 새 스페이스는 "Drag items here to pin them" 점선 박스만.
- **온보딩 flow** ([921b5ed3](https://mobbin.com/flows/921b5ed3-54ad-4c80-9dfa-229966af1f30)): 이메일/비번 → "Name your organization" → "Turn on your mic and camera"(권한별 이유 한 줄씩) → Today. 문서 생성 flow ([0346c00b](https://mobbin.com/flows/0346c00b-ff41-44b3-b90d-91216bd3ee26))는 Create new → 빈 Doc(우측 레일 Backlinks/Changes 빈 상태 그대로 노출).
- **회의 다이제스트** ([371a8f0d](https://mobbin.com/screens/371a8f0d-4835-4f74-95d7-223b56674b15)): "1 Pending item · 1 Pending Update" 카드 + "1 Accepted" 카드 — AI 제안을 보류/수락 상태로 카드화.

### Notion
- **AI Q&A** ([fec09ec2](https://mobbin.com/screens/fec09ec2-fba4-45b2-98ad-28e6366bd642), [4f5455f9](https://mobbin.com/screens/4f5455f9-bd96-4d45-ae56-33838f2e4d71)): 불릿마다 번호 인용 마커, 하단 "8 citations" 버튼 → 타임스탬프 달린 전사 줄 팝오버, 👍👎.
- **Property 추가** ([4e6e1f98](https://mobbin.com/screens/4e6e1f98-a567-4370-b392-ac28802481c7)): "Type property name…" 입력, Suggested(Team Members, Project Start Date…) 섹션, Select type 그리드(Text/Number/Select/Status/Person/Date/…). 보드 ([69f98d1d](https://mobbin.com/screens/69f98d1d-b556-4a33-90f4-a0e98b6b9032))는 "Property visibility" 패널로 카드에 보일 속성 토글.
- **Customize page** ([ff1d684c](https://mobbin.com/screens/ff1d684c-08e6-454d-af4c-f0d0d57e6308)): Backlinks "Show on hover" / Page discussions / Table of contents / Inline comments 토글.

### Obsidian (iOS)
- **Graph view** ([a4e27535](https://mobbin.com/screens/a4e27535-090f-40de-81c2-fa8e83703b8b), [6239ed2b](https://mobbin.com/screens/6239ed2b-70fd-4c8d-aa22-f8c7b467d4a8), [ac93a668](https://mobbin.com/screens/ac93a668-ffbc-43dd-8437-8428767713a1), [cb5ed1c3](https://mobbin.com/screens/cb5ed1c3-4e42-457b-a170-0cc4f417345a), [fe673348](https://mobbin.com/screens/fe673348-8160-48be-a481-66560fb027d7), [726f86eb](https://mobbin.com/screens/726f86eb-6bb9-416c-acd1-5a37efb6c568)): 4개 접힘 섹션 Filters(검색, Tags/Attachments/Existing files only/Orphans 토글) · Groups("Enter query…" + 색 점, path:/file:/tag:/line:/section: 옵션 안내, 그룹 "Trip"이 노드 색을 바꿈) · Display(Arrows, Text fade, Node size, Link thickness, Animate) · Forces(4 슬라이더), 상단 리셋 버튼.
- **Backlinks pane** ([59932f82](https://mobbin.com/screens/59932f82-a889-4b24-b5a6-75be8965334e)): "Linked mentions 1" → 소스 노트별 접힘, 링크 문맥 문장에 `[[2 Day Trip Plan to NYC]]` 하이라이트; "Unlinked mentions" 섹션; 하단 정렬/접기/검색 아이콘, "Backlinks" 토글 바 + 단어·글자 수.

### 빈 상태 프록시
- Fabric ([2e4b53f6](https://mobbin.com/screens/2e4b53f6-7e3e-4604-8c70-38245f431dae)): 일러스트 + "Let's add our first item!" + 하단 플로팅 ＋/검색.
- Attio ([8069cf5f](https://mobbin.com/screens/8069cf5f-e09a-4089-a50d-84c16a471949)): "No notes" + "Create your first note using the button below." + New note 버튼; Favorites 영역도 자체 빈 카피.
- Evernote ([c723a6bd](https://mobbin.com/screens/c723a6bd-6b0b-4b25-a938-76bb2d2b61c6)): 아이콘 + "There are many ways to fill a space" + 1차 CTA(Create a note) + 2차 링크 2개(Create a notebook / Move from Notebooks) + "See example spaces".
- Twenty ([de2c33e7](https://mobbin.com/screens/de2c33e7-9982-4424-973a-c7beccf0c87d)): 빈 표 헤더는 유지하고 중앙에 "Add your first Note" + 보조 문장 + 버튼.

## 2. 패턴 → myco 갭 → 제안

형식: **패턴** · 왜 먹히는가 · 근거 · myco 현재(파일) · 제안 · 영향/노력

### 2.1 home

**P1. 하루 단위 헤더 + ‹ › 날짜 이동 (Tana Today)**
- 왜: 홈이 "오늘"에 닻을 내리면 어제로 한 번, 지난주로 몇 번 넘겨보는 회고가 자연스럽다. 캘린더 팝오버로 임의 날짜 점프.
- 근거: [4297e674](https://mobbin.com/screens/4297e674-95c8-4646-afe9-96cc77cd4635), [ad6644fa](https://mobbin.com/screens/ad6644fa-6e1f-45a3-acee-0a22a27f0f86)
- myco: `pages/PageOverview.tsx` 제목은 `t.nav_overview`, `components/EverydayHome.tsx`의 hero는 정적 `home_title`. 일간 노트는 `components/Sidebar.tsx:543 DailyNoteButton`이 오늘 파일만 열고, `pages/PageReader.tsx`에는 daily prev/next 없음(grep 0건).
- 제안: 홈 상단을 "인사말 + 오늘 날짜 + ‹ ›"로. ‹ ›는 `daily/<date>.md`를 열되 없으면 DailyNoteButton 로직(`lib/`로 추출)으로 생성. 같은 헤더를 daily 노트 Reader에도 붙여 날짜 간 이동.
- 영향 medium / 노력 M

**P2. "Ask or Capture…" 단일 입력 (Tana Today)**
- 왜: 홈에서 질문과 메모를 같은 상자에 치고 의도는 전송 방식으로 가른다. 라우팅 결정을 사용자가 안 함.
- 근거: [4297e674](https://mobbin.com/screens/4297e674-95c8-4646-afe9-96cc77cd4635), [6f3f108c](https://mobbin.com/screens/6f3f108c-92ad-445e-a28d-22bdab8f6e50)
- myco: `EverydayHome.tsx`는 Ask/Write 두 개의 **이동 버튼**(`setRoute("query")`, `promptNewNote`)이고 인라인 입력이 없다. 캡처는 `NotchPanel`(`notch_capture` "⏎ daily note")과 `Spotlight.tsx`(ask + 음성)에만 있음.
- 제안: hero에 입력 하나. ⏎ → `lib/queryPrefill` 로 prefill 후 `setRoute("query")`; ⌘⏎ → notch가 쓰는 daily 노트 append 경로 재사용; 마이크 버튼은 Spotlight의 voice machine 재사용. 아래에 예시 질문 칩(이미 `copy.examples`가 `PageQuery.tsx:415`에 있음).
- 영향 high / 노력 M

**P3. Pinned 섹션 (Tana Today)**
- 왜: 즐겨찾기가 홈에 있어야 "매일 여는 3개"가 클릭 한 번.
- 근거: [4297e674](https://mobbin.com/screens/4297e674-95c8-4646-afe9-96cc77cd4635)
- myco: 즐겨찾기는 `Sidebar.tsx`의 `syntheticGroup(FAVORITES_ID…)`에만. `PageOverview.tsx`/`OverviewBoard.tsx`/`EverydayHome.tsx`에 favorites 참조 0건.
- 제안: `EverydayHome`에 `useVaultStore.favorites` 기반 Pinned 행(빈 상태: "사이드바에서 ★로 고정"). 
- 영향 medium / 노력 S

**P4. 최근 목록에 Type · 위치 열 + 날짜 그룹 (Tana Library)**
- 왜: "어제 만진 것 중 decision만" 같은 훑어보기가 표에서 바로 됨.
- 근거: [427e3fb4](https://mobbin.com/screens/427e3fb4-2eb1-496a-91a4-6d1e2527253a), Craft All Docs 정렬 메뉴 [5973d6ab](https://mobbin.com/screens/5973d6ab-4d8f-43ba-9097-16b0f888ef80)
- myco: `components/RecentNotes.tsx`는 stem + `Intl.RelativeTimeFormat` 날짜만. `adjacency.meta[path].type`(`lib/ipc.ts:57 NodeMeta`)는 있는데 안 씀.
- 제안: 행에 타입 점(`DashCharts.TYPE_COLORS`)과 폴더 crumb 추가, Today/Yesterday/Earlier 그룹, 상단에 type ▾ 필터(`lib/queryViews.facetValues`).
- 영향 medium / 노력 S

### 2.2 sidebar

**P5. "+ New" 타입 메뉴 (Tana Create new…)**
- 왜: 생성 진입점이 하나면 "템플릿으로/일간/태스크/폴더"를 외울 필요가 없다.
- 근거: [572a2ee5](https://mobbin.com/screens/572a2ee5-025a-4fcc-89a4-3b6fb354df19), flow [0346c00b](https://mobbin.com/flows/0346c00b-ff41-44b3-b90d-91216bd3ee26)
- myco: `Sidebar.tsx:530` "New note" 버튼 → `promptNewNote`; 템플릿은 `SidebarMenu.tsx:90` 컨텍스트 메뉴와 ⌘K에만; 일간 노트는 별도 qbtn; 태스크는 Tasks 페이지 `TaskComposer`에서만; 소스는 Ingest 페이지.
- 제안: 사이드바 ＋ → 메뉴: Note / From template… / Daily note / Task(오늘 daily에 `appendTaskLine`) / Folder / Ingest source. 기존 함수 호출만 묶는다.
- 영향 medium / 노력 S

### 2.3 search

**P6. 필터 칩 + 타입 배지 + 섹션 "See all" (Tana Search)**
- 왜: 연산자를 기억하지 않아도 칩으로 좁힌다. 결과 행의 타입 배지가 스캔 속도를 올린다.
- 근거: [7830189f](https://mobbin.com/screens/7830189f-0b30-4d2c-b3cf-4a23f42b5425), [91e0b7f8](https://mobbin.com/screens/91e0b7f8-65be-4bcb-811a-551a735b66d6), [39e2361c](https://mobbin.com/screens/39e2361c-0cb4-4a9c-86a9-3ca111111b3e)
- myco: `components/CommandBar.tsx` 행 태그는 file/page/lens/action 넷뿐(370–395행). `lib/searchQuery.ts`에 `type:/status:/confidence:/tag:/path:` 연산자가 있지만 타이핑해야만 보임. 렌즈(`BUILTIN_LENSES`)는 목록 행으로만 노출.
- 제안: 입력 아래 칩 행 type ▾ / status ▾ / tag ▾ (`facetValues`로 값 채움, 선택 시 `q`에 연산자 삽입) + 렌즈 4개를 칩으로. 파일 행에 `meta.type` 배지.
- 영향 high / 노력 M

**P7. 무결과 = 힌트 + 만들기/묻기 (Tana no results)**
- 왜: 검색 실패는 새 노트나 질문의 시작점이다. 막다른 길을 없앤다.
- 근거: [51add4e7](https://mobbin.com/screens/51add4e7-c5a7-4fb8-9366-34dde8c5eeb9)
- myco: `CommandBar.tsx:370` `cb_no_results` "No results" 한 줄. base 목록의 "New note" action은 라벨 매칭이라 질의어가 있으면 사라짐(227–230행 `filtered`).
- 제안: 무결과 행을 "'{q}'로 새 노트 만들기"(`promptNewNote` 제목 prefill) + "'{q}' 위키에 묻기"(`queryPrefill` + `setRoute("query")`) + 힌트("필터/연산자 조정")로 교체.
- 영향 high / 노력 S

### 2.4 ai (Ask / Agent)

**P8. @컨텍스트 칩으로 질문 고정 (Tana Ask)**
- 왜: "이 노트 기준으로" 묻는 게 스코프 세그먼트보다 정확하고, 어떤 컨텍스트로 답했는지 턴에 남는다.
- 근거: [6f3f108c](https://mobbin.com/screens/6f3f108c-92ad-445e-a28d-22bdab8f6e50), [cfff96f7](https://mobbin.com/screens/cfff96f7-c7b2-49ba-b7b1-8fac900caa30)
- myco: `pages/PageQuery.tsx:246–288` composer = 입력 + 스코프 세그먼트(wiki/sessions/all). 페이지를 지정할 방법 없음. 턴 헤더엔 `q_scope_chip`만.
- 제안: 입력에서 `@` → 페이지 피커(CommandBar의 파일 목록 재사용) → 칩. 검색 시 해당 페이지 + `ipc.relatedPages`/MCP `neighbourhood` 이웃으로 후보를 제한하고 턴 헤더에 칩 표시. 추출형 답변 원칙은 그대로.
- 영향 high / 노력 M

**P9. AI가 만든 페이지 = 카드(Keep/Undo) + 감사 줄 (Tana)**
- 왜: 쓰기 결과가 카드로 보이고 되돌릴 수 있으면 "에이전트 쓰기 허용"을 켤 수 있다. "accepted 1 change" 한 줄이 신뢰를 만든다.
- 근거: [cfd6099e](https://mobbin.com/screens/cfd6099e-a08b-482b-831f-7d818fec2ccc), [1f809649](https://mobbin.com/screens/1f809649-ac28-47c4-90fb-70a93a1d4720), [254e49a0](https://mobbin.com/screens/254e49a0-cf54-4a7c-8206-c706a58c6346), [371a8f0d](https://mobbin.com/screens/371a8f0d-4835-4f74-95d7-223b56674b15)
- myco: `components/AgentPanel.tsx:265–283` 스텝 행은 `tool · args · result 텍스트 · declined`뿐. 쓰기 전 confirm만 있고 쓴 뒤 열기/되돌리기 없음.
- 제안: `write_page/create_page` 스텝은 페이지 카드(제목·폴더·Open·Revert)로 렌더. Revert는 `PageReader.tsx:495`가 쓰는 history IPC 재사용(git 없으면 스텝의 이전 본문 스냅샷으로 복원). 답변 아래 "이번 턴 쓰기 N건 수락" 한 줄.
- 영향 high / 노력 M

**P10. 👍 신호 (Notion Q&A)** — 낮음
- 왜: 부정(miss)만 기록하면 검색 튜닝에 양성 예가 없다.
- 근거: [fec09ec2](https://mobbin.com/screens/fec09ec2-fba4-45b2-98ad-28e6366bd642)
- myco: `PageQuery.tsx:529` `q_miss_btn` "Not what you expected? Log it"만. 인라인 번호 인용(624–646행)·SourceLadder·RetrievalStepper는 Notion보다 나음(패리티 이상).
- 제안: miss 버튼 옆 👍 → Feedback 페이지에 positive 로그. 
- 영향 low / 노력 S

### 2.5 editor (Reader)

**P11. 제목 아래 타입 배지 + 핵심 필드 (Tana Doc)**
- 왜: 노트가 무엇(type)이고 어떤 상태인지 본문 첫 줄에서 읽힌다.
- 근거: [73bcd93e](https://mobbin.com/screens/73bcd93e-3c5d-4d0d-b5e9-7c292e116c34)
- myco: `pages/PageReader.tsx:697–701` 헤더 typebadge가 **하드코딩 "file"**(`t-overview` 점). `parseFrontmatter` 결과 `fm`은 `ReaderRail`의 PropertiesPanel에만 감.
- 제안: 배지를 `fm.type ?? "note"`로, 옆에 status(superseded/disputed는 경고색)·confidence 칩. 클릭 → 레일 Properties 포커스.
- 영향 medium / 노력 S

**P12. 백링크 문맥 스니펫 + Unlinked mentions (Obsidian, Tana)**
- 왜: "누가 왜 링크했나"가 이름만으로는 안 읽힌다. 미링크 언급은 링크 밀도를 올리는 가장 싼 방법.
- 근거: [59932f82](https://mobbin.com/screens/59932f82-a889-4b24-b5a6-75be8965334e), [73bcd93e](https://mobbin.com/screens/73bcd93e-3c5d-4d0d-b5e9-7c292e116c34)
- myco: `lib/readerRail.ts:11 ConnRow` = kind/path/name/score. `components/ConnectionsPanel.tsx`는 이름 + 태그 + %만. "unlinked" UI 0건(grep: GraphGaps 주석·i18n 한 줄만).
- 제안: backlink 행에 링크 줄 스니펫(CommandBar가 쓰는 content search `SearchHit.snippet/line` 재사용, `[[stem]]` 질의). "Unlinked mentions" 하위 목록(bare stem 검색 − 이미 링크된 것) + "링크로 바꾸기"(`insert`/`acceptSuggestion` 경로).
- 영향 high / 노력 M

**P13. "Changes" 레일 + 정직한 빈 상태 (Tana Doc)**
- 왜: 이 노트의 변경 이력이 옆에 있으면 히스토리 페이지로 나갈 일이 준다. 빈 상태 카피가 "언젠가 여기 나타난다"를 약속한다.
- 근거: [73bcd93e](https://mobbin.com/screens/73bcd93e-3c5d-4d0d-b5e9-7c292e116c34), flow [0346c00b](https://mobbin.com/flows/0346c00b-ff41-44b3-b90d-91216bd3ee26)
- myco: `components/ReaderRail.tsx` = Properties → Outline → Sources → Connections. 이력은 전역 `PageHistory`(distill 런 목록)와 authorship 배지(`PageReader.tsx:157` "no history means no claim")뿐.
- 제안: Rail "Changes": git이 있으면 이 파일을 건드린 커밋 N개(`ipc.pageAuthorship`의 데이터원), 없으면 mtime 한 줄 + "Settings에서 vault history 켜기" CTA(Q4 로드맵 opt-in git과 결합).
- 영향 medium / 노력 M

**P14. 속성 추가 시 Suggested 키 + 타입별 컨트롤 (Notion)**
- 왜: 스키마가 있는 위키(type/status/confidence)에서 키를 손으로 치게 하면 오타가 스키마를 깬다.
- 근거: [4e6e1f98](https://mobbin.com/screens/4e6e1f98-a567-4370-b392-ac28802481c7)
- myco: `components/PropertiesPanel.tsx` `AddRow`는 자유 key + 자유 value(KEY_RE 검증만). ENUMS(type/status/confidence)는 이미 존재하는 행에만 적용.
- 제안: key 입력에 datalist(FM 스키마 키 + `adjacency.meta`에서 본 키), 알려진 키 선택 시 value 컨트롤이 기존 행과 같은 select/ChipInput로 전환.
- 영향 medium / 노력 S

**P15. 레일 섹션별 접힘 기억 (Notion Customize page)** — 낮음
- 근거: [ff1d684c](https://mobbin.com/screens/ff1d684c-08e6-454d-af4c-f0d0d57e6308)
- myco: `uiStore.propsCollapsed`는 Properties만. Outline/Sources/Connections는 `Rail`에 `onToggle` 없이 항상 열림.
- 제안: `uiStore`에 `railCollapsed: Record<section, boolean>` 하나, 네 섹션 모두 `onToggle` 연결.
- 영향 low / 노력 S

### 2.6 graph

**P16. Groups: 질의 기반 색 규칙 (Obsidian)**
- 왜: "path:wiki/decisions는 주황, tag:#question은 파랑"처럼 사용자가 의미 색을 정의하면 갤럭시 자동색과 겹쳐도 질문에 답하는 지도가 된다.
- 근거: [6239ed2b](https://mobbin.com/screens/6239ed2b-70fd-4c8d-aa22-f8c7b467d4a8), [ac93a668](https://mobbin.com/screens/ac93a668-ffbc-43dd-8437-8428767713a1), [cb5ed1c3](https://mobbin.com/screens/cb5ed1c3-4e42-457b-a170-0cc4f417345a)
- myco: `components/GraphControls.tsx` Filters(313–412행) = search(path:/tag:), 태그 칩, 폴더 select, orphans, existing-only. 색은 갤럭시(폴더/Louvain)별 자동. `rule|colorBy` grep 0건.
- 제안: "Groups" 섹션: {query, color} 목록. `settings.search`와 같은 파서로 매칭, 매칭 노드는 규칙 색 우선. 저장 look에 포함(`saveLook`이 settings 전체를 저장하므로 필드 추가만).
- 영향 medium / 노력 M

### 2.7 other — tasks

**P17. 필터 칩 + 타입/페이지 열 (Tana To-Do)**
- 왜: 볼트 전체 체크박스는 금방 수십 개. "이 페이지/이 태그/이번 주"로 자르는 칩이 없으면 보드도 목록도 스크롤 벽.
- 근거: [8f7056a0](https://mobbin.com/screens/8f7056a0-fe49-4cdd-820c-78147a8edcd2), [440bf8eb](https://mobbin.com/screens/440bf8eb-523f-4bde-84f5-241ee96e3606), [7169e4f9](https://mobbin.com/screens/7169e4f9-157e-405c-bcc8-9b46d30d4530)
- myco: `pages/PageTasks.tsx:341–356` tools = view Segment(List/Board/Calendar/Roadmap)뿐. 목록은 "{n} open / {n} done" 칩(470–500행). `TaskItem.page`, `extractTags`는 있는데 필터 UI 없음. 상태 칸반 4열은 Tana와 패리티.
- 제안: Segment 옆 칩 page ▾ / tag ▾ / due(overdue·today·week) — `tasks` 배열 클라이언트 필터, 네 뷰 공통 적용.
- 영향 medium / 노력 S

### 2.8 other — activity/notifications

**P18. 알림 로그 + "You're all caught up" (Tana Activity)**
- 왜: 토스트는 지나가면 끝. 놓친 알림을 다시 볼 곳과 "다 봤다"는 마침표가 있어야 알림을 믿는다.
- 근거: [cefac3a7](https://mobbin.com/screens/cefac3a7-7b7c-4be2-9e27-cd79f641a3bb), [1802fe90](https://mobbin.com/screens/1802fe90-50d5-4bec-acb8-dfbc09dd237b)
- myco: `components/NoticeStack.tsx` 토스트는 휘발. `ActivityChip.tsx` 팝오버는 진행 중 작업, tray는 `tray_sub_clear` "Nothing waiting". 지난 알림 목록 없음.
- 제안: noticeStore에 최근 20건 + read 플래그, ActivityChip 팝오버에 "Notifications" 섹션 + Mark all read, 빈 상태 카피(체크 아이콘 + 한 줄).
- 영향 low / 노력 S

### 2.9 empty_state / consistency

**P19. EmptyState 프리미티브 (Evernote·Attio·Twenty·Fabric·Tana rail)**
- 왜: 아이콘 + 헤드라인 + 한 줄 이유 + 1차 CTA + 2차 대안이 모든 빈 화면에서 같은 목소리면 앱이 하나로 읽힌다.
- 근거: [c723a6bd](https://mobbin.com/screens/c723a6bd-6b0b-4b25-a938-76bb2d2b61c6), [8069cf5f](https://mobbin.com/screens/8069cf5f-e09a-4089-a50d-84c16a471949), [de2c33e7](https://mobbin.com/screens/de2c33e7-9982-4424-973a-c7beccf0c87d), [2e4b53f6](https://mobbin.com/screens/2e4b53f6-7e3e-4604-8c70-38245f431dae), [df73c242](https://mobbin.com/screens/df73c242-3ec5-4f3e-9d29-8adc00694a88)
- myco: `components/ui/` = Button/Check/Chip/Hero/IconButton/Segment — EmptyState 없음. 빈 상태가 제각각: `Sidebar.tsx:433` muted "Empty vault"(CTA 없음), `PageTasks.tsx:470` 카드+힌트(CTA 없음), `OutlinePanel` "No headings yet", `ConnectionsPanel` "Nothing links here yet."(index==0일 때만 CTA), `PageGraph.tsx:2235` `gr_empty_pre/post`.
- 제안: `ui/EmptyState`(icon, title, hint, action, secondary[]) 추가 후 다섯 곳 교체. 사이드바 빈 볼트는 New note / From template / Ingest a source 세 가지 진입.
- 영향 medium / 노력 S

**P20. 상태 기반 "다음 한 걸음" 넛지 (Tana "More please — Sync your Calendar", 온보딩 권한 설명)**
- 왜: 온보딩 뒤 첫 홈에서 "지금 제일 가치 있는 다음 행동" 하나만 보여준다. 권한 요청도 이유를 한 줄씩.
- 근거: [04101346](https://mobbin.com/screens/04101346-6ff0-4e6f-a4e7-32d9784e43fa), flow [921b5ed3](https://mobbin.com/flows/921b5ed3-54ad-4c80-9dfa-229966af1f30)
- myco: 넛지가 흩어져 있음 — `ConnectionsPanel.tsx` index==0 CTA, `PageQuery.tsx:370` 프로필 힌트, `EverydayHome` "Add" 버튼. `PageOverview.tsx`는 상태에 따라 바뀌는 단일 카드 없음.
- 제안: 홈에 우선순위 1개짜리 nudge: 페이지 0 → 첫 소스 ingest; 인덱스 없음 → Ollama/semantic 설정; 프로필 없음 → 프로필; 모두 충족 → 숨김. 기존 세 CTA의 조건을 그대로 모은다.
- 영향 medium / 노력 S

### 2.10 other — folder landing (장기)

**P21. 폴더(Space) 랜딩 페이지 + 폴더별 AI Instructions (Tana Space)**
- 근거: [efa214d0](https://mobbin.com/screens/efa214d0-93d4-48f9-a6cf-2c3b0053f351), flow [e3bd6954](https://mobbin.com/flows/e3bd6954-0235-4662-9cad-f5316954c5e5)
- myco: 폴더는 `SidebarTree` 행일 뿐, 클릭하면 펼침만. 프로필은 볼트 전역(`lib/profile.ts` role/goals/interests/style).
- 제안: 폴더명 클릭 → 폴더 페이지(Pinned, 최근, 타입 분포 `facetValues`, distill이 만든 map 페이지 링크) + 폴더 `_instructions.md`를 profile 주입에 합침.
- 영향 medium / 노력 L

## 3. 이미 패리티인 것 (추가 작업 불필요)
- Tana "Thought for 16 s ›" ↔ `RetrievalStepper` 7단계; Tana "AI response stopped · Reset" ↔ `q_retrieval_failed` + Model settings 링크.
- Notion 번호 인용 ↔ `PageQuery` `ask-cite` 번호 + SourceLadder + similarity %. myco가 더 투명함.
- Tana 상태 칸반(Inbox/In Progress/Completed/Later) ↔ `TaskBoard` 4열(todo/doing/blocked/done).
- Obsidian Filters(orphans, existing only, path:/tag:) ↔ `GraphControls` Filters 동일 항목 보유. Forces/Display 슬라이더도 보유.

## 4. 권장 순서 (영향 ÷ 노력)
1. P7 무결과 → 만들기/묻기 (S, high)
2. P11 헤더 타입 배지 (S, medium) — 하드코딩 "file" 제거
3. P3 Pinned 홈 (S) · P4 최근 목록 타입 열 (S) · P19 EmptyState (S) · P5 + New 메뉴 (S) · P17 태스크 필터 칩 (S) · P20 nudge (S) · P14 속성 키 제안 (S)
4. P6 검색 칩 (M, high) · P8 @컨텍스트 (M, high) · P12 백링크 스니펫/unlinked (M, high) · P9 에이전트 쓰기 카드 (M, high)
5. P2 홈 단일 입력 (M) · P1 날짜 헤더 (M) · P13 Changes 레일 (M) · P16 그래프 Groups (M)
6. P21 폴더 페이지 (L) · P10/P15/P18 (low)
