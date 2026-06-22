---
title: "Today Queue — 멀티 프로젝트 아키텍처"
created: 2026-04-23
owner: yoo
---

# Today Queue — 멀티 프로젝트 전환

우선순위: 위에서 아래로 소비. 각 항목은 독립 커밋.

---

## ~~[MP-01] 저장소 레이아웃 재설계~~ ✅ 완료 (2026-04-23)
- 결과: `plans/architecture-multiproject.md`
- 커밋: 8c0750d

---

## ~~[MP-02] `projects/` 루트 + `projects.json` 레지스트리~~ ✅ 완료 (2026-04-23)
- 결과: `projects/`, `projects.json`, `templates/{CLAUDE.md,llm-research,reading-log,personal-notes}`
- 커밋: 18b0cd9

---

## ~~[MP-03] `server.py` 프로젝트 resolver (부분 완료)~~ ⚠️ 기반만 (2026-04-23)
- 완료: `dashboard/project_registry.py` 모듈 + `/api/projects*` 엔드포인트 + legacy 폴백
- 커밋: bcf7f32
- 남은 과제(MP-07로 이관): 기존 do_ingest/do_query/do_lint 등에서 `WIKI_DIR`/`RAW_DIR`를 resolver 기반으로 대체

---

## [MP-04] 기존 콘텐츠 → `projects/karpathy-llm/` 마이그레이션 🚨 BLOCKED
- 위험도: high → 자율모드 금지 (§21.8). 사용자 승인 필요.
- `plans/blocked.md` [BLOCK-MP-04] 참조
- 영향 범위: 루트 디렉터리 대규모 이동
- 완료 기준:
  - `git mv`로 history 보존 이전
  - `projects.json`에 `karpathy-llm` 등록 + active
  - `.dashboard-settings.json`의 model 값을 프로젝트 `.settings.json`으로 복사
  - 루트 `README.md`의 경로 예시 갱신
  - 서버 재시작 후 대시보드 정상 작동 확인

---

## ~~[MP-05] `/api/projects` CRUD 엔드포인트~~ ✅ 완료 (MP-03에서 동시 구현, 2026-04-23)

원래 항목은 아래 — MP-03 커밋(bcf7f32)에서 `/api/projects`, `/api/projects/create`,
`/switch`, `/update`, `/delete` 모두 완성.

---

## [MP-05-archived] `/api/projects` CRUD 엔드포인트
- 목표: 프로젝트 목록/생성/전환/삭제 API
- 영향 범위: `server.py`
- 완료 기준:
  - `GET /api/projects` → 리스트 + active
  - `POST /api/projects` (name, description, model, template) → 새 `projects/<slug>/` 생성 + 스타터 CLAUDE.md + 빈 wiki/raw
  - `POST /api/projects/switch` (slug) → active 갱신
  - `POST /api/projects/delete` (slug, confirm) → 삭제 (쓰레기통으로 이동 권장)
  - `POST /api/projects/<slug>/settings` (model) → 프로젝트별 모델 저장
- 위험도: medium

---

## [MP-06] 프로젝트 템플릿 CLAUDE.md
- 목표: 신규 프로젝트 생성 시 복제될 스타터 스키마 제공
- 영향 범위: `templates/CLAUDE.md` 신규
- 완료 기준:
  - 일반 목적용 (기본 frontmatter/citation 규칙 유지, 도메인 예시 삭제)
  - 3~5개 주제별 variant (llm-research / product-ops / personal-notes / reading-log) — 생성 시 선택 가능
- 위험도: low

---

## ~~[MP-07] 기존 API 엔드포인트 project 스코핑~~ ✅ 완료 (2026-04-23 ~ 2026-04-24)
- Partial (읽기): cb04d81 — `/api/wiki`, `/api/folders`, `/api/hash`, `/api/schema`, `/api/provenance`, `/api/index/status`에 `?project=<slug>`, 미지 slug 404
- Full (쓰기/Claude 호출): 1f50ddb — 모든 `do_*` + CRUD + `run_claude` cwd + GitManager + `assert_writable` 전면 스코핑

---

