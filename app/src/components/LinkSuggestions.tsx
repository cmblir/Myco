// Suggested links review queue (Overview) — the embedding similarity pairs
// that are NOT yet wikilinked, offered one by one. Accept appends the
// [[wikilink]] under the source note's "## Related" section (read → append →
// write, preserving frontmatter) and refreshes the link graph; dismiss
// remembers the pair (localStorage) and never shows it again. The AI only
// proposes — nothing is inserted without a click.

import { useEffect, useMemo, useState } from "react";
import type { JSX } from "react";
import { Icon } from "../lib/icons";
import type { Strings } from "../lib/i18n";
import { stem } from "../lib/graphData";
import { useVaultStore } from "../stores/vaultStore";
import { useLinkSuggestStore } from "../stores/linkSuggestStore";
import { useNoticeStore } from "../stores/noticeStore";
import { applyLinkSuggestions } from "../lib/linkActions";
import { useFocusTarget } from "../lib/useFocusTarget";
import {
  suggestLinks,
  type LinkSuggestion,
} from "../lib/linkSuggestions";

// Four rows: the card sits directly under the harvest queue now, as a compact
// second act — "accept all" still covers the whole pending list.
const SHOW = 4;
/** Matches `ls-leave` in styles.css: the accepted row slides out before it
 * is removed from the list. */
const LEAVE_MS = 320;
/** The chip progress slot this card owns while "accept all" runs. */

export default function LinkSuggestions({ t }: { t: Strings }): JSX.Element | null {
  const adjacency = useVaultStore((s) => s.adjacency);
  // sem + dismissed live in a shared store (not useState) so the Topbar
  // activity popover shows the same pending count this card acts on.
  const sem = useLinkSuggestStore((s) => s.sem);
  const error = useLinkSuggestStore((s) => s.error);
  const dismissed = useLinkSuggestStore((s) => s.dismissed);
  const refreshSem = useLinkSuggestStore((s) => s.refresh);
  const dismissKeys = useLinkSuggestStore((s) => s.dismiss);
  // Single-accept motion: the ✓ pops to filled the moment it is clicked,
  // then the row leaves once the write has landed.
  const [doneKey, setDoneKey] = useState<string | null>(null);
  const [leavingKey, setLeavingKey] = useState<string | null>(null);
  // "Accept all" reports through the activity chip, not this card: progress
  // lives in noticeStore's chip slot, the result arrives as a toast.
  const busy = useLinkSuggestStore((s) => s.busy);
  const bulk = useNoticeStore((s) => s.progress?.key === "links");
  // "N suggested links" in the activity popover points HERE.
  const focusRef = useFocusTarget<HTMLElement>("links");

  // Keyed on `adjacency`, not fetched once: right after app launch the
  // semantic index is still reconciling, so a mount-time one-shot fetch came
  // back empty and the whole section silently never appeared. The link graph
  // refreshes when the vault settles (and after every accept), so it doubles
  // as the retry signal (the store dedupes by adjacency reference).
  useEffect(() => {
    void refreshSem(adjacency);
  }, [adjacency, refreshSem]);

  // The list DISPLAYS a handful at a time, but "accept all" means all —
  // accepting only the visible slice made the user re-click through the
  // queue six at a time. So compute the full pending set once and slice
  // for display.
  const allPending = useMemo(
    () =>
      adjacency && sem
        ? suggestLinks(adjacency, sem, dismissed, Number.POSITIVE_INFINITY)
        : [],
    [adjacency, sem, dismissed],
  );
  const suggestions = useMemo(() => allPending.slice(0, SHOW), [allPending]);

  function dismiss(s: LinkSuggestion): void {
    dismissKeys([s.key]);
  }

  // One link = no toast (noise): the ✓ itself is the confirmation.
  async function accept(s: LinkSuggestion): Promise<void> {
    setDoneKey(s.key);
    try {
      await applyLinkSuggestions([s], { onAccepted: async () => {
        setLeavingKey(s.key);
        await new Promise((r) => setTimeout(r, LEAVE_MS));
      } });
    } finally {
      setDoneKey(null);
      setLeavingKey(null);
    }
  }

  if (suggestions.length === 0 && !error) return null;

  return (
    // tabIndex: the activity row that names this section moves keyboard focus
    // here after scrolling it into view (useFocusTarget).
    <section
      className="card link-suggestions"
      ref={focusRef}
      tabIndex={-1}
    >
      <div className="row" style={{ justifyContent: "space-between", alignItems: "center", gap: 8 }}>
        <div className="section-title" style={{ fontSize: 14 }}>
          {t.ls_title ?? "Suggested links"}
        </div>
        <button
          type="button"
          className="btn"
          disabled={busy || bulk || allPending.length === 0}
          onClick={() => void applyLinkSuggestions(allPending, { bulk: true })}
        >
          {`${t.ls_accept_all ?? "Accept all"} (${allPending.length})`}
        </button>
      </div>
      {error ? (
        <p className="muted" role="alert">
          {error}{" "}
          <button type="button" className="btn" disabled={busy} onClick={() => void refreshSem(adjacency)}>
            {t.ls_toast_retry}
          </button>
        </p>
      ) : null}
      <p className="muted link-suggestions__hint">
        {t.ls_hint ??
          "Semantically close notes that aren't linked yet. Accept to add a [[wikilink]] under “## Related”."}
      </p>
      <ul className="link-suggestions__list">
        {suggestions.map((s) => (
          <li key={s.key} className={leavingKey === s.key ? "is-leaving" : undefined}>
            <span className="link-suggestions__pair" title={`${s.source} ↔ ${s.target}`}>
              {stem(s.source)} ↔ {stem(s.target)}
              <span className="muted"> · {(s.score * 100).toFixed(0)}%</span>
            </span>
            <button
              type="button"
              className={"icon-btn" + (doneKey === s.key ? " is-done" : "")}
              disabled={doneKey !== null || busy || bulk}
              aria-label={t.ls_accept ?? "Link them"}
              title={t.ls_accept ?? "Link them"}
              onClick={() => void accept(s)}
            >
              <Icon name="check" size={13} />
            </button>
            <button
              type="button"
              className="icon-btn"
              disabled={busy || bulk}
              aria-label={t.ls_dismiss ?? "Dismiss"}
              title={t.ls_dismiss ?? "Dismiss"}
              onClick={() => dismiss(s)}
            >
              <Icon name="x" size={13} />
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
