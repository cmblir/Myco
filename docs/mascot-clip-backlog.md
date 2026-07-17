# MYCO 클립 백로그 — 제작 요청 (Higgsfield → Resolve)

> **파이프라인(검증됨)**: Higgsfield 생성(아래 프롬프트) → 네가 DaVinci Resolve Delta Keyer로 누끼 →
> **ProRes 4444 + Export Alpha .mov** 전달 → Claude가 HEVC(hvc1)+VP9 duo로 변환·배선.
> 프롬프트 블록 [IDENTITY]/[LIGHTING]/[LOOP]/[CHROMA]/[NEGATIVE]는 `docs/mascot-motion-prompts.md`의
> **검증된 강화판**을 그대로 접두로 붙일 것 (v2에서 rim·비침·그림자 제거 확인된 그 블록들).

## 코드 쪽 준비 상태 (2026-07-17 실측)

앱은 **모든 표면에서 `idle` 클립을 재사용 중**이다 — `CLIPS` 레지스트리에 `idle` 항목 하나뿐이고,
6개 마운트가 전부 `clip="idle"`이다. 따라서 "클립이 도착하면 한 줄 교체"는 **표면이 이미 있는 클립에만**
해당한다. 아래 표의 준비 상태 열은 그 구분이다 — 이전 판은 전부 준비된 것처럼 읽혔다.

클립 하나를 추가하는 데 필요한 것:
1. 에셋 3개를 `app/src/assets/mascot/`에 — `<key>.mov`(hvc1+alpha), `<key>.webm`(VP9+alpha), `<key>.poster.png`
2. `MascotClip.tsx`의 `CLIPS`에 한 줄 (`zoom`은 캐릭터가 프레임에서 차지하는 비율에 맞춰 조정, one-shot이면 `loop: false`)
3. 표면이 없으면 — 그 표면을 만드는 것. 이게 대부분의 작업이다.

**one-shot 재생은 구현되어 있다**: `loop: false`인 클립은 한 번 재생 후 마지막 프레임(poster)에서 멈추고
`onEnded`를 부른다. reduced-motion·디코드 실패·마스코트 끔 상태에서도 `onEnded`는 반드시 한 번 불린다
(안 그러면 클립을 기다리는 호출자가 영영 멈춘다). 즉 `celebrate`의 코드 블로커는 이제 없다 — 표면만 없다.

## 클립 목록 (우선순위순)

| # | clip | 쓰일 곳 | 준비 상태 | 화면비 | 길이 | 종류 |
|---|---|---|---|---|---|---|
| 1 | `wave` | 온보딩 스텝 1 (환영) | ✅ **표면 있음** — `OnboardingWizard.tsx:116`이 이미 마스코트를 마운트. 레지스트리 한 줄 = 진짜 한 줄. **파이프라인 검증용 첫 후보.** | 1:1 | ~3s | loop |
| 2 | `sorry` | ErrorBoundary 크래시 | ✅ **표면 있음** — 크래시 화면이 `idle.poster.png`를 정지컷으로 쓰는 중. 정지컷이면 poster만 교체. ⚠️ 크래시 화면은 `MascotClip`을 **절대** 쓰면 안 된다(마스코트 렌더가 터진 원인일 수 있음) → `sorry`도 `<img>` poster로만. | 1:1 | 정지컷 OK | poster |
| 3 | `think` | Query 실행 대기 | 🟡 **부분** — Query 빈 상태(`PageQuery.tsx:280`)엔 마운트가 있으나 *실행 대기 중* 표면은 없음. ThinkingGalaxy 옆 배선 필요. | 1:1 | ~5s | loop |
| 4 | `sleepy` | 빈 vault Overview · Graph empty | ❌ **표면 없음** — 두 빈 상태 모두 마스코트를 안 쓴다. | 1:1 | ~5s | loop |
| 5 | `celebrate` | Ingest 성공 배지 · Study 세션 완료 | ❌ **표면 없음** — 코드 블로커(one-shot)는 해결됨. 배지/완료 화면에 마운트 추가 필요. | 1:1 | ~2s | **one-shot** |
| 6 | `drift` | 그래프 카메오(Phase 2) | ❌ **표면 없음 + 설계 이견** — 유일한 타이머 기반 자동 등장(= Clippy를 죽인 PUSH 패턴). 방어하려면 기본 OFF여야 하고, 그러면 거의 아무도 못 본다. 게다가 16:9인데 `MascotClip`은 정사각 크롭이라 컴포넌트 작업이 별도로 필요. **만들기 전에 재고 권장.** | 16:9 | ~8s | loop |

> **덜어내기**: 플랜 자체의 P5가 "less is more (3-4곳)"라고 말한다. 지금 Query 한 곳 + 크래시 한 곳이 있다.
> 여기서 더 늘릴 거면 **2곳 이하**로 고르는 게 플랜의 자기 권고에 맞다. 이 표는 채울 목록이 아니라 **자를 목록**이다.

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
