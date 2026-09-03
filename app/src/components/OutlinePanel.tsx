// Reader outline: the note's headings as an indented list of buttons. Pure
// presentation — the page decides which pane (editor / preview) to scroll.

import type { JSX } from "react";
import type { Strings } from "../lib/i18n";
import type { OutlineHeading } from "../lib/outline";

export default function OutlinePanel({
  t,
  headings,
  onSelect,
}: {
  t: Strings;
  headings: OutlineHeading[];
  onSelect: (h: OutlineHeading) => void;
}): JSX.Element {
  return (
    <nav className="outline" aria-label={t.ol_title ?? "Outline"}>
      {headings.length === 0 ? (
        <p className="muted">{t.ol_empty ?? "No headings yet"}</p>
      ) : (
        <ul>
          {headings.map((h) => (
            <li key={h.line}>
              <button
                type="button"
                className="outline__item"
                style={{ paddingLeft: (h.level - 1) * 10 + 8 }}
                title={h.text}
                onClick={() => onSelect(h)}
              >
                {h.text || (t.ol_untitled ?? "(untitled)")}
              </button>
            </li>
          ))}
        </ul>
      )}
    </nav>
  );
}
