// Where a query block's pages come from (lib/blocks/query.ts): the vault
// store's index (the link scan's tags and frontmatter, the file tree), the
// files' mtimes when the block sorts or shows by date, and the vault's text
// scan for a "phrase". Live's widget (Editor) and Preview (Viewer →
// hydrateBlocks, which imports this on first use: runView's graph library
// would otherwise load with every view that renders markdown) both read
// through here, so the two views list one set.

import type { QueryModel, QueryRow } from "./blocks/query";
import { listedName } from "./displayName";
import { flattenMarkdown } from "./graphData";
import { ipc, type Adjacency } from "./ipc";
import { runView } from "./queryViews";
import { hitPassesFilters } from "./searchQuery";
import { useVaultStore } from "../stores/vaultStore";

/** What a query runs over (runQuery reads it from the vault store). */
export interface QueryIndex {
  adj: Adjacency;
  /** Absolute markdown paths: the whole vault, as ⌘K searches it. */
  files: readonly string[];
  vaultRoot: string;
  /** The page the block is on: never a row. */
  current?: string;
  mtimes?: Map<string, number>;
  /** The files holding each of the query's phrases, in order. */
  phraseHits?: readonly ReadonlySet<string>[];
}

/** Pure: every page the query matches, sorted (the view applies `limit`):
 *  ⌘K's operator filter, the phrases' files, the free words in the name. */
export function queryRows(q: QueryModel, index: QueryIndex): QueryRow[] {
  const { adj } = index;
  const files = index.files.filter(
    (p) =>
      p !== index.current &&
      hitPassesFilters(p, index.vaultRoot, q.search, adj.tags, adj.meta) &&
      (index.phraseHits ?? []).every((hits) => hits.has(p)),
  );
  return runView(
    adj,
    files,
    { text: q.search.terms },
    q.sort,
    q.desc,
    index.mtimes,
  ).map((r) => ({
    ...r,
    label: listedName(r.name, adj.meta?.[r.path]?.title),
  }));
}

// ponytail: a phrase is looked for in the first 1000 files that hold it
// (search_vault's one hit per file, in path order); page it if vaults outgrow it.
const PHRASE_FILES = 1000;

/** The query's pages, `current` (the page it is on) left out. */
export async function runQuery(
  q: QueryModel,
  current?: string,
): Promise<QueryRow[]> {
  const { adjacency, fileTree, currentVault } = useVaultStore.getState();
  if (!adjacency || !currentVault) throw new Error("no vault is open");
  const dated = q.sort === "modified" || q.view === "table";
  const [mtimes, phraseHits] = await Promise.all([
    // Without dates, rows read 0 and the modified sort falls back to names.
    dated
      ? ipc.fileMtimes(currentVault.path).then(
          (pairs) => new Map(pairs),
          () => undefined,
        )
      : undefined,
    Promise.all(
      q.search.phrases.map((p) =>
        ipc
          .searchVault(p, PHRASE_FILES)
          .then((hits) => new Set(hits.map((h) => h.path))),
      ),
    ),
  ]);
  return queryRows(q, {
    adj: adjacency,
    files: flattenMarkdown(fileTree),
    vaultRoot: currentVault.path,
    current,
    mtimes,
    phraseHits,
  });
}

/** runQuery for one open note (`current`): a query it already ran is
 *  answered from that run while the vault's index and tree are the same
 *  objects, so a Live widget scrolled back into view redraws without
 *  scanning the vault again; a failed run is tried again. */
// ponytail: a text-only edit elsewhere (a phrase, a date) leaves the index
// as it was, so it shows on the note's next open; key on the vault's
// revision if that proves too stale.
export function queryRunner(
  current?: string,
): (q: QueryModel) => Promise<QueryRow[]> {
  let runs = new Map<string, Promise<QueryRow[]>>();
  let index: unknown[] = [];
  return (q) => {
    const { adjacency, fileTree } = useVaultStore.getState();
    if (index[0] !== adjacency || index[1] !== fileTree) {
      runs = new Map();
      index = [adjacency, fileTree];
    }
    const cached = runs.get(q.query);
    if (cached) return cached;
    const run = runQuery(q, current);
    const mine = runs;
    mine.set(q.query, run);
    run.catch(() => {
      if (mine.get(q.query) === run) mine.delete(q.query);
    });
    return run;
  };
}
