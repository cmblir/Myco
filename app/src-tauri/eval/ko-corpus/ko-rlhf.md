---
title: "인간 피드백 기반 강화학습(RLHF)"
type: technique
tags:
  - technique
created: 2024-01-17
last_updated: 2024-03-15
source_count: 1
confidence: high
status: active
---

# 인간 피드백 기반 강화학습(RLHF)

인간 피드백 기반 강화학습(RLHF)은 순위가 매겨진 인간 비교 데이터로 [[reward-modeling|보상 모델]]을 학습한 뒤 그에 대해 정책을 최적화(보통 PPO)함으로써, 사전학습된 언어 모델을 인간 선호에 맞추는 [[fine-tuning|파인튜닝]] 방법이다. 보상 모델은 쌍별 인간 판단을 스칼라 신호로 변환하고, 정책은 그 보상을 최대화하도록 갱신되며 KL 페널티가 정책을 원래 모델에 가깝게 유지한다. RLHF는 [[openai]]와 [[anthropic]]에서 개발된 지시 따르기 어시스턴트의 지배적인 [[alignment|정렬]] 기법이 되었고, 유용성과 무해성 같은 행동을 형성했다.[^src-constitutional-ai-paper] 다단계 강화학습 파이프라인은 상대적으로 복잡하고 불안정하며, 이는 별도의 보상 모델이나 강화학습 루프 없이 선호를 직접 최적화하는 [[dpo]] 같은 더 단순한 대안을 낳았다.

[^src-constitutional-ai-paper]: [[source-constitutional-ai-paper]]
