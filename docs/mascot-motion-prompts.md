# Memex 마스코트 — Higgsfield 프롬프트 팩 (누끼/투명 배경용)

> 역할 분담: **영상·이미지 생성 = 사용자(Higgsfield)** / **프롬프트 팩 + 앱 통합 = Claude**
> 이 문서의 프롬프트를 Higgsfield에 그대로 넣어 생성하고, 산출물을 `app/src/assets/mascot/`에 드롭하면 앱에 배선한다.

## 0. 해석 (먼저 읽기)

- **캐릭터 = 버섯 마스코트** (`app/src/assets/logo.png` 기반: 무광 검은 갓, 흰 점 눈 2개, 갓 밑면 보라 발광, 오른쪽 아래 작은 포자, 소프트 3D 클레이/비닐토이 렌더, 아주 작은 몸으로 둥둥 떠다님).
- **첨부한 `NOCHI` 시트는 "포맷 레퍼런스"** — 턴어라운드(FRONT/SIDE/BACK) + NOTES + EXPRESSIONS + ACTIONS 그리드 레이아웃을 그대로 따르되, **그 안의 캐릭터는 버섯**으로 그린다.
- 만약 실제로 NOCHI(수염 교수)를 마스코트로 쓰려는 것이었다면 알려줘 — 그러면 정체성 블록만 교체하면 된다.
- **제안 이름**: `MYCO` (mycelium=균사체 = 연결된 지식망, Memex와 맞음). 바꿔도 됨.
- **페르소나** (NOCHI의 "AI Session Caretaker"에 대응): *어두운 볼트에서 자라며, 노트 사이의 연결을 찾으면 밑면이 밝게 빛나는 지식 관리자.*

## 1. 재사용 블록 (모든 프롬프트에 접두로 붙임)

> 검증됨(2026-07-16): 아래 강화판 [IDENTITY]+[LIGHTING]+[NEGATIVE]로 재생성한 `myco_idle_v2`가
> 유리질 rim·몸 비침(subsurface)·바닥 그림자 없이 깨끗하게 나와 누끼가 완벽히 빠졌다. 이 4블록을 유지할 것.

