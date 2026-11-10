# myco 사용성 점검 요약 (2026-10-01)

이번 라운드 보고서 7개(Mobbin 조사 4개, 데스크톱 감사, 폰·태블릿 폭 감사, 모바일 기술 타당성)를 한 장으로 합쳤습니다. 검토 의견을 반영해 코드와 Mobbin을 다시 확인했고, 보조 창 세 개(트레이, Spotlight, 노치)를 ko·en, light·dark로 새로 찍었습니다(`audit-desktop/shots/aux/`, `aux-windows.mjs`). 자세한 근거와 작업 단위는 `backlog.md`(블로커 B1, S13–S55)와 `mobile-strategy.md`에 있습니다. 스크린샷 경로는 `ux-2026-10/` 기준이고 코드 경로는 `app/` 기준입니다. 보고서에 없는 제 판단은 (추론)으로 표시했습니다.

## 먼저 정해야 할 블로커

자동 정리(distill)가 `raw/` 원문을 옮기고, 끝내 지울 수 있습니다. distill은 `_inbox/`, `raw/`, `sessions/`를 판정하고(`src-tauri/src/distill.rs:474-490`), 격리 판정이 나면 `raw/` 파일도 `_inbox/quarantine/`으로 옮깁니다(`:682-694`). 30일 뒤에는 `.myco/trash/`로, 다시 30일 뒤에는 `remove_dir_all`로 지웁니다(`:2741-2819`). 이미 반영된 원문은 `raw/archive/`로 옮깁니다(`:2680-2735`). 이것은 저장소 규칙 "`raw/` is immutable"(`../CLAUDE.md:20`)과 충돌합니다. 기본값은 켜짐, Standard 강도(실제로 옮김), 위키 50쪽 미만이면 게이트 꺼짐입니다(`:31-33`, `:73`, `:108`, `:550`). 소유자가 이것을 정해야 S25와 모바일 볼트 공유를 확정할 수 있습니다(`backlog.md` B1).

## 일반 사용자가 지금 막히는 곳

