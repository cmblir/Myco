# Mascot roam: myco leaves the notch while work runs

Owner, 2026-10-02, with a screenshot of the harvest queue running ("실행 중 — 20개 중 11개 완료") and
"모두 수락 (58)": "내가 이거 모두 눌렀는데 myco가 가만히 있어 노치에서 뿅 하고 나와서 내 화면을 돌아다니면서
모션들을 보여주면 좋겠어. 완료할 때는 다시 노치로 들어가고".

This extends `2026-10-02-notch-mascot.md` and `2026-10-02-mascot-motion-library.md`. The character
rules there (one character, the committed poses and clips, nothing redesigned) all hold.

## Decisions

1. **When it roams.**
   - Long-running work triggers it: any job the notch reports as running (ingest, including a
     harvest batch; a distill run; Reflect; a batch of link accepts; saving) that is still running
     2 s after it started.
   - One roam at a time. A second job joins the roam already out.
2. **Out of the notch.** myco pops out of the collapsed notch: a squash-and-stretch drop from the
   notch's left edge, where it sits today. It does not appear somewhere else. In the same frame the
   notch's own myco hides, so there is never a second myco.
3. **The roam window.**
   - It is a borderless, transparent, non-activating, always-on-top NSPanel over the visible frame
     of the notch's screen.
   - It ignores all mouse events. It never takes focus and never takes a click from the app below.
   - It exists, or is ordered in, only while roaming. When hidden there is no rAF, no timers and no
     pointer feed.
4. **How it moves.**
   - It hops between waypoints with squash-and-stretch arcs, using the existing spring engine, at
     about 64 px.
   - It pauses at each stop to play a motion from the library that fits the job: `read-loop` while
     reading or ingesting, `think` while saving or reflecting, and `look-around` and idle breathing
     between.
   - Waypoints stay out of the menu bar. They favour the lower part and the sides of the screen, and
     each is at least 200 px from the pointer. When the pointer comes within 120 px, myco hops away.
     The existing ≤ 30 Hz pointer feed drives this.
   - The planner is a pure, seeded function that is unit-tested.
5. **Progress.** When the job reports steps ("20개 중 11개"), a small bubble beside myco shows
   "11/20". It is `aria-hidden`; the notch text stays the accessible status.
6. **Back into the notch.**
   - On completion myco hops back to the notch's left edge and dives in. The notch's myco reappears
     in that frame and plays the done celebration.
   - On failure it plays `worried` (or `shake-no`) at its stop, then goes back, and the notch shows
     the failure.
   - The roam window then orders out.
7. **Off switches.**
   - A setting, "작업하는 동안 화면을 돌아다니기" (en and ja too), is on by default because the owner
     asked for it.
   - `prefers-reduced-motion`: no roaming. myco stays in the notch.
   - With `mascotEnabled` off there is no roaming either.
   - When the frontmost app is full screen, myco stays in the notch.
8. **Assets.** The existing clips and poses are used, plus procedural hops. A dedicated walk or hop
   clip (krea) is optional and not in this slice.

## Invariants

- Nothing about the notch's hit-test, focus or hover rules changes.
- The roam window never covers the menu bar and never receives input.
- The budget and lazy-load rules of the motion library hold, and nothing is added to the initial JS
  chunk.

## Acceptance

- **vitest:**
  - the planner: bounds, the menu bar excluded, distance from the pointer, flee, determinism;
  - trigger rules: the 2 s delay, one roam, a join, back on done and on failure;
  - every off switch;
  - the clip picked per job kind.
