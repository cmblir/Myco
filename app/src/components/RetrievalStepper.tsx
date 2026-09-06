// One-line retrieval stepper above an extractive answer: the seven steps the
// backend's pipeline takes (candidates → BM25 → vector → RRF → cap → floor →
// archived), each with the number this response lets the client state
// truthfully (ladder.ts::traceOf) — unknowns show "—", nothing is inferred.
// Expands to the same seven as tiles plus the parameter footer.

import { Fragment, useState } from "react";
import type { JSX } from "react";
import { Icon } from "../lib/icons";
import type { Strings } from "../lib/i18n";
import type { RetrievalTrace } from "../lib/ladder";

interface Step {
  key: string;
  label: string;
  value: string;
  sub: string;
  /** on = the arm did work · drop = rejects · cold = archive searched · off = n/a */
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
  const floor = trace.floor.toFixed(2);
  const steps: Step[] = [
    {
      key: "candidates",
      label: t.q_trace_candidates,
      value: trace.indexedPages === null ? "—" : nf(trace.indexedPages),
      sub: t.q_trace_candidates_sub,
      cls: trace.indexedPages === null ? "off" : "",
    },
    {
      key: "bm25",
      label: t.q_trace_bm25,
      value: nf(trace.lexicalOnly),
      sub: t.q_trace_bm25_sub,
      cls: trace.lexicalOnly ? "on" : "",
    },
    {
      key: "dense",
      label: t.q_trace_dense,
      value: nf(trace.dense),
      sub: t.q_trace_dense_sub,
      cls: trace.dense ? "on" : "",
    },
    {
      key: "rrf",
      label: t.q_trace_rrf,
      value: nf(trace.fused),
      sub: t.q_trace_rrf_sub,
      cls: trace.fused ? "on" : "",
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
      value: `−${nf(trace.rejected)}`,
      sub: t.q_trace_floor_sub.replace("{floor}", floor),
      cls: trace.rejected ? "drop" : "",
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
          {steps.map((s, i) => (
            <Fragment key={s.key}>
              {i > 0 ? (
                <span className="ask-arr" aria-hidden="true">
                  <Icon name="arrowR" size={12} />
                </span>
              ) : null}
              <span className={`ask-step ${s.cls}`}>
                <span className="sk">{s.label}</span>
                <span className="sn">{s.value}</span>
              </span>
            </Fragment>
          ))}
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
        <div className="ask-tracefoot">{t.q_trace_params.replace("{floor}", floor)}</div>
      </div>
    </div>
  );
}
