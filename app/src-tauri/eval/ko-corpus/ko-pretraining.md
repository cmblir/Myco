---
title: "사전학습"
type: technique
tags:
  - technique
created: 2024-01-13
last_updated: 2024-03-15
source_count: 1
confidence: high
status: active
---

# 사전학습

사전학습은 모델이 방대한 비라벨 텍스트로부터 일반적인 언어 표현을 학습하는 초기의 대규모 자기지도 학습 단계로, 보통 다음 토큰을 예측하는 방식으로 이루어진다. 이는 어떤 과제별 적응에 앞서 [[transformer-architecture|트랜스포머]]의 넓은 지식과 능력을 확립하며, 그 수익은 모델 크기·데이터·연산이 커짐에 따라 예측 가능한 [[scaling-laws|스케일링 법칙]]을 따른다.[^src-scaling-laws-paper] 그 결과로 얻는 베이스 모델은 그대로 배포되는 경우가 드물고, 대신 더 좁은 목표나 인간 선호에 대한 [[fine-tuning|파인튜닝]]의 토대가 된다. 사전학습은 프런티어 모델 구축의 총 연산 비용을 지배하며, 그래서 효율적인 자원 배분이 이 과정의 핵심이 된다.

[^src-scaling-laws-paper]: [[source-scaling-laws-paper]]
