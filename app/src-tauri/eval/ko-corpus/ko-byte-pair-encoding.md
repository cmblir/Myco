---
title: "바이트 페어 인코딩"
type: technique
tags:
  - technique
created: 2024-01-07
last_updated: 2024-03-15
source_count: 1
confidence: high
status: active
---

# 바이트 페어 인코딩

[[byte-pair-encoding|바이트 페어 인코딩]](BPE)은 개별 문자 또는 바이트에서 출발해 가장 자주 함께 등장하는 쌍을 하나의 새 토큰으로 반복 병합하며, 목표 어휘 크기에 도달할 때까지 이를 되풀이하는 서브워드 [[tokenization|토큰화]] 알고리즘이다.[^src-attention-is-all-you-need] 그 결과로 만들어진 어휘는 흔한 단어를 단일 토큰으로 표현하면서도 드문 단어는 재사용 가능한 서브워드 조각으로 쪼갤 수 있어 어휘 밖 실패를 없앤다. 병합 규칙을 코퍼스 통계로부터 학습하기 때문에, BPE는 조밀하고 데이터 기반적인 어휘를 만들어 내며 대규모 언어 모델의 기본 선택지가 되었다.

[^src-attention-is-all-you-need]: [[source-attention-is-all-you-need]]
