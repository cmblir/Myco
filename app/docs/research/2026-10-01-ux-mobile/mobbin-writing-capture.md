# Mobbin 조사: 모바일 쓰기·캡처 (Craft, Bear, Apple Notes, Evernote, Goodnotes) → myco

키: `writing-capture`. 2026-10-01. 대상 소스: `~/prj/karpathy-editor-build/app` (branch `feat/permit-editor-ux`, 읽기 전용).
이번 라운드의 초점은 일반 사용자 기준의 앱 전체 사용성과 모바일이다. 이전 라운드 보고서
(`docs/research/2026-09-26-ux/mobbin-craft-bear.md`)가 Craft web과 Bear iOS의 에디터·태그·설정·노트 목록을
다뤘으므로, 여기서는 그 화면을 다시 쓰지 않고 캡처 속도, 터치 툴바, 폰에서의 정리, 검색, 오프라인·동기화에 집중한다.

## 방법과 못 찾은 것

- Mobbin 검색 32회(screens 28, flows 4). 플랫폼은 iOS 위주이고 web은 2회. 반환된 이미지는 모두 직접 열어 보고 기록했다.
  아래 링크는 모두 이번 세션에서 실제로 받은 것이다.
- **Mobbin에 없음(검색했지만 0건이거나 다른 앱만 나옴)**: Day One(deep 2회, standard 1회 모두 0건), Drafts(다른 앱만 나옴),
  Notability(Otter·Fabric 등이 대신 나옴). Day One 자리에는 Apple Journal을 썼다.
- **iPad**: iOS 검색에서 iPad 화면은 한 장도 나오지 않았다. "three-column iPad" 질의에도 iPhone 화면만 나왔다(Notion, Obsidian, v0).
  그래서 iPad 레이아웃은 Mobbin 근거 없이 myco 스크린샷(768/1024)만으로 판단했다.
- **Android**: Mobbin 도구의 `platform`은 `ios` / `web`만 받는다. Android 화면은 조사하지 못했다.
- **홈 화면 위젯**: Bear·Craft·Apple Notes의 홈 화면/잠금 화면 위젯 캡처는 없었다. 위젯 근거로는 ChatGPT·Grok·Arc Search와
  Evernote 앱 안의 "위젯" 홈만 있다.

myco 스크린샷은 직접 찍었다. 스크래치 vite 서버(`cacheDir`를 스크래치로 돌린 설정, 포트 5201)에서 `?mock=1`을 열고,
Playwright로 `isMobile` / `hasTouch` 컨텍스트를 만들었다. 파일은 모두 `<session-scratchpad>/ux-2026-10/shots/` 아래에 있다.
목 볼트는 `wiki/`만 들어 있어서 `sessions/`·`raw/`·`_inbox` 동작은 보이지 않는다(메모리의 mock blind spot).

---

## 0. 지금의 myco: 모바일과 캡처 관점의 사실

**검증한 것 (코드/스크린샷)**

1. **배포 대상이 데스크톱뿐이다.** 번들 타깃은 `dmg`, `nsis` 두 개뿐이다(`src-tauri/tauri.conf.json:36-39`). 메인 창은
   `minWidth: 800`이다(`tauri.conf.json:20`). 그래서 `styles.css:7057-7180`의 `≤768px` 폰 규칙과 `App.tsx:517-535`의
   사이드바 자동 접기는 출시된 앱에서는 실행되지 않는다. 동작하는 곳은 브라우저 dev 모드뿐이다.
2. **모바일 진입점이 없다.** `src-tauri/src/lib.rs:114`의 `pub fn run()`에는 `mobile_entry_point`가 없다(grep 0건).
   global-shortcut 플러그인(`lib.rs:158`), tray와 spotlight init(`lib.rs:352`, `:358`)은 조건 없이 등록된다.
   `Cargo.toml:22`의 tauri features에는 `tray-icon`과 `macos-private-api`가 들어 있다. whisper는 `externalBin`
   사이드카다(`tauri.conf.json:64`). deep-link는 `desktop` 스킴만 선언했다(`tauri.conf.json:84-90`).
3. **오늘 있는 캡처 경로는 넷이고, 두 곳으로 나뉘어 들어간다.**
   - Home 입력칸: Enter를 누르면 질문, ⌘/Ctrl+Enter를 누르면 오늘의 노트에 한 줄을 적는다(`pages/PageOverview.tsx:300-301`, `:362-366`).
     입력은 한 줄로 접히고(`src-tauri/src/commands.rs:761-763`) 4 KiB를 넘으면 거절된다(`commands.rs:818`).
     성공하면 `notice.ok(t.home_captured)` = "오늘의 노트에 적었어요"가 뜨는데, 바로 열어 볼 액션은 없다(`PageOverview.tsx:334`).
     `notice`는 이미 `action`을 지원한다(`lib/notice.ts:1`, `components/NoticeStack.tsx:190-199`).
   - Spotlight(⌥Space, `spotlight.rs:26`)는 질문 전용이다. 같은 창의 음성(⌥M)은 whisper로 받아 적은 뒤
     `_inbox/voice-<날짜>.md`에 저장한다(`components/Spotlight.tsx:7-10`, `commands.rs:517-521`). 저장 후 칩에는
     "{rel} — 다음 자료 추가 때 함께 처리됩니다"(`lib/i18n.ts:6028`)처럼 경로만 보이고, 받아 적은 내용은 보이지 않는다(`Spotlight.tsx:421-427`).
   - 웹 클리퍼는 `url`, `title`, `selection` 세 값만 `myco://clip`으로 보내 `_inbox/`에 쓴다(`clipper/background.js:9-14`).
     사용자가 한마디를 덧붙이거나 저장 위치를 고르는 칸은 없다.
   - 자료 추가 페이지는 아직 처리되지 않은 `_inbox` 항목과 채널별 오늘 유입량을 보여 준다(`pages/PageIngest.tsx:90-130`).
4. **서식은 키보드 전용이고, 블록 핸들은 hover로만 나온다.** 서식 단축키는 `Mod-b/i/e/k`이다(`lib/editorFormat.ts:572-580`).
   블록 ⋮⋮ 핸들은 `pointermove`/`pointerleave`로만 나타난다(`lib/editorBlockHandle.ts:77-78`). 터치 컨텍스트에서
   `.cm-content`를 탭한 직후 핸들 상태는 `{"hidden":true,"w":0}`였다(Playwright 측정). 터치에서 쓸 수 있는 길은 슬래시 메뉴뿐이다.
   빈 줄의 placeholder "'/'를 입력해 블록 선택"이 그 길을 알려 준다(`shots/05-phone-375-note-editing.png`).
5. **⌘K 연산자 힌트는 툴팁에만 있다.** 검색 연산자(`path: tag: type: status: confidence:`) 안내는 input의 `title`
   속성에만 들어 있다(`components/CommandBar.tsx:491`, `lib/i18n.ts:3822`). hover가 없는 터치에서는 보이지 않고, 마우스 사용자도 대부분 못 본다.
