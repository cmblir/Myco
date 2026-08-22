// Recorder state machine for the spotlight's voice quick-capture (W3–6
// item 9). getUserMedia and MediaRecorder are injected so the whole walk —
// idle → recording → saving → saved/error — is unit-testable in node. The
// machine's other job is releasing the mic: stream tracks are stopped on
// every exit path (save, failure, cancel), never left glowing in the menubar.

export type VoiceState = "idle" | "recording" | "saving" | "saved" | "error";

export interface VoiceMachine {
  state: VoiceState;
  /** "mic-denied" when getStream refused; otherwise the save failure text. */
  error: string | null;
  start(): Promise<void>;
  stop(): Promise<void>;
  cancel(): void;
}

export interface VoiceDeps {
  getStream: () => Promise<MediaStream>;
  makeRecorder: (s: MediaStream) => MediaRecorder;
  save: (bytes: Uint8Array) => Promise<{ rel: string }>;
  onChange: (state: VoiceState, error: string | null) => void;
}

export function createVoiceMachine(deps: VoiceDeps): VoiceMachine {
  let stream: MediaStream | null = null;
  let rec: MediaRecorder | null = null;
  let chunks: Blob[] = [];

  const machine: VoiceMachine = { state: "idle", error: null, start, stop, cancel };

  function set(state: VoiceState, error: string | null = null): void {
    machine.state = state;
    machine.error = error;
    deps.onChange(state, error);
  }

  function releaseMic(): void {
    stream?.getTracks().forEach((t) => t.stop());
    stream = null;
  }

  async function start(): Promise<void> {
    if (machine.state === "recording" || machine.state === "saving") return;
    chunks = [];
    try {
      stream = await deps.getStream();
    } catch {
      set("error", "mic-denied");
      return;
    }
    rec = deps.makeRecorder(stream);
    rec.ondataavailable = (e: BlobEvent): void => {
      if (e.data.size > 0) chunks.push(e.data);
    };
    rec.start();
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
