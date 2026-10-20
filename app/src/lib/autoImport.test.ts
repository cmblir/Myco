import { describe, expect, it, vi, beforeEach } from "vitest";

const importSessionSweep = vi.fn();
const agentVaultSession = vi.fn();
vi.mock("./ipc", () => ({
  ipc: {
    importSessionSweep: (...a: unknown[]) => importSessionSweep(...a),
    agentVaultSession: (...a: unknown[]) => agentVaultSession(...a),
  },
}));

import { getLastSweepAt, getLastSweepReceipt, runSessionSweep } from "./autoImport";
import { useImportStore } from "../stores/importStore";
import { useIngestStore } from "../stores/ingestStore";
import { useDistillRunStore } from "../stores/distillRunStore";
import { useVaultStore } from "../stores/vaultStore";

beforeEach(() => {
  importSessionSweep.mockReset().mockResolvedValue({ imported: 0, skipped: 0, failed: [], quarantined: [] });
  agentVaultSession.mockReset().mockResolvedValue({ vaultPath: "/synthetic", openingToken: "native-opening" });
  useImportStore.setState({ stage: "idle" });
  useIngestStore.setState({ stage: "idle" });
  useDistillRunStore.setState({ running: false });
  useVaultStore.setState({
    currentVault: { path: "/synthetic", name: "Synthetic" },
    vaultToken: crypto.randomUUID(),
    isOpeningVault: false,
  });
});

describe("runSessionSweep", () => {
  it("binds both CLI sweeps to one captured native opening", async () => {
    await runSessionSweep();
    expect(agentVaultSession).toHaveBeenCalledOnce();
    for (const kind of ["claude-code", "codex"]) {
      expect(importSessionSweep).toHaveBeenCalledWith(kind, {
        vaultPath: "/synthetic", openingToken: "native-opening",
      }, expect.any(String));
    }
  });

  it("does not import into an unrelated native vault", async () => {
    agentVaultSession.mockResolvedValue({ vaultPath: "/synthetic-other", openingToken: "native-other" });
    await runSessionSweep();
    expect(importSessionSweep).not.toHaveBeenCalled();
  });

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

  it("does not advance the clean watermark when a returned batch contains failures", async () => {
    importSessionSweep.mockResolvedValue({
      imported: 1, skipped: 0, quarantined: [],
      failed: [{ path: "/synthetic/source.jsonl", error: "Synthetic read failure" }],
    });
    await runSessionSweep();
    expect(getLastSweepAt()).toBeNull();
  });

  it("does not let the second kind hide a failed first kind", async () => {
    importSessionSweep.mockRejectedValueOnce(new Error("Synthetic ledger failure"));
    await runSessionSweep();
    expect(getLastSweepAt()).toBeNull();
    expect(getLastSweepReceipt()).toMatchObject({ status: "partial", items: [
      { kind: "claude-code", error: "Error: Synthetic ledger failure" },
      { kind: "codex", outcome: { imported: 0 } },
    ] });
  });

  it("does not dispatch overlapping background sweeps", async () => {
    let finish!: (value: { imported: number; skipped: number; failed: never[]; quarantined: never[] }) => void;
    importSessionSweep.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    const first = runSessionSweep();
    await runSessionSweep();
    expect(importSessionSweep).toHaveBeenCalledOnce();
    finish({ imported: 0, skipped: 0, failed: [], quarantined: [] });
    await first;
  });

  it("stops the old sweep after the same vault is reopened", async () => {
    let finish!: (value: { imported: number; skipped: number; failed: never[]; quarantined: never[] }) => void;
    importSessionSweep.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    const pending = runSessionSweep();
    await vi.waitFor(() => expect(importSessionSweep).toHaveBeenCalledOnce());
    useVaultStore.setState({ vaultToken: "synthetic-reopened" });
    finish({ imported: 1, skipped: 0, failed: [], quarantined: [] });
    await pending;
    expect(importSessionSweep).toHaveBeenCalledOnce();
    expect(getLastSweepAt()).toBeNull();
  });

  it("rejects a same-path reopening before the native identity capture finishes", async () => {
    let finish!: (value: { vaultPath: string; openingToken: string }) => void;
    agentVaultSession.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    const pending = runSessionSweep();
    useVaultStore.setState({ vaultToken: "synthetic-reopened-during-capture" });
    finish({ vaultPath: "/synthetic", openingToken: "native-opening" });
    await pending;
    expect(importSessionSweep).not.toHaveBeenCalled();
    expect(getLastSweepAt()).toBeNull();
  });

  it("keeps failures from both kinds and publishes no clean completion", async () => {
    importSessionSweep.mockRejectedValue(new Error("Synthetic read failure"));
    await runSessionSweep();
    expect(getLastSweepReceipt()).toMatchObject({ status: "failed", items: [
      { kind: "claude-code", error: "Error: Synthetic read failure" },
      { kind: "codex", error: "Error: Synthetic read failure" },
    ] });
    expect(getLastSweepAt()).toBeNull();
  });

  it("advances a clean watermark only after both kinds finish without held sources", async () => {
    await runSessionSweep();
    expect(getLastSweepReceipt()).toMatchObject({ status: "success" });
    expect(getLastSweepAt()).not.toBeNull();
    const clean = getLastSweepAt();
    importSessionSweep.mockResolvedValue({ imported: 0, skipped: 0, failed: [], quarantined: [{ title: "Synthetic held", secrets: ["token"] }] });
    await runSessionSweep();
    expect(getLastSweepReceipt()).toMatchObject({ status: "pending" });
    expect(getLastSweepAt()).toBe(clean);
  });
});
