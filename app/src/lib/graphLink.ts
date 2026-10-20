// The Survey's front doors. The old graph had two ways in (sidebar, ⌘K) and
// no way to arrive AT anything — every entry landed on the whole cosmos. This
// is the one call another screen makes to arrive at a question, optionally
// with a note already selected: Ask's abstention card ("that topic is empty in
// your vault" → orphans), Today's gaps widget, the reader's backlinks.

import type { Question } from "./graphEncoding";
import type { GraphSettings } from "./graphSettings";
import { useUIStore } from "../stores/uiStore";

/** The deep link a surface can render or hand to setRoute — `graph?q=…&n=…`. */
export function graphHref(question: Question, path?: string): string {
  const q = new URLSearchParams({ q: question });
  if (path) q.set("n", path);
  return `graph?${q.toString()}`;
}

/**
 * The note a fresh scene lands on again, or null. The file mtimes arrive just
 * after mount and rebuild the scene, which resets the selection: the note the
 * deep link landed on survives that one rebuild if it is still selected. Any
 * other rebuild (a filter, a look, Reset) clears it like any selection, so it
 * cannot close the drawer the user is working in or fly the camera back.
 */
export function relandAfterRebuild(o: {
  selected: string | null;
  /** The note the deep link arrived at. */
  origin: string | null;
  /** A landing still waiting for a laid-out scene. */
  pending: string | null;
  /** This rebuild is the one the file mtimes caused. */
  mtimesArrived: boolean;
}): string | null {
  return o.mtimesArrived && !o.pending && o.selected !== null && o.selected === o.origin
    ? o.selected
    : null;
}

/** The neighbours question's "pick a note" banner. A deep link's note is
 * already on its way while the layout settles (2–6 s), so asking for one then
 * contradicts the click that opened the graph (UX S44). */
export function pickBannerShown(o: {
  question: Question;
  selected: string | null;
  arriving: boolean;
}): boolean {
  return o.question === "neighbors" && !o.selected && !o.arriving;
}

/** The question a deep link opened on, and the user's own it stands in for. */
export interface ArrivalQuestion {
  shown: Question;
  before: Question;
}

/**
 * What the graph stores. The question a deep link opens on (the reader's
 * "그래프에서 보기" asks 이 노트의 이웃) is a view of that visit, not the user's
 * choice: while it still shows, the user's own question is saved in its place,
 * so the next ordinary visit does not open on a question that draws nothing
 * without a note. Once the question changes the arrival is over.
 */
export function settingsToSave(
  settings: GraphSettings,
  arrival: ArrivalQuestion | null,
): { save: GraphSettings; arrival: ArrivalQuestion | null } {
  if (!arrival || settings.question !== arrival.shown) return { save: settings, arrival: null };
  return { save: { ...settings, question: arrival.before }, arrival };
}

/** Go to the Survey, on `question`, with `path` selected when given. */
export function openGraph(question: Question, path?: string): void {
  const ui = useUIStore.getState();
  ui.setGraphFocus({ q: question, path: path ?? null });
  ui.setRoute("graph");
}
