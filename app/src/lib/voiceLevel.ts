// Mic level for the spotlight's recording row. The old waveform was a CSS
// keyframe — a muted or wrong mic looked exactly like a working one, and the
// owner could not tell whether a 13 s take had captured anything. RMS per
// ScriptProcessor buffer drives the bars; the silence watch turns a long run
// of near-zero frames into a "no sound is coming in" hint.

/** Root-mean-square of one PCM buffer (0 for silence, ~1 for full scale). */
export function rms(samples: Float32Array): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (const s of samples) sum += s * s;
  return Math.sqrt(sum / samples.length);
}

export interface SilenceWatch {
  /** Feed one level reading. `silent` means NO SOUND HAS EVER ARRIVED in this
   *  take (a dead, muted or wrong input), not "the speaker paused": once one
   *  frame clears the threshold the watch latches open for good. Pauses
   *  between sentences used to raise the warning — and the warning covers the
   *  live caption, so speaking normally looked like a broken mic. */
  push(level: number, nowMs: number): { silent: boolean };
}

export function createSilenceWatch(opts: {
  threshold: number;
  holdMs: number;
}): SilenceWatch {
  let quietSince: number | null = null;
  let heard = false;
  return {
    push(level, nowMs) {
      if (level >= opts.threshold) heard = true;
      if (heard) return { silent: false };
      quietSince ??= nowMs;
      return { silent: nowMs - quietSince >= opts.holdMs };
    },
  };
}

export interface LevelHistory {
  push(level: number): void;
  /** Oldest → newest, always `size` long (zeros before the first push). */
  read(): Float32Array;
}

/** Ring buffer of recent RMS readings — the waveform's scrolling history.
 *  ~12 ScriptProcessor buffers/s at 48 kHz, so 160 samples is ~13 s. */
export function createLevelHistory(size = 160): LevelHistory {
  const ring = new Float32Array(size);
  const out = new Float32Array(size);
  let head = 0;
  return {
    push(level) {
      ring[head] = level;
      head = (head + 1) % size;
    },
    read() {
      out.set(ring.subarray(head));
      out.set(ring.subarray(0, head), size - head);
      return out;
    },
  };
}
