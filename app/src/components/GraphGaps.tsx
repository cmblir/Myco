// Gap analysis panel — the graph as an instrument. Lists the actionable gaps in
// the vault (missing pages, orphans, under-cited, low-confidence, disputed,
// disconnected islands) as clickable rows; clicking flies the camera to the node
// and opens its inspector, so "what should I ingest/fix next?" becomes a click.
// Fed by lib/graphGaps.analyzeGaps over the live graph — no backend call.

import type { JSX } from "react";
import { Icon } from "../lib/icons";
import type { Strings } from "../lib/i18n";
import { stem } from "../lib/graphData";
import { gapCount, type GapReport } from "../lib/graphGaps";

const GHOST = "ghost:";
const MAX_ROWS = 15; // per category, with a "+N more" tail

function displayName(id: string): string {
  return id.startsWith(GHOST) ? id.slice(GHOST.length) : stem(id);
}

export default function GraphGaps({
  t,
  report,
  onSelect,
  onClose,
}: {
  t: Strings;
  report: GapReport;
  onSelect: (id: string) => void;
  onClose: () => void;
}): JSX.Element {
  const cats: { label: string; ids: string[] }[] = [
    { label: t.gr_gap_missing ?? "Missing pages", ids: report.missing },
    { label: t.gr_gap_orphans ?? "Orphans", ids: report.orphans },
    { label: t.gr_gap_undercited ?? "Under-cited", ids: report.underCited },
    { label: t.gr_gap_lowconf ?? "Low confidence", ids: report.lowConfidence },
    { label: t.gr_gap_disputed ?? "Disputed", ids: report.disputed },
    { label: t.gr_gap_islands ?? "Disconnected", ids: report.islands.flat() },
  ].filter((c) => c.ids.length > 0);

  const total = gapCount(report);

  return (
    <aside className="graph-gaps" role="region" aria-label={t.gr_gaps_title ?? "Gaps"}>
      <div className="graph-gaps__head">
        <span className="graph-gaps__title">
          {t.gr_gaps_title ?? "Gaps"} <span className="muted">({total})</span>
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

      {total === 0 ? (
        <p className="graph-gaps__none">{t.gr_gap_none ?? "No gaps found"}</p>
      ) : (
        cats.map((c) => (
          <div className="graph-gaps__section" key={c.label}>
            <h4>
              {c.label} <span className="muted">({c.ids.length})</span>
            </h4>
            <ul className="graph-gaps__links">
              {c.ids.slice(0, MAX_ROWS).map((id) => (
                <li key={id}>
                  <button
                    type="button"
                    className="graph-gaps__link"
                    title={id}
                    onClick={() => onSelect(id)}
                  >
                    {displayName(id)}
                  </button>
                </li>
              ))}
              {c.ids.length > MAX_ROWS ? (
                <li className="graph-gaps__more">
                  +{c.ids.length - MAX_ROWS} {t.gr_gap_more ?? "more"}
                </li>
              ) : null}
            </ul>
          </div>
        ))
      )}
    </aside>
  );
}
