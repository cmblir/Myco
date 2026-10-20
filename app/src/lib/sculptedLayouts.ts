import type { VaultGraph } from "./graphData";

export type SculptedLayoutKind = "terrain" | "ribbon" | "city";
export function isSculptedLayout(layout: string): layout is SculptedLayoutKind {
  return layout === "terrain" || layout === "ribbon" || layout === "city";
}
export interface SculptedVector {
  x: number;
  y: number;
  z: number;
}
export interface SculptedNode {
  width: number;
  depth: number;
  height: number;
  normal: SculptedVector;
}
export interface SculptedBounds {
  min: SculptedVector;
  max: SculptedVector;
}
interface LayoutBase {
  radius: number;
  nodes: Map<string, SculptedNode>;
  bounds: SculptedBounds;
}
export interface TerrainPeak {
  x: number;
  y: number;
  height: number;
  spreadX: number;
  spreadY: number;
}
export interface TerrainLayout extends LayoutBase {
  kind: "terrain";
  peaks: TerrainPeak[];
  extent: { width: number; depth: number };
}
export interface RibbonLayout extends LayoutBase {
  kind: "ribbon";
  halfWidth: number;
}
export interface CityDistrict {
  community: number;
  x: number;
  y: number;
  width: number;
  depth: number;
  streetX?: number[];
  streetY?: number[];
  streetWidthX?: number;
  streetWidthY?: number;
}
export interface CityLayout extends LayoutBase {
  kind: "city";
  districts: CityDistrict[];
}
export type SculptedLayoutResult = TerrainLayout | RibbonLayout | CityLayout;

interface Members {
  community: number;
  ids: string[];
}
interface Plot extends Members {
  x: number;
  y: number;
  width: number;
  depth: number;
}
const UP: SculptedVector = { x: 0, y: 0, z: 1 };
const compareIds = (a: string, b: string): number =>
  a < b ? -1 : a > b ? 1 : 0;

function unit(seed: string): number {
  let hash = 2166136261;
  for (let i = 0; i < seed.length; i++)
    hash = Math.imul(hash ^ seed.charCodeAt(i), 16777619);
  hash ^= hash >>> 16;
  hash = Math.imul(hash, 0x7feb352d);
  hash ^= hash >>> 15;
  hash = Math.imul(hash, 0x846ca68b);
  return ((hash ^ (hash >>> 16)) >>> 0) / 4294967296;
}

function members(graph: VaultGraph): Members[] {
  const groups = new Map<number, string[]>();
  graph.forEachNode((id, attrs) => {
    const community = Number.isFinite(attrs.community) ? attrs.community : -1;
    const ids = groups.get(community) ?? [];
    ids.push(id);
    groups.set(community, ids);
  });
  return [...groups]
    .map(([community, ids]) => ({ community, ids: ids.sort(compareIds) }))
    .sort((a, b) => b.ids.length - a.ids.length || a.community - b.community);
}

// Weighted bisection gives every real group room, including many tiny groups.
function partition(
  groups: Members[],
  x: number,
  y: number,
  width: number,
  depth: number,
): Plot[] {
  if (groups.length === 0) return [];
  if (groups.length === 1) return [{ ...groups[0], x, y, width, depth }];
  const total = groups.reduce((sum, group) => sum + group.ids.length, 0);
  let count = 0;
  let split = 1;
  for (; split < groups.length; split++) {
    count += groups[split - 1].ids.length;
    if (count >= total / 2) break;
  }
  const fraction = count / total;
  if (width >= depth) {
    const leftWidth = width * fraction;
    return [
      ...partition(
        groups.slice(0, split),
        x - (width - leftWidth) / 2,
        y,
        leftWidth,
        depth,
      ),
      ...partition(
        groups.slice(split),
        x + leftWidth / 2,
        y,
        width - leftWidth,
        depth,
      ),
    ];
  }
  const frontDepth = depth * fraction;
  return [
    ...partition(
      groups.slice(0, split),
      x,
      y - (depth - frontDepth) / 2,
      width,
      frontDepth,
    ),
    ...partition(
      groups.slice(split),
      x,
      y + frontDepth / 2,
      width,
      depth - frontDepth,
    ),
  ];
}

