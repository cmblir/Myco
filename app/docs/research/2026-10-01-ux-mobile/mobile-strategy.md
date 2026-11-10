# myco 모바일 전략 (2026-10-01)

모바일 버전을 어떻게 만들지에 대한 권장안입니다. 근거는 이번 라운드 보고서 7개이고, 특히 기술 판단은 `mobile-feasibility.md`(이하 타당성), 화면 판단은 `audit-mobile.md`(폰 감사)와 Mobbin 보고서 넷(ON, WC, PA, AM)에서 왔습니다. 코드 경로는 `app/` 기준, 스크린샷 경로는 `ux-2026-10/` 기준입니다. 보고서에 없고 제가 판단한 부분은 (추론)으로 표시했습니다. 실기기와 iOS 빌드는 아무도 돌려 보지 않았습니다. 이 기계에는 iOS Rust 타깃과 iOS SDK가 없습니다(타당성 0절).

## 결론

**같은 코드베이스로 iOS 짝꿍 앱(iPhone과 iPad 겸용)을 먼저 만들기를 권합니다.** 첫 버전이 하는 일은 넣기, 읽기, 묻기 세 가지입니다.

- 노트는 iCloud Drive 폴더에 평범한 마크다운 파일로 있고, 데스크톱 myco와 폰 myco가 같은 폴더를 엽니다. myco는 동기화 서버를 만들지 않습니다.
- 질문은 폰 안의 인덱스로 답합니다. 데스크톱과 같은 Rust 검색 코드와 같은 임베딩 모델을 쓰므로, 노트를 기기 밖으로 보내지 않고 원문 인용과 기권 규칙을 그대로 지킵니다.
- 폰은 첫 버전에서 **새 파일만 만듭니다.** 텍스트 메모는 `_inbox/capture/`에, 링크와 사진은 `_inbox/`에 새 파일로 들어가고, 기존 노트는 고치거나 지우지 않으며, `raw/`는 읽기만 합니다. 단, 데스크톱의 자동 정리(distill)는 지금 `raw/` 파일을 옮기므로(`backlog.md` B1) 이 결정이 나야 볼트 공유 규칙이 닫힙니다.
- 자료 정리 판단, 자동 정리, 그래프 작업, 에이전트, MCP, 플러그인은 계속 데스크톱이 맡습니다.
- 지금은 데스크톱에 먼저 효과가 있는 공통 작업(0단계)을 하고, 네이티브 쪽 위험은 스파이크(1단계)로 확인한 뒤, 모바일 웹 레이어(2단계 첫 묶음)와 MVP 범위를 확정하십시오.

이유는 네 가지입니다. 폰에서 사람들이 하는 일은 넣기와 묻기입니다(아래 "왜 이 안인가"). 기기 안 답변은 local-first와 원문 인용 원칙을 그대로 지키는 유일한 길입니다. 동기화를 OS에 맡기는 방식은 Obsidian iOS가 이미 같은 볼트 형식으로 검증한 길입니다. 새 파일만 만드는 규칙은 동기화 충돌을 원리상 막아서 첫 버전을 작게 유지합니다(추론).

## 선택지

### 앱의 형태

| | A. 전체 이식 | **B. 짝꿍 앱(권장)** | C. 반응형 PWA | D. iPad 우선 |
|---|---|---|---|---|
| 내용 | 같은 Tauri 앱을 iOS/Android로 거의 전부 옮깁니다 | 같은 코드베이스의 부분집합(넣기, 읽기, 묻기) | 웹 UI만 폰에 맞춥니다 | 지금 데스크톱 레이아웃을 iPad에 냅니다 |
| 네이티브 어댑터 | 전부(경로, 폴더, 추출, whisper, llama, git, 휴지통) | 경로, 폴더, 임베더, 공유 확장 | 없음 | 전부 |
| 폴더 접근 | iOS와 Android 모두 L | iOS iCloud 폴더 M(스파이크) | 불가 | iOS M |
| local-first | 유지 | 유지 | 깨집니다 | 유지 |
| 스토어 위험 | 3.1.1, 2.5.2, 4.2 | 4.2, Pro를 내면 3.1.1 | 해당 없음 | A와 같음 |
| 판단 | 비용이 가장 크고 무거운 기능(distill, 연속 렌더 그래프)이 폰과 맞지 않습니다 | 권장 | iOS Safari와 Chrome Android가 `showDirectoryPicker`를 지원하지 않아 기기 폴더를 읽을 수 없고, Safari는 7일 미사용 저장소를 지웁니다(타당성 4절 C) | 따로 만들지 않고 B의 universal 빌드에서 넓은 화면이면 데스크톱 레이아웃을 쓰게 합니다 |

근거: 타당성 1절과 4절. 데스크톱 전용 의존성은 `src-tauri/Cargo.toml:22, 29, 69`(tray-icon, macos-private-api, updater, global-shortcut), 모바일 진입점 없음은 `src-tauri/src/lib.rs:114`, 외부 프로세스를 띄우는 Rust 모듈 15개는 폰 감사 3단계에 있습니다.

### 질문을 어디서 계산하나

보고서들이 여기서 갈렸습니다. 타당성은 기기 안을, PA와 AM은 데스크톱 원격(페어링)을, 폰 감사는 HTTP 제공자나 원격을 후보로 들었습니다.

