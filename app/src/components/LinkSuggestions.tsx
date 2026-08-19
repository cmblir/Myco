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
import { ipc, type SemEdge } from "../lib/ipc";
import { stem } from "../lib/graphData";
import { useVaultStore } from "../stores/vaultStore";
import {
  acceptAll,
  acceptSuggestion,
  loadDismissed,
  saveDismissed,
  suggestLinks,
  type LinkSuggestion,
} from "../lib/linkSuggestions";

const SHOW = 6;

export default function LinkSuggestions({ t }: { t: Strings }): JSX.Element | null {
  const adjacency = useVaultStore((s) => s.adjacency);
  const refreshLinkGraph = useVaultStore((s) => s.refreshLinkGraph);
  const [sem, setSem] = useState<SemEdge[] | null>(null);
  const [dismissed, setDismissed] = useState<Set<string>>(() => loadDismissed());
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [bulk, setBulk] = useState<{ done: number; total: number } | null>(null);
  const [bulkResult, setBulkResult] = useState<number | null>(null);

  // Keyed on `adjacency`, not fetched once: right after app launch the
  // semantic index is still reconciling, so a mount-time one-shot fetch came
  // back empty and the whole section silently never appeared. The link graph
  // refreshes when the vault settles (and after every accept), so it doubles
  // as the retry signal.
  useEffect(() => {
    let killed = false;
    ipc
      .semanticEdges(4)
      .then((edges) => {
        if (!killed) setSem(edges);
      })
      .catch(() => {
        if (!killed) setSem([]);
      });
    return () => {
      killed = true;
    };
  }, [adjacency]);

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
    const next = new Set(dismissed);
    next.add(s.key);
    setDismissed(next);
    saveDismissed(next);
  }

  async function accept(s: LinkSuggestion): Promise<void> {
    setBusyKey(s.key);
    setError(null);
    try {
      await acceptSuggestion(s, ipc);
      dismiss(s); // accepted pairs also leave the queue immediately
      await refreshLinkGraph();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusyKey(null);
    }
  }

  // Same write path as a single ✓ (acceptSuggestion), just looped — no
  // parallel or new way to land a wikilink.
  async function acceptAllSuggestions(): Promise<void> {
    if (bulk) return;
    setError(null);
    setBulkResult(null);
    const total = allPending.length;
    setBulk({ done: 0, total });
    const { accepted, error: err } = await acceptAll(allPending, ipc, (done) =>
      setBulk({ done, total }),
    );
    if (accepted.length > 0) {
      const next = new Set(dismissed);
      for (const s of accepted) next.add(s.key);
      setDismissed(next);
      saveDismissed(next);
      await refreshLinkGraph();
    }
    setBulk(null);
    if (err) setError(err);
    else setBulkResult(accepted.length);
  }

  // Keep the section mounted right after an accept-all empties the queue —
  // unmounting here also swallowed the "{n} linked" confirmation, which read
  // as the feature silently breaking.
  if (suggestions.length === 0 && bulkResult === null && !bulk) return null;

  return (
    <section className="card link-suggestions">
      <div className="row" style={{ justifyContent: "space-between", alignItems: "center", gap: 8 }}>
        <div className="section-title" style={{ fontSize: 14 }}>
          {t.ls_title ?? "Suggested links"}
        </div>
        <button
          type="button"
          className="btn"
          disabled={!!bulk}
          onClick={() => void acceptAllSuggestions()}
        >
          {bulk
            ? (t.ls_accept_all_progress ?? "{done}/{total}")
                .replace("{done}", String(bulk.done))
                .replace("{total}", String(bulk.total))
            : `${t.ls_accept_all ?? "Accept all"} (${allPending.length})`}
        </button>
      </div>
      <p className="muted link-suggestions__hint">
        {t.ls_hint ??
          "Semantically close notes that aren't linked yet. Accept to add a [[wikilink]] under “## Related”."}
      </p>
      {error ? <p className="link-suggestions__error">{error}</p> : null}
      {bulkResult !== null ? (
        <p className="muted link-suggestions__hint">
          {(t.ls_accept_all_result ?? "{n} linked").replace("{n}", String(bulkResult))}
        </p>
      ) : null}
      <ul className="link-suggestions__list">
        {suggestions.map((s) => (
          <li key={s.key}>
            <span className="link-suggestions__pair" title={`${s.source} ↔ ${s.target}`}>
              {stem(s.source)} ↔ {stem(s.target)}
              <span className="muted"> · {(s.score * 100).toFixed(0)}%</span>
            </span>
            <button
              type="button"
              className="icon-btn"
              disabled={busyKey === s.key || !!bulk}
              aria-label={t.ls_accept ?? "Link them"}
              title={t.ls_accept ?? "Link them"}
              onClick={() => void accept(s)}
            >
              <Icon name="check" size={13} />
            </button>
            <button
              type="button"
              className="icon-btn"
              disabled={!!bulk}
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
