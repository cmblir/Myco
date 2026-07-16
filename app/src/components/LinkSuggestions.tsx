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
  appendWikilink,
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
  }, []);

  const suggestions = useMemo(
    () => (adjacency && sem ? suggestLinks(adjacency, sem, dismissed, SHOW) : []),
    [adjacency, sem, dismissed],
  );

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
      const file = await ipc.readFile(s.source);
      const next = appendWikilink(file.raw, s.target);
      if (next !== file.raw) await ipc.writeFile(s.source, next);
      dismiss(s); // accepted pairs also leave the queue immediately
      await refreshLinkGraph();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusyKey(null);
    }
  }

  if (suggestions.length === 0) return null;

  return (
    <section className="card link-suggestions">
      <div className="section-title" style={{ fontSize: 14 }}>
        {t.ls_title ?? "Suggested links"}
      </div>
      <p className="muted link-suggestions__hint">
        {t.ls_hint ??
          "Semantically close notes that aren't linked yet. Accept to add a [[wikilink]] under “## Related”."}
      </p>
      {error ? <p className="link-suggestions__error">{error}</p> : null}
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
              disabled={busyKey === s.key}
              aria-label={t.ls_accept ?? "Link them"}
              title={t.ls_accept ?? "Link them"}
              onClick={() => void accept(s)}
            >
              <Icon name="check" size={13} />
            </button>
            <button
              type="button"
              className="icon-btn"
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
