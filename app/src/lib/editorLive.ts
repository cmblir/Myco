// Live preview for the CodeMirror editor: hides markdown marks on every line
// the caret is not on, renders bullets / task checkboxes / heading sizes in
// place and replaces frontmatter with a one-line block widget. `liveSpecs`
// is the pure walker over the Lezer tree (vitest, node); `liveExtension`
// wires it to the view.

import type { SyntaxNodeRef, Tree } from "@lezer/common";
import {
  Prec,
  StateField,
  type Extension,
  type Range,
  type Text,
} from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
} from "@codemirror/view";
import { syntaxTree } from "@codemirror/language";
import { matchWikilinkAt } from "./wikilinks";
import { frontmatterLength } from "./markdown";

export type LiveSpec =
  | { kind: "hide"; from: number; to: number }
  | { kind: "line"; from: number; cls: string }
  | { kind: "mark"; from: number; to: number; cls: string }
  | { kind: "bullet"; from: number; to: number }
  | { kind: "task"; from: number; to: number; checked: boolean };

const HEADING_RE = /^(?:ATX|Setext)Heading([1-6])$/;
const MARK_CLASS: Record<string, string> = {
  StrongEmphasis: "live-strong",
  Emphasis: "live-em",
  InlineCode: "live-code-inline",
  Strikethrough: "live-strike",
};

function fmEndOf(doc: Text): number {
  // ponytail: 32 KB frontmatter cap
  return frontmatterLength(doc.sliceString(0, Math.min(doc.length, 32768)));
}

/** Pure: decoration specs for [from,to) given the tree, doc and the 1-based lines holding a selection. */
export function liveSpecs(
  tree: Tree,
  doc: Text,
  activeLines: ReadonlySet<number>,
  from = 0,
  to = doc.length,
): LiveSpec[] {
  const out: LiveSpec[] = [];
  const fmEnd = fmEndOf(doc);
  const inactive = (pos: number): boolean =>
    !activeLines.has(doc.lineAt(pos).number);
  const hide = (a: number, b: number): void => {
    out.push({ kind: "hide", from: a, to: b });
  };
  // One `line` spec per line the node covers, clamped to the window.
  const lines = (n: SyntaxNodeRef, cls: string): void => {
    const end = Math.min(n.to, to);
    let l = doc.lineAt(Math.max(n.from, from));
    for (;;) {
      out.push({ kind: "line", from: l.from, cls });
      if (l.to >= end || l.number === doc.lines) break;
      l = doc.line(l.number + 1);
    }
  };
  const link = (n: SyntaxNodeRef): false => {
    const line = doc.lineAt(n.from);
    const col = n.from - line.from;
    // `[[…]]`: Lezer sees the inner `[…]` as a bare Link between two brackets.
    const wl =
      line.text[col - 1] === "[" && line.text[n.to - line.from] === "]"
        ? matchWikilinkAt(line.text, col - 1)
        : null;
    if (wl && wl.end === n.to + 1 - line.from) {
      out.push({
        kind: "mark",
        from: n.from - 1,
        to: n.to + 1,
        cls: "live-wikilink",
      });
      if (inactive(n.from)) {
        hide(n.from - 1, n.from + 1);
        const pipe = doc.sliceString(n.from + 1, n.to - 1).indexOf("|");
        if (pipe >= 0) hide(n.from + 1, n.from + 2 + pipe);
        hide(n.to - 1, n.to + 1);
      }
      return false;
    }
    const node = n.node;
    if (!node.getChild("URL")) return false; // bare `[text]` stays raw
    out.push({ kind: "mark", from: n.from, to: n.to, cls: "live-link" });
    if (inactive(n.from)) {
      hide(n.from, n.from + 1);
      const close = node
        .getChildren("LinkMark")
        .find((m) => doc.sliceString(m.from, m.to) === "]");
      if (close) hide(close.from, n.to);
    }
    return false;
  };

  tree.iterate({
    from,
    to,
    enter(n) {
      if (n.from < fmEnd) return n.name === "Document";
      const h = HEADING_RE.exec(n.name);
      if (h) {
        lines(n, `live-h${h[1]}`);
        return;
      }
      const cls = MARK_CLASS[n.name];
      if (cls) {
        out.push({ kind: "mark", from: n.from, to: n.to, cls });
        return;
      }
      switch (n.name) {
        case "FencedCode":
        case "CodeBlock":
          lines(n, "live-code");
          return false;
        case "Image":
        case "HTMLBlock":
          return false;
        case "Blockquote":
          lines(n, "live-quote");
          return;
        case "Link":
          return link(n);
        case "ListMark":
          if (inactive(n.from) && /^[-*+]$/.test(doc.sliceString(n.from, n.to)))
            out.push({ kind: "bullet", from: n.from, to: n.to });
          return;
        case "TaskMarker":
          if (inactive(n.from))
            out.push({
              kind: "task",
              from: n.from,
              to: n.to,
              checked: doc.sliceString(n.from, n.to) !== "[ ]",
            });
          return;
        case "HeaderMark":
        case "QuoteMark":
          if (inactive(n.from))
            hide(
              n.from,
              n.to + (doc.sliceString(n.to, n.to + 1) === " " ? 1 : 0),
            );
          return;
        case "EmphasisMark":
        case "CodeMark":
        case "StrikethroughMark":
          if (inactive(n.from)) hide(n.from, n.to);
          return;
      }
    },
  });
  return out;
}

/** Pure: target of the wikilink whose [[…]] span (inclusive) contains `col`, else null. */
export function wikilinkAtCursor(lineText: string, col: number): string | null {
  for (
    let i = lineText.indexOf("[[");
    i >= 0;
    i = lineText.indexOf("[[", i + 1)
  ) {
    const m = matchWikilinkAt(lineText, i);
    if (m && col >= i && col <= m.end) return m.target;
  }
  return null;
}

