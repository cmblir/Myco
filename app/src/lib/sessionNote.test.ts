import { describe, expect, it } from "vitest";
import { getValue, parseFrontmatter } from "./frontmatter";
import { sourceEvidence } from "./sessionEvidence";
import { refreshSessionNote } from "./sessionNote";

const ORIGINAL = "---\ntitle: Human title\nsession_key: codex:synthetic\nsession_kind: work\nsession_record_start: 2026-10-02\nsession_record_end: 2026-10-03\nsession_activity_days: [2026-10-03]\n---\n\nHuman annotation.\n";

function refresh(source: string, previous = ORIGINAL, count?: number): string {
  const evidence = sourceEvidence("raw/synthetic.md", source, "2026-10-08");
  return refreshSessionNote(previous, "codex:synthetic", "Synthetic update", evidence.revision, "2026-10-08", false,
    source, count === undefined ? evidence.chunks : evidence.chunks.slice(0, count));
}

describe("organized session original dates", () => {
  it.each([
    "**User:**\n\nUndated synthetic request.",
    "---\ncreated: 2026-02-30\n---\n\n**User:**\n\nInvalid record date.",
    '---\nturn_metadata: [{"timestamp":"2026-10-07T09:00:00Z"}]\n---\n\n**User:**\n\nOne.\n\n**Assistant:**\n\nTwo.',
    '---\nturn_metadata: [{"timestamp":"2026-10-07T09:00:00Z"}]\nturn_metadata: []\n---\n\n**User:**\n\nAmbiguous metadata.',
  ])("does not promote fallback, invalid or ambiguous timestamps", (source) => {
    const next = refresh(source);
    const fm = parseFrontmatter(next);
    expect(getValue(fm, "session_record_end")).toBe("2026-10-03");
    expect(getValue(fm, "session_activity_days")).toEqual(["2026-10-03"]);
    expect(next).toContain("Human annotation.");
    expect(getValue(fm, "title")).toBe("Human title");
  });

  it("uses original document dates as record dates without inventing event dates", () => {
    const fm = parseFrontmatter(refresh("---\ncreated: 2026-10-06\n---\n\nSynthetic source text."));
    expect(getValue(fm, "session_record_end")).toBe("2026-10-06");
    expect(getValue(fm, "session_activity_days")).toEqual(["2026-10-03"]);
  });

  it("adds event dates only as their source chunks are saved", () => {
    const source = '---\ncreated: 2026-10-06\nturn_metadata: [{"timestamp":"2026-10-07T09:00:00Z"},{"timestamp":"2026-10-08T09:00:00Z"}]\n---\n\n**User:**\n\nFirst synthetic request.\n\n**Assistant:**\n\nSecond synthetic report.';
    const first = refresh(source, ORIGINAL, 1);
    expect(getValue(parseFrontmatter(first), "session_activity_days")).toEqual(["2026-10-03", "2026-10-07"]);
    const second = refresh(source, first);
    expect(getValue(parseFrontmatter(second), "session_activity_days")).toEqual(["2026-10-03", "2026-10-07", "2026-10-08"]);
    expect(getValue(parseFrontmatter(second), "session_record_end")).toBe("2026-10-06");
  });
});
