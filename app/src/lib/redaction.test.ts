// Q4 item 13 — the promotion guard both TS raw/ entry paths share
// (fullTierIngest, autoIngest). Secrets always block; PII blocks only when
// the quarantine toggle is on, mirroring Rust's raw_source_guard.
import { describe, expect, it } from "vitest";
import { checkSourceText, shouldPromote } from "./redaction";
import CASES from "./redactionCases.json";

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

  // The same cases pin Rust's raw_source_guard (secrets_scan.rs), which the
  // distill summary pass uses — one rule, not two that could drift.
  it("agrees with the Rust guard on every shared fixture case", () => {
    expect(CASES.length).toBeGreaterThan(0);
    for (const c of CASES) {
      const scan = { secrets: c.secrets, pii: c.pii };
      expect(shouldPromote(scan, false), c.name).toBe(c.promote_warn);
      expect(shouldPromote(scan, true), c.name).toBe(c.promote_quarantine);
    }
  });
});

// The one check every path into raw/ runs: link import, pasted text, YouTube
// transcripts, the _inbox pass (spec 2026-10-03-paste-guard).
describe("checkSourceText", () => {
  const scanOf = (secrets: string[], pii: string[]) => async () => ({ secrets, pii });

  it("passes clean text, noting no PII", async () => {
    expect(await checkSourceText("t", scanOf([], []), true)).toEqual({ ok: true, piiWarn: false });
  });

  it("refuses a secret whatever the PII setting", async () => {
    for (const q of [false, true]) {
      expect(await checkSourceText("t", scanOf(["aws"], ["email"]), q)).toEqual({
        ok: false,
        code: "secret",
      });
    }
  });

  it("refuses PII under quarantine, otherwise passes with a warning", async () => {
    const scan = scanOf([], ["email"]);
    expect(await checkSourceText("t", scan, true)).toEqual({ ok: false, code: "pii" });
    expect(await checkSourceText("t", scan, false)).toEqual({ ok: true, piiWarn: true });
  });

  it("fails closed when the scan itself fails", async () => {
    const down = () => Promise.reject(new Error("scan down"));
    expect(await checkSourceText("t", down, false)).toEqual({ ok: false, code: "scan" });
  });

  it("scans exactly the text it is given", async () => {
    const seen: string[] = [];
    await checkSourceText("abc", async (t) => (seen.push(t), { secrets: [], pii: [] }), false);
    expect(seen).toEqual(["abc"]);
  });
});
