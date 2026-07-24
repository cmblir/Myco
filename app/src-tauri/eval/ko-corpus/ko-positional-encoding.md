---
title: "위치 인코딩"
type: technique
tags:
  - technique
created: 2024-01-08
last_updated: 2024-03-15
source_count: 1
confidence: high
status: active
---

# 위치 인코딩

[[positional-encoding|위치 인코딩]]은 토큰 순서에 관한 정보를 [[transformer-architecture|트랜스포머]]에 주입한다. 트랜스포머는 [[attention-mechanism|어텐션 메커니즘]]이 입력을 순서 없는 집합으로 취급하기 때문에 그렇지 않으면 순열 불변(permutation-invariant)이다.[^src-attention-is-all-you-need] 원래의 트랜스포머는 서로 다른 주파수의 고정된 사인·코사인 함수를 입력 벡터에 더해, 각 위치에 모델이 상대적·절대적 거리를 추론하는 데 쓸 수 있는 고유한 서명을 부여했다.[^src-attention-is-all-you-need] 이후 변형들은 이를 학습형 또는 회전형(rotary) 방식으로 대체했지만, 핵심 요구는 변하지 않는다. 위치 정보가 없으면 어텐션만으로는 시퀀스의 순서를 구분할 수 없다.

[^src-attention-is-all-you-need]: [[source-attention-is-all-you-need]]
