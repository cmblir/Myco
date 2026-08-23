// Authorship UI helpers (Q4 item 16) — pure. The reader badge percentages and
// the sidebar's "human-only (on record)" tree filter.
import type { Lang } from "./i18n";
import type { AuthorshipIndex, FileNode, PageAuthorship } from "./ipc";

const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ["day", 86400],
  ["hour", 3600],
  ["minute", 60],
];

export interface AuthBadgeView {
  humanPct: number;
  agentPct: number;
  lastHumanRel: string | null;
}

/** Rounded split that always sums to 100 — human absorbs the remainder. */
export function badgeView(
  a: PageAuthorship,
  now: number,
  lang: Lang,
): AuthBadgeView {
  const total = a.agent_lines + a.human_lines;
  const agentPct = total === 0 ? 0 : Math.round((a.agent_lines / total) * 100);
  let lastHumanRel: string | null = null;
  if (a.last_human_at !== null) {
    const delta = now - a.last_human_at;
    const [unit, secs] = UNITS.find(([, s]) => delta >= s) ?? ["minute", 60];
    lastHumanRel = new Intl.RelativeTimeFormat(lang, {
      numeric: "auto",
    }).format(-Math.max(1, Math.round(delta / secs)), unit);
  }
  return { humanPct: 100 - agentPct, agentPct, lastHumanRel };
}

/** Keeps files never committed by the agent author. Untracked files are kept
 *  too (`touched` simply has no row — untracked means unknown, not agent).
 *  Directories survive only while they still hold a kept child. */
export function filterHumanTree(
  tree: FileNode[],
  touched: AuthorshipIndex,
  vaultRoot: string,
): FileNode[] {
  const out: FileNode[] = [];
  for (const node of tree) {
    if (node.kind === "file") {
      const rel = node.path.startsWith(vaultRoot + "/")
        ? node.path.slice(vaultRoot.length + 1)
        : node.path;
      if (touched[rel] !== true) out.push(node);
    } else {
      const children = filterHumanTree(node.children, touched, vaultRoot);
      if (children.length > 0) out.push({ ...node, children });
    }
  }
  return out;
}
