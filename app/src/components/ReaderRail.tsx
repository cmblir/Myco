// The reader's one rail (mockup "Manuscript"): properties → authorship →
// outline → sources & trust → connections, in that order. Stateless — every section owns
// its own data; this only decides the stack.
//
// Each section is a shared <Rail>, the same part the graph's gaps column and
// legend are built from, so the three rails in the app are one implementation.

import { useRef } from "react";
import type { JSX, ReactNode } from "react";
import type { AuthBadgeView } from "../lib/authorship";
import type { Strings } from "../lib/i18n";
import type { FmPatch, Frontmatter } from "../lib/frontmatter";
import type { OutlineHeading } from "../lib/outline";
import type { LinkSuggestionIO } from "../lib/linkSuggestions";
import { Icon } from "../lib/icons";
import Rail from "./Rail";
import { useModalFocus } from "./useModalFocus";
import PropertiesPanel from "./PropertiesPanel";
import OutlinePanel from "./OutlinePanel";
import SourcesPanel from "./SourcesPanel";
import ConnectionsPanel from "./ConnectionsPanel";

export default function ReaderRail({
  filePath,
  fm,
  allTags,
  onPatch,
  headings,
  onSelectHeading,
  io,
  /** raw/ is immutable: no property form, no accepting links into it. */
  readOnly,
  authorship,
  t,
}: {
  filePath: string;
  fm: Frontmatter | null;
  allTags: string[];
  onPatch: (p: FmPatch) => void;
  headings: OutlineHeading[];
  onSelectHeading: (h: OutlineHeading) => void;
  io: LinkSuggestionIO;
  readOnly: boolean;
  /** Who wrote the note, from vault history; null = no record. It used to
   *  sit in the note's head (UX S14). */
  authorship: AuthBadgeView | null;
  t: Strings;
}): JSX.Element {
  return (
    <aside className="reader-rail" aria-label={t.rd_rail ?? "Note rail"}>
      {readOnly ? null : (
        <PropertiesPanel fm={fm} allTags={allTags} onPatch={onPatch} t={t} />
      )}
      {authorship ? (
        <Rail title={t.rd_auth_section}>
          <span className="auth-badge">
            <span className="auth-bar" aria-hidden="true">
              <span
                className="auth-bar__human"
                style={{ width: `${authorship.humanPct}%` }}
              />
            </span>
            <span>
              {t.auth_badge_human
                .replace("{h}", String(authorship.humanPct))
                .replace("{a}", String(authorship.agentPct))}
              {authorship.lastHumanRel
                ? " · " + t.auth_badge_last_human.replace("{t}", authorship.lastHumanRel)
                : ""}
            </span>
          </span>
        </Rail>
      ) : null}
      <Rail
        title={t.ol_title ?? "Outline"}
        count={headings.length > 0 ? headings.length : undefined}
      >
        <OutlinePanel t={t} headings={headings} onSelect={onSelectHeading} />
      </Rail>
      <SourcesPanel filePath={filePath} t={t} />
      <ConnectionsPanel filePath={filePath} io={io} t={t} />
    </aside>
  );
}

/** The rail as an overlay sheet at the window's right edge (owner default 5:
 *  a narrow window or pane). Scrim click, Esc and the close button all close
 *  it; useModalFocus keeps Tab inside and hands focus back to the rail's
 *  button. The caller portals it to <body>, out of the page's stacking. */
export function ReaderRailSheet({
  t,
  onClose,
  children,
}: {
  t: Strings;
  onClose: () => void;
  children: ReactNode;
}): JSX.Element {
  const ref = useRef<HTMLDivElement | null>(null);
  const { onKeyDown } = useModalFocus(ref, { open: true, onEscape: onClose });
  return (
    <div className="myco-modal__backdrop reader-sheet-backdrop" onClick={onClose}>
      <div
        ref={ref}
        className="reader-sheet"
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={t.rd_rail}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        <button
          type="button"
          className="icon-btn reader-sheet__close"
          aria-label={t.ui_close}
          title={t.ui_close}
          onClick={onClose}
        >
          <Icon name="x" size={16} />
        </button>
        {children}
      </div>
    </div>
  );
}
