import { describe, expect, it } from "vitest";
import {
  filterSlash,
  slashItems,
  slashQueryAt,
  tagQueryAt,
} from "./editorCompletions";
import { STRINGS } from "./i18n";

describe("tagQueryAt", () => {
  it("completes the last inline tag (comma or flow-list form)", () => {
    expect(tagQueryAt("---\ntags: a, b")).toEqual({ from: 13, query: "b" });
    expect(tagQueryAt("---\ntags: [x, y")).toMatchObject({ query: "y" });
  });

  it("completes a block-list item under tags:", () => {
    expect(tagQueryAt("---\ntags:\n  - fo")).toEqual({ from: 14, query: "fo" });
    expect(tagQueryAt("---\ntags:\n  - my ta")).toMatchObject({ query: "my ta" });
  });

  it("ignores list items under another key", () => {
    expect(tagQueryAt("---\ntitle: t\n  - fo")).toBeNull();
  });

  it("never triggers in the body or without an opening fence", () => {
    expect(tagQueryAt("---\na: 1\n---\nbody #ta")).toBeNull();
    expect(tagQueryAt("tags: a")).toBeNull();
  });
});

describe("slashQueryAt", () => {
  it("matches / at line start or after whitespace", () => {
    expect(slashQueryAt("/")).toEqual({ from: 0, query: "" });
    expect(slashQueryAt("  /tab")).toEqual({ from: 2, query: "tab" });
    expect(slashQueryAt("a /x")).toEqual({ from: 2, query: "x" });
  });

  it("ignores slashes inside words and URLs, and a closed word", () => {
    expect(slashQueryAt("9/2")).toBeNull();
    expect(slashQueryAt("http://x")).toBeNull();
    expect(slashQueryAt("/x ")).toBeNull();
  });
});

describe("slashItems / filterSlash", () => {
  const ko = slashItems(STRINGS.ko, new Date(2026, 0, 5));

  it("has 11 items, no link item, and today's local date", () => {
    expect(ko).toHaveLength(11);
    expect(ko.some((i) => i.label === "link")).toBe(false);
    expect(ko.find((i) => i.label === "date")?.template).toBe("2026-01-05");
  });

  it("filters by label prefix or localized description", () => {
    expect(filterSlash(ko, "표").map((i) => i.label)).toEqual(["table"]);
    expect(filterSlash(ko, "h").map((i) => i.label)).toEqual(["h1", "h2", "h3"]);
    expect(filterSlash(ko, "")).toHaveLength(11);
  });
});
