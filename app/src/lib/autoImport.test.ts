import { describe, expect, it, vi, beforeEach } from "vitest";

const importSessionSweep = vi.fn();
vi.mock("./ipc", () => ({
  ipc: { importSessionSweep: (...a: unknown[]) => importSessionSweep(...a) },
}));

import { runSessionSweep } from "./autoImport";
import { useImportStore } from "../stores/importStore";
import { useIngestStore } from "../stores/ingestStore";
import { useDistillRunStore } from "../stores/distillRunStore";

beforeEach(() => {
  importSessionSweep.mockReset().mockResolvedValue({ imported: 0, skipped: 0 });
  useImportStore.setState({ stage: "idle" });
  useIngestStore.setState({ stage: "idle" });
  useDistillRunStore.setState({ running: false });
});

describe("runSessionSweep", () => {
  it("sweeps both CLI kinds when nothing else is running", async () => {
    await runSessionSweep();
    expect(importSessionSweep).toHaveBeenCalledTimes(2);
  });

  it("skips the tick while a distill run is in flight", async () => {
    // The digest inside runDistillGuarded reads a session file, calls the LLM,
    // then archives it; a sweep rewriting a resumed conversation in that window
    // would leave its new turns behind for a duplicate digest next run.
    useDistillRunStore.setState({ running: true });

    await runSessionSweep();

    expect(importSessionSweep).not.toHaveBeenCalled();
  });

  it("skips the tick while an import is already sweeping", async () => {
    useImportStore.setState({ stage: "sweeping" });
    await runSessionSweep();
    expect(importSessionSweep).not.toHaveBeenCalled();
  });
});
