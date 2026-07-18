import { describe, expect, it } from "vitest";
import { dropNoticeFor } from "./ingestDrop";

const T = "Loaded the first of {n} files — one at a time.";

describe("dropNoticeFor", () => {
  it("says nothing for a single file — the normal case is silent", () => {
    expect(dropNoticeFor(1, T)).toBeNull();
    expect(dropNoticeFor(0, T)).toBeNull();
  });

  it("announces the count when more than one file is dropped", () => {
    // The bug this fixes: the extra files used to vanish with no message.
    const msg = dropNoticeFor(12, T);
    expect(msg).not.toBeNull();
    expect(msg).toContain("12");
  });

  it("falls back to English when the locale lacks the key", () => {
    expect(dropNoticeFor(3, undefined)).toContain("3");
  });
});
