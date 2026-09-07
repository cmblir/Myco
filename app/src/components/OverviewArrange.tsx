// Arrange mode for the Overview's own blocks — the board's customization,
// applied to the page around it.
//
// Two rules keep view mode honest. Nothing is draggable outside arrange mode
// (an accidental drag is the #1 customization killer, which is why the board
// locks its grid too), and a zone whose blocks are all full width renders its
// blocks as plain children with no wrapper and no grid, exactly as the fixed
// stack did. The 12-column grid appears when the user has actually asked for
// columns — so a vault that never edited cannot drift a pixel.
//
// Drags go through lib/pointerDrag: HTML5 drag-and-drop never fires inside the
// macOS Tauri webview (wry claims the drag for OS file drops), so `draggable`
// is not an option here. The keyboard path is not a fallback bolted on after —
// a pointer-only affordance would make the page unarrangeable without a mouse,
// so the grip is a focusable button and the arrows move the block.

import { Fragment, useEffect, useRef, useState } from "react";
import type { CSSProperties, JSX } from "react";
import type { Strings } from "../lib/i18n";
import { usePointerDrag } from "../lib/pointerDrag";
import { Segment } from "./ui";
import {
  BOARD_COLS,
  defaultOverviewLayout,
  loadOverviewLayout,
  moveOverviewItem,
  moveOverviewItemBefore,
  moveOverviewItemToZone,
  OVERVIEW_SPANS,
  overviewPosition,
  saveOverviewLayout,
  setOverviewSpan,
  zoneItems,
  type OverviewBlockId,
  type OverviewLayout,
  type OverviewZone,
} from "../lib/board";

/** The nine blocks, each already rendered by the page. `null` = it has nothing
 *  to show right now (no suggestions, no vault) — arrange mode still gives it
 *  a slot so it can be moved. */
export type OverviewNodes = Record<OverviewBlockId, JSX.Element | null>;

export interface ArrangeControl {
  layout: OverviewLayout;
  arranging: boolean;
  setArranging: (on: boolean) => void;
  reset: () => void;
  /** Live drag, for the drop indicator. */
  dragId: string | null;
  dragOver: string | null;
  startDrag: (id: string) => (e: React.PointerEvent) => void;
  move: (id: string, delta: number) => void;
  setSpan: (id: string, span: number) => void;
  /** The last move, for the aria-live region. */
  announcement: string;
}

/** How long a drag's layout change waits before it reaches the file. A drag
 *  emits many moves; the vault gets one write. */
const SAVE_MS = 400;

export function useOverviewArrange(
  t: Strings,
  vaultPath: string | undefined,
): ArrangeControl {
  const [layout, setLayout] = useState<OverviewLayout>(defaultOverviewLayout);
  const [arranging, setArranging] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  /** The layout every edit builds on. Not the `layout` state: two width clicks
   *  in one tick both close over the same pre-render value, and the second
   *  silently threw away the first (measured — three of five width changes
   *  were lost). React batches the renders; this does not batch the document. */
  const latest = useRef<OverviewLayout>(layout);
  // Guards the first write: the load resolves a render after mount, and saving
  // the default over a real file before it arrives would erase the user's
  // arrangement on every visit.
  const loaded = useRef(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Grip to refocus after a move that rebuilt the DOM node holding it —
   *  crossing zones destroys the button, and losing focus mid-keyboard-move
   *  strands the user. */
  const refocus = useRef<string | null>(null);

  useEffect(() => {
    if (!vaultPath) return;
    let gone = false;
    loaded.current = false;
    void loadOverviewLayout(vaultPath).then((l) => {
      if (gone) return;
      latest.current = l;
      setLayout(l);
      loaded.current = true;
    });
    return () => {
      gone = true;
    };
  }, [vaultPath]);

  // Flush a pending write on unmount, so leaving the page right after a drop
  // does not drop the arrangement.
  const pending = useRef<OverviewLayout | null>(null);
  useEffect(
    () => () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
      if (pending.current) void saveOverviewLayout(pending.current).catch(() => undefined);
    },
    [],
  );

  /** Runs the edit against the newest document, publishes it, and schedules
   *  the one write. Returns whether anything actually changed. */
  const apply = (edit: (from: OverviewLayout) => OverviewLayout): boolean => {
    const next = edit(latest.current);
    if (next === latest.current) return false;
    latest.current = next;
    setLayout(next);
    if (!loaded.current) return true;
    pending.current = next;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      const doc = pending.current;
      pending.current = null;
      if (doc) void saveOverviewLayout(doc).catch(() => undefined);
    }, SAVE_MS);
    return true;
  };

  const announce = (id: string): void => {
    const at = overviewPosition(latest.current, id);
    if (!at) return;
    setAnnouncement(
      t.ovl_moved
        .replace("{block}", blockLabel(t, id as OverviewBlockId))
        .replace("{zone}", zoneLabel(t, at.zone))
        .replace("{index}", String(at.index))
        .replace("{total}", String(at.total)),
    );
  };

  const { live, start } = usePointerDrag((id, target) => {
    const moved = apply((from) =>
      target.startsWith("end:")
        ? moveOverviewItemToZone(from, id, target.slice(4) as OverviewZone)
        : moveOverviewItemBefore(from, id, target),
    );
    if (moved) announce(id);
  }, arranging);

  useEffect(() => {
    const id = refocus.current;
    if (!id) return;
    refocus.current = null;
    document
      .querySelector<HTMLButtonElement>(`[data-grip="${CSS.escape(id)}"]`)
      ?.focus();
  }, [layout]);

  return {
    layout,
    arranging,
    setArranging,
    reset: () => {
      apply(defaultOverviewLayout);
      setAnnouncement(t.ovl_reset_done);
    },
    dragId: live?.id ?? null,
    dragOver: live?.target ?? null,
    startDrag: start,
    move: (id, delta) => {
      refocus.current = id;
      if (apply((from) => moveOverviewItem(from, id, delta))) announce(id);
    },
    setSpan: (id, span) => {
      apply((from) => setOverviewSpan(from, id, span));
    },
    announcement,
  };
}

