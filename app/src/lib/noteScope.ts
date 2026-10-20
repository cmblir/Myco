// "Ask this note" (UX S37): which pages an Ask over one note may quote — the
// note and its one-hop link neighbours, both directions, as semantic_search's
// `paths` filter takes them (vault-relative).

import type { Adjacency } from "./ipc";

/** The note an Ask is scoped to: its absolute path, and the name the reader
 *  shows for it (the composer's chip). */
export interface NoteScope {
  path: string;
  title: string;
}

/** `abs` and the notes it links to or is linked from, vault-relative, once
 *  each, the note first. Without a graph yet, the note alone. */
export function noteScopePaths(abs: string, vaultRoot: string, adjacency: Adjacency | null): string[] {
  const prefix = `${vaultRoot}/`;
  const all = [abs, ...(adjacency?.forward[abs] ?? []), ...(adjacency?.backward[abs] ?? [])];
  return [...new Set(all.filter((p) => p.startsWith(prefix)).map((p) => p.slice(prefix.length)))];
}