- **Rust:**
  - the roam window config (ignores mouse events, non-activating, level, frame = the visible frame
    of the notch's screen);
  - show and hide gating as a pure, unit-tested part;
  - `cargo fmt`, `clippy -D warnings` and `cargo test` pass.
- **Browser:** a preview (`?window=roam&roamMock=1`, with a frame parameter for deterministic shots)
  is shot at 2× and looked at:
  - the pop out of the notch, a stop with each clip, a hop mid-air, the progress bubble, and the
    dive back;
  - ko and en, with reduced motion still.
- **Not checkable headless, so the owner checks in the installed app:** the real panel over other
  apps, click-through, multi-display, and the feel.

## Amendment: everyday wandering and a soft way home (2026-10-03)

Owner, 2026-10-03, with a screenshot of myco and the "2" badge beside the notch: "마스코트 myco가
나오는거는 여기서 나와서 평상시에 돌아다니는거야. 지금처럼 나오는 것도 유지해주고 근데 너무 확 노치로 사라져서 이상한데
이것도 krea.ai로 들어가는 자연스러운 모션도 만들어줘".

1. **Everyday wandering.** myco also leaves the notch's wing when no work runs.
   - It goes out every few minutes: a seeded interval of 3–8 min.
   - Each trip is a short walk of 15–40 s with 2–4 stops, then it returns.
   - It leaves from the wing beside the count, exactly where it sits.
   - A job that starts during a walk turns that walk into the job roam, with no second exit.
   - It never goes out while the notch is open, the pointer is over the notch, a full-screen app is
     in front, the screen is locked or asleep, or any off switch is set.
   - The same setting governs both kinds of trip. Its hint says myco also wanders now and then.
2. **A soft way home.** myco no longer vanishes into the notch in one frame.
   - It hops to the wing's spot, lands, and plays an "enter" clip that sinks or slides it back into
     its seat.
   - The wing's own myco takes over on the clip's last frame, in the same pose, so there is no jump.
   - The clip is made with krea.ai from the committed poses and keyed like the rest
     (`app/scripts/mascot-key-clip.py`): a notch strip and app videos.
   - Until the clip ships, a procedural squash and shrink of 300–450 ms replaces the snap.
3. Tests cover the idle scheduler (interval, duration, every veto, a job taking over a walk, one myco
   at any frame) and the hand-over frame.

## Amendment: a bouncy hop (2026-10-04)

Owner, 2026-10-04: "지금 화면 돌아다니면서 뛰는 모션이 약간 어색한데 뛰는 모션도 만들어줘 콩콩 점프하는 듯한".

Krea has no compute left (it resets Nov 1), so the hop is procedural for now. Its clip slot (`hop`)
is wired the way `enter` is, so a krea clip can replace it later with no code change.

1. **Travel is a run of small bounces, not one leap.** Between two stops, myco covers the distance
   in small hops, "콩콩".
   - Each hop is 40–70 px and roughly 260–340 ms.
   - The count comes from the distance: at least 2 hops and at most 8.
2. **Each hop is cartoon-sprung.**
   - **Anticipation:** a squash of about 0.8 high by 1.15 wide for about 60 ms.
   - **Takeoff:** a stretch of about 1.15 high by 0.9 wide.
   - **Apex:** neutral, with a slight cap lag (secondary motion: the cap trails the body by a few
     degrees).
   - **Landing:** a squash of about 0.82 by 1.12, then a spring back.
   - Easing is parabolic in y and linear in x per hop.
   - The last landing settles with one small rebound.
3. **Readable and calm.**
   - Hops lean slightly into the direction of travel, by no more than 6°.
   - The eyes stay on the face.
   - The shadow, if drawn, shrinks at the apex.
   - Reduced motion still slides with no bounce.
4. **Tests.** The hop count follows from the distance, every frame stays on screen, and the
   squash/stretch keeps the volume roughly constant (sx·sy between 0.85 and 1.15). The last frame
   lands exactly on the waypoint.
5. **Long legs, and the time they take** (added after review, 2026-10-04; owner to confirm).
   - A leg longer than 8 × 70 px goes in the fewest equal runs that fit. Each run is 2–8 hops of
     40–70 px and settles before the next run sets out. Under 80 px, two hops win over 40 px.
   - Small hops cover about 200 px/s, so crossing the screen takes several seconds. An everyday walk
     heads home once its time is spent, even with stops left. The notch waits 20 s, not 10, before
     it calls myco back.
   - A run cut short (work ends, or the pointer comes near) lands and settles before myco turns.
     Every landing checks the pointer, not only the stops.
