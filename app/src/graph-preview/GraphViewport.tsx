import { useEffect, useMemo, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { copy } from "./copy";
import { placeLabels } from "./labels";
import {
  neighborhood,
  type Look,
  type Point,
  type PreviewGraph,
} from "./model";

interface Props {
  graph: PreviewGraph;
  look: Look;
  selected: string | null;
  query: string;
  isFocused: boolean;
  showLabels: boolean;
  brightness: number;
  onSelect: (id: string | null) => void;
}
const HOME = { x: 0, y: 0, scale: 1 };

export function GraphViewport({
  graph,
  look,
  selected,
  query,
  isFocused,
  showLabels,
  brightness,
  onSelect,
}: Props) {
  const svg = useRef<SVGSVGElement>(null);
  const [camera, setCamera] = useState(HOME);
  const [hovered, setHovered] = useState<string | null>(null);
  const [positions, setPositions] = useState<Record<string, Point>>({});
  const current = useRef(positions);
  const drag = useRef<{
    start: Point;
    origin: Point;
    id: string | null;
    moved: boolean;
  } | null>(null);
  const active = selected ?? hovered;
  const nearby = useMemo(() => neighborhood(graph, active), [graph, active]);
  const nodesById = useMemo(
    () => new Map(graph.nodes.map((n) => [n.id, n])),
    [graph],
  );

  useEffect(() => {
    const from = current.current;
    const started = performance.now();
    const reduced = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    let frame = 0;
    const animate = (now: number): void => {
      const t = reduced ? 1 : Math.min(1, (now - started) / 550);
      const eased = 1 - (1 - t) ** 3;
      const next: Record<string, Point> = {};
      for (const node of graph.nodes) {
        const end = node.positions[look],
          start = from[node.id] ?? end;
        next[node.id] = {
          x: start.x + (end.x - start.x) * eased,
          y: start.y + (end.y - start.y) * eased,
        };
      }
      current.current = next;
      setPositions(next);
      if (t < 1) frame = requestAnimationFrame(animate);
    };
    frame = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(frame);
  }, [graph, look]);

  function zoom(factor: number): void {
    setCamera((previous) => {
      const scale = Math.min(4, Math.max(0.55, previous.scale * factor));
      return {
        scale,
        x: 500 - ((500 - previous.x) * scale) / previous.scale,
        y: 350 - ((350 - previous.y) * scale) / previous.scale,
      };
    });
  }
  function point(clientX: number, clientY: number): Point {
    const matrix = svg.current?.getScreenCTM();
    return matrix
      ? new DOMPoint(clientX, clientY).matrixTransform(matrix.inverse())
      : { x: clientX, y: clientY };
  }
  useEffect(() => {
    const element = svg.current;
    if (!element) return;
    const wheel = (event: WheelEvent): void => {
      event.preventDefault();
      const cursor = point(event.clientX, event.clientY);
      setCamera((previous) => {
        const scale = Math.min(
          4,
          Math.max(0.55, previous.scale * Math.exp(-event.deltaY * 0.0015)),
        );
        return {
          scale,
          x: cursor.x - ((cursor.x - previous.x) * scale) / previous.scale,
          y: cursor.y - ((cursor.y - previous.y) * scale) / previous.scale,
        };
      });
    };
    element.addEventListener("wheel", wheel, { passive: false });
    return () => element.removeEventListener("wheel", wheel);
  }, []);

  function begin(
    event: ReactPointerEvent<SVGElement>,
    id: string | null,
  ): void {
    if (event.button !== 0) return;
    event.stopPropagation();
    const start = point(event.clientX, event.clientY);
    drag.current = {
      start,
      origin: id ? current.current[id] : camera,
      id,
      moved: false,
    };
    svg.current?.setPointerCapture(event.pointerId);
  }
  function move(event: ReactPointerEvent<SVGSVGElement>): void {
    const action = drag.current;
    if (!action) return;
    const cursor = point(event.clientX, event.clientY);
    const dx = cursor.x - action.start.x,
      dy = cursor.y - action.start.y;
    if (Math.hypot(dx, dy) > 3) action.moved = true;
    if (action.id) {
      const next = {
        ...current.current,
        [action.id]: {
          x: action.origin.x + dx / camera.scale,
          y: action.origin.y + dy / camera.scale,
        },
      };
      current.current = next;
      setPositions(next);
    } else
      setCamera((previous) => ({
        ...previous,
        x: action.origin.x + dx,
        y: action.origin.y + dy,
      }));
  }
  function end(event: ReactPointerEvent<SVGSVGElement>): void {
    const action = drag.current;
    if (action && !action.moved) onSelect(action.id);
    drag.current = null;
    if (svg.current?.hasPointerCapture(event.pointerId))
      svg.current.releasePointerCapture(event.pointerId);
  }
  const visible = (id: string): boolean =>
    !isFocused || !selected || nearby.has(id);
  const matches = (id: string): boolean =>
    !query ||
    nodesById.get(id)!.label.toLowerCase().includes(query.toLowerCase());
  const clusters = [...new Set(graph.nodes.map((n) => n.community))].map(
    (community) => {
      const members = graph.nodes.filter((n) => n.community === community);
      const center = members.reduce(
        (sum, n) => ({
          x: sum.x + (positions[n.id]?.x ?? 500),
          y: sum.y + (positions[n.id]?.y ?? 350),
        }),
        { x: 0, y: 0 },
      );
      return {
        community,
        x: center.x / members.length,
        y: center.y / members.length,
        size: 30 + Math.sqrt(members.length) * 6,
      };
    },
  );
  const hubs = new Set(
    clusters.map(
      (cluster) =>
        graph.nodes
          .filter((node) => node.community === cluster.community)
          .sort((a, b) => b.degree - a.degree)[0]?.id,
    ),
  );
  const labels = placeLabels(
    showLabels
      ? graph.nodes.filter(
          (node) =>
            visible(node.id) &&
            matches(node.id) &&
            (active ? nearby.has(node.id) : query || hubs.has(node.id)),
        )
      : [],
    positions,
    active,
  );
  return (
    <div className="graph-stage">
      <svg
        ref={svg}
        viewBox="0 0 1000 700"
        role="group"
        aria-label={copy.graph}
        tabIndex={0}
        onPointerDown={(e) => begin(e, null)}
        onPointerMove={move}
        onPointerUp={end}
        onPointerCancel={() => {
          drag.current = null;
        }}
        onLostPointerCapture={() => {
          drag.current = null;
        }}
        onKeyDown={(event) => {
          if (event.target !== event.currentTarget) return;
          const step = 35;
          if (
            [
              "ArrowLeft",
              "ArrowRight",
              "ArrowUp",
              "ArrowDown",
              "+",
              "=",
              "-",
              "0",
              "Escape",
            ].includes(event.key)
          )
            event.preventDefault();
          if (event.key === "Escape") onSelect(null);
          if (event.key === "+" || event.key === "=") zoom(1.2);
          if (event.key === "-") zoom(1 / 1.2);
          if (event.key === "0") setCamera(HOME);
          if (event.key.startsWith("Arrow"))
            setCamera((previous) => ({
              ...previous,
              x:
                previous.x +
                (event.key === "ArrowLeft"
                  ? step
                  : event.key === "ArrowRight"
                    ? -step
                    : 0),
              y:
                previous.y +
                (event.key === "ArrowUp"
                  ? step
                  : event.key === "ArrowDown"
                    ? -step
                    : 0),
            }));
        }}
      >
        <g
          transform={`translate(${camera.x} ${camera.y}) scale(${camera.scale})`}
        >
          {look === "terrain" && (
            <g className="contours" aria-hidden="true">
              {clusters.flatMap((cluster) =>
                [1, 1.35, 1.7, 2.05].map((ring) => (
                  <ellipse
                    key={`${cluster.community}:${ring}`}
                    cx={cluster.x}
                    cy={cluster.y}
                    rx={cluster.size * ring}
                    ry={cluster.size * ring * 0.76}
                  />
                )),
              )}
            </g>
          )}
          <g aria-hidden="true">
            {graph.edges.map((edge) => {
              const a = positions[edge.source],
                b = positions[edge.target];
              if (!a || !b || !visible(edge.source) || !visible(edge.target))
                return null;
              const incident = edge.source === active || edge.target === active;
              const dim =
                (active && !incident) ||
                (query && !matches(edge.source) && !matches(edge.target));
              return (
                <line
                  key={edge.id}
                  x1={a.x}
                  y1={a.y}
                  x2={b.x}
                  y2={b.y}
                  stroke={
                    incident ? "#d6c6ff" : nodesById.get(edge.source)!.color
                  }
                  strokeWidth={incident ? 1.6 : 0.7}
                  opacity={(dim ? 0.035 : incident ? 0.95 : 0.3) * brightness}
                />
              );
            })}
          </g>
          {graph.nodes.map((node) => {
            const p = positions[node.id];
            if (!p || !visible(node.id)) return null;
            const isSelected = selected === node.id;
            const dim = (active && !nearby.has(node.id)) || !matches(node.id);
            const radius = 2.6 + Math.min(6, Math.sqrt(node.degree) * 0.65);
            const label = labels.get(node.id);
            return (
              <g
                key={node.id}
                className="graph-node"
                transform={`translate(${p.x} ${p.y})`}
                opacity={dim ? 0.17 : 1}
                role="button"
                aria-label={`${copy.select}: ${node.label}`}
                aria-pressed={isSelected}
                tabIndex={-1}
                onPointerDown={(e) => begin(e, node.id)}
                onPointerEnter={() => setHovered(node.id)}
                onPointerLeave={() => setHovered(null)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    onSelect(node.id);
                  }
                }}
              >
                <circle r={14} fill="transparent" />
                {isSelected && (
                  <circle className="selection-ring" r={radius + 5} />
                )}
                <circle r={radius} fill={node.color} />
                {label && (
                  <text x={label.x} y={label.y} className="node-label">
                    {label.text}
                  </text>
                )}
              </g>
            );
          })}
        </g>
      </svg>
      <div className="viewport-tools">
        <button aria-label={copy.zoomIn} onClick={() => zoom(1.25)}>
          +
        </button>
        <button aria-label={copy.zoomOut} onClick={() => zoom(0.8)}>
          −
        </button>
        <span>
          {new Intl.NumberFormat("ko", { style: "percent" }).format(
            camera.scale,
          )}
        </span>
        <button onClick={() => setCamera(HOME)}>{copy.reset}</button>
      </div>
      <p className="stage-hint">{copy.hints}</p>
    </div>
  );
}
