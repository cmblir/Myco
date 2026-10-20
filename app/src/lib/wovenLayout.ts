import Graph from "graphology";
import louvain from "graphology-communities-louvain";
import {
  forceSimulation,
  forceLink,
  forceManyBody,
  forceCollide,
  forceCenter,
  forceX,
  forceY,
  type SimulationLinkDatum,
  type SimulationNodeDatum,
} from "d3-force";
import { CatmullRomCurve3, Vector3 } from "three";
import type { VaultGraph } from "./graphData";
import type { SculptedNode, SculptedBounds } from "./sculptedLayouts";

export interface WovenInput {
  radius: number;
  nodes: { id: string; community: number; degree: number }[];
  edges: { id: string; source: string; target: string }[];
}
export interface WovenLayout {
  kind: "woven";
  radius: number;
  nodes: Map<string, SculptedNode>;
  positions: Map<string, { x: number; y: number; z: number }>;
  bounds: SculptedBounds;
  routes: {
    id: string;
    source: string;
    target: string;
    points: Float32Array;
  }[];
}
interface Site extends SimulationNodeDatum {
  id: string;
  radius: number;
}
const compare = (a: { id: string }, b: { id: string }) =>
  a.id.localeCompare(b.id, "en");
// The notes draw at one world size whatever the vault (the shared size chain,
// graph-visual-rules R6) and the camera frames the whole web, so a note's
// screen size goes as 1 / the frame's world size. A flat web at one scale grows
// its frame as √notes, while the default look's landing frame hardly grows
// below a few hundred notes (measured, 68 → 250 notes: ×1.13), so at one scale
// a 250-note vault drew its notes at 0.6 of the default look's size. The
// frame's world half-height is therefore set from the web's own frame (layout
// units, a sunflower step is 16): FRAME_HELD × radius ×
// min(1, max(∛(frame / FRAME_CUBE), (frame / FRAME_FULL)²)).
// - A small web's grows as the cube root, which lands the 68- and the
//   250-note vault at the default look's note size.
// - A big web's is held at FRAME_HELD, where the 2,000-note vault's bundles
//   were tuned (held to the radius, that vault framed at ≈ 0.84 of it).
// - Between, it eases from one to the other as the frame squared.
const FRAME_HELD = 0.835;
const FRAME_CUBE = 13200;
const FRAME_FULL = 900;
// A fan's collision radius in that 2,000-note vault (its notes reach ≈ 620,
// plus the 80 gap the fan sim was tuned with). The gap now grows with the fan
// and the charge with its area, so the sim settles any vault's fans in the
// same shape: a small vault's small fans side by side, not a fixed corridor
// apart with the empty corridor setting the frame.
const FAN_UNIT = 700;

/** Copy only topology into the worker; no note contents leave the graph. */
export function wovenInput(graph: VaultGraph, radius: number): WovenInput {
  return {
    radius,
    nodes: graph.mapNodes((id, attrs) => ({
      id,
      community: attrs.community ?? -1,
      degree: graph.degree(id),
    })),
    edges: graph.mapEdges((id, _attrs, source, target) => ({
      id,
      source,
      target,
    })),
  };
}

