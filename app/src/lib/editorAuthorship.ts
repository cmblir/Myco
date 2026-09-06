// Authorship gutter: a violet bar beside every paragraph an agent wrote
// (mockup "Manuscript"). Built on the installed `@codemirror/view` gutter() —
// no new dependency — and composed alongside the live extension rather than
// inside it. With no runs (vault history off, untracked file) it contributes
// NO extension at all, so the gutter takes zero width and shows no banner
// asking anyone to turn anything on.

import type { Extension } from "@codemirror/state";
import { GutterMarker, gutter } from "@codemirror/view";
import type { GutterRun } from "./authorship";

export interface AuthorshipGutterOptions {
  runs: readonly GutterRun[];
  /** Hover text for one paragraph, e.g. "myco agent · 2 days ago". */
  label: (run: GutterRun) => string;
  /** Gutter click: the run plus the pointer, for anchoring the popover. */
  onSelect: (run: GutterRun, x: number, y: number) => void;
}

class RunMarker extends GutterMarker {
  constructor(
    private readonly run: GutterRun,
    private readonly text: string,
  ) {
    super();
  }
  override eq(other: RunMarker): boolean {
    return other.run.from === this.run.from && other.run.agent === this.run.agent;
  }
  override toDOM(): HTMLElement {
    const el = document.createElement("span");
    el.className = "auth-run" + (this.run.agent ? " is-agent" : "");
    el.title = this.text;
    return el;
  }
}

export function authorshipGutter(opts: AuthorshipGutterOptions): Extension {
  if (opts.runs.length === 0) return [];
  const at = (line: number): GutterRun | undefined =>
    opts.runs.find((r) => r.from <= line && line <= r.to);
  return gutter({
    class: "cm-auth-gutter",
    lineMarker: (view, block) => {
      const run = at(view.state.doc.lineAt(block.from).number);
      return run ? new RunMarker(run, opts.label(run)) : null;
    },
    // The markers come from props, not from editor state: redraw whenever the
    // document moved lines under them.
    lineMarkerChange: (update) => update.docChanged,
    initialSpacer: null,
    domEventHandlers: {
      mousedown: (view, block, event) => {
        const run = at(view.state.doc.lineAt(block.from).number);
        if (!run) return false;
        const e = event as MouseEvent;
        opts.onSelect(run, e.clientX, e.clientY);
        return true;
      },
    },
  });
}
