// The ingest run's live mini galaxy: touched pages orbit the hub (written
// pages bright gold, read-only ice), real wikilinks between touched pages
// (from ingestStore.liveAdjacency rescans) draw as solid edges. Physics,
// drag, hover and click-selection live in the shared MiniGalaxy; clicking a
// star opens the page's content in-place below the graph (NodePreview) —
// navigating to the reader mid-run would hide the live progress.

import { useMemo, useState } from "react";
import type { JSX } from "react";
import type { Strings } from "../lib/i18n";
import { useIngestStore } from "../stores/ingestStore";
import { useUIStore } from "../stores/uiStore";
import MiniGalaxy from "./MiniGalaxy";
import type { GalaxyLink, GalaxyNode } from "./MiniGalaxy";
import NodePreview from "./NodePreview";

export default function IngestMiniGraph({
  t,
}: {
  t: Strings;
}): JSX.Element | null {
  const touched = useIngestStore((s) => s.touched);
  const liveAdjacency = useIngestStore((s) => s.liveAdjacency);
  const vaultPath = useIngestStore((s) => s.vaultPath);
  const writeCount = useIngestStore((s) => s.writeCount);
  const setRoute = useUIStore((s) => s.setRoute);
  const [selected, setSelected] = useState<string | null>(null);

  const nodes = useMemo<GalaxyNode[]>(
    () =>
      touched.map((f) => ({
        id: f.path,
        label: f.path.split("/").pop() ?? f.path,
        bright: f.write,
      })),
    [touched],
  );

  // Real wikilinks among touched pages, from the latest mid-run rescan.
  const links = useMemo<GalaxyLink[]>(() => {
    if (!liveAdjacency || !vaultPath) return [];
    const ids = new Set(touched.map((f) => f.path));
    const rel = (p: string): string =>
      p.startsWith(vaultPath) ? p.slice(vaultPath.length).replace(/^\//, "") : p;
    const out: GalaxyLink[] = [];
    for (const [srcAbs, targets] of Object.entries(liveAdjacency.forward)) {
      const src = rel(srcAbs);
      if (!ids.has(src)) continue;
      for (const tgtAbs of targets) {
        const tgt = rel(tgtAbs);
        if (ids.has(tgt)) out.push({ a: src, b: tgt });
      }
    }
    return out;
  }, [liveAdjacency, vaultPath, touched]);

  if (nodes.length === 0) return null;

  return (
    <div className="card ingest-constellation-card">
      <div className="section-title" style={{ fontSize: 13.5, marginBottom: 4 }}>
        {t.ing_live_files} · {nodes.length}
      </div>
      <MiniGalaxy
        nodes={nodes}
        links={links}
        selected={selected}
        onSelect={setSelected}
        ariaLabel={t.ing_live_files}
      />
      {selected && vaultPath ? (
        <NodePreview
          t={t}
          absPath={`${vaultPath}/${selected}`}
          label={selected}
          refreshKey={writeCount}
          onOpen={() => setRoute(`page:${vaultPath}/${selected}`)}
          onClose={() => setSelected(null)}
        />
      ) : null}
    </div>
  );
}
