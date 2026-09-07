// Sources & trust — this note's citation coverage, in the note (mockup
// "Manuscript"). The vault-wide `scan_provenance` result is already cached in
// provenanceStore, so this consumes it: no new IPC, one scan per vault per
// session. Distinct citations in the whole wiki: 9 — "no grounding" is the
// product's default state and it was visible nowhere inside a note.

import { useEffect } from "react";
import type { JSX } from "react";
import type { Strings } from "../lib/i18n";
import Rail from "./Rail";
import { sourcesView } from "../lib/readerRail";
import { useProvenanceStore } from "../stores/provenanceStore";
import { useUIStore } from "../stores/uiStore";
import { useVaultStore } from "../stores/vaultStore";

export default function SourcesPanel({
  filePath,
  t,
}: {
  filePath: string;
  t: Strings;
}): JSX.Element {
  const vaultPath = useVaultStore((s) => s.currentVault?.path);
  const rows = useProvenanceStore((s) => s.rows);
  const loading = useProvenanceStore((s) => s.loading);
  const scan = useProvenanceStore((s) => s.scan);
  const setRoute = useUIStore((s) => s.setRoute);
  const weights = useUIStore((s) => s.askTierWeights);

  // ponytail: the whole vault is scanned to answer one note's coverage. The
  // store caches per vault, so it is one scan a session; a per-page command
  // is the upgrade if opening the first note ever feels slow.
  useEffect(() => {
    if (vaultPath) void scan(vaultPath);
  }, [vaultPath, scan]);

  const view = sourcesView(rows, filePath, weights);
  return (
    <Rail
      title={t.rd_src_title ?? "Sources & trust"}
      count={view ? `${view.cited}/${view.total}` : undefined}
    >
      {!view ? (
        <p className="rail-empty">
          {loading
            ? (t.rd_src_scanning ?? "Reading the vault's citations…")
            : (t.rd_src_no_claims ?? "No claims to ground yet.")}
        </p>
      ) : (
        <>
          <div className="rail-cov">
            <b className="rail-cov__pct">{view.pct}%</b>
            <p className="rail-cov__txt">
              {(t.rd_src_coverage ?? "{cited} of {total} claims carry a citation")
                .replace("{cited}", String(view.cited))
                .replace("{total}", String(view.total))}
            </p>
          </div>
          <div
            className="rail-cov__bar"
            role="img"
            aria-label={(t.rd_src_bar ?? "Citation coverage {pct} percent").replace(
              "{pct}",
              String(view.pct),
            )}
          >
            <i style={{ width: `${view.pct}%` }} />
          </div>
          {view.sources.length === 0 && view.cited === 0 ? (
            <p className="rail-empty">
              {t.rd_src_none ??
                "Nothing backs this note. The system will not invent a source."}
            </p>
          ) : view.sources.length === 0 ? null : (
            <ul className="rail-list">
              {view.sources.map((s, i) => (
                <li key={s.ref.slug} className={s.weight === null ? "is-broken" : undefined}>
                  <span className="rail-badge" aria-hidden="true">
                    {i + 1}
                  </span>
                  <span className="rail-src__body">
                    <span className="rail-src__title" title={s.ref.slug}>
                      {s.ref.title ?? s.ref.slug}
                    </span>
                    <span className="rail-src__meta">
                      {s.weight === null ? (
                        t.rd_src_broken ?? "no raw/ file — broken citation"
                      ) : (
                        <>
                          {s.ref.kind || (t.rd_src_hand ?? "hand-written")}
                          {s.ref.created ? ` · ${s.ref.created}` : ""}
                          {" · "}
                          <span
                            className="rail-w"
                            title={t.rd_src_weight ?? "Trust weight Ask applies to this layer"}
                          >
                            <i style={{ width: `${Math.round(s.weight * 100)}%` }} />
                          </span>{" "}
                          {s.weight.toFixed(2)}
                        </>
                      )}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          )}
          {view.uncited > 0 ? (
            <p className="rail-empty">
              {(t.rd_src_uncited ?? "{n} claims with no source").replace(
                "{n}",
                String(view.uncited),
              )}
            </p>
          ) : null}
          <button type="button" className="rail-link" onClick={() => setRoute("provenance")}>
            {t.rd_src_all ?? "Full coverage"} →
          </button>
        </>
      )}
    </Rail>
  );
}
