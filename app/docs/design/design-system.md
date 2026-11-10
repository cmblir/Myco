# myco Design System

This guide describes the current desktop interface and the rules for extending it.
myco is a personal knowledge workspace: capture a source, organize a note, and find
the evidence again. The interface should make those actions clear while preserving
the owner's original mushroom character.

Reviewed on 2026-10-04. **Current** means present in the linked source; **target**
means a requirement for subsequent work, not a claim that every existing surface
passes it. Browser checks use synthetic IPC data, not a native vault.

## Source of truth

| Area | Canonical implementation |
| --- | --- |
| Theme, type, shell, legacy surfaces | [styles.css](../../src/styles.css) |
| Shared controls and page frame | [ui.css](../../src/styles/ui.css), [ui components](../../src/components/ui/index.ts), [AppPage](../../src/components/AppPage.tsx), [Rail](../../src/components/Rail.tsx) |
| Sidebar brand | [Sidebar](../../src/components/Sidebar.tsx), [sidebar-brand.css](../../src/styles/sidebar-brand.css) |
| Everyday Home | [everyday.css](../../src/styles/everyday.css) |
| Character identity and pose grammar | [mascot assets](../../src/assets/mascot/README.md), [portable brand motion](../../public/brand-motion/README.md) |
| Roaming and floor shadow | [RoamWindow](../../src/components/RoamWindow.tsx), [roamMotion](../../src/lib/roamMotion.ts) |
| Knowledge graph | [Graph visual rules](graph-visual-rules.md) |

`main.tsx` loads `ui.css` after `styles.css`. Component styles should use a scoped
selector and existing tokens. New UI work should reuse the kit; this guide does
not authorize a broad migration of remaining legacy classes.

## Product hierarchy

**Current:** Home places Ask or capture, Add something, Write a note, and Recent
notes before the folded management area. Sidebar groups distinguish workspace
routes, personal notes, and material managed by myco. Settings is a separate
header action. Graph is an optional exploration surface with its own visual rules.

**Target:** each page has one clear title and a primary next action. Source text,
user writing, extracted evidence, and suggestions must retain their identity.
Keep maintenance counts, provider details, and advanced controls in their relevant
management surfaces. An ordinary reading or capture task should not require the
graph, an animated character, or a model configuration decision.

Use this order when composing a page: title and orientation, primary content or
input, actions, then supporting metadata. An error and its recovery belong next
to the operation that failed. A status badge never replaces the actionable row.

## Theme tokens

Values below are the current CSS defaults; all hexadecimal values are sRGB.
Choose a token by its role rather than copying a color into a new component.

| Token | Light | Dark | Intended use |
| --- | --- | --- | --- |
| `--bg` | `#ffffff` | `#191919` | Main canvas |
| `--bg-elev` | `#fbfbfa` | `#202020` | Raised reading or control surface |
| `--bg-soft` | `#f7f6f3` | `#252525` | Sidebar and quiet bands |
| `--bg-hover` | `#efeeec` | `#2c2c2c` | Pointer hover |
| `--bg-active` | `#e9e8e4` | `#353535` | Pressed or selected surface |
| `--bg-inverse` | `#181715` | `#ededec` | Inverse surface |
| `--line` | `#e9e8e4` | `#2c2c2c` | Ordinary divider |
| `--line-strong` | `#dad9d4` | `#3a3a3a` | Control boundary |
| `--line-soft` | `#f0efeb` | `#232323` | Quiet grouping |
| `--ink` | `#181715` | `#ededec` | Primary readable text |
| `--ink-2` | `#37352f` | `#d4d4d2` | Secondary readable text |
| `--ink-3` | `#62615c` | `#b1b0aa` | Supporting copy |
| `--ink-4` | `#696862` | `#a3a29c` | Readable secondary metadata |
| `--ink-5` | `#cfcdc5` | `#4a4a48` | Very faint visual detail |
| `--accent` | `#181715` | `#ededec` | Neutral emphasis and focus |
| `--accent-soft` | `#ebe9e3` | `#2c2c2c` | Neutral selection ground |
| `--accent-ink` | `#ffffff` | `#181715` | Text on accent |

There are two existing semantic families. Do not silently substitute one for the
other: base status tokens serve general UI, while the renewal palette serves
activity, chips, and the dark primary control treatment.

| Role | Base token light / dark | Renewal token light / dark |
| --- | --- | --- |
| Positive result | `--positive: #217346 / #9dd7b1` | `--ok: #16a34a / #7ee0a6` |
| Review or warning | `--warning: #94631e / #e6c18e` | `--warn: #9a6a1f / #e0a458` |
| Error or danger | `--danger: #dc2626 / #f87171` | Uses the base danger token |
| Active work | No separate base token | `--live: #7e22ce / #a78bfa` |

