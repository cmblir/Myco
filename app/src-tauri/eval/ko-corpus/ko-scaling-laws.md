---
title: "스케일링 법칙"
type: concept
tags:
  - concept
created: 2024-01-12
last_updated: 2024-03-15
source_count: 1
confidence: high
status: active
---

# 스케일링 법칙

스케일링 법칙은 언어 모델의 손실이 세 가지 자원 — 모델 크기(파라미터), 데이터셋 크기, 그리고 [[pretraining|사전학습]]에 쓰인 [[compute-budget|연산 예산]] — 의 매끄러운 거듭제곱 함수로 어떻게 감소하는지를 기술한다. 경험적으로 성능은 여러 자릿수에 걸쳐 예측 가능하게 개선되며, 고정된 연산 예산에 대해서는 모델을 더 크게 만드는 것과 더 많은 데이터로 학습하는 것 사이에 최적의 배분이 존재한다.[^src-scaling-laws-paper] 이러한 관계는 특히 [[transformer-architecture|트랜스포머]]에서 성립하며, 실무자가 자원을 투입하기 전에 계획된 학습 실행의 수익을 예측하게 해 준다. 파라미터를 늘리는 것과 데이터를 늘리는 것 사이의 긴장은 [[analysis-scaling-vs-data]]에서 더 자세히 다룬다.

[^src-scaling-laws-paper]: [[source-scaling-laws-paper]]
