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
import { ipc } from "../lib/ipc";
import { stem } from "../lib/graphData";
import { useVaultStore } from "../stores/vaultStore";
import { useLinkSuggestStore } from "../stores/linkSuggestStore";
import { useNoticeStore } from "../stores/noticeStore";
import { notice } from "../lib/notice";
import {
  acceptAll,
  acceptSuggestion,
  suggestLinks,
  type LinkSuggestion,
} from "../lib/linkSuggestions";

const SHOW = 6;
/** Matches `ls-leave` in styles.css: the accepted row slides out before it
 * is removed from the list. */
const LEAVE_MS = 320;
/** The chip progress slot this card owns while "accept all" runs. */
const PROGRESS_KEY = "links";

export default function LinkSuggestions({ t }: { t: Strings }): JSX.Element | null {
  const adjacency = useVaultStore((s) => s.adjacency);
  const refreshLinkGraph = useVaultStore((s) => s.refreshLinkGraph);
  // sem + dismissed live in a shared store (not useState) so the Topbar
  // activity popover shows the same pending count this card acts on.
  const sem = useLinkSuggestStore((s) => s.sem);
  const dismissed = useLinkSuggestStore((s) => s.dismissed);
  const refreshSem = useLinkSuggestStore((s) => s.refresh);
  const dismissKeys = useLinkSuggestStore((s) => s.dismiss);
  // Single-accept motion: the ✓ pops to filled the moment it is clicked,
  // then the row leaves once the write has landed.
  const [doneKey, setDoneKey] = useState<string | null>(null);
  const [leavingKey, setLeavingKey] = useState<string | null>(null);
  // "Accept all" reports through the activity chip, not this card: progress
  // lives in noticeStore's chip slot, the result arrives as a toast.
  const bulk = useNoticeStore((s) => s.progress?.key === PROGRESS_KEY);
  const setProgress = useNoticeStore((s) => s.setProgress);

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

  const failed = (err: string, retry: () => void): void => {
    notice.warn(t.ls_toast_failed ?? "Couldn't add the links", {
      sub: err,
      action: { label: t.ls_toast_retry ?? "Retry", run: retry },
    });
  };

  // One link = no toast (noise): the ✓ itself is the confirmation.
  async function accept(s: LinkSuggestion): Promise<void> {
    setDoneKey(s.key);
    try {
      await acceptSuggestion(s, ipc);
      setLeavingKey(s.key);
      await new Promise((r) => setTimeout(r, LEAVE_MS));
      dismiss(s); // accepted pairs also leave the queue
      await refreshLinkGraph();
    } catch (e) {
      failed(String(e), () => void accept(s));
    } finally {
      setDoneKey(null);
      setLeavingKey(null);
    }
  }

  // Same write path as a single ✓ (acceptSuggestion), just looped — no
  // parallel or new way to land a wikilink. Retry resumes with what is left.
  async function acceptAllSuggestions(list: LinkSuggestion[]): Promise<void> {
    if (useNoticeStore.getState().progress || list.length === 0) return;
    const total = list.length;
    const label = t.ls_linking ?? "Linking…";
    setProgress({ key: PROGRESS_KEY, label, done: 0, total });
    const { accepted, remaining, error: err } = await acceptAll(list, ipc, (done) =>
      setProgress({ key: PROGRESS_KEY, label, done, total }),
    );
    if (accepted.length > 0) {
      dismissKeys(accepted.map((s) => s.key));
      await refreshLinkGraph();
    }
    setProgress(null);
    if (err) {
      failed(err, () => void acceptAllSuggestions(remaining));
      return;
    }
    // No undo: acceptSuggestion has no inverse (the wikilink stays), so the
    // toast states the result and offers nothing it cannot do.
    notice.ok(
      (t.ls_toast_linked ?? "{n} links added").replace("{n}", String(accepted.length)),
      { sub: t.ls_toast_linked_sub ?? "[[wikilink]] under ## Related", icon: "link" },
    );
  }

  if (suggestions.length === 0) return null;

  return (
    <section className="card link-suggestions">
      <div className="row" style={{ justifyContent: "space-between", alignItems: "center", gap: 8 }}>
        <div className="section-title" style={{ fontSize: 14 }}>
          {t.ls_title ?? "Suggested links"}
        </div>
        <button
          type="button"
          className="btn"
          disabled={bulk}
          onClick={() => void acceptAllSuggestions(allPending)}
        >
          {`${t.ls_accept_all ?? "Accept all"} (${allPending.length})`}
        </button>
      </div>
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
              disabled={doneKey !== null || bulk}
              aria-label={t.ls_accept ?? "Link them"}
              title={t.ls_accept ?? "Link them"}
              onClick={() => void accept(s)}
            >
              <Icon name="check" size={13} />
            </button>
            <button
              type="button"
              className="icon-btn"
              disabled={bulk}
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
