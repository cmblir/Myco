import { describe, expect, it } from "vitest";
import { activeFilterChips, clearFilters } from "./graphFilters";
import { DEFAULT_GRAPH_SETTINGS, type GraphSettings } from "./graphSettings";
import { STRINGS } from "./i18n";

const t = STRINGS.en;

describe("clearFilters — the way out of an empty stage", () => {
  it("resets every corpus filter and nothing else", () => {
    const narrowed: GraphSettings = {
      ...DEFAULT_GRAPH_SETTINGS,
      search: "zzzz",
      tagFilter: "analysis",
      folderFilter: "wiki",
      existingOnly: true,
      showOrphans: false,
      hideSample: true,
      skin: "white",
      question: "time",
    };
    const cleared = { ...narrowed, ...clearFilters() };
    expect(cleared).toEqual({ ...DEFAULT_GRAPH_SETTINGS, skin: "white", question: "time" });
  });
});

describe("activeFilterChips — drawer filters stay visible on the bar", () => {
  it("is empty at the defaults", () => {
    expect(activeFilterChips(DEFAULT_GRAPH_SETTINGS, t)).toEqual([]);
  });

  it("names each narrowing filter and knows how to lift it", () => {
    const chips = activeFilterChips(
      { ...DEFAULT_GRAPH_SETTINGS, tagFilter: "analysis", folderFilter: "wiki", search: " attn " },
      t,
    );
    expect(chips.map((c) => c.label)).toEqual(["#analysis", "folder: wiki", "search: attn"]);
    expect(chips.map((c) => c.clear)).toEqual([
      { tagFilter: null },
      { folderFilter: null },
      { search: "" },
    ]);
  });

  it("ignores a blank search — it narrows nothing", () => {
    expect(activeFilterChips({ ...DEFAULT_GRAPH_SETTINGS, search: "   " }, t)).toEqual([]);
  });
});
