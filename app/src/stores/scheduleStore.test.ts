import { describe, expect, it } from "vitest";
import { intervalSecs, isDue } from "./scheduleStore";
import type { Schedule } from "../lib/ipc";

const s = (over: Partial<Schedule>): Schedule => ({
  id: "s",
  title: "t",
  kind: "query",
  prompt: "",
  cadence: "daily",
  output_dir: "digests",
  provider: "",
  model: "",
  notify: false,
  last_run: null,
  enabled: true,
  ...over,
});

describe("intervalSecs (mirrors Rust)", () => {
  it("maps cadences", () => {
    expect(intervalSecs("daily")).toBe(86400);
    expect(intervalSecs("weekly:2")).toBe(7 * 86400);
    expect(intervalSecs("monthly:1")).toBe(30 * 86400);
    expect(intervalSecs("every:6h")).toBe(6 * 3600);
    expect(intervalSecs("every:junk")).toBe(24 * 3600);
  });
});

describe("isDue", () => {
  const now = 1_000_000;
  it("never-run enabled schedule is due", () => {
    expect(isDue(s({ last_run: null }), now)).toBe(true);
  });
  it("disabled schedule is never due", () => {
    expect(isDue(s({ last_run: null, enabled: false }), now)).toBe(false);
  });
  it("respects the interval", () => {
    expect(isDue(s({ cadence: "daily", last_run: now - 3600 }), now)).toBe(false);
    expect(isDue(s({ cadence: "daily", last_run: now - 90_000 }), now)).toBe(true);
  });
});
