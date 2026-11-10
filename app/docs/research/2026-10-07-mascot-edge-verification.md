# Mascot boundary verification — 2026-10-07

The reported pale, shimmering cap fringe appears on more than one screen.
Two independent problems were reproduced: foreground colour recovery used a
cleaned alpha value, and native HEVC encoding received straight colour while
VideoToolbox assumed premultiplied colour. The fixes preserve the character,
silhouette, eye placement, motion timing and existing playback controls.

## Colour recovery

Both the old static-pose preparation and `scripts/mascot-key-clip.py` estimated
green-plate coverage, tightened alpha with `(coverage - 0.14) / 0.86`, then
used that smaller alpha to recover foreground RGB. A synthetic dark-gray
foreground at 16% coverage became clipped magenta. Recovery now uses the
original coverage, before alpha cleanup. The alpha cleanup itself is unchanged.

The preserved five PNG masters were read from the same project's canonical
worktree. Replaying the historic preparation produced all five shipping pose
PNGs exactly, including their encoded bytes. The corrected preparation lives
in `scripts/prepare-mascot-poses.py`; the canonical worktree and masters were
not modified.

Five pose PNGs and fourteen generated notch PNGs were replaced. Pose and
notch alpha are byte-identical, eye RGB is identical, and `anchors.json` is
unchanged. Across opaque pose pixels, the maximum RGB channel difference is
2/255 and the mean is 0.0034–0.0057/255; opaque lavender underside samples are
identical. Dark and light previews confirm reduced bright/magenta outlines
without changing the cap shape or intended rim light.

Temporary evidence:

- `/tmp/myco-mascot-static-review/comparison.json`
- `/tmp/myco-mascot-static-review/poses-dark-light.png`
- `/tmp/myco-mascot-static-review/attention-cap-dark-light.png`
- `/tmp/myco-mascot-static-review/shipping-replacement.json`
- Original shipping PNGs: `/tmp/myco-mascot-static-review/shipping-backup/`

## Native HEVC alpha

Read-only AVFoundation decoding of the shipping `look-around.mov` reproduced
the bright dotted cap outline. Its first and last frames were affected; the
measurement does not establish a defect unique to the end of the animation.
The equivalent VP9 alpha frames had substantially less boundary excess.

The installed VideoToolbox header documents premultiplied alpha as the
default when neither AlphaChannelMode nor a matching attachment is specified.
The installed FFmpeg encoder did not specify either. Both clip scripts fed
straight RGBA PNGs directly to BGRA HEVC encoding.

The checked header is the command-line SDK's
`VideoToolbox.framework/Headers/VTCompressionProperties.h`, lines 996–1009.
FFmpeg 9.0.1's encoder and VideoToolbox frame-upload sources were checked
against the official tag; URLs and digests are in the temporary
`encoding-reference.json`. This finding concerns the encoder's default, not
a claim that FFmpeg has no alpha-mode option.

The minimum correction in both scripts is:

```text
-vf format=gbrap,premultiply=planes=7:inplace=1,format=bgra
```

Frame size/rate, `alpha_quality=0.8`, `q:v=60` and `hvc1` remain unchanged.
This premultiplies RGB without changing alpha. Native round-trips of the same
three RGBA source frames gave cap-boundary RGB excess p95 of
140.0/143.6/140.3 with the old recipe and 44.0/45.6/45.3 with the correction,
close to the VP9 reference. Decoded alpha between those two recipes was
byte-identical. The corrected dark/light previews remove the native encoder's
additional pale fringe.

Temporary evidence:

- `/tmp/myco-mascot-edge-review/hevc-premultiplication-metrics.json`
- `/tmp/myco-mascot-edge-review/hevc-premultiplication-comparison-0.png`
- `/tmp/myco-mascot-edge-review/hevc-premultiplication-comparison-2.png`

## Verification and limits

- Static preparation regression: historic colour calculation fails four
  coverage cases; corrected preparation passes 8/8 tests, including rejection
  of nonsquare source masters before writing a stretched character.
- Clip-keying and native HEVC round-trip regressions: stock encoder fails the
  visible partial-edge comparison; corrected scripts pass 9/9 tests. The
  native fixture separates alpha transitions from its opaque colour control
  and retains the same eight-level colour tolerance and alpha checks.
- Shared mascot component, clip and notch tests after PNG replacement:
  5 files, 91/91 passing.
- All three Python regressions after final changes: 17/17 passing. The app clip
  budget tests after MOV replacement pass 30/30; the 24 files total 1,476,531
  bytes, below the unchanged 4 MB budget.

The original unkeyed video takes were not found in the checked source
locations. Existing VP9 colour, posters and notch animation strips contain
their historical keying result and cannot be restored losslessly from those
exports. The native correction can re-encode existing VP9 alpha without
inventing new frames, but does not claim to recover colour already clipped by
the historic keyer. The corrected keyer applies when original footage is
available. No blur, alpha erosion, character redesign or generated retake is
part of this change.

