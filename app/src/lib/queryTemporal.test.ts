import { describe, expect, it } from "vitest";
import { formatTemporalRecall } from "./queryTemporal";
import type { TemporalRecallResult } from "./ipc";

const range = { start: "2026-10-03", end: "2026-10-03" };
const result: TemporalRecallResult = {
  events: [
    { page: "sessions/2026-09/shared.md", stem: "shared", section: 2,
      text: "**User:**\n\nPlease investigate the synthetic caching issue.", role: "User", timestamp: 1790985600 },
    { page: "sessions/2026-10/shared.md", stem: "shared", section: 3,
      text: "**Assistant:**\n\nI propose changing the cache key.", role: "Assistant", timestamp: 1790985700 },
  ],
  indexed_pages: 20,
  scanned_pages: 12,
  matched_events: 3,
  incomplete: true,
};

describe("formatTemporalRecall", () => {
  const section = (answer: string, heading: string): string => answer.split(`### ${heading}\n\n`)[1]?.split("\n\n### ")[0] ?? "";
  const fixture = (texts: string[]): TemporalRecallResult => ({
    events: texts.map((text, index) => ({ page: `sessions/synthetic-${index}.md`, stem: `Synthetic ${index}`,
      section: 0, text, role: text.startsWith("**User:") ? "User" : "Assistant", timestamp: 1790985600 + index })),
    indexed_pages: texts.length, scanned_pages: texts.length, matched_events: texts.length, incomplete: false,
  });

  it("summarizes performed reports, progress and unconfirmed requests separately", () => {
    const answer = formatTemporalRecall(fixture([
      "**User:**\n\nPlease fix the synthetic export bug and deploy the app.",
      "**Assistant:**\n\nNeed your decision\n\nChoose the export format before deployment.",
      "**Assistant:**\n\nRunning now\n\nI am investigating the synthetic export bug.",
      "**Assistant:**\n\nI fixed the synthetic cache key. I ran 12 regression tests; all passed.",
    ]), range, "en");
    const reported = section(answer, "Performed / results reported");
    const progress = section(answer, "In progress / planned");
    const unknown = section(answer, "Requests / decisions pending / completion unconfirmed");
    expect(reported).toContain("I fixed the synthetic cache key.");
    expect(reported).not.toMatch(/deploy|Choose|investigating/);
    expect(progress).toContain("investigating the synthetic export bug");
    expect(unknown).toContain("Please fix the synthetic export bug");
    expect(unknown).toContain("Choose the export format");
    expect(answer).toContain("reports in the conversation");
    expect(answer).toContain("· Assistant · [[sessions/synthetic-3|Synthetic 3]]");
    expect(answer).not.toContain("> **User:**");
    expect(answer).not.toContain("Running now\n");
  });

  it.each([
    "Please mark the migration completed.",
    "Can you confirm the tests passed?",
    "Make sure the tests passed before deployment.",
    "I can report that the tests passed after checking them.",
    '"I completed the migration."',
    "I will report that the migration is completed after testing.",
    "The migration is not completed.",
    "I haven't deployed the app.",
    "If the build passed, deploy it.",
    "Example: I completed the migration.",
    "마이그레이션 완료 후 배포할 예정입니다.",
    "테스트가 통과하면 배포하겠습니다.",
    "배포를 완료하지 않았습니다.",
    "테스트 통과 여부는 확인하지 못했습니다.",
  ])("does not promote a request, conditional, example or negation to performed work: %s", (text) => {
    const answer = formatTemporalRecall(fixture([`**Assistant:**\n\n${text}`]), range, "en");
    expect(section(answer, "Performed / results reported")).not.toContain(text);
    expect(answer).toContain("No explicit performed-work or result report was found");
  });

  it.each([
    "Once I have completed the migration, deploy it.",
    "When I have completed the migration, deploy it.",
    "After I have completed the migration, deploy it.",
  ])("keeps a leading conditional completion clause unconfirmed: %s", (text) => {
    const answer = formatTemporalRecall(fixture([`**Assistant:**\n\n${text}`]), range, "en");
    expect(section(answer, "Performed / results reported")).not.toContain(text);
    expect(section(answer, "In progress / planned")).not.toContain(text);
    expect(section(answer, "Requests / decisions pending / completion unconfirmed")).toContain(text);
    expect(answer).toContain("No explicit performed-work or result report was found");
    expect(answer).toContain("· Assistant · [[sessions/synthetic-0|Synthetic 0]]");
  });

  it("retains a past action report with an embedded after clause", () => {
    const text = "I completed the migration after the tests passed.";
    const answer = formatTemporalRecall(fixture([`**Assistant:**\n\n${text}`]), range, "en");
    expect(section(answer, "Performed / results reported")).toContain(text);
    expect(section(answer, "Requests / decisions pending / completion unconfirmed")).not.toContain(text);
  });

  it("keeps mixed completed and unfinished clauses out of the performed category", () => {
    const answer = formatTemporalRecall(fixture(["**Assistant:**\n\nI fixed the parser, but deployment is not completed."]), range, "en");
    expect(section(answer, "Performed / results reported")).not.toContain("deployment");
    expect(section(answer, "Requests / decisions pending / completion unconfirmed")).toContain("deployment");
  });

  it("ignores completion words in quoted examples and code blocks", () => {
    const answer = formatTemporalRecall(fixture(["**Assistant:**\n\n> I deployed the app.\n\n```text\nI completed the migration.\n```\n\nI am checking the parser."]), range, "en");
    expect(section(answer, "Performed / results reported")).not.toMatch(/deployed|completed/);
    expect(section(answer, "In progress / planned")).toContain("checking the parser");
  });

  it("uses explicit action reports beneath a completed heading but does not promote example sections", () => {
    const answer = formatTemporalRecall(fixture([
      "**Assistant:**\n\n## Done\n\nI fixed the parser.\n\n## Example\n\nI deployed the app.",
      "**Assistant:**\n\n## 완료\n\n파서 오류를 수정했습니다.",
    ]), range, "en");
    const performed = section(answer, "Performed / results reported");
    expect(performed).toContain("I fixed the parser.");
    expect(performed).toContain("파서 오류를 수정했습니다.");
    expect(performed).not.toContain("I deployed the app.");
  });

  it("does not turn negated completion into progress beneath a running heading", () => {
    const answer = formatTemporalRecall(fixture(["**Assistant:**\n\nRunning now\n\nI haven't deployed the app."]), range, "en");
    expect(section(answer, "In progress / planned")).not.toContain("deployed");
    expect(section(answer, "Requests / decisions pending / completion unconfirmed")).toContain("haven't deployed");
  });

  it("keeps an unchecked task unconfirmed even when its text contains a completion report", () => {
    const answer = formatTemporalRecall(fixture(["**Assistant:**\n\n- [ ] I completed the migration."]), range, "en");
    expect(section(answer, "Performed / results reported")).not.toContain("migration");
    expect(section(answer, "Requests / decisions pending / completion unconfirmed")).toContain("migration");
  });

  it("preserves source-role attribution without certifying an assistant report as a user's verified fact", () => {
    const answer = formatTemporalRecall(fixture(["**Assistant:**\n\nI ran 12 regression tests; all passed."]), range, "ko");
    expect(answer).toContain("대화에서 보고한 내용");
    expect(answer).toContain("실제 작업 완료를 확인한 결과는 아닙니다");
    expect(answer).toContain("· Assistant ·");
    expect(answer).not.toContain("· User ·");
  });

  it("bounds the overview and discloses omitted items instead of dumping every message", () => {
    const answer = formatTemporalRecall(fixture(Array.from({ length: 40 }, (_, index) =>
      `**User:**\n\nPlease investigate synthetic task ${index}: ${"detail ".repeat(150)}`)), range, "en");
    expect(answer).toContain("More items are present in the retrieved excerpts");
    expect(answer.length).toBeLessThan(4000);
    expect((answer.match(/^- /gm) ?? []).length).toBeLessThanOrEqual(12);
  });
  it("keeps requests and proposals as attributed unconfirmed/planned evidence, preserving exact source identity", () => {
    const answer = formatTemporalRecall(result, range, "en");
    expect(answer).toContain("rather than verifying completed work");
    expect(answer).toContain("· User · [[sessions/2026-09/shared|shared]]");
    expect(answer).toContain("· Assistant · [[sessions/2026-10/shared|shared]]");
    expect(section(answer, "Requests / decisions pending / completion unconfirmed")).toContain("- Please investigate the synthetic caching issue.");
    expect(section(answer, "In progress / planned")).toContain("- I propose changing the cache key.");
    expect(answer).toContain("Checked 12 of 20");
    expect(answer).toContain("considered 2 of 3");
    expect(answer).toContain("Coverage is incomplete");
    expect(answer).not.toContain("similarity");
  });

  it.each(["en", "ko", "ja"] as const)("never treats incomplete empty evidence as proof of no activity in %s", (lang) => {
    const answer = formatTemporalRecall({ ...result, events: [], matched_events: 0 }, range, lang);
    expect(answer).toContain("2026-10-03");
    expect(answer).toContain({ en: "do not establish that nothing happened", ko: "그날 아무 일도 없었다는 뜻은 아닙니다", ja: "何も起きなかった証拠にはなりません" }[lang]);
    expect(answer).not.toContain("[[");
  });

  it("keeps a short cited statement and excludes fenced content", () => {
    const event = { ...result.events[0], text: `Original evidence\n\n\`\`\`text\n${"synthetic ".repeat(200)}\n\`\`\`` };
    const answer = formatTemporalRecall({ ...result, incomplete: false, events: [event] }, range, "en");
    expect(section(answer, "Requests / decisions pending / completion unconfirmed")).toContain("- Original evidence");
    expect(answer).not.toContain("```text");
    expect(answer.length).toBeLessThan(1000);
  });
});