function grid(plot: Plot): {
  columns: number;
  rows: number;
  stepX: number;
  stepY: number;
} {
  const columns = Math.min(
    plot.ids.length,
    Math.max(
      1,
      Math.ceil(Math.sqrt((plot.ids.length * plot.width) / plot.depth)),
    ),
  );
  const rows = Math.ceil(plot.ids.length / columns);
  return {
    columns,
    rows,
    stepX: plot.width / columns,
    stepY: plot.depth / rows,
  };
}

function emptyBounds(): SculptedBounds {
  return { min: { x: 0, y: 0, z: 0 }, max: { x: 0, y: 0, z: 0 } };
}

function include(
  bounds: SculptedBounds,
  position: SculptedVector,
  margin = 0,
): void {
  for (const axis of ["x", "y", "z"] as const) {
    bounds.min[axis] = Math.min(bounds.min[axis], position[axis] - margin);
    bounds.max[axis] = Math.max(bounds.max[axis], position[axis] + margin);
  }
}

function place(
  graph: VaultGraph,
  layout: SculptedLayoutResult,
  id: string,
  position: SculptedVector,
  node: SculptedNode,
): void {
  graph.setNodeAttribute(id, "x", position.x);
  graph.setNodeAttribute(id, "y", position.y);
  graph.setNodeAttribute(id, "z", position.z);
  layout.nodes.set(id, node);
  include(
    layout.bounds,
    position,
    Math.hypot(node.width, node.depth, node.height) / 2,
  );
}

/** Height of the continuous terrain in world units, shared by notes and mesh. */
export function sampleTerrain(
  layout: TerrainLayout,
  x: number,
  y: number,
): number {
  const r = layout.radius;
  const nx = x / r;
  const ny = y / r;
  let strongest = 0;
  let combined = 0;
  for (const peak of layout.peaks) {
    const angle = 0.42 * Math.sin((peak.x / r) * 4 + (peak.y / r) * 3);
    const dx = x - peak.x;
    const dy = y - peak.y;
    const along = (dx * Math.cos(angle) + dy * Math.sin(angle)) / peak.spreadX;
    const across =
      (-dx * Math.sin(angle) + dy * Math.cos(angle)) / peak.spreadY;
    const bend = across - 0.32 * Math.sin(along * 1.7 + (peak.x / r) * 2);
    const crest = 0.9 + 0.1 * Math.cos(along * 3.2 + (peak.y / r) * 4);
    const influence =
      peak.height * crest * Math.exp(-0.5 * (along * along + bend * bend));
    combined += influence;
    strongest = Math.max(strongest, influence);
  }
  // Elevation shapes the display only: narrow ridges retain valleys between groups.
  const support =
    r * 0.07 * (1 - Math.exp(-(combined - strongest) / (r * 0.12)));
  const edgeX = Math.max(0, 1 - ((2 * x) / layout.extent.width) ** 8);
  const edgeY = Math.max(0, 1 - ((2 * y) / layout.extent.depth) ** 8);
  const foothills = r * (0.014 + 0.008 * Math.sin(nx * 7 + ny * 4) ** 2);
  return r * 0.006 + (strongest + support + foothills) * edgeX * edgeY;
}

function normalized(x: number, y: number, z: number): SculptedVector {
  const length = Math.hypot(x, y, z);
  return length > 1e-12
    ? { x: x / length, y: y / length, z: z / length }
    : { ...UP };
}

