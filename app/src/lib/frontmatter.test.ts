import { describe, expect, it } from "vitest";
import {
  getValue,
  normalizeTag,
  parseFrontmatter,
  parseScalar,
  patchFrontmatter,
  serializeFrontmatter,
  tagsOf,
} from "./frontmatter";

// vault.rs wiki_page_stub — `tags:` is a null value there.
const STUB =
  "---\ntype: concept\ntags:\ncreated: 2026-08-13\nconfidence: medium\nstatus: active\n---\n\n# Title\n";

const FIXTURES = [
  STUB,
  "---\ntitle: X\ntags:\n  - a\n  - b\n---\nbody\n",
  "---\ntags: [a, b]\n---\n",
  "---\ntitle: \"A: b\"\nother: 'it''s'\n---\n",
  "---\n# top comment\ntype: concept\n# mid comment\nstatus: active\n---\n",
  "---\nsources:\n  a: 1\n  b: 2\ntype: concept\n---\n",
  "---\nnotes: |\n  line one\n  line two\ntype: concept\n---\n",
  "---\ntype: concept\n\nstatus: active\n\n---\n",
  "---\nstatus: active # todo\n---\n",
  "---\r\ntype: concept\r\ntags:\r\n  - a\r\n---\r\nbody\r\n",
  "---\ntags:\n- a\n- b\n---\nbody\n",
];

describe("parseFrontmatter", () => {
  it("is null without a leading, terminated block", () => {
    expect(parseFrontmatter("# no fm\n")).toBeNull();
    expect(parseFrontmatter("---\nonly: open\n# never closes")).toBeNull();
    expect(parseFrontmatter("intro\n---\nx: 1\n---\n")).toBeNull();
  });

  it("detects CRLF", () => {
    expect(parseFrontmatter(FIXTURES[9])?.eol).toBe("\r\n");
    expect(parseFrontmatter(STUB)?.eol).toBe("\n");
  });

  it("round-trips every fixture byte for byte", () => {
    for (const raw of FIXTURES) {
      const fm = parseFrontmatter(raw)!;
      expect(fm).not.toBeNull();
      expect(serializeFrontmatter(fm) + raw.slice(fm.end)).toBe(raw);
    }
  });

  it("keeps order and classifies values", () => {
    const fm = parseFrontmatter(
      '---\ntype: concept\ntags:\nsource_count: 3\ntitle: "A: b"\nsources:\n  a: 1\nstatus: active # todo\nlist:\n  - x\n  - y\n---\n',
    )!;
    expect(fm.entries.map((e) => e.key)).toEqual([
      "type",
      "tags",
      "source_count",
      "title",
      "sources",
      "status",
      "list",
    ]);
    expect(getValue(fm, "type")).toBe("concept");
    expect(getValue(fm, "tags")).toBeNull();
    expect(getValue(fm, "source_count")).toBe(3);
    expect(getValue(fm, "title")).toBe("A: b");
    expect(getValue(fm, "sources")).toBeUndefined();
    expect(getValue(fm, "status")).toBe("active");
    expect(getValue(fm, "list")).toEqual(["x", "y"]);
    expect(getValue(fm, "missing")).toBeUndefined();
    expect(fm.head).toBe("");
  });

  it("reads column-0 lists, comment-only inlines and block scalars", () => {
    expect(getValue(parseFrontmatter(FIXTURES[10]), "tags")).toEqual([
      "a",
      "b",
    ]);
    expect(
      getValue(parseFrontmatter("---\ntags: # mine\n  - a\n---\n"), "tags"),
    ).toEqual(["a"]);
    expect(
      getValue(parseFrontmatter("---\nnotes: |\n  # Heading\n---\n"), "notes"),
    ).toBeUndefined();
  });

  it("returns the first of duplicate keys", () => {
    const raw = "---\ntype: concept\ntype: entity\n---\n";
    expect(getValue(parseFrontmatter(raw), "type")).toBe("concept");
    expect(patchFrontmatter(raw, { type: "map" }).insert).toBe(
      "---\ntype: map\ntype: entity\n---\n",
    );
  });
});

