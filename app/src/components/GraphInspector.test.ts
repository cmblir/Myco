import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import GraphInspector from "./GraphInspector";
import { STRINGS } from "../lib/i18n";

// Focus return is a browser-only layout effect; the label is what this checks.
vi.mock("../lib/returnFocus", () => ({ useReturnFocus: vi.fn() }));

function backLabel(origin: string, lang: "en" | "ko"): string {
  const noop = vi.fn();
  const html = renderToStaticMarkup(
    createElement(GraphInspector, {
      t: STRINGS[lang],
      nodeId: "/v/wiki/other.md",
      adjacency: { forward: {}, backward: {}, unresolved: {}, tags: {} },
      graph: null,
      pathAnchor: null,
      path: null,
      onSetAnchor: noop,
      onClearAnchor: noop,
      onSelect: noop,
      onOpen: noop,
      origin,
      onClose: noop,
      isSample: () => false,
      onAction: noop,
      onNeighbors: noop,
    }),
  );
  const m = html.match(/class="graph-insp__back"[^>]*>([^<]*)</);
  return (m?.[1] ?? "").replace(/&amp;/g, "&").replace(/&#x27;/g, "'");
}

describe("GraphInspector — the way back to the note the user came from", () => {
  it("names the note exactly, `$` sequences included", () => {
    expect(backLabel("/v/wiki/Price $& notes.md", "en")).toBe("← Back to Price $& notes");
    expect(backLabel("/v/wiki/a$`b.md", "en")).toBe("← Back to a$`b");
    expect(backLabel("/v/wiki/cost-$$.md", "ko")).toBe("← cost-$$ 노트로 돌아가기");
  });
});
