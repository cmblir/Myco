import { describe, expect, it } from "vitest";
import { graphHref } from "./graphLink";

describe("graphHref", () => {
  it("names the question, and the note when there is one", () => {
    expect(graphHref("orphans")).toBe("graph?q=orphans");
    expect(graphHref("neighbors", "/v/wiki/a b.md")).toBe(
      "graph?q=neighbors&n=%2Fv%2Fwiki%2Fa+b.md",
    );
  });
});
