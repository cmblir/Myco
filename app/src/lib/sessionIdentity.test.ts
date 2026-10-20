import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { sessionIdentity } from "./sessionIdentity";

const sourceDocument = (source: string, id = "synthetic-session", via = "mcp") =>
  `---\nsource: ${source}\nconversation_id: ${JSON.stringify(id)}\nvia: ${via}\n---\n\nSynthetic transcript.\n`;

describe("sessionIdentity", () => {
  it("keeps one identity across source revisions, titles and body updates", async () => {
    const key = "codex:synthetic-session";
    const expected = { key, slug: `session-codex-${createHash("sha256").update(key).digest("hex").slice(0, 16)}` };
    const text = sourceDocument("codex");
    expect(await sessionIdentity(text)).toEqual(expected);
    expect(await sessionIdentity(text.replace("via: mcp", 'via: mcp\ntitle: "Synthetic revised name"\nsource_revision: revised\nraw_path: raw/conversations/codex/synthetic-session.r2.md').replace("Synthetic transcript.", "Synthetic revised transcript."))).toEqual(expected);
  });

  it.each(["chatgpt", "claude", "claude-code", "codex"])(
    "recognizes a legacy %s session without MCP metadata", async source => {
      expect(await sessionIdentity(sourceDocument(source, "synthetic-session", "local"))).toMatchObject({ key: `${source}:synthetic-session` });
    },
  );

  it("recognizes an ingest-prefixed legacy raw copy without changing its key", async () => {
    const text = sourceDocument("codex", "synthetic-session", "local");
    expect(await sessionIdentity(`# codex-synthetic-session\n\n${text}`)).toEqual(await sessionIdentity(text));
  });

  it("separates provider namespaces and IDs that sanitize to the same filename", async () => {
    const first = await sessionIdentity(sourceDocument("codex", "synthetic/session"));
    const provider = await sessionIdentity(sourceDocument("claude", "synthetic/session"));
    const sanitized = await sessionIdentity(sourceDocument("codex", "synthetic-session"));
    expect(first?.key).toBe("codex:synthetic/session");
    expect(first?.slug).not.toBe(provider?.slug);
    expect(first?.slug).not.toBe(sanitized?.slug);
    expect(first?.slug).toMatch(/^session-codex-[a-f0-9]{16}$/);
  });

  it("recognizes an arbitrary MCP source only when it is an accepted source slug", async () => {
    expect(await sessionIdentity(sourceDocument("synthetic-agent"))).toMatchObject({ key: "synthetic-agent:synthetic-session" });
    expect(await sessionIdentity(sourceDocument("synthetic-agent", "synthetic-session", "local"))).toBeNull();
  });

  it.each([
    sourceDocument("../codex"),
    sourceDocument("CODEX"),
    sourceDocument("x".repeat(33)),
    sourceDocument("codex", ""),
    sourceDocument("codex", "synthetic\nsession"),
    sourceDocument("codex").replace('conversation_id: "synthetic-session"', "conversation_id: 42"),
    sourceDocument("codex").replace('conversation_id: "synthetic-session"', "conversation_id: [invalid]"),
    sourceDocument("codex").replace("source: codex", "source: codex\nsource: claude"),
    "# Synthetic ordinary note\n\nSynthetic body.\n",
    "---\nsource: codex\nconversation_id: synthetic-session\n",
  ])("leaves malformed or non-session metadata on the existing path", async text => {
    expect(await sessionIdentity(text)).toBeNull();
  });
});
