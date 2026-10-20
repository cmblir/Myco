// Every toast can be dismissed on its own (a labelled × button), and a stack
// of three stays readable: older toasts step back in size, never in opacity.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import postcss from "postcss";
import { describe, expect, it } from "vitest";
import { Toast, focusAfterClose } from "./NoticeStack";
import type { Notice } from "../stores/noticeStore";
import { STRINGS } from "../lib/i18n";

const toast = (n: Omit<Notice, "id" | "ttlMs">, i: number): string =>
  renderToStaticMarkup(
    h(Toast, {
      notice: { ...n, id: `n${i}`, ttlMs: 4000 },
      depth: i,
      leaving: false,
      closeLabel: STRINGS.ko.ui_close,
      onClose: () => undefined,
    }),
  );

describe("NoticeStack", () => {
  it("gives every toast a labelled close button, with or without an action", () => {
    const html = [
      { kind: "ok" as const, title: "저장됨" },
      { kind: "warn" as const, title: "실패", action: { label: "다시", run: () => undefined } },
      { kind: "info" as const, title: "안내" },
    ]
      .map(toast)
      .join("");
    const closes = html.match(new RegExp(`<button[^>]*aria-label="${STRINGS.ko.ui_close}"`, "g"));
    expect(closes).toHaveLength(3);
    expect(html).toContain(">다시</button>");
  });

  it("stacks older toasts without fading them", () => {
    const css = readFileSync(resolve(__dirname, "../styles.css"), "utf8");
    const faded: string[] = [];
    postcss.parse(css).walkRules((rule) => {
      if (!/\.notice\.is-depth-\d/.test(rule.selector)) return;
      rule.walkDecls("opacity", (d) => void faded.push(`${rule.selector} { opacity: ${d.value} }`));
    });
    expect(faded).toEqual([]);
  });

  // Closing a toast from the keyboard (×, its action, Escape) must not drop
  // focus to <body>: it moves to the neighbouring toast's ×, the one that
  // slides into the closed toast's place first.
  describe("focusAfterClose", () => {
    const none = new Set<string>();
    it("moves to the next older toast, else the newer one", () => {
      expect(focusAfterClose(["a", "b", "c"], none, "b")).toBe("c");
      expect(focusAfterClose(["a", "b", "c"], none, "c")).toBe("b");
      expect(focusAfterClose(["a", "b", "c"], none, "a")).toBe("b");
    });
    it("skips toasts already on their way out", () => {
      expect(focusAfterClose(["a", "b", "c"], new Set(["c"]), "b")).toBe("a");
      expect(focusAfterClose(["a", "b"], new Set(["a"]), "b")).toBeNull();
    });
    it("has nowhere to go when the stack empties", () => {
      expect(focusAfterClose(["a"], none, "a")).toBeNull();
    });
  });
});
