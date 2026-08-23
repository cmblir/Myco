// Contradiction queue v1 (Q4 item 15). Client-side mirror of the
// mcp_native::contradictions scan over the already-loaded Adjacency — the
// graph carries `meta.status` and `forward`, so no backend call is needed.
// Status flips are recorded in vault history via commitHumanEdit (undo rides
// history, not the run manifest — it cannot represent an in-place edit).

import type { Adjacency } from "./ipc";

export interface Contradiction {
  kind: "disputed" | "stale-link";
  /** Absolute path (the Adjacency key) — what readFile/writeFile and the
   *  `page:` route consume. */
  page: string;
  /** Vault-relative path — what commitHumanEdit wants. */
  rel: string;
  /** Vault-relative path of the superseded page (stale-link only). */
  target?: string;
}

// Mirrors mcp_native::LINT_SKIP_NAMES.
const SKIP_NAMES = new Set(["index.md", "log.md"]);

/** Mirrors mcp_native::contradictions: a wiki page whose frontmatter status is
 *  `disputed`, plus every active-or-unstated wiki page holding a forward link
 *  to a `superseded` wiki page. index.md/log.md and anything outside `wiki/`
 *  are skipped on both arms. */
export function findContradictions(adj: Adjacency, vaultRoot: string): Contradiction[] {
  const prefix = vaultRoot.endsWith("/") ? vaultRoot : `${vaultRoot}/`;
  const wikiPrefix = `${prefix}wiki/`;
  const meta = adj.meta ?? {};
  const scannable = (abs: string) =>
    abs.startsWith(wikiPrefix) && !SKIP_NAMES.has(abs.slice(abs.lastIndexOf("/") + 1));

  const found: Contradiction[] = [];
  for (const [abs, m] of Object.entries(meta)) {
    if (m.status === "disputed" && scannable(abs)) {
      found.push({ kind: "disputed", page: abs, rel: abs.slice(prefix.length) });
    }
  }
  for (const [abs, targets] of Object.entries(adj.forward)) {
    if (!scannable(abs)) continue;
    if ((meta[abs]?.status ?? "active") !== "active") continue;
    for (const tgt of targets) {
      if (!scannable(tgt) || meta[tgt]?.status !== "superseded") continue;
      found.push({
        kind: "stale-link",
        page: abs,
        rel: abs.slice(prefix.length),
        target: tgt.slice(prefix.length),
      });
    }
  }
  return found;
}

/** Frontmatter status flip that also INSERTS the key when absent and CREATES
 *  the frontmatter block when the file has none (`rewriteStatus` in
 *  distillStore only replaces). Scoped to the first `---` block, so a body
 *  `status:` line is never touched. */
export function setPageStatus(
  raw: string,
  status: "active" | "superseded" | "disputed",
): string {
  const line = `status: ${status}`;
  const m = /^---\n([\s\S]*?)\n---/.exec(raw);
  if (!m) return `---\n${line}\n---\n\n${raw}`;
  const fm = m[1];
  const next = /^status:/m.test(fm)
    ? fm.replace(/^status:\s*.*$/m, line)
    : `${fm}\n${line}`;
  return `---\n${next}${raw.slice("---\n".length + fm.length)}`;
}

// --- ignore persistence (linkSuggestions.ts idiom) ---------------------------

const KEY = "myco.contradictions.ignored.v1";
const MAX_IGNORED = 500; // bounded so localStorage can't grow unbounded

export function contradictionKey(c: Contradiction): string {
  return `${c.kind}:${c.rel}:${c.target ?? ""}`;
}

export function loadIgnored(): Set<string> {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw) as unknown;
    return new Set(Array.isArray(parsed) ? parsed.filter((x) => typeof x === "string") : []);
  } catch {
    return new Set();
  }
}

export function saveIgnored(set: ReadonlySet<string>): void {
  try {
    localStorage.setItem(KEY, JSON.stringify([...set].slice(-MAX_IGNORED)));
  } catch {
    /* localStorage unavailable */
  }
}
