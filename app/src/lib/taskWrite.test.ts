import { describe, expect, it, vi, beforeEach } from "vitest";

const readFile = vi.fn();
const writeFile = vi.fn();
vi.mock("./ipc", () => ({
  ipc: {
    readFile: (...a: unknown[]) => readFile(...a),
    writeFile: (...a: unknown[]) => writeFile(...a),
  },
}));

import { writeTaskFields, writeTaskStatus } from "./taskWrite";
import type { TaskItem } from "./ipc";

beforeEach(() => {
  readFile.mockReset();
  writeFile.mockReset();
});

const TASK: TaskItem = {
  page: "daily.md",
  stem: "daily",
  line: 2,
  text: "ship it @2026-08-19",
  done: false,
  status: "todo",
};

describe("writeTaskStatus", () => {
  it("rewrites exactly the task's checkbox line and writes back", async () => {
    readFile.mockResolvedValue({ raw: "# day\n- [ ] ship it @2026-08-19\n- [ ] other" });
    expect(await writeTaskStatus("/v", TASK, "done")).toBe("ok");
    expect(readFile).toHaveBeenCalledWith("/v/daily.md");
    expect(writeFile).toHaveBeenCalledWith(
      "/v/daily.md",
      "# day\n- [x] ship it @2026-08-19\n- [ ] other",
    );
  });

  it("returns stale and writes nothing when the line is no longer a checkbox", async () => {
    readFile.mockResolvedValue({ raw: "# day\nplain text now\n- [ ] other" });
    expect(await writeTaskStatus("/v", TASK, "done")).toBe("stale");
    expect(writeFile).not.toHaveBeenCalled();
  });

  it("propagates IO errors instead of swallowing them", async () => {
    readFile.mockRejectedValue(new Error("boom"));
    await expect(writeTaskStatus("/v", TASK, "done")).rejects.toThrow("boom");
  });
});

describe("writeTaskFields", () => {
  it("writes the patched fields and leaves the mark and other lines alone", async () => {
    readFile.mockResolvedValue({ raw: "# day\n- [/] ship it @2026-08-19\n- [ ] other" });
    expect(await writeTaskFields("/v", TASK, { due: "2026-08-28", estimate: "2d" })).toBe(
      "ok",
    );
    // The legacy `@date` migrates to the emoji marker on this first edit.
    expect(writeFile).toHaveBeenCalledWith(
      "/v/daily.md",
      "# day\n- [/] ship it 📅 2026-08-28 ⏱ 2d\n- [ ] other",
    );
  });

  it("clears a field given an empty string", async () => {
    readFile.mockResolvedValue({ raw: "- [ ] a\n- [ ] ship it 📅 2026-08-19 !p1" });
    expect(await writeTaskFields("/v", { ...TASK, line: 2 }, { due: "" })).toBe("ok");
    expect(writeFile).toHaveBeenCalledWith("/v/daily.md", "- [ ] a\n- [ ] ship it !p1");
  });

  it("returns stale and writes nothing when the line is no longer a checkbox", async () => {
    readFile.mockResolvedValue({ raw: "# day\nplain text now\n- [ ] other" });
    expect(await writeTaskFields("/v", TASK, { due: "2026-08-28" })).toBe("stale");
    expect(writeFile).not.toHaveBeenCalled();
  });
});
