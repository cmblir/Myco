// Recorder state machine for the spotlight's voice quick-capture (W3–6
// item 9). getUserMedia and MediaRecorder are injected so the whole walk —
// idle → recording → saving → saved/error — is unit-testable in node. The
// machine's other job is releasing the mic: stream tracks are stopped on
// every exit path (save, failure, cancel), never left glowing in the menubar.

import type { RecorderLike } from "./wavRecorder";

/** Rust → the notch / spotlight webview: the global ⌥M was pressed (see
 *  spotlight.rs `VOICE_HOTKEY_EVENT`). Payload free — only the surface knows
 *  whether that means start or save. */
export const VOICE_HOTKEY_EVENT = "myco://voice-hotkey";

/** One ⌥M press must move a take exactly once.
 *
 *  The OS hotkey normally swallows the key (Carbon's RegisterEventHotKey,
 *  which global-hotkey uses on macOS, consumes it before the focused app sees
 *  it), so the window-level keydown listeners should never fire alongside the
 *  event. "Should" is not verifiable without a headed run, and a double fire
 *  would start-then-stop a take on one keystroke — so both paths pass through
 *  this gate and the second delivery inside the window is dropped. */
export function createHotkeyGate(gapMs = 400): (now?: number) => boolean {
  let last = -Infinity;
  return (now = Date.now()) => {
    if (now - last < gapMs) return false;
    last = now;
    return true;
  };
}

/** The gate the ⌥M paths share. Per webview — the notch and the spotlight are
 *  separate JS contexts, and only one of them is ever the hotkey's target. */
export const voiceHotkeyGate = createHotkeyGate();

export type VoiceState = "idle" | "recording" | "saving" | "saved" | "error";

export interface VoiceMachine {
  state: VoiceState;
  /** "mic-denied" when getStream refused; otherwise the save failure text. */
  error: string | null;
  start(): Promise<void>;
  stop(): Promise<void>;
  cancel(): void;
  /** WAV of the take so far, for the live-caption partials (liveCaption.ts).
   *  Null outside recording, or with a recorder that cannot snapshot — the
   *  recorder is the machine's private field, and the caption loop must not
   *  have to reach around it to a second reference to the same object. */
  snapshot(): Blob | null;
}

export interface VoiceDeps {
  getStream: () => Promise<MediaStream>;
  /** Anything MediaRecorder-shaped; production injects the WAV capturer
   *  (wavRecorder.ts) because the bundled whisper cannot read WKWebView's
   *  AAC-in-MP4 MediaRecorder output. */
  makeRecorder: (s: MediaStream) => RecorderLike;
  save: (bytes: Uint8Array) => Promise<{ rel: string }>;
  onChange: (state: VoiceState, error: string | null) => void;
  /** Per-buffer mic RMS while recording (see voiceLevel.ts); optional. */
  onLevel?: (rms: number) => void;
}

export function createVoiceMachine(deps: VoiceDeps): VoiceMachine {
  let stream: MediaStream | null = null;
  let rec: RecorderLike | null = null;
  let chunks: Blob[] = [];

  const machine: VoiceMachine = {
    state: "idle",
    error: null,
    start,
    stop,
    cancel,
    snapshot: () =>
      machine.state === "recording" ? (rec?.snapshot?.() ?? null) : null,
  };

  function set(state: VoiceState, error: string | null = null): void {
    machine.state = state;
    machine.error = error;
    deps.onChange(state, error);
  }

  function releaseMic(): void {
    stream?.getTracks().forEach((t) => t.stop());
    stream = null;
  }

  let starting = false;
  async function start(): Promise<void> {
    // `starting` closes the gap the state check leaves open: state only flips
    // to "recording" AFTER the getUserMedia await, so a rapid second start()
    // (⌥M mashed) used to run concurrently — the first MediaStream got
    // overwritten and its tracks were never stopped (mic indicator stuck on).
    if (starting || machine.state === "recording" || machine.state === "saving")
      return;
    starting = true;
    chunks = [];
    try {
      stream = await deps.getStream();
    } catch {
      starting = false;
      set("error", "mic-denied");
      return;
    }
    rec = deps.makeRecorder(stream);
    rec.ondataavailable = (e: { data: Blob }): void => {
      if (e.data.size > 0) chunks.push(e.data);
    };
    if (deps.onLevel) rec.onLevel = deps.onLevel;
    rec.start();
    starting = false; // the state check guards from here on
    set("recording");
  }

  async function stop(): Promise<void> {
    const r = rec;
    if (machine.state !== "recording" || !r) return;
    set("saving");
    await new Promise<void>((resolve) => {
      r.onstop = (): void => resolve();
      r.stop();
    });
    releaseMic();
    rec = null;
    try {
      const bytes = new Uint8Array(await new Blob(chunks).arrayBuffer());
      chunks = [];
      await deps.save(bytes);
      set("saved");
    } catch (e) {
      set("error", e instanceof Error ? e.message : String(e));
    }
  }

  function cancel(): void {
    if (machine.state === "saving") return; // the save is already in flight
    if (rec && machine.state === "recording") {
      rec.onstop = null;
      rec.stop();
    }
    rec = null;
    chunks = [];
    releaseMic();
    set("idle");
  }

  return machine;
}
