import { beforeEach, describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { CompletionContext } from "@codemirror/autocomplete";
import { topbarOverlap, wikilinkCompletion } from "./Editor";
import { useVaultStore } from "../stores/vaultStore";

describe("topbarOverlap", () => {
  it("is the whole bar when the document scrolls under it", () => {
    // A jump to a heading landed at -18px, hidden under the 44px bar.
    expect(topbarOverlap(44, 0)).toBe(44);
    expect(topbarOverlap(44, -1388)).toBe(44);
  });

  it("is nothing in a split pane, whose scroller starts below the bar", () => {
    expect(topbarOverlap(44, 44)).toBe(0);
    expect(topbarOverlap(44, 300)).toBe(0);
  });
});

const names = Array.from({ length: 40 }, (_, i) => `note-${i}`);

const complete = (doc: string) =>
  wikilinkCompletion(
    new CompletionContext(EditorState.create({ doc }), doc.length, false),
  );

describe("wikilinkCompletion", () => {
  beforeEach(() => {
    useVaultStore.setState({
      fileTree: names.map((n) => ({
        kind: "file" as const,
        name: `${n}.md`,
        path: `/v/${n}.md`,
      })),
    });
  });

  it("asks again as you type when it showed only the first 30 names", () => {
    // Kept valid, the first 30 would be filtered for `[[note-39` and miss it.
    const first = complete("![[");
    expect(first?.options).toHaveLength(30);
    expect(first?.validFor).toBeUndefined();
    expect(complete("![[note-39")?.options.map((o) => o.label)).toEqual([
      "note-39",
    ]);
  });

  it("lists the names a one-letter query starts, however many only contain it", () => {
    // CodeMirror keeps only the options a one-letter query starts; cut at 30
    // in tree order, `[[e` held 30 `note-*` names (all with an "e") and
    // showed nothing, though `embeddings` exists.
    useVaultStore.setState({
      // First in the tree, so collected last (the walk pops a stack).
      fileTree: ["embeddings", ...names].map((n) => ({
        kind: "file" as const,
        name: `${n}.md`,
        path: `/v/${n}.md`,
      })),
    });
    const labels = complete("[[e")?.options.map((o) => o.label);
    expect(labels).toHaveLength(30);
    expect(labels?.[0]).toBe("embeddings");
  });

  it("keeps a complete list valid while typing narrows it", () => {
    expect(complete("[[note-3")?.validFor).toBeDefined();
  });

  it("stays cheap per keystroke in a large vault, names deduplicated", () => {
    // Asked again on every keystroke once over 30 matches: the dedupe used to
    // be quadratic (85 ms a call at 10k files).
    const N = 40000;
    useVaultStore.setState({
      fileTree: Array.from({ length: N }, (_, i) => ({
        kind: "file" as const,
        name: `note-${i % (N / 2)}.md`,
        path: `/v/${i < N / 2 ? "a" : "b"}/note-${i}.md`,
      })),
    });
    complete("[[no");
    const t = performance.now();
    const r = complete("[[note-1999");
    expect(performance.now() - t).toBeLessThan(250);
    // Each name once, though two folders hold it.
    expect(r?.options.map((o) => o.label).sort()).toEqual([
      "note-1999",
      "note-19990",
      "note-19991",
      "note-19992",
      "note-19993",
      "note-19994",
      "note-19995",
      "note-19996",
      "note-19997",
      "note-19998",
      "note-19999",
    ]);
  });
});
