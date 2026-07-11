<div align="center">

<br />

<img src="docs/memex-icon.png" width="100" alt="Memex icon" />

<h1>Memex</h1>

<p><strong>스스로 자라는 개인 지식 베이스.</strong></p>

<p>
소스를 던지면, Claude가 정리해 둡니다.<br/>
당신의 지식은 마크다운 그대로, 통제권은 당신에게.
</p>

<p>
<a href="#설치"><img alt="설치" src="https://img.shields.io/badge/install-DMG-111?style=flat-square" /></a>
&nbsp;
<img alt="License" src="https://img.shields.io/badge/license-MIT-111?style=flat-square" />
&nbsp;
<img alt="Tauri 2" src="https://img.shields.io/badge/Tauri-2-111?style=flat-square" />
&nbsp;
<img alt="Made with Claude Code" src="https://img.shields.io/badge/made%20with-Claude%20Code-111?style=flat-square" />
&nbsp;
<a href="README.md"><img alt="English" src="https://img.shields.io/badge/English-README-111?style=flat-square" /></a>
</p>

<br />

<p>
<em>"Obsidian이 IDE라면, Claude는 프로그래머. 위키는 코드베이스."</em>
</p>

<br />

<img src="docs/screenshots/hero-mesh.png" width="100%" alt="Memex 지식 그래프 — vault를 3D 코스믹 웹으로 렌더링, 커뮤니티별로 색칠되고 이름이 붙은 클러스터의 빛나는 별들" />

<sub><em>Graph 뷰 — "고요한 코스믹 웹". 각 노트는 링크 수에 따라 크기가 정해지는 별이고, 커뮤니티마다 고유 색과 자동으로 이름 붙은 클러스터 라벨을 갖습니다. <code>[[wikilinks]]</code>는 옅은 회색 연결 조직이고, 진짜 허브만 발광합니다. 첫 실행 시 제공되는 시드 노트 약 50개짜리 스타터 vault 화면입니다.</em></sub>

</div>

---

## 왜?

대부분의 LLM + 문서 셋업은 **모든 질의마다 지식을 재유도합니다**. RAG는 청크를 찾고, 모델은 답을 짜 맞추고, 아무것도 남지 않습니다. 같은 문서에 열 번 물어보면 → 열 번의 재발견이죠.

**Memex는 이 흐름을 뒤집습니다.** 소스를 한 번 넣으면, Claude가 읽고, 영속 위키에 통합하고, 기존 페이지와의 모순을 표시하고, 인용을 연결하고, 커밋합니다. 10번째 질의에서는 위키 스스로 답합니다 — 정리는 이미 끝나 있으니까요.

