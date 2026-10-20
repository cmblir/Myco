// Explicit creation requests survive routing and the asynchronous file read.
// Only the matching editor may consume one; ordinary navigation has no request.
let pendingPath: string | null = null;
const listeners = new Set<(path: string) => void>();

/** Ask the next editor for this note to focus its existing document end. */
export function requestNoteWriting(path: string): void {
  pendingPath = path;
  for (const listener of listeners) listener(path);
}

/** Consume once, including when several editor panes are mounted. */
export function takeNoteWritingRequest(path: string): boolean {
  if (pendingPath !== path) return false;
  pendingPath = null;
  return true;
}

/** Notify an already-mounted editor when creation resolves to the same note. */
export function subscribeNoteWriting(listener: (path: string) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
