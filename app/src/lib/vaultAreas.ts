// My notes vs the folders myco keeps (UX backlog S15). Pure. Nothing moves on
// disk: the sidebar draws two areas, ⌘K orders and names its results, and a
// new note lands beside the open one — the vault stays Obsidian-shaped.

import type { AuthorshipIndex } from "./ipc";
import type { Strings } from "./i18n";

export type Area = "mine" | "managed";

type KindKey =
  | "area_raw"
  | "area_sessions"
  | "area_cards"
  | "area_ingest_reports"
  | "area_work"
  | "area_inbox"
  | "area_templates"
  | "area_audio"
  | "area_claude";

/** Top-level entries myco writes and keeps, each with the kind name ⌘K shows
 *  for a result there instead of its folder. A Map, so a folder the user named
 *  `constructor` is not mistaken for one of these. The same list as MANAGED_TOP
 *  in src-tauri/src/vault.rs (search order) — change the two together. */
const MANAGED = new Map<string, KindKey>([
  ["raw", "area_raw"],
  ["sessions", "area_sessions"],
  ["cards", "area_cards"],
  ["ingest-reports", "area_ingest_reports"],
  ["work", "area_work"],
  ["_inbox", "area_inbox"],
  ["templates", "area_templates"],
  ["audio", "area_audio"],
  ["CLAUDE.md", "area_claude"],
]);

/** A top-level folder or file name. `wiki/`, `daily/` and anything the user
 *  made are mine — `wiki/` holds both the user's notes and myco's pages, and
 *  only the authorship index tells those apart. */
export function classifyTopLevel(name: string): Area {
  return MANAGED.has(name) ? "managed" : "mine";
}

const topOf = (rel: string): string => rel.split("/")[0];

/** `path` relative to the vault `root`; unchanged outside it. */
export function vaultRel(path: string, root: string): string {
  return root && path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path;
}

/** What a managed vault-relative path is ("학습 카드"), null for one of mine. */
export function kindName(rel: string, t: Strings): string | null {
  const key = MANAGED.get(topOf(rel));
  return key ? t[key] : null;
}

/** ⌘K order: 0 human on record, 1 mine with no record, 2 written by myco,
 *  3 managed. `index` is authorship_index (wiki/ rel -> ever committed by the
 *  agent author). A rel with no row — no history, untracked — is unknown, so
 *  it ranks as mine: the app never claims it wrote what it may not have. */
export function areaRank(rel: string, index: AuthorshipIndex): number {
  if (MANAGED.has(topOf(rel))) return 3;
  if (index[rel] === true) return 2;
  return index[rel] === false ? 0 : 1;
}

/** `items` in ⌘K order. The sort is stable, so within a rank the incoming
 *  order (name order, a search's own order) holds. */
export function byArea<T>(
  items: readonly T[],
  relOf: (item: T) => string,
  index: AuthorshipIndex,
): T[] {
  return [...items].sort((a, b) => areaRank(relOf(a), index) - areaRank(relOf(b), index));
}

/** The folder a new note goes in: the open note's, unless that is one myco
 *  manages (raw/ among them) or the vault root — Ask does not index the root,
 *  and a root note has no folder crumb to move it by. Null means the default,
 *  wiki/ — also with no note open or a path outside the vault. */
export function newNoteDir(openPath: string | null, root: string): string | null {
  if (!openPath || !root || !openPath.startsWith(`${root}/`)) return null;
  const rel = vaultRel(openPath, root);
  if (!rel.includes("/") || MANAGED.has(topOf(rel))) return null;
  return openPath.slice(0, openPath.lastIndexOf("/"));
}
