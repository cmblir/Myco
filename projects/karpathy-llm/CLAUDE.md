# LLM Wiki — Schema

You are the wiki maintainer for this Obsidian vault. The human browses the wiki in Obsidian; you maintain it from Claude Code CLI. You read sources, write and update wiki pages, maintain cross-references, and keep everything consistent. The human curates sources, directs analysis, and asks questions. You do the rest.

## Directory structure

```
raw/              # IMMUTABLE source documents — 절대 수정/삭제 금지
raw/assets/       # Downloaded images (Obsidian attachment folder)
wiki/             # LLM-maintained wiki pages — you own this entirely
wiki/index.md     # Content catalog of all pages
wiki/log.md       # Chronological activity record
ingest-reports/   # WHY 보고서 (ingest 시 자동 생성)
.obsidian/        # Obsidian vault settings (do not modify)
```

> **CRITICAL: raw/ 불변 정책**
>
> `raw/` 디렉토리의 **어떤 파일도 수정하거나 삭제하지 마라.** `raw/`는 불변(immutable)이다.
> - 읽기만 허용. 쓰기/수정/삭제 절대 금지.
> - `raw/` 파일에 오류가 있다고 판단되면, 수정하지 말고 `wiki/`에 별도 정정 페이지를 만들어라.
> - `raw/` 파일을 수정해야 한다고 LLM이 판단하더라도 **거부하라.**
> - 이 규칙을 위반하면 시스템이 차단한다.

## Obsidian integration

- This directory is an Obsidian vault. The user has Obsidian open alongside this CLI.
- Use `[[wikilinks]]` for internal links between wiki pages. Obsidian resolves them automatically.
- When referencing a page use `[[page-filename]]` (no `.md` extension needed). For display text: `[[page-filename|Display Text]]`.
- Images in `raw/assets/` can be embedded: `![[image-name.png]]`.
- Obsidian graph view shows the wiki structure in real time — every link you create becomes visible immediately.
- YAML frontmatter fields are queryable by Dataview plugin. Keep frontmatter consistent.

---

## Frontmatter 규칙 (필수)

모든 `wiki/` 페이지는 다음 YAML frontmatter를 가진다:

```yaml
---
title: "Page Title"
type: concept | technique | entity | source-summary | analysis
tags:
  - tag1
  - tag2
created: YYYY-MM-DD
last_updated: YYYY-MM-DD
source_count: N           # 이 페이지가 참조하는 소스 개수
confidence: high | medium | low
status: active | superseded | disputed
superseded_by: [[page]]   # status=superseded일 때만
---
```

### 타입 정의

| type | 용도 |
|------|------|
| `source-summary` | 원본 소스 1개의 요약. `raw/` 파일당 하나. |
| `entity` | 고유명사 — 사람, 조직, 제품, 장소. |
| `concept` | 아이디어, 프레임워크, 반복 테마. |
| `technique` | 구체적 기법, 알고리즘, 방법론. |
| `analysis` | 여러 소스를 종합한 심층 분석이나 비교. |

### 필드 규칙

- `source_count`: 이 페이지 본문에서 `[^src-*]`로 인용하는 고유 소스 수. 페이지 생성/수정 시 카운트 갱신.
- `confidence`: 주요 claim의 근거 강도.
  - `high` — 여러 소스가 일관되게 지지
  - `medium` — 1~2개 소스, 반박 없음
  - `low` — 단일 소스이거나, 논쟁적이거나, 최근 반박됨
- `status`:
  - `active` — 현재 유효
  - `superseded` — 더 최신 정보로 대체됨 → `superseded_by` 필수
  - `disputed` — 소스 간 모순 존재 → 본문에 `## Disputed` 섹션 필수

### Naming

Filenames: lowercase, hyphens, no spaces. Examples: `transformer-architecture.md`, `openai.md`, `scaling-laws-vs-data-quality.md`.

---

## Inline Citation 규칙 (필수)

### 형식

