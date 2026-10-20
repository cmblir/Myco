/** Each tag of Adjacency.tags with how often it is used, most used first then
 *  alpha. */
export function tagCounts(
  tags: Record<string, string[]>,
  limit = Infinity,
): [string, number][] {
  const count = new Map<string, number>();
  for (const list of Object.values(tags)) {
    for (const t of list) count.set(t, (count.get(t) ?? 0) + 1);
  }
  return [...count.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit);
}

/** Unique tags of Adjacency.tags, frequency desc then alpha, case-insensitive
 *  substring filter on `query`. */
export function tagCandidates(
  tags: Record<string, string[]>,
  query = "",
  limit = 30,
): string[] {
  const q = query.toLowerCase();
  return tagCounts(tags)
    .filter(([t]) => t.toLowerCase().includes(q))
    .slice(0, limit)
    .map(([t]) => t);
}
