import { describe, expect, it, vi } from "vitest";
import { createPointerDrag, type DragLive } from "./pointerDrag";

function setup(targets: Record<string, string> = {}) {
  const changes: (DragLive<string> | null)[] = [];
  const onDrop = vi.fn<(id: string, target: string) => void>();
  const machine = createPointerDrag<string>({
    threshold: 4,
    // Targets keyed by "x,y" so a test can place the pointer over one.
    targetAt: (x, y) => targets[`${x},${y}`] ?? null,
    onChange: (live) => changes.push(live),
    onDrop,
  });
  return { machine, changes, onDrop };
}

describe("createPointerDrag", () => {
  it("stays a click below the threshold", () => {
    const { machine, changes, onDrop } = setup({ "2,0": "a" });
    machine.begin("t1", 0, 0);
    machine.move(2, 0);
    expect(changes).toEqual([]);
    expect(machine.end()).toBe(false);
    expect(onDrop).not.toHaveBeenCalled();
  });

  it("goes live at the threshold and reports target changes only", () => {
    const { machine, changes } = setup({
      "10,0": "a",
      "20,0": "a",
      "30,0": "b",
    });
    machine.begin("t1", 0, 0);
    machine.move(4, 0);
    machine.move(10, 0);
    machine.move(20, 0);
    machine.move(30, 0);
    machine.move(40, 0);
    expect(changes).toEqual([
      { id: "t1", target: null },
      { id: "t1", target: "a" },
      { id: "t1", target: "b" },
      { id: "t1", target: null },
    ]);
  });

  it("drops on the last target and clears", () => {
    const { machine, changes, onDrop } = setup({ "10,0": "a" });
    machine.begin("t1", 0, 0);
    machine.move(10, 0);
    expect(machine.end()).toBe(true);
    expect(onDrop).toHaveBeenCalledWith("t1", "a");
    expect(changes.at(-1)).toBeNull();
  });

  it("ends without a target without dropping", () => {
    const { machine, onDrop } = setup();
    machine.begin("t1", 0, 0);
    machine.move(10, 0);
    expect(machine.end()).toBe(true);
    expect(onDrop).not.toHaveBeenCalled();
  });

  it("cancel drops nothing and ignores later moves", () => {
    const { machine, changes, onDrop } = setup({ "10,0": "a" });
    machine.begin("t1", 0, 0);
    machine.move(10, 0);
    expect(machine.cancel()).toBe(true);
    machine.move(10, 0);
    expect(machine.end()).toBe(false);
    expect(onDrop).not.toHaveBeenCalled();
    expect(changes.at(-1)).toBeNull();
  });
});
