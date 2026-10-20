// The one modal focus contract (useModalFocus): Escape closes, Tab stays
// inside, focus lands on the modal's chosen control or its first one. The
// node env has no DOM, so the decisions are driven with stand-in elements;
// the hook's timing (focus in the commit, again after the opener's effects,
// back to the opener on close) is checked in the browser.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { focusInto, modalKeyDown, returnFocus } from "./useModalFocus";

afterEach(() => vi.unstubAllGlobals());

interface FakeEl {
  id: number;
  offsetParent: object | null;
  focus: () => void;
}

function fakeDialog(n: number) {
  const doc: { activeElement: unknown } = { activeElement: null };
  vi.stubGlobal("document", doc);
  const els: FakeEl[] = [];
  for (let i = 0; i < n; i++)
    els.push({ id: i, offsetParent: {}, focus: vi.fn(() => void (doc.activeElement = els[i])) });
  const dialog = {
    querySelectorAll: () => els,
    querySelector: () => els[0] ?? null,
    // Node#contains is true for the node itself, as in the DOM.
    contains: (x: unknown) => x === dialog || els.includes(x as FakeEl),
  } as unknown as HTMLElement;
  return { doc, els, dialog };
}

const key = (k: string, shiftKey = false) => ({
  key: k,
  shiftKey,
  preventDefault: vi.fn(),
  stopPropagation: vi.fn(),
});
type Key = Parameters<typeof modalKeyDown>[0];

describe("modalKeyDown", () => {
  it("closes on Escape and stops it there, so the page behind never sees it", () => {
    const { dialog } = fakeDialog(2);
    const onEscape = vi.fn();
    const e = key("Escape");
    modalKeyDown(e as unknown as Key, dialog, onEscape);
    expect(onEscape).toHaveBeenCalledOnce();
    expect(e.stopPropagation).toHaveBeenCalled();
  });

  // Escape mid-composition cancels the IME's candidate; it is not a close.
  it("leaves an Escape that cancels an IME composition to the IME", () => {
    const { dialog } = fakeDialog(1);
    const onEscape = vi.fn();
    modalKeyDown({ ...key("Escape"), isComposing: true } as unknown as Key, dialog, onEscape);
    modalKeyDown({ ...key("Escape"), keyCode: 229 } as unknown as Key, dialog, onEscape);
    expect(onEscape).not.toHaveBeenCalled();
  });

  it("wraps Tab from the last control to the first, and Shift+Tab back", () => {
    const { doc, els, dialog } = fakeDialog(3);
    doc.activeElement = els[2];
    const tab = key("Tab");
    modalKeyDown(tab as unknown as Key, dialog, vi.fn());
    expect(tab.preventDefault).toHaveBeenCalled();
    expect(doc.activeElement).toBe(els[0]);
    modalKeyDown(key("Tab", true) as unknown as Key, dialog, vi.fn());
    expect(doc.activeElement).toBe(els[2]);
  });

  it("brings a Tab that starts outside the modal back in", () => {
    const { doc, els, dialog } = fakeDialog(2);
    doc.activeElement = { outside: true };
    modalKeyDown(key("Tab") as unknown as Key, dialog, vi.fn());
    expect(doc.activeElement).toBe(els[0]);
  });

  // A click on the modal's text focuses the modal itself (tabIndex -1), not a
  // control: Tab and Shift+Tab from there still land on its controls.
  it("takes Tab and Shift+Tab from the focused modal itself to its first and last control", () => {
    const { doc, els, dialog } = fakeDialog(3);
    doc.activeElement = dialog;
    const back = key("Tab", true);
    modalKeyDown(back as unknown as Key, dialog, vi.fn());
    expect(back.preventDefault).toHaveBeenCalled();
    expect(doc.activeElement).toBe(els[2]);
    doc.activeElement = dialog;
    modalKeyDown(key("Tab") as unknown as Key, dialog, vi.fn());
    expect(doc.activeElement).toBe(els[0]);
  });

  it("leaves every other key alone", () => {
    const { doc, els, dialog } = fakeDialog(2);
    doc.activeElement = els[1];
    const onEscape = vi.fn();
    const e = key("a");
    modalKeyDown(e as unknown as Key, dialog, onEscape);
    expect(onEscape).not.toHaveBeenCalled();
    expect(e.preventDefault).not.toHaveBeenCalled();
    expect(doc.activeElement).toBe(els[1]);
  });
});