6. **사이드바에 태그가 없다.** `components/Sidebar.tsx`에서 "tag"를 grep하면 0건이다. 이전 라운드 craft-bear #4에서 제안했지만
   backlog S1–S12에는 들어가지 않았다.
7. **동기화·저장 위치 상태가 보이지 않는다.** 노트별 저장 상태(saving/failed/pending/saved)는 있다(`pages/PageReader.tsx:904-911`).
   그런데 iCloud에서 아직 내려받지 않은 placeholder는 인덱스 빌드가 조용히 건너뛴다(`src-tauri/src/index.rs:88-95` 주석).
   사용자는 어느 파일이 빠졌는지 알 수 없다. git 기록은 opt-in 배너로만 안내된다(`components/VaultHistoryBanner.tsx:1-3`).

**375px 터치 스크린샷에서 본 것** (`isMobile`, `hasTouch`)

- `shots/01-phone-375-first.png`: 상단바가 넘친다. `.topbar`의 scrollWidth/clientWidth = 591/375(측정)라서 모델·상태 칩이 화면 밖에 있다.
  Home 입력칸 placeholder "노트에 물어보거나, 떠오른 생각을 적어 보세요"는 두 줄째가 잘린다. 안내 문구 "Enter 질문하기 · ⌘Enter 오늘의 노트에 적기"는
  폰 키보드로는 실행할 수 없는 조합을 알려 준다. 터치에서도 `⌘K` kbd 칩이 그대로 보인다.
- `shots/03-phone-375-sidebar.png`: 서랍 높이의 위쪽 절반 이상을 워크스페이스 6행과 "더 보기"가 차지한다.
  아래쪽은 설정, 볼트 상태, 인덱스 경고 카드가 차지한다. 그 사이에 노트 목록은 "최근 수정 5" 한 줄 남짓만 보인다.
- `shots/04-phone-375-note.png`, `shots/05-phone-375-note-editing.png`: 노트 머리(종류 칩 · 저장됨 · 작성 비율 바 · 제목 · 노트 정보/그래프에서 보기/⋯)가
  첫 화면 높이의 약 40%를 차지한다. 탭하고 나서도 서식 도구는 보이지 않는다.
- `shots/08-phone-375-ingest.png`: 자료 추가의 헤드라인이 "여기에 파일 드롭"이다. 폰에는 드롭 제스처가 없다.
  제출 버튼은 첫 화면 아래로 밀려 있다.
- `shots/09-phone-375-ask.png`: 질문 화면은 폰에서도 무리 없이 읽힌다(입력, 주 버튼, 범위 세그먼트). 다만 우하단의 "?" 버튼이 예시 행의 화살표를 가린다.
- `shots/06-ipad-portrait-768-note.png`: 768에서는 사이드바가 오버레이로 바뀌고 본문이 화면 전체를 쓴다. Live 본문에 각주 원문
  `[^src-attention-is-all-you-need]`와 정의 줄이 그대로 노출된다.
- `shots/06-ipad-landscape-1024-note.png`: 1024에서는 사이드바가 고정되고 본문 폭도 적당해서 iPad 가로에서 그대로 쓸 수 있는 형태다.

---

## 1. Mobbin에서 본 패턴

### A. 캡처 속도

**A1. Craft iOS: "+" 하나로 여는 떠 있는 캡처 카드** (iOS)
- 무엇: Home의 "+"를 누르면 키보드 위에 카드가 뜬다. 안내문은 "What's on your mind?"이고 버튼은 "Create →"다. 카드 아래 아이콘
  세 개(문서 / 할 일 / 오늘의 노트)로 모드를 바꾼다. 모드에 따라 목적지 칩이 바뀐다(문서 = "Unsorted ▾", 할 일 = "Inbox ▾").
  보내면 우상단에 결과 토스트가 뜬다. 오늘의 노트 모드는 "Added to Today — Tap to open", 할 일 모드는 "Task Created — Open Inbox to view"다.
  Calendar 탭의 Today 카드에서 방금 적은 줄을 확인할 수 있다.
