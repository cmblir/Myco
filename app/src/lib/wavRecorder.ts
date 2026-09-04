// WAV-emitting stand-in for MediaRecorder. WKWebView's MediaRecorder produces
// AAC-in-MP4 (whatever the filename says), and the bundled whisper.cpp CLI
// reads only wav/mp3/flac/ogg — the first live voice run died on exactly
// that ("failed to read audio data as wav"). So the webview captures raw PCM
// itself (AudioContext + ScriptProcessor) and hands the machine ONE 16 kHz
// mono 16-bit WAV blob through the same ondataavailable/onstop surface, which
// is why voiceCapture's state machine and tests need no change at all.

/** The slice of MediaRecorder the voice machine actually touches. Both the
 *  real MediaRecorder and this WAV capturer satisfy it structurally. */
export interface RecorderLike {
  ondataavailable: ((e: { data: Blob }) => void) | null;
  onstop: (() => void) | null;
  /** RMS of each captured buffer — the live meter's only data source. */
  onLevel?: ((rms: number) => void) | null;
  start: () => void;
  stop: () => void;
  /** WAV of everything captured so far, chunks untouched. */
  snapshot?: () => Blob;
  /** WAV of only the LAST `seconds` of the take — what the live-caption
   *  partials feed on. Re-decoding the whole take made every pass cost more
   *  than the last (measured 1.1 s at 5 s of audio, 2.1 s at 27 s, and the
   *  lag the owner felt was that growth); a fixed window is ~1.1 s forever. */
  snapshotTail?: (seconds: number) => Blob;
}

import { rms } from "./voiceLevel";

/** whisper.cpp's native rate; producing it here skips any CLI-side resample. */
export const WAV_RATE = 16000;

/** Linear-interpolation downsample to WAV_RATE. Plain and phase-naive — this
 *  is speech for a speech model, not audio mastering. */
export function downsample(input: Float32Array, inRate: number): Float32Array {
  if (inRate === WAV_RATE) return input;
  const outLen = Math.floor((input.length * WAV_RATE) / inRate);
  const out = new Float32Array(outLen);
  const step = inRate / WAV_RATE;
  for (let i = 0; i < outLen; i++) {
    const pos = i * step;
    const i0 = Math.floor(pos);
    const i1 = Math.min(i0 + 1, input.length - 1);
    const frac = pos - i0;
    out[i] = input[i0] * (1 - frac) + input[i1] * frac;
  }
  return out;
}

/** RIFF/WAVE, PCM 16-bit mono at WAV_RATE. */
export function wavBytes(samples: Float32Array): Uint8Array {
  const data = new DataView(new ArrayBuffer(44 + samples.length * 2));
  const ascii = (off: number, s: string): void => {
    for (let i = 0; i < s.length; i++) data.setUint8(off + i, s.charCodeAt(i));
  };
  ascii(0, "RIFF");
  data.setUint32(4, 36 + samples.length * 2, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  data.setUint32(16, 16, true); // PCM chunk size
  data.setUint16(20, 1, true); // PCM
  data.setUint16(22, 1, true); // mono
  data.setUint32(24, WAV_RATE, true);
  data.setUint32(28, WAV_RATE * 2, true); // byte rate
  data.setUint16(32, 2, true); // block align
  data.setUint16(34, 16, true); // bits per sample
  ascii(36, "data");
  data.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    data.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Uint8Array(data.buffer);
}

/** Concatenate captured chunks and render the final WAV blob. */
export function wavBlobFrom(chunks: Float32Array[], inRate: number): Blob {
  let total = 0;
  for (const c of chunks) total += c.length;
  const joined = new Float32Array(total);
  let at = 0;
  for (const c of chunks) {
    joined.set(c, at);
    at += c.length;
  }
  return new Blob([wavBytes(downsample(joined, inRate)).buffer as ArrayBuffer], {
    type: "audio/wav",
  });
}

/** The trailing `samples` of the captured chunks, chunk boundaries ignored.
 *  Input-rate samples — the WAV is written at WAV_RATE by wavBlobFrom, which
 *  downsamples afterwards. */
export function tailChunks(chunks: Float32Array[], samples: number): Float32Array[] {
  const tail: Float32Array[] = [];
  let want = Math.max(0, Math.floor(samples));
  for (let i = chunks.length - 1; i >= 0 && want > 0; i--) {
    const c = chunks[i];
    tail.unshift(c.length <= want ? c : c.subarray(c.length - want));
    want -= Math.min(c.length, want);
  }
  return tail;
}

export function createWavRecorder(stream: MediaStream): RecorderLike {
  // ScriptProcessor over AudioWorklet on purpose: no module file to load,
  // and a 4096 buffer at mic rates is far below anything a voice note could
  // notice. ponytail: swap to AudioWorklet if capture ever needs low latency.
  const ctx = new AudioContext();
  const source = ctx.createMediaStreamSource(stream);
  const tap = ctx.createScriptProcessor(4096, 1, 1);
  const chunks: Float32Array[] = [];
  let live = false;

  const recorder: RecorderLike = {
    ondataavailable: null,
    onstop: null,
    start() {
      live = true;
      tap.onaudioprocess = (e): void => {
        if (!live) return;
        const pcm = e.inputBuffer.getChannelData(0);
        chunks.push(new Float32Array(pcm));
        recorder.onLevel?.(rms(pcm));
      };
      source.connect(tap);
      // A ScriptProcessor only fires while wired to the destination; the tap
      // writes silence to its output, so nothing is audible.
      tap.connect(ctx.destination);
    },
    stop() {
      live = false;
      tap.disconnect();
      source.disconnect();
      const rate = ctx.sampleRate;
      void ctx.close();
      recorder.ondataavailable?.({ data: wavBlobFrom(chunks, rate) });
      chunks.length = 0;
      recorder.onstop?.();
    },
    snapshot: () => wavBlobFrom(chunks, ctx.sampleRate),
    snapshotTail: (seconds) =>
      wavBlobFrom(tailChunks(chunks, seconds * ctx.sampleRate), ctx.sampleRate),
  };
  return recorder;
}
