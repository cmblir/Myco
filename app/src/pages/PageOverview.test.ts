// Home's mtime read, driven by hand (node env). Every file change refreshes
// the vault tree and re-runs this read; the band's engine is rebuilt whenever
// the week's count changes, so the rows on screen must not blink empty.
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { beginReflectCreation, DistillWorkflowResult, HomeAsk, readMtimes } from "./PageOverview";
import { STRINGS } from "../lib/i18n";
import { useReflectStore } from "../stores/reflectStore";
import { useVaultStore } from "../stores/vaultStore";
import type { WorkflowReceipt } from "../lib/workflowOutcome";

describe("Distill workflow feedback", () => {
  it.each(["pending", "partial", "stopped", "failed"] as const)("renders %s separately from completed work", status => {
    const receipt: WorkflowReceipt = {
      status,
      steps: [{ step: "run", status: "success" }, { step: "digest", status }],
      issues: [{ step: "digest", status: status === "partial" ? "pending" : status,
        code: "unavailable", error: "synthetic model unavailable", retryable: true }],
    };
    const html = renderToStaticMarkup(h(DistillWorkflowResult, { t: STRINGS.ko, receipt }));
    expect(html).toContain(STRINGS.ko[`workflow_${status}`]);
    expect(html).toContain(STRINGS.ko.set_distill_step_run);
    expect(html).toContain("synthetic model unavailable");
    expect(html).not.toContain(STRINGS.ko.ing_success_title);
    expect(html).not.toContain("var(--ok)");
  });
});

type Rows = [string, number][];
const ROWS: Rows = [["/v/wiki/a.md", 100]];
const never = new Promise<Rows>(() => undefined);
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

function recorder(): { rows: Rows[]; states: string[]; setRows: (r: Rows) => void; setState: (s: string) => void } {
  const rows: Rows[] = [];
  const states: string[] = [];
  return { rows, states, setRows: (r) => void rows.push(r), setState: (s) => void states.push(s) };
}

describe("readMtimes", () => {
  it("keeps the rows on screen while a tree refresh re-reads the same vault", async () => {
    const shown = { current: null as string | null };
    const rec = recorder();
    readMtimes("/v", shown, Promise.resolve(ROWS), rec.setRows, rec.setState);
    await settle();
    expect(rec.rows).toEqual([[], ROWS]);

    rec.rows.length = 0;
    readMtimes("/v", shown, never, rec.setRows, rec.setState);
    await settle();
    expect(rec.rows).toEqual([]);
  });

  it("starts a different vault from no rows", async () => {
    const shown = { current: "/v" as string | null };
    const rec = recorder();
    readMtimes("/w", shown, never, rec.setRows, rec.setState);
    await settle();
    expect(rec.rows).toEqual([[]]);
    expect(shown.current).toBe("/w");
  });

  it("ignores a superseded read", async () => {
    const shown = { current: "/v" as string | null };
    const rec = recorder();
    const cancel = readMtimes("/v", shown, Promise.resolve(ROWS), rec.setRows, rec.setState);
    cancel();
    await settle();
    expect(rec.rows).toEqual([]);
    expect(rec.states).toEqual(["loading"]);
  });
});

// The box's two actions are buttons, not only Enter / Cmd+Enter: a phone
// keyboard has no Cmd, and the hint line is all a newcomer had to go on.
describe("HomeAsk", () => {
  const t = STRINGS.ko;
  const buttons = (): Map<string, string> => {
    const html = renderToStaticMarkup(h(HomeAsk, { t }));
    return new Map(
      [...html.matchAll(/<button([^>]*)>([^<]*)<\/button>/g)].map((m) => [m[2], m[1]]),
    );
  };

  it("offers Ask as the primary button and Add to today's note beside it", () => {
    const all = buttons();
    expect(all.get(t.home_ask_send)).toContain("u-btn--primary");
    expect(all.get(t.home_capture_send)).toBeDefined();
    expect(all.get(t.home_capture_send)).not.toContain("u-btn--primary");
  });

  it("keeps both off while the box is empty", () => {
    const all = buttons();
    expect(all.get(t.home_ask_send)).toContain('disabled=""');
    expect(all.get(t.home_capture_send)).toContain('disabled=""');
  });
});

