<div align="center">

<br />

<img src="docs/myco-banner.jpg" width="100%" alt="myco — 소스를 먹이면, 당신의 은하가 자랍니다" />

<h1>myco</h1>

<p><strong>스스로 자라는 개인 지식 베이스.</strong></p>

<p>
소스를 떨어뜨리면, Claude가 정리를 맡습니다.<br/>
지식은 복리로 쌓입니다 — 당신이 소유한 평범한 마크다운으로.
</p>

<p>
<a href="https://github.com/cmblir/Memex/releases/latest"><img alt="Install" src="https://img.shields.io/badge/install-DMG%20%2F%20EXE-111?style=flat-square" /></a>
&nbsp;
<img alt="License" src="https://img.shields.io/badge/license-MIT-111?style=flat-square" />
&nbsp;
<img alt="Tauri 2" src="https://img.shields.io/badge/Tauri-2-111?style=flat-square" />
&nbsp;
<a href="README.md"><img alt="English" src="https://img.shields.io/badge/English-README-111?style=flat-square" /></a>
</p>

<br />

<p>
<em>"Obsidian은 IDE, Claude는 프로그래머, 위키는 코드베이스."</em>
</p>

<br />

<p>
<strong>만든 쪽이 사라져도 남도록 만들었습니다.</strong> MIT 라이선스이고, vault는 <code>grep</code>으로 뒤질 수 있는<br/>
평범한 마크다운입니다 — myco를 지워도 모든 페이지를 그대로 읽고 찾고 고칠 수 있습니다.<br/>
로컬 git 이력은 선택입니다. 켜면 편집마다 작성자가 남아, 내가 쓴 것과 에이전트가 쓴 것을 구분하고<br/>
어느 쪽이든 되돌릴 수 있습니다. <code>raw/</code>는 불변이라 원본을 고쳐 쓰는 경로 자체가 없습니다.<br/>
서버도, 계정도, 로그인도 없습니다 — 움직이는 부품은 앱 하나뿐이고, 그건 버려도 되는 쪽입니다.
</p>

<br />

<img src="docs/screenshots/hero-mesh.png" width="100%" alt="myco 지식 그래프 — vault를 3D 우주 거미줄로 렌더링" />

<sub><em>Graph 뷰. 모든 노트는 링크 수만큼 커지는 별, 커뮤니티마다 고유한 색, <code>[[위키링크]]</code>가 이들을 잇는 조직입니다.</em></sub>

</div>

---

## 왜?

대부분의 LLM+문서 구성은 **쿼리마다 지식을 다시 유도**합니다. RAG가 청크를 찾고, 모델이 답을 짜맞추고, 아무것도 남지 않습니다. 같은 문서에 열 번 질문하면 → 열 번 재발견합니다.

**myco는 이걸 뒤집습니다.** 소스를 한 번 추가하면 Claude가 읽고, 영속 위키에 통합하고, 기존 페이지와의 모순을 표시하고, 인용을 연결하고, 커밋합니다. 열 번째 질문쯤엔 위키 자체가 답합니다 — 정리는 이미 끝나 있으니까요.

