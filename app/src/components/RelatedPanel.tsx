// Related-notes panel (Feature 1 — semantic layer). Lists pages the embedding
// index finds semantically nearest to the current file. Mounted by PageReader
// next to Backlinks.
//
// It used to render nothing when the index was missing, which is the same thing
// it renders when a page genuinely has no neighbours — so a user without an
// index saw a permanently absent feature and no reason why. Those are different
// facts and this now says which one it is.

import { useEffect, useState } from "react";
import type { JSX } from "react";
import { Icon } from "../lib/icons";
import type { Strings } from "../lib/i18n";
import type { VecHit } from "../lib/ipc";
import { ipc } from "../lib/ipc";
import { useUIStore } from "../stores/uiStore";
import { useVaultStore } from "../stores/vaultStore";
import { useReindexStore } from "../stores/reindexStore";

export default function RelatedPanel({
  filePath,
  t,
}: {
  filePath: string;
  t: Strings;
}): JSX.Element | null {
  const setRoute = useUIStore((s) => s.setRoute);
  const currentVault = useVaultStore((s) => s.currentVault);
  const [hits, setHits] = useState<VecHit[] | null>(null);
  const indexedPages = useReindexStore((s) => s.indexedPages);
  const refreshStatus = useReindexStore((s) => s.refreshStatus);

  useEffect(() => {
    if (indexedPages === null) void refreshStatus();
  }, [indexedPages, refreshStatus]);

  // Vault-relative path, matching how the index keys pages (e.g. "wiki/foo.md").
  const root = currentVault?.path ?? "";
  const rel =
    root && filePath.startsWith(root)
      ? filePath.slice(root.length).replace(/^[\\/]/, "").replace(/\\/g, "/")
      : filePath.replace(/\\/g, "/");

  useEffect(() => {
    let alive = true;
    ipc
      .relatedPages(rel, 8)
      .then((r) => {
        if (alive) setHits(r);
      })
      .catch(() => {
        if (alive) setHits([]);
      });
    return () => {
      alive = false;
    };
  }, [rel]);

  // No index: say so once, with the way to fix it. Not a nag — it is the only
  // place this feature's absence is visible at all.
  if (indexedPages === 0) {
    return (
      <section className="card-flat" style={{ marginTop: 24 }} data-testid="related-no-index">
        <div className="section-title" style={{ fontSize: 13.5, marginBottom: 6 }}>
          {t.rd_related ?? "Related"}
        </div>
        <p className="muted" style={{ fontSize: 12.5, margin: "0 0 8px" }}>
          {t.rd_related_no_index ??
            "Related notes come from an on-device index that hasn't been built yet."}
        </p>
        <button className="btn" onClick={() => setRoute("settings")}>
          {t.rd_related_no_index_cta ?? "Set up semantic search"}
        </button>
      </section>
    );
  }

  // An index exists and this page simply has no neighbours — nothing to say.
  if (!hits || hits.length === 0) return null;

  return (
    <section className="card-flat" style={{ marginTop: 24 }}>
      <div className="section-title" style={{ fontSize: 13.5, marginBottom: 6 }}>
        {t.rd_related ?? "Related"} ({hits.length})
      </div>
      <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
        {hits.map((h) => (
          <li key={h.page}>
            <button
              type="button"
              onClick={() => setRoute(`page:${h.page}`)}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                width: "100%",
                background: "transparent",
                border: 0,
                padding: "6px 0",
                color: "var(--ink)",
                textAlign: "left",
                cursor: "pointer",
              }}
            >
              <Icon name="sparkles" size={13} />
              <span style={{ flex: 1 }}>{h.stem}</span>
              <span className="muted" style={{ fontSize: 11 }}>
                {(h.score * 100).toFixed(0)}%
              </span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