[Andrej Karpathy의 LLM Wiki 패턴](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f) 기반. 이름은 [Vannevar Bush의 1945년 Memex](https://en.wikipedia.org/wiki/Memex)에서.

---

## 두 가지 표면, 하나의 위키

Memex의 주력은 네이티브 데스크톱 앱입니다. 다른 Claude 클라이언트에서의 프로그램적 접근을 위해 보조 표면 하나가 제공됩니다.

| 표면 | 설명 | 사용 시기 |
|---|---|---|
| **Memex 데스크톱 앱** (`app/`) | Tauri 2 + React, `.dmg`/`.exe`로 배포. 자체 vault 생성, 5개 LLM 프로바이더 지원. | **기본. 이걸 쓰세요.** |
| **MCP 서버** (`mcp-server/`) | Model Context Protocol을 통한 26개 도구. | Claude Desktop/Code 같은 MCP 클라이언트에서 Memex 조작. |

두 표면 모두 같은 vault 레이아웃(`raw/ wiki/ daily/ ingest-reports/`)을 공유하며 데이터를 잠그지 않습니다. 디스크 위의 평범한 마크다운, 언제나.

---

## 설치

### 데스크톱 앱 (권장)

**[최신 릴리스](https://github.com/cmblir/Memex/releases/latest)**에서 플랫폼별 번들을 받으세요:

- **macOS** (유니버설 — Apple Silicon + Intel): `Memex_0.1.0_universal.dmg`
- **Windows x64**: `Memex_0.1.0_x64-setup.exe` (NSIS 설치 파일)

> [!note] 첫 실행 — v0.1.0 설치 파일은 서명되지 않음
> 두 번들 모두 **서명되지 않아** OS가 첫 실행 시 경고합니다. 정상이며 한 번만 허용하면 됩니다:
> - **macOS**(Gatekeeper "확인되지 않은 개발자") — 앱 우클릭 → **열기** → **열기**; 또는 `xattr -dr com.apple.quarantine /Applications/Memex.app`; 또는 **시스템 설정 → 개인정보 보호 및 보안 → "그래도 열기"**.
> - **Windows**(SmartScreen "PC를 보호했습니다") — **추가 정보** → **실행**.

마운트/실행 → Applications 드래그. 첫 실행 시 Memex가 `~/Documents/Memex/`를 자동 생성하고 다음 구조로 시드합니다:

```
~/Documents/Memex/
├── CLAUDE.md            ← Claude를 위한 유지보수 규칙
├── welcome.md           ← 시작 노트
├── raw/                 ← 소스 드롭 (불변)
├── wiki/                ← Claude가 유지하는 페이지
│   ├── index.md
│   ├── log.md
│   └── …                ← 상호 연결된 시작 노트 (LLM 개념)
├── daily/               ← 데일리 노트 (YYYY-MM-DD.md)
└── ingest-reports/      ← ingest별 WHY 보고서
```

`wiki/`에는 상호 연결된 시작 노트가 들어 있어 첫 실행부터 **Graph** 뷰가 채워집니다 — 언제든 삭제 가능.

다른 폴더(예: 기존 Obsidian vault)를 쓰려면 Settings → Account → Change…

### MCP 서버 (선택)

Python 3.10+ (stdlib만)과 [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) 필요.

```bash
git clone https://github.com/cmblir/memex.git
cd memex
bash mcp-server/install.sh    # Claude Desktop/Code용 MCP 서버
```

---

## 스크린샷

<p align="center">
<img src="docs/screenshots/mesh.gif" width="100%" alt="Memex 3D 코스믹 웹 그래프가 천천히 자동 공전 — 커뮤니티 색 빛나는 별, 클러스터 라벨, 옅은 회색 위키링크 조직" />
<br/>
<sub><em>Graph 화면이 천천히 자동 공전하며 대기하는 모습 — 커뮤니티 색 빛나는 별, 자동으로 이름 붙은 클러스터 라벨, 옅은 회색 <code>[[wikilink]]</code> 연결 조직. 별을 잡으면 d3-force-3d 시뮬레이션이 재가열돼 이웃이 따라오고 놓으면 제자리로 돌아옵니다.</em></sub>
</p>

<br/>

<table>
<tr>
<td width="50%"><img src="docs/screenshots/overview.png" alt="Overview — vault 통계, 점프백 카드, 최근 git 활동" /></td>
<td width="50%"><img src="docs/screenshots/provenance.png" alt="Provenance — 페이지별 인용 커버리지, 임계값 플래그 + Run lint" /></td>
</tr>
<tr>
<td align="center"><sub><strong>Overview</strong> — 통계 · 점프백 · 최근 활동</sub></td>
<td align="center"><sub><strong>Provenance</strong> — 페이지별 인용 커버리지</sub></td>
</tr>
<tr>
<td width="50%"><img src="docs/screenshots/reader.png" alt="Reader — CodeMirror 소스, 라이브 프리뷰, 백링크" /></td>
<td width="50%"><img src="docs/screenshots/tags.png" alt="Tags — 프론트매터 태그별로 묶인 모든 페이지, 태그 클릭 시 필터링" /></td>
</tr>
<tr>
<td align="center"><sub><strong>Reader</strong> — 소스 / 분할 / 프리뷰 + 백링크</sub></td>
<td align="center"><sub><strong>Tags</strong> — 태그별로 페이지를 묶어 보기</sub></td>
</tr>
<tr>
<td width="50%"><img src="docs/screenshots/settings.png" alt="Settings — 작업별 프로바이더 + 모델 선택, 비용 예산, 자동 반영" /></td>
<td width="50%"></td>
</tr>
<tr>
<td align="center"><sub><strong>Settings</strong> — Query / Ingest 모델 분리, 비용 예산, 자동 반영</sub></td>
<td></td>
</tr>
</table>

> 시드 샘플 vault에서 실행 중인 앱을 캡처. 새로 설치하면 상호 연결된 시작 노트
> ~50개(LLM 지식 맵)가 시드되어 첫날부터 Graph가 이렇게 보입니다 — 언제든 삭제 가능.

---

## 데스크톱 앱

왼쪽 사이드바 라우트 — Overview, Graph, History, Provenance, Tags, **Study**, **Schedules**, Settings, 그리고 Ingest·Ask. ⌘K로 명령 팔레트(시맨틱 검색 포함), ⌘B로 사이드바 토글. 첫 실행 시 3단계 온보딩 마법사가 vault 열기 → 소스 추가 → 질문하기까지 안내합니다. 앱 전체가 320px까지 반응형이며, 좁은 화면에서는 사이드바가 오프캔버스로 접힙니다.

### Overview

Vault 통계 (파일 수, 해결된 위키링크, 비율), 최근 git 활동, 가장 많이 편집된 노트로 점프하는 카드들.

### Ingest

1. 파일 드롭 또는 텍스트 붙여넣기 → Memex가 `raw/<slug>.md`에 저장.
2. 활성 **ingest 모델** 호출 (기본: Claude CLI), vault를 cwd로.
3. Claude가 소스를 읽고, 영향받는 wiki 페이지를 찾고, 인용을 추가하고, `wiki/source-<slug>.md`를 생성/갱신하고, `wiki/log.md`에 추가하고, `ingest-reports/<datetime>-<slug>.md`에 WHY를 기록.
4. 트리와 그래프 새로고침.

**입력은 멀티모달** — PDF, 일반 텍스트, Office 문서(`.docx` / `.pptx`), 스프레드시트(`.xlsx` / `.xls` / `.ods`), **이미지**(비전 프로바이더 — Anthropic / OpenAI / Google API로 설명 생성), **오디오·비디오**(설치된 `whisper` CLI로 전사 — openai-whisper 또는 whisper.cpp; 모델은 번들하지 않음), 그리고 **YouTube URL**(watch 페이지에서 자막을 가져옴)이 모두 1단계 전에 마크다운으로 환원됩니다. 위키 위에 **로컬 임베딩 인덱스**(기본은 번들된 Gemma 모델, 또는 옵트인 프로바이더)를 구축해 Ask가 가장 관련 있는 페이지를 검색하고, 명령 팔레트가 시맨틱 히트를 띄우며, 각 페이지에 **관련 노트** 패널이 붙습니다. 재색인은 Settings에서.

### Ask

위키에 대한 질문에 답하는 채팅 화면. 활성 **query 모델**이 vault 루트에서 실행되며 시스템 프리앰블이 `wiki/`를 먼저 Read/Grep 도구로 조회한 뒤 필요하면 `raw/`로 내려가도록 유도합니다. 세션별 대화 히스토리 유지. 도구 미지원 프로바이더에는 시맨틱 상위-K 페이지를 인라인해 실제 내용으로 답하게 합니다.

**에이전트 모드**(Ask/Agent 토글)는 도구 지원 프로바이더(Anthropic API 또는 OpenAI 호환)를 자율 리서처로 바꿉니다 — 계획을 세우고 vault에 읽기 도구(검색·페이지 읽기·링크 탐색·출처)를 호출하며 접을 수 있는 단계 트레이스를 스트리밍한 뒤 인용과 함께 답합니다. 선택적 **쓰기 도구**(페이지 생성/수정)는 호출마다 확인하며 `raw/`는 절대 건드리지 않습니다. 재사용 가능한 **작업 에이전트 프리셋**은 이식 가능한 `agents/<slug>.md`로 저장됩니다.

**오디오 개요**는 답변이 인용한 페이지(또는 Reader 페이지 + 이웃)를 근거 있는 2인 진행 음성 "딥다이브"로 만듭니다 — 인용 포함 대화를 `audio/`에 저장하고 OS 음성(Web Speech API, 번들 엔진 없음)으로 오프라인 재생합니다.

### Graph

**three.js**(WebGL) + **d3-force-3d** 레이아웃 위에 vault 전체 링크 그래프를 **3D "고요한 코스믹 웹"**으로 렌더링 — Obsidian이 쓰는 동일한 포스 패밀리(`forceLink` + `forceManyBody` + `forceX/Y/Z` + 충돌)를 적용하고, 각 링크 강도를 노드 차수로 정규화하며, 가벼운 커뮤니티 클러스터링 포스가 각 Louvain 커뮤니티를 은은하게 빛나는 자기만의 영역으로 모읍니다. 설계 원칙은 *밝기는 밀도로 얻는다*는 것 — 화면의 80~90%는 어두운 공백으로 남고, 노드 크기는 log-degree 스케일을 따르며, **진짜 허브 코어만 발광합니다**(selective bloom — 엣지·펄스·별밭·라벨은 구조적으로 블룸에 반응하지 않아, 밀집한 클러스터도 흰색으로 번지지 않습니다). 엣지는 `[[wikilinks]]`가 옅은 **회색 연결 조직**으로 그려집니다(구조는 회색, 신호는 색칠된 별들). **링크 없는 고아까지 모든 노트가 표시**되고, 미해결 링크는 **고스트 노드**로 옅게 나타납니다 — Obsidian처럼(*고립 노드 표시* / *존재하는 파일만* 토글).

가장 큰 여섯 개 커뮤니티는 엄선된 6색 팔레트에서 색을 받고(나머지는 중립색), 줌아웃했을 때 각자의 무게중심에 떠 있는 **자동 명명 클러스터 라벨**을 갖습니다 — 파고들면 노드별 라벨로 넘겨주는 역방향 시맨틱 줌입니다. 라벨은 기본값으로 커뮤니티의 최고 차수 노트를 쓰고, 번들된 오프라인 모델이 백그라운드에서 이를 짧은 토픽 이름으로 업그레이드합니다(캐시되며, 노트 이름이 영구 폴백). 캔버스 안 **범례**(좌하단)에는 상위 커뮤니티와 크기/디밍/앰버/회색 인코딩이 나열되며, 색상 스와치를 클릭하면 해당 커뮤니티만 격리됩니다.

링크 해석도 Obsidian과 일치 — `[[note]]`, `[[note|별칭]]`, `[[note#heading]]`, `![[임베드]]`, 그리고 Obsidian **Bases** 같은 비-`.md` 파일 링크(`[[Table.base]]`)까지 모두 해석됩니다.

**드래그로 카메라를 회전**하고 스크롤로 줌합니다. 평소엔 천천히 자동 회전하다가 조작 중에는 멈추고 몇 초 뒤 재개합니다. **별을 잡으면 시뮬레이션이 재가열**돼 이웃이 3D로 따라오고, 놓으면 제자리로 돌아옵니다. **노드를 클릭**하면 1-hop 이웃만 격리되고(더블클릭은 2-hop), 각 격리는 포커스 스택에 쌓여 **Esc**·빈 공간 클릭·브레드크럼 칩으로 되돌립니다. **Cmd/Ctrl+클릭으로 두 번째 노드를 지정**하면 두 노트 사이 최단 경로가 밝은 필라멘트로 켜집니다. 앱 밖에서 파일이 바뀌면 파일트리와 그래프가 **자동 갱신**됩니다. ~1만 노드까지 60fps로 동작하며, 5천 개를 넘어서면 앰비언트 레이어를 끈 퍼포먼스 모드로 전환하고 배너를 띄웁니다.

우측 설정 드로어(톱니바퀴 아이콘):

- **Filters** — 파일명 라이브 검색, 태그 칩, 폴더 드롭다운, *고립 노드 표시* / *존재하는 파일만* 토글.
- **Display** — *화살표*, *라벨 페이드 임계*, *노드 크기*, *링크 두께*, **Glow** 슬라이더, **Ambient motion** 토글(자동 회전 + 펄스 + 호흡 애니메이션을 한 스위치로), 그리고 **▶ 타임랩스 재생** 버튼.
- **Layout** — 세 가지 프리셋(**Galaxy** / **Loose web** / **Dense**)이 흔한 경우를 커버하고, 원본 d3-force 슬라이더(*중심력 / 반발력 / 링크 장력 / 링크 거리 / 클러스터 포스*)는 **Advanced** 아코디언 아래에 있습니다.

**타임랩스**(툴바 ▶ 또는 드로어 버튼)는 파일 mtime 순(오래된 것부터)으로 노드를 **정착 위치 그대로 공개**합니다 — 노드가 연결될 때마다 엣지가 나타나, 실제로 작성한 순서대로 그래프가 스스로 자라는 모습을 보여줍니다.

드로어 상태와 모든 슬라이더 위치는 localStorage에 영속됩니다. 라이트/다크 테마 모두 보정되어 있으며, 라이트에서는 별이 흰색으로 번지는 대신 읽기 쉬운 잉크색으로 어두워집니다.

### History

Vault 디렉터리의 `git log`를 읽어 각 커밋의 제목, 해시, 날짜, `+/~` 줄 수를 표시. HEAD 표기. 아직 git repo가 아니면 `git init` 가이드 인라인.

### Provenance

페이지별 **인용 커버리지** — 전체 주장 라인 vs 인용된 주장 라인. 커버리지 낮은 순 정렬, 슬라이더 임계값 미만은 플래그.

**Run lint**은 CLAUDE.md의 lint 체크리스트(구조/인용/연결/신선도)를 활성 query 모델로 보냅니다. Claude CLI에서는 완료까지 기다리는 대신 보고서가 작성되는 대로 **실시간 스트리밍**합니다. (MCP 서버에는 즉석 정규식 검사를 위한 LLM 없는 `lint_citations`도 있습니다.)

### Tags

프론트매터 `tags`별로 묶인 모든 페이지 — 개수로 가중된 태그 클라우드입니다. 태그를 클릭하면 페이지 목록이 필터링되고, 페이지를 클릭하면 열립니다.

### Study

위키에 대한 능동 회상(active recall). 아무 페이지에서 **"Make cards"**를 누르면 LLM 스택으로 플래시카드를 생성합니다(번들 모델로 오프라인 가능). 카드는 `cards/<deck>.md`에 일반 마크다운으로 저장됩니다 — Obsidian `spaced-repetition` 문법 + **FSRS** 스케줄링 트레일러라, 복습 상태가 손실 없이 왕복합니다. Study 라우트는 복습 대상 카드를 리뷰하고(앞면 → 뒤집기 → Again/Hard/Good/Easy 채점 → FSRS가 다음 간격을 진행 → 디스크에 저장) 생성된 객관식 퀴즈를 실행합니다. 사이드바 배지가 복습 대상 개수를 표시합니다.

### Schedules

정기·무인 다이제스트. 스케줄을 정의합니다 — 자유 **질의**, **"무엇이 바뀌었나"** 요약(`git log` 반영), **신선도** 점검(고아/저인용/모순), 또는 **토픽** 추적 — 주기(매일 / 매주 / 매월 / N시간마다)로. 앱이 열려 있는 동안 인앱 타이머가 대상 스케줄을 실행하고, 각각 출처 인용과 함께 `digests/`에 마크다운 노트를 씁니다. **Run now**로 즉시 실행하고 최신 다이제스트로 이동할 수 있습니다. (앱-닫힘 실행: launchd/cron, 그리고 네이티브 알림은 후속 예정.)

### Settings

6개 서브 탭:

- **Account** — 현재 vault 경로. **Change…**로 다른 폴더로 전환, **Make this an independent Obsidian vault**로 `.obsidian/`을 스캐폴딩해 폴더를 Obsidian에서 단독으로 열 수 있게 만듭니다.
- **Model** — **Query**와 **Ingest**용 프로바이더+모델 드롭다운을 따로 지정. 모델별 월간 **비용 예산**(임계값 + 이번 달 지출, 예산 초과 시 HTTP 호출 차단), `_inbox/` 폴더용 **자동 ingest** 토글, 그리고 위키 개선 제안을 주기적으로 요청하는 **자동 반영(auto-reflect)** 토글.
- **Connections** — 다음 중 원하는 조합으로 연결:
  - **Built-in (오프라인)** — Gemma 3 1B가 앱에 내장(인프로세스 llama.cpp, Apple Silicon에선 Metal). 설치·키·인터넷 불필요 — 분류와 가벼운 질의용이며, 고품질 ingest는 클라우드 프로바이더 선택. 모델 © Google, Gemma Terms of Use 적용(전문 동봉).
  - **Claude Code (CLI)** — Pro/Max 구독 사용. 키 불필요, PATH에 `claude`만 있으면 됨.
  - **Anthropic API** — 직접 `/v1/messages` 호출.
  - **OpenAI API** — `/v1/chat/completions`. `/v1/models`로 실시간 모델 리스트.
  - **Google AI** — `:generateContent`로 Gemini 계열.
  - **Ollama** — 로컬 `http://localhost:11434`. 설치된 모델 자동 감지.
  - **OpenRouter** — `/api/v1/chat/completions`. 80개 이상 모델 실시간 카탈로그.
  
  API 키는 OS 키체인 (macOS Keychain / Windows Credential Manager / freedesktop Secret Service)에 서비스 이름 `dev.cmblir.memex`로 저장됩니다. **디스크에 평문으로 절대 쓰이지 않습니다.**
- **Language** — EN / 한국어 / 日本語 (UI). 모델의 작성 언어는 독립.
- **Appearance** — light / dark / system.
- **About** — 버전 + 설명.

### Page reader (vault 파일)

사이드바에서 파일 클릭 → 3가지 모드로 열림:

- **Source** — CodeMirror 6, markdown 하이라이트, `[[wikilink]]` 자동완성(`[[` 입력 시 vault의 모든 노트 팝업), `⌘S` 저장, 2초 idle 자동저장.
- **Preview** — markdown-it 렌더, 위키링크는 클릭 가능한 버튼.
- **Split** — 좌우 동시. 편집 즉시 프리뷰 갱신.

페이지 하단 **Backlinks** 패널에 이 노트로 링크하는 모든 노트 목록, **관련 노트** 패널에 임베딩 유사도 기준 가장 가까운 페이지 목록, 그리고 헤더 액션으로 이 페이지와 이웃에서 **Make cards**(Study)나 **오디오 개요**를 생성할 수 있습니다.

**`raw/` PDF**를 열면 인앱 **pdf.js** 뷰어가 표시됩니다(번들 워커, 네트워크 없음). 텍스트를 선택 → **Highlight & cite**로 색상 하이라이트를 만들고 노트에 `[[pdf::<stem>#p<page>:<id>]]` 핀포인트 링크를 삽입합니다. 하이라이트는 외부 사이드카(`wiki/.annotations/<stem>.json`)에 저장되어 `raw/`는 불변으로 유지됩니다. 핀포인트 링크를 클릭하면 해당 위치에서 PDF가 열리고, 하이라이트를 클릭하면 인용한 노트로 이동합니다.

트리 항목 우클릭 → **New note / New folder / Rename / Delete**. ⌘K로 파일명 stem으로 즉시 점프.

---

## 패턴

```
   ~/Documents/Memex/    당신의 vault (또는 Memex를 가리키게 한 다른 폴더)
     ├─ raw/             원본 소스. 불변.
     │    │
     │    ▼  Ingest 페이지
     ├─ wiki/            Claude가 유지하는 페이지.
     │                   인라인 인용 [^src-*]. 교차 참조.
     │                   Frontmatter 스키마 (vault별 CLAUDE.md).
     ├─ daily/           데일리 노트 (Today's note 버튼).
     ├─ ingest-reports/  각 ingest가 왜 그 결정을 내렸는지.
     ├─ cards/           플래시카드 덱 (Study) — 마크다운 + FSRS 상태.
     ├─ audio/           오디오 개요 대본.
     ├─ agents/          저장된 작업 에이전트 프리셋.
     ├─ digests/         스케줄 다이제스트 노트.
     └─ CLAUDE.md        Memex가 첫 실행 시 시드하는 유지 규칙.
     ▼
   Memex 데스크톱 + Obsidian (선택) + 셸 / git 클라이언트
   세 도구가 같은 파일을 봅니다. Memex는 vault를 잠그지 않습니다.
```

- **당신**: 소스 큐레이션, 질문, 경계 설정.
- **Claude**: 요약, 교차 참조, 인용, 모순 탐지, 커밋.
- **위키**: ingest마다 누적.

---

## 앱 밖에서 위키 다루기 (MCP)

데스크톱 앱은 UI 안에서 모든 작업을 노출하지만, 다른 곳에서 실행 중인 **Claude Desktop / Claude Code** 세션에서도 같은 vault에 접근하고 싶다면 MCP 서버를 쓰세요.

**가장 쉬운 길 — 앱이 대신 해줍니다.** 데스크톱 앱은 **MCP 서버를 번들로 포함하고 자동 등록**합니다: **Settings → MCP**에서 *Install*(앱 데이터 디렉터리에 전용 Python venv 생성) → *Register*(`claude mcp add` 자동 실행) 클릭. 이후 서버는 **앱이 현재 연 vault를 따라갑니다** — 앱이 vault 전환 때마다 다시 쓰는 `active-vault` 마커를 읽으므로, 앱에서 vault를 바꾸면 MCP 읽기/쓰기 대상도 자동으로 바뀝니다(재등록 불필요). 아래 단계는 소스 체크아웃에서 직접 구동할 때를 위한 것입니다.

<details>
<summary><b>4단계 MCP 셋업 (소스에서)</b></summary>

#### 1단계 — 서버 설치

```bash
bash mcp-server/install.sh
```

`mcp-server/.venv`에 `mcp` SDK를 설치하고 클라이언트 설정에 붙여 넣을 절대 경로를 출력합니다.

노출되는 26개 도구:

| 그룹 | 도구 |
|---|---|
| **Read** | `list_projects` `get_instructions` `stats` `list_pages` `read_page` `search` (`all_projects` 지원) `folder_tree` `recent_log` `list_raw_sources` |
| **Write** | `add_raw_source` (감지된 시크릿 경고) `create_page` `update_page` `create_folder` `git_commit` |
| **Inbox** | `list_inbox` `read_inbox_source` `archive_inbox_source` |
| **Quality (LLM 없음)** | `lint_citations` `preview_page_update` `trust_report` `contradictions` `translation_report` |
| **Governance / 멀티 프로젝트** | `resolve_cross_links` (`[[slug::page]]`) `append_changelog` `export_project` `register_vault` |

#### 2단계 — 클라이언트 선택

**Claude Code (터미널 CLI):**

```bash
claude mcp add --scope user memex \
  -- "$PWD/mcp-server/.venv/bin/python" "$PWD/mcp-server/memex_mcp.py"
claude mcp list                       # memex가 보여야 함
```

**Claude Desktop:**

> ⚠️ 먼저 Claude Desktop을 완전히 종료 (macOS는 Cmd+Q).

`~/Library/Application Support/Claude/claude_desktop_config.json` (macOS)
또는 `%APPDATA%\Claude\claude_desktop_config.json` (Windows) 편집:

```json
{
  "mcpServers": {
    "memex": {
      "command": "/Users/<you>/Memex/mcp-server/.venv/bin/python",
      "args": ["/Users/<you>/Memex/mcp-server/memex_mcp.py"]
    }
  }
}
```

#### 3단계 — 검증

> 내 Memex 프로젝트들을 보여줘.

Claude가 `list_projects`를 호출하고 응답해야 합니다.

#### 4단계 — 스키마 고정 (선택)

ingest 중심 채팅 시작 시:

> `memex.get_instructions`를 한 번 호출해. 지금부터 내가 공유하는
> 사실적인 내용은 위키 ingestion으로 처리해 — 인용 포함해서 위키에 쓰고,
> 새 페이지 만들 땐 먼저 물어보고, 마지막에 커밋해.

</details>

MCP 서버와 데스크톱 앱은 같은 `wiki/` 트리를 공유하므로, 한쪽의 변경이 다른 쪽에 즉시 반영됩니다.

---

## 소스에서 빌드

### 데스크톱 앱

요구사항: Node 20+, Rust 1.77+, OS별 [Tauri 사전 설치](https://tauri.app/start/prerequisites/).

```bash
cd app
npm install
npm run tauri dev       # 핫리로드 개발 윈도우
npm run tauri build     # src-tauri/target/release/bundle/ 에 릴리스 번들
```

전체 개발 가이드/아키텍처/IPC는 [`app/README.md`](app/README.md) 참고.

### MCP 서버

위에서 설명한 대로 — 컴파일 불필요, Python 3.10+만 있으면 됨.

---

## 멀티 프로젝트

MCP 서버는 여러 독립 wiki를 지원합니다. 각각 `projects/<slug>/` 아래에 자신의 `wiki/ raw/ CLAUDE.md .settings.json`을 가집니다.

생성 시 템플릿으로 `wiki/` 서브 폴더 자동 스캐폴딩:

| 템플릿 | 기본 폴더 |
|---|---|
| `generic` | `sources entities concepts techniques analyses` |
| `llm-research` | `sources models techniques concepts entities benchmarks analyses` |
| `reading-log` | `sources authors ideas quotes reviews` |
| `personal-notes` | `daily topics people projects` |

모든 프로젝트는 **자체 독립 Obsidian vault**로도 등록할 수 있습니다(`register_vault` / Settings 버튼이 `.obsidian/`을 스캐폴딩). 레포 전체를 하나의 vault로 열거나, 각 프로젝트 폴더를 독립적으로 열 수 있습니다.

데스크톱 앱은 현재 단일 vault에 집중합니다. vault 전환은 Settings → Account → Change.

---

## 레포지토리 레이아웃

```
app/                       Memex 데스크톱 앱 (Tauri 2 + React)
  src/                       React 프론트엔드 (TS)
  src-tauri/                 Rust 셸 + IPC
  README.md                  데스크톱 앱 문서
  PLAN.md / PROGRESS.md      빌드 히스토리
mcp-server/                MCP 서버 (26개 도구)
  memex_mcp.py
  project_registry.py        멀티 프로젝트 리졸버
  install.sh
CLAUDE.md                  루트 공통 스키마
projects/                  프로젝트별 vault
  karpathy-llm/              기본 프로젝트 (기존 루트 레이아웃에서 이관)
    CLAUDE.md  .settings.json
    wiki/  raw/  ingest-reports/
projects.json              활성 프로젝트 + 레지스트리
templates/                 프로젝트 템플릿
```

---

## 설정

### 데스크톱 앱

`~/Library/Application Support/dev.cmblir.memex/settings.json` (macOS, 다른 OS는 동등 경로)에 저장. 작업별 선택된 프로바이더/모델, 연결 플래그, 언어 보존. **API 키는 절대 저장하지 않습니다** — OS 키체인에.

프로젝트별 설정(MCP)은 `projects/<slug>/.settings.json`과 `projects/<slug>/CLAUDE.md`에.

---

## Star History

<a href="https://www.star-history.com/?repos=cmblir/memex&type=date&legend=top-left">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=cmblir/memex&type=date&theme=dark&legend=top-left" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=cmblir/memex&type=date&legend=top-left" />
   <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=cmblir/memex&type=date&legend=top-left" />
 </picture>
</a>

---

## 단축키

**데스크톱 앱:**
- `⌘K / Ctrl-K` — 명령 팔레트 (페이지/파일 점프)
- `⌘B / Ctrl-B` — 사이드바 토글
- `⌘S / Ctrl-S` — 저장 (마지막 편집 2초 후 자동 저장도)
- 에디터에서 `[[` — 위키링크 자동완성
- 사이드바 우클릭 — 새로 만들기 / 이름 변경 / 삭제

---

## 크레딧

- **패턴**: [Andrej Karpathy](https://github.com/karpathy) — *[LLM Wiki](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f)*.
- **선조**: [Vannevar Bush, "As We May Think"](https://en.wikipedia.org/wiki/As_We_May_Think), 1945.
- **빌드 도구**: [Claude Code](https://docs.anthropic.com/en/docs/claude-code).

---

<div align="center">
<br/>
<sub>MIT License · <a href="README.md">English README</a> · <a href="app/README.md">데스크톱 앱 문서</a></sub>
</div>
