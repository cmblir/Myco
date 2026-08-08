# Dashboard redesign: a vault that visibly lives

Date: 2026-08-08
Status: approved, not yet implemented

## Problem

The Overview page is a landing page wearing a dashboard's name.

- The top ~380px of the fold is product copy (`ov_eyebrow`, `ov_title`,
  `ov_lede`) explaining what myco is. Someone opening this screen already uses
  myco. The first thing they see every day carries no information about their
  own vault.
- The "recent" section reads git. The real vault
  (`/Users/o/Documents/Memex`) is not a git repository — 0 commits — so that
  section renders `No git history yet.` permanently. Its "more →" link routes
  to the History page, which reads `ingest-reports/`, not git: the link and
  the list it sits under show different data.
- Everything is a same-weight card in one vertical stack, 1333px tall against
  a 900px viewport.
- The app already has a motion vocabulary — 13 keyframes, 8 reduced-motion
  blocks, a continuously rendering graph — and the dashboard is the one
  surface that is completely static.

## Decisions

Settled with the user before design:

| Question | Decision |
|---|---|
| Scope | Overview page + app shell. Other pages unchanged. |
| Motion character | Ambient — moves on its own, not only on interaction. |
| Fold content | Vault status. |
| Trend source | File mtime, not git. |
| Git on the dashboard | Removed entirely. |
| Motion meaning | Driven by real data, not decorative. |
| Implementation | CSS only (DOM + `@keyframes`), no rAF loop. |
| Hero copy | Kept for an empty vault only. |
| Activity scope | Authored and ingested counted **separately**. |

### Why CSS over canvas

Canvas allows hundreds of particles. That is the argument against it here, not
for it. The data behind the motion is `59 pages / 153 links / 7 daily mtime
buckets` — a resolution that supports "few / some / many" and nothing finer.
Hundreds of particles would assert a precision the data does not have. Tens of
particles read honestly and CSS handles tens without waking JS every frame.
A second always-on rAF loop would also land on top of the graph's existing
first-load stutter.

### Why activity must exclude sessions

Measured in the real vault:

```
modified in last 7 days: sessions 1029, raw 6
modified in last 1 day:  sessions 1029
```

The auto-sweep rewrites every session file daily. An activity metric counting
them would read "1029 today" every day forever, and an ambient pulse driven by
it would sit pinned at maximum even if the user had not written for a month —
a screen that looks alive while saying nothing. So the two sources are counted
and shown separately, and they drive different motions:

| Data | Motion | Reads as |
|---|---|---|
| Authored | Pulse rate | The vault's heartbeat |
| Ingested | Particle inflow | Material arriving |
| Link count | Particle count | How woven together |

The split is by top-level folder, and the list is exhaustive rather than
open-ended, because "roughly the machine-written ones" is not implementable:

```
ingested = _inbox | sessions | raw | ingest-reports
authored = every other top-level folder, and root-level notes
```

`raw/` and `ingest-reports/` are on the ingested side even though
`index.rs:89 is_staging_dir` does not list them — that predicate answers a
different question (which folders the link graph skips). `raw/` is immutable
source material and `ingest-reports/` is generated per run; neither is
something the user wrote. `tasks.rs` already skips `raw`, `_inbox` and
`sessions` for the same reason, so this list extends an existing judgement
rather than inventing one.

A week of not writing shows as a slowing heartbeat while intake keeps
drifting. That is the true story, and the combined metric could not tell it.

## Layout

Three bands, replacing six stacked sections.

```
┌─────────────────────────────────────────────┐
│  Living vault  (in the fold, ~420px)        │
│    59        153        23                  │
│    pages     links      moved this week     │
│    ●──○──●──○──●   particles along links    │
│    ▁▃▇▂▅▁▃         7-day sparkline          │
│    [Ingest a source]  [Ask the wiki]        │
├─────────────────────────────────────────────┤
│  Pick up where you left off │ Recently moved│
│  ┌────┐┌────┐               │ self-attention│
│  │    ││    │               │ rlhf.md       │
│  └────┘└────┘               │ tokenization  │
├─────────────────────────────────────────────┤
│  Suggested links   (unchanged)              │
│  Reflect panel     (unchanged)              │
└─────────────────────────────────────────────┘
```

