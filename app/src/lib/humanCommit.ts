// Trailing per-file debounce for human-edit git commits (Q4 item 1).
// A typing burst on one page becomes one commit, not one per keystroke-save.

export interface DebouncedCommitter {
  touch(rel: string): void;
  flushAll(): void;
}

export function createDebouncedCommitter(
  commit: (rel: string) => void,
  windowMs = 4000,
): DebouncedCommitter {
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  return {
    touch(rel) {
      const prev = timers.get(rel);
      if (prev) clearTimeout(prev);
      timers.set(
        rel,
        setTimeout(() => {
          timers.delete(rel);
          commit(rel);
        }, windowMs),
      );
    },
    flushAll() {
      for (const [rel, timer] of timers) {
        clearTimeout(timer);
        commit(rel);
      }
      timers.clear();
    },
  };
}
