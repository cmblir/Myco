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

<img src="docs/screenshots/hero-mesh.png" width="100%" alt="Memex 지식 그래프 — 약 1만 개 노트를 3D 뉴럴 메시로 렌더링, 커뮤니티별로 색칠된 빛나는 별들" />

<sub><em>실제 Memex 렌더 — 약 1만 개 노트를 3D 뉴럴 메시로. 모든 노트가 빛나는 별, 모든 <code>[[wikilink]]</code>가 필라멘트, 커뮤니티마다 고유 색과 옅은 먼지 헤일로.</em></sub>

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
| **MCP 서버** (`mcp-server/`) | Model Context Protocol을 통한 25개 도구. | Claude Desktop/Code 같은 MCP 클라이언트에서 Memex 조작. |

두 표면 모두 같은 vault 레이아웃(`raw/ wiki/ daily/ ingest-reports/`)을 공유하며 데이터를 잠그지 않습니다. 디스크 위의 평범한 마크다운, 언제나.

---

## 설치

### 데스크톱 앱 (권장)

플랫폼별 번들 다운로드:

- **macOS Apple Silicon**: `Memex_0.1.0_aarch64.dmg` (CI 릴리스 전까지는 [소스에서 빌드](#소스에서-빌드))
- **Windows x64**: `Memex_0.1.0_x64-setup.exe`

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
<img src="docs/screenshots/mesh.gif" width="100%" alt="Memex 3D 뉴럴 메시 그래프가 천천히 자동 회전 — 커뮤니티 색 빛나는 별, 위키링크 필라멘트, 옅은 먼지 헤일로" />
<br/>
<sub><em>약 1만 개 노트 vault를 3D 뉴럴 메시로 렌더링하는 Graph 화면 — 커뮤니티 색 빛나는 별, <code>[[wikilink]]</code> 필라멘트, 옅은 우주먼지 헤일로가 천천히 자동 회전합니다. 별을 잡으면 d3-force-3d 시뮬레이션이 재가열돼 이웃이 따라오고 놓으면 제자리로 돌아옵니다.</em></sub>
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
<td width="50%"><img src="docs/screenshots/settings.png" alt="Settings — 작업별 프로바이더 + 모델 선택" /></td>
</tr>
<tr>
<td align="center"><sub><strong>Reader</strong> — 소스 / 분할 / 프리뷰 + 백링크</sub></td>
<td align="center"><sub><strong>Settings</strong> — Query / Ingest 모델 분리 지정</sub></td>
</tr>
</table>

> 시드 샘플 vault에서 실행 중인 앱을 캡처. 새로 설치하면 상호 연결된 시작 노트
> ~50개(LLM 지식 맵)가 시드되어 첫날부터 Graph가 이렇게 보입니다 — 언제든 삭제 가능.

---

## 데스크톱 앱

왼쪽 사이드바에 7개 라우트. ⌘K로 명령 팔레트, ⌘B로 사이드바 토글.

### Overview

Vault 통계 (파일 수, 해결된 위키링크, 비율), 최근 git 활동, 가장 많이 편집된 노트로 점프하는 카드들.

### Ingest

1. 파일 드롭 또는 텍스트 붙여넣기 → Memex가 `raw/<slug>.md`에 저장.
2. 활성 **ingest 모델** 호출 (기본: Claude CLI), vault를 cwd로.
3. Claude가 소스를 읽고, 영향받는 wiki 페이지를 찾고, 인용을 추가하고, `wiki/source-<slug>.md`를 생성/갱신하고, `wiki/log.md`에 추가하고, `ingest-reports/<datetime>-<slug>.md`에 WHY를 기록.
4. 트리와 그래프 새로고침.

### Ask

위키에 대한 질문에 답하는 채팅 화면. 활성 **query 모델**이 vault 루트에서 실행되며 시스템 프리앰블이 `wiki/`를 먼저 Read/Grep 도구로 조회한 뒤 필요하면 `raw/`로 내려가도록 유도합니다. 세션별 대화 히스토리 유지.

### Graph

**three.js**(WebGL) + **d3-force-3d**로 vault 전체 링크 그래프를 **3D 뉴럴 메시**로 렌더링 — Obsidian이 쓰는 동일한 포스 패밀리(`forceLink` + `forceManyBody` + `forceX/Y/Z` + 충돌)를 적용하고, 각 링크 강도를 노드 차수로 정규화합니다. 기본값에는 **커뮤니티 클러스터링 포스가 없어**(Obsidian과 동일) 노트가 몇 개 덩어리가 아니라 하나의 고른 유기적 그물로 퍼집니다. 노드는 빛나는 별, 엣지는 `[[wikilinks]]`가 커뮤니티 색 옅은 필라멘트로 그려지고, 응집된 클러스터 곁엔 **옅은 우주먼지 헤일로**가 맴돕니다. 노드 발광은 power-law이며 **상한 캡**이 있어, 모든 것이 링크되는 `index`/MOC도 흰 덩어리가 아니라 밝은 별로 남습니다. **링크 없는 고아까지 모든 노트가 표시**되고, 아직 안 쓴 노트로의 미해결 링크는 **고스트 노드**로 옅게 나타납니다(Obsidian처럼; 드로어의 *고립 노드 표시* / *존재하는 파일만* 토글).

링크 해석도 Obsidian과 일치 — `[[note]]`, `[[note|별칭]]`, `[[note#heading]]`, `![[임베드]]`, 그리고 Obsidian **Bases** 같은 비-`.md` 파일 링크(`[[Table.base]]`)까지 모두 해석돼, 그래프가 링크 절반을 버리지 않고 실제 링크 망을 그대로 반영합니다.

**드래그로 카메라를 회전**, 스크롤로 줌(넓게 퍼진 큰 vault도 끝까지 빼서 한눈에 담을 만큼 축소 범위 확대). 평소엔 천천히 자동 회전합니다. **별(노드)을 잡으면 시뮬레이션이 재가열**돼 이웃이 3D로 따라오고, 놓으면 제자리로 돌아옵니다. UnrealBloom 발광·depth fog·엣지를 따라 흐르는 **신호 펄스**로 살아있는 우주 느낌을 내고, 드로어의 **밝기(Brightness)** 슬라이더로 발광을 조절합니다. 앱 밖(Obsidian/Finder 편집, ingest 완료 등)에서 파일이 바뀌면 파일트리와 그래프가 **자동 갱신**됩니다.

우측 설정 드로어(톱니바퀴 아이콘)가 Obsidian 패널 구성을 따릅니다:

- **Filters** — 파일명 라이브 검색, 태그 칩, 폴더 드롭다운, *고립 노드 표시* / *존재하는 파일만* 토글.
- **Display** — *화살표*, *라벨 페이드 임계*, *노드 크기*, *링크 두께*, *밝기*, 그리고 **▶ 애니메이션 재생** 버튼.
- **Forces** — *중심력*, *반발력*, *링크 장력*, *링크 거리*, 그리고 *클러스터 포스*(0 = 고른 뉴럴 메시 ↔ 높일수록 커뮤니티가 별도 "은하"로 응집). 각 슬라이더가 실제 d3-force-3d 파라미터를 직접 조작합니다.

**타임랩스**(툴바 ▶ 또는 드로어 버튼)는 파일 mtime 순(오래된 것부터)으로 노드를 **정착 위치 그대로 공개**합니다 — 노드가 연결될 때마다 엣지가 나타나, 실제로 작성한 순서대로 그래프가 스스로 자라는 모습을 보여줍니다. 물리 연산 없는 순수 reveal이라 vault 크기와 무관하게 부드럽고, 카메라는 전체 그래프에 고정됩니다.

노드 위에 마우스를 올리면 1-hop 이웃이 강조되고 나머지는 디밍됩니다. 클릭하면 파일이 열립니다. 마우스 휠 + 배경 드래그로 줌·팬, 툴바에 줌인/맞춤/줌아웃. 드로어 상태와 모든 슬라이더 위치는 localStorage에 영속됩니다.

### History

Vault 디렉터리의 `git log`를 읽어 각 커밋의 제목, 해시, 날짜, `+/~` 줄 수를 표시. HEAD 표기. 아직 git repo가 아니면 `git init` 가이드 인라인.

### Provenance

페이지별 **인용 커버리지** — 전체 주장 라인 vs 인용된 주장 라인. 커버리지 낮은 순 정렬, 슬라이더 임계값 미만은 플래그.

**Run lint**는 CLAUDE.md의 lint 체크리스트(구조/인용/연결/신선도)를 활성 query 모델로 보내고 Markdown 보고서를 인라인 렌더.

### Settings

6개 서브 탭:

- **Account** — 현재 vault 경로. **Change…**로 다른 폴더로 전환.
- **Model** — **Query**와 **Ingest**용 프로바이더+모델 드롭다운을 따로 지정. 한 작업의 프로바이더만 바꿔도 다른 연결은 그대로.
- **Connections** — 다음 중 원하는 조합으로 연결:
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

페이지 하단 **Backlinks** 패널에 이 노트로 링크하는 모든 노트 목록.

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

노출되는 25개 도구:

| 읽기 전용 | 쓰기 |
|---|---|
| `list_projects` `list_pages` `read_page` `search` `folder_tree` `stats` `recent_log` `list_raw_sources` `get_instructions` | `add_raw_source` `create_page` `update_page` `create_folder` `git_commit` |

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

데스크톱 앱은 현재 단일 vault에 집중합니다. vault 전환은 Settings → Account → Change.

---

## 레포지토리 레이아웃

```
app/                       Memex 데스크톱 앱 (Tauri 2 + React)
  src/                       React 프론트엔드 (TS)
  src-tauri/                 Rust 셸 + IPC
  README.md                  데스크톱 앱 문서
  PLAN.md / PROGRESS.md      빌드 히스토리
mcp-server/                MCP 서버 (25개 도구)
  memex_mcp.py
  project_registry.py        멀티 프로젝트 리졸버
  install.sh
CLAUDE.md                  루트 공통 스키마
projects/                  프로젝트별 vault (MCP)
  <slug>/
    CLAUDE.md
    .settings.json
    wiki/  raw/  ingest-reports/
projects.json              활성 프로젝트 + 레지스트리 (MCP)
templates/                 프로젝트 템플릿
raw/ wiki/ ...             레거시 단일 프로젝트 모드 (여전히 지원)
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
