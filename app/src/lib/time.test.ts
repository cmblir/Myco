import { describe, expect, it } from "vitest";
import { formatElapsed, formatTicker } from "./time";

describe("formatElapsed", () => {
  it("renders sub-second as ms", () => {
    expect(formatElapsed(0)).toBe("0 ms");
    expect(formatElapsed(999)).toBe("999 ms");
  });

  it("renders seconds with one decimal", () => {
    expect(formatElapsed(1000)).toBe("1.0 s");
    expect(formatElapsed(1500)).toBe("1.5 s");
  });

  it("renders minutes and seconds past a minute", () => {
    expect(formatElapsed(60000)).toBe("1m 0s");
    expect(formatElapsed(192000)).toBe("3m 12s");
  });
});

describe("formatTicker", () => {
  it("zero-pads the seconds field", () => {
    expect(formatTicker(0)).toBe("0:00");
    expect(formatTicker(9000)).toBe("0:09");
    expect(formatTicker(192000)).toBe("3:12");
  });

  it("clamps negative input to zero", () => {
    expect(formatTicker(-5000)).toBe("0:00");
  });
});