- **중요한 동작이 단축키와 마우스 뒤에 숨어 있습니다.** 홈의 "오늘의 노트에 적기"는 ⌘Enter로만 실행되고 버튼이 없습니다(`src/pages/PageOverview.tsx:362-366`). 읽기 보기가 없어진 뒤 일반 노트는 모두 Live로 열리고(`src/pages/PageReader.tsx:271-276`), 마우스로 노트 안 링크를 따라가는 길은 ⌘클릭 하나뿐입니다(`src/lib/editorLive.ts:748`, `:753`). 블록 메뉴는 마우스를 올려야 보이고(`src/lib/editorBlockHandle.ts:77-78`), 트리의 파일 작업은 우클릭에만 있습니다(`src/components/SidebarTree.tsx:58`, `:89`).
- **일상 화면에 내부 용어와 진단 숫자가 그대로 나옵니다.** 기권 카드의 "관련도 바닥선 0.42", 그래프의 "씬 재빌드 3회 · 242.2 ms", 자료 추가의 "백필 큐 2건 대기"와 UPDATE/ADD/MERGE/NOOP, 모든 화면 사이드바의 "지금 재인덱스" 경고가 그 예입니다(`audit-desktop/shots/flow/21-ask-abstain-ko-dark-1280.png`, `audit-desktop/shots/flow/91-ingest-run-0-ko-dark-1280.png`). Spotlight의 기권도 "이 질문에 답할 근거가 볼트에 없습니다."입니다(`audit-desktop/shots/aux/spotlight-offtopic-ko-dark.png`).
- **내가 쓴 노트와 앱이 만든 파일이 섞여 있습니다.** 트리에 `raw`, `sessions`, `cards`, `ingest-reports`, `work`가 내 노트와 같은 무게로 놓이고, ⌘K 첫 결과가 앱이 만든 파일입니다(`audit-desktop/shots/sweep/reader-ko-light-1280.png`, `audit-desktop/shots/flow/09-cmdk-atten-ko-dark.png`). 볼트 스키마는 `wiki/`를 LLM이 관리하는 곳으로 정했는데(`src-tauri/src/vault.rs:290`), 새 노트도 묻지 않고 `wiki/`에 들어갑니다(`src/lib/newNote.ts:4`). 그래서 폴더만으로는 둘을 가를 수 없고, 변경 이력(git)의 작성자 기록을 함께 써야 합니다(`src-tauri/src/commands.rs:2858-2864`).
- **노트 화면이 낯섭니다.** 인용 각주가 `[^src-attention-is-all-you-need]` 원문 그대로 보입니다(`src/lib/editorLive.ts:267`). 번호 각주는 읽기 보기가 그렸는데, 읽기 보기가 `raw/` 전용이 되면서 사라졌습니다(`docs/specs/2026-09-25-block-editor-roadmap.md:55-64`). 큰 제목은 `listedName` 때문에 파일 이름을 보여서(`src/lib/displayName.ts:40-45`) 한 노트의 이름이 세 번 나오고, 제목을 그 자리에서 고칠 수 없습니다(`src/pages/PageReader.tsx:963-964`).
- **앱을 믿기 어렵게 만드는 순간이 있습니다.** 사용자가 넣은 음성 메모(`source: voice`), 웹 클립(`source: clipper`), 원문이 묻지 않고 격리되고 기한 뒤 휴지통을 거쳐 지워질 수 있습니다(위 블로커). 격리 사실은 정리 제안의 격리 탭에만 있습니다(`audit-desktop/shots/flow/88-feedback-quarantine-ko-dark-1280.png`. 이 화면의 항목은 mock이 심은 가짜 데이터입니다, `src/lib/devMock.ts:775-801`). 편집기에서 쓴 `wiki/`와 `daily/` 노트는 distill이 보지 않으므로 이 경로로 격리되지 않습니다. 비활성 기본 버튼은 활성 버튼과 똑같이 보입니다(`src/styles.css:1075`, `audit-desktop/dis.log`).
- **질문의 답이 너무 깁니다.** 답 하나가 1280px 화면에서 약 2,950px, 375px 폰에서 5,199px(6.4화면)이고, 입력창은 맨 위에 남습니다(`audit-desktop/shots/flow/21b-ask-attention-full-ko-dark-1280.png`, `shots-ai-mobile/03-ask-answer-top.png`). 앱을 다시 켜면 질문 기록이 사라집니다(`src/stores/queryStore.ts:185-190`).
- **처음 쓰는 사람의 길이 비어 있습니다.** 첫 실행 마법사가 "Claude Code 세션 가져오기"를 기본 버튼으로 앞세우고, "첫 자료 추가하기" 단계에는 추가할 곳이 없습니다(`audit-desktop/shots/flow/120-onboard-s3-ko-dark-1280.png`). 홈의 "복습 시작"은 기한 카드 전체가 아니라 첫 덱만 엽니다(`src/components/MorningBand.tsx:192`, `:198-201`).
- **보조 창에도 같은 문제가 있습니다.** 노치 빠른 기록은 저장 뒤 경로 `daily/2026-08-25.md`만 보이고 여는 동작이 없으며, "⏎ 데일리 노트"라고 써서 다른 화면의 "오늘의 노트"와 낱말이 다릅니다(`audit-desktop/shots/aux/notch-f7-ko-dark.png`, `audit-desktop/shots/aux/notch-f6-ko-dark.png`).

## 가장 큰 기회 다섯 가지

