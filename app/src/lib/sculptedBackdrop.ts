import * as THREE from "three";
import {
  sampleRibbon,
  sampleTerrain,
  type CityLayout,
  type RibbonLayout,
  type SculptedLayoutResult,
  type SculptedVector,
  type TerrainLayout,
} from "./sculptedLayouts";
import { addContactShadow, addLines, addPlinth, addSurface, appendPair, surfaceGeometry, triangleIndices } from "./sculptedSurfaceGeometry";

export interface SculptedBackdrop {
  group: THREE.Group;
  dispose(): void;
}

function terrainBackdrop(layout: TerrainLayout, group: THREE.Group): void {
  const columns = 112;
  const rows = 84;
  const positions: number[] = [];
  const colors: number[] = [];
  const heights: number[] = [];
  const low = new THREE.Color("#c7c2a7");
  const mid = new THREE.Color("#c6c6ae");
  const high = new THREE.Color("#ece2c8");
  const color = new THREE.Color();
  for (let row = 0; row <= rows; row++) for (let column = 0; column <= columns; column++) {
    const x = (column / columns - 0.5) * layout.extent.width;
    const y = (row / rows - 0.5) * layout.extent.depth;
    const z = sampleTerrain(layout, x, y);
    const elevation = Math.max(0, Math.min(1, z / (layout.radius * 0.58)));
    color.copy(low).lerp(mid, Math.min(1, elevation * 2.5));
    color.lerp(high, Math.max(0, elevation - 0.3) / 0.7);
    positions.push(x, y, z);
    heights.push(z);
    colors.push(color.r, color.g, color.b);
  }
  const indices = triangleIndices(columns, rows);
  addSurface(group, surfaceGeometry(positions, indices, colors), new THREE.MeshStandardMaterial({
    vertexColors: true, side: THREE.DoubleSide, roughness: 0.94, metalness: 0,
  }), "terrain-surface");

  // A major line every fourth elevation band makes the shape legible at a distance.
  const contours: number[][] = [[], []];
  const step = layout.radius * 0.014;
  const minHeight = Math.min(...heights);
  const maxHeight = Math.max(...heights);
  for (let band = Math.ceil(minHeight / step); band * step < maxHeight; band++) {
    const level = band * step;
    for (let triangle = 0; triangle < indices.length; triangle += 3) {
      const hits: SculptedVector[] = [];
      for (let edge = 0; edge < 3; edge++) {
        const a = indices[triangle + edge];
        const b = indices[triangle + (edge + 1) % 3];
        if ((heights[a] < level) === (heights[b] < level)) continue;
        const fraction = (level - heights[a]) / (heights[b] - heights[a]);
        hits.push({
          x: positions[a * 3] + (positions[b * 3] - positions[a * 3]) * fraction,
          y: positions[a * 3 + 1] + (positions[b * 3 + 1] - positions[a * 3 + 1]) * fraction,
          z: level + layout.radius * 0.001,
        });
      }
      if (hits.length === 2) appendPair(contours[band % 4 === 0 ? 1 : 0], hits[0], hits[1]);
    }
  }
  addLines(group, contours[0], 0x77745d, 0.12, "terrain-contours");
  addLines(group, contours[1], 0x565440, 0.26, "terrain-major-contours");
  terrainCutaway(layout, group);
}

function terrainCutaway(layout: TerrainLayout, group: THREE.Group): void {
  const r = layout.radius;
  const bottom = -r * 0.036;
  const corners = [
    [-layout.extent.width / 2, -layout.extent.depth / 2],
    [layout.extent.width / 2, -layout.extent.depth / 2],
    [layout.extent.width / 2, layout.extent.depth / 2],
    [-layout.extent.width / 2, layout.extent.depth / 2],
  ];
  const boundary: number[] = [];
  const positions: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];
  const strata: number[] = [];
  const earth = new THREE.Color("#b6a88b");
  const chalk = new THREE.Color("#d2c4a4");
  const color = new THREE.Color();
  const segments = 80;
  const layers = 10;
  for (let edge = 0; edge < 4; edge++) {
    const start = corners[edge];
    const end = corners[(edge + 1) % 4];
    const top = Array.from({ length: segments + 1 }, (_, i) => {
      const x = start[0] + (end[0] - start[0]) * i / segments;
      const y = start[1] + (end[1] - start[1]) * i / segments;
      return { x, y, z: sampleTerrain(layout, x, y) };
    });
    const offset = positions.length / 3;
    for (let layer = 0; layer <= layers; layer++) for (const point of top) {
      const fraction = layer / layers;
      positions.push(point.x, point.y, bottom + (point.z - bottom) * fraction);
      color.copy(earth).lerp(chalk, layer % 2 === 0 ? 0.38 : 0.68).multiplyScalar(0.8 + fraction * 0.2);
      colors.push(color.r, color.g, color.b);
    }
    indices.push(...triangleIndices(segments, layers).map((index) => index + offset));
    for (let i = 0; i < segments; i++) {
      appendPair(boundary, top[i], top[i + 1]);
      for (const fraction of [0.18, 0.38, 0.62, 0.82]) {
        const point = (index: number): SculptedVector => ({ ...top[index], z: bottom + (top[index].z - bottom) * fraction });
        appendPair(strata, point(i), point(i + 1));
      }
    }
  }
  addSurface(group, surfaceGeometry(positions, indices, colors), new THREE.MeshStandardMaterial({
    vertexColors: true, side: THREE.DoubleSide, roughness: 0.98,
  }), "terrain-cutaway");
  addLines(group, boundary, 0x796d53, 0.55, "terrain-boundary");
  addLines(group, strata, 0x8b7b5f, 0.24, "terrain-strata");
  addPlinth(group, layout.extent.width + r * 0.016, layout.extent.depth + r * 0.016, bottom - r * 0.025, r * 0.025, r * 0.004, 0xd7ccb4, "terrain-plinth");
  addContactShadow(group, layout.extent.width, layout.extent.depth, bottom - r * 0.026, 0.17);
}