All eight shipping MOVs were replaced from their existing VP9 alpha exports.
Native first/last-frame checks cover 24 decoded frames; frame size, rate,
97-frame count and 4.041667-second duration are preserved. Additional lossy
VP9-to-HEVC opaque RGB error has mean 2.82–4.35/255 and p95 8–13/255;
alpha error has mean 0.042–0.105/255, p95 0–1/255 and maximum 6–14/255.
Thus the filter preserves alpha before encoding, while the lossy decoded
asset is not promised to be bit-identical to VP9. Source WebM, poster and
notch strip digests are unchanged from Git HEAD. Original MOVs remain in
`/tmp/myco-mascot-edge-review/original-mov/`; each before/after digest and
decoded measurement is in `shipping-mov-replacement.json` beside it.
For the actual shipping `look-around` first/last two frames, cap-boundary RGB
excess p95 falls from 136.85/139.0/142.22 to 44.0/45.28/53.73. The comparison
`shipping-look-around-before-after-native.png` and eight-clip dark/light sheet
were visually reviewed. This supports reduced brightness artifacts; it does
not establish that every temporal variation in the generated footage is gone.

## Installation and native observation

The current-source frontend build completed in 19.91 seconds and the native
release build in 7 minutes 59 seconds. The corrected bundle was installed at
2026-10-07 13:50:38 +09:00 after normal shutdown. Its executable SHA256 is
`1bd4810479bd4ad45ff5a5bd86b7f34ace931eeeba24c6771fa587a00b9bfac6`.
The prior installed bundle remains in
`~/Library/Application Support/myco-install-backups/20261007-135036/myco.app`.
Strict signature validity, actual ad-hoc signature type, bundle identity,
executable digest and the unchanged bundled E5 digest were checked for the
candidate, staging copy and installed app. Notarization was skipped without
credentials; the stable-signing guard was unchanged.

The first installation preflight stopped before any file replacement because
it incorrectly required all five full-resolution pose PNGs in the frontend
bundle. Production imports consume only `attention.png` directly; the other
four are preparation masters for notch derivatives and offline colour grading.
The corrected preflight checks all 23 used assets (eight MOVs, attention PNG,
ten separate notch PNGs and four PNGs decoded from inline JavaScript data URIs)
against source hashes and compiled asset keys. It separately records the four
preparation-master hashes. An independent read-only consumer review confirmed
this scope. No used-asset check was removed and no unused asset was forced into
the build. The install receipt is
`/tmp/myco-20261007-edge-and-answers-install.json`.

The installed main window was inspected through the native computer-use tool.
The Ask empty-state clip, Settings information clip and Ask generation loader
were visually checked on the existing dark theme. Their corrected cap edges
rendered without the conspicuous pale speckled fringe in the supplied crop.
This supplements the decoded dark/light and first/last-frame checks above;
it does not certify every frame, every application surface or removal of all
variation baked into the original generated footage. Preferences were not
changed for this visual check, and no private-screen images were saved.

A temporary answer-latency diagnostic bundle was subsequently installed and
removed. The same tested production bundle and all 23 used mascot assets were
restored and reverified at 2026-10-07 14:28:54 +09:00, with the executable and
E5 hashes above unchanged. The source and final installed app do not retain the
temporary latency recorder.

The subsequent user-selected 4B Ask deadline change rebuilt the bundle without
changing mascot assets. Installation at 2026-10-07 15:09:25 +09:00 reverified all
23 used asset digests and four preparation masters. The final executable SHA256
is `909015ec1c9632f9a11f7e2238cc89cc8a840e5b840b6b21f1f2d1fecf2f11a2`;
the E5 hash and lack of a temporary recorder remain verified. Native window
access later recovered. The new bundle's Ask empty-state clip was visually
checked on the existing dark theme and did not show the conspicuous pale
speckled cap fringe from the reported crop. The earlier three-surface
observations apply to those unchanged assets; Settings and the generation
loader were not visually rechecked in this launch. No private-screen image was
saved and no broader temporal or surface guarantee follows from this check.

The subsequent removal of Ask time cutoffs did not change mascot sources.
Installation at 2026-10-07 17:28:43 +09:00 reverified the same 23 used assets and
four preparation masters. The executable SHA256 is now
`14e06abbc49915122d8ea777f72aff4d6de050ed3b515694c42e1cb1cc450daa`;
the E5 digest and absence of a temporary recorder remain verified. The new
main window's Ask empty-state clip was visually checked on the existing dark
theme without the conspicuous pale speckled cap fringe from the supplied crop.
The launch requested macOS Documents-folder access and the main window did not
load the existing notes, so the generation loader was not rechecked in this
launch. Earlier observations apply
to the unchanged assets within their stated limits; no private-screen image
was saved. The persistent install receipt is
`~/Library/Caches/myco-development/2026-10-07-ask-completion/installation.json`.
