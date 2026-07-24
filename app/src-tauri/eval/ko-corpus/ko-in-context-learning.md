---
title: "문맥 내 학습(In-Context Learning)"
type: concept
tags:
  - concept
created: 2024-01-28
last_updated: 2024-03-15
source_count: 1
confidence: high
status: active
---

# 문맥 내 학습(In-Context Learning)

문맥 내 학습은 대규모 언어 모델이 가중치에 대한 어떤 기울기 갱신도 없이, 오직 프롬프트에 놓인 예시나 지시만으로 새로운 과제를 수행하는 능력이다. 이 능력은 어텐션 메커니즘이 모델로 하여금 동일한 문맥 창 안에서 앞서 시연된 패턴에 다음 토큰 예측을 조건화하게 하는 [[transformer-architecture|트랜스포머]]로부터 창발한다.[^src-attention-is-all-you-need] 몇 개의 입력-출력 예시(few-shot 프롬프팅)를 제공함으로써 사용자는 추론 시점에 행동을 조종할 수 있고, [[chain-of-thought|생각의 사슬]] 같은 구조화된 변형은 중간 추론 단계를 시연함으로써 이를 확장한다. 문맥 내 학습은 프롬프트 자체를 과제를 지정하는 주된 인터페이스로 만들기 때문에, 현대의 대부분의 [[prompting|프롬프팅]] 기법의 토대가 된다.

[^src-attention-is-all-you-need]: [[source-attention-is-all-you-need]]
