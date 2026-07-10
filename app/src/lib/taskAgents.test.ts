import { describe, expect, it } from "vitest";
import {
  agentFiles,
  agentSlug,
  parseAgent,
  serializeAgent,
} from "./taskAgents";
import type { FileNode } from "./ipc";

describe("agentSlug", () => {
  it("slugifies names", () => {
    expect(agentSlug("Contradiction Finder")).toBe("contradiction-finder");
    expect(agentSlug("  Weekly Reviewer! ")).toBe("weekly-reviewer");
    expect(agentSlug("")).toBe("agent");
  });
});

describe("serialize ↔ parse round-trip", () => {
  it("preserves name, model, tools, allowWrite, and prompt", () => {
    const preset = {
      name: "Contradiction Finder",
      model: "claude-sonnet-4-6",
      tools: ["search_vault", "read_page"],
      allowWrite: false,
      systemPrompt: "Find pages that contradict each other.\nCite sources.",
    };
    const md = serializeAgent(preset);
    const parsed = parseAgent("contradiction-finder", "/v/agents/contradiction-finder.md", md);
    expect(parsed.name).toBe("Contradiction Finder");
    expect(parsed.model).toBe("claude-sonnet-4-6");
    expect(parsed.tools).toEqual(["search_vault", "read_page"]);
    expect(parsed.allowWrite).toBe(false);
    expect(parsed.systemPrompt).toContain("Find pages that contradict");
  });

  it("round-trips a write-enabled preset", () => {
    const md = serializeAgent({
      name: "Editor",
      model: "m",
      tools: [],
      allowWrite: true,
      systemPrompt: "Edit pages.",
    });
    const parsed = parseAgent("editor", "/v/agents/editor.md", md);
    expect(parsed.allowWrite).toBe(true);
    expect(parsed.tools).toEqual([]);
  });

  it("is lenient about missing frontmatter", () => {
    const parsed = parseAgent("bare", "/v/agents/bare.md", "just a prompt, no frontmatter");
    expect(parsed.name).toBe("bare");
    expect(parsed.tools).toEqual([]);
    expect(parsed.allowWrite).toBe(false);
    expect(parsed.systemPrompt).toBe("just a prompt, no frontmatter");
  });
});

describe("agentFiles", () => {
  it("returns only agents/*.md", () => {
    const tree: FileNode[] = [
      { kind: "file", name: "welcome.md", path: "/v/welcome.md" },
      {
        kind: "directory",
        name: "agents",
        path: "/v/agents",
        children: [
          { kind: "file", name: "a.md", path: "/v/agents/a.md" },
          { kind: "file", name: "notes.txt", path: "/v/agents/notes.txt" },
        ],
      },
    ];
    expect(agentFiles(tree)).toEqual(["/v/agents/a.md"]);
  });
});
