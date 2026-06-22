---
title: "Blocked — 판단/정보 필요 항목"
created: 2026-04-23
---

# Blocked

---

## [2026-04-23 20:45] BLOCK-MP-04 기존 콘텐츠 마이그레이션

**원본 큐 항목**: MP-04 `projects/karpathy-llm/`로 wiki/raw/ingest-reports/reflect-reports/query-log.jsonl/CLAUDE.md 이동
**시도 횟수**: 0 (자율모드에서 실행하지 않음)
**블록 사유**:
- 위험도 `high` — `today-queue.md` 명시. §21.8에 따라 자율모드 금지.
- 대량 `git mv`, 루트 레이아웃 변경, 실행 중인 대시보드 서버(pid 94329) 경로 기반 재시작 요구.
- Q-1~Q-4 (아래) 결정이 전제.

**필요한 판단/정보** (사용자):
- Q-1 단일 repo vs 프로젝트별 repo
- Q-2 Obsidian vault 스코프
- Q-3 slug 규칙 (기본: `make_slug` + 중복 검사)
- Q-4 삭제 정책 (기본: `projects/.trash/` soft delete)

**실행 시 체크리스트** (사용자 승인 후):
1. `git mv` 5건 (wiki, raw, ingest-reports, reflect-reports, query-log.jsonl)
2. `git mv CLAUDE.md projects/karpathy-llm/CLAUDE.md` + 루트에 얇은 CLAUDE.md 재생성
3. `.dashboard-settings.json` → `projects/karpathy-llm/.settings.json` (model 값 이전 후 원본 삭제)
4. `projects.json`에 `karpathy-llm` 등록 + `active` 설정
5. 서버 재시작 후 `/api/projects`, `/api/wiki?project=karpathy-llm` 스모크 테스트 — 주의: MP-07 미완 시 `/api/wiki`는 여전히 legacy 경로를 참조해 깨질 수 있음. MP-07 선행 필요.

**관련 커밋**: 8c0750d (MP-01), 18b0cd9 (MP-02), bcf7f32 (MP-03)

---

## 결정 대기 중인 설계 포인트

## 결정 대기 중인 설계 포인트 (MP-04 실행 전 필수)

- **[Q-1] 프로젝트별 git repo 분리 여부**
  - 옵션 A: 단일 repo + `projects/<slug>/` 서브디렉터리 커밋 (권장, 간단)
  - 옵션 B: 프로젝트당 별도 repo
  - 결정 주체: 사용자
  - 영향: MP-04, MP-05, OPS-04

- **[Q-2] Obsidian vault 스코프**
  - 옵션 A: 루트 전체를 하나의 vault로 (현재) — 프로젝트 간 이동 자유
  - 옵션 B: 프로젝트당 독립 vault 등록 — obsidian.json에 N개 엔트리
  - 결정 주체: 사용자 (작업 습관에 따라)
  - 영향: MP-10

- **[Q-3] 프로젝트 slug 규칙**
  - 영숫자+하이픈 강제? 한글 허용? 공백 불허?
  - 대안: 사용자 입력 title + 자동 slug (make_slug 재사용)

- **[Q-4] 프로젝트 삭제 정책**
  - 즉시 영구 삭제 vs trash/<slug>-<timestamp>/ 이동
  - 기본값은 trash 권장 (되돌릴 수 있음)
