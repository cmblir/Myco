# Mobbin 리서치: PKM·AI 지식앱과 myco의 전체 사용성, 그리고 모바일 (key: mobbin-pkm-ai)

- 날짜: 2026-10-01
- 대상 코드: `~/prj/karpathy-editor-build/app` (branch `feat/permit-editor-ux`, HEAD `d3f82ce`). 읽기만 했고 checkout은 건드리지 않았다(`git status --porcelain` 깨끗함).
- 방법: Mobbin MCP 검색 약 40회(screens 33, flows 8). 결과 이미지는 모두 직접 열어 봤다. `task_intent`는 "Study knowledge-management and AI note apps on desktop and mobile to plan usability and mobile-version improvements for a local-first LLM wiki app"로 고정했다.
- myco 화면: dev mock(`?mock=1`)을 375×812(iPhone 크기, touch)로 띄워 Playwright로 찍었다. vite 캐시는 scratchpad로 돌렸다. 파일은 `ux-2026-10/shots/m375-*.png`이고 스크립트는 `ux-2026-10/shot*.mjs`, `serve.mjs`이다.
  - mock의 Ask 답변은 "(mock) Claude CLI reply"라는 스텁이라서 답변 품질은 평가하지 않았다(`shots/m375-ask.png`).
  - 그래프는 headless에서 흰 화면만 나와서(`shots/m375-graph.png`) 평가하지 않았다.
- 이전 라운드(`docs/research/2026-09-26-ux/mobbin-*.md`)에서 다룬 Tana Today, Reflect ⌘K, Notion 인용 hover, mymind Keep/Forget 등은 반복하지 않았다. 이번 라운드는 두 가지에 집중했다. (1) 일반 사용자가 쓰는 하루 흐름(캡처 → 읽기 → 질문 → 복습), (2) 휴대폰.

---

## 0. 가용성: 지정 앱 9개 중 Mobbin에 있는 것은 2개뿐

