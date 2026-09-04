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

  it("growing text keeps the overlap confirmed and the new tail interim", () => {
    const prev: CaptionState = { confirmed: ["오늘"], interim: ["회의에서"] };
    expect(mergeCaption(prev, "오늘 회의에서 정리한 내용")).toEqual({
      confirmed: ["오늘", "회의에서"],
      interim: ["정리한", "내용"],
    });
  });

  it("a window advanced by two words stitches at the overlap", () => {
    // The window dropped "오늘 회의에서" and gained two words; only the two
    // new ones are interim, and nothing already shown is repeated.
    const prev: CaptionState = {
      confirmed: ["오늘", "회의에서", "정리한"],
      interim: ["내용"],
    };
    expect(mergeCaption(prev, "정리한 내용 다시 확인")).toEqual({
      confirmed: ["오늘", "회의에서", "정리한", "내용"],
      interim: ["다시", "확인"],
    });
  });

  it("no overlap at all appends instead of dropping the line", () => {
    // The window moved past everything we had (a long silence, or a pass
    // that took longer than the window) — keep the line, append the new text.
    const prev: CaptionState = { confirmed: ["오늘", "회의에서"], interim: [] };
    expect(mergeCaption(prev, "다음 안건")).toEqual({
      confirmed: ["오늘", "회의에서"],
      interim: ["다음", "안건"],
    });
  });

  it("drops whisper's non-speech tags", () => {
    expect(mergeCaption(EMPTY_CAPTION, "[BLANK_AUDIO] 안녕하세요")).toEqual({
      confirmed: [],
      interim: ["안녕하세요"],
    });
  });

  it("a result that is only non-speech tags is no news", () => {
    const prev: CaptionState = { confirmed: ["안녕하세요"], interim: [] };
    expect(mergeCaption(EMPTY_CAPTION, "[BLANK_AUDIO]")).toBe(EMPTY_CAPTION);
    expect(mergeCaption(prev, "(음악)")).toBe(prev);
    expect(mergeCaption(prev, "[MUSIC] [_BEG_]")).toBe(prev);
  });

  it("empty text leaves the caption alone", () => {
    const prev: CaptionState = { confirmed: ["오늘"], interim: [] };
    expect(mergeCaption(prev, "   ")).toBe(prev);
  });

  it("keeps only the last 60 words", () => {
    // A sliding window has no end; without the cap the line grows for the
    // whole take.
    let caption: CaptionState = EMPTY_CAPTION;
    for (let i = 0; i < 100; i++) caption = mergeCaption(caption, `w${i}`);
    const line = [...caption.confirmed, ...caption.interim];
    expect(line.length).toBe(60);
    expect(line[0]).toBe("w40");
    expect(caption.interim).toEqual(["w99"]);
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
