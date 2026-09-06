// Gesture cheat-sheet popover — the graph's six interactions (click focus,
// double-click 2-hop, Cmd/Ctrl-click shortest path, Esc step-out, F spaceship,
// drag orbit) explained in one dismissible panel. Toggled by the "?" toolbar
// button in PageGraph; pure presentation, no graph state.

import type { JSX } from "react";
import { Icon } from "../lib/icons";
import type { Strings } from "../lib/i18n";

export default function GraphHelp({
  t,
  onClose,
}: {
  t: Strings;
  onClose: () => void;
}): JSX.Element {
  // kbd tokens stay untranslated on purpose: they are key/gesture names
  // (Esc, F, ⌘/Ctrl…), rendered as keycaps — the descriptions localize.
  const rows: { keys: string[]; text: string }[] = [
    { keys: ["Click"], text: t.gr_help_click ?? "Focus a note (1 hop)" },
    { keys: ["Click ×2"], text: t.gr_help_dblclick ?? "Widen focus to 2 hops" },
    {
      keys: ["⌘/Ctrl", "Click"],
      text: t.gr_help_cmdclick ?? "Shortest path between notes",
    },
    { keys: ["Esc"], text: t.gr_help_esc ?? "Step out of the focus" },
    { keys: ["F"], text: t.gr_help_fly ?? "Toggle spaceship mode" },
    { keys: ["Drag"], text: t.gr_help_drag ?? "Orbit the cosmos" },
  ];

  return (
    <aside
      className="graph-help"
      role="region"
      aria-label={t.gr_help_title ?? "Gestures & keys"}
    >
      <div className="graph-help__head">
        <span className="graph-help__title">
          {t.gr_help_title ?? "Gestures & keys"}
        </span>
        <button
          type="button"
          className="icon-btn"
          onClick={onClose}
          aria-label={t.ui_close ?? "Close"}
          title={t.ui_close ?? "Close"}
        >
          <Icon name="x" size={13} />
        </button>
      </div>
      <ul className="graph-help__list">
        {rows.map((r) => (
          <li className="graph-help__row" key={r.text}>
            <span className="graph-help__keys">
              {r.keys.map((k) => (
                <kbd key={k}>{k}</kbd>
              ))}
            </span>
            <span className="graph-help__text">{r.text}</span>
          </li>
        ))}
      </ul>
    </aside>
  );
}