Changes:

- Hero copy renders only when the vault has 0 pages. The strings stay in
  `i18n.ts` — for an empty vault they are accurate and are the only thing
  worth showing.
- The git section is deleted and replaced by mtime-based "Recently moved
  notes". The mismatched "more →" link goes with it. Only the dashboard's
  `ipc.gitLog` call goes — `queryStore.ts` and `digests.ts` still use it, so
  the IPC binding and the Rust `git_log` command stay exactly as they are.
- "Pick up" and "Recently moved" sit side by side; two stacked sections become
  one band. Below 640px they stack again.
- File paths come off the cards. The card title already carries that.

Target: 1333px → roughly 950px. Not a promise — measured after implementation.

## Motion system

Today 13 keyframes each hardcode their own duration and easing; there are no
motion tokens. Introduce four, and derive all new motion from them:

```css
--dur-quick: 140ms;   /* hover, press */
--dur-enter: 320ms;   /* entrance */
--ease-out: cubic-bezier(0.2, 0, 0, 1);
--ease-spring: cubic-bezier(0.2, 0.9, 0.3, 1.2);
```

The ambient layer is driven by exactly three CSS custom properties, computed
from data:

| Property | Source | Range |
|---|---|---|
| `--vault-particles` | link count | 3–28, log-scaled |
| `--vault-pulse` | authored activity, 7d | 6s (idle) – 1.8s (busy) |
| `--vault-glow` | resolved-link ratio | opacity 0.15–0.5 |

Log-scaled because 153 links and 1530 links must not differ by 10x on screen,
and because the underlying signal is ordinal.

Only `transform` and `opacity` are animated — the two properties the
compositor handles off the main thread. Animating `box-shadow` or `width`
would force layout/paint every frame and is out of bounds here (the existing
`chip-breathe` animates `box-shadow`; it is left alone rather than rewritten,
since changing it is not part of this work).

## Components

Three new files, each with one job:

```
lib/vaultPulse.ts           pure: [path, mtime][] → day buckets + motion vars
components/VaultPulse.tsx   the ambient layer
components/RecentNotes.tsx  recently-moved list
```

`vaultPulse.ts` holds all the arithmetic and knows nothing about the DOM, so
there is one place to test:

```ts
bucketByDay(entries, days, now) → { authored: number[], ingested: number[] }
motionVars(links, authored, resolvedRatio) → { particles, pulseMs, glow }
```

`bucketByDay` buckets by LOCAL day, for the same reason `taskLine.today()`
does: a UTC boundary files a late-evening edit under the next day. `now` is a
parameter so tests can pin it.

### Data flow — no new backend code

`ipc.fileMtimes(root)` already returns `[path, mtime][]` for every markdown
file — it backs the graph timelapse, and it walks everything, including the
staging folders, which is what this needs. The frontend classifies each path
by its top-level folder (list above) and buckets by day. Nothing is added to
Rust.

Called once when the vault changes, alongside the existing `fileTree` /
`adjacency` reads. The dashboard does not poll.

## App shell

Almost no new motion — the tokens are applied so existing durations stop
disagreeing:

- Sidebar hover/active: `--dur-quick`, transform only.
- Route change: one layer of fade + 8px rise on entering content,
  `--dur-enter`.
- Existing `chip-breathe` / `agent-pulse`: switched to tokens, behaviour
  unchanged.

Route transitions stay short deliberately. Motion that replays on every click
reads as latency by the third time. Ambient motion earns its keep by running
in the background; transitions earn theirs by getting out of the way.

## Performance and accessibility

- `will-change` on the particle container only. Per-element `will-change`
  multiplies compositor layers.
- Particle count hard-capped at 28.
- `prefers-reduced-motion: reduce` sets `animation: none` on the ambient
  layer. Particles stay rendered but still — a frozen particle field still
  says "many links", so hiding it would remove information, not just motion.
