// Cluster auto-labels at rest — the calm-cosmic-web spec's "reverse semantic
// zoom": terrain names when zoomed out, street names when zoomed in. One CSS2D
// label per top community, positioned at its live centroid, visible only while
// the camera is farther than SHOW_RATIO of the framed distance; zooming in
// cross-fades them out as the per-node labels take over (CSS transition on
// .is-visible). Label text v1 = the community's top-degree note name — free and
// identical to the legend, so the two never disagree. (v2, LLM topic summaries,
// is a later phase; this name stays the fallback.)
//
// Same lifecycle contract as the other scene helpers (NebulaLayer, PulseLayer):
// construct → add `group` to the scene → update() on (throttled) ticks +
// setZoomRatio() per frame → rebuild() after live-ingest growth → dispose().
import * as THREE from "three";
import { CSS2DObject } from "three/examples/jsm/renderers/CSS2DRenderer.js";
import { stem, type VaultGraph } from "./graphData";

const MAX_LABELS = 6; // matches the legend's top-6 communities
const MIN_MEMBERS = 3;
// Camera distance / framed distance above which cluster labels show. Below it
// the per-node semantic-zoom labels are the detail layer.
const SHOW_RATIO = 0.6;

interface ClusterLabel {
  obj: CSS2DObject;
  el: HTMLDivElement;
  memberIds: string[];
}

export class ClusterLabels {
  readonly group = new THREE.Group();
  private graph: VaultGraph;
  private labels: ClusterLabel[] = [];
  private zoomedOut = true;

  constructor(graph: VaultGraph) {
    this.graph = graph;
    this.rebuild();
  }

  // Re-derive the top communities (size-ranked, like the legend) and their
  // label text/colour. Called on construction and after live-ingest growth.
  rebuild(): void {
    this.clear();
    const members = new Map<number, string[]>();
    const top = new Map<number, { id: string; deg: number }>();
    this.graph.forEachNode((id, a) => {
      if (a.community < 0) return;
      (members.get(a.community) ?? members.set(a.community, []).get(a.community)!).push(id);
      const cur = top.get(a.community);
      if (!cur || a.deg > cur.deg) top.set(a.community, { id, deg: a.deg });
    });
    const ranked = [...members.entries()]
      .filter(([, ids]) => ids.length >= MIN_MEMBERS)
      .sort((a, b) => b[1].length - a[1].length)
      .slice(0, MAX_LABELS);
    for (const [cm, ids] of ranked) {
      const topNode = top.get(cm);
      if (!topNode) continue;
      const el = document.createElement("div");
      el.className = "graph-cluster-label";
      el.textContent = stem(topNode.id);
      el.style.color = this.graph.getNodeAttribute(topNode.id, "color");
      const obj = new CSS2DObject(el);
      obj.visible = false;
      this.group.add(obj);
      this.labels.push({ obj, el, memberIds: ids });
    }
    this.update();
  }

  // Recompute each label's centroid from the live graph (galaxies drift while
  // the sim runs). O(labelled nodes); the caller throttles. Labels whose
  // community is mostly timelapse-hidden hide with it.
  update(): void {
    for (const l of this.labels) {
      let cx = 0;
      let cy = 0;
      let cz = 0;
      let visible = 0;
      for (const id of l.memberIds) {
        const a = this.graph.getNodeAttributes(id);
        if (a.hidden) continue;
        cx += a.x;
        cy += a.y;
        cz += a.z;
        visible++;
      }
      const alive = visible >= Math.min(MIN_MEMBERS, l.memberIds.length);
      if (alive) {
        l.obj.position.set(cx / visible, cy / visible, cz / visible);
      }
      // obj.visible (display:none) only for dead/hidden communities; the zoom
      // gate is a CLASS so the CSS opacity transition can actually play.
      l.obj.visible = alive;
      l.el.classList.toggle("is-visible", alive && this.zoomedOut);
    }
  }

  // Per-frame zoom gate — a no-op except on the show/hide transition, where
  // update() re-derives visibility from the new flag.
  setZoomRatio(camDistOverFramed: number): void {
    const out = camDistOverFramed > SHOW_RATIO;
    if (out === this.zoomedOut) return;
    this.zoomedOut = out;
    this.update();
  }

  private clear(): void {
    for (const l of this.labels) {
      l.el.remove();
      this.group.remove(l.obj);
    }
    this.labels = [];
  }

  dispose(): void {
    this.clear();
  }
}
