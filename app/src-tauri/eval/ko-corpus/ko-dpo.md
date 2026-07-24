---
title: "직접 선호 최적화(DPO)"
type: technique
tags:
  - technique
created: 2024-01-18
last_updated: 2024-03-15
source_count: 1
confidence: high
status: active
---

# 직접 선호 최적화(DPO)

직접 선호 최적화(DPO)는 단일 분류 형태의 손실을 사용해 언어 모델을 인간 선호 데이터에 맞추는 선호 튜닝 기법으로, [[rlhf]]의 명시적 보상 모델과 강화학습 루프를 제거한다. 최적 정책과 선호 분포 사이의 닫힌 형태(closed-form) 관계를 유도하므로, 모델은 선택된 응답 대 거부된 응답 쌍 위에서 직접 학습된다. 이로써 DPO는 인간 선호에 부합한다는 동일한 [[alignment|정렬]] 목표를 추구하면서도 학습이 상당히 더 단순하고 안정적이다.[^src-constitutional-ai-paper] 두 접근의 실무적 트레이드오프는 [[analysis-rlhf-vs-dpo]]에서 검토한다.

[^src-constitutional-ai-paper]: [[source-constitutional-ai-paper]]