describe("Reflect creation callbacks", () => {
  const finding = { text: "missing", kind: "unresolved" as const, link: "missing", from: "/a/wiki/n.md" };
  let finish!: (result: { created: number; failed: string | null }) => void;
  let progress!: (done: number, total: number) => void;
  let setBulk: ReturnType<typeof vi.fn>;
  let setResult: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    useVaultStore.setState({ currentVault: { path: "/a", name: "a" }, vaultToken: "a1", isOpeningVault: false });
    useReflectStore.setState({
      stage: "done", vault: "/a", vaultToken: "a1", origin: { vaultPath: "/a", openingToken: "native-a1" },
      applying: false, suggestions: [finding],
      createMissingPages: vi.fn((_items, onProgress) => {
        progress = onProgress!;
        return new Promise<{ created: number; failed: string | null }>((resolve) => { finish = resolve; });
      }),
    });
    setBulk = vi.fn();
    setResult = vi.fn();
  });

  it("reports this opening's progress and completion", async () => {
    const action = beginReflectCreation(undefined, setBulk, setResult);
    progress(1, 1);
    finish({ created: 1, failed: null });
    await action.finished;
    expect(setBulk.mock.calls.map((c) => c[0])).toEqual([{ done: 0, total: 1 }, { done: 1, total: 1 }, null]);
    expect(setResult.mock.calls.map((c) => c[0])).toEqual([null, { created: 1, failed: null }]);
  });

  it.each(["switch", "reopen", "dismiss"])("does not publish old progress/result after %s", async (kind) => {
    const action = beginReflectCreation(undefined, setBulk, setResult);
    if (kind === "dismiss") useReflectStore.getState().dismiss();
    else useVaultStore.setState({
      currentVault: { path: kind === "switch" ? "/b" : "/a", name: "next" }, vaultToken: "next",
    });
    setBulk.mockClear();
    setResult.mockClear();
    progress(1, 1);
    finish({ created: 1, failed: null });
    await action.finished;
    expect(setBulk).not.toHaveBeenCalled();
    expect(setResult).not.toHaveBeenCalled();
  });

  it("discards callbacks after the panel unmounts", async () => {
    const action = beginReflectCreation(undefined, setBulk, setResult);
    action.cancel();
    setBulk.mockClear();
    setResult.mockClear();
    progress(1, 1);
    finish({ created: 1, failed: null });
    await action.finished;
    expect(setBulk).not.toHaveBeenCalled();
    expect(setResult).not.toHaveBeenCalled();
  });

  it("an old completion cannot clear a new opening's in-flight progress", async () => {
    const old = beginReflectCreation(undefined, setBulk, setResult);
    const oldFinish = finish;
    useVaultStore.setState({ currentVault: { path: "/b", name: "b" }, vaultToken: "b1" });
    useReflectStore.setState({
      stage: "done", vault: "/b", vaultToken: "b1", origin: { vaultPath: "/b", openingToken: "native-b1" },
      applying: false, suggestions: [{ ...finding, from: "/b/wiki/n.md" }],
    });
    const next = beginReflectCreation(undefined, setBulk, setResult);
    const nextFinish = finish;
    setBulk.mockClear();
    setResult.mockClear();
    oldFinish({ created: 1, failed: null });
    await old.finished;
    expect(setBulk).not.toHaveBeenCalled();
    expect(setResult).not.toHaveBeenCalled();
    progress(1, 1);
    nextFinish({ created: 1, failed: null });
    await next.finished;
    expect(setResult).toHaveBeenCalledWith({ created: 1, failed: null });
  });

  it("reports an unexpected failure and releases the progress state", async () => {
    useReflectStore.setState({ createMissingPages: vi.fn().mockRejectedValue(new Error("creation unavailable")) });
    const action = beginReflectCreation(undefined, setBulk, setResult);
    await action.finished;
    expect(setResult).toHaveBeenLastCalledWith({ error: "creation unavailable" });
    expect(setBulk).toHaveBeenLastCalledWith(null);
  });

  it("does not publish a failure that returns after the opening was replaced", async () => {
    useReflectStore.setState({ createMissingPages: vi.fn().mockRejectedValue(new Error("old failure")) });
    const action = beginReflectCreation(undefined, setBulk, setResult);
    useVaultStore.setState({ vaultToken: "a2" });
    setBulk.mockClear();
    setResult.mockClear();
    await action.finished;
    expect(setResult).not.toHaveBeenCalled();
    expect(setBulk).not.toHaveBeenCalled();
  });

  it("does not start a queued click on a row replaced in the same opening", async () => {
    useReflectStore.setState({ suggestions: [{ ...finding, text: "replacement" }] });
    const action = beginReflectCreation([finding], setBulk, setResult);
    await action.finished;
    expect(useReflectStore.getState().createMissingPages).not.toHaveBeenCalled();
    expect(setBulk).not.toHaveBeenCalled();
  });
});
