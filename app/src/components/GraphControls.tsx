// Survey top bar — the whole control surface, one row of it. The old drawer
// had ~30 controls (13 layouts, 7 skins, 10 vibes, 25 sliders, saved looks);
// what survives is the four questions, the size channel, the two corpus
// filters, a search box that only restyles, and an honesty line stating what
// the picture actually contains.

import type { JSX } from "react";
import { useEffect, useState } from "react";
import type { Question, SizeBy } from "../lib/graphEncoding";
import type { GraphSettings } from "../lib/graphSettings";
import type { Strings } from "../lib/i18n";

/** Live counts behind the question chips and the honesty line. */
export interface SurveyCounts {
  /** Nodes actually drawn. */
  total: number;
  sample: number;
  own: number;
  unresolved: number;
  /** Gap rows across every bucket — the "빈 곳" number. */
  gaps: number;
  orphans: number;
  noBacklink: number;
  clusters: number;
  maplessClusters: number;
  fresh30d: number;
  /** 2-hop neighbourhood size of the selected note; null = nothing selected. */
  neighbors: number | null;
  /** Session transcripts structurally excluded by graphData's NON_KNOWLEDGE_FOLDERS. */
  sessions: number;
  cited: number;
}

export interface BuildStat {
  /** Scene rebuilds since mount — MUST NOT move when the search box changes. */
  builds: number;
  ms: number;
}

function fill(tpl: string, vals: Record<string, string | number>): string {
  return Object.entries(vals).reduce((s, [k, v]) => s.split(`{${k}}`).join(String(v)), tpl);
}

export default function GraphControls({
  t,
  settings,
  counts,
  build,
  search,
  onChange,
  onSearch,
}: {
  t: Strings;
  settings: GraphSettings;
  counts: SurveyCounts;
  build: BuildStat;
  search: string;
  onChange: (patch: Partial<GraphSettings>) => void;
  /** Styling only — never a rebuild. */
  onSearch: (q: string) => void;
}): JSX.Element {
  const [draft, setDraft] = useState(search);
  useEffect(() => setDraft(search), [search]);

  const questions: { q: Question; title: string; unit: string; sub: string; n: string }[] = [
    {
      q: "orphans",
      title: t.gr_q_orphans,
      unit: t.gr_q_orphans_u,
      n: String(counts.gaps),
      sub: fill(t.gr_q_sub_orphans, {
        orphans: counts.orphans,
        unresolved: counts.unresolved,
        nobacklink: counts.noBacklink,
      }),
    },
    {
      q: "clusters",
      title: t.gr_q_clusters,
      unit: t.gr_q_clusters_u,
      n: String(counts.clusters),
      sub: fill(t.gr_q_sub_clusters, {
        nomap: counts.maplessClusters,
        map: Math.max(0, counts.clusters - counts.maplessClusters),
      }),
    },
    {
      q: "time",
      title: t.gr_q_time,
      unit: t.gr_q_time_u,
      n: String(counts.fresh30d),
      sub: fill(t.gr_q_sub_time, { sample: counts.sample }),
    },
    {
      q: "neighbors",
      title: t.gr_q_neighbors,
      unit: t.gr_q_neighbors_u,
      n: counts.neighbors == null ? "—" : String(counts.neighbors),
      sub: counts.neighbors == null ? t.gr_q_pick : t.gr_q_sub_neighbors,
    },
  ];

  const pct = counts.total > 0 ? Math.round((counts.sample / counts.total) * 100) : 0;
  const honest = fill(t.gr_honest, {
    sample: counts.sample,
    pct,
    own: counts.own,
    unresolved: counts.unresolved,
    cited: counts.cited,
  });

  return (
    <div className="sv-top">
      <p className="sv-q__lead" id="sv-qlabel">
        {t.gr_q_lead}
      </p>
      <div className="sv-qs" role="group" aria-labelledby="sv-qlabel">
        {questions.map((q) => (
          <button
            key={q.q}
            type="button"
            className="sv-q"
            aria-pressed={settings.question === q.q}
            onClick={() => onChange({ question: q.q })}
          >
            <span className="sv-q__t">{q.title}</span>
            <span className="sv-q__big">
              <span className="sv-q__unit">{q.unit}</span>
              <b className="sv-q__num">{q.n}</b>
            </span>
            <span className="sv-q__n">{q.sub}</span>
          </button>
        ))}
      </div>

      <div className="sv-ctl">
        <label className="sv-field">
          <span className="vh">{t.gr_find_ph}</span>
          <input
            type="search"
            value={draft}
            placeholder={t.gr_find_ph}
            autoComplete="off"
            onChange={(e) => {
              setDraft(e.target.value);
              onSearch(e.target.value);
            }}
          />
        </label>

        <div className="sv-seg" role="group" aria-label={t.gr_size}>
          {(["backlinks", "cites"] as SizeBy[]).map((s) => (
            <button
              key={s}
              type="button"
              aria-pressed={settings.sizeBy === s}
              onClick={() => onChange({ sizeBy: s })}
            >
              {s === "backlinks" ? t.gr_size_backlinks : t.gr_size_cites}
            </button>
          ))}
        </div>

        <label className="sv-chk">
          <input
            type="checkbox"
            checked={settings.hideSample}
            onChange={(e) => onChange({ hideSample: e.target.checked })}
          />
          {fill(t.gr_hide_sample, { n: counts.sample })}
        </label>
        <label className="sv-chk">
          <input
            type="checkbox"
            checked={settings.showUnresolved}
            onChange={(e) => onChange({ showUnresolved: e.target.checked })}
          />
          {t.gr_show_unresolved}
        </label>

        <span className="sv-ctl__spacer" />
        <span className="sv-stat mono" aria-live="polite">
          {fill(t.gr_rebuilds, { n: build.builds, ms: build.ms.toFixed(1) })}
        </span>
      </div>

      <p className="sv-honest">
        <span className="sv-honest__lead">{fill(t.gr_honest_lead, { n: counts.total })}</span>
        <span className="sv-bar" role="img" aria-label={honest}>
          <i style={{ width: `${pct}%`, background: "var(--warn)" }} />
          <i
            style={{
              width: `${counts.total > 0 ? Math.round((counts.own / counts.total) * 100) : 0}%`,
              background: "var(--ok)",
            }}
          />
        </span>
        <span className="sv-honest__txt">
          {honest} {fill(t.gr_honest_sessions, { n: counts.sessions.toLocaleString() })}
        </span>
      </p>
    </div>
  );
}