export function terrainNormal(
  layout: TerrainLayout,
  x: number,
  y: number,
): SculptedVector {
  const step = layout.radius * 0.0005;
  const dx =
    (sampleTerrain(layout, x + step, y) - sampleTerrain(layout, x - step, y)) /
    (2 * step);
  const dy =
    (sampleTerrain(layout, x, y + step) - sampleTerrain(layout, x, y - step)) /
    (2 * step);
  return normalized(-dx, -dy, 1);
}

function terrain(
  graph: VaultGraph,
  groups: Members[],
  radius: number,
): TerrainLayout {
  const layout: TerrainLayout = {
    kind: "terrain",
    radius,
    nodes: new Map(),
    bounds: emptyBounds(),
    peaks: [],
    extent: { width: radius * 2, depth: radius * 1.52 },
  };
  if (graph.order === 0) return layout;
  const plots = partition(groups, 0, 0, radius * 1.84, radius * 1.36);
  layout.peaks = plots.slice(0, 12).map((plot) => ({
    x: plot.x + (unit(`peak-x:${plot.community}`) - 0.5) * plot.width * 0.16,
    y: plot.y + (unit(`peak-y:${plot.community}`) - 0.5) * plot.depth * 0.16,
    height: radius * (0.26 + 0.23 * (plot.ids.length / graph.order) ** 0.35),
    spreadX: Math.max(radius * 0.15, plot.width * 0.38),
    spreadY: Math.max(radius * 0.052, plot.depth * 0.2),
  }));
  for (const plot of plots) {
    const { columns, rows, stepX, stepY } = grid(plot);
    plot.ids.forEach((id, index) => {
      const x =
        plot.x +
        ((index % columns) -
          (columns - 1) / 2 +
          (unit(`${id}:tx`) - 0.5) * 0.28) *
          stepX;
      const y =
        plot.y +
        (Math.floor(index / columns) -
          (rows - 1) / 2 +
          (unit(`${id}:ty`) - 0.5) * 0.28) *
          stepY;
      const normal = terrainNormal(layout, x, y);
      const width = Math.min(radius * 0.052, stepX * 0.44, stepY * 0.52);
      const height = width * 0.34;
      const lift = height / 2 + radius * 0.012;
      place(
        graph,
        layout,
        id,
        {
          x: x + normal.x * lift,
          y: y + normal.y * lift,
          z: sampleTerrain(layout, x, y) + normal.z * lift,
        },
        { width, depth: width * 0.74, height, normal },
      );
    });
  }
  include(layout.bounds, { x: -radius, y: -radius * 0.76, z: -radius * 0.035 });
  include(layout.bounds, { x: radius, y: radius * 0.76, z: 0 });
  for (let x = -1; x <= 1; x += 0.125)
    for (let y = -0.75; y <= 0.75; y += 0.125) {
      include(layout.bounds, {
        x: x * radius,
        y: y * radius,
        z: sampleTerrain(layout, x * radius, y * radius),
      });
    }
  return layout;
}

function ribbonCenter(u: number): SculptedVector {
  u = Math.max(0, Math.min(1, u));
  // Monotonic x opens both folds, preserving negative space and avoiding a knot.
  return {
    x: u * 2 - 1,
    y: Math.sin(u * Math.PI * 2) * 0.44,
    z: 0.08 + Math.sin(u * Math.PI) ** 2 * 0.5 + u * 0.1,
  };
}

function ribbonPosition(
  layout: RibbonLayout,
  u: number,
  v: number,
): SculptedVector {
  const center = ribbonCenter(u);
  const before = ribbonCenter(u - 0.0001);
  const after = ribbonCenter(u + 0.0001);
  const tangent = normalized(
    after.x - before.x,
    after.y - before.y,
    after.z - before.z,
  );
  const side = normalized(-tangent.y, tangent.x, 0);
  const up = normalized(
    -tangent.z * side.y,
    tangent.z * side.x,
    tangent.x * side.y - tangent.y * side.x,
  );
  const twist =
    Math.sin(u * Math.PI * 2 - 0.85) * 0.98 * Math.sin(u * Math.PI) +
    0.12 * Math.cos(u * Math.PI * 2);
  const width = layout.halfWidth * v;
  return {
    x:
      center.x * layout.radius +
      (side.x * Math.cos(twist) + up.x * Math.sin(twist)) * width,
    y:
      center.y * layout.radius +
      (side.y * Math.cos(twist) + up.y * Math.sin(twist)) * width,
    z: center.z * layout.radius + up.z * Math.sin(twist) * width,
  };
}