| | **기기 안 추출형(권장)** | 데스크톱 원격 | HTTP 제공자 |
|---|---|---|---|
| 동작 | 폰이 자기 인덱스로 BM25, dense, RRF, intent 판정을 돌립니다(`src-tauri/src/intent.rs:1-15`, `src-tauri/src/vector_index.rs:1-7`) | 폰이 질문을 보내고 데스크톱이 답합니다 | 사용자 API 키로 생성형 답을 받습니다(`src-tauri/src/providers.rs:6-12`) |
| 원칙 | 노트가 기기 밖으로 나가지 않습니다. 같은 코드라 같은 바닥선과 기권을 냅니다(추론) | 추출형 보증이 데스크톱 한 곳에 남습니다 | 노트 구절을 외부로 보냅니다. myco Ask의 기본 경로는 생성 모델이 필요 없습니다 |
| 조건 | `llama-cpp-2` iOS 빌드(미확인), 폰 색인 시간과 메모리(미측정). 모델은 39.7MB입니다(`src-tauri/tauri.conf.json:62`) | 데스크톱이 켜져 있고 닿아야 합니다. 지금 MCP는 loopback 전용이고 DNS rebinding을 막는데(`src-tauri/src/mcp_native.rs:2955-2962`), 이것은 의도된 보안이라 열면 안 됩니다. 따로 페어링 채널과 보안 설계가 필요합니다 | 네트워크와 키 |
| 다른 앱 | Obsidian iOS는 볼트를 기기 안에 두고 오프라인에서도 동작한다고 첫 화면에서 말합니다([e77414c6](https://mobbin.com/screens/e77414c6-2bee-4455-be64-60b7887b75f5)) | ChatGPT iOS의 Codex 연결은 "Waiting for desktop…", "Offline · Last seen 18 minutes ago · Reconnect" 화면을 따로 둡니다([912012a5](https://mobbin.com/flows/912012a5-1551-4c9f-88c9-ce5737d5961f), [635cf9e7](https://mobbin.com/screens/635cf9e7-fad6-4e72-b13d-20c138e4af00)). Brave는 QR 코드에 만료 시간과 "비밀번호처럼 다루라"는 경고를 붙입니다([53c3fdf5](https://mobbin.com/screens/53c3fdf5-a622-4484-aa67-8ed340ca85c0)) | 해당 없음 |
| 판단 | 권장. 스파이크 SP-2가 실패하면 대안을 다시 고릅니다 | 첫 버전에서 뺍니다. 일반 사용자가 폰으로 묻는 때는 집 밖일 때가 많은데 그때 데스크톱에 닿지 않습니다(추론). 나중에 "데스크톱에서 정리 시작" 같은 원격 동작에만 검토합니다 | 질문 기본 경로로는 쓰지 않습니다 |

## 왜 이 안인가

1. **폰의 일은 넣기와 묻기입니다.** Notion iOS는 화면 바닥에 검색, "Ask AI"(마이크 포함), 새 페이지 세 버튼을 띄웁니다. 최상위 목적지(Home, Chats, Calendar, Inbox)는 화면 위쪽의 탭 네 개로 따로 둡니다([e7689c02](https://mobbin.com/screens/e7689c02-0bc0-49f7-bc5c-71f516844d33), ON 보고서 80행). 엄지 쪽에는 넣기와 묻기를, 이동은 위에 두는 구성입니다. Granola는 폰 홈에 "Get Desktop App"을 두고 폰에서는 보기, 묻기, 새 노트만 합니다([131f5785](https://mobbin.com/screens/131f5785-cbd5-404d-9102-702d5f625e52)). Matter와 mymind는 공유 시트로 넣고 판단은 나중에 합니다([143f64c0](https://mobbin.com/flows/143f64c0-0aa7-41cd-8b75-e12f47ddbfe6), [bc1fa1fd](https://mobbin.com/screens/bc1fa1fd-9d9c-4f9b-9f70-d427816835fd)).
2. **무거운 부분은 데스크톱에 묶여 있습니다.** whisper는 외부 바이너리 사이드카이고(`src-tauri/tauri.conf.json:64`), PDF 추출은 자기 자신을 다시 실행하며(`src-tauri/src/extract.rs:40-60`), git 기록과 Claude CLI도 프로세스를 띄웁니다(`src-tauri/src/vault_history.rs:28-34`, `src-tauri/src/claude.rs:101`). iOS 앱은 자식 프로세스를 만들 수 없습니다(타당성 1-B, Apple DTS 인용). 반면 Ask의 검색은 순수 Rust와 임베더로 끝납니다.
3. **동기화는 OS에 맡깁니다.** Obsidian iOS는 볼트를 만들 때 "Store in iCloud, This cannot be changed later"를 묻고([1fe92af6](https://mobbin.com/screens/1fe92af6-d08b-4aa0-aa68-4a2ff0f41218), [34928d68](https://mobbin.com/flows/34928d68-f70f-4fb2-8379-a5cf8f7303c6)), iOS에서 공식 지원하는 동기화는 Obsidian Sync와 iCloud뿐입니다(타당성 3-C, obsidian.md/help/sync-notes). myco 볼트는 Obsidian 호환 마크다운이라 같은 방식이 맞습니다.
4. **편집을 첫 버전에서 빼는 이유.** 두 기기가 같은 파일을 오프라인에서 고치면 iCloud 충돌이 생기고, 그 처리를 아직 검증하지 않았습니다(추론). 키보드 위 도구 막대(S51)도 아직 없습니다. "폰에서 고치고 싶으면 Obsidian iOS를 쓰면 된다"는 대안은 SP-3의 선택에 달려 있습니다. Obsidian iOS는 `iCloud Drive/Obsidian` 폴더 안의 볼트나 기기 안 볼트만 엽니다(https://obsidian.md/help/sync-notes "Vaults should be inside the Obsidian folder within iCloud Drive", https://forum.obsidian.md/t/full-file-system-access-for-the-ios-app-open-existing-vault-folder/28266 "you cannot pick an arbitrary location").
   - SP-3 (가) myco 자체 iCloud 컨테이너를 고르면 Obsidian iOS는 그 볼트를 열 수 없습니다. 그러면 폰에서 노트를 고칠 길이 없습니다. 이 경우 MVP에 최소 편집(오늘 노트에 한 줄 덧붙이기)을 넣을지 다시 판단해야 합니다. 권장은 넣지 않고, 같은 일을 캡처(`_inbox/capture/` 새 파일, 데스크톱이 오늘 노트로 접음)로 대신하는 것입니다. 오타 고치기 같은 진짜 편집은 3단계까지 할 수 없다는 점을 소유자가 받아들여야 합니다.
   - SP-3 (나) 사용자가 고른 폴더를 쓰고 그 폴더가 `iCloud Drive/Obsidian/<볼트>`이면 Obsidian iOS로 고칠 수 있습니다. 이 경우 Mac의 데스크톱 볼트도 iCloud Drive의 Obsidian 폴더 안에 있어야 합니다. 지금 데스크톱 기본 볼트는 `~/Documents/myco`라서(`src-tauri/src/vault.rs:297-313`) 옮기는 흐름이 필요합니다(아래 "데스크톱 쪽에 필요한 일"). myco 폰 앱이 Obsidian의 폴더를 문서 선택기로 열 수 있는지는 확인하지 못했습니다(타당성 6절).
   - 어느 쪽이든 myco 폰 앱은 Obsidian에 없는 것(원문 인용 질문, 넣기, 나중에 복습)부터 합니다.
5. **iPad는 같은 빌드에서 따라옵니다.** 834px과 1194px에서 지금 데스크톱 레이아웃이 가로 넘침 없이 쓸 만합니다(`mobile-shots/09-ipad-portrait-note.png`, `mobile-shots/09-ipad-landscape-note.png`). 그래서 폭 규칙은 폰 셸 ≤768px, 769–1023px은 데스크톱 레이아웃에 coarse 터치 대상, ≥1024px은 데스크톱입니다(`backlog.md` "모바일 준비" 머리와 같은 규칙). 다만 같은 폭의 터치 대상이 26–28px라서(폰 감사 M-12) S47이 먼저 필요합니다.

## 단계 계획

### 0단계: 데스크톱에 먼저 효과가 있는 공통 작업(지금, 네이티브 없음)

데스크톱 창은 `minWidth: 800`이라서(`src-tauri/tauri.conf.json:20`) 폰 폭 CSS는 출시 앱에서 쓰이지 않습니다. 그래서 지금은 데스크톱 사용자에게 효과가 있고 나중에 폰에도 그대로 실리는 작업만 합니다.

- 순서: `backlog.md` B1(`raw/` 이동 결정), S25, S13 홈 적기 버튼, S55 데스크톱 링크 클릭, S30 기권 카드, S36 질문 기록, S31 각주 번호(소유자 결정), S32·S33의 데스크톱 부분.
- 성공 기준: 각 슬라이스의 수용 기준과 앱 게이트 통과(ON B6).

### 1단계: 스파이크(브랜치 하나, 소유자 승인 뒤)

아래 "위험과 먼저 검증할 것"의 SP-1부터 SP-6까지입니다. SP-1, SP-2, SP-3이 통과해야 2단계 범위를 확정합니다.

### 2단계 첫 묶음: 모바일 웹 레이어

폰 앱을 만들기로 하고 SP-1~SP-3을 통과한 뒤에 합니다. `backlog.md`의 모바일 준비 묶음입니다.

- 순서: S46 터치 링크, S47 coarse 포인터 기준, S48 viewport와 안전 영역, S49 공용 시트(보이는 ⋯ 버튼이 기본), S32·S33의 폰 부분, S50 폰 셸, S54 좁은 폭 페이지.
- 성공 기준: 375·390·768·820·1180에서 문서 가로 스크롤 0, 터치 에뮬레이션에서 화면 안 44px 미만 대상 0, 하드웨어 키보드 경로(⌘K, `/`, `Mod-/`) 회귀 없음, 앱 게이트 통과(ON B6), 실기기 SP-5 항목 통과.
- 이 묶음 없이 앱을 내면 6화면짜리 답(`shots-ai-mobile/03-ask-answer-top.png`)과 수정키가 있어야 열리는 링크(`src/lib/editorLive.ts:753`)가 그대로 폰에 실립니다.

### 2단계: MVP(iOS, iPhone과 iPad 겸용)

**넣는 것**
- 첫 실행: 볼트 위치(iCloud Drive에 두고 Mac과 같이 쓰기 / 이 기기에만), "계정이 필요 없어요", 팁 두 장(다른 앱에서 공유하기, 내 노트에 질문하기).
- 오늘(홈): 입력창과 [질문하기] [적기] 버튼(S13), 최근 노트, "받은 자료 n개 · 데스크톱에서 정리돼요".
- 넣기: ＋ 시트(메모, 링크, 사진·카메라, 파일)와 공유 확장. 텍스트 메모는 `_inbox/capture/`에, 링크·사진·파일은 `_inbox/`에 새 파일로 들어갑니다(이유는 아래 "데스크톱 쪽에 필요한 일").
- 노트: 내 노트 목록(S15 분류), 아래 입력 찾기, 읽기 전용 노트 보기, 탭으로 링크 이동(S46), 번호 칩 각주(S31), 연결 문장 시트.
- 질문: 기기 안 추출형 Ask, 아래 입력창, 접힌 답, 출처 시트, 쉬운 말 범위, 기권과 "적어 두기"(S30, 새 캡처 파일로), 기기 안 질문 기록.
- 설정: 저장 상태(S27), 테마와 글자 크기(S22, 기본은 OS 글자 크기 따르기).

**빼는 것(이유)**
- 기존 노트 편집, 이름 바꾸기, 이동, 삭제: 충돌 처리 미검증, 모바일에서 `trash` 크레이트 미지원(타당성 1-B).
- 복습 기록: 덱 파일 `cards/<deck>.md`(`src/pages/PageStudy.tsx:1`)를 고쳐 써야 해서 편집과 같은 충돌 문제가 있습니다.
- 자료 추가 판단, distill, Reflect, digest, 스케줄: 프로세스 실행과 긴 배치이고 iOS 백그라운드는 best-effort입니다(타당성 3-E).
- PDF 추출: 자기 재실행(`src-tauri/src/extract.rs:40-60`)이 iOS에서 막히고, in-process로 바꾸면 `panic = "abort"`(`src-tauri/Cargo.toml:121`) 때문에 파서가 죽으면 앱 전체가 죽습니다.
- 그래프, 할 일, 히스토리, 출처, 에이전트, MCP 서버, 플러그인, Spotlight, 트레이, 노치.
- 음성 전사: whisper 사이드카는 iOS에서 실행할 수 없습니다(`src-tauri/tauri.conf.json:64`). OS 키보드 받아쓰기만 씁니다.
- myco Pro, 위젯, Android.

**데스크톱 쪽에 필요한 일**
- **폰 캡처를 오늘의 노트로 접고, 자동 정리와 자료 추가에서 빼기(새 작업, S–M).** 폰은 텍스트 메모를 `_inbox/capture/capture-<시각>-<난수>.md`에 `kind: capture`, `day: YYYY-MM-DD` frontmatter를 붙여 쓰고, 데스크톱은 이 파일을 지금의 `capture_note` 경로(`src-tauri/src/commands.rs:809-835`)로 그날 노트에 붙인 뒤 지웁니다(제안, 추론). 짧은 메모가 자료 추가의 200바이트 바닥선에서 거절되는 일(`audit-desktop/shots/flow/94-ingest-short-ko-dark-1280.png`)도 피합니다.
  - 왜 하위 폴더인가: `_inbox/`는 데스크톱 distill의 inflow 트리입니다(`src-tauri/src/distill.rs:474-490`). 캡처가 `_inbox/` 바로 아래에 있으면, 24시간이 지난 뒤(`maturation_hours`, `:51-53`) 200바이트 이상이고 기존 주제와 유사도가 낮은 메모는 `_inbox/quarantine/`으로 옮겨지고(`:682-694`), 30일 뒤 휴지통으로, 다시 30일 뒤 영구 삭제됩니다(`:39-41`, `:2741-2819`). summary 등급이면 첫 줄만 오늘 노트에 "(low confidence)"로 붙고 파일은 `raw/archive/`로 갑니다(`:2590-2678`). 자료 추가 쪽은 `_inbox/` 바로 아래 파일만 읽으므로(앱 `src-tauri/src/commands.rs:1050-1063`, 데몬 `../automation/autoingest.py:95-100`) 하위 폴더면 따로 고칠 것이 없습니다. distill은 `_inbox/`를 하위 폴더까지 훑고 `quarantine`만 빼므로(`src-tauri/src/distill.rs:430-439`, `:476-481`), 같은 제외 목록에 `capture`를 더해야 합니다. 상태 보고의 같은 목록(`:3100-3104`)도 맞추십시오. 그러면 "캡처 접기"와 distill 중 무엇이 먼저 도는지와 상관없이 캡처가 격리되지 않습니다.
  - 대안: `collect_candidates`가 `kind: capture` frontmatter 파일을 건너뛰게 할 수도 있습니다. 다만 파일마다 내용을 읽어야 하고 자료 추가 쪽도 따로 막아야 해서 하위 폴더가 더 작습니다(추론).
  - 수용 기준(`cargo test`): 위키 50쪽 이상으로 게이트가 켜진 임시 볼트에 `_inbox/capture/capture-x.md`(200바이트 이상, 기존 주제와 무관한 내용)를 두고, 그 항목을 격리 등급으로 보내는 stub 임베더로 distill을 한 번 돌린 뒤에도 파일이 `_inbox/capture/`에 그대로 있고 `_inbox/quarantine/`에 없습니다. 이어서 접기를 돌리면 `daily/<day>.md`에 그 줄이 있고 캡처 파일은 사라집니다. `inbox_entries`는 `_inbox/capture/` 안의 파일을 돌려주지 않습니다.
- **볼트를 iCloud로 옮기기(새 작업, M).** 지금 데스크톱 기본 볼트는 `~/Documents/myco`입니다(`src-tauri/src/vault.rs:297-313`). 폰과 나누려면 이 볼트를 iCloud Drive로 옮기는 흐름이 필요합니다. SP-3에서 (나)를 고르고 Obsidian iOS 편집까지 원하면 목적지는 iCloud Drive의 Obsidian 폴더입니다(위 "왜 이 안인가" 4번).
  - `raw/` 보존: 복사한 뒤 모든 파일의 해시를 원래 볼트와 비교하고, 같을 때만 새 위치로 전환하십시오. 원래 폴더는 사용자가 확인하기 전까지 지우지 않습니다.
  - 인덱스: 인덱스 파일 이름이 절대 경로 해시라서(`src-tauri/src/vector_index.rs:109-115`) 새 위치에서는 새로 만들어집니다. 진행 표시를 두고, 옛 인덱스 파일은 정리하십시오. 볼트 id 키로 바꾸는 작업(아래)과 같이 하면 한 번만 다시 만듭니다(추론).
  - 변경 이력이 켜져 있을 때: git 저장소는 볼트 루트의 `.git`입니다(`src-tauri/src/vault_history.rs:63`, `:77`). iCloud 안의 git 저장소는 충돌 사본이 생기거나 객체 파일이 내려가(evict) 손상될 위험이 있습니다(추론). 선택지는 (i) 옮기기 전에 이력을 끄기, (ii) 저장소 본체는 iCloud 밖 Mac 로컬에 두고 볼트에는 `gitdir:` 한 줄짜리 `.git` 파일만 남기기(git의 gitfile 방식. myco는 `.git`이 있는지만 보므로 동작할 것으로 봅니다, 추론), (iii) 그대로 옮기기입니다. 권장은 (ii)이고 소유자 결정입니다.
  - `.myco/`: distill 상태, 실행 기록, 휴지통이 같이 옮겨집니다(아래 표).
- **아직 내려받지 않은 파일 세기와 저장 상태 표시(S27).** macOS Sonoma부터는 `.icloud` stub이 아니라 원래 이름의 dataless 파일이라서, `st_flags`의 `SF_DATALESS`나 `NSURLUbiquitousItemDownloadingStatusKey`로 판별해야 합니다. 인덱스 빌드가 그 파일을 읽으면 내려받기가 시작됩니다(`src-tauri/src/index.rs:88-98`, 자세한 것은 S27).
- 앱 데이터 경로를 Tauri `app_data_dir()`로 바꾸기(`src-tauri/src/settings.rs:262-285`)와 인덱스 키를 절대 경로 해시에서 볼트 id로 바꾸기(`src-tauri/src/vector_index.rs:109-115`). 공유 Rust 코드라서 데스크톱 인덱스가 한 번 다시 만들어질 수 있습니다(추론).

### 3단계: 편집과 복습

- SP-4로 충돌 처리를 확인한 뒤 기존 노트 편집을 넣습니다: 키보드 위 도구 막대와 탭 블록 메뉴(S51), ＋ 블록 타일, 블록 Actions 시트, 진행 중 표 스펙의 터치 조건.
- 복습(S34의 하나의 큐, 두 버튼, 스와이프)과 홈의 재회 카드를 넣습니다.
- 할 일(S52 상태 칩과 길게 눌러 옮기기, S54 입력 두 줄)과 그래프 보기(S53)를 "더 보기" 아래에 넣습니다.
- 위젯: 질문/적기 위젯과 오늘 복습 카드 위젯입니다. `tauri-plugin-widgets`는 0.5.0으로 열람했지만 검색 요약은 0.3.0이라 버전 확인이 필요합니다(타당성 3-D).

### 4단계: 넓히기

- Android: Mobbin에 Android 화면이 없어(모든 Mobbin 보고서의 한계) iOS 근거로만 설계했습니다. 앱 전용 저장소로 시작하고, SAF URI 계층 재작성과 "All files" 권한 중 무엇을 택할지는 사용 데이터를 보고 정합니다(타당성 3-B).
- 음성 메모 전사: whisper.cpp를 라이브러리로 링크하거나(whisper.cpp README의 iOS/Android 예제) OS 음성 인식을 씁니다.
- 데스크톱 원격 동작(선택): 페어링 채널을 따로 설계해 "데스크톱에서 정리 시작" 같은 동작만 엽니다.

## 모바일 정보 구조

### 내비게이션

- **아래 막대(MVP):** [오늘] [노트] [＋ 넣기] [질문]. 3단계에서 [복습]을 더합니다. 아래 막대는 `env(safe-area-inset-bottom)`을 씁니다.
- **상단:** 위치 칩(폴더 이름)과 ⋯만 둡니다. 뒤로는 OS 가장자리 제스처가 맡고, 앞/뒤 화살표, 분할 버튼, 모델 칩은 폰에서 뺍니다(`mobile-shots/03-note.png`에서 화살표가 시스템 제스처와 겹침, 폰 감사 M-11).
- **드문 것:** 설정, 저장 상태, 도움말은 오늘 화면의 ⋯ 메뉴 하나 뒤에 모읍니다.
- **폭 규칙:** 폰 셸은 ≤768px입니다. 769–1023px(iPad 세로 820·834px 포함)은 데스크톱 레이아웃에 coarse 포인터 터치 대상을 적용하고, ≥1024px은 데스크톱 레이아웃 그대로입니다. iPad의 Split View나 Slide Over로 창이 768px 이하가 되면 폰 셸이 됩니다. `backlog.md`의 S42, S50, S53, S54가 같은 규칙을 씁니다.
- 근거: Obsidian iOS 떠 있는 바닥 막대와 상단 제목·⋯([f1a6d4a1](https://mobbin.com/screens/f1a6d4a1-719d-43a3-8532-fe7261f6151e), [06a17971](https://mobbin.com/screens/06a17971-bcd0-445d-a6aa-bc50c5c62c2b)), Notion iOS 바닥 세 버튼([e7689c02](https://mobbin.com/screens/e7689c02-0bc0-49f7-bc5c-71f516844d33))과 아바타 메뉴([39a94725](https://mobbin.com/screens/39a94725-425f-49c9-af53-a1071f24c53b)), Linear 탭과 따로 떨어진 검색, "⌃" 전체 메뉴([3d9ccfd8](https://mobbin.com/screens/3d9ccfd8-2425-49e9-a00b-27189140d3a3), [f97b18e7](https://mobbin.com/screens/f97b18e7-5e86-42f2-85df-9e7a000fae0e)), Craft 알약 탭과 따로 떠 있는 +([af2f4f21](https://mobbin.com/screens/af2f4f21-4534-41ba-8ddd-d626c1905a71)).
- 보고서마다 탭 구성이 달랐습니다(WC: 홈·노트·질문·할 일, PA: 오늘·질문·복습·＋, AM: 홈·질문·＋·할 일). MVP 범위가 넣기, 읽기, 묻기라서 할 일과 복습을 첫 탭에서 뺐습니다(추론).

### 넣기(캡처)

- **＋ 시트:** 메모(오늘 노트로), 링크, 사진·카메라, 파일 네 타일. 음성 메모는 3단계 이후입니다. 근거: Claude iOS의 Camera/Photos/Files 큰 타일([58bcab7a](https://mobbin.com/screens/58bcab7a-f050-487f-bba8-d129de43cce3)), Evernote 홈의 캡처 타일 줄([e1b81139](https://mobbin.com/screens/e1b81139-13cf-465a-8dee-cc29ce6a33c1)), Craft의 "+" 캡처 카드([1d332ade](https://mobbin.com/flows/1d332ade-dd11-4571-9300-00d060523a5f)).
- **영수증:** "어디에 들어갔고, 다음에 무슨 일이 일어나며, 어떻게 여는지" 한 줄입니다("받은 자료에 담았어요 · 데스크톱에서 정리돼요 · 열기"). 근거: Craft "Added to Today, Tap to open"([2a6e4efc](https://mobbin.com/screens/2a6e4efc-8dde-4efa-ba2c-eb27267ee582)), mymind "Good find! It's in your mind"([bc1fa1fd](https://mobbin.com/screens/bc1fa1fd-9d9c-4f9b-9f70-d427816835fd)).
- **공유 확장 "myco에 담기":** 누르면 바로 저장하고, 선택으로 메모 한 줄을 남깁니다. 목적지는 `_inbox/`("받은 자료")로 고정해 보여 줍니다. 정리 판단은 나중에 데스크톱이 하고 결과는 홈에 보입니다. payload는 데스크톱 클리퍼와 같은 `{url, title, selection}`(`clipper/background.js:9-14`)에 S39의 `note`를 더한 것이고, 파일은 데스크톱 클리퍼와 같은 `source: clipper` frontmatter로 씁니다(`src-tauri/src/clip.rs:205`). 그래야 `backlog.md` S25 (가)의 "사용자가 넣은 자료" 면제가 폰 클립에도 그대로 걸립니다. 근거: Matter "Saving…" 다음 태그·메모·보관([143f64c0](https://mobbin.com/flows/143f64c0-0aa7-41cd-8b75-e12f47ddbfe6)), Fabric "Say something about it… (optional)"과 목적지 칩([dfbd43eb](https://mobbin.com/screens/dfbd43eb-2e0d-482c-8924-72e57d939a9f)), Notion 공유 확장 모형([f999e32c](https://mobbin.com/screens/f999e32c-f6d8-4251-846b-2da3a4d3df2d)).
- **공유 확장 가르치기:** 첫 실행 팁과 설정에서 단계를 보여 줍니다. 근거: Apple Notes 첫 실행의 "Create Quick Notes Anywhere"([a5429bad](https://mobbin.com/flows/a5429bad-b542-4f21-afd8-630b5efc918b)), Cosmos의 확장 설치 안내([a8ecbff2](https://mobbin.com/flows/a8ecbff2-5d9c-45a9-9c1d-d33041bfb16b)).

### 편집기 도구 막대(3단계)

- MVP에서 노트는 읽기 전용으로 엽니다. 탭해도 키보드가 올라오지 않고 링크가 열립니다. 근거: Obsidian iOS는 읽기·편집 보기를 나누고 새 탭의 기본을 읽기로 고를 수 있게 합니다([f1a6d4a1](https://mobbin.com/screens/f1a6d4a1-719d-43a3-8532-fe7261f6151e), [54c00af4](https://mobbin.com/screens/54c00af4-c143-4537-86a0-30acf08e709f)). 지금 코드에는 `raw/` 파일만 여는 읽기 전용 Viewer 경로가 있습니다(`src/pages/PageReader.tsx:271-276`).
- 3단계 막대는 키보드 바로 위 한 줄 가로 스크롤입니다: 되돌리기, `[[`, `#`, 체크, 제목, 내어쓰기, 들여쓰기, ↑, ↓, + 블록, ⋮⋮, 키보드 내리기. 텍스트를 고르면 B, I, 형광, 코드, 링크로 바뀝니다. 모두 이미 있는 명령을 부릅니다(`src/lib/editorFormat.ts:572-580`, `src/lib/editorLists.ts:293-305`, `src/lib/editorBlockOps.ts:460-499`). 근거: Obsidian iOS([2092380b](https://mobbin.com/screens/2092380b-d5a6-48c2-910a-671dd80ed973), [1c499b24](https://mobbin.com/screens/1c499b24-8d6b-4b13-8e7b-3bd58693ba21)), Notion iOS([bb04ea66](https://mobbin.com/screens/bb04ea66-02e0-43ff-97ca-21dca43e7947), [011e1303](https://mobbin.com/screens/011e1303-32b9-4882-8d28-71b5b233c517)), Craft([6d762433](https://mobbin.com/screens/6d762433-bb52-4ff6-adc4-07d8a2e90b15)).
- 막대 버튼은 한국어 조합 중에 문서를 바꾸지 않습니다. one-editor 불변식 "A write waits for `compositionend`"(`docs/specs/2026-10-01-notion-blocks-one-editor.md:50-53`)를 따르고, 이미 쓰는 `view.composing` 가드(`src/lib/editorBlockHandle.ts:35`)를 재사용합니다(S51).
- 막대 구성 편집과 Bear식 키보드 대체 패널([59fa6333](https://mobbin.com/screens/59fa6333-106b-4839-81da-79a938280de4))은 쓰임을 본 뒤로 미룹니다.

### 터치로 다루는 블록(3단계)

- **추가:** ＋를 누르면 키보드 자리에 슬래시 항목(`src/lib/editorCompletions.ts:162-`)을 섹션별 2열 타일로 엽니다([23ebacc5](https://mobbin.com/screens/23ebacc5-4ddd-4afc-ae8e-3a07063e80cd), [b689e6c5](https://mobbin.com/screens/b689e6c5-62b4-48e9-83d0-76cc61b9966e)).
- **메뉴:** 캐럿이 있는 블록 옆 44px 핸들을 누르면 블록 Actions 시트가 열리고, 블록 종류별 항목이 맨 위, 삭제가 빨간 그룹으로 맨 아래에 옵니다([6ecea6c7](https://mobbin.com/screens/6ecea6c7-4682-4c35-b649-412a0a240738)). 지금 핸들은 hover 전용이고 20px입니다(`src/lib/editorBlockHandle.ts:47`, `:77-78`).
- **이동:** ↑↓ 버튼부터 시작합니다([bb04ea66](https://mobbin.com/screens/bb04ea66-02e0-43ff-97ca-21dca43e7947)). 터치 끌기는 미룹니다. macOS WebKit에서 HTML5 DnD가 동작하지 않아 pointer 방식만 쓰는 지금 제약(`src/lib/editorBlockHandle.ts:3`)도 그대로입니다.
- **표:** 진행 중 Notion 표 스펙에 맡기고 조건만 넘깁니다(`backlog.md` "진행 중 스펙에 넘길 조건"). 지금은 375px에서 셀을 탭하면 `| … |` 원문이 드러납니다(`audit-mobile/shots/i/375-table-rendered.png`).

### 폰에서 질문(MVP)

- 입력창은 바닥에 고정하고 첫 턴 뒤 페이지 머리를 접습니다(S32). 근거: ChatGPT·Claude iOS([8cf567ec](https://mobbin.com/screens/8cf567ec-633b-4d0b-81b8-4e05de5fdb9c), [7f9374bd](https://mobbin.com/screens/7f9374bd-79d3-4552-9fe0-bd26e76c94f9)).
- 답은 첫 구절 전부와 나머지 구절의 3줄로 시작합니다. 원문 인용이라 요약하지 않고 접기만 합니다(S32). 근거: 접힌 진행 줄과 ↓ 버튼([0c55f827](https://mobbin.com/screens/0c55f827-6928-446b-93f5-41c38ea8fee0), [b7355c29](https://mobbin.com/screens/b7355c29-b0a6-40f7-b41e-cba3c173428a)).
- 인용 번호를 누르면 출처 시트가 열리고, 답 아래 "출처 N개" 칩이 전체 목록을 엽니다(S33). 근거: ChatGPT iOS Sources 시트([3eaf4e44](https://mobbin.com/screens/3eaf4e44-fdce-48bc-965b-b194ed9c43ac)), Perplexity 번호 목록([95249214](https://mobbin.com/screens/95249214-093e-4d7a-afc1-6bbb951ea9ff)).
- 범위는 입력창 안 칩 "범위 · 내 노트 ▾"이고 시트에서 사람 말로 고릅니다(S33, Gemini [d6bb7092](https://mobbin.com/screens/d6bb7092-79e2-4627-bc41-9e35b3061620)).
- 기권하면 "내 노트에서 이 내용을 찾지 못했어요"와 [이 질문을 오늘 노트에 적어 두기]를 보입니다(S30, Bond [4b5284ea](https://mobbin.com/screens/4b5284ea-7e34-4b49-bb4d-ac4736afb9fd)). 폰에서는 이 버튼이 새 캡처 파일을 만듭니다. 데스크톱의 "나중에 채울 질문으로 표시"(recall-miss)는 저장 위치를 확인하지 않아 MVP에서 뺐습니다(추론).
- 질문 기록은 기기 안 앱 데이터에 남깁니다(S36, ChatGPT [ab1d0c55](https://mobbin.com/screens/ab1d0c55-4180-4ad4-b9b6-5a21242092f1), [2db4384c](https://mobbin.com/screens/2db4384c-4fd7-4b23-8612-251c6b59a99e)). 추출형은 IPC 한 번이라 멈춤 버튼이 필요 없습니다.
- 마이크는 OS 키보드 받아쓰기에 맡기고 음성 대화 모드는 만들지 않습니다(AM M7, ChatGPT 받아쓰기 [902347b7](https://mobbin.com/screens/902347b7-a516-4282-98b8-717cc859d39d)).
- 질문 탭 머리에 인덱스 상태 한 줄("이 기기에서 노트 71개를 색인했어요 · 아직 내려받지 않은 노트 3개")을 둡니다(S27, Crouton [2ec1d29c](https://mobbin.com/screens/2ec1d29c-8a03-4e15-9022-bdbc2c9de4dd)).
- 3단계: 구절 동작(복사, 노트에 인용, 원문 열기, 이 구절로 다시 묻기)은 길게 누르기에 걸지 않습니다. 원문을 인용하는 앱에서 길게 누르기는 iOS 기본 텍스트 선택이어야 사용자가 구절의 일부를 골라 복사할 수 있습니다. 대신 두 길을 둡니다. (1) 구절 머리의 ⋯ 버튼이 S33 출처 시트와 같은 항목을 엽니다. (2) 구절 안의 텍스트를 고르면(`selectionchange`로 감지) 선택 메뉴 옆에 "노트에 인용", "이 부분으로 다시 묻기"를 띄웁니다. 근거: Pocket은 선택 위에 Copy, Highlight, Translate, Share 메뉴를 띄우고([340108ed](https://mobbin.com/screens/340108ed-e7d6-4ea5-99ff-9f331c94b3be)), Medium은 선택 위에 Highlight, Respond, Share를 띄웁니다([b14f7259](https://mobbin.com/screens/b14f7259-5a06-4b23-aee7-d6a3d789b27a)). 앞 판이 근거로 든 LINE 말풍선 메뉴는 선택할 수 없는 말풍선에 거는 경우라 이 화면과 사정이 달라 뺐습니다. 수용 기준: 구절 안의 단어를 길게 눌러 선택하고 복사할 수 있습니다. ⋯ 버튼은 VoiceOver에서 "구절 1 메뉴"처럼 읽힙니다.

### 폰에서 그래프(3단계, 보기 전용)

- 캔버스가 상단과 아래 막대 사이 전체를 쓰고, 찾기·질문·필터는 ⚙로 여는 떠 있는 접이식 카드에 들어갑니다. '빈 곳'과 범례는 시트의 두 탭입니다(S53). 근거: Obsidian iOS([750d7b56](https://mobbin.com/screens/750d7b56-5e9f-45d3-a43e-9160b4181c3c), [a4e27535](https://mobbin.com/screens/a4e27535-090f-40de-81c2-fa8e83703b8b)).
- 첫 방문에 "끌어서 돌리기 · 두 손가락으로 확대 · 별을 눌러 노트 보기"를 한 번 보입니다(Obsidian Canvas [58242b18](https://mobbin.com/screens/58242b18-6679-468e-b059-54f082a8de4d)).
- 룩 고르기와 편집은 폰에 두지 않습니다. 연속 렌더 루프는 소유자가 의도한 결정이라 바꾸지 않고(`src/lib/graphScene.ts:4971`, `:5085-5087`), 배터리 영향은 SP-5에서 잽니다.
- 지금 375px 그래프는 캔버스 아래 117px이 잘리고 레일이 높이 0입니다(`audit-mobile/shots/375-ko-light-graph.png`, 폰 감사 M-07).

### 복습(3단계)

- 홈과 복습 탭이 덱 경계 없는 하나의 큐를 쓰고, 카드는 원문 문장과 출처 노트 이름, 버튼은 [기억 안 남] [기억남] 두 개이며 좌우로 밀어도 됩니다. 끝나면 "다음 복습: 내일 3장"을 보입니다(S34). 근거: Headway([3d987534](https://mobbin.com/flows/3d987534-1fb1-4502-872e-49e765b79e85), [e109ca23](https://mobbin.com/screens/e109ca23-95a1-4edd-94d8-704a97ad043b)), Quizlet([5dacac8f](https://mobbin.com/screens/5dacac8f-b958-417c-bae8-e70c4ac3273f)).
- 복습은 덱 파일을 고쳐 쓰므로 SP-4가 통과해야 켭니다.
- 위젯 후보는 오늘 복습 카드 앞면 한 장과 "N장 남음"입니다(Vocabulary [01b7b667](https://mobbin.com/screens/01b7b667-ea50-47ef-9e6f-e563030e0b36), Deepstash [a9dee944](https://mobbin.com/screens/a9dee944-e751-4b82-ab90-470dc9fb24d0)).

### 설정과 첫 실행

- 설정은 목록에서 상세로 들어가는 두 단계이고(S54), 기기마다 다른 항목에는 "이 기기에만 적용"을 답니다. 근거: Obsidian iOS 설정([074d1d45](https://mobbin.com/screens/074d1d45-ec3a-4267-9dae-b53f4402f83e), [3807f2b0](https://mobbin.com/screens/3807f2b0-21a0-4870-88f5-5234e8038674)), Notion "on this device"([d710fe22](https://mobbin.com/screens/d710fe22-f919-4fa8-8f2b-c57a5087ce17)).
- 저장 상태 행(볼트 위치, 아직 내려받지 않은 파일, 마지막 저장)을 첫 출시에 넣습니다(S27, MD Vinyl [2451dc46](https://mobbin.com/screens/2451dc46-c58d-472e-ba63-802790b155bc)). myco 자체 동기화가 없으므로 "동기화됨" 칩은 만들지 않습니다(ON B5).
- 첫 실행은 로컬 약속 한 문장, 볼트 위치 선택("나중에 바꿀 수 없어요" 한 줄), "계정 필요 없음", 팁 두 장 순서입니다. 근거: Obsidian iOS 첫 화면([e77414c6](https://mobbin.com/screens/e77414c6-2bee-4455-be64-60b7887b75f5)), 볼트 만들기 흐름([34928d68](https://mobbin.com/flows/34928d68-f70f-4fb2-8379-a5cf8f7303c6)), 계정 문구([b21b6b48](https://mobbin.com/flows/b21b6b48-0b88-4dba-8df8-db79d01a7076)), 동기화 설명과 "Continue without sync"([c464d280](https://mobbin.com/screens/c464d280-72a1-4984-b7b9-02bed72b99db)), Notion 팁 캐러셀([2ada33fc](https://mobbin.com/flows/2ada33fc-fedc-4d26-a89a-96714e261e81)).

## 저장과 동기화 모델

### 볼트 위치

- **권장:** iCloud Drive 폴더. Mac의 데스크톱 myco가 같은 폴더를 볼트로 엽니다. 구현은 두 갈래이고 SP-3에서 고릅니다. (가) myco 앱의 iCloud 컨테이너(Obsidian "Store in iCloud"와 같은 모양), (나) 사용자가 고른 폴더를 `UIDocumentPickerViewController(forOpeningContentTypes: [.folder])`로 받고 security-scoped bookmark로 저장(타당성 1-B, 3-B). 어느 쪽이든 Tauri 공식 플러그인에는 없으므로 Swift 플러그인이 필요합니다. dialog 플러그인은 모바일에서 폴더 선택을 지원하지 않습니다(타당성 0절 3, v2.tauri.app/plugin/dialog).
- **대안:** 이 기기에만(앱 Documents, iOS Info.plist에 `UIFileSharingEnabled`와 `LSSupportsOpeningDocumentsInPlace`를 넣으면 Files 앱에 보입니다). iOS Info.plist는 아직 없고 `tauri ios init` 때 생성됩니다. 지금 저장소의 `src-tauri/Info.plist`는 macOS 번들에 합쳐지는 파일입니다(`src-tauri/Info.plist:3-5` "macOS denies getUserMedia"). 데스크톱과 나누지 않는 사람을 위한 선택입니다.
- Obsidian iOS는 `iCloud Drive/Obsidian` 폴더 안이나 기기 안의 볼트만 엽니다(https://obsidian.md/help/sync-notes, https://forum.obsidian.md/t/full-file-system-access-for-the-ios-app-open-existing-vault-folder/28266). 그래서 (가)를 고르면 Obsidian iOS와 볼트를 나눌 수 없고, (나)에서 Obsidian 폴더를 고를 때만 나눌 수 있습니다. myco가 그 폴더를 문서 선택기로 열 수 있는지는 확인하지 못했습니다(타당성 6절). 이 차이는 "왜 이 안인가" 4번의 편집 판단과 묶여 있습니다.
- Windows 데스크톱과 iPhone 조합은 iCloud for Windows가 파일 중복이나 손상을 일으킬 수 있다는 Obsidian 도움말 경고가 있어(타당성 4절 B 위험) 첫 출시에서 지원 범위 밖으로 적습니다.

### 무엇이 오가고 무엇이 기기에 남나

| 항목 | 위치 | 동기화 |
|---|---|---|
| 노트, `daily/`, `cards/`, `_inbox/`, `raw/` | 볼트 폴더 | iCloud가 옮깁니다. 데스크톱 distill이 `raw/` 파일을 `raw/archive/`나 `_inbox/quarantine/`으로 옮기면 그 이동도 폰에 퍼집니다(`backlog.md` B1) |
| `.git`(변경 이력) | 볼트 루트(`src-tauri/src/vault_history.rs:63`, `:77`) | 볼트가 iCloud에 있으면 같이 옮겨집니다. 폰은 쓰지 않습니다. iCloud 안의 git 저장소는 충돌 사본이 생기거나 객체 파일이 내려가 손상될 위험이 있습니다(추론). 데스크톱의 "볼트를 iCloud로 옮기기" 작업에서 처리합니다 |
| `.myco/`(distill 설정 `distill.json`, 상태 `distill-state.json`, 실행 기록 `distill-runs/`, 휴지통 `trash/`, 질문 실패 기록 `eval/`) | 볼트 루트(`src-tauri/src/vault_dir.rs:22-24`, `src-tauri/src/distill.rs:128-130`, `:181`, `:2447`, `:2742`, `src-tauri/src/commands.rs:2874`) | 같이 옮겨집니다. 폰 MVP는 읽지도 쓰지도 않습니다. 휴지통의 지운 파일 내용도 iCloud에 올라가고, 두 Mac이 같은 볼트를 열면 상태 파일이 충돌할 수 있습니다(추론) |
| 벡터 인덱스 | 앱 데이터 디렉터리, 볼트 id 키 | 옮기지 않습니다. 기기마다 만듭니다. 지금 키가 절대 경로 해시라 옮겨도 쓸 수 없고(`src-tauri/src/vector_index.rs:109-115`), 옮기면 충돌 위험만 생깁니다(타당성 3-G) |
| 질문 기록, 기기별 설정 | 앱 데이터 디렉터리 | 옮기지 않습니다 |
| API 키 | iOS 키체인(`keyring` apple-native, `src-tauri/src/secrets.rs:5`) | 옮기지 않습니다. MVP는 생성 모델을 쓰지 않아 키가 필요 없습니다 |

인덱스는 처음 열 때 만들고, 앱이 앞으로 돌아올 때마다 바뀐 파일만 다시 읽습니다(`file_mtimes` 명령이 있습니다, `src-tauri/src/lib.rs:164`). `notify` 감시가 iOS에서 동작하는지는 확인하지 못했고 백그라운드에서는 어차피 멈춥니다(타당성 1-B).

### 쓰기 규칙

| 경로 | 폰 MVP | 폰 3단계 | 데스크톱 |
|---|---|---|---|
| `raw/` | 읽기만 | 읽기만 | 읽기만(`is_raw_path`, `src-tauri/src/vault.rs:209`). 단 distill의 격리 이동과 보관 이동은 예외입니다(`src-tauri/src/distill.rs:682-694`, `:2680-2735`, 소유자 결정 `backlog.md` B1) |
| `_inbox/` | 링크·사진·파일의 새 파일 만들기만(고유 이름) | 같음 | 자료 추가가 처리하고, distill이 판정합니다 |
| `_inbox/capture/` | 텍스트 메모의 새 파일 만들기만 | 같음 | 오늘 노트로 접은 뒤 지웁니다. distill과 자료 추가는 보지 않습니다 |
| `daily/` | 쓰지 않음(텍스트 캡처는 `_inbox/capture/`로) | SP-4 뒤 한 줄 덧붙이기 | 덧붙이기 |
| `wiki/`와 사용자 노트 | 읽기만 | SP-4 뒤 편집(충돌 감지 포함) | 편집 |
| `cards/` | 읽기만 | SP-4 뒤 복습 기록 | 쓰기 |
| 삭제 | 없음 | 볼트 안 앱 수준 휴지통(`trash` 크레이트는 모바일 미지원) | OS 휴지통(`src-tauri/src/vault.rs:875`) |

새 파일만 만들면 두 기기가 같은 파일을 동시에 고치는 일이 없으므로 iCloud 충돌 사본이 생길 자리가 없습니다(추론, SP-4에서 확인).

### `raw/` 불변을 지키는 방법

- 폰 앱은 데스크톱과 같은 Rust 볼트 계층을 쓰고, `raw/` 경계는 `is_raw_path` 한 곳에서 정의됩니다(`src-tauri/src/vault.rs:200-214`). 폰 MVP에는 `raw/`로 가는 쓰기 경로가 아예 없습니다. 공유 확장은 App Group 컨테이너에 파일을 두고, 앱이 앞으로 올 때 `_inbox/`로만 옮깁니다(타당성 3-D).
- 수용 조건으로 폰 빌드의 모든 쓰기 명령이 `raw/` 경로를 거절하는 `cargo test`를 두십시오. 비슷한 테스트(`rewrite_backlinks_never_touches_raw`, `src-tauri/src/vault.rs:1843`)가 이미 있습니다.
- 아직 내려받지 않은 파일의 내려받기(`startDownloadingUbiquitousItem`)는 내용을 바꾸지 않는 읽기입니다(추론).
- 데스크톱은 예외가 있습니다. distill이 `raw/` 파일을 `_inbox/quarantine/`으로 옮기고 기한 뒤 휴지통을 거쳐 지울 수 있으며, 이미 반영된 원문은 `raw/archive/`로 옮깁니다(`backlog.md` B1). 볼트가 iCloud에 있으면 이 이동이 폰에도 퍼집니다. 폰 인덱스는 옛 경로를 들고 있다가 다음 포그라운드 재스캔(`file_mtimes`)에서야 바뀌고, 폰 Ask의 인용이 가리키는 `raw/<파일>` 경로가 그 사이 사라질 수 있습니다(추론). B1 결정 전에는 이 경로를 막을 수 없으므로 SP-4에서 확인합니다.
- 다른 기기나 다른 앱(Obsidian iOS 등)이 `raw/`를 고치는 것은 myco가 막을 수 없습니다. iCloud가 `raw/` 안에 충돌 사본을 만들면 저장 상태(S27)에 보이고 자동으로 합치지 않습니다(추론).

### local-first 점검

- myco 서버가 없습니다. 노트는 사용자의 기기와 사용자가 고른 iCloud에만 있습니다.
- 질문은 기기 안에서 답하므로 노트 구절이 기기 밖으로 나가지 않습니다.
- 임베더 스파이크가 실패해도 클라우드 임베딩으로 돌아가지 않습니다(타당성 5절 1).

## 위험과 먼저 검증할 것

### 스파이크

| ID | 질문 | 방법 | 성공 기준 | 실패하면 |
|---|---|---|---|---|
| SP-1 | iOS로 빌드되는가 | `#[cfg_attr(mobile, tauri::mobile_entry_point)]`(`src-tauri/src/lib.rs:114`), tray·global-shortcut·updater·macos-private-api·spotlight를 `cfg(desktop)`으로 막기(`src-tauri/Cargo.toml:22, 29, 69`, `src-tauri/src/tray.rs:15`, `src-tauri/src/spotlight.rs:19-20`). `trash`와 `notify`도 막거나 대체하기(타당성 4절 옵션 A 작업 목록, `mobile-feasibility.md:192`). `trash`는 조건 없이 들어가는 의존성이고(`src-tauri/Cargo.toml:61-63`) Windows, macOS, FreeDesktop만 지원하므로(`mobile-feasibility.md:51`) `src-tauri/src/vault.rs:875`의 삭제를 볼트 안 앱 수준 휴지통으로 바꿔야 합니다. `notify`(`src-tauri/Cargo.toml:68`, `src-tauri/src/index_updater.rs:373-392`)는 모바일 지원이 미확인이라 포그라운드 재스캔으로 대체합니다. `tauri ios init`, iOS 타깃과 SDK 설치 | 시뮬레이터에서 앱이 뜨고, 샌드박스 볼트를 seed해(`src-tauri/src/vault.rs:298-313`) 노트 목록이 보입니다 | 어느 의존성이 막는지 목록을 만들어 범위를 다시 잡습니다. 비슷한 Tauri 마크다운 앱의 iOS 포팅 PR이 같은 목록을 막았지만 병합되지 않았습니다(타당성 3-A) |
| SP-2 | 임베더가 폰에서 도는가 | `llama-cpp-2`를 iOS로 링크, 노트 10개 임베딩, 실기기에서 1k–2k쪽 볼트 색인. 코드는 이 규모를 기준으로 설계돼 있습니다(distill 주석 "26 MB at 1.7k files", `src-tauri/src/distill.rs:607-608`, 벡터 저장소 "≤~10k pages", `src-tauri/src/vector_index.rs:3-4`) | 전체 색인 시간, 상주 메모리, **임베딩 호출 한 번의 순간 메모리 피크**를 기록합니다. 임베딩 compute buffer는 가장 긴 텍스트의 토큰당 약 1 MiB라서 `CHUNK_TOKENS = 320`이면 호출마다 약 320 MiB까지 순간적으로 늘어납니다(`src-tauri/src/embeddings.rs:15-24`). jetsam으로 앱이 죽을 위험은 mmap되는 모델 가중치보다 이 순간 피크에서 옵니다(추론). 고정 질문 10개에서 데스크톱과 같은 인용과 같은 기권을 냅니다 | 피크가 견디지 못하면 모바일에서 `CHUNK_TOKENS`를 줄이는 안을 검토합니다. 피크는 줄지만 청크 단위가 바뀌어 유사도 분포가 달라지므로, 바닥선을 다시 재야 하고 데스크톱과 같은 인용·기권을 낸다는 약속이 깨질 수 있습니다(추론). 그다음 Core ML 변환이나 BM25 전용 Ask를 검토합니다. BM25 전용은 dense 코사인 바닥선이 없어 기권 판정이 달라지므로 따로 설계해야 합니다(추론). 클라우드 임베딩은 제외합니다 |
| SP-3 | iCloud 폴더를 안전하게 읽는가 | Swift 플러그인으로 (가) 앱 컨테이너 또는 (나) 폴더 선택과 bookmark, `NSFileCoordinator`, 아직 내려받지 않은 파일의 감지(`NSURLUbiquitousItemDownloadingStatusKey`, iOS에서 `.icloud` stub이 실제로 쓰이는지도 확인)와 내려받기, 재실행 뒤 경로 변경(Apple DTS: 컨테이너 경로는 바뀔 수 있음). (나)에서는 `iCloud Drive/Obsidian/<볼트>`를 고를 수 있는지도 확인합니다 | Mac 데스크톱과 폰이 같은 볼트를 열고, Mac에서 고친 노트가 폰 Ask에 반영되며, 내려받지 않은 파일 수가 보입니다. 어느 안을 골랐는지에 따라 "Obsidian iOS로 편집 가능"을 지원 범위에 적을지 정합니다 | 이 기기에만 볼트로 MVP를 내면 데스크톱 노트가 폰에 없어 질문 가치가 거의 없습니다(추론). 이 경우 데스크톱 원격안을 다시 비교합니다 |
| SP-4 | 쓰기가 충돌하지 않는가 | **변경 이력(git)이 켜진 볼트**로 합니다. 두 기기를 모두 오프라인으로 두고 폰은 `_inbox/capture/` 메모와 `_inbox/` 링크 캡처, 데스크톱은 노트 편집과 오늘 노트 덧붙이기를 합니다. 다시 연결한 뒤 데스크톱에서 **distill을 한 번 돌리고**(위키 50쪽 이상으로 게이트를 켠 볼트), 그다음 폰에서 Ask를 합니다 | 잃어버린 파일과 충돌 사본이 없습니다. `.git` 안에도 충돌 사본이 없고 `git fsck`가 통과합니다. distill 뒤에도 캡처는 격리되지 않고 오늘 노트로 접힙니다. distill이 `raw/` 파일을 옮겼다면 폰 Ask의 인용이 가리키는 경로가 유효합니다(포그라운드 복귀 재스캔 뒤 다시 열 수 있음). 같은 실험을 `daily/`, `cards/` 덧붙이기로 반복해 3단계 범위를 정합니다 | 3단계 편집과 복습에 충돌 감지와 사용자 선택 화면을 더합니다. 인용 경로가 깨지면 B1 결정을 앞당기거나 폰이 경로 대신 stem으로 노트를 찾게 합니다 |
| SP-5 | WKWebView에서 입력과 접근성이 맞게 도는가 | 실기기에서 `viewport-fit`과 안전 영역, `visualViewport` 키보드 이벤트, 16px 미만 입력 확대, 길게 누르기, OrbitControls 핀치, iPad 하드웨어 키보드 이벤트, 그래프 연속 렌더 배터리. **한국어 IME:** iOS 한국어 두벌식과 천지인 키보드로 홈 입력, ⌘K(아래 피커), 노트 제목, 할 일 입력, 표 셀, 키보드 위 도구 막대를 씁니다. one-editor 스펙은 WKWebView 한국어 조합을 "Not checkable here"로 남겼습니다(`docs/specs/2026-10-01-notion-blocks-one-editor.md:177-178`). **접근성:** VoiceOver로 트리 행 ⋯ 메뉴, Ask 구절 ⋯ 메뉴, 할 일 상태 칩, 아래 막대를 끝까지 씁니다. 설정 앱의 글자 크기를 가장 크게 바꾸고 "시스템 설정 따르기"(S22)에서 본문이 커지는지 봅니다 | S47, S48, S50, S53의 추론 항목을 확인하거나 고칩니다. 조합 중 Enter나 탭이 미완성 음절을 잃지 않습니다(S13, S16, S21, S50, S51). 끌기나 길게 누르기 없이 모든 동작에 닿습니다(S49, S52). 가장 큰 글자에서 가로 넘침이 없습니다 | 해당 슬라이스를 수정합니다 |
| SP-6 | 공유 확장을 붙일 수 있는가 | `tauri-apple-extensions`(Share Extension 전용, XcodeGen 필요, stars 7) 또는 직접 만든 Xcode 타깃, App Group으로 넘기기 | Safari에서 공유하면 앱을 열지 않고 저장되고, 앱을 열면 `_inbox/`에 파일이 있습니다 | 앱 안 "링크 붙여넣기"만 MVP에 남깁니다 |

### 그 밖의 위험

- **Tauri 모바일 파일 접근:** iOS 파일 선택기의 security-scoped 처리 누락 결함이 열려 있습니다(plugins-workspace #3030, 타당성 3-A).
- **App Store 4.2:** 웹사이트를 다시 싼 앱으로 보일 위험이 있습니다. 기기 안 볼트, 기기 안 질문, 공유 확장이 반증입니다(타당성 3-F).
- **App Store 2.5.2:** vault의 `main.js`를 Worker에서 실행하는 코드 플러그인(`src/lib/pluginSandbox.ts:1-18`)이 걸릴 수 있어 MVP에서 뺐습니다.
- **App Store 3.1.1과 3.1.3(b):** myco Pro를 iOS에서 쓰게 하려면 StoreKit IAP 코드가 앱에 들어가야 하고, 결제 코드를 공개 저장소 밖에 둔다는 방침과 맞지 않습니다. 한국 스토어의 대체 결제 규정은 확인하지 못했습니다(타당성 3-F).
- **큰 볼트의 첫 색인:** 시간, 배터리, 순간 메모리를 재지 않았습니다. SP-2에서 1k–2k쪽 수치를 보고 진행 표시와 "충전 중일 때 색인" 같은 선택이 필요한지 정하십시오.
- **데스크톱 distill의 `raw/` 이동:** 격리와 보관 이동이 iCloud로 폰에 퍼지고, 격리된 `raw/` 파일은 약 60일 뒤 지워질 수 있습니다(`backlog.md` B1). 폰 인덱스와 `[^src-*]` 인용 경로가 바뀝니다. SP-4에서 확인하고, B1 결정 전에는 볼트 공유를 출시하지 마십시오.
- **볼트 안 `.git`과 `.myco/`의 동기화:** iCloud 안의 git 저장소와 distill 상태 파일은 충돌 사본과 내려간(evicted) 파일의 위험이 있습니다(추론). "볼트를 iCloud로 옮기기" 작업과 SP-4에서 다룹니다.
- **한국어 IME:** 데스크톱 WKWebView에서도 소유자 확인으로 남은 항목이고, 폰 소프트 키보드에서는 새로 만드는 입력 경로(아래 피커, 도구 막대, 제목 입력, 날짜 칩)마다 다시 깨질 수 있습니다. SP-5에서 확인합니다.
- **접근성:** 숨은 제스처만으로 닿는 기능은 VoiceOver 사용자가 쓰기 어렵습니다. 모든 동작에 보이는 버튼 경로를 두고(`backlog.md` S49, S52) SP-5에서 확인합니다.
- **Android:** Mobbin 근거가 없고 SAF가 경로 대신 URI를 줘서 `std::fs` 계층과 맞지 않습니다(타당성 3-B). 4단계로 미뤘습니다.

### 소유자 결정

1. 데스크톱 distill이 `raw/`를 옮기거나 지울 수 있게 둘지(`backlog.md` B1, 권장: 보관 이동만 허용하고 격리·휴지통은 금지). 볼트 공유보다 먼저 정해야 합니다.
2. 폰 첫 버전에서 기존 노트 편집과 복습 기록을 뺄지(권장: 뺍니다). SP-3에서 (가)를 고르면 폰에서 노트를 고칠 길이 아예 없다는 점을 받아들이는 결정이기도 합니다.
3. 볼트 위치 기본값을 iCloud Drive로 할지, 이 기기에만으로 할지(권장: iCloud Drive, SP-3 결과에 따라). iCloud Drive라면 (가) myco 컨테이너와 (나) Obsidian 폴더를 포함한 사용자 선택 중 무엇으로 할지.
4. 변경 이력이 켜진 볼트를 iCloud로 옮길 때 `.git`을 어떻게 할지(권장: 저장소 본체는 Mac 로컬, 볼트에는 gitfile).
5. myco Pro를 iOS에 낼지와 그 결제 코드를 어디에 둘지.
6. 코드 플러그인을 모바일에서 허용할지.
7. 질문 기록을 기기 안에 둘지 볼트 안에 둘지(S36, 권장: 기기 안).

## 검증한 것과 추론한 것

- **검증(보고서가 실행하거나 읽음):** 모바일 진입점 없음, 데스크톱 전용 의존성(`trash`, `notify` 포함), 번들 타깃 `dmg`/`nsis`, 창 `minWidth: 800`, 외부 프로세스 모듈 15개, `raw/` 경계 함수, 인덱스 키 형식, 임베딩 모델 크기, 임베딩 순간 메모리 주석(약 320 MiB), distill의 inflow 범위와 `raw/` 이동·삭제 경로와 기본값, 자료 추가가 `_inbox/` 바로 아래만 읽는 점, 볼트 루트의 `.git`과 `.myco/`, 데스크톱 기본 볼트 위치는 코드로 확인했습니다. Rust `st_flags()`는 이 기계에서 컴파일하고 실행해 봤습니다. Obsidian iOS의 볼트 위치 제한은 Obsidian 도움말과 포럼에서, Sonoma의 dataless 파일은 Eclectic Light 글에서 확인했습니다. 375·390·820·1180 화면 측정은 Chromium 터치 에뮬레이션(폰 감사)과 Playwright WebKit 데스크톱 에뮬레이션(타당성, ON)입니다. 인용한 Mobbin 화면과 플로우는 각 보고서가 이번 세션에서 받아 본 것입니다.
- **추론:** iOS 빌드 가능성, 폰 임베딩 성능과 jetsam 위험, `CHUNK_TOKENS`를 줄이면 바닥선을 다시 재야 한다는 점, iCloud 안 git 저장소의 손상 위험과 gitfile 방식이 myco에서 동작한다는 점, 새 파일만 쓰면 충돌이 없다는 점, 일반 사용자가 집 밖에서 묻는다는 점, iCloud 앱 컨테이너가 bookmark보다 단순하다는 점, 데스크톱 캡처 접기 형식, BM25 전용 대안의 기권 차이.
- **확인하지 못함:** 실기기 동작 전부, 소프트 키보드와 한국어 IME, VoiceOver와 Dynamic Type, 안전 영역, 핀치, `notify`와 `keyring`의 모바일 컴파일, Obsidian iCloud 폴더를 myco가 여는 것, iOS가 `.icloud` stub과 dataless 중 무엇을 쓰는지, 실제 iCloud 볼트에서의 dataless 판별, distill 자동 실행 경로(백그라운드 스케줄), Android 화면 근거.
