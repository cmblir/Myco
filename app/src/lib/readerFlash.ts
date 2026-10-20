// The lines a citation pointed at, lit for a moment once the reader has
// scrolled to them (UX audit A3). A StateField, not DOM classes: the editor
// draws only the viewport, so a line scrolled into view is created after
// the flash was asked for. `.ask-flash` (styles.css, Ask section) is the
// look; Preview puts the same class on the section's elements itself.

import { StateEffect, StateField } from "@codemirror/state";
import { Decoration, EditorView, type DecorationSet } from "@codemirror/view";

/** Flash 1-based lines `from`..`to` (clamped to the document); null clears. */
export const flashLinesEffect = StateEffect.define<{ from: number; to: number } | null>();

const flashLine = Decoration.line({ class: "ask-flash" });

export const flashField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    deco = deco.map(tr.changes);
    for (const e of tr.effects) {
      if (!e.is(flashLinesEffect)) continue;
      if (!e.value) return Decoration.none;
      const { doc } = tr.state;
      const from = Math.max(1, e.value.from);
      const to = Math.min(doc.lines, e.value.to);
      const ranges = [];
      for (let n = from; n <= to; n++) ranges.push(flashLine.range(doc.line(n).from));
      deco = Decoration.set(ranges);
    }
    return deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});

/** Duration — matches `.ask-flash`'s animation in styles.css. */
export const FLASH_MS = 2000;

/** Light lines `from`..`to` now and put them out after FLASH_MS. */
export function flashLines(view: EditorView, from: number, to: number): void {
  view.dispatch({ effects: flashLinesEffect.of({ from, to }) });
  window.setTimeout(() => {
    view.dispatch({ effects: flashLinesEffect.of(null) });
  }, FLASH_MS);
}
