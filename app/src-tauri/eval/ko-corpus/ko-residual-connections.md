---
title: "잔차 연결"
type: concept
tags:
  - concept
created: 2024-01-09
last_updated: 2024-03-15
source_count: 1
confidence: high
status: active
---

# 잔차 연결

잔차 연결은 서브층의 입력을 그 출력에 직접 더하는 스킵 연결로, `x + Sublayer(x)`로 계산되어 깊은 신경망을 통해 기울기가 방해받지 않고 흐르도록 한다. [[transformer-architecture|트랜스포머]]에서는 잔차 연결이 모든 어텐션·피드포워드 서브층을 감싸며, 이는 트랜스포머가 의존하는 깊은 층 스택을 학습하는 데 필수적이다.[^src-attention-is-all-you-need] 잔차 경로 뒤에는 [[layer-normalization|레이어 정규화]]가 따르므로, 정준적 정식화는 `LayerNorm(x + Sublayer(x))`이다. 항등 경로를 보존함으로써 잔차 연결은 기울기 소실 문제를 완화하고, 각 서브층이 입력의 전면적 변환이 아니라 정련(refinement)을 학습하도록 한다.

[^src-attention-is-all-you-need]: [[source-attention-is-all-you-need]]