[Andrej Karpathy의 LLM Wiki 패턴](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f)에 기반합니다. 뿌리는 [Vannevar Bush의 1945년 Memex](https://en.wikipedia.org/wiki/Memex)까지 거슬러 올라가며, 프로젝트의 원래 이름이기도 했습니다.

```
  raw/              원본 소스. 불변.
    │  Ingest
    ▼
  wiki/             Claude가 유지하는 페이지. 인용 [^src-*], 상호 연결.
    │
    ▼
  myco 데스크톱 + Obsidian(선택) + 셸 / git 클라이언트
  모두 같은 파일을 봅니다. myco는 vault를 잠그지 않습니다.
```

---

## 무엇이 다른가

가장 익숙한 비교 대상은 **NotebookLM**입니다. 소스를 넣고, 묻고, 근거 있는 답을
받습니다. 그 한 세션은 아주 잘 해냅니다. 멈추는 지점은 이렇습니다:

| NotebookLM이 멈추는 곳 | myco는 이렇게 합니다 |
|---|---|
| **답이 도구 안에만 남습니다.** 밖으로 꺼내는 순간 인용은 내 것을 가리키지 않게 됩니다. | Ingest가 답의 내용을 내 폴더 안의 인용된 마크다운 페이지로 남깁니다 — `[^src-*]` 각주는 `raw/`에 실제로 놓인 파일로 이어집니다. |
| **노트북마다 섬입니다** — 사이를 넘어가는 기억이 없습니다. | vault 하나, 그래프 하나. 새 소스는 이미 있는 페이지에 합쳐지고, 기존 페이지와 충돌하는 주장은 조용히 중복되는 대신 표시됩니다. |
| **페이지 단위 인용 이력이 없습니다** — 이 페이지가 무엇으로 만들어졌는지, 어젯밤 무엇이 바뀌었는지 물을 수 없습니다. | 출처 페이지가 모든 `[^src-*]`를 원본으로 되짚고 끊긴 인용을 표시합니다. 실행 로그는 각 런을 파일별로 되짚어 주고 — vault 이력을 켜면 단어 단위 diff까지 — 런 전체를 한 번에 되돌립니다. |
| **노트북을 가로지르는 검색이 없습니다.** | `⌘K`가 vault 전체를 한 번에 찾습니다 — `"정확한 구절"`, `path:` / `tag:` 필터, 키워드와 시맨틱 결과가 한 목록에 나옵니다. |
| **노트북당 소스 개수 상한이 있습니다.** | 상한이 없습니다. 소스는 그냥 파일이고, 한계는 디스크입니다. |

**Obsidian + 에이전트 플러그인과 비교하면** 파일은 똑같이 생겼습니다 — 그게
핵심이고, myco는 vault를 잠그지 않으니 같은 폴더를 Obsidian으로 계속 열어 두어도
됩니다. 차이는 *검토할 수 있는가*입니다. 신뢰 표면이 여기서는 기본 기능입니다:
에이전트의 편집을 단어 단위 diff로 보여 주고 되돌리기를 바로 옆에 두는 실행 로그,
페이지 헤더의 작성자 배지(사람/에이전트 줄 비율, 마지막 사람 손길)와 사이드바의
사람 작성 필터, 시크릿이 불변 `raw/`에 닿기 *전에* 막는 민감정보 차단 게이트,
그리고 개요에서 분쟁 페이지를 두 번 클릭으로 정리하는 모순 큐. 에이전트가 vault를
고치게 만드는 건 쉬운 쪽입니다. 무엇을 했는지 읽고, 누가 썼는지 가리고, 되돌릴 수
있게 만드는 쪽이 실제로 만들어야 하는 절반입니다.

**플래시카드는 실제로 스케줄됩니다.** 카드 생성은 기본기입니다 — NotebookLM도
합니다. myco는 그걸 *스케줄*합니다: FSRS 상태가 덱의 평범한 마크다운에 저장되고
Obsidian spaced-repetition 플러그인과 왕복하므로, 한 번 내보내고 잊는 학습 자료가
아니라 실제 곡선을 따라 복습이 도래합니다.

---

## 설치

**[최신 릴리즈](https://github.com/cmblir/Memex/releases/latest)**에서 플랫폼에 맞는 번들을 받으세요:

- **macOS** (Apple Silicon): `myco_x.y.z_aarch64.dmg` — 미서명; 첫 실행 시
  Gatekeeper 경고가 뜹니다 (앱 우클릭 → **열기** → **열기**, 또는
  **시스템 설정 → 개인정보 보호 및 보안 → "그래도 열기"**).
- **Windows x64**: `myco_x.y.z_x64-setup.exe` — 미서명; 첫 실행 시 SmartScreen
  경고가 뜹니다 (**추가 정보 → 실행**).

첫 실행 시 `~/Documents/myco/`를 만들고 유지 규칙(`CLAUDE.md`), `raw/`,
`wiki/`(첫날부터 Graph가 채워져 보이도록 상호 연결된 스타터 노트 — 언제든 삭제
가능), `daily/`, `ingest-reports/`를 시드합니다. 다른 폴더(기존 Obsidian vault
등)를 쓰려면: 설정 → 계정 → 변경…

---

## 스크린샷

<p align="center">
<img src="docs/screenshots/mesh.gif" width="100%" alt="천천히 자동 궤도를 도는 myco 3D 그래프" />
</p>

<table>
<tr>
<td width="50%"><img src="docs/screenshots/overview.png" alt="개요 — vault 통계, 최근 활동" /></td>
<td width="50%"><img src="docs/screenshots/provenance.png" alt="출처 — 페이지별 인용 커버리지" /></td>
</tr>
<tr>
<td align="center"><sub><strong>개요</strong> — 통계, 바로가기, 최근 활동</sub></td>
<td align="center"><sub><strong>출처</strong> — 페이지별 인용 커버리지</sub></td>
</tr>
<tr>
<td width="50%"><img src="docs/screenshots/reader.png" alt="리더 — 소스, 미리보기, 백링크" /></td>
<td width="50%"><img src="docs/screenshots/settings.png" alt="설정 — 작업별 프로바이더·모델 선택" /></td>
</tr>
<tr>
<td align="center"><sub><strong>리더</strong> — 소스 / 분할 / 미리보기 + 백링크</sub></td>
<td align="center"><sub><strong>설정</strong> — Query / Ingest 모델 분리</sub></td>
</tr>
<!-- TODO(owner): trust-surface screenshots — 실행 로그 단어 diff + 작성자 배지를
     세 번째 행으로 추가. 실제 vault에서 headed 캡처가 필요합니다. -->
</table>

---

## 기능

**Ingest** — 파일을 드롭하거나 텍스트를 붙여넣으면 `raw/`에 저장되고, 활성
모델이 인용·로그·WHY 리포트와 함께 `wiki/`에 통합합니다. 입력은 멀티모달:
PDF, Office 문서, 스프레드시트, 이미지(비전 프로바이더), 오디오/비디오(설치된
`whisper` CLI), YouTube URL. 내장 오프라인 임베딩 인덱스(bge-m3, 인프로세스
llama.cpp)가 시맨틱 검색과 페이지별 관련 노트를 제공합니다.

**Ask & 에이전트 모드** — 연결된 어떤 모델로든 위키와 대화합니다. 에이전트
모드는 툴 지원 프로바이더를 자율 리서처로 바꿉니다: 검색하고, 페이지를 읽고,
링크를 타고, 인용과 함께 답합니다. 쓰기 도구는 호출마다 확인을 받으며 `raw/`는
절대 건드리지 않습니다. 오디오 개요는 답변의 인용 페이지를 두 명의 진행자가
나누는 대화로 오프라인 렌더링합니다.

**Graph** — vault 전체를 3D 우주 거미줄로 (three.js + d3-force-3d). Louvain
커뮤니티별 색상과 자동 명명 클러스터 라벨, 허브만 빛나는 블룸, Obsidian처럼
고아 노트·고스트 링크 표시. 별을 잡아끌면 시뮬레이션이 다시 달아오르고, 이웃
고립·최단 경로·vault가 스스로 만들어지는 타임랩스도 있습니다. 정적 2D 아틀라스,
자라난 균사 매트 등 대체 레이아웃 엔진 포함. ~1만 노드까지 60fps.

**Study** — 어떤 페이지에서든 플래시카드 생성; FSRS 스케줄링이 붙은
평문 마크다운 덱으로 Obsidian spaced-repetition 플러그인과 왕복 호환됩니다.

**할 일(Tasks)** — vault의 모든 `- [ ] …` 체크박스를 한곳에: 목록, 체크박스
표시 자체가 칸이 되는 칸반 보드, 그리고 시작일과 마감일이 있는 일은 기간 막대로
그려지는 월 캘린더. 항목을 누르면 날짜·우선순위·예상 시간·반복 규칙을 고치는
패널이 열리고, 값은 Obsidian Tasks와 같은 마커(`🛫 ⏳ 📅 ✅ 🔁`)로 그 줄에 적혀
플러그인에서도 그대로 동작합니다. 반복 일정을 완료하면 다음 회차가 적힙니다.
달마다 생성되는 `wiki/tasks/<YYYY-MM>.md`는 일정을, 그 일이 링크한 프로젝트
옆의 그래프 노드로 올려 둡니다. 추가할 때 카테고리(`#태그`, 기존 태그에서
제안)·프로젝트(`[[페이지]]`)·추가할 노트(오늘 데일리 또는 로드맵)를 함께 적을
수 있습니다. 로드맵은 마일스톤과 체크박스로 된 페이지
(`wiki/roadmaps/<슬러그>.md`)로, 전용 탭에서 마일스톤별 진행률을 보여주며 코딩
세션이 MCP(`list_tasks`, `set_task_status`, `add_task`)로 읽고 체크하고
이어 쓸 수 있습니다.

**Schedules** — 반복 다이제스트: 상시 쿼리, "무엇이 바뀌었나", 신선도 점검,
토픽 추적. 실행마다 인용된 마크다운 노트를 `digests/`에 남깁니다.

**증류(Distillation)** — 유휴 시간에 새로 들어온 raw/세션 인플로우를 위키의
토픽 클러스터에 대조해 채점합니다: 정크는 임베딩 비용 없이 걸러지고, 근접
중복·주제 이탈 항목은 격리 후 폐기되며, 이미 위키에 반영된 raw 소스는 날짜별
아카이브로 이동합니다. 제안은 피드백 페이지에서 검토하고, 강도·게이트
엄격도·실행 일정은 설정에서 조정합니다. 압축은 세 단계로 이뤄집니다 — 하루치
세션 로그는 `daily/`로, 마감된 한 주의 일일 다이제스트는 `weekly/`로, 마감된
한 달의 주간 롤업은 `monthly/`로 모이고, 각 단계의 원본은 요약된 뒤 콜드
아카이브로 옮겨집니다. 클러스터별 토픽 맵을
초안하며, 프로필을 설정하면 Ask와 ingest를 사용자의 역할·관심사에 맞춰
개인화합니다.

**실행 로그와 되돌리기** — distill·ingest 런이 각각 무엇을 옮기고, 만들고,
버렸는지와 함께 최신순으로 나열됩니다. 하나를 펼치면 파일별 행이 보이고, vault
이력을 켜 두었다면 어떤 단어가 바뀌었는지까지 단어 단위 diff로 확인합니다.
*이 런 되돌리기*는 런 매니페스트를 거꾸로 재생합니다 — 휴지통 복구, 이동 취소,
생성된 페이지 삭제 — git 없이도 동작합니다. 런이 제자리에서 고쳐 쓴 내용은
되돌려지지 않고 diff로 보여 줍니다.

**작성자 표시** — vault 이력을 켜면 에이전트 커밋에 별도 작성자가 남습니다.
그래서 페이지 헤더에 줄 단위 사람/에이전트 비율과 마지막 사람 손길을 표시하고,
사이드바에서 에이전트가 한 번이라도 커밋한 페이지를 숨길 수 있습니다. 이력을 켠
날 이후만 집계하며 그 사실을 그대로 밝힙니다 — 이력이 없으면 배지도 없습니다.
누가 썼는지 추측하지 않습니다.

**되살리기와 리추얼** — distill 런이 끝나면 오늘의 노트를 임베딩해, 한 달 동안
열지 않은 위키 페이지 중 지금의 맥락과 공명하는 것을 찾습니다. 한두 개가 개요의
*오늘의 재회*로 올라오고, 무엇이 걸렸는지 보여 주는 스니펫과 오늘 복습할 카드가
함께 놓입니다. 열거나, 일주일 미루거나, 무시할 수 있고, 유사도 기준선은 수락
비율에 맞춰 스스로 조정됩니다.

**민감정보 차단과 감사** — 불변 `raw/`에는 검사를 거치지 않은 것이 들어가지
않습니다. 키처럼 생긴 문자열(AWS, `sk-`, GitHub, Slack, Google, PEM 블록)은 쓰기
자체가 막힙니다 — 인박스 패스, `_inbox/`에서의 승격, 대화 임포트, 헤드리스 데몬,
두 MCP 서버가 모두 쓰기 전에 검사합니다. 이메일·전화번호·주민등록번호는 기본이
경고이고, 더 엄격한 vault를 위한 격리 모드가 설정에 있습니다. 읽기 전용 감사
카드는 현재 `raw/` 전체와 그 뒤의 git 이력까지 다시 훑어, 어떤 패턴이 걸렸는지만
보고하고 파일은 건드리지 않습니다.

**기간이 걸린 Ask** — "지난주에 뭘 결정했지"라고 물으면 질문에서 기간을 뽑아내고
(EN / 한국어 / 日本語: 오늘, 지난주, 특정 월, 명시적 날짜), 로컬 검색을 실제로 그
기간에 속한 소스로 제한합니다 — 일일 노트, 세션, 주간·월간 롤업 — 동점은
최신순으로 가릅니다. 답변은 사용한 기간을 함께 보여 주고, 그 기간에 아무것도
없으면 없다고 말합니다. 외부 프로바이더에서는 기간이 하드 필터가 아니라 지시문으로
전달됩니다.

**음성 캡처** — Spotlight에서 `⌥M`으로 녹음하고 Enter로 저장하면, 설치된
`whisper`가 받아쓴 노트가 `_inbox/`에 떨어져 평소의 ingest 파이프라인을 탑니다.
whisper는 내장되어 있지 않습니다 — PATH에 없으면 그렇다고 알리고 아무것도 쓰지
않습니다.

**리더** — CodeMirror 소스 / 라이브 미리보기 / 분할, `[[위키링크]]` 자동완성,
백링크·관련 노트 패널. `raw/` PDF는 인앱 pdf.js 뷰어로 열립니다: 텍스트 선택 →
하이라이트 & 인용이 핀포인트 링크를 만들고, 하이라이트는 사이드카에 저장되어
`raw/`는 불변으로 남습니다.

**프로바이더** — 내장 오프라인 임베딩(키·설치 불필요), Claude Code CLI(Pro/Max
구독), Anthropic / OpenAI / Google AI / OpenRouter API, 로컬 Ollama.
Query와 Ingest 모델 분리 선택, 월 비용 예산. API 키는 OS 키체인에만 저장 —
디스크에 평문으로 남지 않습니다.

**설정 이동** — Settings → About → Export/Import로 프로바이더, 자동화 토글,
외관, 그래프 룩을 JSON 파일 하나에 담아 다른 기기로 옮길 수 있습니다. API 키,
vault 경로, 이 기기의 식별 정보는 담기지 않습니다. 가져오기는 무엇을 교체하는지
먼저 알려주고, 앱을 종료하기 전까지 되돌릴 수 있습니다.

**노치 드롭 서피스** *(macOS, 옵트인)* — 맥북 노치 아래 조용히 사는 드롭
타깃. 화면 맨 위로 파일을 끌고 가면 펼쳐지고, 놓으면 `_inbox/`에 앉아
인제스트가 주워 가며, 패널은 스스로 접힙니다. 포커스를 뺏지 않고 메뉴바
위에 떠 있으며, 노치 없는 맥에서는 메뉴바 알약으로 나타납니다. 설정 → 모델
→ "노치 드롭 서피스".

**웹 클리퍼** — 브라우저 확장 + 북마클릿(`clipper/`)으로 어떤 페이지나 선택
영역이든 딥링크를 통해 vault 인박스로 보냅니다.

`⌘K` 커맨드 팔레트(파일·라우트·전문+시맨틱 검색), EN / 한국어 / 日本語 UI,
라이트/다크, 320px까지 반응형.

---

## MCP 서버

같은 vault를 Claude Desktop, Claude Code, 어떤 MCP 클라이언트에서든 쓸 수
있습니다.

**가장 쉬운 길 — 앱이 호스팅.** 데스크톱 앱이 MCP 서버를 인프로세스로
실행합니다(Python 불필요). **설정 → MCP** → **Claude Code에 연결**. 서버는 앱이
현재 연 vault를 따라가고, 토큰이 유지되므로 한 번만 연결하면 됩니다.

<details>
<summary><b>독립 Python 서버 (소스 체크아웃 / 비앱 클라이언트)</b></summary>

Python 3.10+ 필요 (런타임은 표준 라이브러리만).

```bash
bash mcp-server/install.sh            # mcp-server/.venv 생성
bash mcp-server/serve.sh              # http://127.0.0.1:22360/sse 서빙
claude mcp add --transport sse myco http://localhost:22360/sse
```

Claude Desktop은 stdio — `claude_desktop_config.json`에 추가:

```json
{
  "mcpServers": {
    "myco": {
      "command": "<repo>/mcp-server/.venv/bin/python",
      "args": ["<repo>/mcp-server/myco_mcp.py"]
    }
  }
}
```

28개 도구: 읽기(`list_pages` `read_page` `search` `folder_tree` …),
쓰기(`add_raw_source` `create_page` `update_page` `git_commit` …), 인박스,
no-LLM 품질 검사(`lint_citations` `trust_report` `contradictions` …),
멀티 프로젝트 거버넌스(`resolve_cross_links` `export_project` `register_vault`
…). 독립 서버는 `projects/<slug>/` 아래 여러 독립 위키를 관리하며, 각각 자체
`wiki/ raw/ CLAUDE.md`를 가집니다.

</details>

---

## 소스에서 빌드

사전 준비: Node 20+, Rust 1.77+, OS별
[Tauri prerequisites](https://tauri.app/start/prerequisites/).
Git LFS로 클론하세요 (내장 임베딩 모델이 LFS에 저장됩니다).

```bash
cd app
npm install
npm run tauri dev       # 핫리로드 개발 창
npm run tauri build     # 릴리즈 번들: src-tauri/target/release/bundle/
```

테스트와 린트:

```bash
cd app && npm run lint && npx tsc -b && npx vitest run
cd app/src-tauri && cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo test
```

개발 가이드는 [`app/README.md`](app/README.md), 릴리즈/서명 절차는
[`docs/SIGNING.md`](docs/SIGNING.md)를 참조하세요. 이슈와 PR 환영합니다.

---

## Star History

<a href="https://www.star-history.com/?repos=cmblir/Memex&type=date&legend=top-left">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=cmblir/Memex&type=date&theme=dark&legend=top-left" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=cmblir/Memex&type=date&legend=top-left" />
   <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=cmblir/Memex&type=date&legend=top-left" />
 </picture>
</a>

---

## 크레딧

- **패턴**: [Andrej Karpathy](https://github.com/karpathy) — *[LLM Wiki](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f)*.
- **선조**: [Vannevar Bush, "As We May Think"](https://en.wikipedia.org/wiki/As_We_May_Think), 1945.
- **제작 도구**: [Claude Code](https://docs.anthropic.com/en/docs/claude-code).

---

<div align="center">
<br/>
<sub>MIT License · <a href="README.md">English README</a> · <a href="app/README.md">Desktop app docs</a></sub>
</div>