export interface LiveOptions {
  onLinkClick: (target: string) => void;
  taskLabel: string;
  fmLabel: string;
}

class GlyphWidget extends WidgetType {
  constructor(
    private readonly text: string,
    private readonly cls: string,
  ) {
    super();
  }
  override eq(w: GlyphWidget): boolean {
    return w.text === this.text;
  }
  toDOM(): HTMLElement {
    const el = document.createElement("span");
    el.className = this.cls;
    el.textContent = this.text;
    return el;
  }
}

class TaskWidget extends WidgetType {
  constructor(
    private readonly checked: boolean,
    private readonly label: string,
  ) {
    super();
  }
  override eq(w: TaskWidget): boolean {
    return w.checked === this.checked;
  }
  toDOM(): HTMLElement {
    const el = document.createElement("input");
    el.type = "checkbox";
    el.className = "live-task";
    el.checked = this.checked;
    el.setAttribute("aria-label", this.label);
    return el;
  }
  // Keep the same DOM node across a toggle so keyboard focus stays on it.
  override updateDOM(dom: HTMLElement): boolean {
    (dom as HTMLInputElement).checked = this.checked;
    return true;
  }
  override ignoreEvent(): boolean {
    return false;
  }
}

const HIDE = Decoration.replace({});
const BULLET = Decoration.replace({
  widget: new GlyphWidget("•", "live-bullet"),
});

function toRange(s: LiveSpec, taskLabel: string): Range<Decoration> {
  switch (s.kind) {
    case "hide":
      return HIDE.range(s.from, s.to);
    case "line":
      return Decoration.line({ class: s.cls }).range(s.from);
    case "mark":
      return Decoration.mark({ class: s.cls }).range(s.from, s.to);
    case "bullet":
      return BULLET.range(s.from, s.to);
    case "task":
      return Decoration.replace({
        widget: new TaskWidget(s.checked, taskLabel),
      }).range(s.from, s.to);
  }
}

function build(view: EditorView, taskLabel: string): DecorationSet {
  const { doc, selection } = view.state;
  const active = new Set<number>();
  for (const r of selection.ranges) {
    const last = doc.lineAt(r.to).number;
    for (let l = doc.lineAt(r.from).number; l <= last; l++) active.add(l);
  }
  const tree = syntaxTree(view.state);
  const ranges: Range<Decoration>[] = [];
  for (const { from, to } of view.visibleRanges)
    for (const s of liveSpecs(tree, doc, active, from, to))
      ranges.push(toRange(s, taskLabel));
  return Decoration.set(ranges, true);
}

function isTaskBox(el: EventTarget | null): el is HTMLInputElement {
  return el instanceof HTMLInputElement && el.classList.contains("live-task");
}

/** Flip the `[ ]`/`[x]` the checkbox widget stands in for; no-op when stale. */
function toggleTask(view: EditorView, box: HTMLInputElement): boolean {
  const pos = view.posAtDOM(box);
  const cur = view.state.sliceDoc(pos, pos + 3);
  if (!/^\[[ xX]\]$/.test(cur)) return false;
  view.dispatch({
    changes: { from: pos, to: pos + 3, insert: cur === "[ ]" ? "[x]" : "[ ]" },
  });
  return true;
}

export function liveExtension(opts: LiveOptions): Extension {
  const fmDeco = (doc: Text): DecorationSet => {
    const end = fmEndOf(doc);
    if (end === 0) return Decoration.none;
    return Decoration.set(
      Decoration.replace({
        widget: new GlyphWidget(opts.fmLabel, "live-fm"),
        block: true,
      }).range(0, doc.lineAt(end - 1).to),
    );
  };
  // A StateField (not a fold) so PropertiesPanel's replace of [0,end) keeps
  // the frontmatter hidden.
  const frontmatterField = StateField.define<DecorationSet>({
    create: (s) => fmDeco(s.doc),
    update: (v, tr) => (tr.docChanged ? fmDeco(tr.state.doc) : v),
    provide: (f) => EditorView.decorations.from(f),
  });
  const plugin = ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = build(view, opts.taskLabel);
      }
      update(u: ViewUpdate): void {
        if (
          u.docChanged ||
          u.viewportChanged ||
          u.selectionSet ||
          syntaxTree(u.state) !== syntaxTree(u.startState)
        )
          this.decorations = build(u.view, opts.taskLabel);
      }
    },
    {
      decorations: (v) => v.decorations,
      eventHandlers: {
        mousedown(e, view) {
          if (e.button !== 0) return false;
          // Only keep CM from moving the caret; `click` does the toggle so the
          // browser's own check flip and the doc agree.
          if (isTaskBox(e.target)) return true;
          if (!(e.metaKey || e.ctrlKey)) return false;
          const pos = view.posAtCoords({ x: e.clientX, y: e.clientY });
          if (pos == null) return false;
          const line = view.state.doc.lineAt(pos);
          const target = wikilinkAtCursor(line.text, pos - line.from);
          if (!target) return false;
          opts.onLinkClick(target);
          return true;
        },
        click(e, view) {
          if (isTaskBox(e.target)) toggleTask(view, e.target);
          return false; // cancelling `click` would revert the native check
        },
        keydown(e, view) {
          return (
            isTaskBox(e.target) &&
            (e.key === " " || e.key === "Enter") &&
            toggleTask(view, e.target)
          );
        },
      },
    },
  );
  return [
    frontmatterField,
    // Caret motion skips the hidden block instead of walking into the YAML.
    EditorView.atomicRanges.of((v) => v.state.field(frontmatterField)),
    // Above the keymaps so Enter on a checkbox toggles instead of inserting.
    Prec.high(plugin),
  ];
}
