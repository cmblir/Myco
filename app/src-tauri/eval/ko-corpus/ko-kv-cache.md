---
title: "KV 캐시"
type: technique
tags:
  - technique
created: 2024-01-24
last_updated: 2024-03-15
source_count: 1
confidence: high
status: active
---

# KV 캐시

KV 캐시는 [[attention-mechanism|어텐션 메커니즘]]이 이전에 처리한 모든 토큰에 대해 계산한 키·값 텐서를 저장해, 매 디코딩 단계마다 다시 계산하지 않도록 하는 [[inference-optimization|추론 최적화]] 기법이다. 자기회귀 생성 중 각 새 토큰은 자신의 쿼리만 계산하고 캐시된 키·값에 대해 주의를 기울이면 되므로, 토큰당 어텐션 비용이 이차적 재계산에서 한 번의 증분 단계로 바뀐다.[^src-attention-is-all-you-need] 대가는 메모리다. 캐시는 시퀀스 길이와 배치 크기에 선형적으로 커지며, 긴 문맥 생성 중 GPU 메모리의 주요 소비원이 된다. 이 메모리 압박은 캐시 양자화, 그룹 쿼리 어텐션, 페이지 단위 캐시 관리 같은 추가 최적화를 유발한다.

[^src-attention-is-all-you-need]: [[source-attention-is-all-you-need]]
