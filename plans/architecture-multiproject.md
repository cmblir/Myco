---
title: "Architecture — 멀티 프로젝트 저장소 레이아웃"
created: 2026-04-23
status: draft
owner: yoo
scope: MP-01
---

# Multi-Project Architecture (MP-01)

## 1. 목표

현재 루트에 고정된 단일 위키(`wiki/`, `raw/`, `CLAUDE.md`)를 `projects/<slug>/` 하위로
격리하여, 하나의 대시보드에서 여러 주제의 독립 위키를 선택적으로 운영한다.

원칙:

- **격리(Isolation)**: 한 프로젝트의 ingest/query/lint가 다른 프로젝트 데이터를 읽거나 쓰지 않는다.
- **단일 프로세스**: 서버는 하나. 프로젝트 전환은 상태 변경(레이어 스위치)이며 프로세스 재시작 아님.
- **하위호환(Legacy mode)**: 마이그레이션 전에도 서버가 동작. `projects.json`이 없으면 현재 루트의 `wiki/raw/`를 "default" 프로젝트로 간주.
- **git 연속성**: 파일 이동은 `git mv`. 히스토리 보존.

---

## 2. 디렉터리 트리 (목표 상태)

```
.
├── projects/
│   ├── karpathy-llm/                    ← 마이그레이션 후 현재 위키
│   │   ├── CLAUDE.md                    (프로젝트별 스키마)
│   │   ├── .settings.json               (프로젝트별 model 등)
│   │   ├── raw/                         (immutable)
│   │   │   └── assets/
│   │   ├── wiki/
│   │   │   ├── index.md
│   │   │   ├── log.md
│   │   │   ├── overview.md
│   │   │   ├── sources/                 (MP-09 권장 폴더)
│   │   │   ├── entities/
│   │   │   ├── concepts/
│   │   │   ├── techniques/
│   │   │   └── analyses/
│   │   ├── ingest-reports/
│   │   ├── reflect-reports/
│   │   ├── plans/
│   │   │   ├── today-queue.md
│   │   │   ├── backlog.md
│   │   │   └── blocked.md
│   │   └── query-log.jsonl
│   └── <future-project>/
│       └── ... (동일 구조)
├── projects.json                        ← 프로젝트 레지스트리 (루트 유지)
├── templates/
│   └── CLAUDE.md                        ← 스타터 스키마 (MP-06에서 채움)
├── dashboard/                           ← UI 서버 (프로젝트 비의존)
├── logs/                                ← 자율모드 세션 로그 (루트 유지)
├── plans/                               ← 멀티 프로젝트 전환용 플랜 (전환 완료 후 projects/karpathy-llm/plans/로 이동)
├── CLAUDE.md                            ← 루트 스키마 (공통 규칙만 유지)
├── README.md / README-ko.md             ← 프로젝트 비의존 문서
└── .obsidian/                           ← 루트 vault 설정
```

### 루트에 유지할 것 vs 프로젝트 스코프로 내릴 것

| 항목 | 위치 | 근거 |
|------|------|------|
| `dashboard/` | 루트 | 서버는 단일. 프로젝트를 스위치. |
| `projects.json` | 루트 | 레지스트리 파일 (프로젝트 목록, active) |
| `templates/` | 루트 | 신규 프로젝트 생성 시 복제 원본 |
| `logs/` | 루트 | 자율모드 세션 로그는 서버 레벨 작업 기록 |
| `.obsidian/` | 루트 | Obsidian vault 하나에서 모든 프로젝트 탐색 (Q-2는 미결) |
| `.gitignore` | 루트 | repo 레벨 |
| `README.md` | 루트 | 프로젝트 비의존 소개 |
| `CLAUDE.md` | 루트 | 공통 규칙(이 파일이 있으면 프로젝트 CLAUDE.md보다 우선순위 낮음) |
| `wiki/`, `raw/`, `ingest-reports/`, `reflect-reports/`, `query-log.jsonl` | 프로젝트 | 콘텐츠 |
| `.dashboard-settings.json` | **삭제** → `projects/<slug>/.settings.json`로 분산 | |
| 프로젝트별 `plans/` | 프로젝트 | 프로젝트별 작업 큐 |

### 마이그레이션 전 (legacy mode) 동작

- `projects.json` 파일이 없으면 서버는 "legacy" 상태로 간주.
- `get_project(name=None)` → `name`이 없으면 legacy 경로 반환 (현재의 `wiki/ raw/ CLAUDE.md`).
- 대시보드 헤더에 "프로젝트: (legacy)" 표시 + 마이그레이션 유도 버튼.

---

## 3. `projects.json` 스키마

```json
{
  "version": 1,
  "active": "karpathy-llm",
  "projects": [
    {
      "slug": "karpathy-llm",
      "title": "Karpathy LLM Wiki",
      "description": "Andrej Karpathy 관련 LLM 자료 수집",
      "model": "claude-opus-4-7",
      "created": "2026-04-22",
      "last_used": "2026-04-23",
      "template": "llm-research"
    }
  ]
}
```

