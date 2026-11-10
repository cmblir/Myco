# myco video motion kit

[한국어 사용법](README.ko.md)

Fifteen rendered character motions based on the supplied `myco_mov.mp4` and
`myco_base.png` character sheet. This kit contains actual video files, transparent
posters, a portable preview gallery, and prompts for additional character actions.

## Start here

1. Download and extract the ZIP; keep the folder structure together.
2. Open `index.html` in a browser and press **재생** on any card.
3. Download the format for your destination, or copy it from `clips/`.

The gallery is in Korean. It loads no remote fonts, libraries, or services.
Videos play only after a button press, and starting a second video pauses the
first. Reduced-motion preferences pause playback; manual play remains available.
The new inspecting, idea, greeting, and organizing motions appear first. Open the previous-motion
section to browse the other eleven; closing it pauses any video inside.

| Pack                  | Contents                                                              |
| --------------------- | --------------------------------------------------------------------- |
| `myco-video-web.zip`  | WebM, HEVC with alpha, MP4 previews, PNG posters, gallery, and guides |
| `myco-video-pack.zip` | Everything in the web pack, plus ProRes 4444 MOV files for editing    |

The small web pack does not contain the editing MOV files. Choose the complete
pack when editing MOV files are needed. The gallery hides downloads that are not
included in the current pack: archive buttons are hidden in extracted ZIPs, and
editing MOV links are hidden in the web pack. Individual files remain available
in the extracted `clips/` folder. `pack-config.js` records which files are included.

## Choose a format

| File                  | Use                                                    | Background   |
| --------------------- | ------------------------------------------------------ | ------------ |
| `clips/{id}.webm`     | VP9 video for compatible web browsers and apps         | Transparent  |
| `clips/{id}-hevc.mov` | HEVC video for environments supporting HEVC with alpha | Transparent  |
| `clips/{id}.mov`      | ProRes 4444 video for editing and compositing          | Transparent  |
| `clips/{id}.mp4`      | Simple playback, presentations, and sharing            | Opaque ivory |
| `posters/{id}.png`    | Static fallback or reduced-motion presentation         | Transparent  |

Alpha support varies by browser and playback environment. The gallery tries
HEVC, then WebM when supported, and checks a decoded frame's transparent corner.
If transparent playback is unavailable, it uses the ivory MP4 preview and shows
a short explanation on that card. Local-file security restrictions can also
trigger this fallback. The background switch changes the preview surface; an
opaque MP4 keeps its own ivory background.

The files are silent. Exact export dimensions, frame rates, durations, and
provenance are recorded in `manifest.json`. No loop behavior is embedded in the
video file itself: enable looping in the host only for the repeatable variants.

## Motion vocabulary

| ID           | Gallery label     | Length | Playback | Suggested use                               |
| ------------ | ----------------- | ------ | -------- | ------------------------------------------- |
| `idle`       | 대기              | 8 s    | Repeat   | A quiet welcome area or companion           |
| `welcome`    | 등장              | 4 s    | Once     | First visit, onboarding, a new panel        |
| `thinking`   | 생각 중           | 8 s    | Repeat   | Waiting for an answer                       |
| `scan`       | 살펴보기          | 8 s    | Repeat   | Finding or inspecting material              |
| `success`    | 완료              | 4 s    | Once     | An operation that has actually completed    |
| `exit`       | 퇴장              | 4 s    | Once     | Dismissing a guide or ending an interaction |
| `discovery`  | 발견              | 5 s    | Once     | Finding a useful connection                 |
| `reading`    | 메모 읽기         | 5 s    | Once     | Opening or reviewing a note                 |
| `sleepy`     | 졸릴 때           | 5 s    | Once     | A quiet break or inactive screen            |
| `linking`    | 노트 연결         | 5 s    | Once     | Connecting related notes and ideas          |
| `planting`   | 포자 심기         | 5 s    | Once     | Starting a note or growing a new idea       |
| `inspecting` | 돋보기로 살펴보기 | 5 s    | Once     | Inspecting a detail in a note               |
| `idea`       | 아이디어          | 5 s    | Once     | A suggestion or newly formed idea           |
| `greeting`   | 고개 인사         | 5 s    | Once     | A calm handless greeting                    |
| `organizing` | 메모 정리         | 5 s    | Once     | Gathering and sorting notes                 |

## Character anatomy and corrected actions

MYCO has **zero hands and zero arms**. The one original right-side spherical
spore is a companion, not a hand. Props float independently near the lower torso. Linking and planting match
reading's character scale, placement, and source timing. The earlier reading,
linking, and planting clips that added rounded hands and arm supports were
incorrect and have been replaced; those changes were never authorized character
variants.

The six source edits (`idle` through `exit`) use the supplied character footage
with authored movement and overlays. Reading, linking, and planting now combine
that same original handless character footage with isolated note, light, and
flower props. They are video composites, not newly generated character acting.
The note graphics may come from an isolated still and move on a separate track.
Discovery and sleepy remain reference-guided generated expression clips.
Inspecting, idea, and organizing retain the same framing and source timing as reading. Greeting adds one small whole-footage dip, tilt, and vertical squash; its eyes and companion remain original. All actions marked Once are finite clips, not guaranteed seamless loops.

## Use on a web page

For an environment you have verified supports transparent WebM:

```html
<video
  width="160"
  height="160"
  muted
  playsinline
  loop
  controls
  preload="none"
  poster="posters/idle.png"
  aria-label="myco idle motion"
>
  <source src="clips/idle.webm" type='video/webm; codecs="vp9"' />
  <source src="clips/idle.mp4" type="video/mp4" />
</video>
```

Browser source fallback detects decoding support, not alpha support. For wider
browser use, use the gallery's alpha-checking playback logic in `gallery.js`, or
choose the opaque MP4 explicitly. Change the filenames to select another motion
and omit `loop` for a one-shot action.

Keep motion supplemental to nearby status text. A thinking animation does not
measure progress. Show success only after the operation succeeds. Prefer one
repeating character at a time, respect reduced motion, and offer a pause control
for loops displayed beside other content.

## Additional actions and reproduction

All six proposed expansion actions are now delivered: linking, planting,
inspecting, idea, greeting, and organizing. The separate `myco-action-pack`
contains these six plus reading. The four latest actions use original footage
with authored props/transforms; they are not newly generated character acting.
Higgsfield returned `not_enough_credits` for the September 17 generation attempt.
No credits or subscription were purchased.

`motion-prompts.md` contains optional reference instructions for future
reference-based generation. Actual delivered behavior is recorded in
`manifest.json`, including greeting's preserved original eyes.
The complete pack includes the deterministic choreography in
`production/additional-actions.mjs`; production files are omitted from the smaller web pack.
See the repository's `app/docs/myco-video.md` for the renderer command.
