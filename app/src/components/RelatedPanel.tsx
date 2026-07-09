// Related-notes panel (Feature 1 — semantic layer). Lists pages the embedding
// index finds semantically nearest to the current file. Mounted by PageReader
// next to Backlinks. Empty/quiet when the index is not built.

import { useEffect, useState } from "react";
import type { JSX } from "react";
import { Icon } from "../lib/icons";
import type { Strings } from "../lib/i18n";
import type { VecHit } from "../lib/ipc";
import { ipc } from "../lib/ipc";
import { useUIStore } from "../stores/uiStore";
import { useVaultStore } from "../stores/vaultStore";

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

  // Hide entirely until the index yields something — no empty clutter.
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