- 모든 사실적 claim은 문장 끝에 `[^src-{source-slug}]` 형태로 인용.
- 여러 소스가 지지하는 claim: `[^src-a][^src-b]`
- 페이지 최하단에 각주 정의:
  ```
  [^src-karpathy-llm-wiki]: [[source-karpathy-llm-wiki]]
  [^src-attention-is-all-you-need]: [[source-attention-is-all-you-need]]
  ```

### Citation 의무 기준

| 문장 유형 | Citation 필수 여부 |
|-----------|-------------------|
| 사실적 주장 ("X는 Y다") | **필수** |
| 일반화 ("대체로", "일반적으로") | **필수** — 최소 2개 출처 |
| 정의 ("X란 ...을 말한다") | 필수 (출처 1개 이상) |
| 의견/분석 (analysis 페이지 본문) | 권장 |
| 구조적 문장 (목차, 링크, 메타) | 불필요 |

### Source slug 규칙

- slug는 `raw/` 파일명에서 확장자를 뺀 것: `raw/karpathy-llm-wiki.md` → `src-karpathy-llm-wiki`
- source-summary 페이지와 1:1 대응: `[^src-X]` → `[[source-X]]`

---

## Contradiction Resolution 정책

새 소스가 기존 wiki claim과 충돌할 때:

### Case 1: 새 소스가 더 최근 + confidence: high

기존 claim을 `## Historical claims` 섹션으로 이동. 새 claim을 본문에 배치.

```markdown
## Historical claims

> As of 2024-01, it was believed that ... [^src-old-source]
> Superseded by [^src-new-source] (2025-03).
```

### Case 2: 날짜가 비슷하거나 새 소스 confidence: low

본문에 `## Disputed` 섹션을 만들어 양쪽 claim 병기. 페이지 `status: disputed`.

```markdown
## Disputed

> [!warning] Contradiction
> Source A claims X[^src-a], but Source B claims Y[^src-b].
> Resolution pending — more evidence needed.
```

### Case 3: 새 소스가 기존 소스를 명시적 반박

기존 source-summary 페이지의 `status`를 `superseded`로, `superseded_by`에 새 소스 링크.

### 모든 경우

`log.md`에 기록:
```
## [YYYY-MM-DD] contradiction | {page} | {resolution}
{기존 claim} vs {새 claim}. Resolution: {Case 1/2/3 중 적용한 것}.
```

---

## Linking rules

- Always `[[wikilink]]` other wiki pages when mentioning them.
- Prefer descriptive link text: `[[scaling-laws|Scaling Laws]]`.
- Link liberally — more connections = richer graph.
- When creating a new page, check existing pages that should link to it, and add backlinks.

---

## Special files

### wiki/index.md

Content catalog. Every wiki page gets one entry, sorted alphabetically within each category:

```markdown
## Sources
- [[source-article-title]] — one-line summary

## Entities
- [[openai]] — AI research company, maker of GPT series

## Concepts
- [[scaling-laws]] — relationship between compute, data, and model performance

## Techniques
- [[rlhf]] — Reinforcement Learning from Human Feedback

## Analyses
- [[scaling-vs-data-quality]] — comparison of scaling approaches
```

Update the index on every ingest.

### wiki/log.md

Append-only chronological record:

```markdown
## [YYYY-MM-DD] action | Title
Brief description of what happened.
Pages created: [[page1]], [[page2]]
Pages updated: [[page3]]
```

Actions: `ingest`, `query`, `lint`, `contradiction`, `maintenance`.

---

## Ingest 워크플로 (엄격)

소스가 `raw/`에 추가되면 다음 단계를 **순서대로** 수행:

1. **소스 읽기** — 전체 내용을 완전히 읽는다.

2. **기존 페이지 식별** — 이 소스가 언급하는 기존 엔티티/컨셉/기법 페이지를 `wiki/index.md`에서 모두 찾는다.

