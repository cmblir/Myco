import { displayName } from "./displayName";

export interface IngestPageChange {
  path: string;
  change: "created" | "updated" | "changed";
}

export interface IngestReviewResult {
  vaultToken: string;
  sourcePath: string;
  pages: IngestPageChange[];
}

/** Observed file snapshots, never the model's proposed ADD/UPDATE actions. */
export function ingestPageChanges(
  paths: readonly string[], root: string,
  before?: ReadonlyMap<string, number>, after?: readonly [string, number][],
): IngestPageChange[] {
  const observed = after ? new Map(after) : null;
  return [...new Set(paths)].map(path => {
    const absolute = `${root}/${path}`;
    const change: IngestPageChange["change"] = before && observed?.has(absolute)
      ? !before.has(absolute) ? "created"
        : observed.get(absolute) !== before.get(absolute) ? "updated" : "changed"
      : "changed";
    return { path, change };
  }).sort((a, b) => Number(/^wiki\/(index|log)\.md$/.test(a.path)) - Number(/^wiki\/(index|log)\.md$/.test(b.path)));
}

/** Prefer a current frontmatter title; keep the original path separately. */
export function ingestReviewTitle(path: string, title?: string): string {
  const stem = (path.split("/").pop() ?? path).replace(/\.md$/i, "");
  return displayName(stem, title);
}
