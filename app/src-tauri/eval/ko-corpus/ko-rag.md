---
title: "검색 증강 생성(RAG)"
type: technique
tags:
  - technique
created: 2024-02-03
last_updated: 2024-03-15
source_count: 1
confidence: high
status: active
---

# 검색 증강 생성(RAG)

검색 증강 생성(RAG)은 모델의 출력을 가중치에 저장된 지식에만 의존하지 않고, 추론 시점에 검색된 외부 문서에 근거하도록 하는 기법이다. 전형적인 파이프라인은 쿼리와 문서를 모두 [[embeddings|임베딩]]으로 인코딩하고, 이를 [[vector-database|벡터 데이터베이스]]에 저장한 뒤, 의미적으로 가장 유사한 구절을 검색하여 [[prompting|프롬프팅]]의 일부로 모델 문맥에 주입한다. 이는 환각을 줄이고 모델이 최신 정보나 독점 정보에 접근하게 하며, 검색은 [[tool-use|도구 사용]]의 한 형태로 모델에 노출될 수 있다. RAG가 작동하는 이유는 트랜스포머가 검색된 문맥에 주의를 기울여 제공된 증거에 조건화된 생성을 할 수 있기 때문이다.[^src-attention-is-all-you-need]

[^src-attention-is-all-you-need]: [[source-attention-is-all-you-need]]
