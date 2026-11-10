# myco 데스크톱 사용성 감사 (2026-10-01)

일반 사용자가 myco 데스크톱 앱을 처음부터 끝까지 써 보는 상황을 가정하고 현재 빌드를 점검했습니다. 마크다운을 모르는 사람이 막히는 지점을 사용자 영향이 큰 순서로 정리했습니다. 이미 출시된 S1–S12와 블록 에디터 0–6단계, 지금 진행 중인 두 스펙(Notion 표·블록 패널, 그래프 직조·시각 규칙)은 다시 제안하지 않았습니다. 해당 작업과 겹칠 수 있는 항목은 본문에 따로 적었습니다.

## 범위와 방법

- 점검 대상은 `~/prj/karpathy-editor-build/app`, 브랜치 `feat/permit-editor-ux`, HEAD `d3f82ce`입니다. 저장소는 읽기만 했고, 감사가 끝난 뒤 `git status`가 깨끗한 것을 확인했습니다.
- 서버는 `npx vite --port 6300 --strictPort`로 띄웠습니다. 화면에만 찍었던 흐름 로그를 파일로 남기려고 한 번 더 띄웠고, 두 번 모두 끝난 뒤 종료했습니다. 마지막에 `lsof -i tcp:6300`에 아무것도 남지 않았고 `pgrep`으로도 프로세스가 없음을 확인했습니다.
- 브라우저 구동은 Playwright headless Chromium으로 했고, 주소는 `http://localhost:6300/?mock=1`입니다. 언어·테마·라우트는 `localStorage.myco-ui`에 넣어 바꿨습니다.
- 라우트 전체 순회(`sweep.mjs`)는 ko/en × light/dark × 1280×900/1024×700의 8조합에서 11개 화면(홈, 질문, 자료 추가, 정리 제안, 그래프, 할 일, 학습, 히스토리, 출처, 설정, 노트)을 찍었습니다. 88번 로드하는 동안 콘솔 오류와 page error는 0건이었습니다(`sweep.log`).
- 주요 흐름(`flow1.mjs`–`flow13.mjs`, `agent.mjs`, `dis.mjs`, `narrow.mjs`)은 ko-dark-1280을 기준으로 돌렸고, Ask·에디터·자료 추가·할 일·설정은 ko-light-1024, en-dark-1280, en-light-1280/1024에서 다시 확인했습니다. 첫 실행 마법사는 `list_files`를 빈 배열로 바꿔치기해서 띄웠습니다.
- 스크린샷 320장(라우트 순회 88장, 흐름 232장)은 아래 폴더에 있습니다. 본문에서는 이 폴더 기준 상대 경로로 적습니다.
  `<session-scratchpad>/ux-2026-10/audit-desktop/shots/`
- 소스 위치는 `app/src/` 기준 `파일:줄`로 적습니다. 다른 앱 비교는 이번에 직접 조회한 Mobbin 화면만 인용했습니다.

### mock의 한계

- 새로 만든 노트는 mock이 아무것도 쓰지 않아서 "myco / Sample note."로 읽힙니다. 없는 노트를 열어도 같은 내용이 나옵니다. 그래서 새 노트 본문 내용과 not-found 화면은 판단하지 않았습니다.
- 노트마다 보이는 "사람 62% · 에이전트 38%" 수치, 정리 제안 카드의 영어 제목, 자료 추가 계획의 영어 항목은 mock 데이터입니다. 이 문서에서는 문구 구조와 노출 방식만 문제 삼습니다.
- Ask는 mock 기본값이 CLI 응답이라서, 기존 스모크 테스트(`scripts/ask-ladder-smoke.mjs`)처럼 `__mycoMock.settings({query_provider:"builtin-local"})`로 추출형 경로를 켜고 봤습니다. mock 임베딩은 가짜이므로 한국어 질문이 기권한 결과(관련도 0.40)를 검색 품질 문제로 해석하지 않았습니다.
- `list_files`만 비운 상태라서 첫 실행 이후의 "빈 볼트" 화면은 다른 mock 데이터가 섞여 나옵니다. 빈 상태 판단은 마법사와 학습 화면만 했습니다.

## 순위 요약

