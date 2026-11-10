# myco 모바일 버전 기술 타당성 (2026-10-01)

대상: `~/prj/karpathy-editor-build/app` (branch `feat/permit-editor-ux`), Tauri 2 + React 18 + CodeMirror 6.
이 문서는 읽기 전용 조사 결과입니다. 저장소는 수정하지 않았고, 산출물은 이 파일과 `mobile-shots/*.png`, 스크립트 3개(`probe.cjs`, `shots.cjs`, `ipad.cjs`)뿐입니다.

표기 규칙: **[검증]** 직접 실행하거나 원문을 읽어 확인한 것 · **[추론]** 코드/문서를 근거로 추론한 것(실행 안 함) · **[미확인]** 확인하지 못한 것.

---

## 0. 결론 먼저

1. **지금 코드는 iOS/Android로 빌드되지 않는다 [추론].** `run()`에 `#[cfg_attr(mobile, tauri::mobile_entry_point)]`가 없고(`src-tauri/src/lib.rs:114`), 데스크톱 전용 API(트레이·전역 단축키·추가 창·업데이터)가 `cfg(desktop)` 게이트 없이 컴파일된다(`Cargo.toml:22,29,69`, `tray.rs:15`, `spotlight.rs:19-20`). `src-tauri/gen/`에는 `schemas/`만 있고 `apple/`·`android/` 프로젝트가 없다 [검증]. 이 기계에는 iOS Rust 타깃도 iOS SDK도 없어서(`rustup target list --installed` → `aarch64-apple-darwin`뿐, `xcrun --sdk iphoneos` 출력 없음) 실제 모바일 컴파일은 하지 못했다.
2. **핵심 가치(로컬 마크다운 + 추출형 Ask)는 순수 Rust + llama.cpp 임베더라서 이식 가능성이 높다 [추론].** Ask의 BM25·dense·RRF·intent 판정은 모두 임베딩과 파일 읽기로 끝난다(`intent.rs:1-15`, `vector_index.rs:1-7`). 번들 임베딩 모델은 39.7 MB(`models/multilingual-e5-small-ko-v2-q8_0.gguf`, `tauri.conf.json:62`)로 폰에 부담이 크지 않은 크기다. 남는 위험은 `llama-cpp-2`의 iOS/Android 크로스 빌드 하나이고, 이건 아직 검증하지 못했다.
3. **가장 큰 벽은 UI가 아니라 "파일이 어디에 있느냐"다.** Tauri 공식 dialog 플러그인은 모바일에서 **폴더 선택을 지원하지 않는다**(https://v2.tauri.app/plugin/dialog/, 2024-11-01 갱신). 그래서 지금 온보딩(`OnboardingWizard.tsx:90` → `ipc.ts:932` `open({ directory: true })`)은 모바일에서 동작하지 않는다. Android는 SAF가 경로가 아니라 URI를 돌려주므로 `std::fs`로 짠 Rust 계층 전체와 맞지 않는다.
4. **권장 경로: 같은 코드베이스로 "컴패니언"(읽기 + 캡처 + 추출형 질문)부터 낸다.** 첫 대상은 iOS(앱 샌드박스 vault, Obsidian iOS와 같은 모델)로 잡는다. iPad에서는 지금 데스크톱 레이아웃이 그대로 잘 나온다(스크린샷 09). 그래서 iPad는 따로 만들지 않아도 같이 따라온다. PWA 리더는 iOS에서 로컬 폴더를 읽을 방법이 없어 local-first 원칙과 충돌하므로 권하지 않는다.

---

## 1. 기능별 분류: 그대로 / 모바일 어댑터 필요 / 데스크톱 전용

모든 행은 코드만 읽고 판단했다 [추론]. 모바일용으로 컴파일해 보지는 않았다.

### 1-A. 모바일에서 그대로 동작할 가능성이 높은 것

| 기능 | 근거 | 비고 |
|---|---|---|
| vault 파일 CRUD(읽기·쓰기·이름 변경·이동) | `vault.rs:1084` `list_files`, `vault.rs:1207` `walk_dir`(std::fs) | 앱 샌드박스 안의 실제 경로라면 그대로 동작한다. 삭제는 1-B 참고 |
| 링크 그래프, BM25, RRF, intent 판정 | `index.rs`, `retrieval.rs`, `intent.rs:1-15`("Query-intent detection by embedding similarity") | 임베더만 있으면 된다(1-B llama 행) |
| 벡터 저장소 | `vector_index.rs:1-7` 무차별 탐색(brute-force), 바이너리 파일 | 384-d(`local_llm.rs:90`)라 폰 메모리에 부담이 작을 것으로 본다 [추론] |
| 프런트엔드(React, CM6, markdown-it, pdfjs, mermaid, three/sigma) | `package.json` dependencies | CodeMirror는 "Use the platform's native selection and editing features on phones"라고 명시한다(https://codemirror.net/) |
| HTTP LLM 프로바이더(anthropic-api, openai-api, google-api, openrouter) | `providers.rs:6-12`, `Cargo.toml:36` reqwest rustls | 네트워크만 있으면 된다. CLI 경로(`anthropic-cli`)는 1-C |
| YouTube 자막 가져오기 | `youtube.rs`(HTTP) | |
| 알림 | `lib.rs:125`, 플러그인 표 iOS ✅ / Android ✅ | 아래 Tauri 플러그인 표 참고 |
| 파일 하나 선택 | `ipc.ts:936-943` `pickImageFile` 등 | dialog 플러그인은 모바일에서 파일 선택을 지원한다. 단 경로 형식이 다르다(1-B) |
| 선언형/샌드박스 코드 플러그인 | `plugins.rs:1-7`(코드 실행 없음), `lib/pluginSandbox.ts:1-18`(Blob Web Worker) | 기술적으로는 WebView 안에서 돈다. App Store 2.5.2 위험은 3-F |
| 포인터 이벤트 드래그(작업 보드·캘린더) | `lib/pointerDrag.ts:1-11` | HTML5 DnD가 아니라 pointer 이벤트라 터치에서도 동작할 것으로 본다 [추론] |
| OS 버전 문자열 | `crash.rs:168-171` 기타 OS fallback 있음 | |
| 반응형 셸 | `styles.css:7063-7183`(768px 이하에서 오프캔버스 사이드바, 44px 터치 타깃) | 폰 폭 실측은 2절 |

### 1-B. 모바일 어댑터가 필요한 것

| 기능 | 근거 | 무엇이 깨지는가 | 모바일 대안 |
|---|---|---|---|
| 앱 진입점 | `lib.rs:114` `pub fn run()`(속성 없음). `Cargo.toml:11-13` crate-type은 이미 `staticlib/cdylib/rlib` | 모바일 진입점 매크로가 필요하다(https://v2.tauri.app/start/migrate/from-tauri-1/, 2026-06-15) | `#[cfg_attr(mobile, tauri::mobile_entry_point)]` 한 줄 추가 |
| 앱 데이터 디렉터리 | `settings.rs:262-285` `data_dir_on`: macos/windows가 아니면 `_` 분기로 `$HOME/.config/<name>` | iOS도 `_` 분기로 떨어진다. 컨테이너 루트에 `.config`를 만들 수 있는지는 [미확인] | Tauri `app.path().app_data_dir()`로 바꾼다 |
| 절대 경로 저장 | `settings.rs:557-565` `set_active_vault`/`active_vault`(절대 경로). `vector_index.rs:109-115` 인덱스 파일명 = 절대 vault 경로의 해시 | iOS는 앱 컨테이너 경로가 바뀔 수 있다. Apple DTS: "the path to your app's container can change", 상대 경로나 bookmark를 저장하라(https://developer.apple.com/forums/thread/92693, 2017-11). 경로가 바뀌면 vault가 "사라지고" 인덱스는 고아가 된다 [추론] | 컨테이너 기준 상대 경로나 bookmark로 저장하고, 인덱스 키를 vault id로 바꾼다 |
| 기본 vault 위치 | `vault.rs:298-313` `$HOME/Documents/myco` | iOS에서는 앱 자신의 Documents가 된다. Files 앱에 보이려면 Info.plist에 `UIFileSharingEnabled` + `LSSupportsOpeningDocumentsInPlace`가 필요하다(Apple Launch Services Keys, 검색 요약: https://developer.apple.com/library/archive/documentation/General/Reference/InfoPlistKeyReference/Articles/LaunchServicesKeys.html). 지금 `Info.plist:8-9`에는 마이크 키만 있다 | 그대로 쓰고 plist 키 2개만 추가하면 Obsidian iOS의 "On My iPhone" 모델과 같아진다 |
| vault 폴더 선택 | `ipc.ts:931-934` `open({ directory: true })`. 호출처 `OnboardingWizard.tsx:90`, `pages/settings/Account.tsx:79` | dialog 플러그인 표에 Android/iOS "Does not support folder picker"(https://v2.tauri.app/plugin/dialog/) | iOS: `UIDocumentPickerViewController(forOpeningContentTypes: [.folder])` + security-scoped bookmark를 Swift 플러그인으로 만든다(https://developer.apple.com/documentation/uikit/providing-access-to-directories). Android: 3-B 참고 |
| 외부 파일 가져오기 | `commands.rs:843` `read_external_text`, `:1164` `copy_into_inbox`, `:1533` `import_paths`(문자열 경로를 `std::fs`로 읽음) | Android dialog는 content URI를 돌려준다. iOS는 `file://` URI이고 security scope가 필요하다(https://v2.tauri.app/plugin/dialog/, https://v2.tauri.app/reference/javascript/dialog/ `fileAccessMode: copy/scoped`) | 기본 `copy` 모드로 샌드박스에 복사한 뒤 기존 명령에 넘긴다 |
| PDF/스프레드시트 추출 | `extract.rs:40-60` 자기 자신을 `--extract-text`로 다시 실행(`main.rs:10-24`) | iOS 앱은 자식 프로세스를 만들 수 없다. Apple DTS: "iOS apps are not allowed to spawn child processes"(https://developer.apple.com/forums/thread/747499, 2024-02). 코드는 `current_exe()`가 실패할 때만 in-process로 fallback하므로, spawn이 실패하면 `Err`로 끝난다 [추론] | in-process 추출로 바꾼다. 다만 `panic = "abort"`(`Cargo.toml:121`)라서 파서가 죽으면 앱 전체가 죽는다. 이 격리 손실을 감수할지 정해야 한다 |
| 휴지통 삭제 | `vault.rs:875` `trash::delete` | trash 크레이트는 Windows/macOS/FreeDesktop만 지원한다(https://docs.rs/crate/trash/latest) | vault 내부 `.trash/` 같은 앱 수준 휴지통 |
| API 키 보관 | `secrets.rs:5` `keyring::Entry`, `Cargo.toml:39` | keyring 3.x의 `apple-native`는 macOS와 iOS를 덮지만 Android는 지원 목록에 없다(https://docs.rs/keyring/3.6.3/keyring/) | iOS는 그대로 둔다. Android는 Keystore 어댑터가 필요하다(후보 크레이트 미검증) |
| 파일 감시 | `index_updater.rs:373-392` `notify::recommended_watcher` | 모바일 백엔드 지원 여부는 문서에서 확인하지 못했다(https://docs.rs/notify/8.2.0/notify/) [미확인]. 앱이 백그라운드에 있으면 어차피 중단된다 | 포그라운드 복귀 때 재스캔한다(`file_mtimes` 명령이 이미 있다, `lib.rs:164`) |
| 메모리 압박 감지 | `index_updater.rs:229-238` `sysctl` 프로세스 실행 | iOS에서는 spawn이 실패하고 "압박 없음"으로 처리된다. 안전하긴 하지만 압박을 못 본다 [추론] | OS 메모리 경고 콜백 |
| 임베딩 모델(llama.cpp) | `Cargo.toml:46` `llama-cpp-2`(macOS는 Metal 기본), `local_llm.rs:1-24` | 크로스 컴파일이 필요하다. Android는 `cargo ndk`로 `llama-cpp-sys-2`를 빌드해 APK에 넣은 사례가 있다(https://github.com/m96-chan/PAIR4Droid/issues/20, 2026-09-05, PR로 종료). iOS용 llama-cpp-2 빌드 사례는 찾지 못했다 [미확인] | 0단계 스파이크에서 첫 번째로 검증할 항목 |
| 음성 전사 | `whisper.rs:1-6` 사이드카 `whisper-cli`(`tauri.conf.json:64` externalBin), `whisper.rs:43-46` 190 MB 모델 다운로드 | iOS는 사이드카를 실행할 수 없다(위 DTS 답변) | whisper.cpp를 라이브러리로 링크한다. whisper.cpp README는 iOS/Android 예제(`whisper.objc`, `whisper.android`)를 제공한다(https://github.com/ggml-org/whisper.cpp). 다른 길은 OS 음성 인식 API |
| 외부 링크 열기 | `commands.rs:3582-3597` `open` / `cmd` / `xdg-open` | iOS와 Android는 else 분기(`xdg-open`)로 가서 실패한다 [추론] | `opener` 플러그인(표에 iOS ✅ / Android ✅) |
| 딥링크(웹 클리퍼) | `tauri.conf.json:84-89` `deep-link.desktop.schemes`만 있음. 처리 코드는 `lib.rs:394-446` | 모바일은 `plugins.deep-link.mobile` 설정을 따로 둔다(https://v2.tauri.app/plugin/deep-linking/, 2026-06-15) | 설정 추가. 모바일 캡처의 주력은 공유 시트(3-D) |
| OS 파일 드래그앤드롭 | `PageIngest.tsx:170-171`, `Editor.tsx:549` `onDragDropEvent` | 폰에는 해당 입력이 없다 | 파일 선택 버튼과 공유 시트 |
| vault 버전 기록(git) | `vault_history.rs:28-34` `Command::new("git")`, `git_log.rs:25-35`, `distill.rs:1525,4139`, `mcp_native.rs:2133` | git 바이너리가 없고 spawn도 금지 | 끄거나(이미 opt-in, `vault_history.rs:1-3`) libgit2/gitoxide로 교체한다. iOS 빌드는 [미확인] |
| 앱 업데이트 | `lib.rs:132`, `stores/updateStore.ts:10-11` | updater 플러그인은 iOS ❌ / Android ❌ | 모바일에서는 제거하고 스토어 업데이트로 대신한다 |
| myco Pro 구독 | `myco_pro.rs:1-9` 라이선스 키 + 프록시 | App Store 3.1.1은 라이선스 키로 기능을 여는 것을 금지한다. 3.1.3(b)는 웹 구독을 앱 안에서도 IAP로 제공할 때만 허용한다(https://developer.apple.com/app-store/review/guidelines/) | 3-F의 결정 사항 |

### 1-C. 데스크톱 전용(모바일에서는 빼기)

| 기능 | 근거 | 이유 |
|---|---|---|
| 메뉴바 트레이 | `tray.rs:15,536`, `lib.rs:352`, `Cargo.toml:22` `tray-icon`, `macos-private-api` | `tauri::tray`는 "Available on desktop and crate feature tray-icon only"(https://docs.rs/tauri/latest/tauri/tray/index.html, tauri 2.12.1) |
| 스포트라이트(전역 단축키 + 투명 창) | `spotlight.rs:19-20,111-121`, `lib.rs:158` | global-shortcut 플러그인은 Android ✗ / iOS ✗(https://v2.tauri.app/plugin/global-shortcut/, 2025-02-22). `decorations`·`transparent`·`always_on_top`은 desktop-only 메서드(https://docs.rs/tauri/latest/tauri/webview/struct.WebviewWindowBuilder.html) |
| 노치 드롭 표면 | `notch.rs`(macOS cfg + 비-macOS 스텁), `lib.rs:365` | macOS 전용 |
| 보조 창 3개 | `capabilities/default.json:5` `["main","tray-panel","spotlight","notch"]` | 모바일 WebviewWindowBuilder는 단일 창 중심. 다중 창 지원은 문서에서 확인 못 함 |
| 내장 MCP 서버 | `mcp_native.rs:2949-2975` `127.0.0.1` axum, Bearer | 폰 안에는 이 서버에 붙을 MCP 클라이언트가 없고, 앱이 백그라운드로 가면 중단된다 [추론] |
| Claude CLI / Codex 에이전트 | `claude.rs:101,304,684`, `cli_agent.rs:170`, `commands.rs:2185-2254` | 폰에는 CLI가 없고 spawn도 금지 |
| CLI 세션 가져오기(`~/.claude`, `~/.codex`) | `commands.rs:1648-1660` | 데스크톱 홈 디렉터리 전제 |
| Ollama | `ollama.rs:75`, CSP `localhost:11434`(`tauri.conf.json:31`) | 로컬 데몬 전제. LAN 상의 Ollama를 쓰는 방안은 [미확인] |
| 백그라운드 스케줄 / digest | `schedules.rs:317-369` `launchctl`, 비-macOS 스텁 `schedules.rs:456-470`. `tauri.conf.json:61` `automation/digest.py` | 모바일 백그라운드 제약(3-E) |
| 화자 분리 | `diarize.rs:165`(`/usr/bin/tar`), `:283` | spawn |
| WebView 데이터 이전 | `webview_data.rs`(macOS cfg) | macOS 전용 |
| distill 대량 정리 | `distill.rs`(7,502줄, git spawn 포함) | git만 빼면 기술적으로는 이식할 수 있다. 하지만 오래 걸리는 배치라서 포그라운드에서만 도는 폰과 맞지 않는다. "데스크톱 권장"으로 분류 |

---

## 2. 지금 프런트엔드를 폰·iPad 폭에서 띄워 본 결과

방법 [검증]: 다른 세션이 띄워 둔 이 체크아웃의 Vite dev 서버(`localhost:6300`, `node …/app/node_modules/.bin/vite --port 6300`)에 `?mock=1`로 접속했다. Playwright **WebKit** 엔진에 `iPhone 13`(390×664) 프리셋과 `iPad Pro 11` 세로/가로 프리셋을 썼다. 실제 기기와 WKWebView가 아니라 데스크톱 WebKit 에뮬레이션이고, 데이터는 mock vault다.

| # | 스크린샷 | 관찰 |
|---|---|---|
| 01 | `mobile-shots/01-boot-iphone13.png` | 홈이 390px에서 가로 넘침 없이 렌더된다(`scrollWidth = clientWidth = 390`) [검증]. 입력 placeholder가 두 줄로 넘쳐 "보세요"가 잘린다. "⌘Enter 오늘의 노트에 적기"(`lib/i18n.ts:6218`) 안내가 폰에도 보이고, 상단에 `⌘K` 칩이 보인다 |
| 02 | `mobile-shots/02-sidebar-open.png` | 오프캔버스 사이드바는 열린다. 하단에 고정된 "볼트 상태"와 재인덱스 경고 카드가 높이를 많이 차지해서, 파일 트리 영역은 "더 보기"에서 잘린다 |
| 03 | `mobile-shots/03-note.png` | 노트가 읽기 좋게 렌더된다. 상단 바에서는 breadcrumb이 길어 분할·검색 버튼이 화면 밖으로 밀린다(`styles.css:7086` `overflow-x: auto`). 뒤로/앞으로 화살표가 폰의 시스템 뒤로 제스처와 겹친다 |
| 05 | `mobile-shots/05-ask.png` | 질문 페이지가 1열로 렌더된다 |
| 06 | `mobile-shots/06-ingest.png` | 자료 추가가 1열로 접힌다(`styles.css` `.ingest-grid` 1fr). 가로 넘침 없음 [검증] |
| 07 | `mobile-shots/07-graph.png` | 그래프 캔버스가 WebKit에서 그려진다. 다만 컨트롤과 설명이 첫 화면의 약 3분의 2를 차지해서 캔버스는 그 아래에서 시작한다. 렌더 루프는 매 프레임 `requestAnimationFrame`을 다시 건다(`lib/graphScene.ts:4971,5085-5087`). 사용자 메모에 따르면 이건 의도된 연속 렌더다(`memory/MEMORY.md` "Graph render loop is intentional"). 폰 배터리 영향은 [미확인] |
| 08 | `mobile-shots/08-settings.png` | 설정이 렌더된다. 상단 바 오른쪽 모델 칩이 잘린다 |
| 09 | `mobile-shots/09-ipad-portrait-note.png`, `09-ipad-landscape-note.png` | 834px·1194px에서 사이드바와 본문을 함께 쓰는 데스크톱 레이아웃이 그대로 쓸 만하다. 가로 넘침 없음 [검증] |

코드에서 확인한 모바일 결함 [검증: 코드 / 추론: 영향]:
- **홈의 "오늘의 노트에 적기"는 ⌘/Ctrl+Enter로만 실행된다**(`pages/PageOverview.tsx:365` `if (e.metaKey || e.ctrlKey) void capture()`). 버튼이 없다. 폰 소프트 키보드에는 ⌘가 없으므로 폰 사용자는 홈에서 캡처할 수 없다 [추론].
- 키보드 인식 처리가 없다. `visualViewport|virtualKeyboard|enterkeyhint|inputmode` 검색 결과 0건이다. 반면 Obsidian iOS는 키보드 위에 서식 툴바를 띄운다(아래 3-G).
- `index.html:5` viewport에 `viewport-fit=cover`가 없다. 그런데 `styles.css:7088-7091`은 `env(safe-area-inset-*)`에 기대고 있다. WebKit 문서상 `viewport-fit=cover`가 없으면 페이지가 safe area 안에 배치된다(https://webkit.org/blog/7929/designing-websites-for-iphone-x/, 2017-09-22). Tauri iOS WKWebView에서 실제로 어떻게 보이는지는 [미확인].
- `index.html:12-15`는 Google Fonts를 네트워크에서 불러온다. 오프라인으로 처음 실행하면 fallback 폰트가 쓰인다 [추론]. 로컬 우선 앱이라면 폰트를 번들하는 게 맞다.

---

## 3. 플랫폼 조사

### 3-A. Tauri 2 모바일 현황 (2026-10 기준)

- 공식 플러그인 플랫폼 표(https://raw.githubusercontent.com/tauri-apps/plugins-workspace/v2/README.md, 2026-10-01 열람):
  - iOS/Android ✅: clipboard-manager, deep-link, dialog, http, log, notification, opener, os, sql, store, upload, barcode-scanner, biometric, geolocation, haptics, nfc
  - iOS/Android "?": fs, global-shortcut, localhost, persisted-scope, process, shell, stronghold, websocket
  - iOS/Android ❌: autostart, cli, positioner, single-instance, **updater**, window-state
  - 개별 페이지는 더 엄격하다. global-shortcut 페이지는 Android ✗ / iOS ✗(https://v2.tauri.app/plugin/global-shortcut/, 2025-02-22). fs 페이지는 모바일 ✓이지만 "Access is restricted to Application folder by default"이고, iOS는 `PrivacyInfo.xcprivacy`가 필요하다(https://v2.tauri.app/plugin/file-system/, 2026-09-21 갱신).
  - 참고: `v2.tauri.app/plugin/` 페이지를 WebFetch로 요약한 결과는 global-shortcut과 updater를 "모든 플랫폼"이라고 잘못 요약했다. 위 표는 원문 README와 개별 페이지로 다시 확인한 것이다.
- 최신 릴리스는 Tauri 2.12(블로그 2026-09-26, https://v2.tauri.app/blog/tauri-2.12/)다. 모바일 관련 항목은 dev 서버 로딩 속도 개선, Android 템플릿(Gradle 9, Kotlin 2, targetSdk 37), `video_dir()` 수정 정도다. 2025~2026 블로그에 모바일 파일 접근이나 백그라운드 개선을 다룬 글은 없었다(https://v2.tauri.app/blog/).
- 모바일 네이티브 기능은 Swift/Kotlin으로 플러그인을 직접 작성해서 붙인다(https://v2.tauri.app/develop/plugins/develop-mobile/, 2026-05-14). 폴더 bookmark, 공유 확장, 위젯은 모두 이 방식이나 커뮤니티 도구를 써야 한다.
- 열려 있는 결함: iOS 파일 선택기의 필터·선택 오류와 security-scoped 리소스 처리 누락(https://github.com/tauri-apps/plugins-workspace/issues/3030, 2025-10-07 개설, 열람 시점 Open).
- 유사 사례: Tauri 2 마크다운 앱 AndyMD의 iOS 포팅 PR(https://github.com/andy-zhanggx/andymd/pull/25, 2026-06-22 → 2026-09-28 미병합 종료)이 있다. 이 PR은 메뉴, `notify` 감시, Trash, Finder 표시, pandoc(subprocess), 업데이터를 `cfg(desktop)`으로 막았다. vault는 iOS 샌드박스 Documents로 두었고, 외부 폴더 접근은 "future Swift plugin work"로 미뤘다. myco가 해야 할 일과 거의 같은 목록이다. 다만 이 PR은 병합되지 않았으므로 완성 사례가 아니라 작업 목록 참고용이다.

### 3-B. 파일 시스템: iOS와 Android가 다르다

**iOS**
- 앱은 자기 컨테이너만 자유롭게 읽고 쓴다. Documents는 plist 키 2개를 넣으면 Files 앱의 "나의 iPhone"에 보인다(1-B 표).
- 사용자가 고른 외부 폴더(iCloud Drive나 다른 앱의 파일 제공자)는 `UIDocumentPickerViewController([.folder])` → `startAccessingSecurityScopedResource()` → `bookmarkData` 저장 → 실행할 때 bookmark를 resolve하는 순서로 접근한다. 이 과정에서 `NSFileCoordinator`로 읽기·쓰기를 감싸야 한다. `.folder`는 iOS 14 이상(https://developer.apple.com/documentation/uikit/providing-access-to-directories). Tauri 공식 플러그인에는 이 흐름이 없다(3-A).
- **iCloud Drive vault의 함정**: 클라우드로 내려간(evicted) 파일은 디렉터리 목록에 `.filename.ext.icloud` 같은 placeholder로 나온다. POSIX `readdir`은 파일 제공자를 우회하므로 이 placeholder만 보인다(https://github.com/incyclist/mobile/issues/299, 2026-05-06). myco의 `walk_dir`은 `is_markdown(&path)`일 때만 파일을 내보낸다(`vault.rs:1207-1233`). 그러면 `.note.md.icloud`는 확장자가 `icloud`라서 트리와 인덱스에서 **조용히 빠진다** [추론]. iCloud vault를 지원하려면 placeholder를 감지해 `startDownloadingUbiquitousItem`을 호출하는 어댑터가 필요하다(위 이슈와 검색 요약).

**Android**
- SAF `ACTION_OPEN_DOCUMENT_TREE`로 디렉터리 트리 권한을 받고, `takePersistableUriPermission`으로 재부팅 후에도 유지한다. Android 11 이상에서는 내부 저장소 루트와 Download는 고를 수 없다. 파일이 많은 트리를 순회하면 느려질 수 있다고 공식 문서가 경고한다(https://developer.android.com/training/data-storage/shared/documents-files, 2026-09-16 갱신).
- 여기서 받는 것은 경로가 아니라 **URI**다. 그래서 `std::fs` + `canonicalize`로 confinement를 하는 myco Rust 계층과 맞지 않는다. 공식 Tauri 쪽 폴더 선택 요청은 중복으로 닫혔다(https://github.com/tauri-apps/tauri/issues/14587, 2025-11-30, plugins-workspace #933 중복). 커뮤니티 `tauri-plugin-android-fs`(29.0.0, 2026-07-22, 39 stars)가 SAF picker와 persist 권한을 제공하지만 URI(`FsUri`) 기반이다(https://docs.rs/crate/tauri-plugin-android-fs/latest).
- Obsidian Android는 "All files" 접근(`MANAGE_EXTERNAL_STORAGE`)을 요청하는 쪽을 택했다(https://obsidian.md/help/android). Google Play는 문서 관리 앱에 이 권한을 허용하지만, 신고 양식을 내고 승인을 받아야 하며 SAF로 부족한 이유를 설명해야 한다(https://support.google.com/googleplay/android-developer/answer/10467955).
- 따라서 Android의 선택지는 셋이다. ① 앱 전용 저장소만 쓴다(가장 쉽지만 다른 동기화 도구와 공유할 수 없다). ② All files 권한으로 `std::fs` 코드를 그대로 쓴다(Play 심사 위험). ③ Rust 계층을 URI 추상화로 다시 쓴다(가장 비싸다).

### 3-C. Obsidian 모바일은 vault를 어떻게 다루나

- iOS 첫 화면은 "Your thoughts are yours. Obsidian stores notes on your device… in a secure local folder called a vault", 그리고 "Create a vault / Use my existing vault"다(https://mobbin.com/screens/e77414c6-2bee-4455-be64-60b7887b75f5).
- vault 만들기에 "Store in iCloud — This cannot be changed later" 토글이 있다(https://mobbin.com/screens/1fe92af6-d08b-4aa0-aa68-4a2ff0f41218).
- vault 목록 화면에 "Setup Obsidian Sync / Create new vault"와 vault 목록이 함께 있다(https://mobbin.com/screens/a56d3f3c-c332-4395-a1f1-415342a3d42b).
- 공식 도움말:
  - iOS에서 공식 지원하는 동기화는 Obsidian Sync와 iCloud다. Dropbox, Google Drive, OneDrive, Syncthing은 iOS 미지원이고, Git은 Working Copy 앱을 거친다(https://obsidian.md/help/sync-notes).
  - "On mobile devices, Obsidian operates in a sandboxed environment"(https://obsidian.md/help/sync/switch).
  - iOS에는 "Open folder as vault"가 없다(포럼, 2026-07-22, https://forum.obsidian.md/t/open-folder-as-vault-option-missing-entirely-on-ios/116344. 운영진은 "not a bug"로 분류하고 기존 기능 요청으로 연결).
- Obsidian Sync는 연 결제 $4/월, 월 결제 $5/월이고 E2E 암호화를 제공한다. 앱 자체는 무료다(https://obsidian.md/pricing).
- 구현 방식은 커뮤니티 답변에 따르면 Capacitor(WebView) 하이브리드다(https://forum.obsidian.md/t/what-technology-obsidian-mobile-is-developed-with/40125, 2022-07-11. 공식 문서가 아니라 포럼 답변). 웹 코드베이스를 WebView로 모바일에 내는 방식은 이미 검증된 경로라는 정황이다.
- **myco에 주는 함의 [추론]**: iOS에서 Obsidian Sync가 쓰는 vault는 Obsidian 앱의 컨테이너 안에 있다. 그래서 myco가 그 vault를 읽으려면 사용자가 그 폴더를 직접 골라야 하고, myco에 폴더 bookmark 플러그인이 있어야 한다. 그것도 Files 앱에서 그 폴더가 보일 때 이야기이고, 이 부분은 [미확인]이다. 결국 "Obsidian과 같은 vault를 폰에서 함께 쓰기"는 1차 범위에서는 iCloud Drive vault + 폴더 bookmark가 사실상 유일한 길이다. myco 자체에는 동기화가 없다.

### 3-D. 공유 확장(share extension)과 위젯

- Tauri 공식 지원은 없다. 커뮤니티 도구만 있다.
  - `tauri-apple-extensions`: iOS/macOS **Share Extension만** 지원한다. XcodeGen이 필요하고, 데이터는 App Group과 URL scheme으로 넘긴다. stars 7(https://github.com/Choochmeque/tauri-apple-extensions).
  - `tauri-plugin-widgets`: 0.5.0(2026-08-03). JSON으로 위젯을 정의하면 iOS는 WidgetKit, Android는 Glance로 렌더한다(https://docs.rs/crate/tauri-plugin-widgets/latest). 검색 요약에는 버전이 0.3.0으로 나와 열람 결과와 다르다. 최신 버전 확인이 필요하다.
- myco는 이미 `_inbox/`로 들어오는 경로가 있다(`lib.rs:389-446` 딥링크 → `clip::save_clip`). 그래서 공유 확장은 "App Group 컨테이너에 파일을 떨어뜨림 → 앱이 포그라운드로 오면 `_inbox/`로 옮김"이라는 얇은 구조로 충분하다 [추론].
- 타 앱 근거:
  - Fabric의 링크 캡처 시트: URL, "Say something about it… (optional)", 저장 위치 "/ Spaces / Inbox", Save(https://mobbin.com/screens/dfbd43eb-2e0d-482c-8924-72e57d939a9f). myco `_inbox/`와 1:1로 대응한다.
  - Tiimo 홈 화면 위젯: "What's the plan?" 입력 + 마이크 + 빠른 동작 아이콘(https://mobbin.com/screens/9bd0f286-7ce4-42bd-8146-ee694806b166). 캡처 위젯의 참고 형태다.
  - Deepstash 위젯: 인용 카드 + "STREAK 3 days · Read"(https://mobbin.com/screens/a9dee944-e751-4b82-ab90-470dc9fb24d0). myco의 Study·되새김 카드를 위젯으로 내보낼 때 참고할 형태다.

### 3-E. 백그라운드 제약

- 모바일 네이티브 작업 스케줄러(WorkManager/BGTaskScheduler) 요청은 응답 없이 닫혔다(https://github.com/tauri-apps/tauri/issues/14530, 2025-06-03).
- 커뮤니티 `tauri-plugin-background-service`가 있다. 검색 요약에 따르면 iOS BGTaskScheduler는 "~30 seconds every 15+ minutes" 수준의 best-effort이고, 강제 종료하면 실행되지 않는다(https://crates.io/crates/tauri-plugin-background-service). 이건 검색 결과 요약이고 페이지는 열어 보지 않았다.
- App Store 2.5.4는 백그라운드 서비스를 VoIP, 오디오, 위치, 작업 완료 등 본래 목적에만 허용한다(https://developer.apple.com/app-store/review/guidelines/).
- **결론 [추론]**: 재인덱싱, distill, 스케줄 digest는 폰에서 "앱을 열어 둔 동안"만 돈다고 전제하고 설계해야 한다. 무거운 정리는 데스크톱에 남긴다.

### 3-F. 스토어 정책

- **3.1.1**: 기능을 여는 데 라이선스 키를 쓰는 것을 금지한다. 미국 스토어프론트만 외부 결제 링크 금지에서 제외된다. **3.1.3(b)**: 다른 플랫폼이나 웹에서 산 구독을 앱에서 쓰게 하려면 그 항목을 앱 안에서도 IAP로 팔아야 한다(https://developer.apple.com/app-store/review/guidelines/).
  - 사용자 메모(`memory/MEMORY.md` "Memex distribution model")의 방침은 "subscription/payment code OUT of the public repo"다. iOS에서 myco Pro를 쓰게 하려면 StoreKit IAP 코드가 앱, 즉 공개 저장소 빌드에 들어가야 한다. **배포 방침과 충돌하므로 소유자의 결정이 필요하다.** 한국 스토어프론트의 대체 결제 규정은 이번에 확인하지 못했다.
- **2.5.2**: "may not download, install, or execute code which introduces or changes features"다. myco의 코드 플러그인(`lib/pluginSandbox.ts:1-18`, vault의 `main.js`를 Worker에서 실행)이 여기에 걸릴 수 있다. Obsidian 모바일은 커뮤니티 플러그인을 실행하고 `isDesktopOnly` 플래그로 Node/Electron 의존 플러그인만 막는다(https://docs.obsidian.md/Plugins/Getting%20started/Mobile%20development). 같은 방식이 App Store에서 받아들여진 정황은 있지만, myco가 같은 판정을 받는다는 보장은 없다 [추측].
- **4.2**: "beyond a repackaged website"다. 읽기 전용 WebView 래퍼만 내면 위험하다. 로컬 vault, 추출형 Ask, 공유 확장 같은 기능이 그 반증이 된다.

### 3-G. 기기 내 임베딩·LLM

- **임베딩(myco의 핵심)**: 번들 e5-small q8_0은 39.7 MB, 384-d다(`local_llm.rs:90`). llama.cpp는 iOS에서 Metal(`n_gpu_layers=99`)을 쓴다. Android는 CPU가 안전한 기본이다. 가중치가 mmap되므로 iOS jetsam과 Android LMK가 너그럽게 다룬다(https://docs.liquid.ai/deployment/on-device/llama-cpp/mobile, 날짜 없음). 폰에서 100페이지를 인덱싱하는 시간과 메모리 피크는 측정하지 않았다 [미확인]. 0단계 스파이크의 성공 기준으로 삼아야 한다.
- **인덱스 위치 문제**: 인덱스는 vault 밖 앱 데이터 디렉터리에 절대 경로 해시로 저장된다(`vector_index.rs:109-115`). 그래서 데스크톱이 만든 인덱스를 동기화로 폰에 넘길 수 없다. 폰에서 처음 열 때 다시 만들어야 한다 [추론]. 같은 모델이면 벡터는 호환되므로, 인덱스를 `<vault>/.myco/` 아래 vault id 기준으로 둘지 정해야 한다. 이 경우 동기화 충돌 위험을 같이 따져야 한다.
- **음성**: whisper.cpp의 small 모델은 디스크 466 MiB, 메모리 약 852 MB다(https://github.com/ggml-org/whisper.cpp 표, f16 기준). myco는 q5_1 190 MB를 내려받는다(`whisper.rs:43-46`). 폰에서의 메모리 피크는 [미확인]이다. 낮은 사양의 폰을 고려하면 OS 음성 인식을 대안으로 검토할 가치가 있다.
- **생성형 LLM(myco에는 필수가 아님)**:
  - Apple Foundation Models: 약 3B, 2 bpw, 한국어 포함 언어군(https://machinelearning.apple.com/research/apple-foundation-models-2025-updates, 2025-06-09 / 2025-07-17 갱신).
  - Android ML Kit Prompt API(Gemini Nano): Pixel 10에서 가장 잘 동작한다고 명시되어 있다(https://android-developers.googleblog.com/2026/07/android-on-device-inference.html, 2026-07-21).
  - myco Ask는 원문을 그대로 인용하는 추출형이므로 생성 모델 없이 돈다. 쓸 곳은 분류(`local_llm.rs:1-6`) 정도이고, 1차 범위에서 빼도 된다.
- iOS 메모리 상한을 올리는 `com.apple.developer.kernel.increased-memory-limit` entitlement가 있다(검색 요약: https://zenn.dev/mtfum/articles/ios_memory_entitlements?locale=en, 페이지 미열람). 임베딩 모델만 쓴다면 필요하지 않을 가능성이 높다 [추측].

---

## 4. 제품 옵션

비용은 근거 없는 인월 숫자 대신 작업 묶음과 상대 크기(S/M/L)로 적는다.

### 옵션 A. 같은 Tauri 코드베이스를 iOS/Android로 거의 전부 이식

- **작업**
  - (S) 진입점 추가, `cfg(desktop)` 게이트, `Cargo.toml` 타깃별 의존성 정리(tray-icon, macos-private-api, global-shortcut, updater, trash, notify), `tauri ios/android init`
  - (M) 경로 계층: app_data_dir, 상대 경로와 bookmark, 인덱스 키
  - (M) in-process 추출, opener, 키체인(Android)
  - (L) 폴더 접근: iOS Swift bookmark 플러그인, Android SAF 정책 결정
  - (L) llama.cpp 크로스 빌드, whisper 라이브러리화
  - (L) 모바일 UI: 하단 내비게이션, 키보드 툴바, 단일 창 대응, 그래프·distill·작업 보드의 터치 대응
  - (M) git 교체 또는 비활성화
- **사용자가 얻는 것**: 폰에서 읽기·편집·질문·자료 추가(API 프로바이더)·그래프까지 거의 데스크톱 그대로.
- **위험**
  - Tauri 모바일의 파일 접근 공백(3-A, 3-B)
  - Android SAF 재작성 비용
  - llama.cpp iOS 빌드가 [미확인]
  - App Store 3.1.1·2.5.2·4.2 심사
  - 무거운 기능(distill, 연속 렌더 그래프)의 배터리 부담
- **원칙 영향**: 파일과 임베딩이 기기 안에 남으면 local-first와 extractive가 모두 유지된다. Claude CLI 경로가 사라지므로 폰에서 자료를 추가하려면 HTTP 프로바이더나 myco Pro가 필요하다. 이는 데스크톱의 API 경로와 같은 수준의 외부 전송이다(`myco_pro.rs:3-9`). 임베더 크로스 빌드가 실패해서 클라우드 임베딩으로 우회하면 local-first가 깨진다.

### 옵션 B. 컴패니언: 캡처 + 읽기 + 추출형 질문 (같은 코드베이스의 부분집합) ← 권장

- **범위**
  - vault 열기(iOS 샌드박스 Documents. 2차로 iCloud Drive 폴더 bookmark)
  - 노트 목록·읽기·가벼운 편집
  - **캡처**: 홈 입력에 버튼 추가(⌘Enter 의존 제거), 공유 확장 → `_inbox/`, 음성 메모
  - 기기 내 인덱스로 추출형 Ask
  - 자료 정리(ingest), distill, 그래프, 에이전트, MCP는 데스크톱에 남긴다. 폰이 모은 `_inbox/`를 데스크톱이 처리하는 분업은 지금의 클리퍼 → `_inbox/` 흐름(`lib.rs:389-446`)을 그대로 넓힌 것이다.
- **작업**
  - A의 (S)(M) 기반 작업
  - (M) iOS 폴더 처리. 1차는 샌드박스만 쓰므로 S
  - (M) 공유 확장(커뮤니티 도구 + App Group)
  - (S~M) 모바일 셸: 하단 탭(홈/질문/검색/새 노트), 키보드 툴바
  - Android는 앱 전용 저장소로 시작하고 SAF는 미룬다
- **사용자가 얻는 것**: "밖에서 본 것을 바로 넣고, 내 노트에 물어서 원문 인용을 받는" 두 가지 일상 동작. 근거가 되는 타 앱 화면:
  - Notion iOS 홈 하단 바: 검색, 마이크가 달린 "Ask AI" 입력, 새 페이지(https://mobbin.com/screens/d120561c-525c-42e5-a177-c5bfa948a721)
  - Obsidian iOS 하단 내비게이션 바: 뒤로, 앞으로, 검색, +, 탭 수, 메뉴(https://mobbin.com/screens/f1a6d4a1-719d-43a3-8532-fe7261f6151e)
  - Obsidian iOS 키보드 위 툴바: 실행 취소, 다시 실행, `[]`, 파일, 태그, 첨부, H, B(https://mobbin.com/screens/629a3a6a-d55b-49a6-8914-945c900d5ee1)와 `[[` 제안(https://mobbin.com/screens/648fdde3-4975-40ba-a8d8-c9eec6fb5c0a)
  - Obsidian iOS 키보드 위 "Find or create a note…" 빠른 전환(https://mobbin.com/screens/e9aaa07a-ab80-4354-bd1c-a37bc9a3f404)
- **위험**
  - 동기화가 없다. 데스크톱과 폰을 이으려면 iCloud Drive(iOS+mac만 해당. Obsidian 도움말은 Windows의 iCloud가 파일 중복이나 손상을 일으킬 수 있다고 경고)나 사용자가 가진 다른 수단이 필요하다.
  - iCloud placeholder 문제(3-B)
  - 4.2 심사: 캡처와 기기 내 Ask가 반증 근거가 된다
- **원칙 영향**: 없다. 질문은 기기 안의 임베딩으로 원문만 인용하고, 생성과 외부 전송은 폰에서 하지 않는다.

### 옵션 C. 반응형 PWA 리더

- **작업**: 모바일 UI만 정리하면 된다. 이미 768px 셸이 동작한다(2절). (S~M)
- **치명적 제약**
  - iOS Safari와 Chrome Android 모두 File System Access API(`showDirectoryPicker`)를 지원하지 않는다(https://caniuse.com/native-filesystem-api). 그래서 기기의 vault 폴더를 읽을 수 없다.
  - Safari에서는 7일 동안 상호작용이 없으면 스크립트로 쓴 저장소가 삭제된다. 홈 화면 웹앱은 예외다(https://webkit.org/blog/10218/full-third-party-cookie-blocking-and-more/, 2020-03-24). 영구 모드는 휴리스틱에 따라 허용된다(https://webkit.org/blog/14403/updates-to-storage-policy/, 2023-08-10).
  - 결국 vault를 서버에 올리거나, 브라우저 저장소에 가져오거나, 데스크톱이 LAN으로 서빙해야 한다. 지금 MCP 서버는 loopback 전용이고 DNS rebinding을 막는다(`mcp_native.rs:2955-2962`). 이걸 LAN에 여는 것은 보안 설계를 새로 해야 하는 일이다.
  - 브라우저에서 임베딩을 돌리는 방법(wasm llama.cpp 등)은 검증하지 않았다 [미확인].
- **원칙 영향**: 가장 크다. 서버 경로는 local-first를 깨고, 브라우저 저장소 경로는 "vault = 디스크의 평범한 마크다운"이라는 전제를 깬다. **권하지 않는다.**

### 옵션 D. iPad 우선

- **근거**: 834px·1194px에서 지금 데스크톱 레이아웃이 그대로 쓸 만하다(`mobile-shots/09-*.png`) [검증]. iPad는 하드웨어 키보드로 ⌘K 같은 기존 단축키가 의미 있다. 다만 Tauri WKWebView가 하드웨어 키보드 이벤트를 전달하는지는 [미확인]이다.
- **작업**: A의 네이티브 어댑터(경로, 폴더, 추출, whisper, llama)는 그대로 필요하다. 줄어드는 것은 UI 작업이다. 보조 창(스포트라이트, 트레이)은 단일 창 안으로 접어 넣어야 한다.
- **위험**: 사용자는 "모바일 버전"을 물었는데 폰을 비워 두게 된다. Stage Manager 다중 창 지원은 Tauri 문서에서 확인하지 못했다.
- **원칙 영향**: A와 같다.
- **판단**: 따로 제품을 만들기보다 **B의 universal iOS 빌드에서 넓은 화면이면 데스크톱 레이아웃을 쓰게** 하면 비용 없이 따라온다 [추론].

### 비교 요약

| | A 전체 이식 | B 컴패니언(권장) | C PWA | D iPad 우선 |
|---|---|---|---|---|
| 네이티브 어댑터 | 전부 | 경로·추출·임베더·공유 확장 | 없음 | 전부 |
| UI 작업 | L | S~M | S~M | S |
| 폴더 접근 난도 | L(iOS+Android) | S(샌드박스로 시작) | 불가 | M(iOS) |
| local-first | 유지 | 유지 | 깨짐 | 유지 |
| extractive Ask 기기 내 | 예 | 예 | [미확인] | 예 |
| 스토어 위험 | 3.1.1·2.5.2·4.2 | 3.1.1(Pro 노출 시)·4.2 | 해당 없음 | A와 같음 |

---

## 5. 권장 진행 순서와 단계별 성공 기준

1. **0단계: 컴파일 스파이크**(브랜치 하나, 사용자 승인 후 진행)
   - 작업: `mobile_entry_point`, `cfg(desktop)` 게이트, iOS 타깃 설치, `tauri ios init`, 시뮬레이터 실행.
   - 성공 기준: 시뮬레이터에서 앱이 뜨고, 샌드박스 vault를 seed해서(`vault.rs:298-313` 재사용) 노트 목록이 보이며, `llama-cpp-2`가 iOS로 링크되어 노트 10개를 임베딩한다.
   - 실패할 경우: 임베더 대안(BM25만 쓰는 Ask, Core ML 변환)을 검토한다. 클라우드 임베딩은 원칙 위반이므로 대안에서 제외한다.
2. **1단계: 읽기 + Ask**
   - 성공 기준: 실기기에서 vault 100페이지를 인덱싱하는 시간과 메모리 피크를 측정해 기록한다. Ask 결과가 데스크톱과 같은 원문 인용과 같은 abstain 판정을 낸다.
3. **2단계: 캡처**
   - 작업: 홈 입력에 캡처 버튼 추가(`PageOverview.tsx:365`의 수정자 키 의존 제거), 공유 확장 → App Group → `_inbox/`, 키보드 툴바.
4. **3단계: iCloud Drive 폴더 bookmark**
   - 작업: placeholder 처리, `NSFileCoordinator`.
   - 성공 기준: macOS 데스크톱과 같은 vault를 양쪽에서 열 수 있다.
5. **Android**: 앱 전용 저장소로 B를 먼저 낸다. SAF 재작성과 All files 권한 중 무엇을 택할지는 사용 데이터를 보고 정한다.
6. **소유자 결정이 필요한 것**
   - myco Pro를 iOS에 노출할지(3.1.1, 3.1.3(b)와 "결제 코드는 공개 저장소 밖" 방침의 충돌)
   - 코드 플러그인을 모바일에서 허용할지(2.5.2)
   - 파서 격리 손실을 감수할지(`panic = "abort"`)

---

## 6. 확인하지 못한 것

- iOS/Android로 실제 컴파일하지 않았다. 이 기기에 iOS 타깃과 SDK가 없고, 저장소를 수정하지 않는다는 조건도 있었다. 1절의 "그대로 동작"은 모두 추론이다.
- `llama-cpp-2` 0.1.150의 iOS 빌드, 폰에서의 임베딩 속도와 메모리, whisper small q5_1의 폰 메모리 피크.
- `notify` 크레이트의 iOS 백엔드, `keyring`의 `sync-secret-service` 기능이 Android 타깃에서 컴파일되는지.
- Tauri iOS WKWebView의 safe area 처리, 하드웨어 키보드 이벤트 전달, iPad Stage Manager 다중 창.
- Obsidian iOS vault(Obsidian 컨테이너, iCloud Drive/Obsidian)를 다른 앱이 폴더 bookmark로 열 수 있는지.
- 한국 App Store의 대체 결제 규정, Apple Foundation Models 프레임워크의 세션 컨텍스트 한도.
- `tauri-plugin-widgets` 최신 버전(열람은 0.5.0, 검색 요약은 0.3.0)과 `tauri-plugin-background-service`의 실제 문서(검색 요약만 봄).
- 스크린샷은 데스크톱 WebKit 에뮬레이션과 mock vault로 찍었다. 실제 기기의 소프트 키보드, 스크롤 관성, 그래프 프레임레이트와 배터리는 보지 못했다.