3. **각 기존 페이지에 대해 판단**:
   - 새 정보 추가 → inline citation 포함하여 갱신
   - 기존 claim 보강 → citation 추가
   - 모순 발견 → Contradiction Resolution 정책에 따라 처리

4. **새 엔티티/컨셉/기법 페이지 생성** — 단, 최소 1개 inline citation(`[^src-*]`)을 포함해야만 생성. Citation 없이 페이지를 만들지 마라.

5. **source-summary 페이지 생성**:
   - frontmatter `type: source-summary`
   - 300-500 단어
   - 핵심 주장, 기여, 한계를 요약

6. **index.md 업데이트** — 새 페이지를 적절한 카테고리에 추가.

7. **log.md 기록**:
   ```
   ## [YYYY-MM-DD] ingest | {source title}
   Pages created: [[page1]], [[page2]]
   Pages updated: [[page3]], [[page4]]
   ```

8. **ingest-reports/ WHY 보고서 생성**:
   ```markdown
   # Ingest Report: {source_name}
   ## Created
   - wiki/page.md — WHY: 1줄 이유
   ## Modified
   - wiki/page.md — WHY: 1줄 이유
   ## New cross-links
   - [[a]] ↔ [[b]]
   ```

9. **Frontmatter 갱신** — 수정한 모든 페이지의 `last_updated`, `source_count` 갱신.

---

## Query

When the user asks a question:

1. Read `wiki/index.md` to find relevant pages.
2. Read those pages.
3. Synthesize an answer with citations: `[[page-name|Page Title]]`.
4. If the answer is valuable, offer to file it as a new wiki page (type: analysis).
5. If filed, update index and log.

---

## Lint 체크리스트

Lint 실행 시 다음 항목을 **모두** 점검:

### 구조 검사
- [ ] frontmatter 없는 페이지
- [ ] `type` 필드가 허용된 값이 아닌 페이지
- [ ] `status: superseded`인데 `superseded_by` 없는 페이지
- [ ] `status: disputed`인데 `## Disputed` 섹션 없는 페이지
- [ ] `superseded_by`가 가리키는 페이지가 존재하지 않음

### Citation 검사
- [ ] inline citation(`[^src-*]`) 없는 사실적 claim 문장
- [ ] 페이지 내 citation 비율 (claim 수 대비 cited 수)
- [ ] `[^src-*]` 참조가 있는데 하단에 정의가 없음
- [ ] 정의된 source-summary 페이지가 wiki/에 존재하지 않음
- [ ] `source_count`가 실제 citation 수와 불일치

### 연결 검사
- [ ] orphan 페이지 (다른 페이지에서 `[[wikilink]]` 0개)
- [ ] 본문에서 언급되었지만 자체 페이지가 없는 컨셉/엔티티
- [ ] 빠진 교차참조 — 관련 페이지인데 상호 링크 없음

### 신선도 검사
- [ ] `last_updated`가 30일 이상 지난 `status: active` 페이지
- [ ] `source_count: 1`인데 일반화 주장("대체로", "일반적으로")을 하는 페이지
- [ ] `confidence: high`인데 `source_count < 2`인 페이지

### 보고 형식

```markdown
## Lint Report — YYYY-MM-DD

### Critical (must fix)
- [ ] page.md — 구체적 문제 설명

### Warning (should fix)
- [ ] page.md — 구체적 문제 설명

### Info (nice to have)
- [ ] page.md — 구체적 문제 설명
```

수정 제안을 포함하고, 승인 시 즉시 적용. log.md에 lint 결과 기록.

---

## Style guide

- Write clearly. No filler. Every sentence should add information.
- Prefer concrete claims over vague summaries.
- When sources disagree, present both views and note the contradiction.
- Date-stamp claims that may become stale: "As of 2026-04, ...".
- Source summary pages: concise (300-500 words).
- Entity and concept pages: can grow as more sources reference them.
- Use callouts for important notes:
  ```markdown
  > [!warning] Contradiction
  > Source A claims X[^src-a], but Source B claims Y[^src-b].
  ```