1. **숨은 동작을 보이는 버튼으로 바꾸기.** 데스크톱에서는 홈 적기 버튼(S13)과 렌더된 링크를 그냥 클릭해 열기(S55, 소유자 결정)를 먼저 합니다. 폰에서는 터치 링크(S46), 행마다 보이는 ⋯ 버튼과 아래 시트(S49), 키보드 위 도구 막대(S51)가 같은 일을 합니다. 길게 누르기와 끌기는 보조 수단으로만 두고, VoiceOver 사용자도 같은 일을 버튼으로 할 수 있게 합니다. Notion iOS는 질문(Ask AI)과 작성(새 페이지)을 화면 바닥 버튼으로 보여 주고([e7689c02](https://mobbin.com/screens/e7689c02-0bc0-49f7-bc5c-71f516844d33)), Google Drive iOS는 파일 행마다 ⋯ 버튼을 둡니다([ec124a18](https://mobbin.com/screens/ec124a18-9daf-4974-a3b2-632a0ab703a9)).
2. **기본 문구를 "무슨 일이 있었고 다음에 무엇을 하면 되는지" 한 문장으로 쓰기.** 숫자와 내부 이름은 "자세히" 아래로 내립니다(S14, S30). 기권 카드의 주 버튼은 "이 질문을 오늘 노트에 적어 두기"가 되고, Spotlight도 같은 제목 문구를 씁니다. Bond는 기억에 없을 때 바로 저장을 제안합니다([4b5284ea](https://mobbin.com/screens/4b5284ea-7e34-4b49-bb4d-ac4736afb9fd)).
3. **내 노트를 앞에 두고, 사용자가 넣은 자료는 묻기 전에 치우지 않기.** 트리와 ⌘K에서 사람이 쓴 노트를 먼저 보이고 앱이 쓴 노트에는 표시를 답니다(S15). 자동 정리는 음성 메모, 클립, 원문을 격리하기 전에 묻고, 휴지통 이동은 확인을 받습니다(S25). Apple Notes와 Obsidian iOS는 개수가 붙은 몇 개의 입구만 보여 줍니다([6a0eb785](https://mobbin.com/screens/6a0eb785-daad-49db-be8d-b0866ebc7f5c), [4fb0ebc3](https://mobbin.com/screens/4fb0ebc3-a523-460a-af5d-713685a9b939)).
4. **"내 노트를 그대로 인용한다"는 약속을 눈에 보이게 하기.** 각주는 번호 칩으로(S31, 0단계 Live 결정을 뒤집는 소유자 결정), 답은 첫 구절 먼저(S32), 출처는 시트로(S33), 복습은 하나의 큐로(S34), 질문 기록은 남깁니다(S36). Copilot과 ChatGPT iOS는 출처를 번호와 시트로 보여 주고([ae62408b](https://mobbin.com/screens/ae62408b-0082-4e4b-a874-4eb1058be971), [3eaf4e44](https://mobbin.com/screens/3eaf4e44-fdce-48bc-965b-b194ed9c43ac)), Headway는 복습을 버튼 하나와 예/아니오로 끝냅니다([3d987534](https://mobbin.com/flows/3d987534-1fb1-4502-872e-49e765b79e85)).
5. **모바일 웹 작업은 폰 앱 결정 뒤에 하기.** 데스크톱 창은 `minWidth: 800`이라서(`src-tauri/tauri.conf.json:20`) 폰 폭 CSS는 출시 앱에서 쓰이지 않고, 터치 노트북 사용자 비율 데이터도 없습니다. 그래서 S46–S54는 폰 앱을 만들기로 하고 스파이크 SP-1~SP-3을 통과한 뒤에 합니다. 폭 규칙은 폰 셸 ≤768px, 769–1023px은 데스크톱 레이아웃에 터치 대상 키우기, ≥1024px은 데스크톱으로 하나로 맞췄습니다.

## 모바일은 이렇게 하기를 권합니다

- 폰에 데스크톱 앱을 통째로 옮기지 않습니다. 첫 버전은 **넣기, 읽기, 묻기**만 하는 iPhone·iPad 짝꿍 앱입니다. 자료 정리, 자동 정리, 그래프 작업, 에이전트, 플러그인은 계속 데스크톱이 맡습니다.
- 노트는 폰 안에 평범한 마크다운 파일로 있습니다. 데스크톱과는 iCloud Drive 폴더를 함께 쓰고, myco가 동기화 서버를 따로 만들지 않습니다. Obsidian iOS가 같은 방식입니다([1fe92af6](https://mobbin.com/screens/1fe92af6-d08b-4aa0-aa68-4a2ff0f41218)). 다만 Obsidian iOS는 `iCloud Drive/Obsidian` 폴더 안의 볼트만 열 수 있습니다(https://obsidian.md/help/sync-notes). 그래서 myco 전용 iCloud 컨테이너를 고르면 폰에서 노트를 고칠 길이 없고, Obsidian 폴더를 고르면 데스크톱 볼트도 그 폴더로 옮겨야 합니다.
- 질문은 폰 안에서 답합니다. 번들 임베딩 모델이 39.7MB이고 검색 코드가 순수 Rust라서(`src-tauri/src/intent.rs:1-15`, `src-tauri/tauri.conf.json:62`) 같은 노트에서 같은 인용과 같은 기권을 낼 수 있을 것으로 봅니다(추론). 노트를 서버로 보내지 않습니다.
- 폰은 첫 버전에서 새 파일만 만듭니다. 텍스트 메모는 `_inbox/capture/`에, 링크와 사진은 `_inbox/`에 들어가고, 기존 노트는 고치거나 지우지 않으며, `raw/`는 읽기만 합니다. 텍스트 메모를 하위 폴더에 두는 이유는 `_inbox/` 바로 아래에 두면 데스크톱 distill이 기존 주제와 동떨어진 개인 메모(200바이트 이상)를 격리할 수 있기 때문입니다. 데스크톱은 distill 제외 목록에 `capture`를 더하고 메모를 오늘 노트로 접습니다. 이것은 cargo test로 확인합니다.
- 볼트를 iCloud로 옮기는 데스크톱 흐름이 필요합니다. 지금 기본 볼트는 `~/Documents/myco`이고(`src-tauri/src/vault.rs:297-313`), 볼트 안의 `.git`(변경 이력)과 `.myco/`(distill 상태와 휴지통)도 같이 옮겨집니다. iCloud 안의 git 저장소는 손상 위험이 있어(추론) 저장소 본체는 Mac 로컬에 두는 안을 권합니다.
- 시작 전에 실제로 확인할 것이 있습니다. iOS 빌드(`trash`, `notify`를 포함한 데스크톱 전용 의존성 막기), llama.cpp 임베더의 iOS 빌드와 1k–2k쪽 색인의 시간과 순간 메모리(임베딩 한 번에 약 320 MiB, `src-tauri/src/embeddings.rs:15-24`), iCloud 폴더 읽기와 아직 내려받지 않은 파일 판별, distill을 돌린 뒤의 동기화와 인용 경로, 한국어 IME와 VoiceOver입니다.
- PWA는 권하지 않습니다. iOS Safari는 기기 폴더를 읽을 수 없어서 local-first가 깨집니다(mobile-feasibility 4절, caniuse). 데스크톱에 원격으로 붙는 방식은 데스크톱이 켜져 있어야 하고 새 네트워크 입구를 열어야 해서 첫 버전에서 뺐습니다.

## 소유자가 정해야 할 것

- distill이 `raw/` 파일을 옮기거나 지울 수 있게 둘지(B1, 권장: 보관 이동만 허용).
- 자동 정리가 사용자가 넣은 자료(음성 메모, 클립, 원문)를 묻지 않고 격리할 수 있게 둘지(S25).
- 데스크톱에서 렌더된 링크를 수정키 없이 클릭해 열지(S55), 각주를 Live에서 번호로 그려 0단계의 "text stays; no hiding" 결정을 뒤집을지(S31), 큰 제목과 목록을 `listedName` 대신 `displayName`으로 보일지(S16, S17), Ask와 Spotlight 답의 백분율을 "자세히" 아래로 옮길지(S14).
- 폰 첫 버전에서 기존 노트 편집과 복습 기록을 뺄지(권장: 뺍니다). iCloud 볼트를 myco 컨테이너로 할지, Obsidian 폴더를 고를 수 있게 할지와 함께 정해야 합니다.
- 변경 이력이 켜진 볼트를 iCloud로 옮길 때 `.git`을 어떻게 할지.
- myco Pro를 iOS에 낼지. App Store 3.1.1과 3.1.3(b)는 앱 안 결제를 요구하는데, 결제 코드를 공개 저장소 밖에 둔다는 지금 방침과 맞지 않습니다.
- 코드 플러그인을 모바일에서 허용할지(App Store 2.5.2).