| 순위 | 영향 | 영역 | 문제 | 대표 근거 |
|---|---|---|---|---|
| 1 | 높음 | 전체 | 일상 화면에 내부 용어와 진단 수치가 그대로 나옵니다 | `flow/21-ask-abstain-ko-dark-1280.png`, `sweep/graph-ko-light-1280.png`, `flow/91-ingest-run-0-ko-dark-1280.png` |
| 2 | 높음 | 사이드바·검색 | "내 노트"에 시스템 폴더와 기계가 만든 파일이 섞여 있고, 새 노트는 묻지 않고 `wiki/`에 들어갑니다 | `sweep/reader-ko-light-1280.png`, `flow/09-cmdk-atten-ko-dark.png` |
| 3 | 높음 | 노트 | 본문의 인용 각주가 `[^src-…]` 원문 그대로 보입니다 | `flow/51-reader-info-ko-dark-1280.png`, `lib/editorLive.ts:267` |
| 4 | 높음 | 노트 | 제목을 그 자리에서 고칠 수 없고, 한 노트의 이름이 세 가지로 나옵니다 | `flow/51-reader-info-ko-dark-1280.png`, `pages/PageReader.tsx:963` |
| 5 | 높음 | 공통 버튼 | 비활성 기본 버튼이 활성 버튼과 똑같이 보이고, 에이전트 탭은 고칠 길 없이 막혀 있습니다 | `flow/25-ask-agent-ko-dark-1280.png`, `styles.css:1075` |
| 6 | 높음 | 자동 정리 | 주제가 다른 개인 노트가 '격리'되고 기한이 지나면 휴지통 후보가 되는데, 알림은 숨은 탭에만 있습니다 | `flow/88-feedback-quarantine-ko-dark-1280.png` |
| 7 | 높음 | 화면 분할 | 분할 버튼이 기본으로 그래프를 열고, 그래프 캔버스가 수십 px로 찌그러집니다 | `flow/117-split-ko-dark-1280.png`, `components/Topbar.tsx:100` |
| 8 | 중간 | 정리 제안 | 내용을 펼치지 않고도 '승인'할 수 있고, 메뉴 이름과 페이지 제목이 다릅니다 | `flow/87b-feedback-expand-ko-dark-1280.png`, `pages/PageFeedback.tsx:252-283` |
| 9 | 중간 | 홈 | 숫자 배지 네 개가 서로 다른 뜻이고, 관리 도구를 열면 화면 전체가 두 칸으로 바뀝니다 | `flow/01-home-full-ko-dark.png`, `flow/13-manage-0-ko-dark.png` |
| 10 | 중간 | Ask | 답 하나가 화면 세 장 분량이고, 라이트 테마에서 답 안의 링크가 브라우저 기본 파랑입니다 | `flow/21b-ask-attention-full-ko-dark-1280.png`, `flow/21-ask-attention-ko-light-1024.png` |
| 11 | 중간 | 자료 추가 | 짧은 메모를 "내용이 없다"고 거절하고, 계획 검토 중에 타이머가 계속 흐릅니다 | `flow/94-ingest-short-ko-dark-1280.png`, `flow/92-ingest-later-ko-dark-1280.png` |
| 12 | 중간 | 첫 실행 | 마법사가 개발자용 가져오기를 앞세우고, '첫 자료 추가하기' 단계에는 추가할 방법이 없습니다 | `flow/120-onboard-s1-ko-dark-1280.png`, `flow/120-onboard-s3-ko-dark-1280.png` |
| 13 | 중간 | 할 일 | 출처 열이 1~2글자로 잘리고, "내일 오후 3시"를 날짜로 읽지 않으며, 세부 입력이 영어 문법입니다 | `sweep/tasks-ko-light-1280.png`, `flow/101-task-added-ko-dark-1280.png` |
| 14 | 중간 | 그래프 | '그래프에서 보기'가 노드 하나에 너무 붙고, 툴바가 아이콘 8개이며, 팁이 버튼을 가립니다 | `flow/65-open-in-graph-12000-ko-dark-1280.png`, `flow/74-graph-click-ko-dark-1280.png` |
| 15 | 중간 | 학습 | 키보드로 정답 보기·채점을 할 수 없고, 채점 버튼에 다음 복습 간격이 없습니다 | `flow/84-study-revealed-ko-dark-1280.png`, `pages/PageStudy.tsx:340-361` |
| 16 | 중간 | 설정 | 첫 탭이 AI 모델 select 묶음이고, 상태 글자가 버튼과 겹치며, 영어 하드코딩과 글자 크기 설정 부재가 있습니다 | `flow/112-settings-AI_연결-ko-dark-1280.png`, `pages/settings/Providers.tsx:411` |
| 17 | 중간 | 키보드 | 트리에 방향키 이동이 없고, 화면을 옮겨도 포커스가 사이드바에 남습니다 | `flow13-ko.log`, `flow/130-kbd-tree-focus-ko-light-1280.png` |
| 18 | 낮음 | 여러 곳 | 작은 불일치와 표기 문제 묶음(본문 참고) | 본문 |

## 높은 영향

### 내부 용어와 진단 수치의 노출

**보이는 것.** 일반 사용자가 매일 지나가는 화면에 검색 엔진과 파이프라인 내부 용어가 문장째 나옵니다. S10 용어 정리로 같은 개념의 이름은 하나로 맞췄지만, 개념 자체가 사용자에게 필요한지는 다루지 않았습니다.

- Ask 기권 카드: "색인된 51쪽 중 관련도 바닥선 0.42을 넘은 구절이 없습니다", "붉은 눈금이 바닥선 0.42입니다. “키워드만”은 코사인이 없는 어휘 전용 히트로…", "기권도 답입니다 — 기록된 공백은 다음 수확이 채울 수 있습니다", 버튼 "이 질문을 수확 대상으로". 근거는 `flow/21-ask-abstain-ko-dark-1280.png`, `lib/i18n.ts:5885-5900`입니다.
- Ask 입력창 예시가 "BPE는 무엇인가요? 미드트레이닝은 파인튜닝과 어떻게 다른가요?"입니다(`lib/i18n.ts:4584`). 일반 사용자의 노트와 관계없는 ML 용어입니다.
- 그래프 상단에 디버그 칩 "씬 재빌드 3회 · 242.2 ms"가 상시 보이고, 1024 다크에서는 "8732.9 ms"까지 찍혔습니다(`components/GraphQuestions.tsx:149`, `lib/i18n.ts:4614`, `sweep/graph-ko-dark-1024.png`). 같은 화면에 "첫 실행 샘플 51개(75%) · 내가 쓴 노트 10개 · 미해결 7개. 인용을 가진 노트는 53개."라는 통계 문단(`lib/i18n.ts:4616`)과 "갭"(`:4867`), "밝기 = 홉 거리"(`:4632`)가 있습니다.
- 자료 추가 상단 단계 표시가 "유입 · 판정 버림 0 · 기록 0 · 수확 0 · 계획 게이트 · 실행 유휴 · 백필 큐 2건 대기"입니다. 계획 검토 카드는 UPDATE / ADD / MERGE / NOOP 작업 코드를 그대로 쓰고 "NOOP 항목은 이미 위키에 반영되어…"라고 설명합니다(`flow/91-ingest-run-0-ko-dark-1280.png`, `lib/i18n.ts:4564-4567`, `:5728`).
- 사이드바 하단 경고가 "위키 6개가 인덱스 밖에 있습니다 — 질문에서 검색되지 않습니다. 지금 재인덱스"입니다(`lib/i18n.ts:5963`). 모든 화면의 모든 해상도에서 보입니다.
- 노트 머리에 "사람 62% · 에이전트 38% · 마지막 사람 손길 그저께"가 붙습니다(`pages/PageReader.tsx:954`, `lib/i18n.ts:6239`).
- ⌘K 입력창 안내가 `검색하거나 이동 — "정확히", path:, tag:, type:`이고 하단 키 안내에 "⌥↵ 놓친 검색 기록"이 있습니다(`lib/i18n.ts:5948`, `:5950`, `flow/08-cmdk-empty-ko-dark.png`).
- 정리 제안 설명문은 "자동 정리가 새 페이지를 위키의 온톨로지에 접어넣으며 작성한 제안입니다"입니다(`lib/i18n.ts:5606`).

**일반 사용자에게 문제인 이유.** 바닥선, 코사인, 게이트, 백필, 인덱스, 에이전트 같은 말은 사용자가 할 일을 알려 주지 않습니다. 특히 Ask 기권은 이 제품의 신뢰 장치인데, 지금 문구는 "앱이 고장 났다"처럼 읽힙니다.