/** Sample a wide folded strip; u follows its length and v spans [-1, 1]. */
export function sampleRibbon(
  layout: RibbonLayout,
  u: number,
  v: number,
): { position: SculptedVector; normal: SculptedVector } {
  u = Math.max(0, Math.min(1, u));
  v = Math.max(-1, Math.min(1, v));
  const position = ribbonPosition(layout, u, v);
  const before = ribbonPosition(layout, Math.max(0, u - 0.0001), v);
  const after = ribbonPosition(layout, Math.min(1, u + 0.0001), v);
  const left = ribbonPosition(layout, u, -1);
  const right = ribbonPosition(layout, u, 1);
  const a = {
    x: after.x - before.x,
    y: after.y - before.y,
    z: after.z - before.z,
  };
  const b = { x: right.x - left.x, y: right.y - left.y, z: right.z - left.z };
  const normal = normalized(
    a.y * b.z - a.z * b.y,
    a.z * b.x - a.x * b.z,
    a.x * b.y - a.y * b.x,
  );
  return { position, normal };
}

function ribbon(
  graph: VaultGraph,
  groups: Members[],
  radius: number,
): RibbonLayout {
  const layout: RibbonLayout = {
    kind: "ribbon",
    radius,
    nodes: new Map(),
    bounds: emptyBounds(),
    halfWidth: radius * 0.18,
  };
  if (graph.order === 0) return layout;
  const columns = Math.max(1, Math.ceil(Math.sqrt(graph.order / 18)));
  const rows = Math.ceil(graph.order / columns);
  const width = Math.min(
    radius * 0.052,
    (layout.halfWidth * 1.55) / columns,
    (radius * 3.2) / rows,
  );
  groups
    .flatMap((group) => group.ids)
    .forEach((id, index) => {
      const row = Math.floor(index / columns);
      const u = rows === 1 ? 0.35 : 0.025 + (row / (rows - 1)) * 0.95;
      const v =
        columns === 1 ? 0 : ((index % columns) / (columns - 1)) * 1.48 - 0.74;
      const { position, normal } = sampleRibbon(layout, u, v);
      const height = width * 0.32;
      const lift = height / 2 + radius * 0.012;
      place(
        graph,
        layout,
        id,
        {
          x: position.x + normal.x * lift,
          y: position.y + normal.y * lift,
          z: position.z + normal.z * lift,
        },
        { width, depth: width * 0.74, height, normal },
      );
    });
  for (let i = 0; i <= 160; i++)
    for (const v of [-1, 1])
      include(layout.bounds, sampleRibbon(layout, i / 160, v).position);
  return layout;
}

function cityAxis(
  count: number,
  center: number,
  extent: number,
): { centers: number[]; streets: number[]; step: number; streetWidth: number } {
  const block = Math.max(4, Math.ceil(count / 33));
  const roadCount = Math.floor((count - 1) / block);
  const roadWidth = 1.15;
  const span = count + roadCount * roadWidth;
  const step = extent / span;
  return {
    centers: Array.from(
      { length: count },
      (_, index) =>
        center +
        (index + 0.5 + Math.floor(index / block) * roadWidth - span / 2) * step,
    ),
    streets: Array.from(
      { length: roadCount },
      (_, index) =>
        center +
        ((index + 1) * block + (index + 0.5) * roadWidth - span / 2) * step,
    ),
    step,
    streetWidth: step * roadWidth,
  };
}

