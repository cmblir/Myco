# Mobbin UX 리서치 — AI 답변의 모바일 UX + 모바일 크래프트 (key: mobbin-ai-mobile)

- 대상: ChatGPT · Claude · Perplexity(+Comet) · Google Gemini iOS 앱, 그리고 Linear Mobile · Things 3 · Arc Search · Matter · mymind · Obsidian iOS · LINE 등 모바일 기본기 참고 앱.
- 방법: Mobbin MCP 검색 30회 (screens 27 · flows 3, ios 29 · web 1). `task_intent` 고정. 아래에 인용한 화면은 모두 반환된 이미지를 직접 보고 기록했다.
- myco 비교 트리: `~/prj/karpathy-editor-build/app` (branch `feat/permit-editor-ux`, HEAD `d3f82ce`). 읽기 전용으로만 봤다.
- myco 폰 폭 스크린샷: 이 세션에서 직접 찍었다. 375×812, `isMobile`/`hasTouch`, ko, light, `?mock=1`, dev 서버 `:6300`(이 트리의 vite). 스크립트는 `mobile-shots.mjs`, `measure-ask.mjs`이고 이미지는 `shots-ai-mobile/` 아래에 있다(모두 이 문서와 같은 폴더 기준).
- 이전 라운드와의 관계: `docs/research/2026-09-26-ux/mobbin-ai-answers.md`는 데스크톱 기준 Ask 리서치였다. 그 뒤 반영된 것은 답변 복사(`PageQuery.tsx:251-259, 582-606`), 기록 영수증·Spotlight 기권·일회성 widen(backlog S5), 후속 질문 문맥(`queryStore.ts:207-212`, `PageQuery.tsx:514-519`)이다. 그 리포트의 §1 하단 컴포저, §4 히스토리, §5 중단은 아직 코드에 없다(아래 근거). 이번 문서에서는 이 셋을 "모바일에서는 선택이 아니라 필수"인 이유와 함께 모바일 형태로만 다시 다룬다. 나머지 패턴은 모두 새 항목이다.

---

## 0. 한 줄 결론

모바일 myco는 "폰에 들어간 데스크톱 앱"이 되어서는 안 된다. **묻기 + 넣기만 하는 짝꿍 앱**이 맞다. 노트 읽기·편집은 볼트가 Obsidian 호환이라 이미 다른 앱으로 할 수 있다. 근거는 두 가지다. ChatGPT iOS가 데스크톱 Codex를 원격으로 쓰는 구조를 그대로 보여 주고(§S-1), myco가 가진 무거운 부분(인덱스, whisper sidecar, llama.cpp, MCP)은 전부 데스크톱 전제로 짜여 있다(§S-2). 반면 React UI는 이미 375px 셸을 갖고 있어서(`styles.css:7051-7130`) 화면 쪽은 재사용할 수 있다. 다만 Ask 화면 자체가 폰에서 읽히지 않는다(§1의 측정값). 그래서 첫 단계는 **Ask를 폰 폭에서 쓸 수 있게 만드는 웹 레이어 작업**이다. 이 작업은 데스크톱 분할 화면의 좁은 Ask 칸에도 그대로 이득이다.

---

## 1. myco의 현재 모습 — 375×812 실측

| # | 관찰 | 근거 |
|---|---|---|
| A | 답변 1개를 받으면 문서 높이가 **5,199px(약 6.4화면)** 이 된다. 입력창은 맨 위(y=198)에 남고, 인용 본문이 2,316px, 출처 레일은 **y=3,018부터 1,870px**다. 끝까지 읽은 사람이 다음 질문을 하려면 약 4,200px(5,199 − 812 − 198, 5화면 남짓)를 다시 올라가야 한다. | `measure-ask.mjs` 출력(after-answer), `shots-ai-mobile/03-ask-answer-top.png`, `04-ask-answer-scrolled.png` |
| B | 컴포저가 턴 목록 **위**에 있다. 폭이 좁으면 버튼이 입력창 아래로 내려가 전체 폭을 차지한다. 그 위에 페이지 머리(eyebrow·42px 제목·질문/에이전트 세그먼트·리드 문장)가 첫 화면의 1/3을 쓴다. | `PageQuery.tsx:305-352`, `styles/intake.css:233-249`, `02-ask-empty.png` |
| C | 인용 본문은 폭과 상관없이 22px serif, 줄간격 1.7이다. 한 답변에 최대 5쪽을 통째로 인용한다. | `styles.css:11500-11505`, `PageQuery.tsx:66` (`QUOTED_PAGES = 5`) |
| D | 인용 번호 pill은 **24×21px**이다. 터치하면 곧바로 노트로 이동한다. pill과 레일 행을 잇는 강조는 hover/focus에만 걸려 있어서 손가락으로는 "어느 노트인지" 미리 볼 방법이 없다. | `PageQuery.tsx:730-735`, `:764-776`, 측정 `firstPill {h:21,w:24}` |
| E | 기권 카드는 112px 오브와 30px serif 제목이 한 줄에 놓인다. 375px에서는 제목이 "이 질문 / 에 답할 / 근거가 / 볼트에 / 없습니 / 다."처럼 2~3글자씩 끊긴다. 부제는 "색인된 51쪽 중 관련도 바닥선 0.42", 근접 결과는 파일 stem·경로(`wiki/transf…`)·막대·`0.400` 같은 숫자로 보인다. | `05-ask-abstain.png`, `styles.css:12079-12111`, `i18n.ts:5885-5887`, `AbstainCard.tsx:55-96` |
| F | 전송 중 버튼은 "…"로만 바뀌고, 멈출 방법이 없다. | `PageQuery.tsx:325-331`. queryStore에 abort가 없다. AbortController는 `agentStore.ts:79,112`, `OllamaSetup.tsx:75,88`에만 있다. |
| G | 질문 기록은 메모리에만 있다(`turns: []`). 앱을 다시 켜거나 `clear()`하면 사라진다. | `queryStore.ts:185-190`, `:382` |
| H | 오류 턴은 빨간 글자 한 줄뿐이고 다시 시도 버튼이 없다. | `PageQuery.tsx:572-574` |
| I | 홈 입력창 아래 안내가 키보드 전제다("Enter 질문하기 · ⌘Enter 오늘의 노트에 적기"). 상단 바에는 `⌘K` 라벨과 분할·앞/뒤 버튼(28px)이 그대로 있다. | `PageOverview.tsx:369`, `i18n.ts:6218`, `01-home.png` |
| J | 내비게이션은 햄버거 드로어 하나다. 드로어에는 홈·질문·자료 추가·정리 제안·그래프·할 일·더 보기, 내 노트, 설정, 볼트 상태가 한 열로 쌓인다. 행 높이는 coarse pointer에서 44px로 맞춰져 있다(좋음). | `00-drawer-open.png`, `styles.css:7057-7061`, `:7096-7124` |
| K | `?` 도움말 FAB(34×34)가 모든 화면 오른쪽 아래에서 본문·버튼과 겹친다. 하단 컴포저를 붙이면 바로 충돌한다. | `styles.css:8248-8257`, 모든 `shots-ai-mobile/*.png` |
| L | `index.html:5` viewport에 `viewport-fit=cover`가 없다. iOS WebKit은 이 값이 없으면 `env(safe-area-inset-*)`를 0으로 계산한다(알려진 동작이며 기기에서 확인하지는 않음). 그래서 `styles.css:7084-7087`의 safe-area 패딩이 iOS에서는 효과가 없을 가능성이 높다. | `index.html:5` |
| M | 자료 추가 화면의 첫 문구가 "여기에 파일 드롭"이다. 폰에는 드롭이 없다. 카메라·사진·공유 시트 경로도 없다. | `07-ingest.png` |
| N | 음성 입력은 Spotlight와 notch에만 있다(→ whisper → `_inbox/`). Ask·홈 입력창에는 마이크가 없다. | `Spotlight.tsx:7-12, 144`, `lib/notchDriver.ts:912`, `PageQuery.tsx`(mic 없음) |