필드 규칙:
- `slug` — `make_slug()` 결과. 영숫자 + 하이픈 + 유니코드(한글) 허용. 중복 금지. 디렉터리명.
- `active` — 현재 선택된 프로젝트 슬러그. 없으면 legacy.
- `model` — `AVAILABLE_MODELS`의 id 중 하나. 프로젝트 `.settings.json`과 동기화.
- `template` — 신규 생성 시 복제한 템플릿 variant 이름 (MP-06).

---

## 4. Resolver API (MP-03에서 구현)

### 4.1 코어 함수

```python
from dataclasses import dataclass
from pathlib import Path

@dataclass(frozen=True)
class Project:
    slug: str                 # "karpathy-llm" | "" (legacy)
    is_legacy: bool           # projects.json 없을 때 True
    root: Path                # projects/<slug>/ or PROJECT_ROOT
    wiki_dir: Path            # <root>/wiki
    raw_dir: Path             # <root>/raw
    claude_md: Path           # <root>/CLAUDE.md
    settings_file: Path       # <root>/.settings.json (legacy면 PROJECT_ROOT/.dashboard-settings.json)
    ingest_reports: Path
    reflect_reports: Path
    plans_dir: Path
    query_log: Path
    title: str
    model: str                # 현재 모델
```

```python
def list_projects() -> list[dict]: ...          # projects.json 파싱
def get_active_slug() -> str | None: ...
def get_project(slug: str | None = None) -> Project: ...
def create_project(slug: str, title: str, description: str, model: str, template: str) -> Project: ...
def switch_project(slug: str) -> Project: ...
def delete_project(slug: str, confirm: bool) -> dict: ...
def update_project_settings(slug: str, **fields) -> Project: ...
```

### 4.2 엔드포인트 스코핑 규칙

- 모든 기존 엔드포인트는 body/query에 `project` 필드 수용.
- 생략 시 `get_active_slug()` 사용. active도 없고 legacy면 레거시 경로.
- 응답에 `project: <slug>` 에코.

### 4.3 `run_claude(...)` 시그니처 변경

- `cwd=str(PROJECT_ROOT)` → `cwd=str(project.root)` 로 변경.
- 모델 인자는 `project.model`에서 해석 (더 이상 전역 SETTINGS 아님).
- `CLAUDE.md`를 읽을 때 `project.claude_md` 경로 사용.

### 4.4 git 정책

- **단일 repo 유지(옵션 A, Q-1 기본값)**. 프로젝트별 서브디렉터리 커밋.
- `GitManager._stage_all()` → `add projects/<slug>/wiki/ projects/<slug>/raw/ projects/<slug>/ingest-reports/`
- 커밋 메시지 prefix에 프로젝트 slug 포함: `ingest(karpathy-llm): <title>`
- 브랜치 전략은 불변 — 모든 작업은 feature 브랜치에서.

### 4.5 안전장치

- `assert_writable(path)` — raw/ 불변성은 **모든 프로젝트의 raw/에 적용** (not only current project).
- `assert_raw_create_only(path)` — 동일하게 확장.
- 프로젝트 경계를 넘는 경로 접근(`../`)은 resolver에서 거부.

---

## 5. 마이그레이션 단계 (MP-04에서 실행, 자율모드 금지)

1. `git mv wiki projects/karpathy-llm/wiki`
2. `git mv raw projects/karpathy-llm/raw`
3. `git mv ingest-reports projects/karpathy-llm/ingest-reports`
4. `git mv reflect-reports projects/karpathy-llm/reflect-reports`
5. `git mv query-log.jsonl projects/karpathy-llm/query-log.jsonl`
6. `git mv CLAUDE.md projects/karpathy-llm/CLAUDE.md` — 루트에는 새로운 얇은 `CLAUDE.md` 작성 (공통 규칙 + 프로젝트 규칙은 projects/<slug>/CLAUDE.md 참조)
7. `.dashboard-settings.json` → `projects/karpathy-llm/.settings.json`로 변환 후 원본 삭제
8. 새 `projects.json` 생성 (active: "karpathy-llm")
9. `README.md` 경로 예시 갱신
10. 단일 스모크 테스트 (서버 재시작 → `/api/projects` → `/api/wiki?project=karpathy-llm`)

---

## 6. 미결 사항 (`plans/blocked.md` 참조)

- Q-1 단일 repo vs 프로젝트별 repo → 이 문서는 **옵션 A (단일 repo)** 가정.
- Q-2 Obsidian vault 스코프 → 현재 루트 vault 유지, 프로젝트별 분리는 별도 작업.
- Q-3 slug 규칙 → `make_slug()` 재사용 + 중복 검사.
- Q-4 삭제 정책 → `projects/.trash/<slug>-<ts>/`로 이동 (hard delete 옵션은 `confirm=hard` 필수).

---

## 7. 구현 단계 체크리스트 (이 설계에서 파생)

- [ ] MP-02: `projects/` 디렉터리 생성 + `projects.json` 초기 파일 + `templates/CLAUDE.md` 스텁
- [ ] MP-03: resolver + legacy fallback + 엔드포인트 최소 1개(`/api/projects`) 추가 + 인 프로세스 스모크 테스트
- [ ] MP-04 (블록): 기존 콘텐츠 이동 — 사용자 승인 필요
- [ ] MP-05~MP-10: 상위 플랜 참조