function city(
  graph: VaultGraph,
  groups: Members[],
  radius: number,
): CityLayout {
  const layout: CityLayout = {
    kind: "city",
    radius,
    nodes: new Map(),
    bounds: emptyBounds(),
    districts: [],
  };
  if (graph.order === 0) return layout;
  const plots = partition(groups, 0, 0, radius * 1.92, radius * 1.62);
  let maxDegree = 1;
  graph.forEachNode((_id, attrs) => {
    if (Number.isFinite(attrs.deg)) maxDegree = Math.max(maxDegree, attrs.deg);
  });
  for (const plot of plots) {
    const district: CityDistrict = {
      community: plot.community,
      x: plot.x,
      y: plot.y,
      width: plot.width * 0.88,
      depth: plot.depth * 0.88,
    };
    const { columns, rows } = grid({ ...plot, ...district });
    const horizontal = cityAxis(columns, plot.x, district.width * 0.92);
    const vertical = cityAxis(rows, plot.y, district.depth * 0.92);
    district.streetX = horizontal.streets;
    district.streetY = vertical.streets;
    district.streetWidthX = horizontal.streetWidth;
    district.streetWidthY = vertical.streetWidth;
    layout.districts.push(district);
    const lots = horizontal.centers.flatMap((x) =>
      vertical.centers.map((y) => ({ x, y })),
    );
    const distance = (lot: { x: number; y: number }): number =>
      ((lot.x - plot.x) / district.width) ** 2 +
      ((lot.y - plot.y) / district.depth) ** 2;
    lots.sort((a, b) => distance(a) - distance(b) || a.y - b.y || a.x - b.x);
    // Actual high-degree notes form each skyline; no decorative buildings are added.
    const sorted = [...plot.ids].sort((a, b) => {
      const degreeA = graph.getNodeAttribute(a, "deg");
      const degreeB = graph.getNodeAttribute(b, "deg");
      return (
        (Number.isFinite(degreeB) ? degreeB : 0) -
          (Number.isFinite(degreeA) ? degreeA : 0) || compareIds(a, b)
      );
    });
    const densityScale =
      0.65 + 0.35 * Math.min(1, Math.sqrt(350 / graph.order));
    sorted.forEach((id, index) => {
      const attrs = graph.getNodeAttributes(id);
      const degree = Number.isFinite(attrs.deg) ? Math.max(0, attrs.deg) : 0;
      const height =
        radius * (0.018 + 0.16 * (degree / maxDegree) ** 1.45) * densityScale;
      const width = Math.min(radius * 0.105, horizontal.step * 0.62);
      const depth = Math.min(radius * 0.095, vertical.step * 0.62);
      place(
        graph,
        layout,
        id,
        {
          x: lots[index].x,
          y: lots[index].y,
          z: height / 2,
        },
        { width, depth, height, normal: { ...UP } },
      );
    });
    include(layout.bounds, {
      x: district.x - district.width / 2,
      y: district.y - district.depth / 2,
      z: -radius * 0.014,
    });
    include(layout.bounds, {
      x: district.x + district.width / 2,
      y: district.y + district.depth / 2,
      z: 0,
    });
  }
  return layout;
}

/** Place existing notes on one of three deterministic, physically distinct surfaces. */
export function applySculptedLayout(
  graph: VaultGraph,
  kind: SculptedLayoutKind,
  options: { targetRadius: number },
): SculptedLayoutResult {
  if (!Number.isFinite(options.targetRadius) || options.targetRadius <= 0)
    throw new RangeError("targetRadius must be finite and positive");
  const groups = members(graph);
  if (kind === "terrain") return terrain(graph, groups, options.targetRadius);
  if (kind === "ribbon") return ribbon(graph, groups, options.targetRadius);
  return city(graph, groups, options.targetRadius);
}