**제안.** 모든 화면의 기본 문구를 "무슨 일이 있었고 다음에 무엇을 하면 되는지"를 말하는 한 문장으로 바꾸고, 수치와 내부 이름은 기존 "검색 세부정보" 같은 펼침 영역으로 옮기십시오. 예를 들어 기권은 "노트에서 이 질문에 맞는 내용을 찾지 못했어요"와 "새 노트로 적기 / 범위 넓혀 다시 찾기" 두 행동이면 충분합니다. 그래프 재빌드 칩은 개발 모드에서만 보이도록 `import.meta.env.DEV`로 감싸면 됩니다(사이드바 '고장 시뮬레이션'은 이미 그렇게 처리돼 있습니다, `components/StatusStrip.tsx:70-71`). 인덱스 경고는 자동 재인덱스가 돌고 있으면 숨기고, 실패했을 때만 보이는 편이 낫습니다.

### "내 노트"에 섞인 시스템 폴더와 기계 파일

**보이는 것.** 사이드바 "내 노트"는 볼트의 파일 트리를 그대로 보여 줍니다(`components/Sidebar.tsx:145-148`, `:189`). 사용자 노트 사이에 `CLAUDE`, `_inbox`, `audio`, `cards`, `daily`, `ingest-reports`, `raw`, `sessions`, `templates`, `wiki`, `work`가 같은 무게로 나열됩니다(`sweep/reader-ko-light-1280.png`, `flow/07-status-open-ko-dark.png`). ⌘K에서 "atten"을 치면 첫 결과가 `work/feedback`의 "2026-08-12-map-candidate-attention"이고, `ingest-reports`와 `cards`의 파일, 같은 이름의 "attention-mechanism"(wiki, cards) 두 개가 함께 나옵니다(`flow/09-cmdk-atten-ko-dark.png`). 새 노트는 폴더를 묻지 않고 `wiki/`에 만들어지고(`lib/newNote.ts:4`, `:29`), 브레드크럼에 "myco / wiki / 장보기 목록"으로 보입니다(`flow/31-newnote-open-ko-dark-1280.png`).

1024×700에서는 고정된 메뉴와 상태 영역 때문에 트리가 2~3줄만 보입니다(`sweep/overview-ko-dark-1024.png`, `sweep/settings-en-dark-1024.png`). 2026-09-26 감사(audit-chrome-home 1번)에서 지적했지만 백로그 S1–S12에 들어가지 않아 그대로 남아 있습니다.

**일반 사용자에게 문제인 이유.** 사용자는 자기가 쓴 것과 앱이 쓴 것을 구분하지 못하고, `raw`나 `sessions`를 열어 보거나 지우려 할 수 있습니다. 검색 결과도 기계 파일이 앞에 오면 원하는 노트를 찾기 어렵습니다.

**제안.** 트리를 "내 노트"(사용자가 만든 노트와 폴더)와 접힌 "myco가 관리하는 폴더"(raw, sessions, cards, ingest-reports, work, _inbox, templates, CLAUDE.md) 두 구역으로 나누십시오. 파일은 디스크에서 그대로 두고 표시만 바꾸면 되니 Obsidian 호환성은 유지됩니다. ⌘K는 같은 분류로 사용자 노트를 먼저 정렬하고, 같은 이름의 결과에는 폴더 대신 "학습 카드", "자료 추가 보고서" 같은 종류 이름을 붙이십시오. 새 노트의 기본 위치는 사용자에게 보이는 이름(예: "노트")으로 바꾸거나 지금 연 폴더를 따르게 하십시오.

### 원문 그대로 보이는 인용 각주

**보이는 것.** LLM이 쓴 위키 페이지는 문장마다 `[^src-attention-is-all-you-need]` 각주를 답니다. Live 편집기는 이 표식을 회색 칩으로 감싸기만 하고 라벨 원문을 그대로 보여 주며(`lib/editorLive.ts:267`의 `live-fnref`), 문서 끝 정의 줄 `[^src-attention-is-all-you-need]: [[source-attention-is-all-you-need]]`도 흐린 원문으로 남깁니다(`lib/editorLive.ts:178`). 한 문단에 칩이 여러 번 줄을 바꿔 가며 끼어듭니다(`flow/51-reader-info-ko-dark-1280.png`, `flow/140-narrow-reader-390.png`).

**진행 중 작업과의 관계.** `docs/specs/2026-10-01-notion-blocks-one-editor.md` 결정 2는 레지스트리 블록(TOC, 이미지, 표, 차트 등)과 플러그인 펜스만 다루고, 각주는 목록에 없습니다.

