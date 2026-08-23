// Q4 item 13 — the promotion guard both TS raw/ entry paths share
// (fullTierIngest, autoIngest). Secrets always block; PII blocks only when
// the quarantine toggle is on, mirroring Rust's raw_source_guard.
import { describe, expect, it } from "vitest";
import { shouldPromote } from "./redaction";

describe("shouldPromote", () => {
  it("blocks on secrets regardless of the PII toggle", () => {
    const scan = { secrets: ["aws-access-key"], pii: [] };
    expect(shouldPromote(scan, false)).toBe(false);
    expect(shouldPromote(scan, true)).toBe(false);
  });

  it("blocks on secrets even when PII is also present", () => {
    const scan = { secrets: ["generic-api-key"], pii: ["email"] };
    expect(shouldPromote(scan, false)).toBe(false);
    expect(shouldPromote(scan, true)).toBe(false);
  });

  it("blocks on PII only when the quarantine toggle is on", () => {
    const scan = { secrets: [], pii: ["email", "kr-phone"] };
    expect(shouldPromote(scan, true)).toBe(false);
    expect(shouldPromote(scan, false)).toBe(true); // warn-only mode promotes
  });

  it("promotes a clean scan in both modes", () => {
    const scan = { secrets: [], pii: [] };
    expect(shouldPromote(scan, false)).toBe(true);
    expect(shouldPromote(scan, true)).toBe(true);
  });
});
