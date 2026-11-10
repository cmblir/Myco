# Mobbin UX 리서치 — AI 답변 (key: ai-answers)

대상 앱군: NotebookLM(Mobbin 명칭 "Gemini Notebook"), Perplexity(Spaces/History), ChatGPT(Projects), Claude(Projects), Microsoft Copilot, Elicit, Qatalog, Mistral Le Chat, Notion AI, Delphi, WRITER, Grammarly, TravelPerk.
비교 대상 myco 트리: `~/prj/karpathy-editor-build/app/src` (설치본).

Mobbin 검색 16회. 모든 스크린은 이미지를 직접 확인했다.

## Mobbin에 없는 것 / 대체한 것

- **Glean**: Mobbin에 없음. "Glean enterprise search answer" 검색은 Copilot·Delphi·Dropbox Dash·Basecamp만 반환. 엔터프라이즈 검색 답변은 Copilot References 화면으로 대체.
- **NotebookLM**: "Gemini Notebook"으로 수록됨. 노트북 첫 화면(소스 요약 + 추천 질문) 스크린은 검색되지 않았고, Gemini 거래소 화면만 반환됨 → 해당 패턴은 기록하지 않음.
- **"소스에서 찾지 못함" 전용 화면**: NotebookLM·Perplexity·ChatGPT·Claude 어느 것도 Mobbin에 없음. 가장 가까운 것은 TravelPerk의 한 줄 응답. myco의 AbstainCard가 이 앱군보다 앞서 있다는 뜻이다.
- **Claude Projects**: 프로젝트 페이지(Instructions/Files 우측 레일)만 있고, 프로젝트 파일을 인용하는 답변 스크린은 없음.

## myco 현재 상태 (읽은 파일)

- `pages/PageQuery.tsx` — 컴포저(상단 카드, 242–289) → 옵션 `<details>` → 턴 목록(398–576). 턴 = 질문행 + RetrievalStepper(`<details>`) + AbstainCard | ExtractiveAnswer(인용 pill + SourceLadder 레일) | Viewer. 턴 액션은 "기대한 답이 아니었나요? 기록하기" 하나(515–531).
- `stores/queryStore.ts` — 턴은 메모리 전용(`turns: []`, `clear()`), 타임스탬프 없음(스토어의 `startedAt`만), 취소 없음. 추출형 경로는 `retrieveChunks` 1회 IPC → 즉시 완성.
- `components/AbstainCard.tsx` — 제목/부제(질문, 색인 쪽수, floor), near-miss 게이지(floor 눈금), 수확 등록 + 범위 확장 + 영수증.
- `components/RetrievalStepper.tsx` — 7단계 한 줄 스텝퍼, 답변 **후**에만 `<details>` 안에서 보임.
- `components/SourceLadder.tsx` — 순위·stem·tier 칩·인용문·band, 상세 토글 시 cosine/RRF×prior/Δ. 페이지 **제목**은 없음(`ScoredChunk`에 title 필드 없음, `lib/ipc.ts:212–234`).
- `components/Spotlight.tsx` + `lib/spotlight.ts` — 별도 webview. 메인 창이 같은 `ask()`를 돌리고 `{question, answer, error, extractive}`만 되돌려 줌. `abstained`는 전달되지 않음.
- `styles.css:10127–10216` — `.ask-split` 2열(340px 레일), 미디어쿼리(10134)에서 1열로 스택. `.ask-cite`는 glow만, 팝오버 없음.
- 클립보드 사용처: `pages/settings/Mcp.tsx:35`뿐. Ask 페이지에는 복사/저장/공유 없음.

---

## 패턴

