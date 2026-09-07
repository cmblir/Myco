// The graph's toolbar row — the Survey's one genuinely new control surface,
// kept when the 3D galaxy came back, but no longer four hero cards, a chips
// row and a bordered honesty box stacked above the picture. It is now the page
// frame's `bar`: one Segment for the question, one for the size, two Checks,
// and the rebuild stat as a Chip pushed right.
//
// A question changes only the ENCODING (graphEncoding.ts) of the coordinates
// the sim already produced, so the four answers are comparable on one map and
// nothing here rebuilds it — which is why the rebuild count belongs beside the
// controls that must not move it.
//
// The search box the Survey put here is deliberately absent: the header row's
// find field already restyles-without-rebuilding and flies the camera on Enter.

import type { JSX } from "react";
import { Check, Chip, Segment } from "./ui";
import type { Question, SizeBy } from "../lib/graphEncoding";
import type { GraphSettings } from "../lib/graphSettings";
import type { Strings } from "../lib/i18n";

/** Live counts behind the question segment and the honesty line. */
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

/**
 * The honesty disclosure as ONE line for the frame's `note`: what the picture
 * draws, how much of it is first-run sample, and what is structurally absent.
 * It used to be a bordered box with a stacked bar; the numbers are the point,
 * not the frame around them.
 */
export function honestyNote(t: Strings, counts: SurveyCounts, edges: number): string {
  const pct = counts.total > 0 ? Math.round((counts.sample / counts.total) * 100) : 0;
  const drawn = `${counts.total} ${t.gr_node_count} · ${edges} ${t.gr_edge_count}`;
  return [
    drawn,
    fill(t.gr_honest_lead, { n: counts.total }),
    fill(t.gr_honest, {
      sample: counts.sample,
      pct,
      own: counts.own,
      unresolved: counts.unresolved,
      cited: counts.cited,
    }),
    fill(t.gr_honest_sessions, { n: counts.sessions.toLocaleString() }),
  ].join(" · ");
}

export default function GraphQuestions({
  t,
  settings,
  counts,
  build,
  onChange,
}: {
  t: Strings;
  settings: GraphSettings;
  counts: SurveyCounts;
  build: BuildStat;
  onChange: (patch: Partial<GraphSettings>) => void;
}): JSX.Element {
  const questions: { value: Question; label: string; count?: number }[] = [
    { value: "orphans", label: t.gr_q_orphans, count: counts.gaps },
    { value: "clusters", label: t.gr_q_clusters, count: counts.clusters },
    { value: "time", label: t.gr_q_time, count: counts.fresh30d },
    {
      value: "neighbors",
      label: t.gr_q_neighbors,
      // Nothing selected yet — a bare 0 would read as "no neighbours".
      count: counts.neighbors ?? undefined,
    },
  ];
  const sizes: { value: SizeBy; label: string }[] = [
    { value: "backlinks", label: t.gr_size_backlinks },
    { value: "cites", label: t.gr_size_cites },
  ];

  return (
    <>
      <Segment
        options={questions}
        value={settings.question}
        onChange={(question) => onChange({ question })}
        label={t.gr_q_lead}
      />
      <Segment
        options={sizes}
        value={settings.sizeBy}
        onChange={(sizeBy) => onChange({ sizeBy })}
        label={t.gr_size}
      />
      <Check
        checked={settings.hideSample}
        onChange={(hideSample) => onChange({ hideSample })}
        label={fill(t.gr_hide_sample, { n: counts.sample })}
      />
      {/* One state, two doors: the drawer's "existing files only" filter is
          the same switch read the other way round. */}
      <Check
        checked={!settings.existingOnly}
        onChange={(show) => onChange({ existingOnly: !show })}
        label={t.gr_show_unresolved}
      />
      {/* Pushed right, and live: the number the user watches to confirm that
          typing in the find field does NOT rebuild the scene. */}
      <span className="graph-rebuilds" aria-live="polite">
        <Chip label={fill(t.gr_rebuilds, { n: build.builds, ms: build.ms.toFixed(1) })} />
      </span>
    </>
  );
}
