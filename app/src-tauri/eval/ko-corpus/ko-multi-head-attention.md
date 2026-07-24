---
title: "다중 헤드 어텐션"
type: technique
tags:
  - technique
created: 2024-01-04
last_updated: 2024-03-15
source_count: 1
confidence: high
status: active
---

# 다중 헤드 어텐션

[[multi-head-attention|다중 헤드 어텐션]]은 여러 개의 독립적인 [[attention-mechanism|어텐션]] 계산을 병렬로 실행하며, 각 계산은 쿼리·키·값을 서로 다르게 학습한 선형 투영 위에서 동작한다.[^src-attention-is-all-you-need] 표현을 여러 개의 저차원 부분공간으로 분할함으로써 각 헤드는 서로 다른 유형의 관계에 특화될 수 있는데 — 예를 들어 한 헤드는 통사적 의존성을, 다른 헤드는 상호참조를 추적한다 — 그 출력들은 이어 붙여진 뒤 다시 모델 차원으로 투영된다. 이는 동일한 총 폭을 가진 단일 [[self-attention|셀프 어텐션]] 계산보다 엄밀히 더 표현력이 크며, 그래서 현대의 모든 트랜스포머에서 표준 어텐션 층이 되었다.[^src-attention-is-all-you-need]

[^src-attention-is-all-you-need]: [[source-attention-is-all-you-need]]