**[IDENTITY]**
> MYCO — a cute minimalist mushroom mascot. A SOLID, 100% OPAQUE matte object: smooth near-black
> charcoal cap (#1b1822) and a small stubby body. Soft 3D claymation / matte vinyl-toy look.
> CRITICAL — the entire character is fully opaque and solid; you must NOT be able to see through any
> part of it. MATTE finish ONLY: no gloss, no shiny speculars, no wet or glassy look, no rim light,
> no fresnel edge, no transparent dome or glass shell, NO subsurface scattering, NO translucency, no
> glowing outline. The cap silhouette is a HARD, clean, fully-opaque matte edge — never a glassy,
> glowing, or see-through rim. THE FACE IS ONLY TWO WHITE OVAL DOT EYES — nothing else, ever.
> Below and around the eyes the surface is completely blank, smooth and featureless: NO mouth, NO
> smile, NO lips, NO teeth, NO nose, NO eyebrows, NO cheeks, NO blush. All emotion is expressed
> ONLY through body motion and the glow — never through facial features. A SMALL CONTAINED
> violet glow (#8b6cff) only inside the recessed gills directly under the cap, around the eyes — a
> soft inner light that stays tight to that small area and does NOT bloom, haze, transmit through the
> body, wash over the body, or bleed past the silhouette. A small round spore-bud sphere on its
> lower-right side. No visible limbs (tiny stub hands only when an action needs them). Very small
> body that gently floats. Friendly, calm, a little mysterious. Keep the character identical, solid,
> and fully opaque across every frame.

**[LIGHTING]** (rim/글로시 엣지 방지)
> Flat, even, soft frontal fill light. No rim light, no back light, no hard key that carves a bright
> glossy edge, no reflections on the silhouette. The character reads as one flat, cleanly-separated,
> opaque shape.

**[LOOP]** (영상 전용)
> Seamless perfect loop, subtle motion, smooth ease-in-out, no camera cuts, first and last frame
> identical, 24fps. Stable framing, character centered, no drift out of frame. No motion blur, no
> soft focus.

## 2. 누끼(크로마키) 규칙 — 영상 배경

투명 배경 산출물이 목표이므로 **단색 크로마 배경 위에서 생성** → 키잉으로 알파 추출.

- **키 컬러: 크로마 그린 `#00FF00`** 요청 (실제 Higgsfield 산출은 밝은 플랫 그린 ≈`rgb(120,219,145)`로 나옴 — 무방).
  버섯 몸이 검정, 발광이 보라라 그린과 RGB 거리가 넉넉(몸 283 / 발광 163)해 깨끗하게 빠짐.
- **바닥·그림자·그라디언트 금지** (v1은 바닥 shadow가 남아 키잉 필요, v2 프롬프트에서 제거).
- 보라 발광 **몸에 격리**(subsurface로 몸 투과 금지 — v1 비침의 원인이었음).
- **ffmpeg 키잉 레시피(검증)**: `colorkey=0x78db91:0.24:0.10,despill=type=green:mix=0.4:expand=0.2`
  → 그림자(darker green, 거리 71)까지 제거하되 발광(163)은 온전. 그린 프린지 심하면 대안 **블루 `#0000FF`**
  (단 보라 발광과 겹칠 수 있어 그린 우선).
- 각 프롬프트에 아래 [CHROMA]+[NEGATIVE]를 붙인다:

**[CHROMA]**
> Background: ONE pure, fully-saturated bright chroma-key green (#00FF00) — a professional green
> screen. Perfectly flat and evenly lit: one uniform green with NO gradient, NO darker green at the
> bottom, NO floor, NO cast shadow, NO reflections. There is NO ground plane and NO horizon line
> anywhere in frame — the character floats in mid-air, well above the bottom edge, and the flat
> green extends edge to edge, top to bottom, perfectly uniform. Zero green spill and zero green rim
> on the character. Maximum contrast between the dark opaque character and the flat green so the
> silhouette extracts with a hard, clean edge.

**[NEGATIVE / must NOT appear]**
> mouth, smile, lips, teeth, nose, eyebrows, cheeks, blush, any facial feature besides the two
> eyes, transparency, translucency, see-through body, glass, gel, crystal, glossy or wet
> highlights, rim light, fresnel edge, halo, glowing outline, glowing dome, subsurface scattering,
> atmospheric haze, fog, bloom past the character, motion blur, background gradient, ground plane,
> floor, horizon line, contact shadow, drop shadow, ambient occlusion patch under the character,
> shadow on the green, reflections, extra objects.

## 3. 산출물 ① — 캐릭터 시트 1장 (`generate_image`)

- 도구: `generate_image`, **레퍼런스 이미지 = `app/src/assets/logo.png`** (정체성 고정).
- 배경: **흰색/뉴트럴** (시트는 레퍼런스용 — 누끼 불필요, NOCHI처럼 흰 배경).
- 렌더: **로고와 같은 소프트 3D 클레이 룩** (그래파이트 스케치 룩을 원하면 말해줘 — 대안 가능).
- 화면비: 4:3 또는 3:2 가로.

**프롬프트:**
> Character model sheet of [IDENTITY]. Clean layout on a plain white background, soft 3D
> claymation render (match the reference logo's look), organized like a professional model sheet:
> - Top row — TURNAROUND: front, side, back views of the mushroom, consistent proportions, orthographic.
> - A NOTES column (right) calling out key features with small labeled thumbnails: white dot eyes
>   (main expression driver), violet underglow (brightens with discovery), the spore-bud companion,
>   the smooth matte black cap, the tiny floating body.
> - EXPRESSIONS row (7): idle, thinking, scanning, curious, discovery (eyes wide + underglow flare),
>   satisfied (warm steady glow), sleepy (dim glow, "zzz").
> - ACTIONS row (6): reading a glowing note, linking two notes with threads of violet light,
>   planting a spore that sprouts a tiny star, pondering (question swirl), pointing out something
>   ("!"), all-good (check mark, steady glow).
> Neat title "MYCO" and a one-line subtitle "Vault Keeper / Session Caretaker". Consistent
> character identity in every cell.

## 4. 산출물 ② — 행동별 영상 클립 (`image_to_video` 또는 `generate_video`)

각 클립: **[IDENTITY] + (액션) + [LOOP] + [CHROMA]** 를 이어 붙여 생성. 크로마 그린 배경.
`image_to_video`를 쓰면 캐릭터 시트에서 뽑은 정면 포즈를 시작 프레임으로 넣어 일관성↑.

| # | clip | 앱 표면 | 화면비 | 길이 | 종류 |
|---|---|---|---|---|---|
| 1 | `loader` | 그래프 로딩 (`App.tsx` `.graph-loading`) | 1:1 | ~4s | loop |
| 2 | `thinking` | 질의 대기 (`ThinkingGalaxy`/`PageQuery`) | 1:1 | ~5s | loop |
| 3 | `onboarding` | 첫 실행 (`OnboardingWizard`) | 4:5 | ~4s | loop |
| 4 | `empty` | 빈 상태 (overview/graph) | 1:1 | ~4s | loop |
| 5 | `success` | ingest 완료 등 | 1:1 | ~2s | one-shot |
| 6 | `idle` | About/MCP 상태 | 1:1 | ~5s | 저강도 loop |
| 7 | `linking` | 연결 생성 강조 (마케팅/온보딩) | 16:9 | ~5s | loop |
| 8 | `sting` | 영상 인트로 로고 (마케팅) | 1:1 | ~3s | one-shot |

**액션 프롬프트 (각각 [IDENTITY]+아래+[LOOP]+[CHROMA]):**

1. **loader** — gently floating and bobbing in place; the violet underglow slowly pulses like calm breathing; the spore-bud sways slightly.
2. **thinking** — eyes slowly scanning left and right; thin threads of violet light and small particles stream outward from its glow, reach into the air, then fade — as if searching a knowledge network.
3. **onboarding** — wakes up: eyes blink open, the underglow brightens warmly, a small welcoming bob, the spore-bud bounces once. Inviting, friendly.
4. **empty** — gently releases its glowing spore, which drifts down and sprouts into a tiny new violet star that twinkles (evokes creating a first note).
5. **success** (one-shot) — a happy squash-and-stretch pop; the underglow flares bright and a small ring of violet sparkles bursts outward, then settles. Quick, celebratory.
6. **idle** — mostly still, breathing softly with a slow underglow pulse and an occasional slow blink. Minimal, ambient.
7. **linking** — two small glowing note-motes appear on the left and right; MYCO reaches a thread of violet light between them until they connect and light up. Reads as "linking two notes".
8. **sting** (one-shot) — a swarm of glowing violet spores swirls in and coalesces into MYCO, which settles and blinks as the underglow ignites; ends on a clean centered hero frame for a logo lockup.

## 5. Higgsfield 실행 순서

1. 크레딧 확인: `show_plans_and_credits` / `balance`.
2. `logo.png` 업로드(`media_upload`) → 캐릭터 레퍼런스로 지정. 모델 애매하면 `models_explore(action:'recommend')`에 "consistent character image→video, chroma-key" 목표로 추천 요청.
3. §3 캐릭터 시트 1장 생성(흰 배경).
4. (선택) 시트에서 정면 포즈 크롭 1장 → 각 클립의 `image_to_video` 시작 프레임으로.
5. §4 클립을 크로마 그린으로 생성. `loader/idle`는 소형·짧게(≤480px, 낮은 비트레이트).
6. 전달: **크로마 그린 mp4** (Claude가 키잉해서 알파 WebM로 변환) — 또는 Higgsfield에서 알파/투명 출력이 되면 그걸로.

## 6. 전달 후 앱 통합 (Claude 담당)

- 크로마 그린 → **알파 WebM(VP9)** 키잉 + 폴백용 mp4 + 포스터 PNG(0프레임) 생성.
- `MascotClip` 컴포넌트가 투명 WebM을 표면에 오버레이 (reduced-motion/설정 off/자산없음 → 정적 폴백).
- 파일 규약: `app/src/assets/mascot/<clip>.webm` + `<clip>.mp4` + `<clip>.poster.png`.

---
_생성물 예시나 톤이 어긋나면 이 문서의 [IDENTITY]/액션 문구만 고쳐 재생성하면 됨._
