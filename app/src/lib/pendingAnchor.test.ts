import { describe, expect, it } from "vitest";
import {
  matchHeading,
  setPendingAnchor,
  takePendingAnchor,
} from "./pendingAnchor";

describe("pending anchor", () => {
  it("take consumes the anchor once and leaves other paths alone", () => {
    setPendingAnchor("/v/a.md", "Intro");
    setPendingAnchor("/v/b.md", "Other");
    expect(takePendingAnchor("/v/a.md")).toBe("Intro");
    expect(takePendingAnchor("/v/a.md")).toBeUndefined();
    expect(takePendingAnchor("/v/b.md")).toBe("Other");
  });
});

describe("matchHeading", () => {
  const headings = [
    { level: 1 as const, text: "Title", line: 0 },
    { level: 2 as const, text: "My Section: Notes!", line: 4 },
  ];

  it("matches exact text", () => {
    expect(matchHeading(headings, "Title")?.line).toBe(0);
  });

  it("matches case-insensitively, ignoring surrounding whitespace", () => {
    expect(matchHeading(headings, "  title ")?.line).toBe(0);
  });

  it("matches the slug form", () => {
    expect(matchHeading(headings, "my-section-notes")?.line).toBe(4);
    expect(matchHeading(headings, "My Section Notes")?.line).toBe(4);
  });

  it("returns undefined when nothing matches or the anchor is empty", () => {
    expect(matchHeading(headings, "Missing")).toBeUndefined();
    expect(matchHeading(headings, "")).toBeUndefined();
  });
});
