# Wiki Template — LLM Research

> LLM/ML 연구 주제에 최적화된 스타터 스키마.

## 프로젝트 맥락

- **주제**: LLM / ML 연구
- **목적**: 논문·블로그·구현 노트를 축적해 개념 그래프를 구축
- **주 언어**: ko

## 권장 wiki/ 구조

```
wiki/
  sources/        # 논문·블로그 요약
  models/         # 모델 (GPT-N, Llama, Claude 등)
  techniques/     # 알고리즘 (RLHF, DPO, LoRA 등)
  concepts/       # 아이디어 (scaling laws, attention 등)
  entities/       # 연구자·조직·제품
  benchmarks/     # 평가 세트
  analyses/       # 종합 분석
```

## 추가 Frontmatter 필드 (권장)

- `paper_year: YYYY` — source-summary 타입에만
- `venue: "NeurIPS 2024"` 등
- `arxiv: "2401.xxxxx"` — 있으면

## Citation 규칙

루트 `CLAUDE.md`를 따릅니다. 논문 ingest 시 arxiv id가 있으면 source-summary에 명시.