Dark kit primary buttons use `--live` with `#120c22` text; light primary buttons
use `--ink` with `--bg` text. Labels remain explicit in either theme. Status color
is supplementary: include a word, count, or meaningful glyph. In light Home
Reflect, readable status text stays in `--ink`; only the glyph carries result color.

Knowledge type tokens currently map overview/source/entity/concept/technique/
analysis to `#1f6feb`, `#ad6800`, `#16a34a`, `#7e22ce`, `#dc2626`, and `#0891b2`.
Graph skins and community encodings are governed by the graph guide, not by a
new global recoloring of those tokens.

## Typography and spacing

| Token | Size | Current example |
| --- | --- | --- |
| `--fs-11` | 11px | Eyebrow, count, chip |
| `--fs-12-5` | 12.5px | Kit control, toolbar, short note |
| `--fs-14` | 14px | Default UI copy and hero description |
| `--fs-17` | 17px | Sidebar wordmark and larger supporting text |
| `--fs-22` | 22px | Shared page title |
| `--fs-30` | 30px | Shared hero title |
| `--fs-42` | 42px | Large figure or legacy page title |

The sans stack starts with Inter and system fonts, then Pretendard Variable and
Noto Sans JP/KR. Serif starts with EB Garamond, Iowan Old Style, and Georgia.
Monospace starts with JetBrains Mono, ui-monospace, and SF Mono. Reuse the declared
stacks; installing a new font is not required to implement this guide.

Body line-height is 1.55. Shared page titles use 1.2 and weight 650; hero titles
use 1.2 and weight 600. Everyday Home has an intentional responsive hero title
`clamp(1.55rem, 3.6cqi, 2.3rem)`, with line-height 1.3. Metadata must remain
readable when localized; do not force long names into fixed-width count pills.

Current recurring gaps are 4, 8, 12, 16, 20, 24, and 32px, with 6px used in
compact controls. These are existing patterns, not a complete spacing-token API.
Prefer `rem`, flexible columns, and `clamp()` when extending them. Use `min-width: 0`
for shrinkable content, and wrap paths or long source names where they must be read.

Corner tokens are `--r-sm: 6px`, `--r-md: 10px`, `--r-lg: 16px`, and
`--r-pill: 999px`. Use small corners for rows, medium for controls and menus,
large for rails and major surfaces, and pills for compact facts or suggestions.

## Surfaces and elevation

Reading chrome is flat: a canvas, a quiet sidebar, thin dividers, and a clear
selected row. Raised menus use `--shadow-pop`; ordinary content does not need
the same shadow as a transient overlay.

| Token | Light | Dark |
| --- | --- | --- |
| `--shadow-1` | `0 1px 0 rgba(15,15,15,.05)` | `0 1px 0 rgba(0,0,0,.4)` |
| `--shadow-2` | `0 8px 24px rgba(15,15,15,.08), 0 1px 0 rgba(15,15,15,.06)` | `0 8px 24px rgba(0,0,0,.5)` |
| `--shadow-pop` | `0 12px 40px rgba(15,15,15,.12), 0 1px 0 rgba(15,15,15,.08)` | `0 12px 40px rgba(0,0,0,.6)` |

Renewal tiles use `--glass`, a vertical translucent gradient: light ink at 4% to
1.5%, or dark white at 4.5% to 2%. `--glass-line` is the corresponding 8% boundary;
`--glass-hi` is an inset top highlight. This material does not require backdrop
blur. Use a single restrained radial glow on a major activity surface rather
than placing glows behind every card.

## Sidebar brand and navigation

The canonical [logo.png](../../src/assets/logo.png) remains unchanged: its rounded
app-icon frame is part of the supplied asset. Do not crop away the frame, redraw
the character, substitute an emoji, or recolor it to match a theme.

The header displays `MycoMark` at 32×32px beside lowercase `myco` in the existing
sans face, 17px, weight 600, with an 8px gap. The icon contains inset character
artwork, so a 24px image made the character disproportionately small beside its
name. The new lockup increases the image box while keeping its original proportions.

Home has a natural-width hover surface and a minimum 44×44px target. Settings is
a separate 44×44px target at the row's right edge. Both receive a 2px visible
keyboard focus outline. Home's accessible name is the localized destination;
its decorative logo is hidden from assistive technology to avoid “myco myco”.

