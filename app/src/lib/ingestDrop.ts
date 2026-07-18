// The Ingest form composes ONE source. When several files are dropped it loads
// the first; this decides the notice that keeps the rest from vanishing in
// silence. Pure so it is testable without driving the native drag-drop event.

/** Message to show for a drop of `count` files, or null when one file (or none). */
export function dropNoticeFor(
  count: number,
  template: string | undefined,
): string | null {
  if (count <= 1) return null;
  return (template ?? "Loaded the first of {n} files.").replace(
    "{n}",
    String(count),
  );
}
