# Notch mascot: myco lives in the notch

> Current behavior: the 2026-10-04 owner correction below supersedes all
> earlier collapsed mascot, waiting-count, wing, and idle pill decisions.

Owner, 2026-10-01: "노치도 지금 수정이 필요해. 약간 https://github.com/Louis-CFM/coucou 같이 해야하고 필요하다면
지금 있는 myco 캐릭터시트 기반으로 … 여러 모션들을 만들어도 돼. 일관성을 유지하면서". Motion clips are made
with krea.ai, because the Higgsfield account has no credits.

## What coucou does (the reference)

Coucou is from its README, fetched 2026-10-01. It is a borderless panel hugging the notch:
- Mochi, a soft squircle with big eyes, is invisible when idle and peeks out when the notch is
  hovered, saying hi.
- Idle breathing and blinks, with eyes on a sphere that follow the mouse.
- A click squishes it ("annoyed"), and a triple-click makes it dizzy for a few seconds.
- Dragging a file onto the island turns it into a box that swallows the file.
- Session steps (reads, edits, runs) show step by step in the notch.
- It is drawn procedurally at 60 fps with springs and no animation library.

## What myco's notch is today

`components/NotchPanel.tsx` renders ten states (idle, peek, dragging, accepted, running, done,
capture, captured, recording, saving, cancelled, rejected, plus the no-notch pill). It is a dark
panel with a purple status dot and text. There is no character in it. `lib/notchDriver.ts` and
`src-tauri/src/notch.rs` drive it. notch.rs already reads `NSEvent.mouseLocation` for the
proximity peek. A browser preview exists: `?window=notch&notchMock=1&notchFrame=N`.

## The character (consistency rules)

The character sheet is the five poses committed on the main branch (`15a4680`):
`app/src/assets/mascot/poses/{resting,reading,thinking,attention,success}.png` (384², RGBA), and
its README. The identity spec is in `output/mascot-renewal/generation-prompts.json`. The
character is the user's original logo, a 3D charcoal-purple mushroom:
- a softly domed, slightly pointed dark cap with a luminous lavender underside;
- a short rounded dark body;
- two white oval eyes;
- small spherical orb hands.

It has no mouth, nose, limbs, fingers, feet, outfit or text. Every pose and clip keeps this
identity, the camera and the lighting. Nothing is redesigned.

## Decisions

1. **The mascot lives in the notch.** It is about 28–36 px tall in the collapsed notch and about
   56–72 px in the expanded panel. It sits at the panel's leading edge. In the collapsed idle
   state it peeks out at the notch's edge, the way coucou does. The status dot goes away where
   the mascot stands in for it. The text stays the source of status (accessibility).
2. **Rendering is layered so it stays one character.**
   - The pose image comes first.
   - **Procedural eyes** come next: white ovals drawn in SVG over the pose, with the pose's own
     eyes painted out once by a committed script. The eyes blink, look at the cursor, squint
     (annoyed), spiral (dizzy) and close (resting).
   - A **spring transform** on the whole sprite comes last: breathing (scale about 1.0–1.02), bob,
     squash and stretch, shake.
   - Generated clips (decision 4) replace the pose layer only while they play. They are
     one-shot, except a loop the state calls for.
3. **Behaviour by state** (myco's states, coucou's grammar):

   | State | Pose | Motion |
   |---|---|---|
   | idle (collapsed) | resting | slow breathing; blinks every 3–7 s; peeks at the notch edge |
   | peek (hover or near) | reading | slides out; one "hello" wave (clip); eyes follow the cursor |
   | click on the mascot | (current) | squish spring plus annoyed eyes for 600 ms |
   | triple-click | (current) | dizzy: spiral eyes and wobble for 2.5 s |
   | dragging (file over) | attention | leans toward the file, eyes wide, cap glow up |
   | accepted (drop) | attention → success | "gulp" (clip): it catches and swallows the file, then a sparkle, once |
   | running (ingest, distill, save) | reading | page-turn loop (clip) or a gentle bob; the step text beside it ("읽는 중 · attention-mechanism") |
   | done | success | celebrate hop (clip) once, then holds |
   | capture / recording | attention | listening: the cap glow pulses with the voice level |
   | saving | thinking | thought bubbles bob |
   | cancelled | resting | small sigh: down and back |
   | rejected (unsupported) | attention | head shake twice, eyes squint |

