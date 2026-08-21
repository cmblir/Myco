import { describe, expect, it } from "vitest";
import { formatCrashReport } from "./crashReport";

describe("formatCrashReport", () => {
  it("includes app version, OS, and the raw panic line in a fenced block", () => {
    const out = formatCrashReport({
      appVersion: "0.4.0",
      osVersion: "macOS 14.5",
      panicLine: "[unix 1755000000] panic at src/vault.rs:42:9: boom",
      note: "editing a page and hit save",
    });
    expect(out).toContain("**App version:** 0.4.0");
    expect(out).toContain("**OS:** macOS 14.5");
    expect(out).toContain("```\n[unix 1755000000] panic at src/vault.rs:42:9: boom\n```");
    expect(out).toContain("editing a page and hit save");
  });

  it("marks the note as not specified when omitted, never emits 'undefined'", () => {
    const out = formatCrashReport({
      appVersion: "0.4.0",
      osVersion: "macOS 14.5",
      panicLine: "[unix 1] panic at a:1:1: x",
    });
    expect(out).toContain("_not specified_");
    expect(out).not.toContain("undefined");
  });

  it("treats a whitespace-only note as not specified", () => {
    const out = formatCrashReport({
      appVersion: "0.4.0",
      osVersion: "macOS 14.5",
      panicLine: "[unix 1] panic at a:1:1: x",
      note: "   ",
    });
    expect(out).toContain("_not specified_");
  });

  it("keeps a multi-line panic payload whole inside the fence", () => {
    const line =
      "[unix 1] panic at src/vault.rs:1:1: assertion `left == right` failed\n  left: 1\n right: 2";
    const out = formatCrashReport({
      appVersion: "0.4.0",
      osVersion: "macOS 14.5",
      panicLine: line,
    });
    expect(out).toContain("```\n" + line + "\n```");
  });

  it("survives a multi-byte panic message untouched", () => {
    const line = "[unix 1] panic at src/vault.rs:1:1: 제목한글텍스트";
    const out = formatCrashReport({
      appVersion: "0.4.0",
      osVersion: "macOS 14.5",
      panicLine: line,
    });
    expect(out).toContain("제목한글텍스트");
  });
});

// A char-boundary panic embeds the offending string — for this app, a note
// title. The block must say so before the user pastes it into a public issue.
it("warns that the copied line can quote the user's notes", () => {
  const out = formatCrashReport({
    appVersion: "0.4.0",
    osVersion: "macOS 26.2",
    panicLine: "[unix 1] panic at src/x.rs:1:1: inside '한' of `제목한글텍스트`",
  });
  expect(out).toContain("may quote text");
  expect(out).toContain("제목한글텍스트");
});