/** Route each real relationship once through an ordered community corridor. */
export function buildWovenLayout(input: WovenInput): WovenLayout {
  const radius = Math.max(1, input.radius);
  const ordered = [...input.nodes].sort(compare);
  const edges = [...input.edges].sort(compare);
  // Two levels. A fan is a clump of links (Louvain on the links alone, at a
  // low resolution, so a vault makes a few big fans), and every link between
  // two fans runs in one corridor: that is the bundling. Inside a fan each
  // cluster the graph colours (the legend row, the cluster name, a legend
  // focus) sits as its own sub-fan, whole, in the fan holding most of it.
  const topology = new Graph({ type: "undirected" });
  for (const node of ordered) topology.addNode(node.id);
  for (const edge of edges) topology.mergeEdge(edge.source, edge.target);
  const groups: Record<string, number> = topology.size
    ? louvain(topology, { randomWalk: false, resolution: 0.65 })
    : {};
  const linked = (id: string): number => groups[id] ?? -1;
  const votes = new Map<number, Map<number, number>>();
  for (const node of ordered) {
    if (node.degree === 0 || node.community < 0) continue;
    const tally = votes.get(node.community) ?? new Map<number, number>();
    tally.set(linked(node.id), (tally.get(linked(node.id)) ?? 0) + 1);
    votes.set(node.community, tally);
  }
  const fanOfCluster = new Map(
    [...votes].map(([community, tally]) => [
      community,
      [...tally].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0][0],
    ]),
  );
  // Unlinked notes share one fan (-1); a linked field star joins its links' fan.
  const fanOf = (node: WovenInput["nodes"][number]): number =>
    node.degree === 0
      ? -1
      : node.community < 0
        ? linked(node.id)
        : fanOfCluster.get(node.community)!;
  const subFans = new Map<string, typeof ordered>();
  for (const node of ordered) {
    const key = `${fanOf(node)}:${node.degree === 0 ? -1 : node.community}`;
    const members = subFans.get(key) ?? [];
    members.push(node);
    subFans.set(key, members);
  }
  // Each sub-fan: degree-ranked, hubs central, leaves spread around the bundle mouths.
  const local = new Map<string, Vector3>();
  const reach = new Map<string, number>();
  for (const [key, members] of subFans) {
    const community = Number(key.split(":")[1]);
    const ranked = [...members].sort(
      (a, b) => b.degree - a.degree || compare(a, b),
    );
    ranked.forEach((node, index) => {
      const angle = index * Math.PI * (3 - Math.sqrt(5)) + community * 0.83;
      const distance = Math.sqrt(index) * 16;
      local.set(
        node.id,
        new Vector3(
          Math.cos(angle) * distance,
          Math.sin(angle) * distance,
          Math.sin(angle * 1.3) * distance * 0.12,
        ),
      );
    });
    reach.set(key, Math.sqrt(ranked.length - 1) * 16);
  }
  // Pack each fan's sub-fans around its centre, a clear gap between colours.
  // 80 ticks of two collision passes leave no two sub-fans' notes overlapping
  // on the 2,000-note vault (60 do not), at a quarter of 200 × 3's cost.
  const subCenters = new Map<string, Vector3>();
  const fanReach = new Map<number, number>();
  const byFan = new Map<number, string[]>();
  for (const key of [...subFans.keys()].sort())
    byFan.set(Number(key.split(":")[0]), [
      ...(byFan.get(Number(key.split(":")[0])) ?? []),
      key,
    ]);
  for (const [fan, keys] of byFan) {
    const packed: Site[] = keys.map((id) => ({ id, radius: reach.get(id)! + 24 }));
    if (packed.length > 1)
      forceSimulation(packed)
        .stop()
        .force("collision", forceCollide<Site>().radius((site) => site.radius).iterations(2))
        .force("x", forceX(0).strength(0.08))
        .force("y", forceY(0).strength(0.08))
        .tick(80);
    let extent = 0;
    for (const site of packed) {
      const center = new Vector3(site.x ?? 0, site.y ?? 0, 0);
      subCenters.set(site.id, center);
      extent = Math.max(extent, center.length() + site.radius);
    }
    fanReach.set(fan, extent);
  }
  const fans = [...byFan.keys()].sort((a, b) => a - b);
  const sites: Site[] = fans.map((fan) => ({
    id: String(fan),
    radius: fanReach.get(fan)! * (FAN_UNIT / (FAN_UNIT - 80)),
  }));
  const fanOfNote = new Map(ordered.map((node) => [node.id, fanOf(node)]));
  const subFanOf = new Map(
    [...subFans].flatMap(([key, members]) => members.map((node) => [node.id, key] as const)),
  );
  const corridors = new Map<string, typeof edges>();
  for (const edge of edges) {
    const [a, b] = [fanOfNote.get(edge.source)!, fanOfNote.get(edge.target)!];
    // Between fans the corridor is the fans'; inside one, the sub-fans'.
    const pair =
      a !== b
        ? [String(a), String(b)].sort()
        : [subFanOf.get(edge.source)!, subFanOf.get(edge.target)!].sort();
    const key = JSON.stringify(pair);
    const bundle = corridors.get(key) ?? [];
    bundle.push(edge);
    corridors.set(key, bundle);
  }
  const links = [...corridors.keys()]
    .map((key) => {
      const [source, target] = JSON.parse(key) as [string, string];
      return { source, target };
    })
    .filter((edge) => edge.source !== edge.target && !edge.source.includes(":"));
  const reached = new Set(links.flatMap((link) => [link.source, link.target]));
  const sim = forceSimulation(sites)
    .stop()
    .force(
      "link",
      forceLink<Site, SimulationLinkDatum<Site>>(links)
        .id((node) => node.id)
        // Side by side: the collision radii keep the gap between them.
        .distance((link) => (link.source as Site).radius + (link.target as Site).radius)
        .strength(0.12),
    )
    .force("charge", forceManyBody<Site>().strength((site) => -900 * (site.radius / FAN_UNIT) ** 2))
    .force(
      "collision",
      forceCollide<Site>().radius((node) => node.radius),
    )
    .force("center", forceCenter())
    // A fan no corridor reaches (an unlinked component, the unlinked notes)
    // would drift to the edge and set the frame; this holds it near the web.
    // The fans a corridor reaches are held four times harder toward one axis,
    // so the web settles wide, as the frame is (≈ 1.6 : 1), instead of round
    // with empty bands either side; the parts no corridor reaches keep the
    // even hold, so they sit above and below it, not off its ends.
    .force("x", forceX(0).strength(0.06))
    .force("y", forceY<Site>(0).strength((site) => (reached.has(site.id) ? 0.25 : 0.06)));
  sim.tick(220);
  // Then turn the whole picture so its long axis runs across the screen (the
  // landing camera looks down z with x to the right): a web left upright was
  // framed by its height, with empty bands either side.
  const mass = sites.reduce((sum, site) => sum + site.radius ** 2, 0);
  const mx = sites.reduce((sum, site) => sum + site.x! * site.radius ** 2, 0) / mass;
  const my = sites.reduce((sum, site) => sum + site.y! * site.radius ** 2, 0) / mass;
  let [sxx, syy, sxy] = [0, 0, 0];
  for (const site of sites) {
    const w = site.radius ** 2;
    sxx += w * (site.x! - mx) ** 2;
    syy += w * (site.y! - my) ** 2;
    sxy += w * (site.x! - mx) * (site.y! - my);
  }
  const turn = -0.5 * Math.atan2(2 * sxy, sxx - syy);
  const centers = new Map(
    sites.map((site) => [Number(site.id), new Vector3(site.x!, site.y!, 0)]),
  );
  const positions = new Map<string, Vector3>();
  for (const node of ordered) {
    const key = subFanOf.get(node.id)!;
    positions.set(
      node.id,
      centers.get(fanOfNote.get(node.id)!)!.clone().add(subCenters.get(key)!).add(local.get(node.id)!),
    );
  }
  const up = new Vector3(0, 0, 1);
  for (const point of [...centers.values(), ...subCenters.values(), ...positions.values()])
    point.applyAxisAngle(up, turn);
  const extent = Math.max(
    120,
    ...[...positions.values()].map((point) => point.length()),
  );
  // The landing frame's half-height this web needs: its notes' span, the width
  // taken at the frame's ≈ 1.6 : 1.
  const span = (axis: "x" | "y") =>
    Math.max(...[...positions.values()].map((point) => point[axis])) -
    Math.min(...[...positions.values()].map((point) => point[axis]));
  const frame = Math.max(60, Math.max(span("x") / 1.6, span("y")) / 2);
  const held = Math.min(1, Math.max(Math.cbrt(frame / FRAME_CUBE), (frame / FRAME_FULL) ** 2));
  const scale = (radius * FRAME_HELD * held) / frame;
  // This layout's own radius: every proportion below follows it.
  const world = extent * scale;
  positions.forEach((point) => point.multiplyScalar(scale));
  centers.forEach((point) => point.multiplyScalar(scale));
  const subCenter = (key: string): Vector3 =>
    centers.get(Number(key.split(":")[0]))!.clone().addScaledVector(subCenters.get(key)!, scale);
  const shapes = new Map<string, SculptedNode>();
  for (const node of ordered) {
    const width = Math.min(
      scale * 5,
      world * (0.0035 + Math.min(0.005, Math.sqrt(node.degree) * 0.001)),
    );
    shapes.set(node.id, {
      width,
      depth: width,
      height: width,
      normal: { x: 0, y: 0, z: 1 },
    });
  }
  const routes: WovenLayout["routes"] = [];
  for (const bundle of corridors.values()) {
    const first = bundle[0];
    const [groupA, groupB] = [
      fanOfNote.get(first.source)!,
      fanOfNote.get(first.target)!,
    ].sort((x, y) => x - y);
    const a = centers.get(groupA)!;
    const b = centers.get(groupB)!;
    const axis = b.clone().sub(a);
    const perpendicular = new Vector3(-axis.y, axis.x, 0).normalize();
    bundle.forEach((edge, index) => {
      const start = positions.get(edge.source)!;
      const end = positions.get(edge.target)!;
      const lane =
        (index - (bundle.length - 1) / 2) *
        Math.min(world * 0.0035, (world * 0.11) / bundle.length);
      let controls: Vector3[];
      if (groupA !== groupB) {
        const bend = axis.length() * 0.22;
        const middle = a
          .clone()
          .lerp(b, 0.5)
          .addScaledVector(perpendicular, bend + lane);
        middle.z = world * 0.045 * Math.sin(Number(groupA) + Number(groupB));
        const neckA = a
          .clone()
          .lerp(b, 0.18)
          .addScaledVector(perpendicular, bend * 0.55 + lane);
        const neckB = a
          .clone()
          .lerp(b, 0.82)
          .addScaledVector(perpendicular, bend * 0.55 + lane);
        controls =
          fanOfNote.get(edge.source) === groupA
            ? [start, neckA, middle, neckB, end]
            : [start, neckB, middle, neckA, end];
      } else {
        const delta = end.clone().sub(start);
        const normal = new Vector3(-delta.y, delta.x, 0).normalize();
        // Inside one colour the strand bows toward that sub-fan's own centre,
        // so the cluster reads as one shape; between colours, the fan's.
        const own = subFanOf.get(edge.source)!;
        const pull = own === subFanOf.get(edge.target) ? subCenter(own) : a;
        const middle = start
          .clone()
          .lerp(end, 0.5)
          .lerp(pull, 0.35)
          .addScaledVector(normal, delta.length() * 0.22 + lane * 0.2);
        middle.z += world * 0.018;
        controls = [start, middle, end];
      }
      const samples = new CatmullRomCurve3(
        controls,
        false,
        "centripetal",
      ).getPoints(32);
      const points = new Float32Array(
        samples.flatMap((point) => [point.x, point.y, point.z]),
      );
      routes.push({ ...edge, points });
    });
  }
  const min = new Vector3(Infinity, Infinity, Infinity);
  const max = new Vector3(-Infinity, -Infinity, -Infinity);
  positions.forEach((point, id) => {
    const pad = new Vector3().setScalar(shapes.get(id)!.width * 3);
    min.min(point.clone().sub(pad));
    max.max(point.clone().add(pad));
  });
  for (const route of routes)
    for (let index = 0; index < route.points.length; index += 3) {
      const point = new Vector3().fromArray(route.points, index);
      min.min(point);
      max.max(point);
    }
  if (!positions.size) {
    min.set(-1, -1, -1);
    max.set(1, 1, 1);
  }
  const plain = (point: Vector3) => ({ x: point.x, y: point.y, z: point.z });
  return {
    kind: "woven",
    radius: world,
    nodes: shapes,
    positions: new Map([...positions].map(([id, point]) => [id, plain(point)])),
    bounds: { min: plain(min), max: plain(max) },
    routes,
  };
}
