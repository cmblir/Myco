---
title: "셀프 어텐션"
type: technique
tags:
  - technique
created: 2024-01-03
last_updated: 2024-03-15
source_count: 1
confidence: high
status: active
---

# 셀프 어텐션

[[self-attention|셀프 어텐션]]은 쿼리·키·값이 모두 동일한 입력 시퀀스로부터 투영되는 [[attention-mechanism|어텐션 메커니즘]]의 한 형태로, 각 토큰이 그 시퀀스 안의 다른 모든 토큰에 주의를 기울일 수 있게 한다.[^src-attention-is-all-you-need] 이러한 시퀀스 내부 비교 덕분에 모델은 각 위치가 주변 전체 문맥의 영향을 받는 표현을 구축할 수 있으며, 이것이 트랜스포머가 단일 층에서 장거리 의존성을 포착하게 해 주는 요소다. 실제로는 셀프 어텐션이 [[multi-head-attention|다중 헤드 어텐션]]으로 여러 번 병렬 실행되며, 각 헤드는 서로 다른 통사적·의미적 관계에 집중하도록 학습한다.

[^src-attention-is-all-you-need]: [[source-attention-is-all-you-need]]
