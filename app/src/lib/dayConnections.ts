// "Today's connections" on Home (UX S40): the [[link]] pairs and citations
// that appeared today, counted from the link graph without a model. The graph
// only knows the present, so yesterday's links are remembered here, one
// snapshot per vault, and today's new pairs are the difference.

import type { Adjacency } from "./ipc";

/** Link pairs as sorted, vault-relative "a\tb" keys, plus each note's
 *  frontmatter `source_count` (only notes that have any). */
export interface LinkSnapshot {
  pairs: string[];
  cites: Record<string, number>;
}

/** What is stored per vault: the links at the start of `day`, and the latest
 *  seen, which becomes the next day's start. */
export interface DayLinks {
  day: string;
  base: LinkSnapshot;
  last: LinkSnapshot;
}

const rel = (abs: string, root: string): string =>
  abs.startsWith(`${root}/`) ? abs.slice(root.length + 1) : abs;

const pairKey = (a: string, b: string): string => (a < b ? `${a}\t${b}` : `${b}\t${a}`);

export function snapshot(adj: Adjacency, root: string): LinkSnapshot {
  const pairs = new Set<string>();
  for (const [src, targets] of Object.entries(adj.forward)) {
    for (const dst of targets) if (dst !== src) pairs.add(pairKey(rel(src, root), rel(dst, root)));
  }
  const cites: Record<string, number> = {};
  for (const [p, m] of Object.entries(adj.meta ?? {})) {
    if (m.sourceCount) cites[rel(p, root)] = m.sourceCount;
  }
  return { pairs: [...pairs].sort(), cites };
}

/** Move the stored state to `day`. The first sight ever is its own baseline,
 *  so nothing reads as new until links actually change. */
export function rollDay(prev: DayLinks | null, now: LinkSnapshot, day: string): DayLinks {
  if (!prev) return { day, base: now, last: now };
  if (prev.day !== day) return { day, base: prev.last, last: now };
  return { day, base: prev.base, last: now };
}

/** Pairs (sorted, vault-relative) and citations added since `base`, counted
 *  only in files saved today (`savedToday`, vault-relative). */
export function newToday(
  base: LinkSnapshot,
  adj: Adjacency,
  root: string,
  savedToday: Set<string>,
): { pairs: [string, string][]; cites: number } {
  const old = new Set(base.pairs);
  const found = new Set<string>();
  for (const [src, targets] of Object.entries(adj.forward)) {
    const s = rel(src, root);
    if (!savedToday.has(s)) continue;
    for (const dst of targets) {
      const key = pairKey(s, rel(dst, root));
      if (dst !== src && !old.has(key)) found.add(key);
    }
  }
  let cites = 0;
  for (const [p, m] of Object.entries(adj.meta ?? {})) {
    const r = rel(p, root);
    if (savedToday.has(r)) cites += Math.max(0, (m.sourceCount ?? 0) - (base.cites[r] ?? 0));
  }
  const pairs = [...found].sort().map((k) => k.split("\t") as [string, string]);
  return { pairs, cites };
}

const KEY = "myco.dayLinks:";

export function loadDayLinks(vault: string): DayLinks | null {
  try {
    const raw = localStorage.getItem(KEY + vault);
    return raw ? (JSON.parse(raw) as DayLinks) : null;
  } catch {
    return null; // unavailable or corrupt: start a fresh baseline
  }
}

export function saveDayLinks(vault: string, state: DayLinks): void {
  try {
    localStorage.setItem(KEY + vault, JSON.stringify(state));
  } catch {
    /* localStorage unavailable: today's line resets on the next load */
  }
}
