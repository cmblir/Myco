import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDebouncedCommitter } from "./humanCommit";

describe("createDebouncedCommitter", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("coalesces rapid saves of one file into one commit", () => {
    const commit = vi.fn();
    const c = createDebouncedCommitter(commit, 1000);
    c.touch("wiki/a.md");
    vi.advanceTimersByTime(400);
    c.touch("wiki/a.md");
    vi.advanceTimersByTime(999);
    expect(commit).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(commit).toHaveBeenCalledTimes(1);
    expect(commit).toHaveBeenCalledWith("wiki/a.md");
  });

  it("tracks different files independently", () => {
    const commit = vi.fn();
    const c = createDebouncedCommitter(commit, 1000);
    c.touch("wiki/a.md");
    vi.advanceTimersByTime(600);
    c.touch("wiki/b.md");
    vi.advanceTimersByTime(400);
    expect(commit).toHaveBeenCalledTimes(1); // a fired at t=1000
    vi.advanceTimersByTime(600);
    expect(commit).toHaveBeenCalledTimes(2); // b fired at t=1600
  });

  it("flushAll fires everything pending immediately", () => {
    const commit = vi.fn();
    const c = createDebouncedCommitter(commit, 1000);
    c.touch("wiki/a.md");
    c.flushAll();
    expect(commit).toHaveBeenCalledWith("wiki/a.md");
    vi.advanceTimersByTime(2000);
    expect(commit).toHaveBeenCalledTimes(1); // no double fire
  });
});
