import { describe, expect, it } from "vitest";
import { createLevelHistory, createSilenceWatch, rms } from "./voiceLevel";

describe("rms", () => {
  it("is 0 for silence and an empty buffer", () => {
    expect(rms(new Float32Array(64))).toBe(0);
    expect(rms(new Float32Array(0))).toBe(0);
  });

  it("is ~1 for a full-scale square wave", () => {
    const sq = new Float32Array(64).map((_, i) => (i % 2 ? 1 : -1));
    expect(rms(sq)).toBeCloseTo(1, 6);
  });
});

describe("createSilenceWatch", () => {
  const quiet = 0.001;
  const loud = 0.2;

  it("stays quiet-but-not-silent until the hold elapses", () => {
    const w = createSilenceWatch({ threshold: 0.01, holdMs: 2000 });
    expect(w.push(quiet, 0).silent).toBe(false);
    expect(w.push(quiet, 1999).silent).toBe(false);
    expect(w.push(quiet, 2000).silent).toBe(true);
    expect(w.push(quiet, 5000).silent).toBe(true);
  });

  it("latches open on the first loud frame — a pause is not a dead mic", () => {
    const w = createSilenceWatch({ threshold: 0.01, holdMs: 2000 });
    w.push(quiet, 0);
    w.push(quiet, 2500);
    expect(w.push(loud, 2600).silent).toBe(false);
    // Long pause mid-sentence: the take has been heard, so it stays not-silent.
    expect(w.push(quiet, 4000).silent).toBe(false);
    expect(w.push(quiet, 60_000).silent).toBe(false);
  });
});

describe("createLevelHistory", () => {
  it("reads oldest → newest and wraps", () => {
    const h = createLevelHistory(3);
    expect(Array.from(h.read())).toEqual([0, 0, 0]);
    h.push(1);
    h.push(2);
    expect(Array.from(h.read())).toEqual([0, 1, 2]);
    h.push(3);
    h.push(4);
    expect(Array.from(h.read())).toEqual([2, 3, 4]);
  });
});