describe("focusInto", () => {
  it("focuses the modal's chosen control", () => {
    const { doc, els, dialog } = fakeDialog(3);
    focusInto(dialog, () => els[2] as unknown as HTMLElement);
    expect(doc.activeElement).toBe(els[2]);
  });

  it("falls back to the first control when there is no choice (or it is gone)", () => {
    const { doc, els, dialog } = fakeDialog(3);
    focusInto(dialog, () => null);
    expect(doc.activeElement).toBe(els[0]);
    doc.activeElement = null;
    focusInto(dialog);
    expect(doc.activeElement).toBe(els[0]);
  });

  it("does nothing while the modal is not rendered", () => {
    fakeDialog(0);
    expect(() => focusInto(null)).not.toThrow();
  });
});

// The ⌘K palette closed with focus on <body>: its Escape, and the Tidy sheet
// or New note prompt a row opened (whose opener was then <body>), left the
// keyboard user nowhere.
describe("returnFocus", () => {
  function page() {
    const body = { tag: "body" };
    const doc: { activeElement: unknown; body: unknown } = { activeElement: body, body };
    vi.stubGlobal("document", doc);
    const el = (isConnected = true) => {
      const e = { isConnected, focus: vi.fn(() => void (doc.activeElement = e)) };
      return e;
    };
    return { doc, body, el };
  }
  const as = (x: unknown) => x as HTMLElement;

  it("hands focus back to the opener when the close left it on <body>", () => {
    const { doc, el } = page();
    const ask = el();
    returnFocus(as(ask));
    expect(doc.activeElement).toBe(ask);
  });

  it("leaves focus where the close put it (a page or modal that took it)", () => {
    const { doc, el } = page();
    const ask = el();
    const editor = el();
    doc.activeElement = editor;
    returnFocus(as(ask));
    expect(ask.focus).not.toHaveBeenCalled();
    expect(doc.activeElement).toBe(editor);
  });

  it("skips an opener the close removed (the route changed) and a missing one", () => {
    const { doc, body, el } = page();
    const gone = el(false);
    returnFocus(as(gone));
    expect(gone.focus).not.toHaveBeenCalled();
    expect(() => returnFocus(null)).not.toThrow();
    expect(doc.activeElement).toBe(body);
  });
});

// Every modal keeps focus the same way. A new aria-modal surface that rolls its
// own (or none — the onboarding wizard left focus on <body> and let Tab walk
// the sidebar behind it) fails here.
describe("modal surfaces", () => {
  // The palette is a combobox: one tab stop (the input), rows by arrow keys,
  // and its own Tab → input / Escape handling on the panel.
  const OWN_MODEL = new Set(["components/CommandBar.tsx"]);
  // The JSX attribute, not a `[aria-modal="true"]` selector in a query.
  const ARIA_MODAL = /\saria-modal=["{]/;

  function modalFiles(): { rel: string; text: string }[] {
    const src = resolve(__dirname, "..");
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (name.endsWith(".tsx")) files.push(p);
      }
    };
    walk(src);
    return files
      .map((p) => ({ rel: relative(src, p), text: readFileSync(p, "utf8") }))
      .filter(({ rel, text }) => ARIA_MODAL.test(text) && !OWN_MODEL.has(rel));
  }

  /** Each opening tag that carries aria-modal, as prettier lays it out: from
   *  its `<tag` line to the line that is only `>`. */
  function openingTags(text: string): string[] {
    const lines = text.split("\n");
    const tags: string[] = [];
    lines.forEach((line, i) => {
      if (!ARIA_MODAL.test(line)) return;
      let start = i;
      while (start > 0 && !/^\s*<[A-Za-z]/.test(lines[start])) start--;
      let end = i;
      while (end < lines.length - 1 && !/^\s*\/?>\s*$/.test(lines[end])) end++;
      tags.push(lines.slice(start, end + 1).join("\n"));
    });
    return tags;
  }

  it("the palette, with its own key model, still hands focus back on close", () => {
    const src = readFileSync(resolve(__dirname, "CommandBar.tsx"), "utf8");
    expect(src).toMatch(/\breturnFocus\(/);
  });

  it("all use useModalFocus", () => {
    const rolling = modalFiles()
      .filter(({ text }) => !/\buseModalFocus\(/.test(text))
      .map(({ rel }) => rel);
    expect(rolling).toEqual([]);
  });

  // The modal element takes focus itself (tabIndex -1), so a click on its
  // text or title does not drop focus to <body> — where no keydown reaches
  // the modal's onKeyDown and Escape stopped closing it.
  it("each make the modal element focusable, so a click on its text keeps Escape working", () => {
    const missing = modalFiles()
      .flatMap(({ rel, text }) => openingTags(text).map((tag) => ({ rel, tag })))
      .filter(({ tag }) => !/\stabIndex=\{-1\}/.test(tag))
      .map(({ rel }) => rel);
    expect(missing).toEqual([]);
  });
});