Navigation counts use tabular numerals and a centered minimum 20×20px badge;
long counts expand horizontally. Filled and alert treatments retain their
different meanings. A badge is a fact within an actionable row, not another
tiny button. Selection uses both a surface change and text emphasis.

## Shared components

| Component | Current contract | Use |
| --- | --- | --- |
| `Button` | `primary`, `ghost`, `quiet`; defaults to `type="button"`; 32px base height | One primary action, ordinary action, repeated secondary action |
| `IconButton` | Required `aria-label`; ref forwarding; 32×32px base | Labelled compact utility action |
| `Segment` | Labelled group, `aria-pressed`, one tab stop, arrows/Home/End | Mutually exclusive view choice |
| `Chip` | Required label, optional mono value and tone; encode status in the label | Status, count, short identifier; not a clickable control |
| `Check` | Native labelled checkbox, disabled state | Boolean preference or selection |
| `Sheet` | Dialog, focus management, keyboard-aware frame, 44px rows | Phone or coarse-pointer menu |
| `AppPage` | Title, tools, bar, note, optional rails; wide variant | Consistent route frame |
| `Rail`, `RailGroup` | Scrollable list; native collapse button with `aria-expanded` | Supporting lists and reference panels |
| `RailRow` | Native button or noninteractive row; separate label/actions when needed | Avoid nested buttons and hover-only access |
| `Hero` | Asset, title, optional lede/figure/action; caller labels or hides the asset appropriately | Major entry or processing surface |
| `NoticeStack` | Persistent polite live region; focus/hover pauses dismissal | Results and recovery, not continuous progress |
| `SettingsCard` | Registry identity, search filtering, optional current value | Discoverable preferences |

Use existing SVG `Icon` glyphs for utility rows. Do not put a character on every
button. The kit's compact desktop dimensions are current defaults, not universal
touch compliance: sidebar rows, segments, sheets, and everyday actions have
larger rules, but every new touch action still needs its own target check.

## State and evidence contracts

| State | Required presentation and behavior |
| --- | --- |
| Idle | Clear action, prerequisites, and any saved choice |
| Loading | Visible operation label; progress from real counts when available; cancellation only where supported |
| Empty | Explain the absence and offer the relevant capture, import, search, or reset action |
| Error | Keep useful input, show the cause safely, and provide a scoped retry or recovery |
| Success | Announce the actual result; link to the created or changed material |
| Partial or held | Show completed and pending work separately; preserve the resumable action |

These are extension requirements. Do not assume every legacy page implements
all states just because it uses a shared component. Hover, active, focus,
selected, and disabled are also distinct control states. Kit buttons reduce
disabled opacity to .45; a disabled appearance alone does not explain a missing
prerequisite, so place the explanation nearby.

For knowledge work, a copied source is not a completed harvest, a proposal is not
a recorded decision, and an evidence quote is not a generated conclusion. Keep
source path, date scope, and citations available from recall results. Preserve
unprocessed coverage and visible uncertainty instead of celebrating partial work
as complete. User edits and original raw sources retain their ownership.

**Current:** while the selected vault's initial inventory is still opening,
Sidebar marks its tree busy and withholds previous rows; the status disclosure
shows loading for inventory and index counts. Zero and empty labels appear only
after preparation completes. The existing disclosure remains mounted and keeps
its open/closed state. An unresolved filesystem read is not an empty result.

## Responsive layout

| Current rule | Behavior |
| --- | --- |
| `--side-w: 15rem`, `--top-h: 44px` | Desktop sidebar width and topbar height |
| Reading workspace | Maximum 1100px, horizontal gutter `clamp(16px, 5vw, 80px)` |
| Wide workspace | 40px horizontal gutter; rails default to 248px |
| Two rails at ≤1240px | Right rail moves beneath the main stage |
| Shared page at ≤820px | Rails stack; wide stage retains a minimum 62vh |
| At ≤768px | Sidebar becomes an overlay, width `min(82vw, var(--side-w))`; page gutters become 16px |
| At ≤768px or coarse pointer | Several navigation/control families grow to 44px; sheets use touch rows |
| Coarse pointer | Form fields use 1rem text; hover-only hints disappear where appropriate |

Use content and container width to decide when a card's actions wrap; Home's hero
already uses container queries. Preserve safe-area insets and `dvh` in the phone
shell. A soft keyboard must not hide sheet recovery actions. Inspect 320px as a
floor and 375px as the normal narrow review width, plus 768 and 1280px.

These responsive rules are browser layout support. They are not evidence of an
installed iPhone build, mobile account permissions, or native platform certification.

## Accessibility requirements

