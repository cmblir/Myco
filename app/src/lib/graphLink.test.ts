import { describe, expect, it } from "vitest";
import { graphHref, pickBannerShown, relandAfterRebuild, settingsToSave } from "./graphLink";
import { DEFAULT_GRAPH_SETTINGS } from "./graphSettings";

describe("graphHref", () => {
  it("names the question, and the note when there is one", () => {
    expect(graphHref("orphans")).toBe("graph?q=orphans");
    expect(graphHref("neighbors", "/v/wiki/a b.md")).toBe(
      "graph?q=neighbors&n=%2Fv%2Fwiki%2Fa+b.md",
    );
  });
});

describe("relandAfterRebuild — the deep-linked note lands again only once", () => {
  const arrived = { selected: "/v/wiki/rlhf.md", origin: "/v/wiki/rlhf.md", pending: null };

  it("keeps the note through the rebuild the file mtimes cause just after arrival", () => {
    expect(relandAfterRebuild({ ...arrived, mtimesArrived: true })).toBe("/v/wiki/rlhf.md");
  });

  it("lets a rebuild the user causes (a filter, a look, Reset) clear it like any selection", () => {
    expect(relandAfterRebuild({ ...arrived, mtimesArrived: false })).toBeNull();
  });

  it("does not bring the note back once the user moved to another one", () => {
    expect(relandAfterRebuild({ ...arrived, selected: "/v/wiki/ppo.md", mtimesArrived: true })).toBeNull();
    expect(relandAfterRebuild({ ...arrived, selected: null, mtimesArrived: true })).toBeNull();
  });

  it("leaves a landing that is still waiting alone", () => {
    expect(relandAfterRebuild({ ...arrived, pending: "/v/wiki/rlhf.md", mtimesArrived: true })).toBeNull();
  });
});

describe("settingsToSave — a deep link's question is a view, not the user's choice", () => {
  const onNeighbors = { ...DEFAULT_GRAPH_SETTINGS, question: "neighbors" as const };
  const arrival = { shown: "neighbors" as const, before: "clusters" as const };

  it("saves the user's own question while the arrival's is showing", () => {
    const next = settingsToSave({ ...onNeighbors, nodeSize: 2 }, arrival);
    expect(next.save.question).toBe("clusters");
    expect(next.save.nodeSize).toBe(2);
    expect(next.arrival).toBe(arrival);
  });

  it("saves as they are once the user picks another question, and forgets the arrival", () => {
    const next = settingsToSave({ ...onNeighbors, question: "orphans" }, arrival);
    expect(next.save.question).toBe("orphans");
    expect(next.arrival).toBeNull();
    expect(settingsToSave(onNeighbors, next.arrival).save.question).toBe("neighbors");
  });

  it("saves as they are without an arrival", () => {
    expect(settingsToSave(onNeighbors, null)).toEqual({ save: onNeighbors, arrival: null });
  });
});

describe("pickBannerShown — 노트를 하나 고르세요 only when nothing is on its way", () => {
  it("asks for a note when the neighbours question has none", () => {
    expect(pickBannerShown({ question: "neighbors", selected: null, arriving: false })).toBe(true);
  });

  it("stays hidden while a deep-linked note waits for the layout", () => {
    expect(pickBannerShown({ question: "neighbors", selected: null, arriving: true })).toBe(false);
  });

  it("stays hidden with a note selected or on another question", () => {
    expect(pickBannerShown({ question: "neighbors", selected: "/v/wiki/a.md", arriving: false })).toBe(false);
    expect(pickBannerShown({ question: "orphans", selected: null, arriving: false })).toBe(false);
  });
});