**제안.** 각주 참조를 위첨자 번호(1, 2, …)로 그리고, 마우스를 올리거나 포커스하면 출처 이름과 인용 줄을 보여 주십시오. 정의 줄은 본문 끝 "출처" 목록으로 묶어 그리면 됩니다. Microsoft Copilot은 답 아래 "References 31"에 번호 칩과 출처 제목을 나란히 둡니다(https://mobbin.com/screens/ae62408b-0082-4e4b-a874-4eb1058be971). 저장 형식은 지금 그대로 두고 표시만 바꾸는 작업이라서 결정 7(모든 쓰기는 평문 마크다운)과도 충돌하지 않습니다.

### 그 자리에서 고칠 수 없는 제목과 세 가지 이름

**보이는 것.** 노트 머리의 큰 제목은 `h1.page-title`이고 편집할 수 없습니다(`pages/PageReader.tsx:963`, 더블클릭 뒤 포커스가 BODY에 남음, `flow5-ko.log`). 이름을 바꾸려면 ··· 메뉴의 "이름 바꾸기…"를 찾아야 합니다(`flow/43-more-menu-ko-dark-1280.png`). LLM이 쓴 노트는 큰 제목이 파일 이름 `attention-mechanism`, 속성 `title`이 "Attention Mechanism", 본문 첫 줄 H1이 다시 "Attention Mechanism"이라서 한 화면에 이름이 세 번 나옵니다(`flow/51-reader-info-ko-dark-1280.png`). 오늘의 노트도 "2026-10-01"이 큰 제목과 본문 H1로 두 번 나옵니다(`flow/56-daily-ko-dark-1280.png`). 새 노트는 먼저 "노트 제목을 정해 주세요." 대화상자를 거쳐야 쓰기 시작할 수 있습니다(`lib/newNote.ts:52-58`, `flow/30-newnote-dialog-ko-dark-1280.png`).

**일반 사용자에게 문제인 이유.** 사용자는 제목을 클릭해서 고치는 데 익숙합니다. 이름이 세 개면 어느 것이 진짜인지, 무엇을 고쳐야 검색에 반영되는지 알 수 없습니다.

**제안.** 큰 제목을 편집 가능한 한 줄 입력으로 바꾸고, Enter나 포커스 이탈 때 파일 이름 변경으로 연결하십시오. 큰 제목은 속성 `title`이 있으면 그것을, 없으면 파일 이름을 보여 주고, 본문 첫 H1이 제목과 같으면 Live에서 숨기십시오. 새 노트는 대화상자 없이 "제목 없음" 노트를 만들고 커서를 제목에 두면 됩니다. Notion은 제목을 별도 창 없이 문서 첫 줄의 큰 글씨로 두고, 새 페이지 아래에 "Get started with" 칩(Ask AI, AI Meeting Notes, Database, Form, Templates)을 보여 주며(https://mobbin.com/screens/f13ba85e-b673-4583-a5a6-164a0b7228ab), 빈 줄에는 "Press 'space' for AI or '/' for commands"를 안내합니다(https://mobbin.com/screens/e7603296-81cf-4983-89c2-7bd849892786).

### 활성처럼 보이는 비활성 버튼과 막힌 에이전트 탭

**보이는 것.** `.btn-primary`(`styles.css:1075`)에는 `:disabled` 규칙이 없습니다. `.u-btn:disabled`(`styles/ui.css:58`)와 `.hq-btn.btn:disabled`(`styles.css:10147`)에만 있습니다. Ask의 "질문하기" 버튼은 입력이 비어 비활성일 때와 활성일 때 배경색, 불투명도, 커서가 모두 같습니다. 다크 rgb(167,139,250), 라이트 rgb(24,23,21), opacity 1, cursor pointer로 측정했습니다(`dis.log`). 에이전트 탭은 "에이전트 모드에는 Anthropic API 또는 OpenAI 호환 제공자가 필요합니다. 현재: anthropic-cli."라고만 쓰고, 입력과 "실행"을 비활성으로 두는데 "실행"은 활성 보라색과 구분되지 않습니다. 설정으로 가는 링크도 없습니다(`flow/25-ask-agent-ko-dark-1280.png`, `agent.log`의 "element is not enabled").

**일반 사용자에게 문제인 이유.** 눌리는 것처럼 보이는데 반응이 없으면 앱이 멈췄다고 생각합니다. 필요한 조건을 알려 주고도 갈 길을 주지 않으면 막다른 길입니다.

**제안.** `.btn:disabled, .btn-primary:disabled`에 `.u-btn:disabled`와 같은 흐린 처리와 `cursor: not-allowed`를 주십시오. 에이전트 탭은 조건이 안 맞으면 "AI 연결 열기" 버튼을 함께 보여 주거나, 조건이 맞을 때만 탭을 보이십시오. Mintlify 온보딩은 선택 전 Continue를 흐리게 두고 "Skip for now"를 따로 줍니다(https://mobbin.com/screens/3abddd12-6ef2-4abb-a075-4f4c6216d781).

### 숨은 탭에서만 알리는 개인 노트 격리

**보이는 것.** 정리 제안의 "격리 3" 탭에 사용자의 개인 노트(mortgage-rates-2026.md, sourdough-log.md)가 "주제 불일치: 유사도 0.31 · 기준 0.38 (가장 가까운 주제: transformers) · 12일 남음", "기한 만료 — 다음 실행에서 휴지통으로 옮겨질 수 있습니다"로 올라와 있습니다. 설명문은 "심사 게이트가 주제에서 벗어났다고 판단한 항목입니다"입니다(`flow/88-feedback-quarantine-ko-dark-1280.png`, `lib/i18n.ts:5626`). 이 사실은 사이드바 배지 3과 정리 제안 첫 탭 어디에도 따로 드러나지 않습니다(`sweep/feedback-ko-light-1280.png`). mock 설정에서는 자동 정리가 켜져 있었습니다(`flow/112-settings-자동_정리-ko-dark-1280.png`). 실제 기본값은 확인하지 못했습니다.

**일반 사용자에게 문제인 이유.** 일반 사용자의 볼트는 원래 주제가 섞여 있습니다. 은행 상담 메모나 빵 굽기 기록이 "주제에서 벗어났다"는 이유로 치워지고 기한 뒤 휴지통 후보가 되면 앱을 믿을 수 없게 됩니다.

**제안.** 사용자가 직접 쓴 노트는 격리 대상에서 빼거나, 격리 전에 "이 노트를 위키에서 빼 둘까요?"라고 묻는 편이 안전합니다. 격리 항목이 생기면 홈의 첫 화면에 한 줄로 알리고, 휴지통으로 옮기기 전에는 반드시 확인을 받으십시오. 이 항목은 정리 엔진의 동작에 관한 결정이 필요해서, 문구만 바꾸는 작업보다 앞서 소유자 확인이 필요합니다.

### 그래프 캔버스를 찌그러뜨리는 화면 분할

**보이는 것.** 상단 바의 분할 버튼은 현재 화면이 그래프가 아니면 오른쪽에 그래프를 엽니다(`components/Topbar.tsx:100`). 1280×900에서 오른쪽 칸에 갭·범례 레일이 그대로 들어가 캔버스가 약 30px로 줄고, "별자리를 정렬하는 중…"이 한 글자씩 세로로 찍힙니다(`flow/117-split-ko-dark-1280.png`). 1024×700에서는 반대로 레일이 20px 남짓으로 잘립니다(`flow/117-split-ko-light-1024.png`). 같은 화면에서 홈 입력창 안내문은 두 줄로 넘어가 잘립니다.

**제안.** 분할 칸 너비가 정해진 값보다 좁으면 그래프 레일을 기본으로 접고 캔버스만 보이게 하십시오. 분할 기본 화면은 그래프보다 "최근 노트"나 지금 노트의 연결 목록처럼 좁은 칸에서도 읽히는 화면이 낫습니다. 그래프 직조 스펙이 진행 중이지만 이 문제는 룩이 아니라 레이아웃 문제라서 겹치지 않습니다.

## 중간 영향

### 정리 제안: 미리보기 없는 승인과 다른 이름

정리 제안 카드는 제목, 종류("클러스터 수용", "일괄 보관", "토픽 맵 작성"), 생성일과 함께 "승인 / 무시"를 바로 보여 줍니다. 내용은 오른쪽 끝의 작은 화살표 버튼으로만 펼쳐지고, 제목을 눌러도 아무 일이 없습니다(`pages/PageFeedback.tsx:252-262`, `:276-283`, `flow/87b-feedback-expand-ko-dark-1280.png`). 사용자는 무엇을 승인하는지 모른 채 누르게 됩니다. 사이드바 메뉴 이름은 "정리 제안"인데 페이지 제목은 "수확함"입니다(`lib/i18n.ts:5595`, `:5604`). 영어도 "Review suggestions"와 "Harvest box"로 다릅니다(`sweep/feedback-en-dark-1280.png`).

제안: 카드 전체를 펼침 영역으로 만들고, 펼친 뒤에만 "승인"을 기본 버튼으로 보이십시오. 승인 결과("노트 2개를 보관함으로 옮깁니다")를 버튼 옆에 미리 적어 주면 더 좋습니다. 페이지 제목을 메뉴 이름에 맞추십시오.

### 홈: 뜻이 다른 숫자 배지와 레이아웃 전환

첫 화면에 숫자가 네 개 보입니다. 홈 옆 12는 "수확 후보 세션 12건"(툴팁에만 설명, `components/Sidebar.tsx:154`, `lib/i18n.ts:5952`), 정리 제안 3은 대기 제안, 더 보기 2는 학습 복습 카드, 화면 아래 "검토할 항목 15개"는 앞의 것을 합친 값으로 보입니다(`flow/01-home-full-ko-dark.png`). 홈의 12는 일반 사용자가 할 일이 아닌 개발 세션 수입니다.

"검토하고 정리하기"를 펼치면 페이지 전체가 두 칸으로 바뀌고, 맨 위 오른쪽에 "다녀오신 사이", "막힌 페이지 · scaling-laws 분쟁 표시된 페이지입니다 · 해소: active · superseded로 · 무시", "오늘의 재회" 레일이 나타납니다(`flow/02-home-manage-open-ko-dark.png`, `flow/13-manage-0-ko-dark.png`, `lib/i18n.ts:6199-6200`). 이어서 "배치 편집", "런 보기"(`:6179-6180`), 세션 수확 목록, "Reflect 실행"까지 한 페이지에 쌓입니다. 주간 막대 그래프의 요일 글자는 앱 언어가 아니라 브라우저 로캘을 따라 "F S S M T W T"로 나옵니다(`components/VaultPulse.tsx:259`의 `Intl.DateTimeFormat(undefined, …)`).

제안: 홈 배지는 "사용자가 오늘 할 일이 있는 것"(복습 카드, 확인이 필요한 제안)만 남기고, 수확 후보 세션은 자료 추가 화면 안으로 옮기십시오. 관리 도구는 같은 칸 안에서 펼치고 레이아웃을 바꾸지 마십시오. 요일은 `useUIStore`의 `lang`을 로캘로 넘기면 됩니다.

### Ask: 너무 긴 답과 라이트 테마 링크 색

"attention"을 물으면 답 하나가 1280 기준 높이 약 2,950px입니다. 큰 세리프로 원문 단락 5개를 통째로 싣고, 오른쪽에 출처 12개, 아래에 "참조된 소스 · 13"과 미니 그래프를 붙입니다. "검색 세부정보"도 위와 아래에 두 번 나옵니다(`flow/21b-ask-attention-full-ko-dark-1280.png`). 질문 입력창은 위에 고정이라 후속 질문이 아래에 쌓이고, 사용자는 앞 답을 지나 스크롤해야 합니다(`flow/23-ask-followup-ko-dark-1280.png`). 입력 아래에 "검색 범위 위키 / 세션 / 전체"가 먼저 놓이고 설명이 "위키는 노트·맵·다이제스트를, 세션은 대화 기록을 검색합니다 — 설정 › 시맨틱 검색에서 켜면…"입니다(`lib/i18n.ts:5842`).

라이트 테마에서 답 안의 위키 링크가 rgb(0,0,238), 곧 브라우저 기본 링크색으로 그려집니다. 픽셀을 측정해 확인했고(`flow/21-ask-attention-ko-light-1024.png`, `flow/21-ask-abstain-en-light-1280.png`), 다크에서는 보라색입니다. 답 단락은 `Viewer`로 그리는데(`pages/PageQuery.tsx:753`) 이 위치에는 링크 색 토큰이 적용되지 않는 것으로 보입니다. 원인 CSS는 찾지 않았습니다.

제안: 답은 가장 잘 맞는 구절 한두 개를 먼저 보이고 나머지는 "더 보기"로 접으십시오. 출처 목록도 상위 3개만 기본으로 펼치면 됩니다. 범위 선택은 "답변 옵션" 안으로 옮기고, 링크 색은 노트 화면과 같은 토큰을 쓰게 하십시오.

### 자료 추가: 사실과 다른 거절 문구와 대기 중 타이머

"짧은 메모"(13바이트)를 넣으면 토스트와 입력창 아래에 "내용이 없어 저장하지 않았습니다 · 13 B < 200 B"가 나옵니다(`flow/94-ingest-short-ko-dark-1280.png`, `lib/i18n.ts:5719`, 이유 문자열은 백엔드가 줌). 내용은 있었고 짧았을 뿐입니다. 영어에서는 "Kept the original only · 399 B — below the wikify floor"로 나옵니다(`flow/91-ingest-run-1-en-light-1024.png`). 짧은 메모는 새 노트나 오늘의 노트로 가야 하는데 그 길을 알려 주지 않습니다.

계획 검토 단계에서는 붙여 넣은 원문이 화면에서 사라지고, 사용자가 고를 차례인데도 경과 시간이 0:01에서 0:15로 계속 올라갑니다. 계획 제목 옆에는 로딩 아이콘이 붙어 있습니다(`flow/91-ingest-run-0-ko-dark-1280.png`, `flow/92-ingest-later-ko-dark-1280.png`). 버튼 "3개만 적용"과 "이 계획대로 전부"의 차이도 설명이 없습니다(`lib/i18n.ts:4564-4565`). 대기 상태의 "자료 정리하기" 버튼에도 반짝이 아이콘이 붙어 있어 로딩처럼 보입니다(`pages/PageIngest.tsx:503`, `sweep/ingest-ko-light-1280.png`).

"다른 곳에서 가져오기"를 펼치면 "세션 스윕", "MCP 도구", "_inbox 대기열", "세션 백필 · 모델 호출 ≈ 20회 (계획 10 + 작성 10)"가 나옵니다(`flow/93-ingest-more-full-ko-dark-1280.png`). 일반 사용자에게 필요한 웹 링크, PDF, 사진, 음성은 위쪽 드롭 영역 한 줄 설명에만 있습니다.

제안: 짧은 입력은 "짧은 메모는 노트로 바로 저장할 수 있어요"와 "오늘의 노트에 적기" 버튼으로 받으십시오. 계획 검토 중에는 타이머를 멈추고 "선택을 기다리는 중"으로만 표시하고, 원문은 접힌 상태로 남기십시오. Delphi의 "Add Knowledge"는 File, Quick Note, Q&A, URL, YouTube Video, Podcast Episode를 한 시트에 나란히 두고 "Drag and drop anything"을 아래에 적으며, 추가 뒤 "Added to your mind" 토스트를 띄웁니다(https://mobbin.com/screens/61a2b2c5-7b3f-4e44-bba1-042e8fd950cd). 개발자용 채널은 설정의 추가 설정으로 옮기는 편이 맞습니다.

### 첫 실행 마법사

- 1단계 제목은 "프로젝트 만들기 또는 열기"인데 본문은 "볼트"를 씁니다(`lib/i18n.ts:6087`, `flow/120-onboard-s0-ko-dark-1280.png`).
- 2단계 "쌓아둔 기록 가져오기"는 "Claude Code 세션 가져오기"를 보라색 기본 버튼으로, "Codex 세션 가져오기"를 그 옆에 둡니다(`lib/i18n.ts:6111`, `flow/120-onboard-s1-ko-dark-1280.png`). 일반 사용자는 이런 세션이 없습니다. 가져온 뒤에는 포커스가 BODY로 빠집니다(`flow12-ko.log` step 2).
- 3단계 제목은 "첫 자료 추가하기"이고 본문은 "파일을 드롭하거나 URL을 붙여넣거나 노트를 쓰세요"인데, 화면에는 진행 막대와 "인덱스는 이 기기에서만 만들어집니다"만 있고 추가할 곳이 없습니다(`components/OnboardingWizard.tsx:324-345`, `lib/i18n.ts:6093-6095`, `flow/120-onboard-s3-ko-dark-1280.png`). 코드의 기본 문구는 "Reading your notes"입니다. 2026-09-26 감사 O2에서 지적했지만 고쳐지지 않았습니다.
- 4단계 "변경 이력을 남길까요? 켜면 에이전트가 바꾼 것을 단어 단위로 보고 되돌릴 수 있습니다"(`lib/i18n.ts:6120`)는 git 이력 기능을 설명하는 문장입니다. "이력 켜기"를 누르면 포커스가 BODY로 빠집니다.
- 언어·테마를 고르는 단계도, 노트 쓰기와 질문하기를 한 번 해 보게 하는 단계도 없습니다.

제안: 마법사를 "폴더 고르기, 첫 노트 쓰기 또는 자료 넣기, 그 노트에 질문해 보기" 세 단계로 줄이고, 세션 가져오기와 변경 이력은 설정이나 홈의 안내 카드로 옮기십시오. 각 단계에 "2/3" 같은 글자 진행 표시를 넣으십시오. Mintlify는 "Step 2/4"와 "Skip for now"를 함께 둡니다(https://mobbin.com/screens/3abddd12-6ef2-4abb-a075-4f4c6216d781).

### 할 일

- 목록 오른쪽 출처 열이 "m…", "t..", "d."처럼 1~2글자로 잘려 쓸모가 없습니다(`pages/PageTasks.tsx:695-706`, `sweep/tasks-ko-light-1280.png`, `sweep/tasks-ko-light-1024.png`).
- "치과 예약 내일 오후 3시"를 넣으면 마감일 없이 추가되고, 목록 중간에 강조 없이 끼어듭니다(`flow/100-task-typing-ko-dark-1280.png`, `flow/101-task-added-ko-dark-1280.png`). 한국어 날짜 표현을 읽지 않습니다.
- "자세히"를 누르면 카테고리, 프로젝트, 추가할 위치, 시작, 작업 예정, 우선순위, 예상 시간, 반복 등 입력 9개가 열리고, 자리표시자가 "#dev", "[[project]]", "2d", "every week"입니다(`components/TaskComposer.tsx:176`, `:188`, `:267`, `:285`, `components/TaskDetail.tsx:255`, `:266`). 열린 상태가 보드·캘린더·로드맵 화면까지 따라와 캘린더를 아래로 밀어냅니다(`flow/105-calendar-ko-dark-1280.png`).
- 상단 "일정 페이지 갱신"(`lib/i18n.ts:4448`)은 무엇을 갱신하는지 알 수 없습니다.

제안: 출처 열은 노트 이름을 최소 너비로 보장하거나 줄 아래 작은 글씨로 옮기십시오. "오늘, 내일, 모레, 요일, 오후 3시" 정도의 한국어 날짜를 인식해 칩으로 미리 보여 주고, 추가한 줄은 잠깐 강조하십시오. 자리표시자는 "예: 2일", "예: 매주"처럼 ko 문자열로 바꾸고, 세부 입력은 보기 전환 때 닫으십시오.

### 그래프의 틀과 조작

- 노트에서 "그래프에서 보기"를 누르면 처음 2~6초는 "노트를 하나 고르세요"가 보이고, 그 뒤 카메라가 선택 노드에 너무 붙어 흰 구가 캔버스를 채우고 인스펙터가 나머지를 가립니다. 이웃은 보이지 않습니다(`flow/54-open-in-graph-ko-dark-1280.png`, `flow/65-open-in-graph-6000-ko-dark-1280.png`, `flow/65-open-in-graph-12000-ko-dark-1280.png`).
- 툴바는 이름 없는 아이콘 8개입니다. 이름은 툴팁으로만 확인할 수 있고 "타임랩스 재생", "타임랩스 녹화 (WebM)", "우주선 모드 (F)", 축소, 맞춤, 확대, "그래프 설정", "제스처 안내"입니다(`flow7-ko.log`, `lib/i18n.ts:4791-4792`).
- 노드를 누르면 "MYCO 팁" 말풍선이 인스펙터의 기본 버튼을 덮습니다. 갭 레일 행에 마우스를 올리면 "열기 / 링크 / 수확" 버튼이 노트 이름을 "2026-…"로 잘라 먹습니다(`flow/74-graph-click-ko-dark-1280.png`).
- 캔버스에는 `tabindex`와 `aria-label`이 없습니다(`flow7-ko.log`). 갭 레일은 행마다 Tab 정지점이 4개라서 키보드로는 캔버스 옆을 지나가기만 수십 번 눌러야 합니다(`flow13-ko.log`).
- "그래프 설정"의 룩 목록은 이름만으로 차이를 알기 어려운 선택지가 10개 넘게 이어집니다(`flow/70-graph-gear-ko-dark-1280.png`). 룩 자체는 진행 중인 직조 스펙의 범위라서 여기서는 개수 문제만 적습니다.

제안: "그래프에서 보기"는 선택 노드와 1단계 이웃이 모두 들어오는 거리로 맞추고, 그 동안 "노트를 하나 고르세요" 배너를 숨기십시오. 툴바는 확대·축소·맞춤만 남기고 나머지는 "더 보기" 메뉴로 옮기면 됩니다. 팁 말풍선은 인스펙터가 열려 있으면 띄우지 마십시오.

### 학습

PageStudy에는 키 처리기가 없습니다. 정답 보기 뒤 포커스가 BODY에 남고(`flow10-ko.log`), Space나 1~4 키로 넘길 수 없습니다(`flow9-ko.log`, `pages/PageStudy.tsx:340-361`). 채점 버튼 네 개(다시, 어려움, 좋음, 쉬움)에는 다음 복습까지의 간격이 없습니다(`flow/84-study-revealed-ko-dark-1280.png`). 카드 앞면이 질문이 아니라 "Attention Mechanism › Scaling" 같은 제목 경로입니다(`flow/81-study-reveal-ko-dark-1280.png`). 덱 목록의 "근거 없는 카드 3장"(`lib/i18n.ts:5384`)과 설명 "간격 반복 플래시카드"(`:5359`)도 설명이 필요한 말입니다. 덱 저장 실패는 `catch {}`로 삼키고 "다른 곳에서 드러난다"는 주석만 있습니다(`pages/PageStudy.tsx:300-304`). 실제로 드러나는지는 확인하지 못했습니다.

제안: 정답 보기 뒤 포커스를 "좋음"에 두고, Space와 1~4 키를 연결하십시오. 버튼 아래에 "10분", "1일", "4일" 같은 다음 간격을 작게 적으십시오. 저장 실패는 `notice.warn`으로 알리십시오.

### 설정

- 설정을 열면 "AI 설정" 탭이 먼저 선택되고, 첫 카드가 "Claude Code (CLI) / 직접 입력… / (default)" select 세 개와 "claude-sonnet-4-6" 텍스트 입력입니다(`sweep/settings-ko-light-1280.png`).
- "AI 연결" 탭에서 오른쪽 위 "켜짐/꺼짐" 글자가 "연결" 버튼과 겹쳐 잘립니다(`flow/112-settings-AI_연결-ko-dark-1280.png`). 같은 탭 하단 안내 "API keys are stored in your OS keychain…"는 영어로 하드코딩돼 있습니다(`pages/settings/Providers.tsx:411-412`).
- 설정 검색에서 "글꼴"은 0건입니다(`flow/113-settings-search-font-ko-dark-1280.png`). 글자 크기를 바꿀 방법이 없습니다. Telegram 설정은 첫 줄에 "Message Text Size" 슬라이더를 둡니다(https://mobbin.com/screens/3d6fd56f-3ff9-4308-9aee-129c574d6747).
- "플러그인" 탭은 `.myco/plugins/`, `main.js`, 샌드박스, CSP, `localhost:11434`를 설명하고, 검증 오류 "contributes.fences[0].renderer 값 "builtin:iframe"는 렌더러가 아닙니다…"를 그대로 보여 줍니다. 앱 안에서 플러그인을 찾거나 설치할 방법은 없습니다(`flow/112-settings-플러그인-ko-dark-1280.png`).
- "자동 정리" 탭의 숫자 입력 7개와 "격리 TTL (일)", "숙성 시간 (시간)" 같은 이름은 2026-09-26 감사 S9에서 지적한 그대로입니다(`flow/112-settings-자동_정리-ko-dark-1280.png`).

제안: 기본 탭을 "테마"나 "내 공간"으로 바꾸고, AI 모델은 "추천 설정 사용 / 직접 고르기" 두 선택으로 줄이십시오. 상태 글자는 스위치나 버튼 하나로 합치고, 영어 문자열은 i18n 키로 옮기십시오. 본문 글자 크기 설정을 테마 탭에 추가하십시오.

### 키보드 사용

- 사이드바 트리는 방향키로 움직이지 않고 모든 행이 Tab 정지점입니다(`flow13-ko.log` "after ArrowDown"가 같은 행). `wiki` 폴더를 펼치면 57개 행을 Tab으로 지나가야 합니다.
- ⌘K로 그래프에 가도 포커스가 사이드바에 남아서, 다음 Tab이 트리 행부터 시작합니다(`flow13-ko.log` "GRAPH TAB"). 본문으로 건너뛰는 링크가 없습니다.
- 홈에서는 입력창이 자동 포커스되어 첫 Tab이 칩으로 가고, 본문 버튼을 지나 BODY를 거쳐 사이드바로 돌아갑니다(`flow1-ko.log` "TAB").
- 좋은 점도 있습니다. ⌘N은 새 노트 대화상자를 열고 입력에 포커스를 두며, Esc가 원래 위치로 돌려줍니다(`flow13-ko.log`).

제안: 트리에 roving tabindex와 위·아래·좌·우 키를 넣고, 라우트가 바뀌면 본문 제목에 포커스를 옮기십시오.

## 낮은 영향

- 1024에서 "노트 정보"를 열면 사이드바가 접히는데, 닫아도 다시 펴지지 않습니다. 접기만 하는 코드입니다(`pages/PageReader.tsx:200-206`, `flow/42-note-info-ko-light-1024.png`).
- 슬래시 메뉴에 27개 항목이 있고 오른쪽에 영어 별칭(h1, bullet, todo…)이 함께 보입니다. "오늘의 과거"와 "과거의 오늘 쿼리", "기록 찾기", "쿼리"는 이름만으로 차이를 알기 어렵습니다(`flow/32-slash-ko-dark-1280.png`, `flow4-ko.log`).
- `[[` 자동완성의 행마다 "abc" 아이콘이 붙고, "노트 내용에서" 구역은 "transformer-architecture#Transformer Architecture 68%"처럼 제목 앵커와 백분율을 보여 줍니다. 첫 후보는 노트가 아니라 PDF입니다(`flow/36-wikilink-ko-dark-1280.png`).
- 히스토리의 실행 이름이 "digest-1755740000"(유닉스 시각)이고, 요약이 "→ 3 · + 2" 기호입니다. 버튼은 "WHY 리포트"인데 설명문은 "WHY 보고서"입니다(`sweep/history-ko-light-1280.png`, `lib/i18n.ts:6227`, `:4906`). 노트 정보의 출처 행은 날짜 값을 그대로 찍어서 mock에서 "chatgpt · 1700000000"이 보입니다(`components/SourcesPanel.tsx:91`). 실제 데이터에도 유닉스 시각이 들어가는지는 확인하지 못했습니다.
- 페이지 위 작은 머리글이 일정하지 않습니다. 그래프는 워크스페이스 메뉴에 있는데 머리글이 "더 보기"이고, 자료 추가는 "워크스페이스", 나머지는 페이지 이름을 반복합니다(`sweep/graph-ko-light-1280.png`, `sweep/ingest-ko-light-1280.png`).
- 홈에는 질문하는 입구가 셋(입력창, 예시 칩, "내 노트에 질문하기" 카드)이고, 새 노트와 자료 추가도 사이드바와 본문에 겹쳐 있습니다(`flow/01-home-full-ko-dark.png`).
- 사이드바 "기록상 사람만" 버튼에는 툴팁이나 설명이 없고, 눌러도 보이는 트리에 변화가 없었습니다(`components/Sidebar.tsx:418-425`, `flow/05-human-only-ko-dark.png`).
- 오늘의 노트는 빈 날에 날짜 H1만 있고, 무엇을 적으면 좋은지 안내가 없습니다(`flow/56-daily-ko-dark-1280.png`).

## 이번에 확인한 개선 사항

- 히스토리의 "이 실행 되돌리기"가 앱 안 확인창으로 바뀌었습니다(`flow/86-history-undo-ko-dark-1280.png`).
- ⌘K는 결과가 없을 때 "“어텐션” 노트 만들기"와 "위키에 질문: 어텐션"을 내놓고, 하단에 키 안내와 결과 수를 보여 줍니다(`flow/11-cmdk-ko-query-ko-dark.png`, `flow/09-cmdk-atten-ko-dark.png`).
- 그래프와 할 일이 워크스페이스 메뉴로 올라왔고, "최근 수정"이 처음부터 펼쳐져 있습니다(`sweep/overview-ko-light-1280.png`).
- 노트 ··· 메뉴에 즐겨찾기, 이름 바꾸기, 이동, 삭제가 생겼습니다(`flow/43-more-menu-ko-dark-1280.png`).
- 자료 추가 계획 검토가 1280에서 첫 화면 안에 들어오고, 거절 시 "내용 지우기 / 내용 더 붙여넣기"가 나옵니다(`flow/91-ingest-run-0-ko-dark-1280.png`, `flow/94-ingest-short-ko-dark-1280.png`).
- 토스트에 닫기 버튼이 있고(`flow/17-capture-ko-dark.png`), 설정 검색은 결과가 없을 때 "전체 설정 보기"를 줍니다(`flow/113-settings-search-font-ko-dark-1280.png`). 학습 빈 상태는 "페이지를 열고 “카드 만들기”를 선택해 덱을 생성하세요"로 다음 행동을 알려 줍니다(`flow12-ko.log`).
- 첫 실행 마법사가 열리면 포커스가 "다음"에 놓입니다(`flow12-ko.log` step 0).

## 모바일 판단에 쓸 관찰

데스크톱 감사 범위라서 짧게 적습니다. 390×844에서 노트 화면은 사이드바가 숨고 본문이 읽힙니다(`flow/140-narrow-reader-390.png`). 다만 지금 데스크톱 UI의 여러 기능이 마우스 hover, 우클릭, ⌘ 단축키에 기대고 있어 그대로 옮기기 어렵습니다.

- Ask 인용 강조는 "인용 번호에 마우스를 올리거나 포커스하면"으로만 동작합니다(`lib/i18n.ts:5868`).
- 블록 핸들은 줄에 마우스를 올려야 보입니다(`flow/40-block-hover-ko-dark-1280.png`).
- 트리 작업은 우클릭 메뉴에 있습니다(`flow/06-ctxmenu-ko-dark.png`).
- 도움말은 ⌘ 단축키 표가 대부분입니다(`flow/71-graph-help-ko-dark-1280.png`, `flow/115-help-home-ko-dark-1280.png`).
- 그래프 툴바는 32px 아이콘 8개입니다(`flow7-ko.log`).

모바일에서는 이 기능들의 터치 대안(길게 누르기 메뉴, 항상 보이는 블록 메뉴, 탭으로 여는 인용 미리보기)이 먼저 필요합니다.

## 산출물

- 스크립트: `lib.mjs`(공통 열기 도우미), `sweep.mjs`, `flow1.mjs`–`flow13.mjs`, `agent.mjs`, `dis.mjs`, `narrow.mjs`, `probe.mjs`
- 로그: `sweep.log`, `flow1-ko.log`–`flow5-ko.log`, `flow7-ko.log`, `flow9-ko.log`, `flow10-ko.log`, `flow12-ko.log`, `flow13-ko.log`, `dis.log`, `agent.log`, `flow3-ko-light-1024.log`, `flow4-ko-light-1024.log`, `flow4-en-dark.log`, `flow3-en-light.log`, `flow10-en-light-1024.log`, `flow11-ko-light-1024.log`, `vite.log`, `vite2.log`
- 스크린샷: `shots/sweep/`(88장), `shots/flow/`(232장)

모두 `<session-scratchpad>/ux-2026-10/audit-desktop/` 아래에 있습니다.
