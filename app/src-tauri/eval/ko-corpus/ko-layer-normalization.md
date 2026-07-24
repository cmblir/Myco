---
title: "레이어 정규화"
type: technique
tags:
  - technique
created: 2024-01-10
last_updated: 2024-03-15
source_count: 1
confidence: high
status: active
---

# 레이어 정규화

레이어 정규화는 각 개별 토큰에 대해 특징(feature) 차원 전반에 걸쳐 활성값을 정규화하여, 학습된 이득(gain)과 편향(bias)을 적용하기 전에 평균 0·분산 1로 재조정한다. 원래의 [[transformer-architecture|트랜스포머]]에서는 각 [[residual-connections|잔차 연결]] 뒤에 포스트-노름(post-norm) 구성 `LayerNorm(x + Sublayer(x))`으로 적용된다.[^src-attention-is-all-you-need] 배치 정규화와 달리 배치 통계에 의존하지 않으므로, 언어 모델링에서 흔한 가변 길이 시퀀스와 작거나 단일 예제인 배치에 잘 맞는다. 많은 현대 변형은 대신 정규화를 서브층 앞에 두는데(프리-노름), 이는 매우 깊은 트랜스포머의 학습을 안정화하는 경향이 있다.

[^src-attention-is-all-you-need]: [[source-attention-is-all-you-need]]