function ribbonBackdrop(layout: RibbonLayout, group: THREE.Group): void {
  const columns = 256;
  const rows = 24;
  const positions: number[] = [];
  const colors: number[] = [];
  const uvs: number[] = [];
  const graphite = new THREE.Color("#182534");
  const silver = new THREE.Color("#354557");
  const color = new THREE.Color();
  for (let row = 0; row <= rows; row++) for (let column = 0; column <= columns; column++) {
    const u = column / columns;
    const v = row / rows * 2 - 1;
    const { position } = sampleRibbon(layout, u, v);
    positions.push(position.x, position.y, position.z);
    color.copy(graphite).lerp(silver, 0.18 + 0.12 * Math.sin(u * Math.PI * 2) + Math.pow(Math.abs(v), 4) * 0.2);
    colors.push(color.r, color.g, color.b);
    uvs.push(u, row / rows);
  }
  const shape = surfaceGeometry(positions, triangleIndices(columns, rows), colors);
  shape.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  shape.computeTangents();
  addSurface(group, shape, new THREE.MeshPhysicalMaterial({
    vertexColors: true, side: THREE.DoubleSide, roughness: 0.72, metalness: 0.12,
    clearcoat: 0.08, clearcoatRoughness: 0.32, anisotropy: 0.65,
    sheen: 0.16, sheenColor: new THREE.Color("#7788af"), sheenRoughness: 0.6,
    iridescence: 0.04, iridescenceThicknessRange: [160, 260],
  }), "ribbon-surface");
  const edges: number[] = [];
  const wallPositions: number[] = [];
  const wallIndices: number[] = [];
  const boundary = [
    ...Array.from({ length: columns + 1 }, (_, i) => [i / columns, -1]),
    ...Array.from({ length: rows }, (_, i) => [1, -1 + (i + 1) / rows * 2]),
    ...Array.from({ length: columns }, (_, i) => [1 - (i + 1) / columns, 1]),
    ...Array.from({ length: rows }, (_, i) => [0, 1 - (i + 1) / rows * 2]),
  ];
  for (let i = 0; i < boundary.length; i++) {
    const [u, v] = boundary[i];
    const { position, normal } = sampleRibbon(layout, u, v);
    const thickness = layout.radius * 0.004;
    wallPositions.push(position.x, position.y, position.z, position.x - normal.x * thickness, position.y - normal.y * thickness, position.z - normal.z * thickness);
    if (i < boundary.length - 1) {
      wallIndices.push(i * 2, i * 2 + 1, i * 2 + 2, i * 2 + 1, i * 2 + 3, i * 2 + 2);
      appendPair(edges, position, sampleRibbon(layout, boundary[i + 1][0], boundary[i + 1][1]).position);
    }
  }
  addSurface(group, surfaceGeometry(wallPositions, wallIndices), new THREE.MeshStandardMaterial({ color: 0x9caeaf, metalness: 0.5, roughness: 0.3, side: THREE.DoubleSide }), "ribbon-edge-thickness");
  addLines(group, edges, 0x8197aa, 0.24, "ribbon-selvedge");
}