## [MP-07-archived] 기존 API 엔드포인트 project 스코핑
- 목표: `/api/ingest, /api/query, /api/lint, /api/lint/fix, /api/reflect, /api/write, /api/compare, /api/review/*, /api/search, /api/page*, /api/folder, /api/slides, /api/revert, /api/history, /api/provenance, /api/suggest/sources, /api/raw/integrity, /api/index/*, /api/schema, /api/wiki, /api/folders, /api/hash, /api/query-stats, /api/assistant` — 전부 project 스코프 수용
- 영향 범위: 모든 핸들러
- 완료 기준:
  - body 또는 querystring에 `project` 필드 수용
  - 생략 시 active 사용
  - 응답에 `project` echo
- 위험도: medium

---

## ~~[MP-08] 헤더 프로젝트 선택기 (UI)~~ ✅ 완료 (2026-04-24)
- 커밋: fb39871
- 헤더 `<select#projectSelect>` + 생성/삭제 버튼 + 모달 2종 (New Project / Delete Project)
- `window.fetch` monkey-patch로 모든 `/api/*` 호출에 `CURRENT_PROJECT` 자동 주입 (기존 fetch 코드 수정 불필요)
- Cmd/Ctrl+P 단축키 → 프로젝트 선택기 포커스
- 모델 선택기가 현재 프로젝트 모델로 자동 반영

---

## [MP-08-archived] 헤더 프로젝트 선택기 (UI)
- 목표: 대시보드 상단에 프로젝트 드롭다운 추가 (모델 선택기 옆)
- 영향 범위: `dashboard/index.html`
- 완료 기준:
  - 프로젝트 목록 + active 표시
  - 전환 시 전체 뷰 재로딩 (`/api/wiki?project=<slug>` 등)
  - "새 프로젝트" 버튼 → 모달 (name, description, model, template variant)
  - 모델 선택기는 현재 프로젝트의 모델을 읽고 쓰도록 연동
  - 키보드 단축키: Cmd/Ctrl+P (프로젝트 전환 팔레트)
- 위험도: medium

---

## ~~[MP-09] 프로젝트 내 "목적별 폴더" 템플릿 지원~~ ✅ 완료 (2026-04-24)
- 커밋: df51718
- `project_registry.TEMPLATE_FOLDERS` + `recommended_folders()`
- `create_project`에서 템플릿별 폴더 자동 mkdir
- `/api/templates` 엔드포인트 + New Project 모달에 권장 폴더 미리보기
- 기존 폴더 선택 드롭다운은 `loadFolders()`로 자동 갱신되어 바로 사용 가능

---

## [MP-09-archived] 프로젝트 내 "목적별 폴더" 템플릿 지원
- 목표: 사용자가 "페이지를 목적별 폴더에 정리"하고 싶다는 요구 충족
- 영향 범위: 페이지 생성 플로우
- 완료 기준:
  - 템플릿 CLAUDE.md에 권장 폴더 구조 명시 (e.g. `sources/ entities/ concepts/ techniques/ analyses/`, 또는 variant별 상이)
  - Ingest 시 type에 따라 자동으로 적절한 하위 폴더에 배치 옵션
  - 페이지 생성 모달에 "폴더 빠른 선택" 드롭다운 (프로젝트 루트 + 기존 폴더)
  - 사이드바 "목적" 탭: frontmatter.tags 또는 folder 기반 그룹핑 뷰
- 위험도: low

---

## ~~[MP-10] 문서 갱신~~ ✅ 부분 완료 (2026-04-24)
- 커밋: dfcf66a
- README.md / README-ko.md에 'Multi-project' / '멀티 프로젝트' 섹션 추가
- Repository layout에 projects/ templates/ plans/ logs/ project_registry.py 반영
- API curl 예시 + 템플릿별 권장 폴더 표 + legacy 호환 안내
- 남은 작업: 대시보드 내 Guide 모달 갱신, 스크린샷 재촬영 — 사용자 확인 후 선택 진행

---

## [MP-10-archived] Obsidian / git / 대시보드 문서 갱신
- 목표: 멀티 프로젝트 전환 후 사용자 실제 이용 가능 상태 → README/가이드 갱신 (CLAUDE.md §4.5)
- 영향 범위: `README.md`, `README-ko.md`, `docs/`, 대시보드 내 Guide 모달
- 완료 기준:
  - 신규 경로/명령 반영
  - 스크린샷/GIF 재촬영 (필요 시)
  - `.obsidian/` vault 경로가 여전히 동작하는지 확인 — 프로젝트 개별 vault 등록 필요한지 결정
- 위험도: low
