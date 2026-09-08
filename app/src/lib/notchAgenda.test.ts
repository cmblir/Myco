// The notch's agenda. What this guards is the one rule the surface exists
// for: a decision outranks an offer outranks a queue, nothing waiting draws
// nothing at all, and acting on a row removes exactly that row — because the
// agenda is derived from the stores, so the store write IS the removal.

import { describe, expect, it } from "vitest";
import { AGENDA_CAP, notchAgenda, withoutActed } from "./notchAgenda";
import type { AgendaSources } from "./notchAgenda";
import type { Adjacency, NotchAgendaPayload, SemEdge } from "./ipc";
import type { ProposalMeta, ProposalStatus } from "../stores/distillStore";
import { pairKey } from "./linkSuggestions";

const EMPTY_ADJ: Adjacency = {
  forward: {},
  backward: {},
  unresolved: {},
  tags: {},
};

function proposal(
  path: string,
  status: ProposalStatus = "pending",
): ProposalMeta {
  return {
    path,
    action: "draft-map",
    status,
    created: "2026-09-01",
    title: path,
    raw: "",
    files: [],
    cluster: `cluster ${path}`,
    members: ["a.md", "b.md"],
  };
}

function edge(source: string, target: string, score: number): SemEdge {
  return { source, target, score };
}

function sources(over: Partial<AgendaSources> = {}): AgendaSources {
  return {
    proposals: [],
    adjacency: EMPTY_ADJ,
    sem: [],
    dismissed: new Set<string>(),
    harvestItems: 0,
    ...over,
  };
}

describe("notchAgenda", () => {
  it("draws nothing when nothing is waiting", () => {
    expect(notchAgenda(sources())).toEqual({ total: 0, rows: [] });
  });

  it("ranks a decision over an offer over a queue", () => {
    const agenda = notchAgenda(
      sources({
        // Deliberately the smallest count of the three: the order is by what
        // the thing IS, never by how many there are.
        proposals: [proposal("work/feedback/p1.md")],
        sem: [edge("a.md", "b.md", 0.9), edge("c.md", "d.md", 0.8)],
        harvestItems: 40,
      }),
    );
    // Two suggestions are ONE decision, which is also what leaves room for
    // the queue: three separate link rows used to eat the cap and the harvest
    // queue never appeared at all.
    expect(agenda.rows.map((r) => r.kind)).toEqual([
      "proposal",
      "links",
      "harvest",
    ]);
    expect(agenda.total).toBe(3);
  });

  it("keeps a lone suggestion as its own row", () => {
    // One pair still names itself: collapsing a single suggestion into
    // "1 suggested link" would hide what it is for no gain.
    const agenda = notchAgenda(sources({ sem: [edge("a.md", "b.md", 0.9)] }));
    expect(agenda.rows.map((r) => r.kind)).toEqual(["link"]);
  });

  it("counts the harvest queue as one decision, not N", () => {
    const agenda = notchAgenda(sources({ harvestItems: 40 }));
    expect(agenda.total).toBe(1);
    expect(agenda.rows).toEqual([{ kind: "harvest", id: "harvest", count: 40 }]);
  });

  it("caps the rows at three and keeps counting past them", () => {
    const agenda = notchAgenda(
      sources({
        proposals: ["p1", "p2", "p3", "p4", "p5"].map((p) => proposal(p)),
      }),
    );
    expect(agenda.rows).toHaveLength(AGENDA_CAP);
    expect(agenda.total).toBe(5);
  });

  it("only offers pending draft-map proposals", () => {
    // An approved one is an in-flight decision already made; dismissed/done
    // are resolved. Offering "approve" on any of them would be a lie.
    const agenda = notchAgenda(
      sources({
        proposals: [
          proposal("p1", "approved"),
          proposal("p2", "dismissed"),
          proposal("p3", "done"),
          proposal("p4"),
        ],
      }),
    );
    expect(agenda.rows.map((r) => r.id)).toEqual(["p4"]);
  });

  it("offers no link rows without a link graph", () => {
    // suggestLinks needs adjacency to know which pairs are ALREADY linked;
    // without it every pair would read as a fresh suggestion.
    const agenda = notchAgenda(
      sources({ adjacency: null, sem: [edge("a.md", "b.md", 0.9)] }),
    );
    expect(agenda).toEqual({ total: 0, rows: [] });
  });

  it("dismissing one link removes exactly that row", () => {
    const sem = [edge("a.md", "b.md", 0.9), edge("c.md", "d.md", 0.8)];
    const before = notchAgenda(sources({ sem }));
    // Two pending pairs are the collapsed set, carrying both.
    expect(before.rows.map((r) => r.id)).toEqual(["links"]);
    expect(before.rows[0]).toMatchObject({ kind: "links", count: 2 });
    // Exactly what linkSuggestStore.dismiss writes. One left means the set
    // stops being a set: the survivor names itself again.
    const after = notchAgenda(
      sources({ sem, dismissed: new Set([pairKey("a.md", "b.md")]) }),
    );
    expect(after.rows.map((r) => r.id)).toEqual([pairKey("c.md", "d.md")]);
    expect(after.total).toBe(1);
  });

  it("deciding one proposal removes exactly that row", () => {
    const proposals = [proposal("p1"), proposal("p2")];
    expect(notchAgenda(sources({ proposals })).total).toBe(2);
    // What distillStore.dismiss/apply leave behind on disk (status rewritten).
    const decided = [proposal("p1", "dismissed"), proposal("p2")];
    const after = notchAgenda(sources({ proposals: decided }));
    expect(after.rows.map((r) => r.id)).toEqual(["p2"]);
  });

  it("emptying the harvest queue removes its row and nothing else", () => {
    const proposals = [proposal("p1")];
    expect(notchAgenda(sources({ proposals, harvestItems: 3 })).total).toBe(2);
    const after = notchAgenda(sources({ proposals, harvestItems: 0 }));
    expect(after.rows.map((r) => r.kind)).toEqual(["proposal"]);
  });
});

function row(id: string): NotchAgendaPayload["rows"][number] {
  return {
    id,
    label: id,
    sub: "",
    primaryLabel: "Approve",
    primaryAction: `proposal-approve:${id}`,
    secondaryLabel: "Dismiss",
    secondaryAction: `proposal-reject:${id}`,
  };
}

describe("withoutActed", () => {
  const pushed: NotchAgendaPayload = {
    total: 5,
    rows: [row("a"), row("b"), row("c")],
  };

  it("removes exactly the acted row, and takes it off the count", () => {
    // The write happens in the main window; the row only disappears from the
    // push a store refresh later, and until then it would still offer the
    // decision that was already made.
    const after = withoutActed(pushed, new Set(["b"]));
    expect(after?.rows.map((r) => r.id)).toEqual(["a", "c"]);
    expect(after?.total).toBe(4);
  });

  it("returns the push untouched when nothing was acted on", () => {
    expect(withoutActed(pushed, new Set())).toBe(pushed);
    expect(withoutActed(pushed, new Set(["nope"]))).toBe(pushed);
  });

  it("never lets the count go negative", () => {
    const one: NotchAgendaPayload = { total: 1, rows: [row("a"), row("b")] };
    expect(withoutActed(one, new Set(["a", "b"]))).toEqual({
      total: 0,
      rows: [],
    });
  });

  it("passes a missing agenda through", () => {
    expect(withoutActed(null, new Set(["a"]))).toBeNull();
  });
});
