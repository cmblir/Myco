import { describe, expect, it } from "vitest";
import { downsample, wavBytes, WAV_RATE } from "./wavRecorder";

describe("downsample", () => {
  it("passes 16k input through untouched", () => {
    const input = new Float32Array([0.1, -0.2, 0.3]);
    expect(downsample(input, WAV_RATE)).toBe(input);
  });

  it("halves the sample count from 32k", () => {
    const input = new Float32Array(3200).fill(0.5);
    const out = downsample(input, 32000);
    expect(out.length).toBe(1600);
    expect(out[0]).toBeCloseTo(0.5);
    expect(out[out.length - 1]).toBeCloseTo(0.5);
  });

  it("48k → 16k keeps a constant signal constant", () => {
    const input = new Float32Array(4800).fill(-0.25);
    const out = downsample(input, 48000);
    expect(out.length).toBe(1600);
    for (const s of out) expect(s).toBeCloseTo(-0.25);
  });
});

describe("wavBytes", () => {
  it("writes a valid RIFF header for 16 kHz mono 16-bit PCM", () => {
    const bytes = wavBytes(new Float32Array([0, 0.5, -0.5, 1, -1]));
    const dv = new DataView(bytes.buffer);
    const tag = (off: number, len: number): string =>
      String.fromCharCode(...bytes.slice(off, off + len));
    expect(tag(0, 4)).toBe("RIFF");
    expect(tag(8, 4)).toBe("WAVE");
    expect(tag(12, 4)).toBe("fmt ");
    expect(tag(36, 4)).toBe("data");
    expect(dv.getUint16(20, true)).toBe(1); // PCM
    expect(dv.getUint16(22, true)).toBe(1); // mono
    expect(dv.getUint32(24, true)).toBe(WAV_RATE);
    expect(dv.getUint16(34, true)).toBe(16); // bits/sample
    expect(dv.getUint32(40, true)).toBe(5 * 2); // data byte length
    expect(bytes.length).toBe(44 + 5 * 2);
    // Full-scale samples clip to int16 bounds instead of wrapping.
    expect(dv.getInt16(44 + 3 * 2, true)).toBe(0x7fff);
    expect(dv.getInt16(44 + 4 * 2, true)).toBe(-0x8000);
  });
});
