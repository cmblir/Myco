import * as THREE from "three";

const BOX_EDGES: [THREE.Vector3, THREE.Vector3][] = [];
for (let axis = 0; axis < 3; axis++) {
  for (const a of [-0.5, 0.5]) for (const b of [-0.5, 0.5]) {
    const start = new THREE.Vector3().setComponent(axis, -0.5)
      .setComponent((axis + 1) % 3, a).setComponent((axis + 2) % 3, b);
    BOX_EDGES.push([start, start.clone().setComponent(axis, 0.5)]);
  }
}
const DASHES = [[0.05, 0.25], [0.4, 0.6], [0.75, 0.95]] as const;
const DOTS = [[0.08, 0.11], [0.34, 0.37], [0.6, 0.63], [0.86, 0.89]] as const;
const SOLID = [[0, 1]] as const;
const COLORS = ["#000000", "#b97712", "#93939e", "#b97712", "#21915b", "#f1f0e8", "#367cd6"]
  .map((color) => new THREE.Color(color));

/** Non-interactive note frames preserve the graph's shape-based status channel. */
export class SculptedIndicators {
  readonly group = new THREE.Group();
  private readonly geometry = new THREE.BufferGeometry();
  private readonly material = new THREE.LineBasicMaterial({ vertexColors: true, depthWrite: false });
  private readonly lines = new THREE.LineSegments(this.geometry, this.material);
  private readonly matrix = new THREE.Matrix4();
  private readonly point = new THREE.Vector3();
  private readonly selectionBorder = new THREE.Color("#273449");
  private readonly searchBorder = new THREE.Color("#b7d2ff");
  private disposed = false;

  constructor() {
    this.group.name = "sculpted-note-indicators";
    this.lines.frustumCulled = false;
    this.group.add(this.lines);
    this.geometry.setDrawRange(0, 0);
  }

  /** Follow each actual note's transform; hidden notes contribute no segments. */
  sync(nodes: THREE.InstancedMesh, attributes: THREE.BufferGeometry, frameScale = 1): void {
    if (this.disposed) return;
    const rings = attributes.getAttribute("a_ring");
    const alphas = attributes.getAttribute("a_alpha");
    if (!rings || !alphas) {
      this.geometry.setDrawRange(0, 0);
      return;
    }
    const count = Math.min(nodes.count, rings.count, alphas.count);
    let positions = this.geometry.getAttribute("position") as THREE.BufferAttribute | undefined;
    const capacity = Math.max(24, count * 96);
    if (!positions || positions.count < capacity) {
      // Reserve the densest frame once; question changes only alter drawRange.
      // A replacement must release the previous GPU attributes before detaching them.
      if (positions) this.geometry.dispose();
      positions = new THREE.BufferAttribute(new Float32Array(capacity * 3), 3).setUsage(THREE.DynamicDrawUsage);
      this.geometry.setAttribute("position", positions);
      this.geometry.setAttribute("color", new THREE.BufferAttribute(new Float32Array(capacity * 3), 3).setUsage(THREE.DynamicDrawUsage));
    }
    const colors = this.geometry.getAttribute("color") as THREE.BufferAttribute;
    let vertex = 0;
    const frame = (ring: number, extent: number, color: THREE.Color): void => {
      const segments = ring === 2 ? DOTS : ring <= 3 ? DASHES : SOLID;
      for (const [start, end] of BOX_EDGES) for (const segment of segments) for (const fraction of segment) {
        this.point.copy(start).lerp(end, fraction).multiplyScalar(extent * frameScale).applyMatrix4(this.matrix);
        positions.setXYZ(vertex, this.point.x, this.point.y, this.point.z);
        colors.setXYZ(vertex++, color.r, color.g, color.b);
      }
    };
    for (let index = 0; index < count; index++) {
      const ring = rings.getX(index);
      if (alphas.getX(index) <= 0 || !Number.isInteger(ring) || ring < 1 || ring > 6) continue;
      nodes.getMatrixAt(index, this.matrix);
      frame(ring, 1.15, COLORS[ring]);
      // Two solid contours stay visibly stronger without unsupported line widths.
      if (ring >= 5) frame(ring, 1.23, ring === 5 ? this.selectionBorder : this.searchBorder);
    }
    positions.needsUpdate = true;
    colors.needsUpdate = true;
    this.geometry.setDrawRange(0, vertex);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.geometry.dispose();
    this.material.dispose();
    this.group.clear();
    this.group.removeFromParent();
  }
}
