// The block menu's two openers: Mod-/ at the caret's block (Source and Live),
// and a ⋮⋮ handle beside the hovered block in the left margin (Live). Pointer
// events only: HTML5 drag and drop never reaches WebKit under Tauri. The menu
// itself is React (components/BlockMenu.tsx); this only says where it opens.

import { Prec, type Extension } from "@codemirror/state";
import {
  ViewPlugin,
  keymap,
  type EditorView,
  type ViewUpdate,
} from "@codemirror/view";
import { blockUnit } from "./editorBlockOps";

export interface BlockMenuRequest {
  view: EditorView;
  /** Where the menu's actions apply (blockActionTr's `pos`). */
  pos: number;
  /** Viewport point the menu's top-left corner goes to. */
  x: number;
  y: number;
}

export type OpenBlockMenu = (req: BlockMenuRequest) => void;

/** Mod-/ opens the menu under the caret's line. Replaces CodeMirror's
 *  toggle-comment binding, as in Notion. */
export function blockMenuKeymap(open: OpenBlockMenu): Extension {
  return Prec.high(
    keymap.of([
      {
        key: "Mod-/",
        preventDefault: true,
        run: (view) => {
          if (view.composing) return false;
          const pos = view.state.selection.main.head;
          const c = view.coordsAtPos(pos) ?? view.coordsAtPos(pos, -1);
          const left = view.contentDOM.getBoundingClientRect().left;
          open({ view, pos, x: left, y: c ? c.bottom + 4 : 0 });
          return true;
        },
      },
    ]),
  );
}

const HANDLE_W = 20;
/** On touch the handle is a finger's size and follows the caret (UX S51). */
const TOUCH_W = 44;
const coarse = (): boolean =>
  typeof matchMedia === "function" && matchMedia("(any-pointer: coarse)").matches;

/** The handle's left relative to the editor box, out in the margin left of
 *  `edge` (window x); null when it would start off the window's left edge
 *  (a phone's narrow gutter, where the keyboard toolbar's ⋮⋮ opens the menu
 *  instead). */
export function handleLeft(edge: number, boxLeft: number, width: number, clear: number): number | null {
  const x = edge - width - 4 - clear;
  return x < 0 ? null : x - boxLeft;
}
/** A table's row handles sit on its left edge, 14px into the margin
 *  (blocks/table.ts): the ⋮⋮ beside a table stands that much further out. */
const TABLE_CLEAR = 14;

/** The ⋮⋮ handle: shown beside the first line of the block under the
 *  pointer, hidden on typing and when the pointer leaves the editor. On a
 *  touch screen it stands beside the caret's block instead, 44px wide. */
export function blockHandle(open: OpenBlockMenu, label: string): Extension {
  return ViewPlugin.fromClass(
    class {
      readonly dom: HTMLButtonElement;
      /** Start of the block the handle stands beside; -1 while hidden. */
      at = -1;

      constructor(readonly view: EditorView) {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "cm-block-handle";
        b.textContent = "⋮⋮";
        b.title = label;
        b.setAttribute("aria-label", label);
        // Out of the tab order: Tab belongs to list nesting; Mod-/ is the key.
        b.tabIndex = -1;
        b.hidden = true;
        // Keep the editor's focus and selection; the click opens the menu.
        b.addEventListener("pointerdown", (e) => e.preventDefault());
        b.addEventListener("click", () => {
          if (this.at < 0) return;
          const r = b.getBoundingClientRect();
          open({ view, pos: this.at, x: r.left, y: r.bottom + 4 });
        });
        view.dom.appendChild(b);
        this.dom = b;
        view.dom.addEventListener("pointermove", this.move);
        view.dom.addEventListener("pointerleave", this.hide);
      }

      move = (e: PointerEvent): void => {
        if (e.target === this.dom || e.pointerType === "touch") return;
        const { view } = this;
        const line = view.lineBlockAtHeight(e.clientY - view.documentTop);
        const u = blockUnit(view.state, line.from);
        if (!u) return this.hide();
        const from = view.state.doc.line(u.first).from;
        if (from !== this.at) this.place(from);
      };

      hide = (e?: PointerEvent): void => {
        // A lifted finger "leaves"; on touch the caret places the handle.
        if (e?.pointerType === "touch") return;
        this.at = -1;
        this.dom.hidden = true;
      };

      place(from: number): void {
        this.show(from, this.measure(from));
      }

      /** Where the handle goes beside the block at `from` (layout reads
       *  only), or null where the margin cannot hold it. */
      measure(from: number): { left: number; top: number; height: number } | null {
        const { view } = this;
        const box = view.dom.getBoundingClientRect();
        // Left of the gutters (authorship bars), so it never covers them.
        const gutters = view.dom.querySelector(".cm-gutters");
        const edge = Math.min(
          view.contentDOM.getBoundingClientRect().left,
          gutters?.getBoundingClientRect().left ?? Infinity,
        );
        const row = view.coordsAtPos(from, 1);
        const block = view.lineBlockAt(from);
        const top = row ? row.top : view.documentTop + block.top;
        const bottom = row ? row.bottom : top + block.height;
        const widget = block.widget as { blockId?: string } | null;
        const clear = widget?.blockId === "table" ? TABLE_CLEAR : 0;
        const left = handleLeft(edge, box.left, coarse() ? TOUCH_W : HANDLE_W, clear);
        return left === null ? null : { left, top: top - box.top, height: bottom - top };
      }

      show(from: number, at: { left: number; top: number; height: number } | null): void {
        if (!at) return this.hide();
        const { dom } = this;
        this.at = from;
        dom.hidden = false;
        dom.style.left = `${at.left}px`;
        dom.style.top = `${at.top}px`;
        dom.style.height = `${at.height}px`;
      }

      update(u: ViewUpdate): void {
        // Stale once text moves; the next pointer move places it again.
        if (u.docChanged || u.geometryChanged || u.viewportChanged)
          this.hide();
        if (!coarse() || !(u.selectionSet || u.focusChanged || u.docChanged || u.geometryChanged))
          return;
        // Touch: beside the caret's block while the editor has focus,
        // placed once layout is readable.
        this.view.requestMeasure({
          read: (view) => {
            const unit = view.hasFocus && blockUnit(view.state, view.state.selection.main.head);
            if (!unit) return null;
            const from = view.state.doc.line(unit.first).from;
            return { from, at: this.measure(from) };
          },
          write: (m) => (m ? this.show(m.from, m.at) : this.hide()),
        });
      }

      destroy(): void {
        this.view.dom.removeEventListener("pointermove", this.move);
        this.view.dom.removeEventListener("pointerleave", this.hide);
        this.dom.remove();
      }
    },
  );
}
