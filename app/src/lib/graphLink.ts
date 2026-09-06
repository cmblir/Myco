// The Survey's front doors. The old graph had two ways in (sidebar, ⌘K) and
// no way to arrive AT anything — every entry landed on the whole cosmos. This
// is the one call another screen makes to arrive at a question, optionally
// with a note already selected: Ask's abstention card ("that topic is empty in
// your vault" → orphans), Today's gaps widget, the reader's backlinks.

import type { Question } from "./graphEncoding";
import { useUIStore } from "../stores/uiStore";

/** The deep link a surface can render or hand to setRoute — `graph?q=…&n=…`. */
export function graphHref(question: Question, path?: string): string {
  const q = new URLSearchParams({ q: question });
  if (path) q.set("n", path);
  return `graph?${q.toString()}`;
}

/** Go to the Survey, on `question`, with `path` selected when given. */
export function openGraph(question: Question, path?: string): void {
  const ui = useUIStore.getState();
  ui.setGraphFocus({ q: question, path: path ?? null });
  ui.setRoute("graph");
}
