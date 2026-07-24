---
title: "벡터 데이터베이스"
type: concept
tags:
  - concept
created: 2024-02-04
last_updated: 2024-03-15
source_count: 1
confidence: high
status: active
---

# 벡터 데이터베이스

벡터 데이터베이스는 고차원 [[embeddings|임베딩]]을 색인하고 그에 대한 빠른 근사 최근접 이웃 검색을 지원하는 특화된 데이터 저장소다. 정확한 키워드를 매칭하는 대신, 저장된 벡터를 쿼리 벡터와의 거리로 순위 매겨 의미적 유사도로 항목을 검색한다. 이 때문에 벡터 데이터베이스는 인코딩된 문서 청크를 보관하고 모델 문맥에 삽입할 가장 관련 있는 구절을 반환하는 [[rag]] 시스템의 핵심 구성요소가 된다. 그 효과는 의미적으로 관련된 텍스트를 벡터 공간의 가까운 점으로 매핑하는 임베딩의 품질에 달려 있다.[^src-attention-is-all-you-need]

[^src-attention-is-all-you-need]: [[source-attention-is-all-you-need]]
