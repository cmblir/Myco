import { describe, expect, it, vi, beforeEach } from "vitest";

const readFile = vi.fn();
const writeFile = vi.fn();
vi.mock("./ipc", () => ({
  ipc: {
    readFile: (...a: unknown[]) => readFile(...a),
    writeFile: (...a: unknown[]) => writeFile(...a),
  },
}));

import { writeTaskStatus } from "./taskWrite";
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