- Background-tab throttling is left to the browser. CSS animations are
  throttled automatically; this is one of the reasons for choosing CSS.
- Verified at 375 / 768 / 1280, keyboard-only, and with a numeric label beside
  the sparkline so it does not encode meaning in colour alone.

### Measured

**`fileMtimes` walk cost.** Real vault, `/Users/o/Documents/Memex`, via a
throwaway `cargo run --release --example` calling `vault::file_mtimes`
directly:

```
1144 files in 5.217625ms
```

(1144, not the ~1125 estimated when this spec was written — the vault grew by
a handful of files in the meantime.) Two orders of magnitude under the ~100ms
budget. The deferral this section originally reserved — mounting `VaultPulse`
after the numbers instead of with them — is not needed; the walk is fast
enough to sit on the same tick as `fileTree` / `adjacency`, unchanged.

**Page height, 375 / 768 / 1280px.** The "1333px" figure quoted in Problem
was measured at 1280px width only — a height baseline is only meaningful at
the width it was taken at, so comparing a narrow-viewport new height against
that single wide-viewport number is not valid. The old dashboard was
re-measured at all three widths, in a git worktree checked out at
`345f0957` (the last commit before this redesign), same mock vault, same
900px-tall viewport, same `.workspace.scrollHeight`:

| Viewport | Old (`345f0957`) | New | Change | vs. ~950px target |
|---|---|---|---|---|
| 375 | 2065px | 1489px | −576px (−28%) | missed |
| 768 | 1505px | 1163px | −342px (−23%) | missed |
| 1280 | 1333px | 1088px | −245px (−18%) | missed |

The page got shorter at every width, and 375px improved the most, not the
least. The ~950px target was stated as "not a promise," and it was still not
met at any of the three widths — 1280px, the closest, sits 138px over it.
No width overflowed horizontally —
`document.documentElement.scrollWidth > window.innerWidth` was `false` at
375, 768, and 1280, old and new alike.

**Reduced motion.** Playwright with `reducedMotion: 'reduce'`: running
animations `document.getAnimations().filter(a => a.playState ===
'running').length` was `0`; `.vp-dot` count was `21`. Both requirements hold
— the ambient layer is fully stilled, and the particle field stays rendered,
so the "how linked" signal survives motion being turned off.

**Keyboard reachability.** Tabbing through the rendered dashboard at 1280px
(`mock=1`) landed on 40 consecutive `<button>` / `<select>` elements, each
carrying a visible `outline: auto 1px` ring (checked visually via
screenshot, not just computed style). In sequence this included both CTAs
(`소스 가져오기`, `위키에 질문`), both "이어서 보기" cards, and all 6 rows of
"최근 움직인 노트" — every row is a `<button class="list-row recent-row">`,
not a `div`, so all six take focus and show the ring.

## Testing

- `vaultPulse.test.ts`: day-bucket boundaries across local midnight, the
  authored/ingested split, empty vault, clamp limits at both ends.
- The existing i18n parity test catches any new string missing ko/ja.
- Playwright against mock mode for the rendered result, as with the calendar.

## Files touched

New:

```
src/lib/vaultPulse.ts            the arithmetic
src/lib/vaultPulse.test.ts       its tests
src/components/VaultPulse.tsx    ambient layer
src/components/RecentNotes.tsx   recently-moved list
```

Modified:

```
src/pages/PageOverview.tsx   largely rewritten
src/styles.css               motion tokens, ambient layer, two-column band
src/lib/i18n.ts              new strings across en/ko/ja
src/components/Sidebar.tsx   token substitution only
src/components/Topbar.tsx    token substitution only
src/App.tsx                  one fade layer on route change
```

Sidebar, Topbar and App.tsx are token substitution: hardcoded durations become
variables, no structural or behavioural change. The visible effect is that
hover timings stop disagreeing with each other. If that is unwanted, dropping
those three files leaves the rest of the design intact.

No Rust changes.

## Out of scope

- Other pages (graph, ask, settings…). Tokens land app-wide; visual redesign
  does not.
- The graph's first-load stutter. Separate, already flagged.
- Adding git to the vault.
