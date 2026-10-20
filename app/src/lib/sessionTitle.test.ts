import { describe, expect, it } from "vitest";
import { sessionTitle } from "./sessionTitle";

// Noon UTC, so the local calendar day is 2026-07-27 in any timezone within ±11h.
const CREATED = Date.UTC(2026, 6, 27, 12) / 1000;
const ID = "064ddbe4-251d-4da1-8315-da096a5b75ff";

const transcript = (source: string, heading: string, created = String(CREATED)) =>
  `---\nsource: ${source}\nconversation_id: ${ID}\n` +
  (created ? `created: ${created}\n` : "") +
  `---\n\n# ${heading}\n\n**User:**\n\n${heading}\n`;

describe("sessionTitle", () => {
  it("prefers an explicit session name over the first prompt", () => {
    const text = transcript("codex", "Synthetic first prompt").replace("---\nsource:", '---\ntitle: "Synthetic session name"\nsource:');
    expect(sessionTitle(text)).toBe("Synthetic session name · Codex · 2026-07-27");
  });

  it("uses a supplied MCP title without requiring a heading", () => {
    const text = '---\nvia: mcp\nsource: chatgpt\nconversation_id: "synthetic-session"\ntitle: "Synthetic work summary"\ncreated: 2026-07-27\n---\n\nSynthetic transcript.\n';
    expect(sessionTitle(text)).toBe("Synthetic work summary · ChatGPT · 2026-07-27");
  });

  it("displays an arbitrary accepted MCP source but keeps ordinary sources out", () => {
    const text = '---\nvia: mcp\nsource: synthetic-agent\nconversation_id: "synthetic-session"\ntitle: "Synthetic investigation"\n---\n\nSynthetic transcript.\n';
    expect(sessionTitle(text)).toBe("Synthetic investigation · synthetic-agent");
    expect(sessionTitle(text.replace("via: mcp\n", ""))).toBeNull();
    expect(sessionTitle(text.replace("source: synthetic-agent", "source: ../invalid"))).toBeNull();
  });

  it.each([ID, `codex-${ID}`, `source-codex-${ID}`, `Source: codex-${ID}`])(
    "uses the actual heading when the frontmatter title is the opaque fallback %s", title => {
      const text = transcript("codex", "Synthetic work theme").replace("---\nsource:", `---\ntitle: ${JSON.stringify(title)}\nsource:`);
      expect(sessionTitle(text)).toBe("Synthetic work theme · Codex · 2026-07-27");
    },
  );

  it("falls back from a sanitized MCP ID title to the actual heading", () => {
    const text = '---\nvia: mcp\nsource: synthetic-agent\nconversation_id: "synthetic/session"\ntitle: "synthetic-session-0123456789abcdef"\n---\n\n# Synthetic work theme\n';
    expect(sessionTitle(text)).toBe("Synthetic work theme · synthetic-agent");
  });

  it.each(["2026-02-30", "2026-13-01", "2026-00-01"])("does not display invalid date %s or malformed MCP session metadata", created => {
    const text = `---\nvia: mcp\nsource: synthetic-agent\nconversation_id: "synthetic-session"\ntitle: "Synthetic work theme"\ncreated: ${created}\n---\n\nSynthetic transcript.\n`;
    expect(sessionTitle(text)).toBe("Synthetic work theme · synthetic-agent");
    expect(sessionTitle(text.replace('conversation_id: "synthetic-session"', "conversation_id: [invalid]"))).toBeNull();
  });

  it("is the first heading, the agent and the created date", () => {
    expect(sessionTitle(transcript("claude-code", "서버 띄워봐."))).toBe(
      "서버 띄워봐. · Claude Code · 2026-07-27",
    );
    expect(sessionTitle(transcript("codex", "Fix the legend"))).toBe(
      "Fix the legend · Codex · 2026-07-27",
    );
  });

  it("reads a raw/ copy, which ingest prefixed with a `# <stem>` line", () => {
    const raw = `# claude-code-${ID}\n\n${transcript("claude-code", "서버 띄워봐.")}`;
    expect(sessionTitle(raw)).toBe("서버 띄워봐. · Claude Code · 2026-07-27");
  });

  it("cuts a long heading to 60 characters, marked with an ellipsis", () => {
    const long = "가".repeat(80);
    const title = sessionTitle(transcript("claude-code", long)) ?? "";
    const heading = title.split(" · ")[0];
    expect([...heading]).toHaveLength(60);
    expect(heading.endsWith("…")).toBe(true);
    expect(heading.startsWith("가".repeat(59))).toBe(true);
  });

  it("leaves the date out when the transcript has none", () => {
    expect(sessionTitle(transcript("codex", "Fix the legend", ""))).toBe(
      "Fix the legend · Codex",
    );
  });

  it("is null for anything that is not a session transcript", () => {
    expect(sessionTitle("# Retrieval notes\n\nHybrid retrieval fuses two arms.")).toBeNull();
    expect(sessionTitle(transcript("clipper", "RoPE scaling notes"))).toBeNull();
    expect(sessionTitle(`---\nsource: codex\n---\n\nNo heading here.\n`)).toBeNull();
  });
});
