import { describe, expect, it } from "vitest";
import { appendDeckCards, patchDeckGrade, readDeckCards } from "./cardDeckPatch";
import { gradeCard, parseDeck, serializeDeck, type Card } from "./cards";

const card: Card = { front: "Synthetic question", back: "Synthetic answer", sourceRef: "[[synthetic]]", state: null };

describe("byte-preserving deck patches", () => {
  it("appends after the complete original bytes and uses the existing CRLF style", () => {
    const raw = "# Human heading\r\n\r\n<!-- Human note -->\r\n" + serializeDeck([card]).replace(/\n/g, "\r\n") +
      "\r\n```opaque\r\nunknown bytes\r\n```\r\n";
    const added = { ...card, front: "Another question" };
    const patch = appendDeckCards(raw, [added]);
    expect(patch.added).toBe(1);
    expect(patch.content.startsWith(raw)).toBe(true);
    expect(patch.content.slice(raw.length)).toBe("\r\n" + serializeDeck([added]).replace(/\n/g, "\r\n"));
  });

  it("does not touch any bytes for a normalized duplicate or an empty addition", () => {
    const raw = "# Preserve this\n\n" + serializeDeck([card]) + "\n<!-- Unknown -->\n";
    expect(appendDeckCards(raw, [{ ...card, front: "synthetic QUESTION" }])).toEqual({ content: raw, added: 0 });
    expect(appendDeckCards(raw, [])).toEqual({ content: raw, added: 0 });
  });

  it("updates only the recognized trailer while preserving the original question line and adjacent human comment", () => {
    const prefix = "# Human heading\r\n\r\n";
    const head = "Synthetic question ?? Synthetic   answer\r\n";
    const suffix = "<!-- Human comment must remain -->\r\n\r\nOther question ?? Other answer\r\n";
    const raw = prefix + head + "<!--src:[[synthetic]]-->\r\n" + suffix;
    const original = readDeckCards(raw)[0];
    const graded = gradeCard(original, 3, "2026-10-11");
    const trailer = serializeDeck([graded]).split("\n")[1];
    expect(patchDeckGrade(raw, graded, original)).toEqual({
      content: prefix + head + trailer + "\r\n" + suffix,
      updated: true,
    });
  });

  it("adds a grade trailer to an EOF card without altering its question bytes", () => {
    const original = { ...card, sourceRef: "" };
    const raw = `${original.front} ?? ${original.back}`;
    const graded = gradeCard(original, 3, "2026-10-11");
    expect(patchDeckGrade(raw, graded, original).content).toBe(raw + "\n" + serializeDeck([graded]).split("\n")[1] + "\n");
  });

  const examples = "---\nexample: Synthetic question ?? Synthetic answer\n---\n\n" +
    "```markdown\nSynthetic question ?? Synthetic answer\n<!--src:[[synthetic]]-->\n```\n\n" +
    "<!--\nSynthetic question ?? Synthetic answer\n-->\n";
  it("does not read or grade fenced, frontmatter or comment examples as cards", () => {
    expect(readDeckCards(examples)).toEqual([]);
    expect(patchDeckGrade(examples, gradeCard(card, 3, "2026-10-11"))).toEqual({ content: examples, updated: false });
  });

  it("does not deduplicate a real addition against a fenced example", () => {
    const patch = appendDeckCards(examples, [card]);
    expect(patch.added).toBe(1);
    expect(patch.content.startsWith(examples)).toBe(true);
    expect(readDeckCards(patch.content)).toEqual([card]);
  });

  it.each(["---\nmetadata: unfinished\n", "```markdown\nunfinished example\n", "<!-- unfinished human comment\n"])(
    "refuses to append inside an unfinished opaque block: %s",
    (raw) => {
      expect(() => appendDeckCards(raw, [card])).toThrow("layout is incomplete");
    },
  );

  it("keeps a deleted card deleted", () => {
    expect(patchDeckGrade("# Empty human deck\n", gradeCard(card, 3, "2026-10-11"), card)).toEqual({
      content: "# Empty human deck\n", updated: false,
    });
  });

  it("refuses duplicate exact fronts instead of grading both cards", () => {
    const raw = serializeDeck([card, { ...card, back: "Different answer" }]);
    expect(() => patchDeckGrade(raw, gradeCard(card, 3, "2026-10-11"), card)).toThrow("ambiguous");
  });

  it.each([
    { ...card, back: "Human edited answer" },
    { ...card, sourceRef: "[[human-edited-source]]" },
    gradeCard(card, 1, "2026-10-10"),
  ])("refuses a changed card's back, source or scheduling state: %j", (changed) => {
    expect(() => patchDeckGrade(serializeDeck([changed]), gradeCard(card, 3, "2026-10-11"), card)).toThrow("changed");
  });

  it.each([
    { ...card, front: "Question\nAnother line" },
    { ...card, back: "Answer\r\nAnother line" },
    { ...card, sourceRef: "[[source]]\n<!--SR:injected-->" },
    { ...card, front: "Question ?? Injected answer" },
    { ...card, front: "Question --> escape" },
    { ...card, back: "Answer --> escape" },
    { ...card, sourceRef: "source--> escape" },
    { ...gradeCard(card, 3, "2026-10-11"), state: { ...gradeCard(card, 3, "2026-10-11").state!, stability: Number.POSITIVE_INFINITY } },
    { ...gradeCard(card, 3, "2026-10-11"), state: { ...gradeCard(card, 3, "2026-10-11").state!, difficulty: Number.NaN } },
    { ...gradeCard(card, 3, "2026-10-11"), state: { ...gradeCard(card, 3, "2026-10-11").state!, reps: -1 } },
    { ...gradeCard(card, 3, "2026-10-11"), state: { ...gradeCard(card, 3, "2026-10-11").state!, lapses: 1.5 } },
    { ...gradeCard(card, 3, "2026-10-11"), state: { ...gradeCard(card, 3, "2026-10-11").state!, due: "2026-02-30" } },
  ])("rejects fields or state that cannot safely fit the on-disk card format: %j", (invalid) => {
    expect(() => appendDeckCards("", [invalid])).toThrow("Invalid Study card");
  });

  it.each([
    "<!--SR:!2026-10-12|NaN|5|1|0|2026-10-11|[[synthetic]]-->",
    "<!--SR:!not enough fields-->",
  ])("refuses malformed recognized SR metadata without rewriting it: %s", (trailer) => {
    const raw = `${card.front} ?? ${card.back}\n${trailer}\n`;
    expect(() => patchDeckGrade(raw, gradeCard(card, 3, "2026-10-11"))).toThrow("Invalid Study card state");
  });

  it("retains source aliases and the existing four-decimal FSRS representation", () => {
    const aliased = { ...card, sourceRef: "[[Q|A]]" };
    const graded = gradeCard(aliased, 3, "2026-10-11");
    const patch = patchDeckGrade(serializeDeck([aliased]), graded, aliased);
    expect(readDeckCards(patch.content)).toEqual(parseDeck(serializeDeck([graded])));
  });
});
