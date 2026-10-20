import { afterEach, describe, expect, it, vi } from "vitest";
import { consumeQueryPrefill, setQueryPrefill } from "./queryPrefill";

describe("consumeQueryPrefill", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("fills the composer with the draft and focuses it on the next frame", () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => frames.push(cb));
    const fill = vi.fn();
    const focus = vi.fn();
    setQueryPrefill("어텐션이 뭐야?");
    expect(consumeQueryPrefill(fill, focus)).toBe(true);
    expect(fill).toHaveBeenCalledWith("어텐션이 뭐야?");
    // ⌘K "Ask the wiki: q" lands here: the next Enter must ask, not hit <body>.
    frames.forEach((f) => f(0));
    expect(focus).toHaveBeenCalledTimes(1);
  });

  it("is a no-op with no draft, and a draft is taken once", () => {
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => cb(0));
    const focus = vi.fn();
    setQueryPrefill("once");
    consumeQueryPrefill(() => undefined, focus);
    expect(consumeQueryPrefill(() => undefined, focus)).toBe(false);
    expect(focus).toHaveBeenCalledTimes(1);
  });
});