| 앱 | iOS | Web | 이번에 대신 쓴 근거 |
|---|---|---|---|
| Capacities | 없음 (Mindtrip/Tripadvisor/Perplexity 반환) | 없음 (Tana/HoneyBook/Emergent/Obvious 반환) | Tana web, Notion iOS |
| Tana | 없음 (Tolan/Stardust/Perplexity 반환) | **있음** (이전 라운드에서 깊게 다룸) | 이번엔 새 화면만 |
| Heptabase | 이번엔 검색 안 함 | 없음 (fal/Higgsfield/Buffer/MagicPath 반환) | 없음. 캔버스는 제안하지 않음 |
| Logseq | 없음 (Public/Tolan/v0 반환) | 없음 (Square/Variant/Mintlify 반환) | Dot Chronicles, Fabric 타임라인 |
| Anytype | 없음 (Notion/Feeld/bless 반환) | 없음 (Klaviyo/Dash/Tana 반환) | Notion iOS |
| Reflect | 없음 (Tolan/Mesh/Obsidian 반환) | 있음 (이전 라운드) | Obsidian iOS 일간 노트 설정 |
| Mem | 없음 (Tolan/Mindtrip/Claude 반환) | 없음 (AirOps/Mintlify/Copilot 반환) | Dot, Granola, Perplexity Memories |
| Readwise Reader | 없음 (Public/Perplexity/Noom 반환) | 없음 (Klaviyo/Copilot/Delphi 반환) | **Matter (iOS, 흐름 풍부)**, ElevenReader, Fable, Headway |
| NotebookLM | 단독 앱은 없음 (Gemini 거래소 앱 반환). 대신 **Google Gemini iOS 안에 "notebooks — Powered by NotebookLM"**이 있다: "Group chats by topic / Upload up to 50 sources / Set custom instructions"([ebd09bfc](https://mobbin.com/screens/ebd09bfc-197a-4534-9f3f-6616753e7d9a)), 컴포저 + 메뉴의 첫 항목이 NotebookLM([e6ff39a4](https://mobbin.com/screens/e6ff39a4-3df1-475b-bdad-5aadb6e3575d)) | **있음**. Mobbin 이름은 "Gemini Notebook"이다. 홈 헤더 로고가 "NotebookLM"이다([1de85982](https://mobbin.com/screens/1de85982-b9a1-4900-ac29-409425a93cd0)) | Studio 패널, 소스 추가 대화상자 |

결론: Readwise Reader의 하이라이트 → 노트 → 복습 흐름은 **Matter + Headway** 조합이 가장 가까운 대체 근거다. Mem의 "AI가 기억한다"는 **Dot + Granola**가 대신한다.

---

## 1. myco의 모바일 출발점 (이번에 확인한 사실)

| 사실 | 근거 |
|---|---|
| 배포 대상이 데스크톱뿐이다 | `src-tauri/tauri.conf.json:37-38` (`"dmg"`, `"nsis"`), 창 `minWidth: 800` `:20`, `src-tauri/gen/schemas/`에는 desktop·macOS 스키마만 있음 |
| 휴대폰에서는 무거운 의존이 있다 | 외부 바이너리 `bin/whisper-cli` `:64`, 번들 모델 `multilingual-e5-small-ko-v2-q8_0.gguf` `:62`, CSP가 `localhost:11434`(Ollama)를 허용 `:31`. 폰에서 그대로 돌릴 수 있는지는 검증하지 않았다(추론: 이식 비용이 크다) |
| MCP는 loopback 전용이다 | `src-tauri/src/mcp_native.rs:2946-2975` (`127.0.0.1:{MCP_PORT}`에 bind하고 DNS-rebinding을 막음). 폰이 데스크톱 MCP에 직접 붙을 길이 없고, 이것은 의도된 보안이다 |
| 반응형 셸은 이미 있다 | `src/styles.css:7051-7183`. ≤768px에서 사이드바가 off-canvas가 되고, 터치 타깃 44px, safe-area 대응, "Verified at 375 / 768 / 1280" 주석 |
| 375px에서 상단바가 옆으로 넘친다 | 실측: `.topbar` scrollWidth 591 vs client 375 (shot.mjs 출력). 설계상 `overflow-x: auto`(`styles.css:7086-7092`). 검색 ⌘K가 화면 밖으로 밀린다(`shots/m375-home.png`) |
| 모든 이동이 왼쪽 위 아이콘 뒤 서랍 안에 있다 | `shots/m375-drawer.png`. 홈·질문·자료 추가·정리 제안·그래프·할 일·더 보기가 한 서랍에 있고 하단 탭바는 없다 |
| 웹 기사는 데스크톱 확장으로만 들어온다 | `clipper/README.md:25-27, 37, 47`. 크롬 확장이나 북마클릿이 `myco://clip` 딥링크로 데스크톱 앱에 넘긴다 |

---

## 2. 패턴 (앱 · 플랫폼 · 무엇을 하는가 · 일반 사용자에게 왜 통하나 · URL → myco 갭 → 제안)

### A. 휴대폰의 역할: 데스크톱 앱의 동반자이고, 복제품이 아니다

**A1. Granola (iOS): 폰 홈에 "Get Desktop App"이 있고, 폰은 보기·묻기·새 노트만 맡는다**
- 본 것:
  - 홈 "My notes" 상단에 `Get Desktop App` pill이 있다. 섹션은 Coming up / Earlier today이고, 하단 바는 전화 · 채팅 · 큰 `New note` pill이다([131f5785](https://mobbin.com/screens/131f5785-cbd5-404d-9102-702d5f625e52)).
  - 노트 상세 하단에는 화면 폭 전체의 `Chat with note` 버튼이 있다([6c2cfb1b](https://mobbin.com/screens/6c2cfb1b-3b86-4a51-90fd-c9f215b20d86)). 누르면 그 노트로 범위가 한정된 "Chat with this meeting" 채팅으로 간다([77c50532](https://mobbin.com/screens/77c50532-d6fa-4077-958a-d4a33e5e5edf), flow [70b3a6e2](https://mobbin.com/flows/70b3a6e2-0eac-43f9-a2a0-e24b0b45d7ee)).
  - ··· 메뉴: Edit title / Edit AI summary / View transcript / Show my notes / Copy notes (같은 flow).
- 왜 통하나: 폰에서 할 일이 세 가지(본다, 묻는다, 적는다)로 줄어서 처음 보는 사람도 길을 잃지 않는다. 무거운 작업은 데스크톱이라고 화면이 먼저 말해 준다.

**A2. Opera / Brave / Comet (iOS): 데스크톱과 QR로 짝짓기**
- 본 것:
  - Opera Flow는 "Open Flow in Opera on your computer and click 'Connect your phone'" 안내 아래 `Scan QR code`와 `Get Opera for computer`를 둔다([311067b8](https://mobbin.com/screens/311067b8-4d20-412a-bfab-1146a9d72d7e)).
  - Brave는 "Treat this code like a password" 경고와 "valid for the next 0 hour 29 min" 만료 시간을 보여 준다([53c3fdf5](https://mobbin.com/screens/53c3fdf5-a622-4484-aa67-8ed340ca85c0)).
  - Comet "Add device"([3670b77f](https://mobbin.com/screens/3670b77f-56c3-49f6-bd8c-4befe2a80b1f)).
- 왜 통하나: 계정이나 서버 없이 "화면에 뜬 코드를 찍는다" 한 동작으로 끝난다. 만료와 경고가 보여서 보안을 설명하지 않아도 된다.

**A3. Obsidian (iOS): 같은 마크다운 폴더를 폰에서 연다**
- 본 것:
  - 볼트 목록에 Setup Obsidian Sync / Create new vault / 기존 볼트가 있다([d6dd92e4](https://mobbin.com/screens/d6dd92e4-9d3b-4bf8-a0be-706ef3708b40)).
  - 새 볼트를 만들 때 "Store in iCloud — This cannot be changed later" 토글이 있다([7b3da2e3](https://mobbin.com/screens/7b3da2e3-ea85-48ff-9072-0488b55409b1), flow [34928d68](https://mobbin.com/flows/34928d68-f70f-4fb2-8379-a5cf8f7303c6)).
- 왜 통하나: 파일 위치를 한 번 고르면 동기화는 OS가 맡는다.
- myco와의 관계: myco 볼트는 Obsidian 호환 마크다운이다. 그래서 iCloud 볼트를 쓰는 사람은 이미 Obsidian 모바일로 노트를 읽고 고칠 수 있다(추론). myco 모바일은 이 편집을 복제할 필요가 없다. Obsidian에 없는 것만 하면 된다: 원문 인용형 질문, 복습 카드, 자료 수집.

→ **제안 (모바일 방향, §3에서 종합)**: v1은 "동반 앱"으로 하고 할 일은 캡처 · 질문 · 복습 셋으로 정한다. 연결 방식은 owner가 정해야 할 문제로 남긴다(§3).

### B. 수집: 폰에서는 "공유 → 저장 중… → 태그·메모·보관"이 한 시트에 끝난다

**B1. Matter (iOS): 공유 시트로 저장하고, 첫 화면 체크리스트가 폰과 컴퓨터 저장 경로를 각각 켜게 한다**
- 본 것: flow [143f64c0](https://mobbin.com/flows/143f64c0-0aa7-41cd-8b75-e12f47ddbfe6)
  - 빈 Queue에 "Get Started" 카드가 있다. "Save from your phone — Enable" / "Save from your computer — Enable".
  - 공유 확장 시트에는 스피너 + "Saving…"가 뜨고, 하단에 `Add Tags` / `Take a Note` / `Archive` 세 버튼이 있다.
  - 저장하고 나면 체크리스트의 "Save from your phone"에 ✓가 생기고 목록에 글이 나타난다.
  - Queue 행은 favicon · 제목 · 출처 · 며칠 전 · N min, 태그 칩으로 되어 있다. 하단 탭은 Discover / Inbox / Queue + 검색 원형 버튼이다([c83ef484](https://mobbin.com/screens/c83ef484-396d-4a68-93c8-4fbeb91d7355)).
- 왜 통하나: 사용자가 브라우저를 떠나지 않는다. "저장됐다"는 결과가 체크 표시로 바로 남는다.

**B2. NotebookLM (= Gemini Notebook, Web): 링크 붙여넣기 대화상자가 "무엇이 들어가고 무엇이 안 되는지"를 미리 말한다**
- 본 것: "Website and YouTube URLs — Paste any links" 텍스트 영역과 규칙 목록([7b363f63](https://mobbin.com/screens/7b363f63-caa2-4688-93ed-d72e19d9ae30)).
  - "To add multiple URLs, separate with a space or new line"
  - "Only the visible text on the website will be imported"
  - "Paid articles are not supported"
  - "If upload fails, learn more"
  - 소스 레일의 빈 상태: "Saved sources will appear here — Click Add source above to add PDFs, websites, text, videos, or audio files."
  - Google Gemini web의 노트북 소스 대화상자: Upload files / Add from Drive / Add websites / Copied text([42d56402](https://mobbin.com/screens/42d56402-aec7-40ec-8283-1c1df6c71db9)).
- 왜 통하나: 실패를 미리 알려 주니 "왜 안 들어가지?"가 줄어든다.

**B3. 홈 화면 위젯 (iOS): 입력칸 하나 + 마이크**
- 본 것:
  - ChatGPT: "Ask anything" + 카메라/사진/마이크/음성([adc5c939](https://mobbin.com/screens/adc5c939-62b8-4a9b-9b9b-4e6cdc27c276))
  - Tiimo: "What's the plan?" + 마이크([9bd0f286](https://mobbin.com/screens/9bd0f286-7ce4-42bd-8146-ee694806b166))
  - Grok: 작성 + 음성([bc2d81cc](https://mobbin.com/screens/bc2d81cc-0842-45e7-b2eb-3f82e7b807f9))
  - Evernote 홈: New note / New task / Camera / Scan / Files / Sketch 빠른 동작 + Scratch Pad. Scratch Pad 메뉴는 Convert to note / Clear / Edit widget이다([44a9ceb2](https://mobbin.com/screens/44a9ceb2-ca06-4457-a0e0-2de73288c96e)).
- 왜 통하나: 앱을 열지 않고 생각을 던져 둘 수 있다.

**myco 갭 (데스크톱에서도 지금 보이는 것)**
1. **홈 상자의 "오늘의 노트에 적기"는 ⌘/Ctrl+Enter로만 된다.** `PageOverview.tsx:362-365`(`if (e.metaKey || e.ctrlKey) void capture(); else ask(text);`)이고 안내 문구는 `i18n.ts:6218` "Enter 질문하기 · ⌘Enter 오늘의 노트에 적기"이다. 이 동작에 대응하는 버튼이 없다. 터치 키보드나 단축키를 모르는 사용자는 캡처 기능을 찾을 수 없다. 375px에서는 ⌘ 안내가 그대로 노출되고, `rows={1}`(`:354`) 때문에 placeholder 끝이 잘린다(`shots/m375-home.png`).
2. **자료 추가 화면의 첫 문장이 "여기에 파일 드롭"이다**(`i18n.ts:4517`, `shots/m375-ingest.png`). 폰과 태블릿에서는 끌어다 놓기가 의미 없다.
3. **일반 웹 기사 링크를 가져오는 버튼이 없다.** 붙여넣기 칸은 YouTube 링크일 때만 "가져오기" 버튼을 띄운다(`PageIngest.tsx:468-477`, 판별 `:1171-1175`). 일반 URL을 가져오는 IPC는 찾지 못했다(`grep fetch_url|fetchArticle|readability|web_fetch` 0건). 따라서 일반 URL은 텍스트 그대로 본문이 된다고 추론한다(미실행). 웹 기사는 크롬 확장/북마클릿을 거쳐 데스크톱으로만 들어온다(`clipper/README.md:25, 37, 47`).

**제안**
- (S) 홈 상자 아래에 버튼 두 개를 보이게 둔다: **[질문하기] [오늘 노트에 적기]**. 단축키는 그대로 두고 문구는 `(any-pointer: coarse)`일 때 숨긴다. 근거는 Tana Today의 칩(이전 라운드)과 Notion iOS 하단 바(§G1)다.
- (S) 자료 추가 문구를 "파일 선택 또는 붙여넣기"로 바꾼다. 드롭은 마우스가 있을 때만 보조 문구로 둔다.
- (M) 붙여넣은 일반 링크에도 YouTube와 같은 **"링크에서 글 가져오기"** 버튼을 둔다. NotebookLM처럼 규칙 3줄(보이는 글만, 유료 기사 불가, 실패 시 이유)을 함께 보여 준다. Rust 측에 새 fetch 경로가 필요하고 SSRF 방어(사설 IP와 file 스킴 차단)가 필수다. 가져온 원문은 `raw/` 불변 규칙을 따르는 기존 extractive ingest로 넘긴다.
- (모바일) iOS 공유 확장에 Matter 패턴 그대로 "저장 중… → [메모 남기기] [나중에 읽기]" 시트를 둔다. 저장 위치는 `_inbox/`이고, clipper와 같은 frontmatter를 쓴다(`clipper/README.md:9-17`).

### C. 하이라이트 → 노트 (Readwise Reader 대체: Matter, Fable)

**C1. Matter (iOS): 선택 → 떠 있는 바 → 노란 하이라이트 → 같은 자리에서 메모**
- 본 것:
  - 하이라이트 flow [134cfe08](https://mobbin.com/flows/134cfe08-4be1-4b53-8e66-804abcc94095): 문장을 선택하면 ▶(읽어주기) / 형광펜 / 복사 / 검색 아이콘 바가 뜨고, 형광펜을 누르면 노란색이 칠해진다.
  - 메모 flow [a036686e](https://mobbin.com/flows/a036686e-02ed-48e5-b8c3-b2a745b2470a): 하이라이트를 탭하면 `Note / Copy / Co-Reader / Remove`가 뜬다([ee97ab8f](https://mobbin.com/screens/ee97ab8f-d8de-4f53-8e01-d7f7180ede9f)). Note를 누르면 하이라이트 문장 아래 "Notes" 입력이 열리는 Notebook 시트가 나온다.
  - Notebook([01f20888](https://mobbin.com/screens/01f20888-4bcf-41dc-ab36-6785fd0b91fb)): 하이라이트별로 Go to highlight / Copy highlight / Delete highlight, 메모별로 Copy / Edit / Delete note가 있다.
  - 글 ··· 메뉴: Web view, Appearance, Summarize, Favorite, Add tags, Open notebook, Archive, Delete, More like this (flow [10aefde7](https://mobbin.com/flows/10aefde7-8e3e-4845-a084-4294133c3c7e)).
- 왜 통하나: "밑줄 긋기"는 누구나 아는 동작이다. 노트를 따로 쓰지 않아도 읽은 흔적이 쌓인다.

**C2. Fable (iOS): 읽기 화면 시트의 탭이 Contents / Highlights / Notes / Tabs이다**([29ada781](https://mobbin.com/screens/29ada781-5195-4009-bbe4-99e811d969b8)).

**myco 갭**
- 하이라이트 sidecar는 **PDF 원문 전용**이다(`lib/annotations.ts:1-5`). 페이지 번호와 quad 사각형 좌표를 쓰고 `wiki/.annotations/<raw-stem>.json`에 저장한다. clipper로 들어온 마크다운 원문에 대한 하이라이트 경로는 찾지 못했다(PDF 외 검색 결과 없음, 미검증 범위).

**제안 (M–L)**
- 마크다운 원문에도 같은 sidecar 방식(텍스트 앵커)을 쓴다. 원문은 불변이므로 `raw/`는 건드리지 않는다.
- 하이라이트 메뉴는 **[노트로 옮기기]** 하나로 시작한다. 누르면 선택 문장을 `[^src-*]` 인용이 달린 한 줄로 오늘 노트나 관련 위키 페이지에 붙인다.
- 이 줄은 곧바로 extractive 카드의 cloze 재료가 된다. spec 2026-09-29 Part 1은 "`[^src-*]` 인용이 있는 문장"에서 cloze를 만든다. 결과적으로 Readwise의 "하이라이트 → 복습" 고리가 원문 인용 그대로 닫힌다.

### D. 복습 (spaced repetition): 일반 사용자에게 필요한 것은 "버튼 하나, 질문 하나"

**D1. Headway (iOS): 모든 세트를 한 번에 복습하는 버튼, 2지선다, 다음 복습일**
- 본 것: flow [3d987534](https://mobbin.com/flows/3d987534-1fb1-4502-872e-49e765b79e85) "Completing spaced repetition"
  - Library의 `Repetition 3` 탭에 큰 파란 버튼 **"Repeat 3 cards"**가 있다. 세트(책)가 여러 개여도 버튼은 하나다.
  - 카드에는 하이라이트 문장이 그대로 있고 아래에 책 제목("Never Get a Real Job")이 붙는다. 하단 질문은 "Do you remember this?", 버튼은 **[✕ No] [✓ Yes]** 두 개다([e109ca23](https://mobbin.com/screens/e109ca23-95a1-4edd-94d8-704a97ad043b)은 단어 카드로, 원문 문장 속 단어를 강조한다).
  - 끝나면 Library로 돌아가고 "Next repetition in 1 day" pill이 표시된다.
  - 처음 쓰는 사람에게는 "Spaced Repetition — Tap to see how it works" 카드가 있고, 마스코트가 4장으로 설명한다. 마지막 장은 "We'll remind you to repeat cards when needed"이다(flow [d1aac739](https://mobbin.com/flows/d1aac739-414e-453f-a894-593e7ec237f7)).
- 왜 통하나: "간격 반복"이라는 말을 몰라도 된다. 할 일이 "N장 복습" 하나로 보이고, 평가는 기억이 나는지 아닌지만 고르면 된다.

**D2. Quizlet (iOS): 스와이프로 평가**
- 본 것: "1 / 68", 왼쪽 주황 카운터(still learning)와 오른쪽 초록 카운터(know), 하단 "Swipe left to mark Still learning"([5dacac8f](https://mobbin.com/screens/5dacac8f-b958-417c-bae8-e70c4ac3273f)).
- 왜 통하나: 한 손 엄지로 끝난다.

**D3. 위젯 복습 (iOS)**
- 본 것:
  - Vocabulary: 홈 화면 위젯에 단어, 뜻, 예문 카드([01b7b667](https://mobbin.com/screens/01b7b667-ea50-47ef-9e6f-e563030e0b36)).
  - Deepstash: 인용 위젯 + "STREAK 3 days · 3 ideas read today · ▶ Read"([a9dee944](https://mobbin.com/screens/a9dee944-e751-4b82-ab90-470dc9fb24d0)).
- 왜 통하나: 앱을 열기 전에 이미 한 장을 본 셈이 된다.

**myco 갭**
1. **홈 "복습 시작"이 기한 카드 전체가 아니라 첫 덱만 연다.**
   - 문구는 전체 덱 합계(`dueTotal`)를 센다: `MorningBand.tsx:347-354`, `i18n.ts:6213` "복습 카드 {n}장이 기한입니다".
   - 버튼은 `studyDecks.find((d) => d.due > 0)` 하나만 연다(`MorningBand.tsx:192, 198-201`).
   - 그런데 덱은 이제 "one deck per note"이다(spec `2026-09-29-study-from-the-wiki.md:46`). 노트 5개에 기한 카드가 흩어져 있으면 "12장"이라고 보이는데 실제로는 3장만 복습하고 끝난다.
   - 학습 페이지에도 전체 복습 버튼이 없고 덱별 행만 있다(`PageStudy.tsx:149-185`, `shots/m375-study.png`).
2. **평가 버튼 4개** "다시 / 어려움 / 보통 / 쉬움"(`PageStudy.tsx:341-352`, `i18n.ts:5374-5377`). 엄지로 누르기에 버튼이 좁고, 일반 사용자는 "어려움"과 "보통"의 차이를 판단하기 어렵다(추론).
3. **다 끝난 화면에 "다음 복습은 언제"가 없다.** `AllDone`은 "모두 완료"와 "N장 복습함"만 보여 준다(`PageStudy.tsx:390-409`).
4. **설명이 용어로 되어 있다.** "페이지에서 생성한 간격 반복 플래시카드와 퀴즈로 지식을 복습하세요."(`i18n.ts:5358-5359`).

**제안**
- (S) **"오늘 복습 N장"을 덱 경계 없이 하나의 큐로 만든다.** 홈 버튼과 학습 페이지 상단 모두 같은 큐를 쓴다. 데이터는 이미 있다: `dueCards`, `useStudyStore.dueTotal`. 카드 출처는 각 카드의 `sourceRef`로 계속 보인다(`PageStudy.tsx:328-333`).
- (S) 기본 평가를 **[기억 안 남] [기억남]** 두 개로 바꾸고 FSRS Grade 1과 3에 대응시킨다. 4단계는 설정에 "세밀하게 평가" 옵션으로 남긴다. 모바일에서는 같은 두 값을 좌우 스와이프에 대응시킨다(Quizlet).
- (S) 끝 화면에 "다음 복습: 내일 3장"을 보여 준다(Headway). FSRS 상태에 다음 기한이 있으므로 계산만 하면 된다.
- (S) 설명을 "읽은 노트에서 문장을 골라 카드로 만들고, 잊을 때쯤 다시 보여 줘요"로 바꾸고 마스코트(`MascotCameo.tsx`)를 쓴 3장짜리 설명을 붙인다(Headway).
- (모바일) 위젯 1개: 오늘 복습 카드 앞면 한 장 + "N장 남음". 탭하면 복습 큐가 열린다(Vocabulary/Deepstash).

### E. 휴대폰에서 AI 답변과 인용 보여 주기

**E1. 인용은 작은 표시, 탭하면 하단 시트**
- 본 것:
  - ChatGPT iOS: 답변 아래에서 Sources 하단 시트가 올라오고, 항목은 도메인 · 제목 · 발췌 순이다([3eaf4e44](https://mobbin.com/screens/3eaf4e44-fdce-48bc-965b-b194ed9c43ac)).
  - Dot: 답변 아래 `Sources ›` 칩 → 시트(제목+URL 행) → 앱 내 브라우저(flow [427217c1](https://mobbin.com/flows/427217c1-5216-4f7d-b33f-85ec2b9c0006)).
  - Notion iOS 회의 요약: 불릿 끝에 원 안의 작은 숫자 "1"([91018867](https://mobbin.com/screens/91018867-e081-4c8f-b370-250159b7badc)).
  - Perplexity iOS: 번호 매긴 References 목록, 제목 + 발췌([a355e53b](https://mobbin.com/screens/a355e53b-c3cc-4215-a81f-6cd31ff7ba27)).
- 왜 통하나: 본문은 깨끗하게 읽히고, 근거가 궁금할 때만 한 번 탭하면 된다.

**E2. "원문과 같은가"를 색으로 알려 주는 범례 (Google Gemini iOS)**
- 본 것:
  - 답변 아래 "Check Completed · Understand the results" 링크([0d09bdd7](https://mobbin.com/screens/0d09bdd7-f954-4a73-aa9b-d507e4d9f4e9)).
  - 링크를 열면 범례가 나온다. 초록 = 비슷한 내용을 찾음, 주황 = 다르거나 못 찾음, 강조 없음 = 판단할 정보 부족([3c708786](https://mobbin.com/screens/3c708786-b2c1-4716-aa33-8e2362afdfe8)).
  - 초록 문장을 탭하면 하단 시트 "Google Search found similar content, like this:"가 도메인과 발췌, "Was this check helpful?" 👍👎를 보여 준다([b778369a](https://mobbin.com/screens/b778369a-80d7-4740-bf86-90ac2caf139f)).
- Google iOS "Key points from the page": 불릿마다 작은 인용 아이콘이 있고, 아래에 "Explore on page" 질문 목록이 있다([22bad4e9](https://mobbin.com/screens/22bad4e9-2b75-4cac-904d-3f259b5b5d53)).
- myco 상태: myco는 답이 원래 원문 그대로이고 "From your notes (top matches, verbatim)" 라벨이 이미 있다(`PageQuery.tsx:741`). 이 부분은 패리티다. 모바일에서도 이 라벨은 그대로 둔다.

**E3. 노트 하나에 대해 묻기 (Granola, A1 참조)**: `Chat with note` 하단 pill([6c2cfb1b](https://mobbin.com/screens/6c2cfb1b-3b86-4a51-90fd-c9f215b20d86)).

**myco 갭**
1. **노트 본문의 인용 표시가 375px에서 원문 문법 그대로 한 줄을 차지한다.** 본문에 `[^src-attention-is-all-you-need]`가 그대로 보이고, 하단 각주 정의 `[^src-…]: [[source-…]]`도 그대로 보인다(`shots/m375-note.png`). Notion iOS의 작은 숫자 하나와 대조된다.
2. **출처 사다리의 강조와 툴팁이 hover에 의존한다.**
   - 답변과 사다리를 서로 강조하는 처리: `PageQuery.tsx:730-735`, `SourceLadder.tsx:193-196` (`onMouseEnter`; focus 대응은 있음).
   - 행 툴팁: `title={detailsOpen ? tip : r.stem}`(`SourceLadder.tsx:191`).
   - 터치에서는 hover가 없다. 레이아웃은 1100px 아래에서 세로로 쌓이므로 그 부분은 괜찮다(`styles.css:11463-11476`).
3. **질문 범위가 위키 / 세션 / 전체뿐이다**(`PageQuery.tsx:333-347`). "이 노트에 대해"가 없다. 이전 라운드 #18(`mobbin-reflect-mem-heptabase.md`)에서 컴포저 범위 지정을 제안했으나 backlog S1–S12에는 들어가지 않았다.

**제안**
- (M, 데스크톱+모바일 공통) 읽기 표시에서 `[^src-*]`를 **작은 번호 칩**으로 그린다. 탭하면 하단 시트(데스크톱은 팝오버)에 원문 문장과 [원문 열기]를 보여 준다. S11("citation lands on its passage")이 이미 이동 기능을 만들었으므로 표시만 바꾸면 된다. 단, one-editor spec(진행 중)의 렌더 규칙과 겹치는지 먼저 확인해야 한다.
- (S) 출처 사다리 행 툴팁 내용을 탭해서 펼치는 줄로도 보여 준다.
- (M) 노트 ··· 메뉴와 모바일 노트 하단에 **"이 노트에 묻기"**를 둔다. 범위가 한 페이지와 그 이웃으로 정해진 Ask이고, 답은 extractive와 기권 규칙을 그대로 따른다.

### F. 연결된 지식: 폰에서는 "오늘 무엇이 이어졌나"를 카드로

**F1. Obsidian (iOS): backlinks는 오른쪽 서랍, 노트 메뉴는 하단 시트**
- 본 것:
  - 노트 위로 오른쪽 서랍이 덮이고 "Linked mentions 1 → 2 Day Trip Plan to NYC → `[[Moodboard]]`" 문맥 줄이 나온다. 하단에는 "Backlinks" 토글 바와 단어·글자 수가 있다([0ef5d4b3](https://mobbin.com/screens/0ef5d4b3-1972-4f6a-a980-fb862061ea0c), [59932f82](https://mobbin.com/screens/59932f82-a889-4b24-b5a6-75be8965334e)).
  - 노트 ··· 하단 시트: Backlinks in document ✓ / Reading view / Source mode / Pin / Rename / Move file to / Bookmark / Add file property([fe616813](https://mobbin.com/screens/fe616813-9830-40ac-a4bf-b213df151fb0)).
  - 그래프 위에 Filters/Groups/Display/Forces 패널이 겹쳐 뜨고, 하단 툴바는 ‹ › 🔍 + 탭수 ≡이다([fe673348](https://mobbin.com/screens/fe673348-8160-48be-a481-66560fb027d7)).

**F2. Dot (iOS): "Chronicles". 하루 카드 안에 주제가 밑줄 링크로 박혀 있다**
- 본 것: "Yesterday — Exploring <u>ergonomic mouse options</u> … planning a <u>trip to Bali</u> …" 카드가 날짜순으로 쌓이고, 빈 오늘 카드 아래에 "Chronicles are updated every night"가 붙는다([29acf4e2](https://mobbin.com/screens/29acf4e2-acbe-4aa0-9bef-2d4b44ac17a0), flow [f9194234](https://mobbin.com/flows/f9194234-990c-4c5f-ada9-b2819e68908f)).
- 왜 통하나: 사용자가 링크를 걸지 않았는데도 "내 기록이 이어지고 있다"가 보인다. 갱신 시점("매일 밤")을 밝혀서 기대치를 맞춘다.

**F3. Fabric (iOS): 타임라인 날짜마다 `✦ Summary` 칩이 있고, 하루 요약 시트로 이어진다**
- 본 것:
  - 타임라인 필터 "Email, Highlight +2 more", "Any tag"([b9e4b31d](https://mobbin.com/screens/b9e4b31d-2ab5-4079-8265-bda6c7c1f9d7)).
  - "Wednesday, April 1st summary"에 "Top highlights" 링크 목록과 "Get email summaries… Set up Recaps"가 있다([b0de8bea](https://mobbin.com/screens/b0de8bea-341f-4846-b4d8-bc73e87331f6)).
- **반면교사**: Fabric 요약은 "likely saved to support your personal projects"처럼 **추측을 섞는다**. myco의 extractive 원칙(답변·ingest·카드 모두 원문 그대로)과 정면으로 어긋난다.

**myco 상태와 갭**
- backlink 문맥 문장은 S11로 이미 출시됐다(재제안하지 않음).
- 하루 요약: `lib/digests.ts`는 생성형 프롬프트("Produce a concise … digest", `:9-12`)를 쓰는데, `runDigest`(`:77`)를 부르는 곳이 src 안에 없다(grep 결과 정의 파일과 테스트뿐). **데드 코드로 보고만 하고 삭제는 owner 판단에 맡긴다.**

**제안 (M)**: 홈 일간 타임라인(S7 출시)의 날짜마다 **"오늘 생긴 연결"** 줄을 붙인다. 모델 없이 만든다.
- 그날 새로 생긴 `[[링크]]` 쌍과 새 인용 수를 센다. 예: "transformer-architecture ↔ attention-mechanism 연결 1개 · 새 인용 3개".
- 링크는 Dot처럼 밑줄로 그 노트를 연다.
- 갱신 시점을 명시한다("노트 저장 시 갱신").
- Fabric식 생성 요약은 넣지 않는다.

### G. 홈과 이동: 폰은 하단 바, 서랍이 아니다

**G1. Notion (iOS)**: 상단 pill(Home / 채팅 / 캘린더 / 받은편지), Recents 가로 카드, Private 목록이 있다. **하단 떠 있는 바**는 [검색] [Ask AI 입력 + 마이크] [새 페이지]이다([fe199502](https://mobbin.com/screens/fe199502-0dd2-44d7-8000-901596adb1fd)).

**G2. 하단 검색 + 작성**
- Apple Notes([497d6ce0](https://mobbin.com/screens/497d6ce0-454b-4f98-b8e7-15a2560b509c))
- Raycast Notes(상단 "Sync across devices" 배너, [a95cc58e](https://mobbin.com/screens/a95cc58e-9248-4d5c-a96e-308902f7870c))
- Obsidian iOS 새 탭: "Create new note / Close" + 하단 ‹ › 🔍 + 탭 ≡([a56d3f3c](https://mobbin.com/screens/a56d3f3c-c332-4395-a1f1-415342a3d42b))

**G3. 탭바**
- Evernote: Create / Notes / Notebooks / Tasks / Calendar([d9c0cb9a](https://mobbin.com/screens/d9c0cb9a-9f61-4019-b398-2d7243d68120))
- Otter: 가운데 큰 마이크 버튼([f314557f](https://mobbin.com/screens/f314557f-6003-4d02-9b2c-d324e3a0d139))
- Matter: Discover / Inbox / Queue + 검색([c83ef484](https://mobbin.com/screens/c83ef484-396d-4a68-93c8-4fbeb91d7355))

**G4. 목록 스와이프 정리**
- ElevenReader: 행을 밀면 Archive / Mark as unread / Add to collection이 나오고, 행에 "17% · 10 min left" 진행도가 있다([b5563b2a](https://mobbin.com/screens/b5563b2a-bcbe-43cf-ac1c-fcf90add847c)).
- Google Photos: "Swipe right to keep"([fe08f11d](https://mobbin.com/screens/fe08f11d-55f0-43b7-a506-2acc10e4bc26)).

**myco 갭 (375px 실측)**
- 이동 경로가 전부 왼쪽 위 서랍에 있다(`shots/m375-drawer.png`).
- 상단바는 591px가 375px 안에서 옆으로 스크롤된다(§1).
- 홈과 학습 화면에 `⌘K` 배지가 그대로 보인다(`shots/m375-home.png`, `m375-study.png`).

**제안**
- (S, 현재 반응형 셸) `(any-pointer: coarse)`일 때 ⌘ 배지와 단축키 문구를 숨긴다. ≤768px 상단바에는 서랍 · 제목 · 검색만 남긴다.
- (모바일 앱) 하단 바 4칸: **오늘 · 질문 · 복습 · ＋(캡처 시트)**. 그래프·정리 제안·할 일·설정은 "오늘" 화면의 카드나 ··· 안으로 보낸다. 정리 제안 큐(`TidySheet`)는 스와이프 Keep/Later로 처리한다(G4). Keep/Later 의미는 S7과 같다.

### H. 재회(resurfacing): 날짜에 묶인 카드 하나

**H1.**
- Canopi: "Next / Past" 전환과 "20 Days Ago — 100 days ❤️" 카드([a9768b9f](https://mobbin.com/screens/a9768b9f-0911-498d-b64c-ee59b1c70fa8))
- Placify: "Memories On Jul 23" 카드 하나 + Save([ef83e8d7](https://mobbin.com/screens/ef83e8d7-73ce-49b3-b406-1d21a7979eff))

**myco 상태**: 홈 ritual 카드가 이미 재회 1순위 + 나중에(Keep/Later)를 보여 준다(`MorningBand.tsx:188-197`, S7). 데스크톱은 패리티다. 모바일에서는 같은 카드를 스와이프(오른쪽 = 열기/Keep, 왼쪽 = 나중에)로 처리하고 위젯 후보로 둔다(D3).

---

## 3. 모바일 버전: 무엇을 어떻게

### 3.1 선택지 (owner 결정 필요. 추천은 B)

| | A. 지금 앱을 Tauri iOS/Android로 빌드 | **B. 동반 앱 + 데스크톱 짝짓기** | C. 동반 앱 + 파일 동기화 |
|---|---|---|---|
| 하는 일 | 전부 | 캡처 · 질문 · 복습 · 노트 읽기 | 캡처 · 복습 · 노트 읽기 (질문은 폰 색인 필요) |
| 근거 앱 | (Mobbin 근거 없음) | Granola [131f5785](https://mobbin.com/screens/131f5785-cbd5-404d-9102-702d5f625e52), Opera [311067b8](https://mobbin.com/screens/311067b8-4d20-412a-bfab-1146a9d72d7e) | Obsidian [7b3da2e3](https://mobbin.com/screens/7b3da2e3-ea85-48ff-9072-0488b55409b1) |
| myco 쪽 걸림돌 | whisper 바이너리·gguf·Ollama(`tauri.conf.json:31, 62, 64`). 데스크톱 전제(`:20, 37-38`) | MCP는 loopback 전용(`mcp_native.rs:2946-2975`)이라 **별도 opt-in LAN 채널**이 필요하다. 기존 MCP를 열면 안 된다 | 폰에서 FSRS 상태와 `daily/` 동시 편집 충돌. iCloud가 아닌 볼트는 접근 불가 |
| 원문 인용형 답 | 폰 안에서 색인 필요 | 데스크톱이 답하고 폰은 보여 준다(데스크톱이 꺼져 있으면 기권 화면) | 폰 자체 색인 필요(무거움) |
| 판단 | 비용 최대, 이점 불명 | **가장 가볍고 extractive 보증이 데스크톱 한 곳에 남는다** | 질문을 빼면 Obsidian 모바일과 겹친다 |

"A는 무겁다"와 "C는 Obsidian과 겹친다"는 위 근거에서 끌어낸 추론이다. 폰에서 직접 빌드하거나 실행해 보지는 않았다.

### 3.2 B안 v1 화면 목록 (각 화면의 Mobbin 선례)

1. **짝짓기**: 데스크톱 설정에서 QR을 띄우고 폰 카메라로 찍는다. "이 코드는 비밀번호처럼 다루세요 · 30분 뒤 만료"를 표시한다. 선례: Brave [53c3fdf5](https://mobbin.com/screens/53c3fdf5-a622-4484-aa67-8ed340ca85c0).
   - 데스크톱이 꺼져 있으면 "데스크톱 myco가 켜져 있어야 질문할 수 있어요"라고 보여 준다. 캡처는 폰에 쌓았다가 다음 연결 때 `_inbox/`로 보낸다.
2. **오늘(홈)**: 인사 + 입력칸 + **[질문] [적기]** 두 버튼, 오늘 복습 N장 카드, 재회 카드 1장, 오늘 생긴 연결 줄. 선례: Notion iOS [fe199502](https://mobbin.com/screens/fe199502-0dd2-44d7-8000-901596adb1fd), Granola [131f5785](https://mobbin.com/screens/131f5785-cbd5-404d-9102-702d5f625e52).
3. **질문**: 답 = 원문 인용 블록. 번호 칩을 탭하면 출처 하단 시트가 뜬다. 기권 시에는 S5 문구를 그대로 쓴다. 선례: ChatGPT iOS [3eaf4e44](https://mobbin.com/screens/3eaf4e44-fdce-48bc-965b-b194ed9c43ac), Dot flow [427217c1](https://mobbin.com/flows/427217c1-5216-4f7d-b33f-85ec2b9c0006).
4. **복습**: 전체 큐 하나, 카드 = 원문 문장 + 출처 노트 이름, **[기억 안 남] [기억남]** 또는 스와이프, 끝 화면에 다음 복습일. 선례: Headway flow [3d987534](https://mobbin.com/flows/3d987534-1fb1-4502-872e-49e765b79e85), Quizlet [5dacac8f](https://mobbin.com/screens/5dacac8f-b958-417c-bae8-e70c4ac3273f).
5. **노트 읽기**: 기본은 읽기. 하단에 [이 노트에 묻기], 오른쪽 서랍에 연결 문장(backlink). 선례: Granola [6c2cfb1b](https://mobbin.com/screens/6c2cfb1b-3b86-4a51-90fd-c9f215b20d86), Obsidian iOS [0ef5d4b3](https://mobbin.com/screens/0ef5d4b3-1972-4f6a-a980-fb862061ea0c).
   - 편집은 v1에서 빼거나 오늘 노트 덧붙이기만 허용한다(추론: 원격 편집의 충돌 처리를 피하려는 것).
6. **공유 확장**: "저장 중…" 다음에 [메모 남기기] [나중에 읽기]. 선례: Matter flow [143f64c0](https://mobbin.com/flows/143f64c0-0aa7-41cd-8b75-e12f47ddbfe6).
7. **위젯(2차)**: 입력 + 마이크 하나, 오늘 복습 카드 하나. 선례: ChatGPT [adc5c939](https://mobbin.com/screens/adc5c939-62b8-4a9b-9b9b-4e6cdc27c276), Vocabulary [01b7b667](https://mobbin.com/screens/01b7b667-ea50-47ef-9e6f-e563030e0b36).

모바일 v1에서 빼는 것: 그래프 룩(Obsidian iOS도 설정 패널이 화면을 덮는다, [fe673348](https://mobbin.com/screens/fe673348-8160-48be-a481-66560fb027d7)), 플러그인, 에이전트, 설정 대부분.

---

## 4. 모바일과 상관없이 지금 데스크톱에서 할 수 있는 것 (영향 ÷ 노력 순)

| # | 무엇 | 노력 | myco 근거 | Mobbin 근거 |
|---|---|---|---|---|
| 1 | "복습 시작"과 학습 상단을 **전체 덱 하나의 큐**로 | S | `MorningBand.tsx:192, 198-201, 347-354`, `PageStudy.tsx:149-185`, spec `:46` | Headway [3d987534](https://mobbin.com/flows/3d987534-1fb1-4502-872e-49e765b79e85) |
| 2 | 홈 상자에 **[질문하기] [오늘 노트에 적기]** 버튼 | S | `PageOverview.tsx:362-365`, `i18n.ts:6218` | Notion iOS [fe199502](https://mobbin.com/screens/fe199502-0dd2-44d7-8000-901596adb1fd), Granola [131f5785](https://mobbin.com/screens/131f5785-cbd5-404d-9102-702d5f625e52) |
| 3 | 복습 2버튼 기본 + 끝 화면 다음 복습일 + 쉬운 설명 | S | `PageStudy.tsx:341-352, 390-409`, `i18n.ts:5358-5359, 5374-5377` | Headway [e109ca23](https://mobbin.com/screens/e109ca23-95a1-4edd-94d8-704a97ad043b), flow [d1aac739](https://mobbin.com/flows/d1aac739-414e-453f-a894-593e7ec237f7) |
| 4 | 터치 포인터에서 ⌘ 문구와 "드롭" 문구 숨기기 | S | `i18n.ts:4517, 6218`, `shots/m375-home.png`, `m375-ingest.png` | (Mobbin 폰 화면 어디에도 단축키 문구가 없음. 예: Apple Notes [497d6ce0](https://mobbin.com/screens/497d6ce0-454b-4f98-b8e7-15a2560b509c)) |
| 5 | 일반 웹 링크 "가져오기" + 규칙 3줄 | M | `PageIngest.tsx:468-477, 1171-1175` | NotebookLM [7b363f63](https://mobbin.com/screens/7b363f63-caa2-4688-93ed-d72e19d9ae30) |
| 6 | 인용 `[^src-*]`를 번호 칩으로 표시, 탭하면 원문 | M | `shots/m375-note.png` | Notion iOS [91018867](https://mobbin.com/screens/91018867-e081-4c8f-b370-250159b7badc), ChatGPT iOS [3eaf4e44](https://mobbin.com/screens/3eaf4e44-fdce-48bc-965b-b194ed9c43ac) |
| 7 | "이 노트에 묻기" 범위 | M | `PageQuery.tsx:333-347` | Granola flow [70b3a6e2](https://mobbin.com/flows/70b3a6e2-0eac-43f9-a2a0-e24b0b45d7ee) |
| 8 | 홈 타임라인에 "오늘 생긴 연결" (모델 없이) | M | S7 타임라인. `lib/digests.ts:77` 미사용 | Dot [29acf4e2](https://mobbin.com/screens/29acf4e2-acbe-4aa0-9bef-2d4b44ac17a0) |
| 9 | 마크다운 원문 하이라이트 → 인용 한 줄 → 카드 | M–L | `lib/annotations.ts:1-5` (PDF 전용) | Matter flow [134cfe08](https://mobbin.com/flows/134cfe08-4be1-4b53-8e66-804abcc94095), [a036686e](https://mobbin.com/flows/a036686e-02ed-48e5-b8c3-b2a745b2470a) |

---

## 5. 이미 패리티이거나 진행 중이라 제안하지 않은 것

- 재회 Keep/Later, 홈 Ask/Capture 상자, 일간 타임라인: S7 출시(backlog).
- backlink 문맥 문장, 인용 클릭 시 해당 문단으로 이동: S11 출시.
- 원문 인용형 카드(모델 없음): spec 2026-09-29, `lib/extractiveCards.ts` 존재.
- 답변의 "원문 그대로" 라벨: `PageQuery.tsx:741`.
- Ask 레이아웃 좁은 폭 쌓기: `styles.css:11463-11476`.
- Write/Read 없는 한 편집기, Notion 표·블록 패널, 그래프 woven: 진행 중 spec. 단 §2E의 인용 칩 표시는 one-editor 렌더 규칙과 겹치는지 확인이 필요하다.
- Heptabase식 화이트보드: Mobbin 근거 없음(이번과 이전 라운드 모두). 제안하지 않음.

---

## 6. 한계 (검증한 것 / 추론한 것 / 못 한 것)

- **검증**:
  - 위 Mobbin 화면과 flow는 모두 이번 세션에서 검색해서 이미지를 직접 봤다.
  - myco file:line은 모두 읽어서 확인했다.
  - 375px 스크린샷 5장(home, drawer, note, study, ingest)과 상단바 넘침 수치(591/375)는 실측이다.
- **추론**:
  - Tauri 모바일 빌드 비용, iCloud 볼트 사용자가 Obsidian 모바일로 이미 읽을 수 있다는 점.
  - 4버튼 평가의 일반 사용자 혼란.
  - 일반 URL 붙여넣기 시 동작(코드 경로만 봤고 실행하지 않음).
  - autofocus가 폰에서 키보드를 띄우는지(`PageOverview.tsx:360`). 판단할 수 없어서 본문 주장에서 뺐다.
- **못 한 것**:
  - 지정 앱 7개(Capacities, Heptabase, Logseq, Anytype, Mem, Readwise Reader, Tana iOS)는 Mobbin에 없어서 해당 앱 자체의 화면 근거가 없다. 대체 앱을 썼다.
  - NotebookLM 단독 모바일 앱은 Mobbin에 없다. Gemini iOS 안의 notebooks 소개 화면과 + 메뉴까지만 봤고, 그 안의 노트북 사용 화면은 보지 못했다. NotebookLM web의 Flashcards/Quiz/Mind Map 결과 화면은 검색이 비었다(`search_screens` deep 0건, flows 0건). Studio 타일 목록([1f0f898d](https://mobbin.com/screens/1f0f898d-d513-40e3-a23e-97be8ee75019): Audio Overview, Slide Deck, Video Overview, Mind Map, Reports, Flashcards, Quiz, Infographic, Data Table)까지만 봤다.
  - 실제 Ask 답변과 그래프의 375px 모습: mock 스텁과 headless WebGL 한계로 평가하지 못했다.
  - Android는 Mobbin MCP 플랫폼 인자에 없다(ios/web만). 그래서 검색하지 않았다.
