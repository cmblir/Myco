// BlockMenu — Turn into / Duplicate / Delete / Move / Ask about this block
// for one editor block, opened by Mod-/ or the ⋮⋮ handle
// (lib/editorBlockHandle.ts). A search field with a listbox under it:
// arrows move, Enter applies, Esc closes and hands focus back to the
// editor. The edits are lib/editorBlockOps.ts; "Ask" opens the ask picker
// (RecallPicker.tsx) with the block's text instead.

import { useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { FocusEvent, JSX, KeyboardEvent } from "react";
import type { Strings } from "../lib/i18n";
import {
  askPrefill,
  blockActionOk,
  blockActionTr,
  blockActions,
  filterActions,
  type BlockAction,
} from "../lib/editorBlockOps";
import type { BlockMenuRequest } from "../lib/editorBlockHandle";
import { Sheet } from "./ui";

/** Keep the option `id` (the highlighted row Enter applies) scrolled into
 *  its list as the arrows, Home and End move it; a section's first row
 *  brings its head along. By id: useId's ids hold `:`. */
export function useActiveRowInView(id: string | undefined): void {
  useLayoutEffect(() => {
    const row = id ? document.getElementById(id) : null;
    const head = row?.previousElementSibling;
    if (head?.classList.contains("block-menu__head"))
      head.scrollIntoView({ block: "nearest" });
    row?.scrollIntoView({ block: "nearest" });
  }, [id]);
}

export default function BlockMenu({
  t,
  req,
  onClose,
  onAsk,
  sheet = false,
}: {
  t: Strings;
  req: BlockMenuRequest;
  /** Touch: the actions as 44px rows in the shared sheet, no search box
   *  (it would raise the keyboard), Indent/Outdent among them (UX S51). */
  sheet?: boolean;
  /** `refocus`: hand focus back to the editor (Esc, a pick), not on blur. */
  onClose: (refocus: boolean) => void;
  /** "Ask about this block": open the ask picker on `question`, the answer
   *  to go in at `pos` (askPrefill). */
  onAsk: (question: string, pos: number) => void;
}): JSX.Element {
  const { view, pos } = req;
  const boxRef = useRef<HTMLDivElement>(null);
  const listId = useId();
  const actions = useMemo(() => blockActions(t, { nest: sheet }), [t, sheet]);
  // What applies here, judged once on the doc as it was when the menu opened
  // (the editor closes the menu if the doc changes under it).
  const usable = useMemo(
    () =>
      new Set(
        actions
          .filter((a) => blockActionOk(view.state, pos, a))
          .map((a) => a.id),
      ),
    [actions, view, pos],
  );
  // The highlight starts on the first row that applies (not the block's own
  // kind), so a bare Enter always does something.
  const firstUsable = (list: BlockAction[]): number =>
    Math.max(0, list.findIndex((a) => usable.has(a.id)));
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(() => firstUsable(actions));
  const shown = filterActions(actions, query);
  const current = shown[Math.min(active, shown.length - 1)];
  const activeId = current ? `${listId}-${current.id}` : undefined;
  useActiveRowInView(activeId);

  useLayoutEffect(() => {
    const el = boxRef.current;
    if (!el || sheet) return;
    const r = el.getBoundingClientRect();
    el.style.left = `${Math.max(8, Math.min(req.x, window.innerWidth - r.width - 8))}px`;
    el.style.top = `${Math.max(8, Math.min(req.y, window.innerHeight - r.height - 8))}px`;
    el.querySelector("input")?.focus();
  }, [req.x, req.y, sheet]);

  function pick(a: BlockAction | undefined): void {
    if (!a || !usable.has(a.id)) return;
    const tr = blockActionTr(view.state, pos, a);
    // Change first, then focus: the editor draws the new selection on focus.
    if (tr) view.dispatch(tr);
    onClose(true);
    // Once the menu is closed: the picker takes the focus as it mounts.
    const ask = a.id === "ask" ? askPrefill(view.state, pos) : null;
    if (ask) onAsk(ask.question, ask.pos);
  }

  function onKey(e: KeyboardEvent<HTMLInputElement>): void {
    // Mid-composition (Korean IME) the keys belong to the IME.
    if (e.nativeEvent.isComposing) return;
    const n = shown.length;
    const moves: Record<string, number> = {
      ArrowDown: (active + 1) % Math.max(n, 1),
      ArrowUp: (active - 1 + n) % Math.max(n, 1),
      Home: 0,
      End: n - 1,
    };
    if (e.key in moves) {
      e.preventDefault();
      setActive(Math.max(0, moves[e.key]));
    } else if (e.key === "Enter") {
      e.preventDefault();
      pick(current);
    } else if (e.key === "Escape") {
      e.preventDefault();
      onClose(true);
    } else if (e.key === "Tab") {
      e.preventDefault(); // focus stays in the menu until it closes
    }
  }

  function onBlur(e: FocusEvent<HTMLDivElement>): void {
    if (!boxRef.current?.contains(e.relatedTarget as Node | null))
      onClose(false);
  }

  const turnHead = t.bm_turn_into ?? "Turn into";
  const actionsHead = t.bm_actions ?? "Actions";
  if (sheet)
    return (
      <Sheet title={t.bm_handle ?? "Block menu"} closeLabel={t.ui_close} onClose={() => onClose(true)}>
        <ul className="myco-menu" role="menu">
          {actions.map((a, i) => {
            const turn = a.turn !== undefined;
            const head =
              i > 0 && (actions[i - 1].turn !== undefined) === turn ? null : turn ? turnHead : actionsHead;
            return [
              head ? (
                <li key={head} className="block-menu__head" role="presentation">
                  {head}
                </li>
              ) : null,
              <li key={a.id} role="none">
                <button type="button" role="menuitem" disabled={!usable.has(a.id)} onClick={() => pick(a)}>
                  <span className="block-menu__icon" aria-hidden="true">
                    {a.icon}
                  </span>
                  {a.label}
                </button>
              </li>,
            ];
          })}
        </ul>
      </Sheet>
    );
  return (
    <div
      ref={boxRef}
      className="block-menu"
      role="dialog"
      aria-label={t.bm_handle ?? "Block menu"}
      onBlur={onBlur}
    >
      <input
        className="block-menu__search"
        value={query}
        placeholder={t.bm_search ?? "Search actions…"}
        role="combobox"
        aria-expanded="true"
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={activeId}
        onChange={(e) => {
          setQuery(e.target.value);
          setActive(firstUsable(filterActions(actions, e.target.value)));
        }}
        onKeyDown={onKey}
      />
      <ul className="block-menu__list" role="listbox" id={listId}>
        {shown.map((a, i) => {
          // Section heads only while browsing, as in the slash menu.
          const turn = a.turn !== undefined;
          const head =
            query || (i > 0 && (shown[i - 1].turn !== undefined) === turn)
              ? null
              : turn
                ? turnHead
                : actionsHead;
          const off = !usable.has(a.id);
          return [
            head ? (
              <li key={head} className="block-menu__head" role="presentation">
                {head}
              </li>
            ) : null,
            <li
              key={a.id}
              id={`${listId}-${a.id}`}
              role="option"
              aria-selected={a === current}
              aria-disabled={off}
              className={
                "block-menu__item" +
                (a === current ? " is-active" : "") +
                (off ? " is-off" : "")
              }
              onPointerDown={(e) => e.preventDefault()}
              onPointerMove={() => setActive(i)}
              onClick={() => pick(a)}
            >
              <span className="block-menu__icon" aria-hidden="true">
                {a.icon}
              </span>
              {a.label}
            </li>,
          ];
        })}
        {shown.length === 0 ? (
          <li className="block-menu__empty" role="presentation">
            {t.sl_no_results ?? "No results"}
          </li>
        ) : null}
      </ul>
    </div>
  );
}