- 왜 통하는가: 어디에 넣을지 고르기 전에 쓰기부터 할 수 있다. 목적지가 늘 보이고, 끝나면 어디로 갔는지와 거기로 가는 방법을 한 문장으로 알려 준다.
- 근거: [quick note flow](https://mobbin.com/flows/1d332ade-dd11-4571-9300-00d060523a5f), [task flow](https://mobbin.com/flows/5820e512-2b24-466a-b355-4e0c0c0b7d99),
  [daily note flow](https://mobbin.com/flows/f8b2e29f-3769-4e46-a694-0c70942ef8a3), [Inbox 칩 화면](https://mobbin.com/screens/60b123cd-6636-4286-8f12-2958e6dc0f13),
  ["Added to Today" 토스트](https://mobbin.com/screens/2a6e4efc-8dde-4efa-ba2c-eb27267ee582).
- 데스크톱에서 같은 생각: Craft web의 할 일 캡처 카드는 상단에 목적지 문서 칩("Travel itinerary ▾"), 날짜 선택(Today / 달력 / Remind Me / Repeat), [Create]를 둔다
  ([화면](https://mobbin.com/screens/2b46f2cb-a958-44bb-9241-7da84d641cc8)). Evernote web은 템플릿에서 새 노트를 만들 때 "Place new note in…" 모달에
  위치 검색칸, New Space / New Notebook, 노트북 목록을 보여 준다([화면](https://mobbin.com/screens/78342f98-a7a1-4d22-9bf5-a9d30aa3f742)).

**A2. Craft iOS: "+" 길게 보기 메뉴** (iOS)
- 무엇: New Document / New Quick Note / Reminder / New Folder / Templates / Import / Less 순서의 세로 목록이다.
  자주 쓰는 캡처가 위에 있고 정리용 항목은 아래에 있다.
- 근거: [creating a document flow](https://mobbin.com/flows/77670082-f25e-4bc4-904e-c213264fb747).

**A3. Evernote iOS: 첫 화면이 곧 입력이다** (iOS)
- 무엇: "My Evernote"와 날짜 아래에 검색칸("Find any note, task or document")이 있다. 그 아래 큰 타일 두 개("+ New note" / "+ New task")와
  작은 캡처 타일 줄(Event / Notebook / Audio / Camera, 다른 배치에서는 Camera / Scan / Files / Sketch)이 있다.
  노란 **Scratch Pad**는 홈에서 바로 쓰는 메모장이다. ⋯ 메뉴에 Convert to note / Clear scratch pad / Edit widget이 있다.
  쓸 때 키보드 위에 "Scratch Pad ↺ →" 줄이 붙는다. **Recently Captured**는 Web Clips / Images / Documents / Audio 탭으로 나뉜다.
  비어 있으면 "Save useful information from the web." 문구와 [Clip web content] 버튼이 나온다. 홈의 구성 요소는 사용자가 추가·삭제·정렬할 수 있다.
- 왜 통하는가: '노트가 될지 아직 모르는' 메모를 받아 둘 곳이 따로 있다. 나중에 한 번 탭으로 노트로 승격할 수 있다.
  최근 캡처를 종류별로 다시 볼 수 있어서 "어디 갔지?"가 줄어든다.
- 근거: [홈](https://mobbin.com/screens/e1b81139-13cf-465a-8dee-cc29ce6a33c1), [Scratch Pad 메뉴](https://mobbin.com/screens/44a9ceb2-ca06-4457-a0e0-2de73288c96e),
  [Scratch Pad 입력](https://mobbin.com/screens/bc6f25aa-11c7-41fd-b62e-4d3e1ee6da81), [Recently Captured 빈 상태](https://mobbin.com/screens/8c0cc28d-5c37-40f6-adda-e1bbb49220a7),
  [홈 커스터마이즈](https://mobbin.com/screens/a2fd7b7e-0e37-409a-a6eb-a62a6c076001), ["Complete your setup" 카드](https://mobbin.com/screens/2e3f4be4-470e-4c5f-a9f1-2e086ddc574e).

**A4. Evernote iOS: 할 일 빠른 추가 시트** (iOS)
- 무엇: 목록 선택 "Things to do ▾"와 "Enter task" 입력칸이 있고, 칩으로 Due today / Due tomorrow / Repeat를 고른다.
- 근거: [화면](https://mobbin.com/screens/ecec3dd6-7f30-4a30-87da-2ca3b2c848ae).

**A5. Evernote iOS: 스캔 모드 선택** (iOS)
- 무엇: 카메라 화면 아래 시트에서 Photo / Document (Color) / Document (Black and white) / Post-it® note / Business Card 중 하나를 고른다.
- 근거: [화면](https://mobbin.com/screens/7d0377ab-3e1f-4c29-8084-936f4f33dab1).

**A6. 홈 화면 위젯** (iOS, 노트 앱 외)
- 무엇: ChatGPT 위젯은 "Ask anything" 칸과 카메라 / 사진 / 마이크 / 음성 모드 버튼을 둔다. Grok 위젯은 작성 + 음성 버튼이다.
  Arc Search는 "Bring Arc to your home screen" 시트에 [Add Widget] / Maybe Later를 둔다.
  Truecaller는 Home screen | Lock screen 탭에 번호 매긴 설치 단계를 보여 준다.
- 왜 통하는가: 앱을 열지 않고 질문이나 음성으로 바로 들어간다. 위젯 설치는 사용자가 혼자 찾기 어려우니 앱이 단계를 가르친다.
- 근거: [ChatGPT](https://mobbin.com/screens/adc5c939-62b8-4a9b-9b9b-4e6cdc27c276), [Grok](https://mobbin.com/screens/bc2d81cc-0842-45e7-b2eb-3f82e7b807f9),
  [Arc Search](https://mobbin.com/screens/9ca4c1a8-8a2e-47a0-a765-b988b0c632ff), [Truecaller](https://mobbin.com/screens/3515c637-eb2f-450a-9012-3e23b69850f2).

**A7. 공유 시트·공유 확장** (iOS)
- Fabric: "Link" 시트가 열리면 URL 칸에서 스피너가 돌며 페이지를 가져온다. 아래에 선택 입력칸 "Say something about it… (optional)"이 있고,
  목적지 칩 "/ Spaces / Inbox"와 [Save]가 있다. 링크와 함께 *왜 저장했는지*를 한 줄 남길 수 있다.
  [화면](https://mobbin.com/screens/dfbd43eb-2e0d-482c-8924-72e57d939a9f).
- iOS 시스템 공유 시트의 "Add to New Quick Note": [Universe](https://mobbin.com/screens/53ea0255-9d7c-4b4a-855e-01938ff2903a), [NYT Cooking](https://mobbin.com/screens/100dbaba-c0e5-46f5-9cea-da7d202f1689).
- Apple Notes 첫 실행: "Welcome to Notes" 화면에 "Create Quick Notes Anywhere — Create new Quick Notes in any app from the Share menu."가 있다.
  첫 화면에서부터 공유 메뉴가 캡처 입구라고 가르친다. 이 화면은 Apple Notes 플로우 결과에서 봤다:
  [Notes](https://mobbin.com/flows/a5429bad-b542-4f21-afd8-630b5efc918b), [Creating a note](https://mobbin.com/flows/243b2ee1-b668-4d16-a4af-70fabe323188).
- 공유 확장 설치 안내: Cosmos는 설정 → Setup extension → "Tap Edit · Add Cosmos · Click Done" 오버레이 → "You're all set — You can now save from any app, even your camera roll." 순서로 안내한다
  ([flow](https://mobbin.com/flows/a8ecbff2-5d9c-45a9-9c1d-d33041bfb16b)). corner는 공유 시트 즐겨찾기에 앱을 켜는 법을 실제 시트 모양으로 보여 준다
  ([flow](https://mobbin.com/flows/39ef667a-d234-42a1-88d7-1f0ac8a602a7)).
- Craft iOS 내보내기: Share & Export에 Export As | Transfer 탭이 있고 PDF / Print / MS Word / Image / **Markdown** / E-mail / Copy Deeplink / Copy Markdown Deeplink / Copy Link 항목이 있다
  ([flow](https://mobbin.com/flows/f653790e-dc08-4b13-9340-949a61cd44f4)).

**A8. 음성 캡처** (iOS)
- Fabric: "+" 메뉴(Note / Voice note / Upload / Camera / Link / Create new space)에서 Voice note를 고른다. 녹음하는 동안 화면 아래에서
  **받아 적은 텍스트가 실시간으로 올라온다**. 타이머와 [Stop]이 있다. 멈추면 My notes / Transcript / Summary 탭과 [Resume]이 나온다.
  홈의 Recent items 카드에는 음성 항목에 마이크 아이콘이 붙는다.
  [flow](https://mobbin.com/flows/3c069b65-da04-47ec-a852-5165ac63562b). 저장된 음성 노트는 플레이어, 타임스탬프 달린 Transcript, 하단 Comments / Similar / Ask / Info로 구성된다
  ([화면](https://mobbin.com/screens/0811382a-64f3-4e02-a022-66189be04c50)).
- Otter: 화자 번호와 타임스탬프가 붙은 문단, 스크러버, 재생, ± 건너뛰기([화면](https://mobbin.com/screens/26c472e8-30e4-4b2f-a413-c5e19adfe550)).
- Mesh: 메모 시트의 액세서리 줄에 마이크 · @ · 알람이 있고, 받아 적은 문장이 바로 입력칸에 들어간다([flow](https://mobbin.com/flows/7283a746-bed9-43d7-8279-fa1972179406)).
- Apple Journal(Day One 대체): 항목 편집 화면 하단에 제안 / 사진 / 카메라 / 오디오 / 위치 등의 아이콘 줄이 있고, 상단에 되돌리기 · Aa · 마크업 · ⋯ · ✓ 완료가 있다
  ([화면](https://mobbin.com/screens/68cf68b2-f4b1-4c4f-bcc6-9b2e3bc31d7a)).
- 왜 통하는가: 녹음 중에 텍스트가 보이면 "제대로 듣고 있나"를 바로 확인할 수 있다. 끝난 뒤에는 원문(Transcript)과 요약을 나란히 볼 수 있다.

### B. 터치 에디터: 툴바와 서식

**B1. Craft iOS: 맥락에 따라 바뀌는 액세서리 줄과 두 장의 시트**
- 커서만 있을 때: 블록 스타일, Aa, 표 추가, f(x), ⋮, →, 복사, 키보드 내리기([화면](https://mobbin.com/screens/6d762433-bb52-4ff6-adc4-07d8a2e90b15)).
  텍스트를 선택하면 형광펜 / **B** / I / S / `</>` / 링크로 바뀐다([화면](https://mobbin.com/screens/ad1e22cb-acdb-4e3a-b02e-b9a635c113cb)). 표 셀에서는 I S `</>` 링크 √x @가 나온다([화면](https://mobbin.com/screens/f7227a15-25f0-4130-bd75-3ec2c05a229c)).
- 블록 시트: Heading / Body / Page / More… · 체크박스 / 토글 / 글머리 / 번호 / 내어쓰기 · Focus / Block · 색([화면](https://mobbin.com/screens/bb82e030-2d9a-401f-adcf-246aa9bf8fb9)).
  서식 시트: B I S `</>` 정렬 4종, 글꼴 System / Serif / Mono / Round, Copy Format / Paste Format([화면](https://mobbin.com/screens/8d70cdbf-ff7a-48ba-9344-aacaa73968d1)).
  편집 중에는 우상단에 파란 ✓(완료)가 떠 있다.

**B2. Apple Notes: 키보드가 있을 때와 없을 때 같은 자리에 같은 도구**
- 키보드 위: Aa / 체크리스트 / 표 / 첨부 / 마크업([화면](https://mobbin.com/screens/15f4ed2f-c402-441e-a74a-f282c93fd510)). 선택하면 B I U S 형광펜 링크 목록으로 바뀐다.
  키보드를 내리면 같은 도구가 화면 하단의 떠 있는 바(체크리스트 / 첨부 / 마크업 + 새 메모)로 옮겨 간다([Creating a note flow](https://mobbin.com/flows/243b2ee1-b668-4d16-a4af-70fabe323188)).
- Format 시트: Title / Heading / Subheading / Body / Monostyled · B I U S · 형광펜 · 색 · 목록 3종 · 들여쓰기 · 인용([화면](https://mobbin.com/screens/d7944bc3-b7b8-45c6-ac43-10becff9c093)).
  표 행의 ⋯ 메뉴는 Delete Row / Add Row / Paste다([화면](https://mobbin.com/screens/8a0f7c91-f68c-417d-aadc-e8462a8424e9)).
- 처음 체크리스트 항목을 체크하는 순간 "Enable Automatic Sorting? … 체크한 항목을 목록 아래로 옮길까요?" 시트가 뜬다. 설정을 기능을 쓰는 순간에 묻는다
  ([flow](https://mobbin.com/flows/b62f531d-a1fa-4240-b654-cf7e6c7786b4)).

**B3. Bear iOS: 서식 패널이 키보드 자리를 대신한다**
- 압축된 줄은 되돌리기 / 다시 / # / 키보드 / ⋮ / **BIU**이고([화면](https://mobbin.com/screens/0610fb16-f031-45bf-acd0-30fb63a53a15)), BIU를 누르면 키보드 자리에 전체 패널이 열린다. ABC를 누르면 키보드로 돌아온다
  ([화면](https://mobbin.com/screens/59fa6333-106b-4839-81da-79a938280de4)). 커서가 표 안에 있으면 패널이 행·열 추가·삭제와 화살표로 바뀐다([화면](https://mobbin.com/screens/d79084b0-8566-4a14-bd02-dcf1e04f0f05)).
  목록 버튼을 길게 누르면 목록 종류 팝오버가 나온다([화면](https://mobbin.com/screens/83297cd1-0750-49e6-b889-b3501235733a)).

**B4. Evernote iOS: 객체 탭과 빈 노트의 템플릿 칩**
- 툴바는 (+)삽입 / 카메라 / 체크 / AI / Aa / B I U 순서다. 커서가 링크·표·이미지에 있으면 툴바 위에 "Text | Link", "Text | Table", "Text | Image" 탭이 생긴다
  ([Link](https://mobbin.com/screens/1a6858dc-e54b-493c-b981-988885fc5579), [Table](https://mobbin.com/screens/53a99577-f253-4503-9f6d-693867ebb7e2), [Image](https://mobbin.com/screens/cbe0cce2-4a71-41e9-9266-da4210010865)).
  첨부 이미지에는 "Snapshot.png 758 kB · Transcribing ⟳" 처리 상태가 붙는다(같은 Image 화면).
- 새 빈 노트에는 노트북 위치 "First Notebook", "Title", "Start writing"이 보이고, 툴바 위에 템플릿 칩 "Daily Reflection / Reading List / ··· More"가 있다
  ([화면](https://mobbin.com/screens/9056e48b-833b-4627-a072-aa6cf6420aab)).
- AI가 노트를 다듬으면 상단 배너 "Edited with AI Note Cleanup Beta. You can revert changes with Undo. [Send feedback] ×"가 뜬다([화면](https://mobbin.com/screens/49a6a046-e3e5-4073-aa42-cb5ea5852af0)).

**B5. Obsidian iOS: 마크다운 볼트 앱에서 가장 가까운 예**
- 한 줄짜리 가로 스크롤 툴바다. 첫 화면은 되돌리기 / 다시 / `[[ ]]` / 파일 / 태그 / 첨부 / H / B…이고, 넘기면 인용 / 링크 / 글머리 / 번호 / 체크 / 들여·내어쓰기 / 🔧(툴바 편집)이 나온다
  ([화면](https://mobbin.com/screens/2092380b-d5a6-48c2-910a-671dd80ed973), [화면](https://mobbin.com/screens/6160c8c8-09f8-40b9-9f4a-696f04070e07)).
  선택하면 B I S 형광펜 `</>` 인용 링크 목록으로 바뀐다([화면](https://mobbin.com/screens/1c499b24-8d6b-4b13-8e7b-3bd58693ba21)).
  `[[` 팝오버는 노트 이름 아래 폴더 "Itinerary/"를 보여 준다([화면](https://mobbin.com/screens/99d28878-15e3-4630-9add-02990ad1626f)). 상단에는 사이드바 / 읽기 모드 / ⋯만 있다.
- 왜 통하는가(B 전체): 폰에는 단축키가 없다. 지금 맥락에 맞는 4–8개만 키보드 위에 두고, 나머지는 시트나 다음 페이지로 보낸다.
  마크다운 문법을 몰라도 `[[`, `#`, 체크를 버튼 하나로 넣을 수 있다.

### C. 폰에서의 정리 (폴더·태그)

**C1. Apple Notes: 폴더 화면이 곧 내비게이션**
- 큰 제목 "Folders" 아래에 접을 수 있는 iCloud 섹션이 있다. All iCloud 3 · Notes 2 · Stories(⚙ = 스마트 폴더) 0 · TBC 1 · Recently Deleted 1처럼 개수가 붙고,
  그 아래 **Tags** 칩 줄(All Tags, #Stories)이 있다. 화면 하단에는 떠 있는 검색칸과 새 메모 버튼이 항상 있다([화면](https://mobbin.com/screens/6a0eb785-daad-49db-be8d-b0866ebc7f5c)).
- 편집 모드에서는 순서 핸들과 행별 ⋯가 나온다([화면](https://mobbin.com/screens/916cdceb-da25-41ab-885e-c5518d1723f2)). 폴더 메뉴는 Share / Add Folder / Move / Rename / Group By Date / Delete / **Convert to Smart Folder**다
  ([화면](https://mobbin.com/screens/8ce20c03-8f02-4bd3-b49e-79807e48e1a4)). 스마트 폴더 필터는 "Include notes matching all filters" 아래 Tags / Created / Edited / Shared / Mentions / Checklists / Attachments / Folders / Quick Notes / Pinned / Locked다
  ([화면](https://mobbin.com/screens/0bdc22b6-54e9-4c5e-ab64-c4ea7e06f200)). 태그 화면은 "Show notes with tags."와 노트를 날짜로 묶어 보여 준다([화면](https://mobbin.com/screens/90153db2-233f-4a25-b00d-47974df5f886)).
- 노트 목록은 Today / Previous 7 Days로 묶이고 각 행에 시간·첫 줄·폴더가 나온다. 빈 목록은 "No Notes" 한 줄이고 하단 검색 + 새 메모는 그대로 있다([Creating a note flow](https://mobbin.com/flows/243b2ee1-b668-4d16-a4af-70fabe323188)).

**C2. Craft iOS: 사용자가 고치는 Home과 아래 탭바**
- "Search in Alex's Space" 아래에 최근 문서 카드 가로 캐러셀, All Docs, Shared with Me, Starred, Folders(개수), Tags, Recently Deleted, [Customize Home]이 이어진다.
  비어 있는 섹션은 머리를 그대로 두고 회색 이탤릭 안내를 넣는다("Star Docs to keep them close", "Pin your key tags for quick access")
  ([화면](https://mobbin.com/screens/3dc7f1ab-05c3-468e-bcb7-8ac6ad57cea7), [화면](https://mobbin.com/screens/cf3931f4-9dea-4da2-a94a-b520196c7c91), [화면](https://mobbin.com/screens/f5bae8f7-7222-4f77-8083-08f726d0c77a)).
- 하단은 알약 모양 탭(홈 / 할 일 / 캘린더 / 스페이스)과 **따로 떠 있는 "+"**다. Customize 시트에서 Quick Access(Recents / Starred / None)를 고르고 섹션을 숨기거나 순서를 바꾼다
  ([화면](https://mobbin.com/screens/af2f4f21-4534-41ba-8ddd-d626c1905a71)).

**C3. Goodnotes iOS: 문서 라이브러리**
- "Documents" 큰 제목 아래 필터 "All", 파란 "+ New" 알약, 그리드/목록 전환, 클라우드 아이콘이 있다. 하단 탭은 Documents / Favorites / Shared / Marketplace다
  ([그리드](https://mobbin.com/screens/f9dce871-ecc2-4753-9727-ec2c7b7d76eb), [목록](https://mobbin.com/screens/7c7ff1bd-0a46-4be1-aa40-2a99ebc8e863)).
  항목 메뉴는 Customize Color / Set Icon / Move / Export / Move to Trash([화면](https://mobbin.com/screens/1ce924af-efc7-4a63-9659-c39d296c7120)), 보기 메뉴는 Select Items · Grid/List · 정렬([화면](https://mobbin.com/screens/189b3062-cc75-4e1b-a2e9-68346157a609))이다.
- 빈 라이브러리는 **"Skip the blank page — Start with a template"** 문구와 템플릿 카드 3장(월간 플래너 / To-Do List / Concept Map)을 보여 준다([화면](https://mobbin.com/screens/976b45a2-7ede-410d-a78d-f8fcfb90ae55)).
- 편집기는 브라우저처럼 문서 탭(홈 + "Untitled ×")을 쓴다([화면](https://mobbin.com/screens/a10bae9d-f3ef-4d6e-ac60-c25a2ab1129f)).

**C4. Bear iPhone 목록**: 제목 "Notes ▾", 우상단 검색, **우하단 빨간 연필 FAB**가 있다([화면](https://mobbin.com/screens/2e6b36e9-8e8d-4b4f-a2f0-58aa320177d0)).
검색하면 상단 바가 "Search all notes" + Cancel로 바뀌고([화면](https://mobbin.com/screens/67babcfa-06dc-45f6-a978-e39d327c972e)), 결과의 제목과 발췌에서 일치한 단어가 노랗게 강조된다([화면](https://mobbin.com/screens/641f6455-f244-4387-8880-3cdf9aad1748)).

**C5. Obsidian iOS 서랍**: 파일 트리 행에 BASE / CANVAS 종류 라벨이 붙는다. 하단에는 새 노트 / 새 폴더 / 정렬 / … / 모두 접기 도구 줄이 있고,
"Files" 전환기와 볼트 이름 "Mobbin ▾ · 4 files, 1 folder", 설정 ⚙가 있다. 오른쪽 가장자리에 열린 노트가 살짝 보인다
([화면](https://mobbin.com/screens/b932b2a2-f404-45ae-a0d1-1b3aab5bed62)). 이름 바꾸기는 그 자리에서 인라인으로 한다([화면](https://mobbin.com/screens/67f6cae9-9c20-4d3a-812f-a7d0ac5ad3a1)).

**C6. 하단 탭의 구성**: Evernote는 Create / Notes / Notebooks / Tasks / Calendar([화면](https://mobbin.com/screens/e1b81139-13cf-465a-8dee-cc29ce6a33c1)).
Notion iOS 에디터 하단은 검색 / "Ask AI"(마이크 포함) / 새 페이지([화면](https://mobbin.com/screens/db2814d9-78bd-4b01-9d57-8e1c4dcbdbbc)).

- 왜 통하는가(C 전체): 폰에서 정리는 '트리를 펼치는 일'이 아니라 '개수가 붙은 몇 개의 입구를 고르는 일'이다. 만들기 버튼은 엄지가 닿는 아래쪽에 항상 같은 자리에 있다.

### D. 검색

**D1. Evernote iOS: 문법 대신 누르는 필터**
- 검색칸 아래에 Standard | AI-Powered 세그먼트가 있다. 빈 상태에는 RECENT SEARCHES / GO TO…(노트북·노트) / APPLY FILTER(Attachments, Images, 태그)가 나온다
  ([화면](https://mobbin.com/screens/bdc7e0b5-08fc-4b75-aec3-1fe81026de9d)). 입력하는 동안 GO TO가 갱신된다([화면](https://mobbin.com/screens/c66ad0a5-1247-4137-80ea-61699cd688b4)).
- 결과 위에는 점선 "+" 칩으로 **추천 필터**가 붙는다(Attachments / Images / Checkboxes / 태그). 일치한 단어는 노랗게 강조되고 오른쪽에 썸네일이 붙는다. 저장하면 "Search saved" 토스트가 뜬다
  ([화면](https://mobbin.com/screens/2952cb28-ffd2-4c40-abcf-9342b1d7e7d0)). 켠 필터는 파란 칩과 ×, Clear로 표시된다([화면](https://mobbin.com/screens/ac298483-58b6-4b07-ad5b-1d70bab34b25)).
- Filter notes 시트 항목은 Reminders / Tags / Located in / Contains / Created date / Updated date / Clear all이다([화면](https://mobbin.com/screens/c7b41921-1fc1-4991-b9d2-2f3e832d421f)).
  ⋯에서는 Save search / View options / Sort by(Relevance / Date updated / Date created / Title)를 고른다([화면](https://mobbin.com/screens/95f04d0b-fe56-4f84-a1f9-20b5bb97bd0d)).

**D2. Apple Notes: 키보드 바로 위의 검색과 "Suggested"**: 검색칸이 화면 하단, 키보드 바로 위에 있다. 빈 상태 제안은 Shared Notes / Locked Notes /
Notes with Checklists / with Tags / with Drawings / with Scanned Documents / with Attachments다([화면](https://mobbin.com/screens/4bb49171-5339-442a-87f1-714a791daa0e)).

**D3. Craft iOS 문서 안 찾기**: 시트 하나에 개요 / 할 일 / 첨부 / 찾기 탭이 있고, "Find ▾"에서 "3 Results"와 ↑↓ 이동을 보여 준다([화면](https://mobbin.com/screens/5a9dd1b3-5d00-41e2-b668-ad6ef5babfb7)).

**D4. Matter 검색 홈**: Recents / Favorites / Highlights / Archive 타일 아래에 Content Types(PDFs / Newsletters / YouTube / Podcasts)와 Tags가 있고, 검색칸은 하단에 있다
([화면](https://mobbin.com/screens/99a48611-3da3-4db7-82e9-5d2a01a3fed4)).

- 왜 통하는가: 일반 사용자는 `tag:`, `path:` 같은 문법을 모른다. 필터를 칩으로 보여 주면 문법을 배우지 않고도 좁힐 수 있다.

### E. 오프라인·동기화 상태

- **Obsidian iOS**는 볼트를 만든 직후 이렇게 설명한다: "Because Obsidian stores your notes on your devices, you'll need to set up sync if you want to access your notes on another phone or computer."
  주 버튼은 [Continue without sync], 보조 버튼은 [Set up sync]다. 이 화면은 지난 라운드 obsidian 보고서에서 온보딩 근거로 이미 인용했다. 이번에는 '로컬 우선 앱이 동기화를 어떻게 설명하는가'의 근거로 쓴다
  ([화면](https://mobbin.com/screens/c464d280-72a1-4984-b7b9-02bed72b99db)).
- **Crouton Sync Status**: 체크 행 네 개로 상태를 보여 준다. Account ✓ "Logged in to iCloud account" / iCloud Storage ✓ "Storage available" / Items in iCloud ⟳ "Updating…" / Items on Device ✓ "All items on this device are synced to iCloud"
  ([화면](https://mobbin.com/screens/2ec1d29c-8a03-4e15-9022-bdbc2c9de4dd)).
- **MD Vinyl**: Status ● Synced, 설명 한 문장, "Last synced at 1 Dec 2025 at 8:09 AM"([화면](https://mobbin.com/screens/2451dc46-c58d-472e-ba63-802790b155bc)).
- **Notion iOS**: 토스트 "Working offline · Last sync on May 28, 2026 at 1:10 AM"([화면](https://mobbin.com/screens/a335360d-a12e-4032-8d58-c465a9fc181a)).
- **Docusign**: 배너 "Syncing offline envelopes"와 행별 "Sync pending"([화면](https://mobbin.com/screens/42948b73-a83c-40c0-819c-6f96133201dc)).
- **Evernote iOS**: 노트 ⋯에 "Available offline" 토글이 있고 켜면 "Downloading note "To-Do"" 토스트가 뜬다([전](https://mobbin.com/screens/436d56d6-717c-41a4-bb29-44d8e4aa0ff0), [후](https://mobbin.com/screens/e02408ee-1a3a-4218-9dcc-c26f09254741)).
  노트북 단위 토글도 있다([화면](https://mobbin.com/screens/85c1b0c0-2bb2-420a-ac53-3ce244aed5df)). 목록에는 "Downloading notebook" 토스트와 행별 동기화 아이콘이 붙는다([화면](https://mobbin.com/screens/a1001720-eb1f-4cd3-8d46-f02904aafdf7)).
  설정에는 Offline / Sync 행이 따로 있다([화면](https://mobbin.com/screens/f74264ac-0593-4010-a615-a072d51d445e)). 기기 목록에는 "Current device"가 표시된다([화면](https://mobbin.com/screens/6ce913b7-77f6-4cba-88ae-447861e9c9ed)).
- **Google Photos**: "Review out-of-sync changes — All done"([화면](https://mobbin.com/screens/ebdde736-974d-4160-8da5-1bfa15a4a7a8)).
- 왜 통하는가: 로컬 우선 앱 사용자의 가장 큰 불안은 "이 기기에 있나, 다른 기기에 갔나, 무엇이 빠졌나"다. 체크 행 몇 줄과 마지막 시각만 보여 줘도 그 불안이 풀린다.

---

## 2. myco 갭 → 제안

표의 '영향/노력'은 판단이고 측정값이 아니다. **이미 출시됐거나 진행 중인 항목은 제안하지 않았다.**
출시된 것: S1–S12, 블록 에디터 0–6단계(⌘B/⌘I 마크, Home Ask/Capture 상자, 일일 노트 ‹ ›, 브레드크럼, 슬래시 템플릿).
진행 중인 것: Notion 표·블록 패널, graph-woven.
"지금"은 데스크톱 앱에 바로 넣을 수 있다는 뜻이고, "모바일"은 모바일 빌드나 좁은 창에서만 의미가 있다는 뜻이다.

| # | 대상 | 근거 패턴 | myco 현재 | 제안 | 영향/노력 | 시점 |
|---|---|---|---|---|---|---|
| W1 | Home 캡처 | Craft 캡처 카드의 모드 아이콘 + 목적지 칩 + "Added to Today — Tap to open" (A1) | 오늘의 노트에 적기는 ⌘/Ctrl+Enter로만 된다(`PageOverview.tsx:362-366`). 안내 문구도 키 조합이다(`i18n.ts:4095`, `shots/01`). 성공 토스트에 열기 액션이 없다(`PageOverview.tsx:334`). | 입력칸 오른쪽에 [질문] / [메모] 두 버튼을 둔다. 메모 버튼은 기존 `capture()`를 그대로 부른다. 토스트에 `action: { label: "열기", run: () => openDailyNote(vault, today) }`를 단다(`notice`는 이미 action을 지원, `NoticeStack.tsx:190-199`). 키 안내는 hover 기기에서만 보여 준다. | high / S | 지금 |
| W2 | 캡처 목적지 | Fabric "/ Spaces / Inbox" 칩, Craft "Inbox ▾" / "Unsorted ▾" (A1, A7) | 텍스트는 daily로, 음성·클립은 `_inbox/`로 간다. 음성 칩은 경로만 보여 준다(`Spotlight.tsx:421-427`, `i18n.ts:6028`). | 캡처 영수증 문구를 하나로 통일한다: "어디에 들어갔는지 + 다음에 무엇이 일어나는지 + 열기". 음성 칩에는 받아 적은 첫 줄(최대 1줄)을 덧붙여, 저장 전에 제대로 들었는지 보이게 한다. | med / S | 지금 |
| W3 | 웹 클리퍼 | Fabric 링크 시트의 "Say something about it… (optional)" (A7) | 클리퍼는 url/title/selection만 보낸다(`clipper/background.js:9-14`). | 확장 팝업에 선택 입력칸 한 줄을 두고 `note=` 파라미터로 보낸다. 앱에서는 클립 본문 앞에 "> 내 메모: …"로 넣는다. 그러면 ingest가 *왜 저장했는지*를 출처와 함께 갖게 된다. 앱 쪽 `clip.rs` 수정도 필요하다. | med / M | 지금 |
| W4 | ⌘K 검색 | Evernote APPLY FILTER와 점선 + 칩(D1), Apple Notes Suggested(D2) | 연산자 안내가 input `title` 툴팁에만 있다(`CommandBar.tsx:491`, `i18n.ts:3822`). | 빈 쿼리와 결과 상단에 연산자 칩 줄(태그 · 폴더 · 종류 · 출처 없음 …)을 둔다. 칩을 누르면 `tag:` 같은 접두어가 입력칸에 들어가고, 이미 있는 `parseSearchQuery` 경로를 그대로 탄다. lens 행은 그대로 둔다. | high / S | 지금 |
| W5 | 사이드바 태그 | Apple Notes 폴더 아래 Tags 칩 줄(C1), Craft Tags 섹션과 빈 안내(C2) | `Sidebar.tsx`에 tag 0건. 이전 라운드 craft-bear #4에서 제안했지만 미반영. | 접힌 "태그" 그룹에 상위 N개를 개수와 함께 칩으로 보여 준다. 누르면 W4의 `tag:` 칩이 켜진 ⌘K가 열린다. 새 라우트는 만들지 않는다. | med / S | 지금 |
| W6 | 빈 새 노트 | Evernote 빈 노트의 템플릿 칩(B4), Goodnotes "Skip the blank page"(C3) | 빈 줄 placeholder "'/'를 입력해 블록 선택"만 있다(`shots/05`). 템플릿은 슬래시 항목으로 출시됐지만 슬래시를 알아야 쓸 수 있다. | 본문이 비어 있을 때만 placeholder 아래에 템플릿 칩 2–3개(`templates/`의 `slash:` 항목 재사용)를 보여 주고, 첫 입력에서 사라지게 한다. | med / S | 지금 |
| W7 | 저장 위치·동기화 | Crouton 체크 행, MD Vinyl "Last synced", Notion "Working offline", Obsidian 동기화 설명(E) | iCloud placeholder는 인덱스가 조용히 건너뛰고(`index.rs:88-95`), 저장 상태는 노트 단위로만 있다(`PageReader.tsx:904-911`). | 설정이나 볼트 상태(StatusStrip)에 "저장 상태" 체크 행 3–4줄을 둔다: 볼트 위치(경로로 iCloud Drive·Dropbox 판별), 읽지 못한 파일 n개(목록 링크), git 기록 켜짐/꺼짐(배너와 같은 상태), 마지막 저장 시각. 빠진 파일을 숨기지 않는다는 원칙을 지키는 일이다. | high / M | 지금 (모바일 전제) |
| W8 | 터치에서 키 안내 | 터치 앱은 kbd를 보여 주지 않는다(B1–B5 화면에 단축키 표기 없음) | 터치에서도 `⌘K` 칩과 "⌘Enter…" 문구가 보인다(`shots/01`, `shots/03`). `@media (hover: none)`은 rail 버튼 하나에만 쓰인다(`styles/ui.css:834-841`). | `(hover: none)`에서 `kbd`와 키 안내를 숨기고, 그 자리에 버튼(W1)을 둔다. | low / S | 지금·모바일 |
| W9 | 좁은 서랍 | Obsidian 서랍은 볼트명 + ⚙ 한 줄(C5), Apple Notes는 폴더·태그만 둔다(C1) | 812px 높이에서 노트 목록이 한 줄 남짓이다. 푸터(설정·볼트 상태·경고)가 서랍 아래를 차지한다(`shots/03`). | `≤768px`에서는 StatusStrip을 아이콘 한 줄(경고 점 포함)로 접고, 설정은 머리 줄의 ⚙로 옮긴다. 워크스페이스 6행은 하단 탭(M2)으로 보낸다. | med / S | 모바일 |
| W10 | Home 자동 포커스 | Craft는 "+"를 눌러야 입력 카드가 열린다(A1) | `autoFocus`(`PageOverview.tsx:360`). placeholder가 375px에서 잘린다(`shots/01`). | `autoFocus`는 `(pointer: fine)`에서만 건다. textarea는 내용에 맞춰 늘어나게 한다. 폰에서 Home을 열 때마다 키보드가 올라오는 일을 막는다(추론: 모바일 WebView의 autofocus 동작은 실기기에서 미검증). | med / S | 모바일 |
| W11 | 자료 추가 | Evernote 캡처 타일 Camera / Scan / Files / Audio(A3), 스캔 모드(A5) | 헤드라인이 "여기에 파일 드롭"이고 제출 버튼은 첫 화면 밖이다(`shots/08`). | `(pointer: coarse)`에서는 드롭 문구 대신 타일 4개(사진·카메라 / 파일 / 링크 붙여넣기 / 음성)를 둔다. 제출 버튼은 하단에 고정한다. | med / M | 모바일 |
| W12 | 에디터 터치 툴바 | Craft·Apple Notes·Evernote·Obsidian의 맥락형 액세서리 줄(B1–B5) | 서식은 키보드 전용(`editorFormat.ts:572-580`)이고 블록 핸들은 hover 전용이다(`editorBlockHandle.ts:77-78`, 탭 후 hidden 측정). | 모바일 빌드에서 키보드 위에 붙는 한 줄 바를 둔다. 커서만 있을 때는 되돌리기 · `[[` · `#` · 체크 · 제목 · 슬래시 열기, 선택했을 때는 B · I · 형광 · 코드 · 링크(기존 `formatTr`). 이미 있는 명령만 부르고 새 서식은 만들지 않는다. 진행 중인 블록 패널 스펙의 "Pointer hover and keyboard selection" 툴바에 탭이 트리거로 들어가는지는 해당 스펙 담당이 확인해야 한다(`notion-blocks-one-editor.md:113`). | high / M | 모바일 |
| W13 | 노트 머리 높이 | Apple Notes는 본문 위에 날짜 한 줄만 둔다(B2 flow) | 375px에서 종류 칩·저장됨·작성 비율 바·제목·액션 줄이 첫 화면의 약 40%를 차지한다(`shots/05`). | `≤768px`에서 작성 비율 바와 액션 줄을 ⋯ 하나로 접고, 저장 상태는 제목 줄 끝의 점으로 바꾼다. | low / S | 모바일 |

이번 범위 밖이지만 보인 것: 768px Live에서 각주 원문 `[^src-…]`와 정의 줄이 그대로 노출된다(`shots/06-ipad-portrait-768-note.png`).
진행 중인 one-editor/블록 작업과 겹치는지 확인이 필요해서 제안으로 올리지 않았다.

---

## 3. 모바일 버전은 어떻게 할까

### 근거에서 나온 방향

1. **처음부터 데스크톱 전체를 옮기지 말고, 캡처와 읽기 동반 앱으로 시작한다.** 위의 쓰기 앱들은 폰 첫 화면을 입력으로 쓴다(Evernote 홈 A3, Craft "+" 카드 A1, Apple Notes 공유 메뉴 Quick Note A7, Fabric "+" 메뉴 A8).
   반면 myco에서 무거운 부분은 데스크톱에 묶여 있다: 로컬 모델(`Cargo.toml:46` llama-cpp-2), whisper 사이드카(`tauri.conf.json:64`), tray·notch·전역 단축키(`lib.rs:158`, `:352`, `:358`), MCP 서버.
   - **M1 범위**: (a) 캡처 카드(텍스트 → 오늘의 노트, 링크·사진·음성 → `_inbox/`). 데스크톱과 같은 파일 형식을 쓴다: 클립 frontmatter(`clipper/README.md`), `voice-<날짜>.md`(`commands.rs:517-521`).
     (b) 공유 확장("myco에 보내기", 선택 메모 한 줄 + 목적지 칩, Fabric A7). (c) 읽기와 검색(W4 칩 포함). (d) 질문하기.
     질문 화면은 375px에서도 이미 무리 없이 읽힌다(`shots/09`).
   - **나중**: 그래프, 정리 제안, 플러그인, 에이전트 패널. 하단 탭이 아니라 "더 보기"에 둔다.
2. **하단 탭 + 떠 있는 "+"**: Craft(홈 / 할 일 / 캘린더 / 스페이스 + 따로 떠 있는 +, C2), Evernote(Create / Notes / Notebooks / Tasks / Calendar, C6), Goodnotes(Documents / Favorites / Shared, C3)가 모두 이 구조다.
   myco 안: **홈(캡처) · 노트 · 질문 · 할 일** 탭에 떠 있는 "+"(캡처 카드)를 더한다. 사이드바의 워크스페이스 6행(`shots/03`)이 이 탭으로 옮겨 간다.
   Notion iOS처럼 노트 화면 하단에 검색 · "질문"(마이크) · 새 노트를 두는 방식도 근거가 있다(C6).
3. **동기화는 myco가 만들지 말고, 설명하고 보여 준다.** 볼트는 평범한 마크다운 폴더이므로 iCloud Drive나 Files에 둔 폴더를 그대로 연다. 이것이 Obsidian iOS와 같은 위치다(E).
   첫 실행에서 Obsidian처럼 "이 기기에만 저장됩니다 / 다른 기기와 맞추려면…"을 설명한다. W7의 저장 상태 행을 모바일 첫 출시에 넣는다(Crouton·MD Vinyl 패턴).
   placeholder 파일 수를 숨기지 않는다.
4. **에디터는 툴바 한 줄(W12) + 슬래시**로 간다. 마크다운 볼트 앱인 Obsidian iOS의 한 줄 툴바(B5)가 myco의 `[[`, `#`, 체크와 가장 잘 맞는다.
   Bear처럼 키보드를 대신하는 전체 패널(B3)은 2단계로 미룬다.
5. **iPad**: Mobbin 근거 없음. myco의 1024 가로 화면은 사이드바 고정 + 적당한 본문 폭이라 그대로 쓸 수 있는 형태다(`shots/06-ipad-landscape-1024-note.png`).
   768 세로는 오버레이 사이드바 동작을 확인했다(`shots/06-ipad-portrait-768-note.png`). iPad는 새 레이아웃을 만들기보다 기존 반응형 규칙에 W8–W13을 적용하는 정도로 시작하는 것이 맞다고 본다.
6. **위젯과 잠금 화면**: 근거는 노트 앱이 아니라 ChatGPT·Grok·Arc의 질문/음성 위젯이다(A6). myco에 맞는 형태는 "질문하기 / 메모 / 음성" 3버튼 위젯이다.
   설치 방법은 Truecaller처럼 앱 안에서 단계로 가르친다.

### 기술 전제 (구분해서)

- **검증함**: 모바일 진입점이 없다(`lib.rs:114`, grep 0건). 데스크톱 전용 플러그인과 초기화가 조건 없이 등록된다(`lib.rs:158`, `:352`, `:358`, `Cargo.toml:22`, `:69`).
  번들 타깃은 데스크톱뿐이다(`tauri.conf.json:36-39`). 창 `minWidth: 800` 때문에 폰 CSS는 출시 앱에서 쓰이지 않는다(`tauri.conf.json:20`).
- **추론(미검증)**: Tauri 2로 iOS/Android 빌드를 하려면 `#[cfg_attr(mobile, tauri::mobile_entry_point)]` 진입점이 필요하다. global-shortcut·tray·macOS private API·`externalBin` 사이드카는 `cfg(desktop)`으로 막아야 한다.
  whisper 사이드카는 iOS에서 프로세스로 실행할 수 없을 가능성이 높다. 이 셋은 Tauri 공식 문서로 확인한 뒤에 계획에 넣어야 한다.
- **추측**: 모바일 음성 받아쓰기는 OS 내장 음성 인식이나 녹음 후 데스크톱 ingest로 넘기는 방식이 현실적일 수 있다. 근거 없음. 결정 전에 조사가 필요하다.

---

## 4. 검증 / 추론 / 미검증 구분

- **검증**: 위 §0의 file:line은 모두 이번 세션에 읽었다. 스크린샷 9장은 직접 찍었다(`shots/01`–`09`).
  topbar 591/375, 블록 핸들 hidden은 Playwright로 측정했다. Mobbin 링크는 모두 이번 세션 검색 결과다.
- **추론**: 모바일 WebView에서 autofocus가 키보드를 띄운다는 점(W10). 터치에서 pointermove가 탭으로 발생하지 않아 핸들이 안 보인다는 점(측정은 Playwright 에뮬레이션이고 실기기가 아니다). Tauri 모바일 제약(§3).
- **미검증**: 실기기(iPhone/iPad) 동작, Tauri mobile 빌드 가능 여부, iCloud placeholder 개수를 앱에서 셀 수 있는 API, 클리퍼 팝업에서 deep link로 보낼 수 있는 길이 제한.
