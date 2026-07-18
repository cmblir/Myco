import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pickVoices, speakTurns } from "./tts";
import type { DialogueTurn } from "./audioOverview";

// Minimal stand-ins for the Web Speech API. The point is the race WebKit shows:
// getVoices() returns [] until `voiceschanged` fires.
function voice(name: string, lang = "en-US"): SpeechSynthesisVoice {
  return { name, lang, default: false, localService: true, voiceURI: name } as SpeechSynthesisVoice;
}

class FakeUtterance {
  text: string;
  voice: SpeechSynthesisVoice | null = null;
  rate = 1;
  onend: (() => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  constructor(text: string) {
    this.text = text;
  }
}

interface FakeSynth {
  getVoices: () => SpeechSynthesisVoice[];
  speak: (u: FakeUtterance) => void;
  cancel: () => void;
  pause: () => void;
  resume: () => void;
  addEventListener: (t: string, cb: () => void, o?: unknown) => void;
  _fireVoicesChanged: () => void;
  spoken: FakeUtterance[];
}

function makeSynth(voicesAfterEvent: SpeechSynthesisVoice[], startEmpty: boolean): FakeSynth {
  let voices = startEmpty ? [] : voicesAfterEvent;
  let listener: (() => void) | null = null;
  const spoken: FakeUtterance[] = [];
  return {
    spoken,
    getVoices: () => voices,
    speak: (u) => {
      spoken.push(u);
      // Auto-advance so the whole dialogue plays in the test.
      queueMicrotask(() => u.onend?.());
    },
    cancel: () => undefined,
    pause: () => undefined,
    resume: () => undefined,
    addEventListener: (t, cb) => {
      if (t === "voiceschanged") listener = cb;
    },
    _fireVoicesChanged: () => {
      voices = voicesAfterEvent;
      listener?.();
    },
  };
}

const TURNS: DialogueTurn[] = [
  { speaker: "A", text: "Hello from host A.", cites: [] },
  { speaker: "B", text: "And host B here.", cites: [] },
];

beforeEach(() => {
  vi.stubGlobal("SpeechSynthesisUtterance", FakeUtterance);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("pickVoices", () => {
  it("returns two distinct voices, preferring the language", () => {
    const vs = [voice("Kyoko", "ja-JP"), voice("Alex", "en-US"), voice("Otoya", "ja-JP")];
    const { a, b } = pickVoices(vs, "ja");
    expect(a?.name).toBe("Kyoko");
    expect(b?.name).toBe("Otoya");
    expect(a).not.toBe(b);
  });

  it("is empty when there are no voices", () => {
    expect(pickVoices([], "en")).toEqual({ a: null, b: null });
  });
});

describe("speakTurns voice race", () => {
  it("gives A and B different voices even when getVoices() is empty at first", async () => {
    // This is the bug: on first play getVoices() is [] (WebKit), so both hosts
    // used to speak in the one default voice. Now it waits for voiceschanged.
    const twoVoices = [voice("Alex"), voice("Samantha")];
    const synth = makeSynth(twoVoices, /* startEmpty */ true);
    vi.stubGlobal("speechSynthesis", synth);
    vi.stubGlobal("window", { speechSynthesis: synth, SpeechSynthesisUtterance: FakeUtterance });

    speakTurns(TURNS, 0, { lang: "en" });
    // Nothing spoken yet — it's waiting for the voice list.
    expect(synth.spoken.length).toBe(0);

    synth._fireVoicesChanged();
    await vi.waitFor(() => expect(synth.spoken.length).toBe(2));

    const [ua, ub] = synth.spoken;
    expect(ua.voice).not.toBeNull();
    expect(ub.voice).not.toBeNull();
    expect(ua.voice).not.toBe(ub.voice); // the two hosts differ — the whole point
  });

  it("starts immediately with no delay when voices are already loaded", async () => {
    const synth = makeSynth([voice("Alex"), voice("Samantha")], /* startEmpty */ false);
    vi.stubGlobal("speechSynthesis", synth);
    vi.stubGlobal("window", { speechSynthesis: synth, SpeechSynthesisUtterance: FakeUtterance });

    speakTurns(TURNS, 0, { lang: "en" });
    // Voices were ready, so the first utterance is queued synchronously.
    expect(synth.spoken.length).toBe(1);
    await vi.waitFor(() => expect(synth.spoken.length).toBe(2));
    expect(synth.spoken[0].voice).not.toBe(synth.spoken[1].voice);
  });
});
