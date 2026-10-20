import { describe, expect, it } from "vitest";
import { displayName, listedName, reportName, sessionIdOf } from "./displayName";

const CC = "claude-code-064ddbe4-251d-4da1-8315-da096a5b75ff";
const CODEX = "codex-019de763-362b-7613-bcfd-5c5e0e8ff9be";

describe("displayName", () => {
  it("names an opaque session stem by agent and the first 8 hex", () => {
    expect(displayName(CC)).toBe("Claude Code · 064ddbe4");
    expect(displayName(CODEX)).toBe("Codex · 019de763");
    expect(displayName("chatgpt-8f3a2b1c-0000-4000-8000-000000000000")).toBe(
      "ChatGPT · 8f3a2b1c",
    );
    expect(displayName("claude-8f3a2b1c-0000-4000-8000-000000000000")).toBe(
      "Claude.ai · 8f3a2b1c",
    );
  });

  it("sees through the source- prefix and a -2 re-ingest suffix", () => {
    expect(displayName(`source-${CC}`)).toBe("Claude Code · 064ddbe4");
    expect(displayName(`${CC}-2`)).toBe("Claude Code · 064ddbe4");
    expect(displayName(`source-${CODEX}-12`)).toBe("Codex · 019de763");
  });

  it("prefers a readable frontmatter title", () => {
    expect(displayName(`source-${CC}`, "서버 띄워봐. · Claude Code · 2026-07-27")).toBe(
      "서버 띄워봐. · Claude Code · 2026-07-27",
    );
    expect(displayName("attention-mechanism", "Attention Mechanism")).toBe(
      "Attention Mechanism",
    );
  });

  it("treats a `Source: <opaque id>` title as opaque too", () => {
    expect(displayName(`source-${CC}`, `Source: ${CC}`)).toBe("Claude Code · 064ddbe4");
    // Title opaque, stem not: the title still names the agent and id.
    expect(displayName("renamed-page", `Source: ${CODEX}`)).toBe("Codex · 019de763");
  });

  it("falls back to the stem for anything else", () => {
    expect(displayName("attention-mechanism")).toBe("attention-mechanism");
    expect(displayName("attention-mechanism", "   ")).toBe("attention-mechanism");
    expect(displayName("claude-code-aaa")).toBe("claude-code-aaa");
    expect(displayName("claude-code-notes")).toBe("claude-code-notes");
    expect(displayName(`${CC}.backup`)).toBe(`${CC}.backup`);
  });
});

describe("listedName", () => {
  it("shows stable session summaries by their readable title without changing transcript identity", () => {
    const stem = "source-session-codex-0123456789abcdef";
    expect(listedName(stem, "검색 답변과 세션 정리 개선")).toBe("검색 답변과 세션 정리 개선");
    expect(listedName(stem)).toBe("Codex · 01234567");
    expect(listedName(stem, `Source: ${stem}`)).toBe("Codex · 01234567");
    expect(listedName("source-session-editor-0123456789abcdef", "문서 내보내기 개선")).toBe("문서 내보내기 개선");
    expect(listedName("source-session-codex-notes", "Other title")).toBe("source-session-codex-notes");
    expect(sessionIdOf(stem)).toBeNull();
  });

  it("names an opaque stem by its readable title, once it has one", () => {
    const title = "서버 띄워봐. · Claude Code · 2026-07-27";
    expect(listedName(`source-${CC}`, title)).toBe(title);
    expect(listedName(`source-${CC}`, `Source: ${CC}`)).toBe("Claude Code · 064ddbe4");
    expect(listedName(`source-${CC}`)).toBe("Claude Code · 064ddbe4");
  });

  it("keeps a readable stem as the file name, whatever its title says", () => {
    expect(listedName("attention-mechanism", "Attention Mechanism")).toBe("attention-mechanism");
  });
});

describe("sessionIdOf", () => {
  it("is the `<agent>-<uuid>` a stem or title names, without prefix or suffix", () => {
    expect(sessionIdOf(`source-${CC}-2`)).toBe(CC);
    expect(sessionIdOf(`Source: ${CODEX}`)).toBe(CODEX);
    expect(sessionIdOf(CC)).toBe(CC);
    expect(sessionIdOf("attention-mechanism")).toBeNull();
  });
});

describe("reportName", () => {
  it("names an ingest report of an opaque session by its date and the session", () => {
    // extractiveIngest reportRel: `<date>-<HHMMSS>-<slug>`.
    expect(reportName(`2026-09-20-103000-${CC}`)).toBe(
      "2026-09-20-103000 · Claude Code · 064ddbe4",
    );
    expect(reportName(`2026-09-20-source-${CODEX}-2`)).toBe("2026-09-20 · Codex · 019de763");
  });

  it("leaves every other report name as the file says", () => {
    expect(reportName("2026-07-15-attention")).toBe("2026-07-15-attention");
    expect(reportName("distill-digest-1755740000")).toBe("distill-digest-1755740000");
    expect(reportName(CC)).toBe(CC);
  });
});
