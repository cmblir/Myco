// Backlinks panel. Reads adjacency.backward[currentFile] and lists the
// referring notes. Mounted by PageReader below the editor/viewer.

import type { JSX } from "react";
import { Icon } from "../lib/icons";
import { useUIStore } from "../stores/uiStore";
import { useVaultStore } from "../stores/vaultStore";

export default function BacklinksPanel({
  filePath,
}: {
  filePath: string;
}): JSX.Element | null {
  const adjacency = useVaultStore((s) => s.adjacency);
  const setRoute = useUIStore((s) => s.setRoute);

  if (!adjacency) return null;
  const inbound = dedupe(adjacency.backward[filePath] ?? []);
  if (inbound.length === 0) {
    return (
      <section className="card-flat" style={{ marginTop: 32 }}>
        <div
          className="section-title"
          style={{ fontSize: 13.5, marginBottom: 6 }}
        >
          Backlinks
        </div>
        <div className="muted" style={{ fontSize: 13 }}>
          No notes link here yet.
        </div>
      </section>
    );
  }
  return (
    <section className="card-flat" style={{ marginTop: 32 }}>
      <div
        className="section-title"
        style={{ fontSize: 13.5, marginBottom: 6 }}
      >
        Backlinks ({inbound.length})
      </div>
      <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
        {inbound.map((p) => (
          <li key={p}>
            <button
              type="button"
              onClick={() => setRoute(`page:${p}`)}
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
              <Icon name="page" size={13} />
              <span style={{ flex: 1 }}>{fileName(p)}</span>
              <span
                className="muted"
                style={{
                  fontSize: 11,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                  maxWidth: 280,
                }}
                title={p}
              >
                {p}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

function dedupe(items: string[]): string[] {
  return Array.from(new Set(items));
}

function fileName(path: string): string {
  const last = path.split(/[\\/]/).pop() ?? path;
  return last.replace(/\.md$/i, "");
}
