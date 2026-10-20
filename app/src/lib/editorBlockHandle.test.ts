import { describe, expect, it } from "vitest";
import { handleLeft } from "./editorBlockHandle";

describe("handleLeft", () => {
  it("stands the handle in the margin left of the text", () => {
    expect(handleLeft(100, 0, 20, 0)).toBe(76);
    expect(handleLeft(100, 0, 44, 0)).toBe(52);
    expect(handleLeft(100, 0, 20, 14)).toBe(62);
    // The editor box starts at the text: the handle sits left of the box.
    expect(handleLeft(300, 300, 20, 0)).toBe(-24);
  });

  it("gives up where the margin cannot hold it (a phone's narrow gutter)", () => {
    expect(handleLeft(30, 30, 44, 0)).toBeNull();
  });
});
