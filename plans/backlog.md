---
title: "Backlog — 멀티 프로젝트 외 추가 개선 후보"
created: 2026-04-23
---

# Backlog — 추가 구현/개발 필요 항목

멀티 프로젝트 전환과 별개로 현재 구현을 돌아보며 식별된 개선 후보.
우선순위는 사용자가 결정.

---

## 운영 / 안정성

- **[OPS-01] Job queue + 진행률 스트리밍** — `/api/ingest`가 길어지면 HTTP 타임아웃 위험. SSE/WS로 진행 로그 푸시 + 백그라운드 작업 식별자.
- **[OPS-02] 장기 실행 Claude 호출 로그 영속화** — 현재는 stdout만. 실패 시 원인 추적 어려움. `runs/<date>-<id>.log` 저장.
- **[OPS-03] 레이트 리밋 / 예산 가드** — 모델별 누적 토큰/비용 추적 + 임계값 초과 시 차단. 현재는 `query-log.jsonl`에만 비용 기록.
- **[OPS-04] 백업/복원** — 프로젝트 단위 zip export/import. git bundle도 고려.
- **[OPS-05] 헬스체크 개선** — Obsidian vault open 상태, git 상태, Claude CLI 응답시간을 한 endpoint로.

## 품질 / 기능

- **[FEAT-01] 교차 프로젝트 검색** — 여러 프로젝트 wiki를 한 번에 검색하는 모드. 현재 TF-IDF는 단일 wiki 전용.
- **[FEAT-02] 프로젝트 간 링크/임베드** — 다른 프로젝트 페이지를 참조할 수 있게 — `[[projectA::page]]` 같은 문법.
- **[FEAT-03] 태그 기반 브라우저** — frontmatter `tags`로 필터/그룹. 현재 UI는 type 위주.
- **[FEAT-04] 소스 업로드 UX** — 현재는 title/content 텍스트 입력만. 파일 업로드(.pdf, .html, .md) 지원.
- **[FEAT-05] 페이지 히스토리 뷰** — 페이지별 git blame/diff 뷰어 (대시보드에서 읽기).
- **[FEAT-06] 자동 reflect 스케줄** — 일정 주기로 reflect 실행 → 제안 큐에 쌓기.
- **[FEAT-07] Diff 미리보기** — ingest/lint-fix 적용 전에 diff 확인 후 confirm.
- **[FEAT-08] 다국어 위키 파이프라인** — 같은 개념의 KO/EN 페이지 연결 (superseded 아닌 translation 관계).

## 스키마 / 거버넌스

- **[GOV-01] Contradiction 자동 감지** — 새 claim이 기존과 충돌할 가능성을 LLM이 체크해 사용자에게 경고.
- **[GOV-02] Citation 검증기 (로컬)** — Claude 호출 없이 regex + frontmatter로 lint 자동 수행. CI hook 후보.
- **[GOV-03] Source trust score** — 소스별 신뢰도 필드(peer-reviewed / blog / tweet 등) + 페이지 confidence 자동 계산.
- **[GOV-04] CHANGELOG** — 프로젝트별 CHANGELOG.md (Keep a Changelog 형식). ingest/reflect/lint가 자동 append.

## 보안 / 접근 제어

- **[SEC-01] localhost 이외 접근 금지 확인** — 현재 `::` 바인딩 — 로컬만 노출되도록 문서 보강 + 옵션화.
- **[SEC-02] 프로젝트 삭제 가드** — `confirm` 파라미터 필수 + 쓰레기통(trash/) 경유.
- **[SEC-03] 시크릿 스캔** — raw/wiki에 API 키/토큰 패턴이 포함됐는지 ingest 시점에 경고.

## 테스트 / DX

- **[DX-01] 단위 테스트** — `server.py`의 `make_slug`, `parse_fm`, `_diff_snapshots`, `_tokenize` 등 순수 함수 pytest.
- **[DX-02] 엔드포인트 계약 테스트** — 각 `/api/*`에 대해 스모크 테스트.
- **[DX-03] 개발 모드 핫 리로드** — 현재 수동 재시작.
- **[DX-04] 로깅 포맷 표준화** — JSON 라인 로깅 + 레벨.

## 사용자 경험

- **[UX-01] 온보딩 마법사** — 첫 실행 시 "프로젝트 생성" → "첫 소스 추가" → "질문 해보기" 3단계 튜토리얼.
- **[UX-02] 커맨드 팔레트** — Cmd/Ctrl+K → 모든 기능 + 프로젝트 전환을 fuzzy search.
- **[UX-03] 모바일 레이아웃** — 현재 데스크톱 전용. §8 기준 최소 대응.
- **[UX-04] 다크/라이트 테마 토글** — 현재 다크 고정.
