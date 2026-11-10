# MYCO video motion kit

Fifteen reusable, silent video clips based on the supplied `myco_mov.mp4` and
`myco_base.png` character sheet. This is separate from the lightweight
[CSS motion component](myco-motion.md) already used in the app.

## Contents

| Motion     | Length    | Playback | Origin                                                     |
| ---------- | --------- | -------- | ---------------------------------------------------------- |
| Idle       | 8 seconds | Loop     | Edited source footage                                      |
| Welcome    | 4 seconds | Once     | Edited source footage                                      |
| Thinking   | 8 seconds | Loop     | Edited source footage                                      |
| Scan       | 8 seconds | Loop     | Edited source footage                                      |
| Success    | 4 seconds | Once     | Edited source footage                                      |
| Exit       | 4 seconds | Once     | Edited source footage                                      |
| Discovery  | 5 seconds | Once     | Reference-guided Seedance 2 Fast generation                |
| Reading    | 5 seconds | Once     | Original character footage + floating prop composite       |
| Sleepy     | 5 seconds | Once     | Reference-guided Seedance 2 Fast generation                |
| Linking    | 5 seconds | Once     | Original character footage + floating prop composite       |
| Planting   | 5 seconds | Once     | Original character footage + floating prop composite       |
| Inspecting | 5 seconds | Once     | Original character footage + floating magnifier and note   |
| Idea       | 5 seconds | Once     | Original character footage + animated violet bulb          |
| Greeting   | 5 seconds | Once     | Original footage with a small authored whole-character nod |
| Organizing | 5 seconds | Once     | Original character footage + three floating note cards     |

All delivery clips are 768 × 768 at 24 fps. The first six preserve the source's
actual frame-by-frame movement, with authored position, rotation, scale,
opacity, and vector accents. Looping versions play the source forward and
backward to join the endpoints. Reading, linking, and planting combine original handless character footage
with independently floating props. Linking and planting use the accepted reading
clip's exact character scale, position, and source timing; their props sit close
in front of the lower torso. Inspecting, idea, and organizing use the same framing and timing. Greeting adds a restrained whole-footage dip, tilt, and squash to suggest a nod; it preserves the original eyes and companion. These composites do not introduce newly generated character acting.
The earlier generated versions incorrectly added hands and were withdrawn.
MYCO has zero hands and zero arms; the existing right-side sphere is a companion,
not a hand. Discovery and sleepy are generated expression clips. Finite actions
are not guaranteed seamless loops.

The original green background and floor shadow are removed. Transparent edge
quality is limited by the compressed inputs. WebM and ProRes alpha are checked
by decoding every frame; Apple HEVC alpha is checked with AVFoundation.

## Use the exported folder

Open `index.html` in the delivered `myco-motion-kit` folder. The portable
gallery includes Korean labels, one active preview at a time, a pause control,
replay, three background choices, and file downloads. Reduced-motion preferences
pause playback; users can still deliberately play a selected clip. The four additional
actions appear first, with the previous eleven behind a disclosure. Closing that
section pauses any video playing inside it.

- `myco-video-web.zip`: WebM, Safari HEVC, MP4, posters, gallery, and guides.
- `myco-video-pack.zip`: The complete kit, including ProRes 4444 editor masters.
- `clips/`: Per-motion exports; `posters/`: transparent PNG stills.
- `manifest.json` and `verification.json`: provenance and measured output checks.
- `motion-prompts.md`: instructions for additional character actions.

The separate `myco-action-pack` folder contains seven composites: reading, linking, planting, inspecting, idea, greeting, and organizing. Higgsfield rejected the September 17 additional video request with `not_enough_credits`. The four additional actions were therefore completed locally using the original footage and authored props/transforms, without a new generation job or a purchase. All eleven previous delivery clips are preserved unchanged; `production/pre-expansion-hashes.json` records their hashes.

For full browser pixel inspection, serve the exported folder over HTTP.
Direct local-file previews can fall back to the opaque MP4 when browser security
prevents alpha inspection. See the [portable guide](../scripts/brand-video/gallery/README.md)
and [Korean guide](../scripts/brand-video/gallery/README.ko.md).

Keep large exports outside `app/public/`; the desktop build should include only
the specific small assets actually used by the product.

## Re-render the four additional actions

The additional renderer uses the same installed Node, Playwright, and FFmpeg as
the source renderer below. The source and note prop are included in the existing
full delivery folder. It exports four formats plus posters and writes provenance
to `production/additional-actions.json`; it never rewrites the eleven earlier clips.

```sh
cd app
MYCO_VIDEO_OUTPUT="/path/to/myco-motion-kit" \
MYCO_KEYED_SOURCE="/path/to/myco-motion-kit/source-idle/myco-idle-alpha.mov" \
MYCO_NOTE_PROP="/path/to/myco-motion-kit/production/reading-note-prop.png" \
node scripts/render-brand-actions.mjs

# Append an action ID to render only one: inspecting, idea, greeting, organizing.
```

Choreography lives in `scripts/brand-video/additional-actions.mjs`. The three
prop actions keep the reading framing exactly. The greeting transforms the whole
original frame slightly; it does not synthesize a cap articulation or new eyes.

## Re-render the six source edits

The renderer needs Node, the repository's installed Playwright, FFmpeg with
VP9 and ProRes encoders, and the supplied keyed 1112 × 834 source master.
HEVC with alpha additionally requires macOS VideoToolbox. It creates the six
source edits; it does not run or recreate AI generation jobs.

```sh
cd app
MYCO_VIDEO_OUTPUT="/path/to/myco-motion-kit" \
MYCO_KEYED_SOURCE="/path/to/myco-idle-alpha.mov" \
node scripts/render-brand-video.mjs

# A single edit can be regenerated independently.
MYCO_VIDEO_OUTPUT="/path/to/myco-motion-kit" \
MYCO_KEYED_SOURCE="/path/to/myco-idle-alpha.mov" \
node scripts/render-brand-video.mjs welcome

node scripts/verify-brand-video.mjs /path/to/myco-motion-kit
```

For the gallery checks, serve the completed kit on `127.0.0.1:8767`, then run
`node scripts/brand-video-smoke.mjs`. Set `MYCO_VIDEO_URL` for another address
and `MYCO_VIDEO_FILE` to the exported `index.html` to include local-file playback.
The checks read the gallery's `window.mycoMotions` dataset, so the same script
supports the seven-action pack at port 8768 and the full fifteen-motion library.

Choreography is in `scripts/brand-video/choreography.mjs`; portable gallery
templates are in `scripts/brand-video/gallery/`. No animation library or new
runtime dependency is added to the application. Exported media and archives
are delivery artifacts and are not committed.
