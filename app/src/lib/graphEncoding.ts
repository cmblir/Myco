// Question → encoding. The Survey graph has ONE layout; picking a question
// changes only how each node is drawn (colour / radius / alpha / ring), never
// where it sits — so answers to different questions stay comparable on the
// same coordinates. Pure and DOM-free: the canvas renderer calls encodeNode per
// node per style pass, the tests call it directly.
//
//   orphans   — what is empty: ghosts, degree-0 notes and notes nobody links to
//               stay lit and ringed; everything already connected recedes.
//   clusters  — what clumps together: cluster colour as-is, members of a
//               cluster with no map page get a dashed amber ring.
//   time      — what grew recently: a single freshness ramp (dim → live),
//               notes older than 90 days recede, ≤30 days get a solid ring.
//   neighbors — this note's 2-hop neighbourhood: hop 0/1 lit, hop 2 dimmed,
//               everything else almost invisible.
//
// Search is a style filter layered on top (hits ring 6, misses fade) — it must
// never rebuild the scene. Selection always wins the ring channel (5).

import { mixHex } from "./graphData";

export type Question = "orphans" | "clusters" | "time" | "neighbors";
export type SizeBy = "backlinks" | "cites";

export const QUESTIONS: readonly Question[] = ["orphans", "clusters", "time", "neighbors"];
export const SIZE_BYS: readonly SizeBy[] = ["backlinks", "cites"];

/** Ring = the shape channel, so no fact is carried by colour alone. */
export type Ring = 0 | 1 | 2 | 3 | 4 | 5 | 6;
export const RING_NONE: Ring = 0;
export const RING_GAP: Ring = 1; // orphan / no backlink — dashed amber
export const RING_UNRESOLVED: Ring = 2; // ghost — dotted dim
export const RING_MAPLESS: Ring = 3; // member of a cluster without a map page
export const RING_FRESH: Ring = 4; // modified within 30 days — solid live
export const RING_SELECTED: Ring = 5;
export const RING_SEARCH_HIT: Ring = 6;

export interface EncNode {
  id: string;
  /** Note name (stem) — what the search box matches against. */
  label: string;
  /** Unresolved [[wikilink]] with no file behind it. */
  ghost: boolean;
  /** Degree within the drawn corpus. */
  deg: number;
  /** Inbound wikilinks within the drawn corpus. */
  backlinks: number;
  /** Frontmatter source_count (citations). */
  cites: number;
  /** Days since the file was modified; 9999 = unknown. */
  ageDays: number;
  /** Cluster hue from graphData (#rrggbb). */
  color: string;
  /** Louvain / folder cluster id; -1 = none. */
  community: number;
}

export interface EncState {
  sizeBy: SizeBy;
  /** Max backlink count over the corpus (≥1) — normalises the size ramp. */
  maxBacklinks: number;
  /** neighbors: id → hop distance from the selected note (0..2). null = no
   * selection yet — nothing is dimmed, the question just has no subject. */
  hops: Map<string, number> | null;
  /** clusters: community ids that have no map (overview) page. */
  mapless: ReadonlySet<number>;
  /** Lower-cased search needle; "" = off. Styling only. */
  search: string;
  selected: string | null;
  /** --ink-4 and --live, resolved by the caller (#rrggbb). */
  dimColor: string;
  liveColor: string;
}

export interface Encoding {
  color: string;
  radius: number;
  alpha: number;
  ring: Ring;
}

const FRESH_DAYS = 30;
const STALE_DAYS = 90;
const RAMP_DAYS = 365;

export function nodeRadius(n: EncNode, s: EncState): number {
  if (n.ghost) return 3.5;
  if (s.sizeBy === "cites") return 3 + Math.min(n.cites, 8) * 3.4;
  return 3 + Math.sqrt(n.backlinks / Math.max(1, s.maxBacklinks)) * 10;
}

export function isGapNode(n: EncNode): boolean {
  return n.ghost || n.deg === 0 || n.backlinks === 0;
}

export function encodeNode(n: EncNode, q: Question, s: EncState): Encoding {
  let color = n.color;
  let alpha = 1;
  let ring: Ring = RING_NONE;
  const radius = nodeRadius(n, s);

  if (q === "orphans") {
    if (isGapNode(n)) {
      ring = n.ghost ? RING_UNRESOLVED : RING_GAP;
    } else {
      alpha = 0.22;
      color = mixHex(color, s.dimColor, 0.55);
    }
  } else if (q === "clusters") {
    if (n.ghost) alpha = 0.3;
    else if (s.mapless.has(n.community)) ring = RING_MAPLESS;
  } else if (q === "time") {
    const fresh = 1 - Math.min(n.ageDays, RAMP_DAYS) / RAMP_DAYS;
    color = mixHex(s.dimColor, s.liveColor, Math.pow(fresh, 0.7));
    alpha = n.ageDays <= FRESH_DAYS ? 1 : n.ageDays <= STALE_DAYS ? 0.62 : 0.24;
    if (n.ageDays <= FRESH_DAYS) ring = RING_FRESH;
  } else if (s.hops) {
    const h = s.hops.get(n.id);
    if (h === undefined) {
      alpha = 0.09;
      color = mixHex(color, s.dimColor, 0.75);
    } else if (h === 0) {
      ring = RING_SELECTED;
    } else if (h >= 2) {
      alpha = 0.42;
      color = mixHex(color, s.dimColor, 0.35);
    }
  }

  if (s.search) {
    const hit = n.label.toLowerCase().includes(s.search);
    if (hit) {
      alpha = 1;
      if (ring === RING_NONE) ring = RING_SEARCH_HIT;
    } else {
      alpha = Math.min(alpha, 0.08);
    }
  }
  if (s.selected === n.id) ring = RING_SELECTED;

  return { color, radius, alpha, ring };
}

/** BFS hop distances (0..max) from `start` over `neighborsOf`. */
export function hopsFrom(
  start: string,
  max: number,
  neighborsOf: (id: string) => Iterable<string>,
): Map<string, number> {
  const d = new Map<string, number>([[start, 0]]);
  let frontier = [start];
  for (let h = 1; h <= max && frontier.length > 0; h++) {
    const next: string[] = [];
    for (const cur of frontier) {
      for (const m of neighborsOf(cur)) {
        if (d.has(m)) continue;
        d.set(m, h);
        next.push(m);
      }
    }
    frontier = next;
  }
  return d;
}
