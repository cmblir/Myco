import { describe, expect, it } from "vitest";
import { bucketByDay, isIngested } from "./vaultPulse";

// Unix seconds for a local wall-clock time. Building the Date locally and
// dividing is the point: the bucketing is local-day based, so the fixtures
// have to be local too or the test passes only in UTC.
const at = (y: number, m: number, d: number, h = 12): number =>
  Math.floor(new Date(y, m - 1, d, h).getTime() / 1000);

const ROOT = "/vault";

describe("isIngested", () => {
  it("treats the machine-written folders as ingested", () => {
    expect(isIngested("sessions/claude-code-abc.md")).toBe(true);
    expect(isIngested("_inbox/dropped.md")).toBe(true);
    expect(isIngested("raw/paper.md")).toBe(true);
    expect(isIngested("ingest-reports/2026-08-01.md")).toBe(true);
  });

  it("treats everything else as authored, including root-level notes", () => {
    expect(isIngested("wiki/self-attention.md")).toBe(false);
    expect(isIngested("daily/2026-08-08.md")).toBe(false);
    expect(isIngested("cards/idea.md")).toBe(false);
    expect(isIngested("welcome.md")).toBe(false);
  });

  it("matches whole folder names, not prefixes", () => {
    // `rawdata/` is somebody's own folder — it is not the immutable `raw/`.
    expect(isIngested("rawdata/notes.md")).toBe(false);
    expect(isIngested("sessions-archive/old.md")).toBe(false);
  });
});

describe("bucketByDay", () => {
  const now = new Date(2026, 7, 8, 15, 0); // Sat 2026-08-08 15:00 local

  it("returns exactly `days` buckets, oldest first, zero-filled", () => {
    const b = bucketByDay([], ROOT, 7, now);
    expect(b.authored).toEqual([0, 0, 0, 0, 0, 0, 0]);
    expect(b.ingested).toEqual([0, 0, 0, 0, 0, 0, 0]);
  });

  it("puts today in the last bucket and splits by folder", () => {
    const b = bucketByDay(
      [
        [`${ROOT}/wiki/a.md`, at(2026, 8, 8)],
        [`${ROOT}/sessions/s.md`, at(2026, 8, 8)],
        [`${ROOT}/sessions/t.md`, at(2026, 8, 8)],
      ],
      ROOT,
      7,
      now,
    );
    expect(b.authored[6]).toBe(1);
    expect(b.ingested[6]).toBe(2);
  });

  it("buckets by LOCAL day, so a late-evening edit stays on its own day", () => {
    // 23:30 on the 7th is the 7th — one bucket before today — even where UTC
    // has already rolled over to the 8th.
    const b = bucketByDay([[`${ROOT}/wiki/a.md`, at(2026, 8, 7, 23)]], ROOT, 7, now);
    expect(b.authored[5]).toBe(1);
    expect(b.authored[6]).toBe(0);
  });

  it("drops entries older than the window instead of clamping them into it", () => {
    // Clamping would pile years of history onto the oldest bar and read as a
    // burst of activity that never happened.
    const b = bucketByDay([[`${ROOT}/wiki/old.md`, at(2025, 1, 1)]], ROOT, 7, now);
    expect(b.authored).toEqual([0, 0, 0, 0, 0, 0, 0]);
  });

  it("drops entries in the future rather than writing past the array", () => {
    const b = bucketByDay([[`${ROOT}/wiki/skew.md`, at(2026, 9, 1)]], ROOT, 7, now);
    expect(b.authored.reduce((s, n) => s + n, 0)).toBe(0);
  });

  it("ignores a path outside the vault root rather than misfiling it", () => {
    const b = bucketByDay([["/elsewhere/wiki/a.md", at(2026, 8, 8)]], ROOT, 7, now);
    expect(b.authored[6]).toBe(0);
  });

  it("accepts a root with a trailing slash", () => {
    const b = bucketByDay([[`${ROOT}/wiki/a.md`, at(2026, 8, 8)]], `${ROOT}/`, 7, now);
    expect(b.authored[6]).toBe(1);
  });
});

import { motionVars, PARTICLE_MAX } from "./vaultPulse";

describe("motionVars", () => {
  it("gives an empty vault the floor of every range", () => {
    const v = motionVars(0, 0, 0);
    expect(v.particles).toBe(3);
    expect(v.pulseMs).toBe(6000); // idle: the slowest heartbeat
    expect(v.glow).toBeCloseTo(0.15, 5);
  });

  it("never exceeds the particle cap, however large the vault", () => {
    expect(motionVars(1_000_000, 0, 1).particles).toBe(PARTICLE_MAX);
    expect(PARTICLE_MAX).toBe(28);
  });

  it("scales particles logarithmically, so 10x the links is not 10x the dots", () => {
    const small = motionVars(150, 0, 0).particles;
    const big = motionVars(1500, 0, 0).particles;
    expect(big).toBeGreaterThan(small);
    // The underlying signal only supports few/some/many. A linear map would
    // assert a precision 'number of wikilinks' does not have.
    expect(big).toBeLessThan(small * 3);
  });

  it("speeds the pulse up as the user writes more, and clamps at the busy end", () => {
    expect(motionVars(100, 0, 0).pulseMs).toBe(6000);
    expect(motionVars(100, 5, 0).pulseMs).toBeLessThan(6000);
    expect(motionVars(100, 500, 0).pulseMs).toBe(1800);
  });

  it("maps resolved ratio onto glow across the full range", () => {
    expect(motionVars(0, 0, 1).glow).toBeCloseTo(0.5, 5);
    expect(motionVars(0, 0, 0.5).glow).toBeCloseTo(0.325, 5);
  });

  it("survives nonsense input rather than emitting NaN into CSS", () => {
    // A NaN in a custom property silently kills the whole animation, which is
    // far harder to notice than a wrong-but-visible value.
    for (const v of [
      motionVars(-5, -5, -1),
      motionVars(Number.NaN, Number.NaN, Number.NaN),
    ]) {
      expect(Number.isFinite(v.particles)).toBe(true);
      expect(Number.isFinite(v.pulseMs)).toBe(true);
      expect(Number.isFinite(v.glow)).toBe(true);
      expect(v.particles).toBeGreaterThanOrEqual(3);
    }
  });
});
