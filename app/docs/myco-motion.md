# myco motion library

Six CSS motions built from the existing, unmodified transparent mascot poster.
The original app logo is retained as the static fallback. There are no videos,
new dependencies, remote requests, or generated replacement brand assets.

## Preview and reuse

Run `npm run dev` from `app/` and open `/brand-motion/index.html`. The gallery
includes light and dark previews, replay buttons, a pause control, and a ZIP
download. You can also open `app/public/brand-motion/index.html` directly in a
browser; the gallery does not require a server.

Download `myco-motion-pack.zip`, extract it, and keep its files together. The
six individual HTML examples have transparent backgrounds and can be embedded
in websites or used as browser sources in presentation/recording tools:

```html
<iframe
  src="brand-motion/welcome.html"
  title="myco welcome"
  width="240"
  height="240"
  style="border: 0"
></iframe>
```

These are HTML/CSS assets, not rendered GIF, video, or Lottie files. Each example
uses the shared `myco-motion.css`, `example.css`, and `mascot.png` beside it.
Decorative examples have no controls inside the frame; the gallery provides
the accessible preview controls. Honor reduced motion in the host, and provide
a pause control when using a repeating motion alongside other content.

## React

```tsx
import MycoMotion from "./components/MycoMotion";

<MycoMotion variant="welcome" size={112} />
<MycoMotion variant="thinking" size={56} className="answer-mascot" />
```

| Prop        | Default | Description                                                 |
| ----------- | ------- | ----------------------------------------------------------- |
| `variant`   | `idle`  | `idle`, `welcome`, `thinking`, `saving`, `success`, `empty` |
| `size`      | `96`    | Square display size in CSS pixels                           |
| `className` | `""`    | Optional host layout class                                  |

The component imports its own stylesheet. It is decorative (`aria-hidden`) and
does not announce status; provide adjacent localized text or a live region
where the task needs one. A progress animation does not measure completion.
Do not trigger `success` until the underlying operation has actually succeeded.

The existing `mascotEnabled` setting replaces all motion with the original
static app mark without changing the allocated size. The CSS media query
responds immediately to changes in `prefers-reduced-motion`; all six states
remain legible as still images. `welcome` and `success` play once when mounted
and hold their final state. To intentionally replay the same React variant,
change its React `key` after a new user action.

## Motion vocabulary

| Variant    | Intended use                   | Behavior                                      |
| ---------- | ------------------------------ | --------------------------------------------- |
| `idle`     | Welcome area, quiet companion  | 2% vertical drift over 6 seconds              |
| `welcome`  | First visit, onboarding        | Gentle greeting and two brief sparks, once    |
| `thinking` | Finding or composing an answer | Three soft dots and a small 7-second tilt     |
| `saving`   | Saving an actual change        | Small indeterminate line over 2.4 seconds     |
| `success`  | Completed action               | One nod, brief sparks, persistent check badge |
| `empty`    | Empty list or first note       | Slow 4-degree glance over 8 seconds           |

Use one visible repeating character per task surface. Reserve the larger sizes
for welcome and empty states; 40–64 pixels is enough beside an active status.
The accent is customizable via `--myco-motion-accent`; image colors stay original.

## Plain HTML

Copy the markup from any of the six HTML examples and include
`myco-motion.css`. Set `data-variant` to choose a motion and
`style="--myco-motion-size: 8rem"` to change its size. Set
`data-paused="true"` on `.myco-motion` to pause all child animations.
`aria-hidden="true"` keeps this decorative artwork out of the reading order.

## Maintaining the portable pack

`src/styles/myco-motion.css` is the CSS source. After changing it, copy it to
`public/brand-motion/myco-motion.css` and rebuild the ZIP so the React and
standalone examples stay identical. Copy the original `src/assets/logo.png`
and `src/assets/mascot/idle.poster.png` byte for byte; do not redraw or retouch
them. The ZIP contains the gallery and all examples, styles, scripts, images,
and this usage guide, without any build artifacts or dependencies.