describe("patchFrontmatter", () => {
  it("replaces one scalar line in place and leaves the body alone", () => {
    const before = parseFrontmatter(STUB)!;
    const edit = patchFrontmatter(STUB, { type: "entity" });
    const after = parseFrontmatter(edit.raw)!;
    expect(edit.to).toBe(before.end);
    expect(after.entries.map((e) => e.key)).toEqual(
      before.entries.map((e) => e.key),
    );
    after.entries.forEach((e, i) => {
      if (e.key === "type") expect(e.src).toBe("type: entity\n");
      else expect(e.src).toBe(before.entries[i].src);
    });
    expect(edit.raw.slice(edit.insert.length)).toBe(STUB.slice(before.end));
    expect(
      patchFrontmatter("---\ntype: concept\n\n# mid\nstatus: active\n---\n", {
        type: "entity",
      }).insert,
    ).toBe("---\ntype: entity\n\n# mid\nstatus: active\n---\n");
  });

  it("appends new keys before the fence, removes blocks with continuations", () => {
    expect(patchFrontmatter(STUB, { new: "v" }).insert).toBe(
      STUB.slice(0, parseFrontmatter(STUB)!.end - 4) + "new: v\n---\n",
    );
    const listed = FIXTURES[1];
    const removed = patchFrontmatter(listed, { tags: undefined });
    expect(removed.insert).toBe("---\ntitle: X\n---\n");
    expect(removed.raw).toBe("---\ntitle: X\n---\nbody\n");
    expect(
      patchFrontmatter("---\nonly: 1\n---\nbody", { only: undefined }),
    ).toEqual({
      raw: "body",
      to: 16,
      insert: "",
    });
  });

  it("creates the block when there is none, matching the body's eol", () => {
    expect(patchFrontmatter("# T\n", { key: "v" })).toEqual({
      raw: "---\nkey: v\n---\n# T\n",
      to: 0,
      insert: "---\nkey: v\n---\n",
    });
    expect(patchFrontmatter("# T\r\nx", { key: "v" }).raw).toBe(
      "---\r\nkey: v\r\n---\r\n# T\r\nx",
    );
  });

  it("writes tags as a block list, empty as []", () => {
    expect(patchFrontmatter("", { tags: ["a", "b"] }).insert).toBe(
      "---\ntags:\n  - a\n  - b\n---\n",
    );
    expect(patchFrontmatter("", { tags: [] }).insert).toBe(
      "---\ntags: []\n---\n",
    );
    expect(patchFrontmatter("", { n: 3, ok: true, none: null }).insert).toBe(
      "---\nn: 3\nok: true\nnone:\n---\n",
    );
  });

  it("quotes only what YAML would misread", () => {
    const fmt = (v: string): string =>
      patchFrontmatter("", { k: v }).insert.split("\n")[1].slice(3);
    for (const v of ["true", "3", "1e3", "- x", "a: b", "x #y", "", " lead"]) {
      expect(fmt(v)).toBe(JSON.stringify(v));
    }
    for (const v of ["high", "2026-08-13", "한국어 제목", "source-summary"]) {
      expect(fmt(v)).toBe(v);
    }
    for (const v of [
      "true",
      "3",
      "1e3",
      "- x",
      "a: b",
      "x #y",
      "",
      " lead",
      "high",
      "2026-08-13",
      "한국어 제목",
      "source-summary",
    ]) {
      expect(parseScalar(fmt(v))).toBe(v);
      expect(
        getValue(parseFrontmatter(patchFrontmatter("", { k: v }).raw), "k"),
      ).toBe(v);
    }
  });
});

describe("tagsOf", () => {
  it("reads arrays, comma strings and null", () => {
    expect(tagsOf(parseFrontmatter(FIXTURES[1]))).toEqual(["a", "b"]);
    expect(tagsOf(parseFrontmatter(FIXTURES[10]))).toEqual(["a", "b"]);
    expect(tagsOf(parseFrontmatter('---\ntags: "a, b"\n---\n'))).toEqual([
      "a",
      "b",
    ]);
    expect(tagsOf(parseFrontmatter("---\ntags: a, b\n---\n"))).toEqual([
      "a",
      "b",
    ]);
    expect(tagsOf(parseFrontmatter(STUB))).toEqual([]);
    expect(tagsOf(null)).toEqual([]);
  });
});

describe("normalizeTag", () => {
  it("trims and drops a leading #", () => {
    expect(normalizeTag(" #foo ")).toBe("foo");
    expect(normalizeTag("bar")).toBe("bar");
  });

  it("rejects empty, spaced, comma and bracket input", () => {
    for (const s of ["", "  ", "#", "a b", "a,b", "[x]"]) {
      expect(normalizeTag(s)).toBeNull();
    }
  });
});
