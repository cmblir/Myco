---
title: "양자화"
type: technique
tags:
  - technique
created: 2024-01-21
last_updated: 2024-03-15
source_count: 1
confidence: high
status: active
---

# 양자화

양자화는 모델의 가중치와 활성값의 수치 정밀도를 예컨대 16비트 부동소수점에서 8비트 또는 4비트 정수로 낮추어, 메모리 사용량을 줄이고 산술 연산을 가속한다. 저정밀도 행렬 곱셈이 더 저렴하고 대형 모델 서빙의 병목인 메모리 대역폭을 줄이기 때문에, 양자화는 대표적인 [[inference-optimization|추론 최적화]] 형태다.[^src-scaling-laws-paper] 양자화는 압축된 모델의 효율적 파인튜닝을 위해 [[lora]]와 자주 결합되며, 더 작은 학생 모델을 학습해 모델을 줄이는 [[distillation|증류]]와 상보적이다. 고정된 모델을 배포하는 비용을 낮춤으로써, 양자화는 실무적 [[compute-budget|연산 예산]]을 일회성 학습에서 지속 가능한 서빙 쪽으로 이동시킨다.

[^src-scaling-laws-paper]: [[source-scaling-laws-paper]]
