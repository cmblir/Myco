import { describe, it, expect } from "vitest";
import { resolveAnswerCitation, verifyAnswerCitations } from "./answerCitation";
describe("answer source navigation", () => {
  const files = ["/v/wiki/a.md", "/v/sessions/a.md", "/v/raw/unique.md"];
  it("opens an existing qualified source and unique legacy basename", () => {
    expect(resolveAnswerCitation("sessions/a#turn", "/v", files)).toBe("/v/sessions/a.md");
    expect(resolveAnswerCitation("unique", "/v", files)).toBe("/v/raw/unique.md");
  });
  it("rejects missing, ambiguous, traversing and incorrectly qualified citations", () => {
    for (const target of ["project/답변-개선", "a", "wiki/unique", "../raw/unique", "/v/raw/unique", "raw/../raw/unique"])
      expect(resolveAnswerCitation(target, "/v", files)).toBeNull();
  });
});

 it("rejects fabricated or malformed generated references even when another note could share a name", () => {
   expect(() => verifyAnswerCitations("Answer [[raw/record|Source]]", ["raw/record.md"])).not.toThrow();
   for (const text of ["[[raw/fake|Source]]", "[[raw/record|Source]", "[[record]]"])
     expect(() => verifyAnswerCitations(text, ["raw/record.md"])).toThrow();
 });

describe("selected factual answer citation requirement", () => {
  it("requires a supplied-source citation for a nonempty selected-workflow answer", () => {
    expect(() => verifyAnswerCitations("The fictional prototype was completed.", ["sessions/prototype.md"], true)).toThrow();
    expect(() => verifyAnswerCitations("The fictional prototype was completed. [[sessions/prototype|Prototype]]", ["sessions/prototype.md"], true)).not.toThrow();
    expect(() => verifyAnswerCitations("The fictional prototype was completed. [[sessions/other|Prototype]]", ["sessions/prototype.md"], true)).toThrow();
  });

  it("does not mistake an incomplete or mixed-validity marker for sufficient evidence", () => {
    for (const answer of ["Answer [[", "Answer [[sessions/prototype|Prototype]", "[[sessions/prototype]] plus [[sessions/fabricated]]"])
      expect(() => verifyAnswerCitations(answer, ["sessions/prototype.md"], true)).toThrow();
    expect(() => verifyAnswerCitations("Legacy uncited answer", ["sessions/prototype.md"])).not.toThrow();
    expect(() => verifyAnswerCitations("", [], true)).not.toThrow();
  });
});
