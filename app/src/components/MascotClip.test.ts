// MascotClip's markup for the states that decide whether a <video> mounts at
// all. Effects do not run under react-dom/server; playback binding is
// playbackRef's test, in lib/mascotClips.test.ts.
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import MascotClip from "./MascotClip";
import { CLIPS } from "../lib/mascotClips";

describe("MascotClip", () => {
  it("plays a one-shot over its still", () => {
    const html = renderToStaticMarkup(h(MascotClip, { clip: "celebrate", size: 96 }));
    expect(html).toContain("<video");
  });

  it("shows a held one-shot as its still, with no video to replay", () => {
    const html = renderToStaticMarkup(h(MascotClip, { clip: "celebrate", size: 96, held: true }));
    expect(html).not.toContain("<video");
    expect(html).toContain(`src="${CLIPS.celebrate.poster}"`);
  });
});
