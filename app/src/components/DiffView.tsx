// Thin renderer for wordDiff's DiffLine[] — the mockup M3-c markup (W3–6
// item 6). Shared by the run drill-in on PageHistory and the agent
// write-confirm dialog. All styling lives in styles.css (.diff recipe).

import type { JSX } from "react";
import type { DiffLine } from "../lib/wordDiff";

export default function DiffView({ lines }: { lines: DiffLine[] }): JSX.Element {
  return (
    <div className="diff">
      {lines.map((l, i) =>
        l.kind === "ctx" ? (
          <div key={i} className="dl">
            <span className="ln" aria-hidden="true" />
            {l.text}
          </div>
        ) : (
          <div key={i} className={`dl ${l.kind}`}>
            <span className="ln" aria-hidden="true">
              {l.kind === "add" ? "+" : "−"}
            </span>
            {l.segs.map((s, j) =>
              s.kind === "same" ? (
                s.text
              ) : (
                <span key={j} className={s.kind === "add" ? "wadd" : "wdel"}>
                  {s.text}
                </span>
              ),
            )}
          </div>
        ),
      )}
    </div>
  );
}
