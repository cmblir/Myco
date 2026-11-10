# Mascot motion library: one character, many moments

Owner, 2026-10-02: krea.ai has 20,000 credits; "너가 쓰고 싶은만큼 여러 모션들 여러 동작들 모두 만들고
지금 쓰고 있는 로고나 노치 모션 등등 다 만들어도 좋아". This extends
`2026-10-02-notch-mascot.md` from the notch to the whole app.

## Where the clips come from

- Seedance 2.5 on krea.ai: 4 s, 480p (640×640), 1:1.
- The start and end frames are the committed character-sheet poses on a solid green plate
  (`output/mascot-renewal/sources/*.png`). Every clip begins and ends on a pose, so it hands off to
  the still sprite without a jump.
- Each clip is keyed by `app/scripts/mascot-key-clip.py`, which runs per frame:
  - The plate is sampled from the border, alpha comes from green excess, and edges are despilled.
  - The full frame is kept, so the scale matches the 384 px pose sprites.
- Outputs per clip:
  - `<name>.webm` (VP9 alpha, 384 px, 24 fps)
  - `<name>.mov` (HEVC alpha, hvc1)
  - `<name>.poster.png`
  - `<name>.strip.webp` (12 fps, 160 px frames, for the notch)
  - `<name>.json`
- QA: every clip's contact sheet is looked at on a dark and a light ground. A clip whose cap
  shape, eyes or colours drift from the poses is not shipped.

## Library (name, from → to, use)

| Clip | Frames | Loop | Used for |
|---|---|---|---|
| hello | attention → attention | once | notch peek on hover |
| absorb-v2 (v1 fallback) | attention → success | once | notch drop accepted; ingest "received" |
| read-loop | reading → reading | loop | notch running HUD; ingest in progress |
| celebrate | success → success | once | notch done; ingest finished; study session done |
| doze | resting → resting | loop | notch idle after a long quiet stretch |
| wake | resting → attention | once | notch idle → peek, used only where the brief top clip is hidden |
| listen | attention → attention | loop | notch voice recording |
| think | thinking → thinking | loop | notch saving; Ask answering |
| shake-no | attention → attention | once | notch rejected file |
| sigh | attention → resting | once | notch cancelled |
| squish | attention → attention | once | click on the mascot |
| look-around | attention → attention | loop | search or Ask with nothing typed yet (empty state) |
| welcome | attention → attention | once | first-run wizard; About hero entry |
| not-found | attention → attention | once | abstain card ("내 노트에서 찾지 못했어요") |
| worried | attention → attention | once | crash and error screens |
| idle | attention → attention | loop | not used for long loops: its blink is too long. The procedural blink stays |

## Rules

- **One representative character per surface**, as in the mascot README. Small utility rows keep
  their icons.
- **One-shot clips play once and hold their last frame**, which is the pose the state uses next.
  Loops are only for ongoing work or ambient idle.
- **Motion off switches.**
  - `prefers-reduced-motion` shows the still pose.
  - `mascotEnabled = false` shows today's static mark.
  - A hidden window plays nothing, and an off-screen element pauses.
- **Engine sniff, as `MascotClip` already does.** WKWebView plays hvc1 `.mov`, and Chromium plays
  VP9 `.webm`. On error, show the poster.
- **Budget.**
  - Notch strips: ≤ 1.6 MB total.
  - App videos: only the clips a surface uses ship, ≤ 4 MB total.
  - Everything loads lazily. Nothing is in the initial JS chunk.
- **Text stays the source of status.** The character is decorative and `aria-hidden`.

## Acceptance

- vitest:
  - The state → clip table, with each surface → clip.
  - Missing-clip fallback.
  - Reduced motion → still.
  - The budget test: sum of shipped motion asset sizes under the limits.
- Browser (`?mock=1`), with screenshots looked at in ko + light and en + dark:
  - every notch frame, the first-run wizard, the About page, an abstain answer, the crash screen
    (`?crash=1` or the existing smoke), and ingest received → running → done.
  - The character is on-model, with no green fringe, no clipping and no jump at a clip's start or
    end.
- Not checkable headless: WKWebView HEVC-alpha playback in the installed app. The owner checks it.