Use semantic buttons, labels, headings, and native inputs; localize visible and
accessible strings through `STRINGS`. Format user dates and numbers with the
appropriate `Intl` formatter. Keep destructive actions distinct and explicit.

The project target is at least 44×44 CSS px for touch actions. This aligns with
[WCAG's enhanced target-size criterion](https://www.w3.org/WAI/WCAG22/Understanding/target-size-enhanced.html);
WCAG 2.2 AA's [minimum criterion](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html)
has different 24px and spacing rules. Do not describe the project's 44px target
as the universal AA threshold.

Target at least 4.5:1 for ordinary readable text and 3:1 for qualifying large
text, following [WCAG contrast guidance](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html).
Measure the final composited background, including selected and dimmed states.
The supporting `--ink-3` and `--ink-4` tokens meet 4.5:1 on the five opaque neutral
surfaces, including hover and active, in both themes. Opacity and composited
backgrounds still need rendered checks. `--ink-5` is a decorative token, not a
readable small-text color.

Keep focus visible and unclipped. Keyboard users must reach row actions without
hover; dialogs should restore a useful focus position. Route focus should not
steal from an input or an active dialog. Announce results once in a stable live
region; decorative mascot motion remains `aria-hidden` with readable adjacent text.

## Mascot and motion grammar

Preserve the charcoal-purple domed cap, lavender underside, short rounded body,
white oval eyes, and small orb hands. The character has no mouth, added limbs,
or text. The original app/Dock icon remains the canonical brand asset. Existing
black/white 3D appearance previews are separate assets, not replacements for it.

Reading means ready; thinking means actual work; success means a confirmed
result; attention means review or recovery; resting means idle or cancellation.
Do not use movement as a fabricated percent-complete indicator. One character
represents a task surface; repeated utility rows use ordinary icons.

The Sidebar brand is static. `MascotClip` owns video/poster fallback, visibility
gating, and reduced-motion behavior. `MycoMotion` uses lightweight CSS and a
same-size static fallback when the mascot is disabled. Its CSS respects reduced
motion; do not assume it has the clip player's visibility scheduler.

The collapsed notch paints nothing: no mascot, waiting count, status dot, or
notchless pill background. Waiting decisions belong in the expanded peek.
The invisible input target stays cutout-wide and preserves drop, hover, and
capture; it must not extend over neighboring menu-bar controls. The mascot
preference affects the expanded panel and other established character surfaces,
and must not restore a persistent collapsed attachment.

Roaming's floor shadow follows the existing motion frame and projected ground
position: a 36×8px radial gradient, smaller and fainter at a hop apex, fading on
return. It uses no blur or second animation loop. The floating character inside
the graph is a different scene; do not add a ground shadow to a floating planet.

Current global timings are `--dur-quick: 140ms` and `--dur-enter: 320ms`;
`--ease-out: cubic-bezier(.2,0,0,1)` and
`--ease-spring: cubic-bezier(.2,.9,.3,1.2)`. Prefer short transform/opacity changes,
one-shot arrival or confirmation, and a still reduced-motion path. Continuous
roaming, clips, and graph work must honor their own user and visibility controls.

## Performance and verification

Intel Macs with 8GB RAM are a minimum design target, not a measured guarantee in
this guide. Keep the bundled approximately 42MB embedding model and avoid adding
a model or a heavy animation dependency for UI decoration. See the separate
[local model research](../research/2026-10-04-local-model-improvement.md) for model
provenance and measured-baseline references.

The existing asset guide budgets notch strips at 1.6MB and app clips at 4MB.
Preserve static and decode-error fallbacks. Load advanced 3D surfaces only when
needed, stop offscreen work in its owning subsystem, and measure changes rather
than claiming that a small asset proves low CPU or memory use.

For each changed surface, review light/dark, keyboard-only operation, narrow and
wide screens, idle/loading/empty/error/success, partial results where applicable,
long translated labels, reduced motion, and touch targets. VoiceOver and iPhone
WKWebView need separate native checks; a Chromium screenshot does not validate them.

The Sidebar change has synthetic Chromium checks at 320/375/768/1280px in both
themes: the Home surface measures 94.5×44px with the current English font stack,
its image box is 32px, Settings is 44×44px, and keyboard Home/Settings transitions
and visible focus pass. These dimensions are an observed fixture result, not a
fixed width contract for every font or translation.
The same smoke also checks a 375px coarse-pointer context with normal motion.

Run `node scripts/sidebar-brand-smoke.mjs` against a loopback development server
and `npx vitest run src/components/Sidebar.test.ts` from `app/`. The smoke test
requires mock IPC, blocks external requests, and never opens a native vault.
