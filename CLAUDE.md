# Memex — Repository Guide

이 레포는 Memex(로컬 지식 위키 도구)의 **개발 레포 + 멀티 프로젝트 vault**입니다.
위키 콘텐츠는 이제 `projects/<slug>/` 아래에 프로젝트 단위로 삽니다.

## 구조

```
projects/             # 프로젝트별 vault — 각자 wiki/ raw/ CLAUDE.md 보유
projects/karpathy-llm # 기본(legacy에서 이관된) 프로젝트, projects.json의 active
projects.json         # 프로젝트 레지스트리 (active 포인터)
templates/            # 신규 프로젝트 CLAUDE.md/폴더 템플릿
app/                  # Memex 데스크톱 앱 (Tauri + React)
mcp-server/           # MCP 서버 — projects.json을 공유
automation/           # 자동 ingest 스크립트
plans/                # 개발 계획·제안 문서
dev-status/           # architecture.md (시스템 맵) + ingest 부하 테스트
cosmic-refs/          # 그래프 디자인 레퍼런스
```

## 위키 작업 규칙

- 위키 스키마·ingest 워크플로·인용 규칙은 **활성 프로젝트의 CLAUDE.md**를 따른다:
  `projects/karpathy-llm/CLAUDE.md` (또는 MCP `get_instructions`).
- `projects/*/raw/`는 모든 프로젝트에서 **불변(immutable)** — 읽기만 허용,
  수정/삭제 절대 금지. 이 규칙은 프로젝트 CLAUDE.md보다 우선한다.
- 새 프로젝트는 MCP `list_projects`/registry 또는 `templates/` 기반으로 생성.

## 개발 작업 규칙

- 앱(`app/`)은 자체 컨벤션(테스트·lint·i18n)을 따른다 — `app/docs/specs/` 참조.
- 커밋은 영어, Conventional Commits (`<type>(<scope>): <subject>`).
