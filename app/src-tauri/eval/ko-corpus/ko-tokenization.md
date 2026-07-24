---
title: "토큰화"
type: technique
tags:
  - technique
created: 2024-01-06
last_updated: 2024-03-15
source_count: 1
confidence: high
status: active
---

# 토큰화

[[tokenization|토큰화]]는 원시 텍스트를 모델이 처리하기 전에 [[embeddings|임베딩]]으로 매핑할 수 있는 이산 단위 — 토큰 — 로 쪼개는 과정이다. [[transformer-architecture|트랜스포머]] 위에 세워진 현대 언어 모델은 서브워드 토큰화, 가장 흔하게는 [[byte-pair-encoding|바이트 페어 인코딩]]에 의존하는데, 이는 문자 수준과 단어 수준 세분성 사이의 균형을 잡으면서 어휘를 고정된 관리 가능한 크기로 유지한다.[^src-attention-is-all-you-need] 서브워드 방식은 드물거나 처음 보는 단어를 더 작은 알려진 조각들로 조합해 표현하게 해 주어, 단어 수준 접근이 겪는 어휘 밖(out-of-vocabulary) 문제를 피한다. 토크나이저의 선택은 시퀀스 길이, 계산 비용, 그리고 텍스트가 얼마나 효율적으로 인코딩되는지에 직접 영향을 준다.

[^src-attention-is-all-you-need]: [[source-attention-is-all-you-need]]
