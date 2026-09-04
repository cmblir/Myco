import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EMPTY_CAPTION, mergeCaption, startPartialLoop } from "./liveCaption";
import type { CaptionState } from "./liveCaption";

describe("mergeCaption", () => {
  it("the first result is all interim", () => {
    expect(mergeCaption(EMPTY_CAPTION, "오늘 회의에서")).toEqual({
      confirmed: [],
      interim: ["오늘", "회의에서"],
    });
  });

  it("the same text twice confirms every word", () => {
    const once = mergeCaption(EMPTY_CAPTION, "오늘 회의에서");
    expect(mergeCaption(once, "오늘  회의에서 ")).toEqual({
      confirmed: ["오늘", "회의에서"],
      interim: [],
    });
  });

  it("growing text keeps the old prefix confirmed and the new tail interim", () => {
    const prev: CaptionState = { confirmed: ["오늘"], interim: ["회의에서"] };
    expect(mergeCaption(prev, "오늘 회의에서 정리한 내용")).toEqual({
      confirmed: ["오늘", "회의에서"],
      interim: ["정리한", "내용"],
    });
  });

  it("a re-decoded early word demotes it and everything after", () => {
    const prev: CaptionState = { confirmed: ["오늘", "회의에서", "정리한"], interim: [] };
    expect(mergeCaption(prev, "오늘 회의에 정리한")).toEqual({
      confirmed: ["오늘"],
      interim: ["회의에", "정리한"],
    });
  });

  it("a shorter partial that is a prefix retracts nothing", () => {
    // whisper re-decoding the take can hand back less than last time; folding
    // that in would un-say words the user already watched settle.
    const prev: CaptionState = { confirmed: ["오늘", "회의에서", "정리한"], interim: [] };
    expect(mergeCaption(prev, "오늘 회의에서")).toBe(prev);
  });

  it("empty text leaves the caption alone", () => {
    const prev: CaptionState = { confirmed: ["오늘"], interim: [] };
    expect(mergeCaption(prev, "   ")).toBe(prev);
  });
});

describe("startPartialLoop", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const snapshot = (): Blob => new Blob([new Uint8Array([1, 2, 3])]);

  it("chains: the next pass starts a gap after the previous one finished", async () => {
    let release: (() => void) | null = null;
    const transcribe = vi.fn(
      (_bytes: Uint8Array) =>
        new Promise<string>((resolve) => {
          release = (): void => resolve("a b");
        }),
    );
    const captions: CaptionState[] = [];
    const stop = startPartialLoop({
      snapshot,
      transcribe,
      onCaption: (c) => captions.push(c),
      leadMs: 900,
      gapMs: 500,
    });
    await vi.advanceTimersByTimeAsync(900);
    expect(transcribe).toHaveBeenCalledTimes(1);
    // Time passing does not queue a second decode: the chain waits.
    await vi.advanceTimersByTimeAsync(5000);
    expect(transcribe).toHaveBeenCalledTimes(1);
    release!();
    await vi.advanceTimersByTimeAsync(0);
    expect(captions).toEqual([{ confirmed: [], interim: ["a", "b"] }]);
    // …and the next one starts a gap after that result, not on a fixed clock.
    await vi.advanceTimersByTimeAsync(499);
    expect(transcribe).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(transcribe).toHaveBeenCalledTimes(2);
    stop();
  });

  it("stops asking after maxMs and drops a result that lands after stop()", async () => {
    const transcribe = vi.fn((_bytes: Uint8Array) => Promise.resolve("x"));
    const onCaption = vi.fn();
    const stop = startPartialLoop({
      snapshot,
      transcribe,
      onCaption,
      leadMs: 1000,
      gapMs: 1000,
      maxMs: 2500,
    });
    await vi.advanceTimersByTimeAsync(10_000);
    // Passes at 1 s and 2 s ran; the 3 s pass is past the cap and the chain
    // ends there rather than freezing the surface with a stale decode.
    expect(transcribe).toHaveBeenCalledTimes(2);
    expect(onCaption).toHaveBeenCalledTimes(2);

    let release: (() => void) | null = null;
    const slow = vi.fn(
      (_bytes: Uint8Array) =>
        new Promise<string>((resolve) => {
          release = (): void => resolve("late");
        }),
    );
    const late = vi.fn();
    const stopSlow = startPartialLoop({
      snapshot,
      transcribe: slow,
      onCaption: late,
      leadMs: 1000,
    });
    await vi.advanceTimersByTimeAsync(1000);
    expect(slow).toHaveBeenCalledTimes(1);
    stopSlow();
    release!();
    await vi.advanceTimersByTimeAsync(0);
    expect(late).not.toHaveBeenCalled();
    stop();
  });
});
