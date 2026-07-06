# Cosmic form — real reference photos

Obsidian에서 이 노트를 열면 아래 실제 사진들이 보입니다. 그래프를 어떤 "우주 형태"로
만들지 고르기 위한 레퍼런스입니다. 각 이미지가 앞서 논의한 3가지 방향에 대응합니다.

---

## A) 우주 거미줄 (Cosmic web) — 추천

![[cosmic-web.jpg]]

은하들이 **밝은 노드**, 그 사이를 잇는 **희미한 필라멘트(가닥)**, 그리고 사이의 검은 **void(빈 공간)**.
노드+엣지 그래프가 원래 이 모양에 가장 가깝습니다 — 이전 force 버전이 이쪽에 근접했고,
렌더링(글로우/색온도/깊이/밀도)만 우주답게 다듬으면 됩니다.
출처: Wikimedia — *Large-scale structure of light distribution in the universe*

---

## B) 사실적 나선 은하 (Spiral galaxy)

![[m101-pinwheel-spiral.jpg]]

밝은 따뜻한 코어 + 파란 나선팔 + 팔 위의 별생성 매듭. 검은 배경에 전경 별들.
내가 만든 기하학적 나선이 실패한 건 이 **유기적 곡선 + 먼지 + 가스 글로우**가 없어서입니다.
출처: Wikimedia — *Pinwheel Galaxy (M101)*

### B-보조) 은하 디스크 클로즈업 (텍스처 참고)

![[andromeda-spiral.jpg]]

안드로메다(M31) 허블 기가픽셀 일부. 나선 "모양"이 아니라 **수백만 별의 밀도 + 먼지 띠 질감** 참고용.
출처: Wikimedia — *Andromeda Galaxy M31 (Heic1502a)*

---

## C) 성운 / 성단 (Nebula)

![[orion-nebula.jpg]]

분홍·청록 가스 구름 + 박힌 밝은 별들. 예쁘지만 노드/연결 **구조가 거의 안 보임** — 아트워크에 가까움.
출처: Wikimedia — *Orion Nebula (Hubble 2006 mosaic)*

---

## 내 추천

그래프(노드+엣지) 본질상 **A) 우주 거미줄**이 가장 자연스럽고, 이전 force 버전이 이미 그 골격입니다.
B는 위치가 연결구조를 버려야 해서 그래프로선 부자연(이미 한 번 실패). C는 구조가 사라짐.

→ 제안: **이전 force 레이아웃 복원 + cosmic-web 처럼 보이도록 렌더링 개선**
(필라멘트 글로우, 노드 밝기 분포, 색온도, 깊이 안개, 배경 별).
