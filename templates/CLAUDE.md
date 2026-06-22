# Wiki Template (generic)

> 이 파일은 신규 프로젝트 생성 시 `projects/<slug>/CLAUDE.md`로 복사되는 스타터 스키마입니다.
> 프로젝트의 주제/도메인에 맞게 자유롭게 수정하세요. 루트 `CLAUDE.md`의 공통 규칙은 항상 유지됩니다.

## 프로젝트 맥락

- **주제**: {{TOPIC}}
- **목적**: {{PURPOSE}}
- **주 언어**: ko

## 디렉터리 구조

```
raw/              # IMMUTABLE 원본 소스 (수정/삭제 금지)
wiki/             # LLM이 유지관리하는 페이지
  sources/        # source-summary 타입
  entities/       # 고유명사
  concepts/       # 아이디어/프레임워크
  techniques/     # 방법론/알고리즘
  analyses/       # 복합 분석
  index.md
  log.md
  overview.md
ingest-reports/
reflect-reports/
plans/
```

`wiki/` 하위 폴더는 권장 사항입니다. 엄격 적용 여부는 프로젝트 관리자가 결정.

## Frontmatter 규칙

루트 `CLAUDE.md`의 Frontmatter 규칙을 그대로 따릅니다. 프로젝트별 추가 필드가 필요하면 이 파일에 명시.

## Ingest 워크플로

루트 `CLAUDE.md`의 "Ingest 워크플로"를 따릅니다.

## Lint 체크리스트

루트 `CLAUDE.md`의 Lint 체크리스트를 따릅니다.

## 프로젝트별 스타일 가이드

(추가 규칙이 있으면 여기에 작성)
