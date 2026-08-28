import { describe, expect, it, vi } from "vitest";
import { createVoiceMachine, type VoiceState } from "./voiceCapture";

// Fake MediaStream/MediaRecorder pair: `stop()` synchronously delivers one
// data chunk and fires onstop, which is enough for the machine's await-onstop
// handshake. Tracks record whether the machine released the mic.

interface FakeRecorder {
  ondataavailable: ((e: { data: Blob }) => void) | null;
  onstop: (() => void) | null;
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
}

function fakes(
  save = vi.fn((_bytes: Uint8Array) =>
    Promise.resolve({ rel: "_inbox/voice-2026-08-22-0912.md" }),
  ),
) {
  const track = { stop: vi.fn() };
  const stream = { getTracks: () => [track] } as unknown as MediaStream;
  const rec: FakeRecorder = {
    ondataavailable: null,
    onstop: null,
    start: vi.fn(),
    stop: vi.fn(() => {
      rec.ondataavailable?.({ data: new Blob(["abc"]) });
      rec.onstop?.();
    }),
  };
  const states: VoiceState[] = [];
  const getStream = vi.fn(() => Promise.resolve(stream));
  const machine = createVoiceMachine({
    getStream,
    makeRecorder: () => rec,
    save,
    onChange: (s) => states.push(s),
  });
  return { machine, rec, track, save, states, getStream };
}

describe("createVoiceMachine", () => {
  it("start acquires the stream and moves to recording", async () => {
    const { machine, rec, states } = fakes();
    await machine.start();
    expect(machine.state).toBe("recording");
    expect(rec.start).toHaveBeenCalledOnce();
    expect(states).toEqual(["recording"]);
  });

  it("a second start while recording is a no-op", async () => {
    const { machine, getStream } = fakes();
    await machine.start();
    await machine.start();
    expect(getStream).toHaveBeenCalledOnce();
    expect(machine.state).toBe("recording");
  });

  it("stop walks saving → saved and hands the recorded bytes to save", async () => {
    const { machine, track, save, states } = fakes();
    await machine.start();
    await machine.stop();
    expect(states).toEqual(["recording", "saving", "saved"]);
    expect(save).toHaveBeenCalledOnce();
    const bytes = save.mock.calls[0][0];
    expect(new TextDecoder().decode(bytes)).toBe("abc");
    expect(track.stop).toHaveBeenCalled();
  });

  it("a rejected save lands in error with the message, mic released", async () => {
    const { machine, track } = fakes(
      vi.fn((_bytes: Uint8Array) => Promise.reject(new Error("whisper-missing"))),
    );
    await machine.start();
    await machine.stop();
    expect(machine.state).toBe("error");
    expect(machine.error).toBe("whisper-missing");
    expect(track.stop).toHaveBeenCalled();
  });

  it("a refused stream lands in error mic-denied", async () => {
    const save = vi.fn(() => Promise.resolve({ rel: "x" }));
    const machine = createVoiceMachine({
      getStream: () => Promise.reject(new Error("NotAllowedError")),
      makeRecorder: () => ({}) as unknown as import("./wavRecorder").RecorderLike,
      save,
      onChange: () => undefined,
    });
    await machine.start();
    expect(machine.state).toBe("error");
    expect(machine.error).toBe("mic-denied");
    expect(save).not.toHaveBeenCalled();
  });

  it("cancel during recording discards without calling save", async () => {
    const { machine, track, save } = fakes();
    await machine.start();
    machine.cancel();
    expect(machine.state).toBe("idle");
    expect(save).not.toHaveBeenCalled();
    expect(track.stop).toHaveBeenCalled();
  });
});
