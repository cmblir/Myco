// Optional retrieval details. These are response statistics and settings,
// not sequential pipeline totals. Unknown values show "—".

import { useState } from "react";
import type { JSX } from "react";
import { Icon } from "../lib/icons";
import type { Strings } from "../lib/i18n";
import type { RetrievalTrace } from "../lib/ladder";

interface Step {
  key: string;
  label: string;
  value: string;
  sub: string;
  /** Styling reflects reported counts/settings, never a retrieval-arm claim. */
  cls: "" | "on" | "drop" | "cold" | "off";
}

export default function RetrievalStepper({
  t,
  trace,
  archivedOn,
  lang,
  id,
}: {
  t: Strings;
  trace: RetrievalTrace;
  /** `search_archived_sessions` — the archive step reads the setting, not a
   *  count the client never sees. */
  archivedOn: boolean;
  lang: string;
  /** Unique per turn — ties the button to the panel it expands. */
  id: string;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const nf = (n: number): string => n.toLocaleString(lang);
  const count = (n: number | null): string => (n === null ? "—" : nf(n));
  const floor = trace.floor.toFixed(2);
  const steps: Step[] = [
    {
      key: "candidates",
      label: t.q_trace_candidates,
      value: count(trace.indexedPages),
      sub: t.q_trace_candidates_sub,
      cls: trace.indexedPages === null ? "off" : "",
    },
    {
      key: "bm25",
      label: t.q_trace_bm25,
      value: count(trace.returnedWithoutSimilarity),
      sub: t.q_trace_bm25_sub,
      cls:
        trace.returnedWithoutSimilarity === null
          ? "off"
          : trace.returnedWithoutSimilarity
            ? "on"
            : "",
    },
    {
      key: "dense",
      label: t.q_trace_dense,
      value: count(trace.returnedWithSimilarity),
      sub: t.q_trace_dense_sub,
      cls:
        trace.returnedWithSimilarity === null
          ? "off"
          : trace.returnedWithSimilarity
            ? "on"
            : "",
    },
    {
      key: "rrf",
      label: t.q_trace_rrf,
      value: nf(trace.returnedChunks),
      sub: t.q_trace_rrf_sub,
      cls: trace.returnedChunks ? "on" : "",
    },
    {
      key: "cap",
      label: t.q_trace_cap,
      value: nf(trace.cap),
      sub: t.q_trace_cap_sub.replace("{k}", nf(trace.cap)),
      cls: "",
    },
    {
      key: "floor",
      label: t.q_trace_floor,
      value: nf(trace.rejectedExamples),
      sub: t.q_trace_floor_sub.replace("{floor}", floor),
      cls: trace.rejectedExamples ? "drop" : "",
    },
    {
      key: "cold",
      label: t.q_trace_cold,
      value: archivedOn ? t.q_trace_cold_on : t.q_trace_cold_off,
      sub: archivedOn ? t.q_trace_cold_on_sub : t.q_trace_cold_off_sub,
      cls: archivedOn ? "cold" : "off",
    },
  ];
  return (
    <div>
      <div className="ask-tracebar">
        <h3>{t.q_trace_title}</h3>
        <button
          type="button"
          className="ask-stepper"
          aria-expanded={open}
          aria-controls={id}
          onClick={() => setOpen((o) => !o)}
        >
          <span className="ask-chev">
            {t.q_trace_toggle} <Icon name="chevD" size={14} />
          </span>
        </button>
      </div>
      <div id={id} className="ask-trace" hidden={!open}>
        {steps.map((s) => (
          <div key={s.key} className={`ask-st ${s.cls}`}>
            <div className="k">{s.label}</div>
            <div className="v">{s.value}</div>
            <div className="s" title={s.sub}>
              {s.sub}
            </div>
          </div>
        ))}
        <div className="ask-tracefoot">
          {t.q_trace_params.replace("{floor}", floor)}
        </div>
      </div>
    </div>
  );
}
