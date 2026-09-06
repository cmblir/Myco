import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  corpusKey,
  DEFAULT_GRAPH_SETTINGS,
  GRAPH_SETTINGS_KEY,
  loadGraphSettings,
  saveGraphSettings,
} from "./graphSettings";

// Minimal localStorage for the node test environment.
function fakeStorage(): Storage {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, String(v)),
    removeItem: (k: string) => void m.delete(k),
    clear: () => m.clear(),
    key: (i: number) => [...m.keys()][i] ?? null,
    get length() {
      return m.size;
    },
  } as Storage;
}

beforeEach(() => {
  (globalThis as { localStorage?: Storage }).localStorage = fakeStorage();
});
afterEach(() => {
  delete (globalThis as { localStorage?: Storage }).localStorage;
});

describe("graph settings v27", () => {
  it("defaults to the orphans question sized by backlinks, sample shown, ghosts on", () => {
    expect(loadGraphSettings()).toEqual(DEFAULT_GRAPH_SETTINGS);
    expect(GRAPH_SETTINGS_KEY).toBe("myco.graph.settings.v27");
  });

  it("round-trips", () => {
    saveGraphSettings({ question: "time", sizeBy: "cites", hideSample: true, showUnresolved: false });
    expect(loadGraphSettings()).toEqual({
      question: "time",
      sizeBy: "cites",
      hideSample: true,
      showUnresolved: false,
    });
  });

  it("ignores the v26 blob and any unknown value — view prefs, not data", () => {
    localStorage.setItem(
      "myco.graph.settings.v26",
      JSON.stringify({ layout: "walrus", skin: "mycelium", nodeSize: 2.5 }),
    );
    localStorage.setItem(
      GRAPH_SETTINGS_KEY,
      JSON.stringify({ question: "walrus", sizeBy: 3, hideSample: "yes" }),
    );
    expect(loadGraphSettings()).toEqual(DEFAULT_GRAPH_SETTINGS);
    localStorage.setItem(GRAPH_SETTINGS_KEY, "{not json");
    expect(loadGraphSettings()).toEqual(DEFAULT_GRAPH_SETTINGS);
  });
});

describe("corpusKey — what may rebuild the scene", () => {
  it("changes only with the corpus filters, never with question or size", () => {
    const base = corpusKey(DEFAULT_GRAPH_SETTINGS);
    expect(corpusKey({ ...DEFAULT_GRAPH_SETTINGS, question: "neighbors" })).toBe(base);
    expect(corpusKey({ ...DEFAULT_GRAPH_SETTINGS, sizeBy: "cites" })).toBe(base);
    expect(corpusKey({ ...DEFAULT_GRAPH_SETTINGS, hideSample: true })).not.toBe(base);
    expect(corpusKey({ ...DEFAULT_GRAPH_SETTINGS, showUnresolved: false })).not.toBe(base);
  });
});