이미 잘 되어 있는 것: 375px에서 가로 스크롤이 없다(모든 캡처에서 `scrollW == clientW == 375`). 사이드바는 off-canvas 드로어와 scrim으로 동작하고, 상단 바는 내부 스크롤과 safe-area 패딩을 갖고 있다(`styles.css:7051-7130`). 320/375/768/1280 폭은 `scripts/everyday-smoke.mjs`로 점검된다. container query도 이미 쓰고 있다(`styles.css:1911, 9176`, `styles/everyday.css:3`).

---

## 2. AI 답변 — 모바일 패턴

각 항목은 다음 순서로 적었다. 무엇을 하는가 → 일반 사용자에게 왜 통하는가 → 근거 → myco → 제안 → impact/effort.

### M1. 컴포저는 엄지 자리(화면 바닥)에 두고, 모드·범위·첨부를 그 안에 넣는다 — 기존 §1을 모바일 필수 조건으로
- **무엇**: 네 앱 모두 입력창을 바닥에 고정한다. 입력창 한 칸 안에 `+`(첨부), 모드/모델 칩, 마이크, 음성 버튼이 들어간다. 모드를 고르면 입력창 위에 `Research ×` 같은 칩이 붙고 placeholder 문구도 바뀐다("Get a detailed report").
- **왜 통하나**: 한 손으로 폰을 쥐면 엄지가 닿는 곳은 화면 아래쪽이다. 답을 다 읽은 바로 그 자리에서 다음 질문을 친다. 지금 어떤 상태로 묻는지(모드·범위)가 입력창 안에 보이니 설정 화면을 찾지 않아도 된다.
- **근거**: [ChatGPT iOS — 답변 + 하단 "+ Ask ChatGPT"·마이크·음성](https://mobbin.com/screens/8cf567ec-633b-4d0b-81b8-4e05de5fdb9c), [ChatGPT iOS — Research 모드 칩 + 바뀐 placeholder](https://mobbin.com/screens/b85cedcd-cfa4-4f48-87e2-ea433d869dd6), [Claude iOS — "Reply to Claude" + 모델 칩 "Sonnet 4.6 Low"](https://mobbin.com/screens/7f9374bd-79d3-4552-9fe0-bd26e76c94f9), [Perplexity iOS — 홈: 가운데 워드마크, 바닥 컴포저 + Model 칩](https://mobbin.com/screens/f1fbcc17-9ce6-48bb-b9f4-a8a7db2f27c3), [Google Gemini iOS — 바닥 컴포저 + 첨부 이미지 칩 + "Fast"](https://mobbin.com/screens/14c6b403-0f06-482b-8d2e-6c7a32d8a433), [X(Grok) iOS — 컴포저 바로 위 후속 칩 "Think harder"](https://mobbin.com/screens/4768d14c-96e1-4522-8b0a-f0f4eab11090)
- **myco**: §1-A, B, I, K.
- **제안**:
  1. `.ask-composer`를 턴 목록 아래로 옮기고, 폰 폭(또는 Ask 컨테이너가 좁을 때)에서는 `position: sticky; bottom: 0` + `padding-bottom: env(safe-area-inset-bottom)`을 준다. 데스크톱 넓은 창은 지금 배치를 유지해도 된다.
  2. 범위 세그먼트(위키/세션/전체)는 입력창 안의 칩 하나("범위 · 위키 ▾")로 줄이고, 누르면 시트(M4)가 열리게 한다.
  3. 첫 턴이 생기면 페이지 머리(eyebrow·제목·리드)를 접는다.
  4. 후속 질문 칩(기존 §8)은 컴포저 **바로 위**에 가로 스크롤로 둔다.
  5. 같은 diff에서 `?` FAB를 폰 폭에서는 숨기거나 상단 바 ··· 안으로 옮긴다(§1-K).
  6. 구현은 이미 쓰고 있는 container query 패턴을 재사용한다. 그러면 데스크톱 분할 화면의 좁은 Ask 칸도 같은 혜택을 받는다.
- impact high / effort S–M

### M2. 출처는 "칩 → 바텀시트"로 보여 준다. 탭 한 번에 노트로 튕겨 나가지 않는다
- **무엇**: 문장이나 불릿 끝에 회색 출처 칩이 붙는다(`loveandlemons +2`). 답변 아래 액션 줄에는 "Sources"(파비콘 겹침)나 "10 sources" 칩이 있다. 칩을 누르면 **답변 위로 시트**가 올라오고, 시트에는 번호·제목·두 줄 발췌·사이트명이 나온다. 긴 리서치는 시트 안에서 "Citations · 23"으로 도메인별로 묶인다.
- **왜 통하나**: 작은 화면에서는 "이 말이 어디서 왔지?"를 확인하려고 화면을 떠나는 순간 맥락을 잃는다. 시트는 답변을 깔고 그 위에 뜨기 때문에 아래로 쓸어 내리면 바로 읽던 자리로 돌아온다.
- **근거**: [ChatGPT iOS — 인라인 출처 칩 + 액션 줄 "Sources"](https://mobbin.com/screens/8cf567ec-633b-4d0b-81b8-4e05de5fdb9c), [ChatGPT iOS — Sources 바텀시트(grabber, 제목·발췌)](https://mobbin.com/screens/3eaf4e44-fdce-48bc-965b-b194ed9c43ac), [ChatGPT iOS — Sources/Activity 탭, "Citations · 23" 도메인별 번호](https://mobbin.com/screens/57a5fc2b-4f37-4b1b-9006-579e4a3df0c7), [Perplexity iOS — 불릿마다 출처 칩 + "10 sources"](https://mobbin.com/screens/fe1aa2bb-e46b-45b2-ac6f-e2cb4916cbf1), [Perplexity iOS — 번호 매긴 출처 전체 시트](https://mobbin.com/screens/95249214-093e-4d7a-afc1-6bbb951ea9ff), [Google Gemini iOS — 답변 아래 "Sources" 필 버튼](https://mobbin.com/screens/14c6b403-0f06-482b-8d2e-6c7a32d8a433), [Opera iOS — 가로 출처 카드 + "Ask more" 후속 목록](https://mobbin.com/screens/1b7bde20-2db5-40dc-8587-09e7933cf880)
- **myco**: §1-A(레일이 y=3,018), §1-D(24×21 pill, 탭하면 바로 이동, 미리보기는 hover 전용).
- **제안**: coarse pointer(또는 좁은 컨테이너)에서 pill 탭은 **시트 열기**로 바꾼다. 시트 내용은 다음과 같다.
  - 노트 제목, 폴더, tier 칩("내가 쓴 노트")
  - 그 구절
  - [노트 열기](= 지금의 `onOpenPage(r.page, passage)`) · [노트에 인용](= `onQuote(block)`)
  
  답변 아래 "출처 N개" 칩 하나가 SourceLadder 전체를 시트로 연다. 그러면 레일을 답변 밑에 1,870px 길이로 쌓을 필요가 없다. 데스크톱 hover 동작은 그대로 둔다. 기존 §7(호버 팝오버)을 터치용으로 바꾼 형태다.
- impact high / effort M

### M3. 폰에서는 긴 답변을 "첫 구절 + 접힌 나머지"로 보여 준다(원문 그대로라는 원칙은 유지)
- **무엇**: 진행 과정과 부가 정보는 한 줄로 접혀 있다("Thought for a couple of seconds ›", "1 step completed ›", "Read SKILL.md ›"). 출처는 가로 카드 한 줄로 압축된다("Read 20 web pages ⌃" + 가로 카드).
- **왜 통하나**: 폰 화면 하나에 들어가는 글은 150~200단어 정도다. 첫 화면에 핵심 한 덩어리와 "더 있음"이라는 신호만 있으면 사용자는 스스로 펼친다. 처음부터 6화면을 보여 주면 대부분 읽지 않는다.
- **근거**: [ChatGPT iOS — "Thought for a couple of seconds ›" 접힘](https://mobbin.com/screens/8cf567ec-633b-4d0b-81b8-4e05de5fdb9c), [ChatGPT iOS — "Read SKILL.md ›", "Ran 5 commands ›" + ↓ 바닥으로 버튼](https://mobbin.com/screens/0c55f827-6928-446b-93f5-41c38ea8fee0), [Perplexity iOS — "2 steps completed ›" + 문장별 칩 + ↓ 버튼](https://mobbin.com/screens/b7355c29-b0a6-40f7-b41e-cba3c173428a), [Arc Search iOS — "Read 20 web pages ⌃" + 가로 출처 카드 + 제목](https://mobbin.com/screens/80c8c003-c2e5-4e20-a084-552d8cee31b0)
- **myco**: §1-A, C. 인용문은 원문 그대로여야 한다(myco 정체성). 그래서 "요약"은 불가능하고, **접기**만 할 수 있다.
- **제안**: 좁은 컨테이너에서는 다음과 같이 바꾼다.
  1. 본문을 17–18px으로 낮춘다(serif는 유지해도 됨).
  2. 1번 구절은 전부 보여 준다.
  3. 2–5번 구절은 3줄로 잘라 "구절 더 보기(4)"로 둔다.
  4. 접힌 구절 머리에 노트 제목과 번호를 남겨, 어느 노트에서 왔는지는 계속 보이게 한다.
  5. 답변이 화면보다 길면 ↓(바닥으로/컴포저로) 버튼을 띄운다.
- impact high / effort S

### M4. "어디서 찾을까"(범위)는 체크 시트로 고른다
- **무엇**: Gemini는 홈에서 "Choose one or more sources" 시트를 띄운다(Search·Gmail·Drive·Chat 체크 → Done). Claude는 `+` 시트 안에 "Add to project", "Web search" 토글을 둔다.
- **왜 통하나**: "위키/세션/전체" 같은 내부 용어 대신 **사용자가 아는 출처 이름**에 체크한다. 체크한 결과는 컴포저 칩으로 남는다.
- **근거**: [Google Gemini iOS — 출처 선택 시트](https://mobbin.com/screens/d6bb7092-79e2-4627-bc41-9e35b3061620), [Claude iOS — "Add to Chat" 시트: Add to project / Tool access / Web search 토글](https://mobbin.com/screens/58bcab7a-f050-487f-bba8-d129de43cce3), [Perplexity iOS — Models 시트, 기본값 "Best — Best for everyday searches"가 맨 위](https://mobbin.com/screens/bd574396-3374-46b8-ba9c-a2867782643a)
- **myco**: 범위 라벨이 "위키/세션/전체"이고 도움말은 화면 밖 sr 문단에 있다(`i18n.ts:5838-5842`, `PageQuery.tsx:333-355`).
- **제안**: 폰에서는 범위 칩 → 시트로 바꾸고, 항목은 "내 노트(정리된 노트·맵)", "대화 기록", "둘 다"처럼 사람이 쓰는 말로 적는다. 각 항목 아래에 한 줄 설명을 붙이고, 지금의 기본값을 맨 위에 둔다. Perplexity의 "Best" 처리와 같은 방식이다. 데이터 모델(`AskScope`)은 그대로 둔다.
- impact medium / effort S

### M5. "모르겠어요" 다음 행동은 "지금 적어 둘까요?"로 연결한다
- **무엇**: Bond는 기억 검색에서 못 찾으면 이렇게 답한다. "I don't have any specific matcha places in New York saved in your memories yet. Would you like me to save a recommendation…?" 기권하고 곧바로 **저장을 제안**하는 흐름이다. Monese는 "No offers found" 아래에 이유 → 할 일 → 주 버튼 → "I'll do it later" 순서로 보여 준다. Claude는 모호할 때 답 대신 번호 매긴 선택지 카드("1 of 2")를 컴포저 자리에 띄운다.
- **왜 통하나**: 일반 사용자에게 "근거 없음"은 막다른 길이다. 다음 한 걸음(적어 두기, 범위 넓히기, 질문 좁히기)이 큰 버튼 하나로 주어지면 실패가 아니라 다음 단계가 된다.
- **근거**: [Bond iOS — 기억에 없음 + 저장 제안](https://mobbin.com/screens/4b5284ea-7e34-4b49-bb4d-ac4736afb9fd), [Monese iOS — No offers found: 이유·해결·주 버튼·나중에](https://mobbin.com/screens/41c7ac9f-3724-4534-8c06-bb9575312ae6), [Claude iOS — 명확화 질문 카드 "1 of 2", 번호 선택지 + 직접 입력](https://mobbin.com/screens/465d155d-404f-40b5-8fc5-ba686cec318b). 반면교사: [ClickUp Brain iOS — "No updates in the last NaN days."](https://mobbin.com/screens/06904e8e-9a1b-4ee8-98dd-3756f6927b9a)
- **myco**: §1-E. 기권 카드의 행동은 "수확 대상으로 기록"(recall-miss)과 "범위 넓혀 다시"(S5)다. 사용자가 그 내용을 **바로 적어 두는** 경로는 카드에 없다. 홈에는 "오늘의 노트에 적기" 경로가 이미 있다(`PageOverview.tsx:369`의 ⌘Enter 경로).
- **제안**:
  1. 좁은 폭에서는 오브를 숨기거나 48px로 줄이고, 제목을 22px 한 덩어리로 만든다.
  2. 제목을 쉬운 말로 바꾼다: "내 노트에서 이 내용을 찾지 못했어요". 숫자(쪽수·바닥선·유사도)는 "자세히" 아래로 내린다.
  3. 주 버튼을 **"이 질문을 오늘 노트에 적어 두기"** 로 둔다. 홈의 오늘 노트 append 경로를 재사용하고, 질문 텍스트와 날짜만 쓴다. 지어낸 답은 쓰지 않는다.
  4. 보조 버튼은 "범위 넓혀 다시"(기존 onWiden)로 둔다.
  
  S5 범위(Spotlight 기권 표시·영수증·widen 일회성)와 겹치지 않는 새 행동이다. 일반 사용자에게는 이 버튼이 "기록하기"(recall-miss)보다 의미가 분명하다.
- impact high / effort S

### M6. 진행 중에는 "읽는 노트 이름"을 보여 주고, 전송 버튼을 ■ 정지로 바꾼다 — 기존 §5·§6의 모바일 형태
- **무엇**: 진행 중에는 전송 버튼 자리가 그대로 ■로 바뀐다. 멈춘 턴은 오류가 아니라 "Research stopped" 카드로 남는다. Arc Search는 로딩 화면 자체를 "Reading 20 web pages"와 실제 도메인 이름 목록으로 채운다.
- **왜 통하나**: 폰에서 기다림은 더 길게 느껴진다. 무엇을 하고 있는지가 **글자**로 보이고, 멈춤 버튼이 엄지 자리에 있으면 사용자는 기다릴지 말지를 직접 정한다.
- **근거**: [ChatGPT iOS — 실행 중 ■ 버튼](https://mobbin.com/screens/1e0d754c-569d-4767-89b7-36bf956dc8b7), [ChatGPT iOS — "Research stopped" 접힌 카드](https://mobbin.com/screens/2add2805-fa2c-406b-bc82-fb3d6682d926), [Google Gemini iOS — 생성 중 ■](https://mobbin.com/screens/b9e4db31-7179-4fe7-af15-c9b6f36711f1), [Arc Search iOS — "Reading 20 web pages" + 도메인 목록 "… and more"](https://mobbin.com/screens/4197a8be-4a2b-4681-b054-db89e9f0eae3)
- **myco**: §1-F. 진행 표시는 canvas `ThinkingGalaxy` 하나와 라벨 "answering from {n} pages…"다(`PageQuery.tsx:178-195`, `:578`).
- **제안**: 진행 중 턴에 검색된 노트 **제목**을 텍스트 목록으로 쌓는다("노트 7개를 읽는 중 · 트랜스포머 구조 · 셀프 어텐션 …"). 갤럭시는 그 위 장식으로 남겨도 된다. 정지는 `agentStore.ts:79,112`의 AbortController 패턴을 재사용한다. 추출형 경로는 IPC 1회라 즉시 끝나므로, 정지가 의미 있는 건 provider/Ollama 경로다.
- impact medium / effort M

### M7. 음성은 "받아쓰기"와 "대화 모드"를 나누고, myco에는 받아쓰기만 둔다
- **무엇**: ChatGPT 받아쓰기는 컴포저가 파형으로 바뀌고 왼쪽 ■, 오른쪽 ↑ 버튼이 붙는다. 음성 대화는 별도 전체 화면이다(오브, 그리고 텍스트 입력도 유지). 대화가 끝나면 스레드에 "Voice chat ended 36s"가 남고, 말한 내용이 글로 남는다. Gemini Live는 자막 토글을, Claude는 "Start talking" 화면을 쓴다.
- **왜 통하나**: 받아쓰기는 "타자 대신 말"이라 누구나 바로 이해한다. 대화 모드는 모델이 말로 답할 때만 가치가 있다.
- **근거**: [ChatGPT iOS — 받아쓰기 파형 + ■/↑](https://mobbin.com/screens/902347b7-a516-4282-98b8-717cc859d39d), [ChatGPT iOS — Voice 모드(오브 + 텍스트 입력 유지)](https://mobbin.com/screens/64be7109-fd45-4292-9010-c6ad15a88d6d), [ChatGPT iOS — "Voice chat ended 36s" + 전사 남음](https://mobbin.com/screens/c5788d46-2106-481c-b034-b5e0a8d29c94), [Google Gemini iOS — Live: 자막 토글, 카메라·화면공유·마이크·종료](https://mobbin.com/screens/9362deca-d1dd-4492-bbe1-6c04b8bb5c01), [Claude iOS — 음성 "Start talking"](https://mobbin.com/screens/1052f36b-9be7-458e-a041-ad086ef59602)
- **myco**: §1-N. myco 답변은 노트 원문 인용 최대 5개다(`PageQuery.tsx:66`). 이것을 소리로 읽어 주는 대화 모드는 길고 어색하다(추론). 음성 메모 → `_inbox/` 캡처는 이미 데스크톱에 있다.
- **제안**: 폰 컴포저에는 마이크 = 받아쓰기(입력창에 텍스트를 채우고 사용자가 보낸다)만 둔다. "음성 메모 저장"은 `+` 시트의 캡처 항목으로 둔다(M8). 음성 대화 모드는 만들지 않는다. 받아쓰기 엔진에는 제약이 있다. 데스크톱 whisper는 sidecar 프로세스(`tauri.conf.json:64` `externalBin`, `whisper.rs` 머리말의 `std::process::Command`)라서 iOS에서는 그대로 돌릴 수 없다(추론: iOS 앱은 하위 프로세스를 띄울 수 없음). OS 키보드 받아쓰기나 OS 음성 인식을 쓰거나, 녹음 파일을 데스크톱으로 보내 전사해야 한다.
- impact medium / effort S(키보드 받아쓰기 의존) ~ M(자체 마이크)

### M8. 첨부·자료 추가는 `+` 시트 하나로 모은다
- **무엇**: Claude는 `+` → "Add to Chat" 시트를 띄운다. 상단에 Camera / Photos / Files 큰 타일 3개, 그 아래 토글이 있다. Perplexity는 Image / Camera / File / Connectors 타일과 "47 uploads remaining this month" 안내를 둔다. Gemini는 `+` 메뉴에 NotebookLM / Drive / Files / Photos / Camera를 둔다.
- **왜 통하나**: 폰 사용자의 자료는 대부분 **카메라·사진첩·파일 앱**에 있다. 큰 타일 3개면 설명이 필요 없다.
- **근거**: [Claude iOS — Add to Chat 시트](https://mobbin.com/screens/58bcab7a-f050-487f-bba8-d129de43cce3), [Perplexity iOS — Options 시트: Image/Camera/File/Connectors + 남은 업로드 수](https://mobbin.com/screens/d7220e78-7231-4822-ab69-169c863deff9), [Google Gemini iOS — `+` 메뉴 NotebookLM/Drive/Files/Photos/Camera](https://mobbin.com/screens/e6ff39a4-3df1-475b-bdad-5aadb6e3575d), [Claude iOS — 프로젝트 파일 빈 상태 "No files yet…" + Choose File / Add Text](https://mobbin.com/screens/db291aa9-629e-4b54-9a34-a9ab38b509d7)
- **myco**: §1-M. 화면 문구상 ingest는 "파일, 문서, 이미지, 음성 또는 YouTube 링크"를 받는다(`07-ingest.png`).
- **제안**: 폰에서는 자료 추가 첫 화면을 큰 타일 4개로 바꾼다: **사진 찍기 · 사진 · 파일 · 링크 붙여넣기**. 그 아래에 "글 붙여넣기"와 "음성 메모"를 둔다. 각 항목은 기존 ingest 파이프라인으로 보낸다. "여기에 파일 드롭"은 pointer: fine일 때만 보인다. 같은 시트를 Ask 컴포저의 `+`에서도 연다.
- impact high / effort M

### M9. 다른 앱에서 "공유 → myco": 한 번 탭하면 끝나고, 확인은 짧게, 판단은 나중에
- **무엇**: mymind는 공유 시트에서 고르면 전체 화면 확인 "Good find! It's in your mind. [+ Add Details]"를 띄우고, 상단 진행 막대가 차면 저절로 닫힌다. Matter는 "Saving…" 아래에 Add Tags / Take a Note / Archive를 둔다. 첫 실행 체크리스트에 "Save from your phone / Save from your computer [Enable]"가 있고, 한 번 저장하면 체크된다.
- **왜 통하나**: 폰에서 가장 흔한 "자료 넣기"는 읽던 앱에서 공유 버튼을 누르는 것이다. 저장은 즉시 끝나야 하고, 덧붙이기는 선택이어야 한다.
- **근거**: [mymind iOS — 공유 후 확인 오버레이 + Add Details](https://mobbin.com/screens/bc1fa1fd-9d9c-4f9b-9f70-d427816835fd), [Matter iOS — Saving an article to queue 플로우(체크리스트 → 공유 확장 "Saving…" → 큐에 표시 + 체크)](https://mobbin.com/flows/143f64c0-0aa7-41cd-8b75-e12f47ddbfe6)
- **myco**: 웹 클리퍼와 북마클릿은 이미 `myco://clip?url&title&selection` 딥링크로 데스크톱 앱에 넣는다(`clipper/background.js:1,14`, `clipper/README.md:25`, `src-tauri/Cargo.toml:25` `tauri-plugin-deep-link`). MCP 안내문에 따르면 ingest는 "쓰레기·중복이면 아무것도 쓰지 않는" 판단을 먼저 한다.
- **제안**: 모바일 공유 확장은 **같은 clip payload `{url,title,selection}`** 를 그대로 쓴다. 공유한 순간에는 "myco에 담았어요 · 메모 추가" 한 장만 띄운다. 판단(정리됨/이미 있음/거절)은 나중에 홈이나 알림에서 보여 준다. 공유 시트 안에서 기다리게 하지 않는다. 데스크톱 첫 실행 체크리스트에 "휴대폰에서 저장하기"를 추가한다(Matter 방식, §S-1의 연결 과정과 연결).
- impact high / effort M(공유 확장은 네이티브 타깃이 필요함)

### M10. 질문 기록은 드로어 + 바닥 검색 + 스와이프로 — 기존 §4의 모바일 형태
- **무엇**: ChatGPT는 전체 화면 드로어(Projects · Recents 제목만, 고정 핀)를 쓰고, 오른쪽 아래에 "Chat" 필 FAB를 둔다. 검색창은 바닥에 있다. 행을 왼쪽으로 밀면 빨간 "Archive"가 나온다. 빈 상태 문구는 "Once you start chatting, your conversations will appear here."다. Perplexity는 검색을 바닥 입력창으로 하고, 결과 행에 "1 day ago · Computer"를 붙인다. 항목 ··· 메뉴에는 "Open in Computer"(데스크톱에서 열기)가 있다.
- **왜 통하나**: "아까 물어본 거"를 다시 찾는 일은 폰에서 더 잦다. 검색창이 엄지 자리에 있어야 한다.
- **근거**: [ChatGPT iOS — 드로어: Projects/Recents + Chat FAB](https://mobbin.com/screens/ab1d0c55-4180-4ad4-b9b6-5a21242092f1), [ChatGPT iOS — 바닥 "Search Chats" + Chat 버튼](https://mobbin.com/screens/2db4384c-4fd7-4b23-8612-251c6b59a99e), [ChatGPT iOS — 스와이프 Archive](https://mobbin.com/screens/f3455f7c-b755-47a7-b926-67c07fe02b86), [ChatGPT iOS — 빈 기록 문구](https://mobbin.com/screens/9cacfecd-ef8a-4feb-9327-2dc5b8642ad2), [Perplexity iOS — 바닥 검색 + 결과 + New FAB](https://mobbin.com/screens/bf1e2bbe-0186-40e5-87d5-8a24c2f3153c), [Perplexity iOS — ··· "Open in Computer"](https://mobbin.com/screens/c67001cd-84ea-4f31-8a2f-f980f06e1932)
- **myco**: §1-G.
- **제안**: 기존 §4(`ChatTurn.at` + 볼트별 append 로그)를 먼저 한다. 폰에서는 질문 탭 상단 "기록" 버튼 → 목록(제목 = 질문, 부제 = 상대 시간 · 인용 노트 수 · 기권 여부) → 바닥 검색 순서로 연결한다. 행을 왼쪽으로 밀면 삭제하되, ··· 메뉴에도 같은 동작을 둔다(C5). 원격 모드에서는 "데스크톱에서 열기"를 둔다.
- impact high / effort M

### M11. 오류는 그 턴 안에서, 다시 시도 버튼과 함께 보여 준다. 연결 문제는 컴포저 위 띠로 보여 준다
- **무엇**: Alan은 스레드 안에 빨간 카드("We can't find Mo — Retry in a few seconds [↻ Retry]")를 넣는다. OpenPhone은 "Failed to send"를 표시하고, 길게 누르면 Retry sending이 나온다. Claude는 모델을 쓸 수 없을 때 컴포저 바로 위 띠("…currently unavailable. [Learn more] ×")로 알린다. 반대로 Wysa는 모달 "Uh-oh!"로 화면을 막는다.
- **왜 통하나**: 어떤 질문이 실패했는지가 그 자리에서 보이고, 한 번 탭하면 같은 질문을 다시 보낼 수 있다.
- **근거**: [Alan iOS — 턴 안 오류 카드 + Retry](https://mobbin.com/screens/d2fd4e09-8370-44f4-837c-108b9380edae), [OpenPhone iOS — 실패 표시 + 길게 눌러 재전송](https://mobbin.com/screens/fd44cd6d-3bf9-4be7-bae2-f6e4b25cb27d), [Claude iOS — 컴포저 위 가용성 띠](https://mobbin.com/screens/2f4b2424-da04-4326-8bc4-a01e30724ebb), [Perplexity iOS — 검색 오류 카드 "Try again"](https://mobbin.com/screens/53c1cd17-3832-45bf-adcc-d86bd15c7a15), 반면교사 [Wysa iOS — 모달 연결 오류](https://mobbin.com/screens/7d6e310a-f1ca-42cc-8a57-6d87ac5dc6c7)
- **myco**: §1-H. stale/retrievalFailed 안내는 설정으로 보내는 링크다(`PageQuery.tsx:608-638`).
- **제안**: 오류 턴에 [다시 시도](같은 질문, 같은 범위로 `askStore` 재호출)를 둔다. 원격 모드(§S-1)의 "Mac 연결 끊김"은 모달이 아니라 컴포저 위 띠로 알리고, 입력은 막지 않는다. 연결이 돌아오면 보낼 수 있게 질문을 대기열에 넣는다.
- impact medium / effort S

### M12. 구절을 길게 누르면 메뉴가 열린다(한국 사용자에게 익숙한 메신저 동작)
- **무엇**: LINE은 메시지를 길게 누르면 격자 메뉴(복사 · 선택해서 복사 · Keep · 삭제 · 답장 · 공유 · 노트 · 캡처)를 연다. Telegram은 메뉴 안에 "Hold a word, then move cursor to select more text to copy or quote."라는 힌트를 둔다. Gmail에는 "Quote in reply"가 있다.
- **왜 통하나**: 카카오톡이나 LINE을 쓰는 한국 사용자는 "꾹 누르면 메뉴"를 이미 안다. 구절마다 작은 버튼을 붙이지 않아도 된다.
- **근거**: [LINE iOS — 길게 누르기 격자 메뉴(Keep·노트 포함)](https://mobbin.com/screens/4b3b1373-0b67-483d-827e-ab09d18ada9a), [Telegram iOS — 메뉴 안 선택 힌트](https://mobbin.com/screens/236fc8bc-865d-4750-a134-e1ffb0e8b4af), [Gmail iOS — Quote in reply](https://mobbin.com/screens/18366947-21ed-465b-aa8b-454c99e8e189), [ChatGPT iOS — 메시지 인용 칩이 컴포저에 붙음](https://mobbin.com/screens/ffe03669-a64a-406c-98c5-32d85f3ea382)
- **myco**: 구절마다 "노트에 인용" ghost 버튼이 붙는다(높이 약 20px, `PageQuery.tsx:754-762`, `styles.css:11600-11606`, `04-ask-answer-scrolled.png`).
- **제안**: 폰에서는 구절을 길게 누르면 메뉴(복사 · 노트에 인용 · 원문 노트 열기 · 이 구절로 다시 묻기)가 열리게 하고, 구절마다 붙은 버튼은 숨긴다. "이 구절로 다시 묻기"는 ChatGPT처럼 컴포저에 인용 칩을 붙이는 방식으로 하며, 기존 followUp 문맥과 같은 경로를 쓴다. 데스크톱은 지금 그대로 둔다.
- impact medium / effort S

### M13. (provider 답변 한정) 문장 단위로 "내 노트에 근거 있음"을 표시한다 — Gemini double-check
- **무엇**: Gemini는 답변 문장 가운데 확인된 것을 초록 배경 + ⌄로 칠한다. 문장을 누르면 시트에 "Google Search found similar content, like this:" + 출처 + 발췌가 나오고, "Was this check helpful?"을 묻는다.
- **왜 통하나**: 합성된 답에서 어느 문장을 믿어도 되는지가 문장 단위로 보인다.
- **근거**: [Google Gemini iOS — 확인된 문장 하이라이트](https://mobbin.com/screens/e6ff39a4-3df1-475b-bdad-5aadb6e3575d), [Google Gemini iOS — 문장 탭 → 근거 시트 + 피드백](https://mobbin.com/screens/b778369a-80d7-4740-bf86-90ac2caf139f)
- **myco**: 추출형 답변은 이미 전부 원문이므로 해당하지 않는다. provider로 합성한 답변은 "산문으로 인용할 뿐 인용별 숫자가 없다"(`queryStore.ts:52-60` 주석)고 되어 있고, `Viewer`로 그대로 렌더한다(`PageQuery.tsx:575-576`).
- **제안**: provider 답변의 문장마다 기존 retrieval을 돌린다. 바닥선을 넘은 문장만 칠하고, 누르면 M2와 같은 출처 시트를 연다. 넘지 못한 문장은 칠하지 않는다. "근거 없음"이라고 빨갛게 표시하지 않는 것이 Gemini 방식이다. 이렇게 하면 abstain 원칙이 합성 답변에도 문장 단위로 이어진다. 백엔드 호출이 문장 수만큼 늘어나므로 비용을 측정한 뒤에 결정한다.
- impact medium / effort L

---

## 3. 모바일 기본기 (Linear · Things · Arc Search 등)

### C1. 하단 탭 4개 + 검색 따로. 나머지는 "더 보기"를 펼친 목록으로
- **근거**: [Linear Mobile — 떠 있는 필 탭바(Inbox·My issues·Favorites·⌃) + 검색 원형 버튼 분리](https://mobbin.com/screens/3d9ccfd8-2425-49e9-a00b-27189140d3a3), [Linear Mobile — ⌃를 누르면 전체 메뉴 목록 + Customize](https://mobbin.com/screens/f97b18e7-5e86-42f2-85df-9e7a000fae0e), [Matter iOS — Discover/Inbox/Queue + 검색 분리](https://mobbin.com/flows/143f64c0-0aa7-41cd-8b75-e12f47ddbfe6), [Todoist iOS — 탭 5개 + 빨간 + FAB](https://mobbin.com/screens/951b39d3-c819-4dbf-a9bb-744f6b7be46d). 탭바 없이 가는 예도 있다: [Things 3 iOS — 목록형 홈 + Quick Find + + FAB](https://mobbin.com/screens/d89a5c8c-6393-4496-8189-acb27c593a9a), [ChatGPT iOS — 드로어 + Chat FAB](https://mobbin.com/screens/ab1d0c55-4180-4ad4-b9b6-5a21242092f1).
- **왜 통하나**: 자주 하는 일 3–4개는 한 번 탭으로 닿고, 나머지는 한 단계 안에 다 있다. 검색은 어느 탭에서든 같은 자리에 있다.
- **myco**: §1-J. 상단 바에 앞/뒤·분할·⌘K가 있다(`01-home.png`, `Topbar.tsx:55-105`).
- **제안**: 폰 탭은 **홈 · 질문 · [+ 넣기] · 할 일**, 그리고 검색 원형 버튼으로 구성한다. 그래프·정리 제안·설정은 "더 보기" 목록으로 보낸다. 그래프는 폰에서 보는 화면이지 작업하는 화면이 아니다(`06-graph.png`: 컨트롤이 첫 화면 절반을 차지함). 폰 폭에서는 상단 바의 앞/뒤(OS 뒤로 제스처가 대신함)와 분할 버튼을 숨긴다. 이 셸은 §S의 B/C안을 고르기 전에도 웹 레이어로 만들어 `?mock=1` 375px에서 검증할 수 있다.
- impact high / effort M

### C2. 키보드 힌트는 터치 대안으로 바꾸고, 빈 상태에서 제스처를 가르친다
- **근거**: [Things 3 iOS — 빈 프로젝트 "Tap or drag the plus button to create a new to-do."](https://mobbin.com/screens/fd56170e-e338-4098-86d1-8395a6f66651), [Things 3 iOS — + 를 끌어다 놓은 자리에 새 항목 + 하단 When/Move/삭제 막대](https://mobbin.com/screens/d6e7f013-e95c-4203-b98f-dfe27bac343d), [Telegram iOS — 메뉴 안 힌트](https://mobbin.com/screens/236fc8bc-865d-4750-a134-e1ffb0e8b4af)
- **myco**: §1-I.
- **제안**: `(any-pointer: coarse)`일 때 `home_ask_keys` 줄을 버튼 두 개 **[질문하기] [오늘 노트에 적기]** 로 바꾼다. `⌘K` 라벨은 숨기고 검색 아이콘만 남긴다. i18n 키를 하나 추가해야 한다(en/ko/ja parity).
- impact medium / effort S

### C3. 폰에서 모달·팝오버·드롭다운은 바텀시트 하나로 통일한다
- **근거**: [Linear Mobile — 검색 가능한 필터 시트](https://mobbin.com/screens/2f215b52-9a22-4ee9-b192-88e2de993521), [Linear Mobile — Snooze 플로우(구체적 시각 시트 → "Notification snoozed · Undo")](https://mobbin.com/flows/8c251f14-40b6-4be0-af8e-71dc6278f2c4), [Fabric iOS — 작업 시트, 삭제만 따로 빨간 그룹](https://mobbin.com/screens/fb35f50d-bccd-4f2c-88d2-16e42dc12ab6), [Claude iOS — 삭제 확인은 메뉴 옆 작은 팝오버](https://mobbin.com/screens/f74f92e4-9509-49e3-8849-1186d7c69850), [ChatGPT iOS — 보관 확인 팝오버 "You can view archived chats in Settings"](https://mobbin.com/screens/20a1bc29-9421-463d-bb58-951e2fea6aa4)
- **왜 통하나**: 시트는 엄지 쪽에서 올라오고, 아래로 쓸면 닫히고, 뒤 화면이 보인다. 위험한 동작은 시트 안에서도 따로 떨어져 있다.
- **myco**: S1로 인앱 다이얼로그(`DialogHost.tsx`)가 들어왔다. 바텀시트는 할 일 상세 하나뿐이고, 그것도 CSS 규칙으로만 되어 있다(`styles.css:1834-1845`, `@media (max-width: 640px)`의 `.task-detail`). 시트 컴포넌트는 따로 없다(`src/components`, `src/components/ui` 목록 확인. `TidySheet.tsx`는 이름과 달리 focus-trap 모달이다).
- **제안**: `.task-detail`의 640px 시트 규칙을 공용 시트로 끌어올린다. 그 시트를 M2(출처) · M4(범위) · M8(넣기) · 노트 ··· 메뉴 · DialogHost(폰 폭)에 같이 쓴다. 다섯 곳이 쓰므로 추상화할 이유가 있다. 삭제 같은 위험 동작은 시트 안 별도 그룹에 빨간색으로 둔다(Fabric 방식).
- impact high / effort M

### C4. 스와이프는 지름길일 뿐이다. 같은 동작을 항상 메뉴에도 둔다
- **근거**: [ChatGPT iOS — 스와이프 Archive](https://mobbin.com/screens/f3455f7c-b755-47a7-b926-67c07fe02b86), [GitHub iOS — 왼쪽 스와이프 동작을 설정에서 고름](https://mobbin.com/screens/37a63823-8a0b-479b-bf6a-7354a718618d), [Notion Mail iOS — 스와이프 설정(빈 상태 "Add action")](https://mobbin.com/screens/0966f755-182c-40de-8a71-975c220b0acf), [Linear Mobile — 상세 화면 하단 Unread/Snooze/Delete 막대](https://mobbin.com/screens/c25eeb30-eb9c-421f-87b0-a0f14dfa259d)
- **myco 적용처**: 질문 기록 행(삭제), 할 일(완료), 다시 만난 노트(S7의 Keep/Later → 오른쪽으로 밀면 Keep, 왼쪽으로 밀면 Later + Undo 토스트). S7 자체는 이미 들어가 있으므로 제스처만 추가하는 것이다.
- impact medium / effort S

### C5. 필터 때문에 비면 "몇 개가 가려졌는지"를 말한다
- **근거**: [Linear Mobile — "4 notifications hidden by filters · Clear filters"](https://mobbin.com/screens/52093bab-28c9-4aa7-805a-3fb4b3daffdc)
- **제안**: 폰에서 새로 만드는 목록(질문 기록·넣은 자료 대기열)의 빈 상태 규칙으로 삼는다. 이 규칙은 기존 myco 목록에 대한 결함 주장이 아니다. 그 목록들은 이번에 확인하지 않았다.
- impact low / effort S

### C6. 터치 목표 44px, safe-area, 떠 있는 버튼끼리 충돌하지 않게
- **myco**: §1-D(24×21 pill), §1-I(28px 상단 pill), §1-K(34px FAB가 본문과 겹침), §1-L(`viewport-fit=cover` 없음). 사이드바 행은 이미 44px다(`styles.css:7057-7061`).
- **제안**: coarse pointer일 때 `.ask-cite`, 상단 바 pill, `.ask-quote`의 터치 영역을 44px로 넓힌다. 보이는 크기는 그대로 두고 padding이나 `::after` hit-area를 쓴다. `index.html:5`에 `viewport-fit=cover`를 추가한다. 하단 컴포저(M1)·탭바(C1)가 생기면 FAB는 폰 폭에서 제거한다.
- **햅틱**: Mobbin 스크린샷으로는 확인할 수 없다. 근거가 없어서 제안하지 않는다.
- impact medium / effort S

---

## 4. 모바일 버전 전략 — 어떻게 할지

### S-1. 참고 구조 세 가지 (Mobbin 근거)
- **A. 폰 = 데스크톱의 리모컨** — ChatGPT iOS의 Codex.
  - 폰에서 "Waiting for desktop… Follow the instructions in the desktop app to get connected." → "Finishing secure setup…" → 기기 이름과 초록 점 → 작업 목록.
  - 데스크톱이 꺼져 있으면 "Offline · Last seen 18 minutes ago · Reconnect"를 보여 준다.
  - Connections 시트에서 기기별 토글, Add connection, Disconnect All을 제공한다.
  - 근거: [Connecting to desktop app 플로우](https://mobbin.com/flows/912012a5-1551-4c9f-88c9-ce5737d5961f), [Waiting for desktop 화면](https://mobbin.com/screens/ca798dd0-24dd-40c8-80b9-d94a764ef728), [Offline · Last seen · Reconnect](https://mobbin.com/screens/635cf9e7-fad6-4e72-b13d-20c138e4af00), [Turning off a connection 플로우](https://mobbin.com/flows/703858f2-9fac-4726-aef8-89d5d1165d86). 데스크톱 쪽 연결 화면 예: [Confluence web — Connect phone: QR 스캔 → 6자리 코드 → Connect phone, "Can't scan the code?"](https://mobbin.com/screens/1502677a-3217-4dbd-8be1-58ff659d9135), [Revolut Business web — "Scan QR or copy link"](https://mobbin.com/screens/51e1e10a-5fad-4ba7-9ce6-b7b291c64c9b).
- **B. 폰에도 볼트 사본** — Obsidian iOS. "Obsidian stores notes on your device… even offline. Your data is stored in a secure local folder called a vault." [Create a vault / Use my existing vault]. 생성할 때 "Store in iCloud — This cannot be changed later." 근거: [Obsidian iOS 첫 화면](https://mobbin.com/screens/e77414c6-2bee-4455-be64-60b7887b75f5), [Obsidian iOS — Store in iCloud 토글](https://mobbin.com/screens/d44bb05b-31a0-4f76-8f49-068327153bd2)
- **C. 넣기 전용 짝꿍** — Matter, mymind. 공유 확장으로 넣고, 폰은 대기열만 본다(M9 근거).

### S-2. myco 쪽 사실 (코드에서 확인)
- 데스크톱 전용으로 묶여 있다.
  - 번들 타깃 `dmg`, `nsis`(`tauri.conf.json:36-38`), 창 `minWidth: 800`(`:20`), `macOSPrivateApi`(`:13`)
  - `tauri` features `tray-icon`, `macos-private-api`(`Cargo.toml:22`), `tauri-plugin-global-shortcut`(`:69`), notch용 `objc2-app-kit`(`:81`), `window-vibrancy`(`:86`)
  - whisper는 sidecar(`tauri.conf.json:64`), 로컬 모델은 `llama-cpp-2`(`Cargo.toml:46`)
- MCP 서버는 `127.0.0.1:22360`에만 bind하고 Bearer 토큰을 요구한다(`mcp_native.rs:44`, `:2972-2973`, `:244`). 지금은 폰에서 접근할 수 없다. 의도된 보안이다.
- 번들 임베딩 모델은 `multilingual-e5-small-ko-v2-q8_0.gguf` **39.7MB**다(`local_llm.rs:96,128`, `src-tauri/models/` 목록).
- 웹 UI는 375px 셸이 있다(`styles.css:7051-7130`). IPC mock으로 브라우저에서도 돈다(`?mock=1`, `scripts/everyday-smoke.mjs`).
- 클립은 `myco://clip` 딥링크 계약이 이미 있다(`clipper/background.js:14`).
- 배경지식(이 세션에서 문서로 확인하지 않음): Tauri 2는 iOS/Android 빌드 타깃을 지원한다. 위 데스크톱 전용 의존성은 `cfg`로 걸러 내야 한다.

### S-3. 권장 (판단이며, 근거와 이유를 함께 적음)
1. **1단계 — 웹 레이어만 (네이티브 없음)**: M1 · M2 · M3 · M5 · C2 · C6.
   - 데스크톱에서도 가치가 있다. 분할 화면의 좁은 Ask 칸에 container query로 같은 규칙이 걸린다.
   - `?mock=1` 375px 스모크로 검증할 수 있다.
   - 이 단계 없이 폰 앱을 내면 §1-A의 6화면짜리 답변이 그대로 폰에 실린다.
2. **2단계 — C안 + A안의 질문만**: 공유 확장(M9)과 넣기 시트(M8)로 `myco://clip` 계약을 재사용한다. 질문은 데스크톱 myco에 원격으로 보낸다(A안).
   - 이유 1: 볼트, 인덱스, `raw/` 불변 규칙, ingest 판단이 한 곳(데스크톱)에 남는다.
   - 이유 2: 폰에서 인덱스를 다시 만들 필요가 없다.
   - 필요한 것: 루프백 MCP와 **별도인** 페어링 전송 계층(QR + 코드, 기기별 철회, 오프라인 대기열 — Codex와 Confluence 화면 구조). 원격에 열어 줄 동작은 질문과 넣기로 제한한다. 이 부분은 보안 설계를 따로 해야 한다.
3. **3단계(보류) — B안**: 볼트 폴더를 iCloud로 동기화하고 폰에서 추출형 Ask를 직접 돌린다.
   - 임베딩 모델이 39.7MB라 기기 내 실행 가능성은 있다(추론, 측정 안 함).
   - 막히는 곳: whisper sidecar, llama.cpp 빌드, 인덱스 동기화 충돌.
   - 노트 읽기·편집은 사용자가 이미 Obsidian 모바일로 할 수 있다(볼트가 Obsidian 호환). 그래서 myco가 폰 편집기를 따로 만들 이유가 약하다.
4. **만들지 않는 것**: 음성 대화 모드(M7), 폰용 그래프 편집 컨트롤(보기만 제공), 폰 블록 편집기.

---

## 5. 우선순위 요약

| 순위 | 항목 | impact / effort | 비고 |
|---|---|---|---|
| 1 | M1 하단 컴포저 + 머리 접기 + FAB 정리 | high / S–M | 기존 §1. 폰에서는 필수 |
| 2 | M3 좁은 폭 답변 접기 | high / S | §1-A 5,199px |
| 3 | M2 출처 칩 → 시트 | high / M | C3 시트와 같이 |
| 4 | M5 기권 → "오늘 노트에 적어 두기" | high / S | S5와 겹치지 않음 |
| 5 | C2 · C6 키보드 힌트·터치 목표·`viewport-fit` | medium / S | 같은 diff로 가능 |
| 6 | C1 폰 탭바 셸 | high / M | 웹 레이어 |
| 7 | M10 질문 기록(기존 §4) + M11 다시 시도 | high / M · medium / S | |
| 8 | M8 넣기 시트, M9 공유 확장 | high / M | 2단계(네이티브) |
| 9 | M6 진행·정지, M12 길게 누르기 | medium / M · S | |
| 10 | M13 provider 문장 근거 | medium / L | 비용 측정 후 |

---

## 6. 찾지 못한 것 / 대체한 것

- **Gemini**: Mobbin의 "Gemini"는 암호화폐 거래소 앱이다(첫 검색에서 거래소 화면만 반환됨). 어시스턴트는 "Google Gemini"로 수록되어 있다. "Hello" 인사 홈 화면 검색은 0건이었고, 홈은 [출처 선택 시트 뒤의 "Hi Alex — Where should we start?"](https://mobbin.com/screens/d6bb7092-79e2-4627-bc41-9e35b3061620)로 대신했다.
- **Things 3의 스와이프 제스처**: 캡처되지 않았다. 스와이프는 ChatGPT, GitHub, Notion Mail 화면으로 대신했다.
- **Claude iOS의 웹 출처 인용 화면**: 검색되지 않았다.
- **"내 문서에 없음" 전용 기권 화면**: ChatGPT, Claude, Perplexity, Gemini 어디에도 없었다(이전 라운드와 같은 결론). 가장 가까운 것은 Bond였다.
- **Android**: Mobbin MCP의 `platform` 값이 `ios`/`web`뿐이라 검색할 수 없었다.
- **햅틱**: 스크린샷으로는 관찰할 수 없다.
- **myco 실기기 확인 안 함**: 모든 myco 화면은 Chromium 모바일 에뮬레이션(375×812)과 IPC mock 결과다. iOS WKWebView의 safe-area 동작(§1-L)과 실제 볼트 데이터의 노트 제목 표시는 확인하지 않았다. mock의 인용 링크·노트 제목이 stem(`transformer-architecture`)으로 보이는 것(`08-note.png`, `05-ask-abstain.png`)이 실제 볼트에서도 그런지는 모른다.