function cityBackdrop(layout: CityLayout, group: THREE.Group): void {
  const r = layout.radius;
  const shape = new THREE.BoxGeometry(1, 1, 1);
  const material = new THREE.MeshStandardMaterial({ color: 0x253244, roughness: 0.9, metalness: 0.08 });
  const floors = new THREE.InstancedMesh(shape, material, layout.districts.length);
  floors.name = "city-district-floors";
  const transform = new THREE.Matrix4();
  const scale = new THREE.Vector3();
  const position = new THREE.Vector3();
  const rotation = new THREE.Quaternion();
  const outlines: number[] = [];
  const lanes: number[] = [];
  const roads: number[] = [];
  const roadIndices: number[] = [];
  const bounds = new THREE.Box2();
  const road = (x0: number, y0: number, x1: number, y1: number): void => {
    const offset = roads.length / 3;
    roads.push(x0, y0, r * 0.0008, x1, y0, r * 0.0008, x1, y1, r * 0.0008, x0, y1, r * 0.0008);
    roadIndices.push(offset, offset + 1, offset + 2, offset, offset + 2, offset + 3);
  };
  layout.districts.forEach((district, index) => {
    position.set(district.x, district.y, -r * 0.006);
    scale.set(district.width, district.depth, r * 0.012);
    transform.compose(position, rotation, scale);
    floors.setMatrixAt(index, transform);
    const z = r * 0.001;
    const x0 = district.x - district.width / 2;
    const x1 = district.x + district.width / 2;
    const y0 = district.y - district.depth / 2;
    const y1 = district.y + district.depth / 2;
    bounds.expandByPoint(new THREE.Vector2(x0, y0));
    bounds.expandByPoint(new THREE.Vector2(x1, y1));
    const corners = [{ x: x0, y: y0, z }, { x: x1, y: y0, z }, { x: x1, y: y1, z }, { x: x0, y: y1, z }];
    for (let i = 0; i < 4; i++) appendPair(outlines, corners[i], corners[(i + 1) % 4]);
    for (const x of district.streetX ?? []) {
      const width = district.streetWidthX ?? r * 0.008;
      road(x - width / 2, y0, x + width / 2, y1);
      appendPair(lanes, { x, y: y0, z }, { x, y: y1, z });
    }
    for (const y of district.streetY ?? []) {
      const width = district.streetWidthY ?? r * 0.008;
      road(x0, y - width / 2, x1, y + width / 2);
      appendPair(lanes, { x: x0, y, z }, { x: x1, y, z });
    }
  });
  floors.instanceMatrix.needsUpdate = true;
  floors.computeBoundingSphere();
  group.add(floors);
  addLines(group, outlines, 0x8a8c80, 0.36, "city-district-boundaries");
  if (roads.length > 0) addSurface(group, surfaceGeometry(roads, roadIndices), new THREE.MeshStandardMaterial({ color: 0x101a29, roughness: 0.86 }), "city-local-streets");
  addLines(group, lanes, 0x958d71, 0.25, "city-street-centerlines");
  const extent = bounds.getSize(new THREE.Vector2());
  const center = bounds.getCenter(new THREE.Vector2());
  const plinth = addPlinth(group, extent.x + r * 0.06, extent.y + r * 0.06, -r * 0.052, r * 0.035, r * 0.006, 0x152131, "city-plinth");
  plinth.position.set(center.x, center.y, 0);
  const trim: number[] = [];
  const x = extent.x / 2 + r * 0.021;
  const y = extent.y / 2 + r * 0.021;
  const z = -r * 0.014;
  const corners = [{ x: center.x - x, y: center.y - y, z }, { x: center.x + x, y: center.y - y, z }, { x: center.x + x, y: center.y + y, z }, { x: center.x - x, y: center.y + y, z }];
  for (let i = 0; i < 4; i++) appendPair(trim, corners[i], corners[(i + 1) % 4]);
  addLines(group, trim, 0xa0a294, 0.4, "city-plinth-inlay");
}

/** Owns only background geometry; every interactive note remains a real graph node. */
export function createSculptedBackdrop(layout: SculptedLayoutResult): SculptedBackdrop {
  const group = new THREE.Group();
  group.name = `sculpted-${layout.kind}-backdrop`;
  if (layout.nodes.size > 0) {
    if (layout.kind === "terrain") terrainBackdrop(layout, group);
    else if (layout.kind === "ribbon") ribbonBackdrop(layout, group);
    else cityBackdrop(layout, group);
  }
  let disposed = false;
  return {
    group,
    dispose(): void {
      if (disposed) return;
      disposed = true;
      const geometries = new Set<THREE.BufferGeometry>();
      const materials = new Set<THREE.Material>();
      group.traverse((object) => {
        if (object instanceof THREE.Mesh || object instanceof THREE.LineSegments) {
          geometries.add(object.geometry);
          for (const material of Array.isArray(object.material) ? object.material : [object.material]) materials.add(material);
          if (object instanceof THREE.InstancedMesh) object.dispose();
        }
      });
      for (const shape of geometries) shape.dispose();
      for (const material of materials) material.dispose();
      group.clear();
      group.removeFromParent();
    },
  };
}