### 1. 컴포저를 스레드 하단에 고정 (Perplexity, ChatGPT, Gemini Notebook)
- 근거: [Perplexity — 답변 + 하단 "Ask a follow-up" 고정 입력](https://mobbin.com/screens/c076f584-8c70-4980-8539-35340238cc32), [Gemini Notebook — 하단 "Start typing… 8 sources"](https://mobbin.com/screens/e5ced159-147b-4772-bb7b-78d83dba09ef), [ChatGPT — 하단 "Ask anything"](https://mobbin.com/screens/b045e2cd-4f54-424a-97f6-4c5954f0c1e1)
- 화면에서 본 것: 세 앱 모두 답변이 위로 쌓이고 입력창은 뷰포트 바닥에 붙어 있다. 입력창 안에 모드/모델 피커(Perplexity), 소스 수(Gemini Notebook)가 들어간다.
- myco: 컴포저가 페이지 **상단** 카드(`PageQuery.tsx:242–289`), 턴은 아래로 붙고 `endRef.scrollIntoView`(198–203)가 답변이 올 때마다 바닥으로 스크롤 → 두 번째 질문부터 입력창이 화면 밖.
- 제안: `.ask-composer`를 턴 목록 아래로 옮기고 `position: sticky; bottom: env(safe-area-inset-bottom)`. 빈 상태(마스코트+예시)는 위에 그대로. 옵션 `<details>`는 컴포저 안의 작은 토글로.
- impact high / effort S

### 2. 턴 액션 행: 복사 · 노트로 저장 · 다시 묻기 · 소스 수 칩 (Perplexity, Gemini Notebook, ChatGPT)
- 근거: [Perplexity — 답변 아래 share/export/copy/rewrite + "1 source" + 👍👎](https://mobbin.com/screens/c076f584-8c70-4980-8539-35340238cc32), [Perplexity — "20 sources" 칩 + 우측 Sources/Usage 레일](https://mobbin.com/screens/eca7eecc-08cc-4795-80f5-de78c735aba0), [Gemini Notebook — "Save to note" + copy + 👍👎](https://mobbin.com/screens/e5ced159-147b-4772-bb7b-78d83dba09ef), [Linear — "Copy as markdown"](https://mobbin.com/screens/477b94d8-ae47-490c-a509-abf69cdc3448)
- 화면에서 본 것: 답변 바로 아래 아이콘 한 줄. 소스 수는 칩으로 눌러서 레일을 연다. NotebookLM은 "Save to note"가 첫 번째 액션.
- myco: 턴에 액션이 없다(유일한 버튼은 recall-miss 기록). 클립보드는 설정 페이지에서만 쓴다.
- 제안: `ExtractiveAnswer` 아래 액션 행 — **복사**(마크다운, `[[stem]]` 인용 유지), **노트로 저장**(§3), **범위 넓혀 다시**(AbstainCard의 onWiden과 같은 핸들러 재사용), **소스 N** 칩(레일로 스크롤/포커스). 복사는 `navigator.clipboard.writeText` 한 줄.
- impact high / effort S

### 3. "노트로 저장" → 질문 페이지가 위키의 일급 지식이 됨 (Gemini Notebook, Delphi)
- 근거: [Gemini Notebook — Save to note](https://mobbin.com/screens/e5ced159-147b-4772-bb7b-78d83dba09ef), [Delphi — Knowledge 목록에 "Q: …" Q&A 항목이 PDF/Podcast와 같은 열로](https://mobbin.com/screens/a0e68c38-c83b-42bb-8049-b38178d0a8a8)
- 화면에서 본 것: Delphi는 Q&A를 Type=Q&A로 날짜와 함께 지식 목록에 넣는다.
- myco: 답변은 인용문이므로 그대로 저장하면 중복. 그러나 "질문 + 어떤 페이지가 뒷받침했는가"는 새 지식이다. MCP에 `write_page`/`check_page`가 이미 있음.
- 제안: "노트로 저장"은 `wiki/questions/<slug>.md`에 질문·날짜·scope·인용된 `[[stem]]` 목록(+ 각 인용문 한 줄)을 쓰는 Q&A 타입 페이지. 답변 갤럭시에 새 노드로 바로 뜸. 인용문 전체 복제는 하지 않는다.
- impact high / effort M

### 4. 질문 히스토리 / Library (Perplexity History, ChatGPT 사이드바, Claude Recents)
- 근거: [Perplexity — History: 유형 아이콘·제목·Space 태그·상대시간·검색·Type 필터·정렬](https://mobbin.com/screens/2450a35c-b175-4212-94fe-b8098298b1e4), [Perplexity — History 빈 상태 "No sessions yet"](https://mobbin.com/screens/53312dd1-cb8c-4e78-89df-11c4758b2441), [ChatGPT — 사이드바 "Search chats" + Your chats](https://mobbin.com/screens/ba8be889-3abd-422b-b03b-754dbd2c8816), [Claude — Starred/Recents](https://mobbin.com/screens/0777ad20-3aa9-4e91-87ee-72e1af8d04aa)
- 화면에서 본 것: 리스트 한 줄 = 유형 아이콘 + 질문 제목 + 태그 + "2h ago". 날짜별 그룹(Perplexity Computer 목록).
- myco: `queryStore.turns`는 메모리 전용, `ChatTurn`에 시각 없음, 앱 재시작·`clear()`로 소실. `PageHistory`는 ingest 리포트 이력이지 질문 이력이 아니다. 사이드바·Spotlight 어디에도 최근 질문 없음.
- 제안: `ChatTurn`에 `at: number` 추가, 볼트별 `.myco/ask-log.jsonl`(또는 localStorage 폴백)에 `{at,q,scope,abstained,cited:[stem]}`만 append. Ask 빈 상태와 Spotlight에 "최근 질문" 5개(클릭=재질문). 전체 목록은 PageHistory에 탭 하나.
- impact high / effort M

### 5. 답변 중 취소(Stop) (Perplexity, Mistral, Qatalog, ChatGPT)
- 근거: [Perplexity — 진행 중 전송 버튼이 ■ Stop으로](https://mobbin.com/screens/4763be57-d9e7-4412-bafe-93dc2c6d7da3), [Mistral — Researching 카드 "15 min estimate · Cancel"](https://mobbin.com/screens/181ce284-3dcd-4d44-bb1f-368d2e5db997), [Qatalog — "Preparing answer… Cancel Esc"](https://mobbin.com/screens/f53931fd-7ada-492d-877d-118a5de477a9), [ChatGPT — 리서치 레일 하단 Stop/Update](https://mobbin.com/screens/b045e2cd-4f54-424a-97f6-4c5954f0c1e1)
- 화면에서 본 것: 전송 아이콘 자리가 그대로 정지 버튼이 된다. Esc 단축키 표기.
- myco: 취소 경로 없음(`lib/chat.ts`, `queryStore.ts`, `PageQuery.tsx`에 abort 없음). busy 동안 버튼은 "…"이고 입력은 disabled(262–268). Spotlight는 "이전 질문에 답하는 중"으로 새 질문을 거부(`lib/spotlight.ts`).
- 제안: `complete()`/`retrieveChunks`에 `AbortSignal` 전달, 버튼을 Stop으로 교체, Esc 바인딩. 중단된 턴은 `stopped: true`로 표시(에러 아님). Ollama 로컬 모델은 30초 이상 걸릴 수 있어 체감 효과 큼.
- impact high / effort M

### 6. 진행 상태를 "읽고 있는 소스" 텍스트 목록으로 (Perplexity Pro Search, ChatGPT, Copilot, Elicit)
- 근거: [Perplexity — "Searching for…" 펼치면 찾은 소스 3개 + "+7 more", 이어서 "Thinking"](https://mobbin.com/screens/4763be57-d9e7-4412-bafe-93dc2c6d7da3), [ChatGPT — 활동 레일 "Searched for…/Read reuters.com" + 진행바 "2 sources"](https://mobbin.com/screens/b045e2cd-4f54-424a-97f6-4c5954f0c1e1), [Copilot — See my thinking: Searching/Reading/Thinking 타임라인](https://mobbin.com/screens/ae62408b-0082-4e4b-a874-4eb1058be971), [Elicit — 상태 레일 Gather 50 → Screen 10 → Extract 50 → Generate, 체크마크](https://mobbin.com/screens/232b3136-ccbb-42e7-a45c-412ea436f330)
- 화면에서 본 것: 단계 이름 + 숫자 + 실제 소스명이 텍스트로 쌓인다. Elicit은 답변 후에도 레일이 남는다.
- myco: `ThinkingGalaxy`(canvas)가 선택된 페이지를 노드로 켜지만 텍스트로는 없음(스크린리더 불가). 라벨은 "answering from {n} pages…"(148–178). `RetrievalStepper`는 답변 **후** `<details>` 안에만.
- 제안: busy 중 갤럭시 아래에 `retrieved` stems를 칩으로 나열하고, 스텝퍼를 스켈레톤으로 미리 보여 단계가 도착하는 대로 채운다. 제약: 추출형 경로는 IPC 1회라 중간 숫자가 한 번에 오므로 "검색 중 → N개 검토 → K개 통과"까지만 순차로 보일 수 있다(그 이상은 백엔드 스테이지 분리 필요).
- impact medium / effort M

### 7. 인용 pill 호버 팝오버(출처 카드 + 페이저) (Perplexity, Customer.io)
- 근거: [Perplexity — "3 sources" 칩 호버: favicon·제목·저자·발췌·"1/2" 페이저](https://mobbin.com/screens/9bd45c42-abfc-4488-b961-0acfa0a60c0a), [Customer.io — "5 references" 팝오버 목록](https://mobbin.com/screens/fafcbfb9-fa85-4b4d-b17f-54df962305b5)
- 화면에서 본 것: 팝오버 하나에 소스 하나, ‹ › 로 다음 소스.
- myco: `.ask-cite` 호버는 레일 행을 밝히는 것뿐(`PageQuery.tsx:611–641`, `styles.css:10212–10216`). 미디어쿼리 이하(`styles.css:10134`)에서는 레일이 답변 아래로 내려가 호버 연결이 시야 밖.
- 제안: pill `focus/hover` 시 작은 팝오버: 페이지 제목/stem, tier 칩, 유사도 %, 경로, "열기". `NodePreview` 스타일 재사용. 레일이 스택된 폭에서 특히 필요.
- impact medium / effort S

### 8. 답변 후 후속 질문 칩 (Gemini Notebook, Perplexity)
- 근거: [Gemini Notebook — 답변 아래 후속 질문 칩 3개](https://mobbin.com/screens/e5ced159-147b-4772-bb7b-78d83dba09ef), [Perplexity Health — 우측 "Ask about this result" 제안](https://mobbin.com/screens/13623927-1cac-4d4a-be4b-0a694ab21579)
- 화면에서 본 것: 답변 직후, 컴포저 바로 위에 회색 칩 3개.
- myco: 예시 질문은 빈 상태에만(`intakeCopy.examples`, 415–432). 답변 후에는 없음. builtin-local은 모델이 없어 질문을 생성할 수 없다.
- 제안: 데이터에서 파생: `UncitedRow`의 "검토했지만 인용하지 않음" 페이지와 `AnswerGalaxy` 이웃에서 "[[stem]]에 대해 묻기" 칩 3개(클릭 → `setQ` + 포커스). 모델 불필요.
- impact medium / effort S

### 9. 소스 체크박스로 질문 범위 지정 (Gemini Notebook)
- 근거: [Gemini Notebook — 좌측 Sources: Select all + 소스별 체크박스, 컴포저 "8 sources"](https://mobbin.com/screens/6c434e95-b9b4-47b3-b4ad-06a9b8e3192a)
- 화면에서 본 것: 체크 해제한 소스는 답변에서 빠지고 컴포저의 소스 수가 바뀐다.
- myco: 범위는 wiki/sessions/all 3분할(270–288)뿐. "이 폴더/이 노트 3개에 대해서만"은 불가. 백엔드는 이미 tier·날짜(`parseTimeQuery`)로 필터하므로 경로 접두 필터는 같은 모양.
- 제안: 사이드바 폴더 컨텍스트 메뉴 "이 폴더에 질문" → 컴포저 칩. `AskScope`에 `paths?: string[]` 추가(Rust 필터 1개).
- impact medium / effort M

### 10. 컴포저 안에 "무엇으로 답하는가" 표시 (Perplexity, Gemini Notebook)
- 근거: [Perplexity — 입력창 안 Search▾ / Computer / Model▾](https://mobbin.com/screens/6ee91718-b057-4e8e-a8b8-ac384fda7b3a), [Perplexity — 모델 드롭다운(설명 한 줄씩)](https://mobbin.com/screens/fa7f866a-1bec-448c-8ec3-3cf1b7e46c8f), [Gemini Notebook — "8 sources" 카운트](https://mobbin.com/screens/e5ced159-147b-4772-bb7b-78d83dba09ef)
- myco: "via local semantic search — 답변은 노트를 그대로 인용" 문구와 provider·model이 "답변 옵션" `<details>` 안(293–308)에 숨어 있다. 첫 질문 전에 기대치를 정하는 핵심 문장이 접혀 있다.
- 제안: 컴포저 푸터에 scope 세그먼트 옆 `provider · model` 칩 + `색인 N쪽` 카운트를 상시 표시(`Topbar`의 모델 피커 재사용). `<details>`에는 tier 슬라이더만 남긴다.
- impact medium / effort S

### 11. 피드백 후 이유 칩 + 접수 영수증 (Perplexity, Notion AI)
- 근거: [Perplexity — 👍 후 "What did you like…?" 칩: Up to date/Accurate/Helpful/…](https://mobbin.com/screens/f1f7b09b-6fad-49fe-9eb5-032b808f6188), [Notion AI — 피드백 모달(자유 텍스트)](https://mobbin.com/screens/93840eea-5ae9-4eac-bc44-3cc70e9ccdbb)
- myco: "기대한 답이 아니었나요? 기록하기"는 `recordRecallMiss(...).catch(() => undefined)`(522–526) — 성공/실패 어느 쪽도 화면에 표시되지 않고 버튼이 그대로 남는다(silent catch). AbstainCard의 수확 버튼은 영수증을 보여준다(118–123).
- 제안: 클릭 후 버튼을 "기록됨 ✓"로 바꾸고(AbstainCard `harvested` 패턴 재사용) 실패는 NoticeStack로. 선택 이유 칩(빠진 페이지 / 엉뚱한 페이지 / 인용문이 어긋남)을 recall-miss 로그에 함께 써 수확 큐 신호를 높인다.
- impact medium / effort S

### 12. Spotlight의 기권 표현이 Ask 페이지와 다름 (일관성)
- 근거: [TravelPerk — 한 줄 "Sorry, no data was found"(이 앱군의 최소 기권)](https://mobbin.com/screens/dd154cd6-e461-46c9-8cb3-38f6ddbc489e) 대비 myco AbstainCard.
- myco: 기권 턴은 `a = copy.extractiveEmpty`("…모델 설정에서 '지금 재인덱스'를 실행해 보세요")로 채워지고(`queryStore.ts` builtin-local 분기), `lib/spotlight.ts`는 `{answer: turn.a, extractive: true}`만 되돌린다. Spotlight는 이를 "From your notes (top matches, verbatim)" 라벨 아래 렌더(`Spotlight.tsx:514–519`) → 색인이 멀쩡한데 재인덱스를 권하고, 아무것도 아닌 문장을 "노트 원문"이라 부른다. Ask 페이지는 AbstainCard를 쓰므로 페이지 안에서는 문제 없음.
- 제안: `SpotlightAnswer`에 `abstained?: boolean` 추가, Spotlight는 `q_abstain_title` + "Ask에서 열기"만 표시하고 verbatim 라벨 생략. `extractiveEmpty` 문구에서 재인덱스 권유는 `stale`일 때만.
- impact medium / effort S

### 13. 홈 대시보드에 질문 상자 (Perplexity Home, ChatGPT Projects)
- 근거: [Perplexity — 중앙 입력 + 능력 카드 2개](https://mobbin.com/screens/82132732-1617-4e13-ae77-3eb8e04a21bb), [Perplexity Academic — 입력 아래 카테고리 칩 + Trending Topics](https://mobbin.com/screens/00fc974e-2367-4479-a8dc-3e0a919604b2), [ChatGPT Project — 상단 "New chat in <project>" + Chats/Sources 탭](https://mobbin.com/screens/8b37adf6-385f-4d04-afb8-99ce66b1d17f)
- myco: Overview에 질문 입력이 없다. `EverydayHome.tsx:1970`의 버튼이 `setRoute("query")`로 보낼 뿐.
- 제안: MorningBand/Overview 상단에 한 줄 입력 → Enter 시 `queryPrefill`(이미 `takeQueryPrefill`로 소비함, 134–137)에 넣고 Ask로 라우팅. 아래에 최근 질문 3개(§4).
- impact medium / effort S

### 14. 참고문헌 목록은 사람이 읽는 제목으로 (Copilot, Perplexity)
- 근거: [Copilot — References 31: 번호 + 도메인 칩 + 전체 제목](https://mobbin.com/screens/e631b279-cfc4-4c1c-85c9-f06c838b8df2), [Perplexity — 답변 위 소스 카드 3개 + "+10 sources"](https://mobbin.com/screens/8a7e1093-c868-416c-9242-a686ba8ead7d)
- myco: `SourceLadder`는 파일 stem(`r.stem`)만. `ScoredChunk`에 title 없음(`lib/ipc.ts:212–234`). Reader의 `SourcesPanel`은 `s.ref.title ?? s.ref.slug`로 제목을 쓴다 — Ask만 예외.
- 제안: 백엔드 hit에 frontmatter `title` 동봉(없으면 인용 페이지 ≤5개만 `readFile`로 보충). 레일·pill aria-label·팝오버 모두 제목 우선, stem은 보조.
- impact low / effort S

### 15. Ask 설정 레일: 프로필(=Instructions) + 색인 상태 + 최근 질문 한곳에 (Claude Projects, Perplexity Spaces)
- 근거: [Claude — 프로젝트: 채팅 목록 + 우측 Instructions/Files](https://mobbin.com/screens/0777ad20-3aa9-4e91-87ee-72e1af8d04aa), [Perplexity Space — Sessions + 우측 Instructions/Files/Skills/Links/Scheduled](https://mobbin.com/screens/748ad285-751b-4fcb-a903-c5299e44db25), [Claude — 빈 프로젝트: Instructions/Files 빈 상태 카피](https://mobbin.com/screens/1861f7d1-789d-44ad-aa42-2a17b7d03482)
- 화면에서 본 것: "Ask가 무엇을 아는가"가 질문 목록 옆에 항상 보인다. 빈 상태는 "Add PDFs, documents… to reference in this project"처럼 무엇을 넣으라고 말한다.
- myco: 프로필은 Settings→Distill 탭에 있고 Ask에는 닫을 수 있는 힌트 카드뿐(357–394). 색인 상태(쪽수·마지막 색인)는 "답변 옵션" 안 문구와 Stepper의 candidates 숫자로만 유추.
- 제안: 턴이 없을 때 `.ask-rail` 자리에 "이 볼트에 대해 Ask가 아는 것" 카드: 프로필 요약(편집 →), 색인 N쪽·마지막 색인(재색인 →), scope, 최근 질문(§4). 모두 기존 스토어/IPC 재사용.
- impact medium / effort M

### 16. 편집기 안 "근거 없는 주장" 인라인 표시 (WRITER, Grammarly)
- 근거: [WRITER — "Claim detected: 사실/통계로 보임, 인용을 넣으세요" 인라인 팝오버](https://mobbin.com/screens/2e571b73-ba47-4570-a9c3-3d067f43cfcf), [Grammarly — Detected Reference → Copy reference](https://mobbin.com/screens/b092ad71-b236-451c-b28b-b0893f3ff6e2)
- myco: `SourcesPanel`(Reader 레일)이 "{n} claims with no source"를 **개수**로만 보여준다(108–114). 어느 문장인지는 안 보인다.
- 제안: 레일의 uncited 개수를 클릭하면 본문에서 해당 문장에 점선 밑줄 + "출처 찾기"(선택 텍스트로 Ask 실행 → 인용 pill을 `[^src]`로 삽입). Ask ↔ 편집기의 왕복이 생긴다.
- impact medium / effort M

---

## 우선순위 요약

1. §1 컴포저 하단 고정 (S, high) — 즉시.
2. §2 턴 액션 행 + §11 기록 영수증 (S, high/medium) — 같은 diff.
3. §5 취소 (M, high).
4. §4 질문 히스토리 (M, high) → §13 홈 입력, §15 Ask 레일이 그 위에 얹힘.
5. §12 Spotlight 기권 일관성 (S) — 신뢰 문제이므로 빠르게.
6. §3 노트로 저장 (M, high) — LLM 위키 정체성에 가장 맞는 항목.
