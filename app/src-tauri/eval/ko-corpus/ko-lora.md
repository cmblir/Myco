---
title: "LoRA (저랭크 적응)"
type: technique
tags:
  - technique
created: 2024-01-20
last_updated: 2024-03-15
source_count: 1
confidence: high
status: active
---

# LoRA (저랭크 적응)

저랭크 적응(LoRA)은 사전학습된 가중치를 동결하고 각 층에 작은 학습 가능한 저랭크 행렬을 주입하여, 파라미터의 아주 일부만 갱신하는 파라미터 효율적 [[fine-tuning|파인튜닝]] 기법이다. 베이스 모델이 고정된 채로 유지되고 각 과제는 조밀한 어댑터 가중치만 저장하면 되므로, 메모리와 저장 비용이 극적으로 줄어든다. LoRA는 [[quantization|양자화]]와 잘 결합된다. QLoRA 변형에서는 동결된 베이스 모델을 4비트 정밀도로 유지하면서 저랭크 어댑터를 더 높은 정밀도로 학습하여, 매우 큰 모델을 단일 GPU에서 파인튜닝할 수 있게 한다.[^src-scaling-laws-paper]

[^src-scaling-laws-paper]: [[source-scaling-laws-paper]]
