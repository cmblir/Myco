import { describe, expect, it } from "vitest";
import { canvasLabel, frameLabel, escTarget, pickFocuses, pushNodeFrame, type FocusFrame } from "./graphFocus";
import { STRINGS } from "./i18n";

const members = (id: string) => (hops: 1 | 2) => new Set([id, `${id}-hop${hops}`]);

describe("pushNodeFrame — every pick focuses the note it picks", () => {
  it("pushes a 1-hop frame labelled with the note's name", () => {
    const next = pushNodeFrame([], "/v/wiki/rlhf.md", members("rlhf"));
    expect(next).toEqual([
      {
        kind: "node",
        id: "/v/wiki/rlhf.md",
        hops: 1,
        label: "rlhf",
        members: new Set(["rlhf", "rlhf-hop1"]),
      },
    ]);
  });

  it("stacks a pick from the gaps list, search or an inspector link on the current frame", () => {
    const a = pushNodeFrame([], "/v/a.md", members("a"));
    const b = pushNodeFrame(a, "/v/b.md", members("b"));
    expect(b.map((f) => f.label)).toEqual(["a", "b"]);
    expect(b[0]).toBe(a[0]);
  });

  it("returns the same stack when the note is already the focus", () => {
    const a = pushNodeFrame([], "/v/a.md", members("a"));
    expect(pushNodeFrame(a, "/v/a.md", members("a"))).toBe(a);
  });

  it("widens the top frame to 2 hops on a double click, once", () => {
    const a = pushNodeFrame([], "/v/a.md", members("a"));
    const wide = pushNodeFrame(a, "/v/a.md", members("a"), true);
    expect(wide).toHaveLength(1);
    expect(wide[0]).toMatchObject({ hops: 2, members: new Set(["a", "a-hop2"]) });
    expect(pushNodeFrame(wide, "/v/a.md", members("a"), true)).toBe(wide);
  });

  it("pushes over a community frame even for one of its members", () => {
    const cm: FocusFrame[] = [{ kind: "community", cm: 3, label: "rlhf", members: new Set(["/v/a.md"]) }];
    expect(pushNodeFrame(cm, "/v/a.md", members("a")).map((f) => f.kind)).toEqual(["community", "node"]);
  });
});

describe("pickFocuses — which picks become the focus", () => {
  it("focuses an ordinary pick", () => {
    expect(pickFocuses({ trace: false, fly: false })).toBe(true);
  });

  it("does not while tracing a path: a 1-hop frame would dim the route past its end", () => {
    expect(pickFocuses({ trace: true, fly: false })).toBe(false);
  });

  it("does not while flying: a pick only fills the ship's HUD", () => {
    expect(pickFocuses({ trace: false, fly: true })).toBe(false);
  });
});

describe("escTarget — Esc closes the thing on top first", () => {
  const frame = pushNodeFrame([], "/v/a.md", members("a"));

  const none = { drawer: false, help: false };

  it("closes the settings drawer first: it is drawn over the help and the inspector", () => {
    expect(escTarget({ drawer: true, help: true, selected: "/v/a.md", stack: frame })).toBe("drawer");
    expect(escTarget({ drawer: true, help: false, selected: null, stack: [] })).toBe("drawer");
  });

  it("closes the help next: it is drawn over the inspector", () => {
    expect(escTarget({ ...none, help: true, selected: "/v/a.md", stack: frame })).toBe("help");
  });

  it("closes an inspector that has no frame of its own (trace pick, neighbours button)", () => {
    expect(escTarget({ ...none, selected: "/v/b.md", stack: [] })).toBe("inspector");
    expect(escTarget({ ...none, selected: "/v/b.md", stack: frame })).toBe("inspector");
  });

  it("steps out of the frame when the inspector shows its note, closing both at once", () => {
    expect(escTarget({ ...none, selected: "/v/a.md", stack: frame })).toBe("frame");
    expect(escTarget({ ...none, selected: null, stack: frame })).toBe("frame");
  });

  it("leaves Esc alone when nothing is open", () => {
    expect(escTarget({ ...none, selected: null, stack: [] })).toBeNull();
  });
});

describe("frameLabel", () => {
  it("names a missing page by its target, not its ghost id", () => {
    expect(frameLabel("ghost:claude-code-e4649b3c-c5ca-4d83-a0a7-e2f41c540fe6")).toBe(
      "Claude Code · e4649b3c",
    );
    expect(frameLabel("ghost:work:gamma")).toBe("gamma");
  });
  it("names a note by its display name", () => {
    expect(frameLabel("/v/wiki/attention.md")).toBe("attention");
  });
});

describe("canvasLabel (UX S44)", () => {
  it("sums the canvas up for a screen reader", () => {
    expect(canvasLabel(STRINGS.ko, 71, null)).toBe("노트 71개");
    expect(canvasLabel(STRINGS.ko, 71, "/v/wiki/attention-mechanism.md")).toBe("노트 71개, 선택: attention-mechanism");
    expect(canvasLabel(STRINGS.en, 3, "/v/wiki/a.md")).toBe("3 notes, selected: a");
    expect(canvasLabel(STRINGS.ja, 3, null)).toContain("3");
  });
});
