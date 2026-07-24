---
title: "생각의 사슬(Chain-of-Thought)"
type: technique
tags:
  - technique
created: 2024-02-01
last_updated: 2024-03-15
source_count: 1
confidence: high
status: active
---

# 생각의 사슬(Chain-of-Thought)

생각의 사슬(CoT)은 모델이 최종 답을 내놓기 전에 중간 추론 단계를 생성하도록 유도하는 프롬프팅 기법이다. 이는 [[in-context-learning|문맥 내 학습]]의 특수한 형태로, 단계별 추론을 보여 주는 예시를 포함시키면 모델이 추론 시점에 결론으로 곧장 건너뛰는 대신 자신의 [[reasoning|추론]]을 외부로 드러내도록 학습한다. 이러한 분해는 산술과 논리 같은 다단계 문제의 성능을 향상시키는 경향이 있는데, 모델이 토큰 전반에 더 많은 계산을 배분할 수 있게 해 주기 때문이다. CoT는 가장 영향력 있는 [[prompting|프롬프팅]] 전략 중 하나이며, 그 효과는 트랜스포머가 자신이 생성한 문맥에 주의를 기울이는 능력에 기반한다.[^src-attention-is-all-you-need]

[^src-attention-is-all-you-need]: [[source-attention-is-all-you-need]]
