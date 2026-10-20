import { describe, expect, it } from "vitest";
import {
  completedEvidenceSources,
  EVIDENCE_BATCH_SIZE,
  EVIDENCE_CHUNK_CHARS,
  evidenceSection,
  nextEvidenceBatch,
  sourceEvidence,
} from "./sessionEvidence";

describe("revision-bound session evidence", () => {
  it("preserves a short name, semantic headings, human comments and a long turn's tail", () => {
    const source = sourceEvidence(
      "raw/conversations/codex/s1.md",
      [
        "# Orion",
        "## auth-policy accepted",
        "<!-- human decision: keep Orion -->",
        "**User:**",
        "민수",
        "**Assistant:**",
        "x".repeat(1_200) + "TAIL-DECISION",
      ].join("\n"),
      "2026-09-01",
    );
    expect(source.chunks.map((chunk) => chunk.text).join("")).toContain("민수");
    expect(source.chunks.map((chunk) => chunk.text).join("")).toContain(
      "TAIL-DECISION",
    );
    expect(source.chunks.map((chunk) => chunk.text).join("")).toContain(
      "## auth-policy accepted",
    );
    expect(source.chunks.map((chunk) => chunk.text).join("")).toContain(
      "human decision: keep Orion",
    );
    expect(
      source.chunks.every((chunk) => chunk.text.length <= EVIDENCE_CHUNK_CHARS),
    ).toBe(true);
  });

  it("keeps importer timestamps, IDs, phases and role ordinals", () => {
    const raw = [
      "---",
      'turn_metadata: [{"message_id":"u1","timestamp":"2026-08-01T09:00:00+09:00"},{"message_id":"a1","phase":"final_answer"}]',
      "---",
      "# Project",
      "**User:**",
      "decided A",
      "**Assistant:**",
      "suggested B",
    ].join("\n");
    const source = sourceEvidence("sessions/s.md", raw, "2026-08-01");
    expect(source.chunks[0]).toMatchObject({
      role: "User",
      turnId: "u1",
      timestamp: "2026-08-01T09:00:00+09:00",
      text: "decided A",
    });
    expect(source.chunks[1]).toMatchObject({
      role: "Assistant",
      turnId: "a1",
      phase: "final_answer",
      text: "suggested B",
    });
    expect(source.chunks[1].timestamp).toBeUndefined();
    const rendered = evidenceSection([source], source.chunks);
    expect(rendered).toContain("decision mention (quoted, not verified)");
    expect(rendered).toContain("u1");
    expect(rendered).toContain("final\\_answer");
  });

  it("does not shift attribution through a literal role header inside a message", () => {
    const body = "# Synthetic collision\n\n**User:**\n\nA literal example follows.\n\n```text\n**Tool:**\n\nCOLLISION_EVIDENCE remains a quoted example.\n```\n\n**Assistant:**\n\nActual assistant response.\n";
    const fields = 'turn_metadata: [{"message_id":"u1","timestamp":"2026-10-01T12:00:00Z"},{"message_id":"a1","timestamp":"2026-10-02T12:00:00Z","phase":"final_answer","original_role":"assistant"}]';
    const source = sourceEvidence("sessions/collision.md", `---\n${fields}\n---\n\n${body}`, "2026-10-05");
    const manual = sourceEvidence("sessions/collision.md", body, "2026-10-05");
    const shape = (chunks: typeof source.chunks) => chunks.map(({ id, start, end, text }) => ({ id, start, end, text }));
    expect(shape(source.chunks)).toEqual(shape(manual.chunks));
    const spoken = source.chunks.filter(chunk => chunk.role !== "Source");
    expect(spoken).toHaveLength(3);
    expect(spoken.every(chunk => chunk.role === "Unknown")).toBe(true);
    expect(spoken.every(chunk => chunk.timestamp === undefined && chunk.turnId === undefined &&
      chunk.phase === undefined && chunk.originalRole === undefined)).toBe(true);
    expect(source.chunks.find(chunk => chunk.text === "# Synthetic collision")?.role).toBe("Source");
    const rendered = evidenceSection([source], source.chunks);
    expect(rendered).toContain("COLLISION\\_EVIDENCE");
    expect(rendered).not.toContain("2026-10-01");
    expect(rendered).not.toContain("2026-10-02");
    expect(completedEvidenceSources([source], rendered)).toEqual([source]);
    expect(nextEvidenceBatch([source], rendered)).toEqual([]);
  });

  it.each(["{}", "[null]", '["invalid"]', "[[]]", "[{broken}]", "[]"])(
    "treats explicit malformed or misaligned metadata %s as unknown attribution", metadata => {
      const raw = `---\ncreated: 2026-10-01\nturn_metadata: ${metadata}\n---\n\n**User:**\n\nThe proposal remains unconfirmed.`;
      const source = sourceEvidence("sessions/malformed.md", raw, "2026-10-05");
      expect(source.chunks).toHaveLength(1);
      expect(source.chunks[0]).toMatchObject({ role: "Unknown", id: "0:0-33", text: "The proposal remains unconfirmed." });
      expect(source.chunks[0].timestamp).toBeUndefined();
      expect(source.chunks[0].turnId).toBeUndefined();
      expect(completedEvidenceSources([source], evidenceSection([source], source.chunks))).toEqual([source]);
    },
  );

  it("keeps aligned roles with unknown turn time and preserves manual transcript behavior", () => {
    const body = "**User:**\n\nA proposed change.\n\n**Assistant:**\n\nStill awaiting implementation.";
    const aligned = sourceEvidence("sessions/aligned.md",
      `---\ncreated: 2026-10-01\nturn_metadata: [{},{}]\n---\n\n${body}`, "2026-10-05");
    expect(aligned.chunks.map(chunk => chunk.role)).toEqual(["User", "Assistant"]);
    expect(aligned.chunks.every(chunk => chunk.timestamp === undefined)).toBe(true);
    const manual = sourceEvidence("sessions/manual.md", body, "2026-10-05");
    expect(manual.chunks.map(chunk => chunk.role)).toEqual(["User", "Assistant"]);
    expect(manual.chunks.every(chunk => chunk.timestamp === "2026-10-05")).toBe(true);
    const plain = sourceEvidence("raw/plain.md", "---\nturn_metadata: invalid\n---\n\nAn original source passage.", "2026-10-05");
    expect(plain.chunks[0]).toMatchObject({ role: "Source", text: "An original source passage." });
  });

  it("uses the original source creation date instead of the later import date", () => {
    const dated = sourceEvidence(
      "raw/old.md",
      "---\ncreated: 2026-01-02\n---\nOriginal decision",
      "2026-10-04",
    );
    expect(dated.chunks[0].timestamp).toBe("2026-01-02");
    const epoch = sourceEvidence(
      "sessions/old.md",
      "---\ncreated: 1767312000\n---\nOriginal decision",
      "2026-10-04",
    );
    expect(epoch.chunks[0].timestamp).toBe("2026-01-02T00:00:00.000Z");
  });

  it("resumes after 48 chunks and cannot complete a partially quoted file", () => {
    const source = sourceEvidence(
      "sessions/s.md",
      "**User:**\n" + "x".repeat(60 * EVIDENCE_CHUNK_CHARS) + "TAIL",
      "2026-08-01",
    );
    let markdown = "# User-edited note\n";
    const first = nextEvidenceBatch([source], markdown);
    expect(first).toHaveLength(EVIDENCE_BATCH_SIZE);
    markdown += evidenceSection([source], first);
    expect(completedEvidenceSources([source], markdown)).toEqual([]);
    const second = nextEvidenceBatch([source], markdown);
    expect(second[0].id).toBe(source.chunks[EVIDENCE_BATCH_SIZE].id);
    expect(second.at(-1)?.text.endsWith("TAIL")).toBe(true);
    markdown += evidenceSection([source], second);
    expect(completedEvidenceSources([source], markdown)).toEqual([source]);
    expect(nextEvidenceBatch([source], markdown)).toEqual([]);
  });

  it("requires a fresh receipt for a resumed source revision", () => {
    const old = sourceEvidence(
      "sessions/s.md",
      "**User:**\nOld decision",
      "2026-08-01",
    );
    const markdown = evidenceSection([old], old.chunks);
    const resumed = sourceEvidence(
      "sessions/s.md",
      "**User:**\nOld decision\n**User:**\nNew decision",
      "2026-08-02",
    );
    expect(completedEvidenceSources([resumed], markdown)).toEqual([]);
    expect(nextEvidenceBatch([resumed], markdown)).toEqual(resumed.chunks);
  });

  it("does not trust a legacy whole-file marker, corrupt receipt or altered evidence", () => {
    const source = sourceEvidence(
      "sessions/s.md",
      "**User:**\nOriginal decision",
      "2026-08-01",
    );
    const legacy = `<!-- myco:digested-sessions s:${source.revision} -->`;
    expect(completedEvidenceSources([source], legacy)).toEqual([]);
    const section = evidenceSection([source], source.chunks);
    expect(
      completedEvidenceSources(
        [source],
        section.replace("Original decision", "Altered decision"),
      ),
    ).toEqual([]);
    expect(
      completedEvidenceSources(
        [source],
        section.replace('"version":1', '"version":99'),
      ),
    ).toEqual([]);
    expect(
      completedEvidenceSources(
        [source],
        "<!-- myco:evidence-coverage {oops} -->",
      ),
    ).toEqual([]);
  });

  it("keeps source paths distinct when file stems collide", () => {
    const a = sourceEvidence(
      "raw/conversations/vendor-a/s.md",
      "same",
      "2026-08-01",
    );
    const b = sourceEvidence(
      "raw/conversations/vendor-b/s.md",
      "same",
      "2026-08-01",
    );
    const rendered = evidenceSection([a], a.chunks);
    expect(completedEvidenceSources([a, b], rendered)).toEqual([a]);
    expect(nextEvidenceBatch([b], rendered)).toEqual(b.chunks);
  });

  it("quotes unsafe source markup as text, with Unicode source links intact", () => {
    const source = sourceEvidence(
      "raw/회의.md",
      "<script>alert(1)</script> [[Topic]]",
      "2026-08-01",
    );
    const rendered = evidenceSection([source], source.chunks);
    expect(rendered).toContain("\\<script\\>");
    expect(rendered).toContain("[[raw/회의.md]]");
    expect(rendered).not.toContain("<script>");
    expect(source.chunks[0].topics).toEqual(["Topic"]);
  });

  it("older imports add dated evidence without asserting or replacing a current state", () => {
    const newer = sourceEvidence("sessions/new.md", "approved B", "2026-09-01");
    const old = sourceEvidence("sessions/old.md", "decided A", "2026-08-01");
    const existing =
      "# Current page edited by owner\nB is current.\n" +
      evidenceSection([newer], newer.chunks);
    const combined = existing + evidenceSection([old], old.chunks);
    expect(combined.startsWith(existing)).toBe(true);
    expect(combined).toContain("2026-08-01");
    expect(combined).toContain("2026-09-01");
    expect(combined).toContain("B is current.");
    expect(completedEvidenceSources([newer, old], combined)).toEqual([
      newer,
      old,
    ]);
  });

  it("keeps a keyword and emoji intact across a chunk boundary", () => {
    const raw = "x".repeat(595) + "ORION-DECISION 😀" + "z".repeat(700);
    const source = sourceEvidence("sessions/s.md", raw, "2026-08-01");
    expect(
      source.chunks.some((chunk) => chunk.text.includes("ORION-DECISION 😀")),
    ).toBe(true);
    expect(
      source.chunks.every(
        (chunk) => !/[\uD800-\uDBFF]$|^[\uDC00-\uDFFF]/.test(chunk.text),
      ),
    ).toBe(true);
  });

  it("includes source citations before computing the receipt hash", () => {
    const source = sourceEvidence("raw/s.md", "A decision", "2026-08-01");
    const rendered = evidenceSection([source], source.chunks, {
      "raw/s.md": "[^src-s]",
    });
    expect(rendered).toContain("A decision [^src-s]");
    expect(completedEvidenceSources([source], rendered)).toEqual([source]);
  });

  it("can receipt an empty source without fabricating a fact", () => {
    const source = sourceEvidence("sessions/empty.md", "", "2026-08-01");
    const rendered = evidenceSection([source], []);
    expect(completedEvidenceSources([source], rendered)).toEqual([source]);
    expect(rendered).not.toContain("decision mention");
  });
});
