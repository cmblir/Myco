import { describe, expect, it } from "vitest";
import { queryForm, setQueryTerm } from "./queryForm";

describe("query panel form ↔ the query line", () => {
  it("reads the common terms; the rest is left to the line", () => {
    expect(
      queryForm(
        '"exact phrase" path:wiki/ tag:ml type:concept sort:-modified limit:10 view:table status:active',
      ),
    ).toEqual({
      path: "wiki/",
      tag: "ml",
      type: "concept",
      sort: "-modified",
      limit: "10",
    });
    expect(queryForm("")).toEqual({
      path: "",
      tag: "",
      type: "",
      sort: "",
      limit: "",
    });
    // ⌘K's operators are lower case; sort: and limit: take any case.
    expect(queryForm("Tag:x SORT:name Limit:5")).toMatchObject({
      tag: "",
      sort: "name",
      limit: "5",
    });
  });

  it("sets a term in place and keeps every term it does not know", () => {
    const line =
      '"exact phrase" tag:ml view:table status:active confidence:high word';
    expect(setQueryTerm(line, "tag", "ai")).toBe(
      '"exact phrase" tag:ai view:table status:active confidence:high word',
    );
    expect(setQueryTerm(line, "path", "wiki/")).toBe(`${line} path:wiki/`);
    expect(setQueryTerm(line, "tag", "")).toBe(
      '"exact phrase" view:table status:active confidence:high word',
    );
    expect(setQueryTerm("", "limit", "5")).toBe("limit:5");
  });

  it("keeps a quoted phrase whole, spaces and option words in it", () => {
    const line = 'tag:a "sort:name and limit:3" b';
    expect(queryForm(line)).toMatchObject({ sort: "", limit: "" });
    expect(setQueryTerm(line, "sort", "links")).toBe(
      'tag:a "sort:name and limit:3" b sort:links',
    );
  });

  it("writes one term for each field; a value's spaces would split it", () => {
    expect(setQueryTerm("tag:a tag:b", "tag", "c")).toBe("tag:c tag:b");
    expect(setQueryTerm("x", "path", " my notes/ ")).toBe("x path:mynotes/");
  });

  it("the form read back says what was set", () => {
    let line = "word";
    for (const [k, v] of [
      ["path", "daily/"],
      ["tag", "회의"],
      ["type", "concept"],
      ["sort", "-name"],
      ["limit", "20"],
    ] as const)
      line = setQueryTerm(line, k, v);
    expect(line).toBe(
      "word path:daily/ tag:회의 type:concept sort:-name limit:20",
    );
    expect(queryForm(line)).toEqual({
      path: "daily/",
      tag: "회의",
      type: "concept",
      sort: "-name",
      limit: "20",
    });
  });
});
