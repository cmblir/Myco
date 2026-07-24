---
title: "임베딩"
type: concept
tags:
  - concept
created: 2024-01-05
last_updated: 2024-03-15
source_count: 1
confidence: high
status: active
---

# 임베딩

[[embeddings|임베딩]]은 이산 토큰을 의미적·통사적 유사도가 공간적 근접성에 대응하는 기하 공간으로 매핑하는 조밀하고 연속적인 벡터 표현이다. [[transformer-architecture|트랜스포머]]에서는 [[tokenization|토큰화]]로 만들어진 단위를 임베딩 테이블에서 조회하여, [[attention-mechanism|어텐션 메커니즘]]이 동작하는 입력 벡터를 형성한다.[^src-attention-is-all-you-need] 이 학습된 벡터들은 미리 고정되는 것이 아니라 나머지 네트워크와 함께 공동으로 학습되므로, 모델의 학습 목표에 특화된 관계를 포착한다. 동일한 표현 아이디어가 대규모 문서 모음에 대한 유사도 검색을 가능하게 하려고 임베딩을 저장하는 [[vector-database|벡터 데이터베이스]]를 뒷받침한다.

[^src-attention-is-all-you-need]: [[source-attention-is-all-you-need]]
