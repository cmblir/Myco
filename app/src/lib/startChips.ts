// Start chips (UX S24): under an empty note's `/` hint, a few starters to
// pick without knowing the slash menu — the vault's `slash:` templates on a
// plain note, three day starters on a daily note. Gone at the first input.

import {
  StateEffect,
  StateField,
  type EditorState,
  type Extension,
  type Transaction,
} from "@codemirror/state";
import { Decoration, EditorView, WidgetType, type DecorationSet } from "@codemirror/view";
import { applySlash, bodyStart } from "./editorBlocks";
import type { SlashItem } from "./editorCompletions";
import type { Strings } from "./i18n";
import { fillBody } from "./templates";

/** Nothing past the frontmatter and a `# title` line (bodyStart's own
 *  "empty body" case lands the caret at the very end). */
export function isBodyEmpty(doc: string): boolean {
  return bodyStart(doc) === doc.replace(/\r\n?/g, "\n").length;
}

type DayKeys =
  | "start_day_todo"
  | "start_day_todo_body"
  | "start_day_meeting"
  | "start_day_meeting_body"
  | "start_day_thoughts"
  | "start_day_thoughts_body";

/** The chips for an empty note: the first three templates, or on a daily
 *  note the three day starters (their `${}` marks the caret). */
export function startChips(
  templates: readonly SlashItem[],
  isDaily: boolean,
  t: Pick<Strings, DayKeys>,
): SlashItem[] {
  if (!isDaily) return templates.slice(0, 3);
  const day = (label: string, body: string): SlashItem => ({
    label,
    detail: label,
    aliases: [],
    icon: "▤",
    section: "templates",
    apart: true,
    ...fillBody(body, { date: "", time: "", title: "" }),
  });
  return [
    day(t.start_day_todo, t.start_day_todo_body),
    day(t.start_day_meeting, t.start_day_meeting_body),
    day(t.start_day_thoughts, t.start_day_thoughts_body),
  ];
}

/** Insert `item` where the body starts, as `/` would there. */
export function applyStartChip(
  view: { state: EditorState; dispatch: (tr: Transaction) => void },
  item: SlashItem,
): void {
  const at = bodyStart(view.state.doc.toString());
  applySlash(view, item, at, at);
}

/** Dispatched once templates/ has been read: the chips draw again. */
export const redrawStartChips = StateEffect.define<null>();

class StartChipsWidget extends WidgetType {
  constructor(
    readonly chips: readonly SlashItem[],
    readonly label: string,
  ) {
    super();
  }
  override eq(w: StartChipsWidget): boolean {
    return (
      w.label === this.label &&
      w.chips.map((c) => c.detail + c.template).join("\0") ===
        this.chips.map((c) => c.detail + c.template).join("\0")
    );
  }
  toDOM(view: EditorView): HTMLElement {
    const el = document.createElement("div");
    el.className = "start-chips";
    el.setAttribute("role", "group");
    el.setAttribute("aria-label", this.label);
    const label = document.createElement("span");
    label.className = "start-chips__label";
    label.setAttribute("aria-hidden", "true");
    label.textContent = this.label;
    el.append(label);
    for (const c of this.chips) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "start-chip";
      b.textContent = c.detail;
      b.addEventListener("click", () => {
        applyStartChip(view, c);
        view.focus();
      });
      el.append(b);
    }
    return el;
  }
  // The buttons take their own clicks; CodeMirror would move the caret.
  override ignoreEvent(): boolean {
    return true;
  }
}

/** Live: the chips as a block under the note's last line while its body is
 *  empty; `chips` is asked again on every edit and redraw. */
export function startChipsField(chips: () => SlashItem[], label: string): Extension {
  const build = (state: EditorState): DecorationSet => {
    const list = isBodyEmpty(state.doc.toString()) ? chips() : [];
    if (list.length === 0) return Decoration.none;
    return Decoration.set(
      Decoration.widget({
        widget: new StartChipsWidget(list, label),
        block: true,
        side: 1,
      }).range(state.doc.length),
    );
  };
  return StateField.define<DecorationSet>({
    create: build,
    update: (deco, tr) =>
      tr.docChanged || tr.effects.some((e) => e.is(redrawStartChips))
        ? build(tr.state)
        : deco,
    provide: (f) => EditorView.decorations.from(f),
  });
}
