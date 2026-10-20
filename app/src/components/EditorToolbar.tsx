// The keyboard toolbar (UX S51): on a touch screen, while the editor has
// focus and a soft keyboard is up, one row of buttons rides above it
// (visualViewport): the commands a hardware keyboard reaches by Tab, ⌘B,
// `/` and Mod-/.
// Selecting text swaps in the format tools. "+" lays the `/` blocks out as
// tiles in a sheet; ⋮⋮ opens the block menu as a sheet. The edits are
// lib/editorToolbar.ts; this only draws and routes.

import { useState } from "react";
import type { JSX } from "react";
import { createPortal } from "react-dom";
import type { EditorView } from "@codemirror/view";
import { startCompletion } from "@codemirror/autocomplete";
import type { Strings } from "../lib/i18n";
import { runTool, toolbarShows, toolsFor, type ToolId } from "../lib/editorToolbar";
import { applySlash, type OpenPicker } from "../lib/editorBlocks";
import {
  SLASH_SECTIONS,
  slashItems,
  slashSectionNames,
  type SlashItem,
} from "../lib/editorCompletions";
import { Sheet, useKeyboardFrame } from "./ui";

const ICONS: Record<ToolId, string> = {
  undo: "↶",
  wikilink: "[[",
  tag: "#",
  todo: "☐",
  heading: "H",
  outdent: "⇤",
  indent: "⇥",
  up: "↑",
  down: "↓",
  add: "＋",
  menu: "⋮⋮",
  hide: "⌄",
  bold: "B",
  italic: "I",
  highlight: "≡",
  code: "</>",
  link: "[[ ]]",
};

function labelOf(t: Strings, id: ToolId): string {
  const labels: Record<ToolId, string> = {
    undo: t.tb_undo,
    wikilink: t.tb_wikilink,
    tag: t.tb_tag,
    todo: t.tb_todo,
    heading: t.tb_heading,
    outdent: t.bm_outdent,
    indent: t.bm_indent,
    up: t.bm_move_up,
    down: t.bm_move_down,
    add: t.tb_add,
    menu: t.bm_handle,
    hide: t.tb_hide,
    bold: t.tb_bold,
    italic: t.tb_italic,
    highlight: t.tb_highlight,
    code: t.tb_code,
    link: t.tb_link,
  };
  return labels[id];
}

export default function EditorToolbar({
  t,
  view,
  editing,
  selected,
  onMenu,
  openPicker,
}: {
  t: Strings;
  view: EditorView;
  /** The editor has focus: the bar shows (the tiles sheet outlives it). */
  editing: boolean;
  /** Text is selected: the format tools show. */
  selected: boolean;
  /** ⋮⋮: open the block menu at the caret's block. */
  onMenu: (pos: number) => void;
  openPicker: OpenPicker;
}): JSX.Element {
  const frame = useKeyboardFrame();
  // "+": where the tiles insert, read when they open (the sheet takes focus).
  const [tilesAt, setTilesAt] = useState<number | null>(null);

  function press(id: ToolId): void {
    const head = view.state.selection.main.head;
    if (id === "hide") return view.contentDOM.blur();
    if (id === "menu") return view.composing ? undefined : onMenu(head);
    if (id === "add") return view.composing ? undefined : setTilesAt(head);
    if (runTool(view, id) && id === "wikilink") startCompletion(view);
  }

  function pickTile(item: SlashItem): void {
    const at = tilesAt;
    setTilesAt(null);
    if (at === null) return;
    view.focus();
    const pos = Math.min(at, view.state.doc.length);
    applySlash(view, item, pos, pos, openPicker);
  }

  const items = slashItems(t);
  const names = slashSectionNames(t);
  return (
    <>
      {toolbarShows(editing, frame.bottom) && createPortal(
        <div
          className="editor-toolbar"
          role="toolbar"
          aria-label={t.tb_label}
          style={{ bottom: frame.bottom }}
        >
          {toolsFor(selected).map((id) => (
            <button
              key={id}
              type="button"
              className={`editor-toolbar__btn editor-toolbar__btn--${id}`}
              aria-label={labelOf(t, id)}
              title={labelOf(t, id)}
              // Keep the editor's focus, so the keyboard stays up.
              onPointerDown={(e) => e.preventDefault()}
              onClick={() => press(id)}
            >
              <span aria-hidden="true">{ICONS[id]}</span>
            </button>
          ))}
        </div>,
        document.body,
      )}
      {tilesAt !== null ? (
        <Sheet
          title={t.tb_add}
          closeLabel={t.ui_close}
          onClose={() => {
            setTilesAt(null);
            view.focus();
          }}
        >
          {SLASH_SECTIONS.map((sec) => {
            const own = items.filter((i) => i.section === sec);
            if (!own.length) return null;
            return (
              <section key={sec} className="block-tiles">
                <h3 className="block-tiles__head">{names[sec]}</h3>
                <div className="block-tiles__grid">
                  {own.map((i) => (
                    <button
                      key={i.label}
                      type="button"
                      className="block-tiles__tile"
                      onClick={() => pickTile(i)}
                    >
                      <span className="block-menu__icon" aria-hidden="true">
                        {i.icon}
                      </span>
                      {i.detail}
                    </button>
                  ))}
                </div>
              </section>
            );
          })}
        </Sheet>
      ) : null}
    </>
  );
}
