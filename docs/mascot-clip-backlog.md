# MYCO 클립 백로그 — 제작 요청 (Higgsfield → Resolve)

> 현재 앱은 모든 표면에서 `idle` 클립을 재사용 중. 아래 클립이 도착하면 표면별로 교체 배선한다.
> **파이프라인(검증됨)**: Higgsfield 생성(아래 프롬프트) → 네가 DaVinci Resolve Delta Keyer로 누끼 →
> **ProRes 4444 + Export Alpha .mov** 전달 → Claude가 HEVC(hvc1)+VP9 duo로 변환·배선.
> 프롬프트 블록 [IDENTITY]/[LIGHTING]/[LOOP]/[CHROMA]/[NEGATIVE]는 `docs/mascot-motion-prompts.md`의
> **검증된 강화판**을 그대로 접두로 붙일 것 (v2에서 rim·비침·그림자 제거 확인된 그 블록들).

## 클립 목록 (우선순위순)

| # | clip | 쓰일 곳 (코드 준비 상태) | 화면비 | 길이 | 종류 |
|---|---|---|---|---|---|
| 1 | `celebrate` | Ingest 성공 배지 · Study 세션 완료 | 1:1 | ~2s | **one-shot** |
| 2 | `think` | Query 실행 대기(ThinkingGalaxy 옆) | 1:1 | ~5s | loop |
| 3 | `wave` | 온보딩 스텝 1 (환영) | 1:1 | ~3s | loop |
| 4 | `sleepy` | 빈 vault Overview · Graph empty | 1:1 | ~5s | loop |
| 5 | `sorry` | ErrorBoundary 크래시 · Ingest 에러 | 1:1 | 정지컷이어도 OK | poster/loop |
| 6 | `drift` | 그래프 카메오(Phase 2, CosmicEvents 패턴) | 16:9 | ~8s | loop |

## 액션 프롬프트 (각각 [IDENTITY]+[LIGHTING]+아래+[LOOP]+[CHROMA]+[NEGATIVE])

> ⚠️ **감정 단어 주의**: "happy/smiling" 같은 표현은 모델이 **입(스마일)을 그려버린다** — 감정은
> 반드시 몸짓·발광 묘사로만 쓰고, 각 프롬프트 끝에 "the face remains ONLY the two eyes" 를 붙일 것.

1. **celebrate** (one-shot — [LOOP] 대신 "single action, clean start and end pose, 24fps"):
   > an excited squash-and-stretch hop; the violet gill-glow flares bright and a small ring of violet
   > sparkles bursts outward once, then everything settles back to calm. The joy is expressed ONLY
   > through the bouncing motion and the glow flare — the face remains ONLY the two eyes, no other
   > facial features. Quick, ~2 seconds.

2. **think**:
   > eyes slowly scanning left and right as if reading; the contained violet gill-glow pulses in a
   > slow thinking rhythm; occasionally the spore-bud tilts like a cocked head. Pensive, focused.

3. **wave**:
   > wakes up with a soft blink, then gives a single greeting bob (a bow-like nod, since it has no
   > arms); the gill-glow warms brighter during the bob; the spore-bud bounces once. The warmth is
   > expressed ONLY through the bob and the glow — the face remains ONLY the two eyes.

4. **sleepy**:
   > dozing — eyes closed to thin arcs, the gill-glow dimmed to a faint ember, the whole body rising
   > and falling with slow sleep-breathing; one tiny "zzz"-like spore particle drifts up and fades.

5. **sorry**:
   > apologetic — body tilted slightly forward like a small bow, eyes turned down into soft droopy
   > arcs, gill-glow dimmed; a single slow blink. Contrite but endearing, minimal motion.

6. **drift** (그래프 카메오용 — [CHROMA] 유지, 캐릭터가 프레임을 천천히 가로지름):
   > drifting slowly from frame-left to frame-right like a tiny explorer floating through space,
   > gently bobbing, gill-glow softly pulsing; eyes glance toward the camera once mid-way, then it
   > continues and exits frame-right. No camera movement — only the character moves.

## 납품 체크리스트 (클립당)
- [ ] **입·코·눈썹 등 없음 — 얼굴은 눈 2개뿐** (하나라도 나오면 재생성)
- [ ] **바닥면·지평선·바닥 그림자 없음** — 캐릭터가 프레임 하단에서 떨어져 부유
- [ ] 그린 배경 균일(그라디언트·바닥·그림자 없음 — [CHROMA])
- [ ] 몸 불투명·rim 없음([IDENTITY]/[NEGATIVE] 강화판 사용)
- [ ] loop 클립은 첫/끝 프레임 동일
- [ ] Resolve 키잉 후 **ProRes 4444 + Export Alpha** (배경 레이어 없이)
- [ ] 파일명: `myco_<clip>.mov` → Claude에게 전달

## 도착 후 Claude가 하는 일
`MascotClip.tsx`의 `CLIPS` 레지스트리에 항목 추가(hvc1 mov + VP9 webm + poster 3종 생성) → 표면 교체 배선
(celebrate→Ingest 성공/Study 완료, think→ThinkingGalaxy, wave→온보딩, sleepy→빈 상태, sorry→에러,
drift→graphScene 카메오 레이어 Phase 2 구현).
