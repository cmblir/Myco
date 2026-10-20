// The graph's focus stack (spec B3 — "focus modes with an exit"): every
// isolation is a frame the user can pop back out of with Esc / a void-click /
// a breadcrumb. A node pick pushes a 1-hop frame (a double click widens it to
// 2 hops); a legend swatch pushes a community frame. Pure so the one rule every
// pick follows is testable in node.

import { stem } from "./graphData";
import { displayName } from "./displayName";
import type { Strings } from "./i18n";

export interface FocusFrame {
  kind: "node" | "community";
  /** breadcrumb text — note stem or community label */
  label: string;
  members: Set<string>;
  /** node frames: the focused node */
  id?: string;
  hops?: 1 | 2;
  /** community frames: the Louvain community id */
  cm?: number;
}

/** A frame's breadcrumb: the node's display name. A missing page's id is
 *  `ghost:<target>` (`ghost:<vault>:<target>` across vaults); its label is
 *  the target's name, never the raw id. */
export function frameLabel(id: string): string {
  const bare = id.startsWith("ghost:") ? id.slice(id.lastIndexOf(":") + 1) : id;
  return displayName(stem(bare));
}

/**
 * The stack after `id` is picked — from the canvas, the gaps list, the find
 * box or an inspector link alike, so the breadcrumb always names what the
 * inspector shows. The note already on top keeps its frame (`widen` turns a
 * 1-hop frame into 2 hops); any other note pushes a 1-hop frame, which Esc
 * pops back to where the pick came from. Returns `stack` itself when nothing
 * changes.
 */
export function pushNodeFrame(
  stack: FocusFrame[],
  id: string,
  members: (hops: 1 | 2) => Set<string>,
  widen = false,
): FocusFrame[] {
  const top = stack[stack.length - 1];
  if (top?.kind === "node" && top.id === id) {
    if (!widen || top.hops !== 1) return stack;
    return [...stack.slice(0, -1), { kind: "node", id, hops: 2, label: frameLabel(id), members: members(2) }];
  }
  return [...stack, { kind: "node", id, hops: 1, label: frameLabel(id), members: members(1) }];
}

/**
 * Whether a pick pushes its focus frame. Not while tracing a path: the 1-hop
 * frame would dim every route note more than a hop from the end. Not while
 * flying either: a pick only fills the ship's HUD. The canvas click, the gaps
 * list, the find box and an inspector link all follow this, so a path end
 * picked anywhere leaves the whole route lit.
 */
export function pickFocuses(mode: { trace: boolean; fly: boolean }): boolean {
  return !mode.trace && !mode.fly;
}

/**
 * What one Esc closes, topmost first, in the order they are drawn: the
 * settings drawer (over the help and the inspector), the gesture help (over
 * the inspector), then an inspector with no frame of its own (a trace pick,
 * the neighbours button), then the focus frame — which takes the inspector
 * showing its note with it, so a canvas click still steps back out in one press.
 */
export function escTarget(o: {
  drawer: boolean;
  help: boolean;
  selected: string | null;
  stack: FocusFrame[];
}): "drawer" | "help" | "inspector" | "frame" | null {
  if (o.drawer) return "drawer";
  if (o.help) return "help";
  const top = o.stack[o.stack.length - 1];
  if (o.selected !== null && !(top?.kind === "node" && top.id === o.selected)) return "inspector";
  return top ? "frame" : null;
}

/** The graph canvas's accessible name: how many notes, and which one is
 * selected ("노트 71개, 선택: attention-mechanism"). */
export function canvasLabel(t: Strings, notes: number, selected: string | null): string {
  const tpl = selected ? t.gr_canvas_label_sel : t.gr_canvas_label;
  return tpl.replace("{n}", String(notes)).replace("{name}", selected ? frameLabel(selected) : "");
}