/** One zone's blocks, in the layout's order. */
export function OverviewZoneBlocks({
  zone,
  ctl,
  nodes,
  t,
}: {
  zone: OverviewZone;
  ctl: ArrangeControl;
  nodes: OverviewNodes;
  t: Strings;
}): JSX.Element | null {
  const items = zoneItems(ctl.layout, zone);
  // The wrapper + grid exist only when they earn it: arrange mode needs drop
  // targets, and a span under full width needs a column to sit in. Otherwise
  // the blocks are plain children, which is what the page has always been.
  const boxed =
    ctl.arranging ||
    (zone === "main" && items.some((i) => i.span < BOARD_COLS));

  const shown = items.filter((i) => ctl.arranging || nodes[i.id]);
  if (shown.length === 0 && !ctl.arranging) return null;

  // Unboxed: fragments, not divs. A wrapper div would be a new formatting
  // context, and the blocks' own margins collapse through the plain column
  // they have always lived in — one extra box moved the Recently-moved
  // heading 18px down, which is not "looks exactly as it does now".
  if (!boxed) {
    const plain = shown.map((item) => (
      <Fragment key={item.id}>{nodes[item.id]}</Fragment>
    ));
    // The rail's own 12px stack, which is the wrapper the four panels always
    // had. The main column never had one.
    return zone === "rail" ? <div className="ovl-rail-stack">{plain}</div> : <>{plain}</>;
  }

  const children = shown.map((item) => {
    const node = nodes[item.id];
    const dragging = ctl.dragId === item.id;
    return (
      <div
        key={item.id}
        className={
          "ovl-block" +
          (dragging ? " is-dragging" : "") +
          (ctl.dragOver === item.id && !dragging ? " is-over" : "")
        }
        style={
          zone === "main"
            ? ({ "--ovl-span": item.span } as CSSProperties)
            : undefined
        }
        data-drop={ctl.arranging ? item.id : undefined}
        data-block={item.id}
        data-span={zone === "main" ? item.span : undefined}
      >
        {ctl.arranging ? (
          <ArrangeBar item={item} ctl={ctl} t={t} zone={zone} />
        ) : null}
        {node ?? <p className="muted ovl-vacant">{t.ovl_vacant}</p>}
      </div>
    );
  });

  return (
    <div
      className={
        `ovl-zone ovl-zone--${zone}` + (ctl.arranging ? " is-arranging" : "")
      }
      data-testid={`overview-zone-${zone}`}
    >
      {children}
      {ctl.arranging ? (
        // The only way back into a zone the user emptied — without it a rail
        // stripped of all four panels could never be refilled.
        <div className="ovl-end" data-drop={`end:${zone}`}>
          {t.ovl_drop_here}
        </div>
      ) : null}
    </div>
  );
}

function ArrangeBar({
  item,
  ctl,
  t,
  zone,
}: {
  item: { id: OverviewBlockId; span: number };
  ctl: ArrangeControl;
  t: Strings;
  zone: OverviewZone;
}): JSX.Element {
  const name = blockLabel(t, item.id);
  const grip = t.ovl_move.replace("{block}", name);
  return (
    <div className="ovl-bar">
      <button
        type="button"
        className="ovl-grip"
        data-grip={item.id}
        aria-label={grip}
        title={grip}
        onPointerDown={ctl.startDrag(item.id)}
        onKeyDown={(e) => {
          const delta =
            e.key === "ArrowUp" || e.key === "ArrowLeft"
              ? -1
              : e.key === "ArrowDown" || e.key === "ArrowRight"
                ? 1
                : 0;
          if (delta === 0) return;
          e.preventDefault();
          ctl.move(item.id, delta);
        }}
      >
        <span aria-hidden="true">⠿</span>
      </button>
      <span className="ovl-name">{name}</span>
      {/* Span is a main-column property: the rail is one column wide, so the
          control would do nothing there. The value is kept while a block
          visits the rail, and comes back with it. */}
      {zone === "main" ? (
        <Segment
          className="ovl-spans"
          label={t.ovl_span}
          value={String(item.span)}
          options={OVERVIEW_SPANS.map((s) => ({
            value: String(s),
            label: spanLabel(t, s),
          }))}
          onChange={(v) => ctl.setSpan(item.id, Number(v))}
        />
      ) : null}
    </div>
  );
}

/** Each block's name in the arrange bar reuses the title the block itself
 *  shows, so the handle and the panel never disagree. Only the two blocks with
 *  no title of their own (the pulse tile, and the harvest surface whose
 *  headline carries a count) need a string here. */
export function blockLabel(t: Strings, id: OverviewBlockId): string {
  switch (id) {
    case "pulse":
      return t.ovl_b_pulse;
    case "harvest":
      return t.ovl_b_harvest;
    case "links":
      return t.ls_title;
    case "recent":
      return t.ov_recent_moved;
    case "board":
      return t.bd_title;
    case "since":
      return t.ov_since_eyebrow;
    case "suspect":
      return t.ov_suspect_title;
    case "contradictions":
      return t.contra_title;
    case "reunions":
      return t.ritual_title;
  }
}

function zoneLabel(t: Strings, zone: OverviewZone): string {
  return zone === "rail" ? t.ovl_zone_rail : t.ovl_zone_main;
}

function spanLabel(t: Strings, span: number): string {
  if (span >= BOARD_COLS) return t.ovl_span_full;
  return span === 4 ? "1/3" : "1/2";
}