4. **Clips** (krea.ai, image-to-video from each pose on a solid #00FF00 backdrop):
   - The clips are `hello`, `gulp`, `celebrate` and `read-loop`.
   - Each is keyed to RGBA and downscaled to a sprite strip `app/src/assets/mascot/motion/<name>.webp`
     (frames of 160 px, 12–15 fps) with `<name>.json` `{ frames, fps, loop }`.
   - The total budget for new motion assets is ≤ 1.5 MB.
   - A clip that does not keep the identity (cap shape, eyes, colours) is not shipped. The
     procedural motion is the fallback, and every state must look right without any clip.
5. **Eyes follow the cursor** when the cursor is within the peek radius or over the panel.
   notch.rs throttles the cursor position to ≤ 30 Hz and emits it only while the panel is visible
   and peeked. When the panel is hidden or collapsed, there are no events and no rAF.
6. **Off switches.**
   - `prefers-reduced-motion`: still poses, with no tracking, no clips and no blinking.
   - The existing mascot setting (`mascotEnabled`) restores today's dot.
   - The no-notch pill gets the same mascot, smaller.
7. **No sound** in this slice.

## Invariants

- The notch never takes focus or a click from the app below. The current hit-test rules in
  notch.rs stay.
- Idle cost is zero frames while collapsed with nothing happening, beyond one CSS breathing
  animation, which the compositor runs off the main thread. No JS timers run while the panel is
  hidden.
- Pixel-art crispness is not a goal. The 3D sprite is downscaled with good filtering, and @2x
  assets are used for Retina.
- Every new user-visible string has en/ko/ja keys.

## Acceptance

- vitest:
  - The state → (pose, motion, clip) table.
  - The eye geometry: the look-at vector is clamped inside the eye socket, and blink timing is
    seeded and deterministic.
  - The spring step is stable.
  - The clip manifest loader: a missing clip falls back to the pose.
- Browser (`?window=notch&notchMock=1`):
  - Every frame is screenshotted at 2× and looked at: the mascot is present and on-model, and it
    is not cropped by the panel.
  - The cursor moves the eyes.
  - A click squishes and a triple-click makes it dizzy.
  - Reduced motion shows still poses.
- Rust:
  - The cursor-emit throttle and its visibility gating, as a unit test on the pure part.
  - `cargo fmt`, `cargo clippy -D warnings` and `cargo test` pass.
- Not checkable headless, so the owner checks in the installed app: the real notch hover,
  drag-and-drop onto the notch, and the feel of the motion.

## Amendment: one collapsed view, the wing (2026-10-02)

Owner, 2026-10-02, with a screenshot of the collapsed notch (myco perched under the notch's left
corner over the app below, and a separate `● 3` pill under the cutout): "여기 지금 뷰가 2개라서
불편한데, 마스코트 캐릭터 옆에 숫자를 붙이는거는 어때? 그리고 마스코트는 해당 노치 왼쪽에 있게끔".

This replaces the collapsed half of decision 1 (the perch under the notch's leading corner) and,
while the mascot is on, where the waiting mark is drawn. Everything else stands.

### Decisions

1. **Collapsed is one view: a wing.** It is a black shape joined to the left edge of the hardware
   cutout. It is the cutout's height and flush with it, square at the screen edge, and its outer
   bottom-left corner is rounded at the cutout's own radius (`--r-notch`). Its black runs one corner
   radius under the hardware, which fills the cutout's rounded bottom-left corner, so the wing and
   the notch read as one continuous shape.
2. **The wing holds myco and the count.** Myco is a 26 px box (the character is about 22 px),
   vertically centred, with its face and cap whole and never under the cutout. Beside it is the
   waiting count: the same number `markCount` gives, the same accessible name (`notch_waiting`),
   and its tone carried by the number's colour (the live lavender, the only tone the collapsed
   count has). With nothing waiting the wing holds myco alone.
3. **The wing is as narrow as what it holds**, because it covers the end of the frontmost app's
   menu bar. `notchWingWidth` in `NotchPanel.tsx` is the one source: a 7 px inset, 26 px of myco and
   4 px before the cutout make 37 px alone. A count adds a 2 px gap, a 7 px slot per digit and 5 px
   before the cutout: 47 px for 1 to 9, 54 px for 10 to 99. `styles.css` and `notch.rs`
   (`NOTCH_WING_PX`) mirror it, and tests pin both.
4. **The lip pill is not drawn while the mascot is on.** With the mascot setting off, today's surface
   comes back unchanged: the 14 px strip under the cutout, the lit dot and the count.
5. **Notchless Macs (the pill)** get one pill: myco with the count beside it, with no dot and no
   ground of its own. The pill's size is unchanged.
6. **Hover and proximity** on the wing open the peek exactly like the cutout. The open card's myco is
   the same element sliding out of the wing, so there is no second mascot at any frame and no jump.
   Folding snaps it back into the wing in the frame the card folds.
7. **Motion** runs in the wing as it ran on the perch: breathing, blinks, the doze clip and the wake
   that follows. Reduced motion shows the still pose.

### Window and hit-test

- With the mascot on, the collapsed window is exactly the wing plus the cutout:
  `(notch_w + wing) × notch_h` (`notchCollapsedFrame`). Nothing hangs below the notch any more, so
  nothing covers the app below, and the only menu bar the window covers is the wing's.
- `frame_x` (notch.rs) places a window no taller than the cutout so it ends at the cutout's right
  edge, which makes its left part the wing. Every taller window stays notch-centred, as before. The
  page follows the same rule: `@media (max-height: 100px)` sets the surface flush right, and in a
  taller window the collapsed box's negative margin keeps the cutout part centred. The switch lands
  in the same layout as the OS resize, so the two-phase open and fold (window first, then card)
  never moves the wing on screen.
- `opening_rect` (notch.rs) is the cutout widened left by the wing the collapsed surface draws. The
  driver sends that wing with every `notch_resize`, open ones too, so the wing a folding card leaves
  behind opens the peek before the window has shrunk.
- The collapsed wing is never wider than its window. A count or a setting that changes while
  collapsed re-fits the window at once (`collapsedFitDelay`); only a fold waits `NOTCH_FOLD_MS` for
  the card, and a re-show waits as long because notch.rs shows the window after telling the webview.
  A re-shown window keeps the last wing the driver sent (`shown_wing`), so the retained webview's
  count fits it from the first frame.
- Unchanged: the non-activating NSPanel, key focus only for the capture input, the hover
  hysteresis and the cursor feed.

### Acceptance

- vitest: `notchWingWidth` (widths, and myco and the count clear of the cutout);
  `notchCollapsedFrame`; the collapsed markup (one wing, the count beside myco with no dot, mascot
  off back to today's mark, the pill, one myco in the open card); the stylesheet pins (the wing box,
  myco's and the count's px, the margin transition, the short-window media query); `NOTCH_WING_PX`
  in notch.rs.
- Rust: `frame_x` (short windows end at the cutout, taller ones are centred, multi-screen offsets)
  and `opening_rect` (the wing opens the peek, nothing beside or below it does); `cargo fmt`,
  `clippy -D warnings`, `cargo test`.
- Browser (`?window=notch&notchMock=1`, `&notchWaiting=N` for a count; `?mock=1&window=notch` for
  the real driver): 2× screenshots, looked at, of every collapsed state (no count, one and two
  digits, the pill with and without a count, mascot off) and of the expand and collapse transition,
  in ko and en. `scripts/notch-agenda-smoke.mjs` checks the wing.
- Not checkable headless, so the owner checks in the installed app: the wing against the real
  cutout's corners, the frame during a WKWebView resize, and that clicks just left of the wing
  still reach the frontmost app's menu.

## Second amendment: the notch keeps its own size (2026-10-02)

Owner, 2026-10-02, after the wing shipped: "아니 내 말은 지금 노치 크기는 맥북 노치 그대로 하고 왼쪽에 나오게끔
하라고 노치 안에 넣지 말고 이러면 노치가 너무 커보여". A black wing joined to the cutout reads as a notch
grown wider.

This replaces the wing's ground (decision 1 of the amendment above) and the count's tone (part of its
decision 2). The window, the widths' purpose, the hit-test and the motion all stand.

1. **The collapsed surface paints no ground.** The notch is the hardware cutout alone, at its own size.
   Myco and the count stand on the menu bar just left of it, with the same gap to the cutout as before
   (4 px with myco alone, 5 px after a count). No black runs under the hardware.
2. **The count is a badge.** On the bare menu bar a lavender number vanishes on a light bar, and dark
   ink vanishes on a dark one. So the count is a small pill with a lavender (`#cdbdfb`) ground and dark
   ink (`#1a1325`), with 3 px of padding a side. That padding is `NOTCH_WING.badge` in
   `notchWingWidth`, which makes 53 px for 1 to 9 waiting and 60 px for 10 to 99. Myco alone is still
   37 px, so `NOTCH_WING_PX` in notch.rs is unchanged.
3. **The pill on notchless Macs is unchanged.** It has its own black ground, so its count stays a
   lavender number.

Acceptance: vitest pins the ground (none), the badge's colours and padding, and the new widths.
`scripts/notch-agenda-smoke.mjs` checks the 53 px wing. 2× screenshots of no count, one digit and two
digits on a light and a dark menu bar were looked at. The owner checks the real menu bar in the
installed app.

## Third amendment: center the count (2026-10-04)

The count uses centered inline-flex layout and a 15 px minimum width. A single
digit is 15×15 px; longer counts expand without clipping. Horizontal padding is
4 px per side, mirrored by `NOTCH_WING.badge = 8`. The waiting wing is now 55 px
for one digit and 62 px for two; the idle 37 px wing and hardware cutout remain
unchanged. Sidebar badges use a separate 20×20 px minimum contract.

Vitest and the synthetic notch/mascot browser checks cover count geometry and
cutout clearance. Native menu-bar placement and WKWebView resizing still need
their own hardware check; these browser results do not certify them.

## Owner correction: remove the collapsed attachment (2026-10-04)

The owner explicitly requested deletion of the menu-bar mushroom and number,
including the supplied one-count screenshot. Centering the badge did not satisfy
that request. The collapsed notch now paints nothing, including when decisions
are waiting, the mascot is enabled, or the Mac has no physical notch.

- Mount `NotchMascot` only inside an open panel; never render a collapsed count
  or status cap. Existing expanded capture, recording, agenda, and outcome states
  remain available.
- Remove the wing layout, width helpers, native wing persistence, and resize IPC
  parameter. Initially shown and re-shown native windows use `notch_w ×
  (notch_h + 14)` for the transparent drop target; the hover-opening target stays
  within the hardware cutout. Notchless input targets stay transparent.
- Keep the existing separate roaming feature, its ground shadow, and motion
  controls. Its origin follows the cutout rather than a deleted wing. Returning
  characters disappear into the cutout; the preview must not repaint an idle
  attachment.
- Cover zero, one, two, and large waiting counts with the mascot on and off,
  notched and notchless surfaces, initial/re-shown native geometry, and expanded
  agenda/capture regressions. Preserve scoped action acknowledgements and vault
  boundary tests.
