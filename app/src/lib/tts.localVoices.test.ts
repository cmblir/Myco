import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DialogueTurn } from "./audioOverview";
import { pickVoices, speakTurns } from "./tts";

function voice(name: string, lang: string, localService?: boolean): SpeechSynthesisVoice {
  return {
    name,
    lang,
    default: false,
    voiceURI: name,
    ...(localService === undefined ? {} : { localService }),
  } as SpeechSynthesisVoice;
}

class FakeUtterance {
  voice: SpeechSynthesisVoice | null = null;
  rate = 1;
  onend: (() => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  constructor(public text: string) {}
}

function installSynth(initial: SpeechSynthesisVoice[]) {
  let voices = initial;
  let listener: (() => void) | undefined;
  const synth = {
    getVoices: () => voices,
    speak: vi.fn<(utterance: FakeUtterance) => void>(),
    cancel: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
    addEventListener: (type: string, callback: () => void) => {
      if (type === "voiceschanged") listener = callback;
    },
  };
  vi.stubGlobal("speechSynthesis", synth);
  vi.stubGlobal("window", { speechSynthesis: synth, SpeechSynthesisUtterance: FakeUtterance });
  return {
    synth,
    settleVoices: (next: SpeechSynthesisVoice[]) => {
      voices = next;
      listener?.();
    },
  };
}

const turns: DialogueTurn[] = [
  { speaker: "A", text: "Synthetic first speaker.", cites: [] },
  { speaker: "B", text: "Synthetic second speaker.", cites: [] },
];

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("SpeechSynthesisUtterance", FakeUtterance);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("local-only speech voices", () => {
  it("selects explicit local matching voices ahead of matching remote and unclassified voices", () => {
    const remote = voice("synthetic-remote-ko", "ko-KR", false);
    const unclassified = voice("synthetic-unclassified-ko", "ko-KR");
    const localA = voice("synthetic-local-ko-a", "ko-KR", true);
    const localB = voice("synthetic-local-ko-b", "ko-KR", true);
    expect(pickVoices([remote, unclassified, localA, localB], "ko")).toEqual({ a: localA, b: localB });
  });

  it("uses an explicitly local other-language voice rather than a matching remote voice", () => {
    const remote = voice("synthetic-remote-ko", "ko-KR", false);
    const local = voice("synthetic-local-en", "en-US", true);
    expect(pickVoices([remote, local], "ko")).toEqual({ a: local, b: local });
  });

  it.each([
    { kind: "remote-only", voices: [voice("synthetic-remote", "ko-KR", false)] },
    { kind: "missing-localService", voices: [voice("synthetic-unclassified", "ko-KR")] },
    { kind: "empty", voices: [] },
  ])("does not queue an implicit default after a $kind voice list settles", async ({ voices }) => {
    const { synth, settleVoices } = installSynth([]);
    speakTurns(turns, 0, { lang: "ko" });
    expect(synth.speak).not.toHaveBeenCalled();
    settleVoices(voices);
    await vi.advanceTimersByTimeAsync(500);
    expect(synth.speak).not.toHaveBeenCalled();
    expect(pickVoices(voices, "ko")).toEqual({ a: null, b: null });
  });

  it("does not queue remote speech when two remote voices are already loaded", async () => {
    const { synth } = installSynth([
      voice("synthetic-remote-a", "ko-KR", false),
      voice("synthetic-remote-b", "ko-KR", false),
    ]);
    speakTurns(turns, 0, { lang: "ko" });
    await vi.advanceTimersByTimeAsync(500);
    expect(synth.speak).not.toHaveBeenCalled();
  });

  it("does not speak after cancellation while the local voice list is pending", async () => {
    const { synth, settleVoices } = installSynth([]);
    const controller = speakTurns(turns, 0, { lang: "ko" });
    controller.cancel();
    settleVoices([voice("synthetic-local-late", "ko-KR", true)]);
    await vi.advanceTimersByTimeAsync(500);
    expect(synth.speak).not.toHaveBeenCalled();
  });

  it("queues both speakers with distinct explicit local voices when those voices are available", async () => {
    const localA = voice("synthetic-local-a", "ko-KR", true);
    const localB = voice("synthetic-local-b", "ko-KR", true);
    const { synth } = installSynth([localA, localB]);
    speakTurns(turns, 0, { lang: "ko" });
    expect(synth.speak).toHaveBeenCalledTimes(1);
    expect(synth.speak.mock.calls[0][0].voice).toBe(localA);
    synth.speak.mock.calls[0][0].onend?.();
    await vi.advanceTimersByTimeAsync(120);
    expect(synth.speak).toHaveBeenCalledTimes(2);
    expect(synth.speak.mock.calls[1][0].voice).toBe(localB);
  });

  it("uses an explicit local voice that arrives after voiceschanged", async () => {
    const local = voice("synthetic-local-after-event", "ko-KR", true);
    const { synth, settleVoices } = installSynth([]);
    speakTurns(turns, 0, { lang: "ko" });
    settleVoices([local]);
    await vi.advanceTimersByTimeAsync(500);
    expect(synth.speak).toHaveBeenCalledTimes(1);
    expect(synth.speak.mock.calls[0][0].voice).toBe(local);
  });
});
