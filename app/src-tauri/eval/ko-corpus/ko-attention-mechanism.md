---
title: "어텐션 메커니즘"
type: technique
tags:
  - technique
created: 2024-01-02
last_updated: 2024-03-15
source_count: 1
confidence: high
status: active
---

# 어텐션 메커니즘

[[attention-mechanism|어텐션 메커니즘]]은 모델이 모든 입력 토큰이 다른 모든 토큰에 대해 갖는 관련성을 가중하도록 하여, 쿼리-키 유사도에 기반한 값 벡터의 가중합을 계산함으로써 문맥을 반영한 표현을 만든다.[^src-attention-is-all-you-need] [[transformer-architecture|트랜스포머]]에서 이는 쿼리·키·값이 모두 동일한 [[embeddings|임베딩]] 시퀀스에서 유도되는 [[self-attention|셀프 어텐션]]의 형태를 띠며, 서로 다른 관계 패턴을 병렬로 포착하기 위해 보통 [[multi-head-attention|다중 헤드 어텐션]]으로 적용된다. 어텐션은 시퀀스 길이에 대해 이차적으로 비용이 증가하기 때문에, 추론 시스템은 자기회귀 생성 중 재계산을 피하려고 이전에 계산한 키와 값을 [[kv-cache|KV 캐시]]에 저장한다. 이 메커니즘은 시퀀스 데이터에서 장거리 의존성을 모델링하는 주된 수단으로서 순환 구조를 대체했다.[^src-attention-is-all-you-need]

[^src-attention-is-all-you-need]: [[source-attention-is-all-you-need]]
