// The toast queue's pure rules: at most three on screen (oldest evicted),
// dismiss by id, and the per-kind default life the helper stamps on.

import { beforeEach, describe, expect, it } from "vitest";
import { MAX_NOTICES, useNoticeStore } from "./noticeStore";
import { NOTICE_TTL_MS, notice } from "../lib/notice";

describe("noticeStore", () => {
  beforeEach(() => {
    useNoticeStore.setState({ notices: [], progress: null, lastProgressOk: true });
  });

  it("records how the progress job ended; a new job resets it", () => {
    const store = useNoticeStore.getState();
    const job = { key: "k", label: "l", done: 0, total: 2 };
    store.setProgress(job);
    store.endProgress(false);
    expect(useNoticeStore.getState()).toMatchObject({ progress: null, lastProgressOk: false });
    store.setProgress(job);
    expect(useNoticeStore.getState().lastProgressOk).toBe(true);
    store.endProgress(true);
    expect(useNoticeStore.getState().lastProgressOk).toBe(true);
    store.setProgress(job);
    store.setProgress(null); // silent clear keeps the last outcome
    expect(useNoticeStore.getState()).toMatchObject({ progress: null, lastProgressOk: true });
  });

  it("keeps at most three, dropping the oldest first", () => {
    const ids = ["a", "b", "c", "d"].map((title) => notice.ok(title));
    const { notices } = useNoticeStore.getState();
    expect(notices).toHaveLength(MAX_NOTICES);
    expect(notices.map((n) => n.title)).toEqual(["b", "c", "d"]);
    expect(notices.map((n) => n.id)).toEqual(ids.slice(1));
  });

  it("dismisses by id and leaves the rest in order", () => {
    const a = notice.ok("a");
    const b = notice.ok("b");
    useNoticeStore.getState().dismiss(a);
    expect(useNoticeStore.getState().notices.map((n) => n.id)).toEqual([b]);
    useNoticeStore.getState().dismiss("nope");
    expect(useNoticeStore.getState().notices).toHaveLength(1);
  });

  it("defaults the life per kind, overridable per call", () => {
    notice.ok("ok");
    notice.info("info");
    notice.warn("warn");
    notice.warn("long", { ttlMs: 10_000 });
    // The first push was evicted by the fourth; check the survivors.
    const [info, warn, long] = useNoticeStore.getState().notices;
    expect(info.ttlMs).toBe(NOTICE_TTL_MS.info);
    expect(warn.ttlMs).toBe(NOTICE_TTL_MS.warn);
    expect(NOTICE_TTL_MS.warn).toBeGreaterThan(NOTICE_TTL_MS.ok);
    expect(long.ttlMs).toBe(10_000);
  });

  it("carries sub, icon and action through untouched", () => {
    const run = () => undefined;
    notice.ok("t", { sub: "s", icon: "link", action: { label: "Undo", run } });
    const [n] = useNoticeStore.getState().notices;
    expect(n).toMatchObject({ kind: "ok", sub: "s", icon: "link" });
    expect(n.action?.run).toBe(run);
  });
});
