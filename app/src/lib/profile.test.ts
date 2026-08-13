import { describe, expect, it, vi, beforeEach } from "vitest";

const readFile = vi.fn();
const writeFile = vi.fn();
vi.mock("./ipc", () => ({
  ipc: {
    readFile: (...a: unknown[]) => readFile(...a),
    writeFile: (...a: unknown[]) => writeFile(...a),
  },
}));

import {
  parseProfile,
  serializeProfile,
  loadProfile,
  saveProfile,
  injectionText,
  type Profile,
} from "./profile";

beforeEach(() => {
  readFile.mockReset();
  writeFile.mockReset();
});

const FULL: Profile = {
  role: "Senior backend engineer",
  goals: ["Ship the distill gate", "Learn Rust"],
  interests: ["rust", "vector search", "ontologies"],
  style: "Concise, bullet points, cite sources",
};

describe("parseProfile / serializeProfile round trip", () => {
  it("round-trips a fully filled profile", () => {
    expect(parseProfile(serializeProfile(FULL))).toEqual(FULL);
  });

  it("round-trips a blank profile", () => {
    const blank: Profile = { role: "", goals: [], interests: [], style: "" };
    expect(parseProfile(serializeProfile(blank))).toEqual(blank);
  });

  it("accepts both - and * bullets", () => {
    const raw = "## Interests\n- rust\n* async runtimes\n";
    expect(parseProfile(raw).interests).toEqual(["rust", "async runtimes"]);
  });

  it("ignores text outside a recognized heading", () => {
    const raw = "stray preamble\n\n## Role\nEngineer\n\n## Unknown\n- nope\n";
    const p = parseProfile(raw);
    expect(p.role).toBe("Engineer");
    expect(p.goals).toEqual([]);
  });

  it("joins multiple hand-edited lines under Role/Working style", () => {
    const raw = "## Role\nSenior engineer\nat a startup\n\n## Working style\nConcise\nno fluff\n";
    const p = parseProfile(raw);
    expect(p.role).toBe("Senior engineer at a startup");
    expect(p.style).toBe("Concise no fluff");
  });

  it("writes the required header comment", () => {
    expect(serializeProfile(FULL)).toContain(
      "<!-- Sent to configured AI providers when profile injection is on (Settings → 증류). -->",
    );
  });
});

describe("injectionText", () => {
  it("names every field in one paragraph", () => {
    const text = injectionText(FULL);
    expect(text).toContain("role: Senior backend engineer");
    expect(text).toContain("goals: Ship the distill gate, Learn Rust");
    expect(text).toContain("interests: rust, vector search, ontologies");
    expect(text).toContain("style: Concise, bullet points, cite sources");
  });

  it("falls back to placeholders for empty fields", () => {
    const text = injectionText({ role: "", goals: [], interests: [], style: "" });
    expect(text).toContain("role: unspecified");
    expect(text).toContain("goals: none");
  });

  it("truncates to 600 chars", () => {
    const huge: Profile = {
      role: "r".repeat(1000),
      goals: [],
      interests: [],
      style: "",
    };
    expect(injectionText(huge).length).toBe(600);
  });
});

describe("loadProfile", () => {
  it("returns null when profile.md does not exist", async () => {
    readFile.mockRejectedValue(new Error("not found"));
    expect(await loadProfile("/v")).toBeNull();
    expect(readFile).toHaveBeenCalledWith("/v/profile.md");
  });

  it("returns null for a present-but-blank profile.md", async () => {
    readFile.mockResolvedValue({ path: "/v/profile.md", raw: "# myco\n\nSample note.\n", content: "", frontmatter: null });
    expect(await loadProfile("/v")).toBeNull();
  });

  it("returns the parsed profile when filled in", async () => {
    readFile.mockResolvedValue({ path: "/v/profile.md", raw: serializeProfile(FULL), content: "", frontmatter: null });
    expect(await loadProfile("/v")).toEqual(FULL);
  });
});

describe("saveProfile", () => {
  it("writes serializeProfile's output to <vault>/profile.md", async () => {
    writeFile.mockResolvedValue(null);
    await saveProfile("/v", FULL);
    expect(writeFile).toHaveBeenCalledWith("/v/profile.md", serializeProfile(FULL));
  });
});
