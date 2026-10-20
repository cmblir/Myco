import * as THREE from "three";
import type { VaultGraph } from "./graphData";
import type { GraphSettings } from "./graphSettings";
import { createSculptedBackdrop } from "./sculptedBackdrop";
import { sampleTerrain, type SculptedLayoutResult } from "./sculptedLayouts";
import { SculptedIndicators } from "./sculptedIndicators";
import { createSculptedNoteMaterial } from "./sculptedMaterials";

const LINK_STEPS = 10;

/** Solid note primitives and explicit links over the three sculpted layouts. */
export class SculptedGraphLayer {
  readonly scene = new THREE.Scene();
  readonly nodes: THREE.InstancedMesh;
  private readonly ids: string[];
  private readonly index: Map<string, number>;
  private readonly pairs: [string, string][];
  private readonly backdrop: ReturnType<typeof createSculptedBackdrop>;
  private readonly geometry = new THREE.BoxGeometry(1, 1, 1);
  private readonly material: THREE.MeshStandardMaterial;
  private readonly linkGeometry = new THREE.BufferGeometry();
  private readonly linkMaterial = new THREE.LineBasicMaterial({
    vertexColors: true, transparent: true, depthWrite: false, depthTest: false,
  });
  private readonly links: THREE.LineSegments;
  private readonly focusGeometry = new THREE.BufferGeometry();
  private readonly focusMaterial = new THREE.LineBasicMaterial({
    color: 0xe7bf7b, transparent: true, depthTest: false, depthWrite: false,
  });
  private readonly focusLines = new THREE.LineSegments(this.focusGeometry, this.focusMaterial);
  private readonly pathGeometry = new THREE.BufferGeometry();
  private readonly pathMaterial = new THREE.LineBasicMaterial({ color: 0xe2a43d, depthTest: false });
  private readonly pathLines = new THREE.LineSegments(this.pathGeometry, this.pathMaterial);
  private readonly outline = new THREE.LineSegments(
    new THREE.EdgesGeometry(this.geometry),
    new THREE.LineBasicMaterial({ color: 0xe3a943, depthTest: false }),
  );
  private readonly raycaster = new THREE.Raycaster();
  private readonly matrix = new THREE.Matrix4();
  private readonly position = new THREE.Vector3();
  private readonly scale = new THREE.Vector3();
  private readonly normal = new THREE.Vector3();
  private readonly rotation = new THREE.Quaternion();
  private readonly up = new THREE.Vector3(0, 0, 1);
  private readonly color = new THREE.Color();
  private readonly background: THREE.Color;
  private readonly pickTargets: THREE.Object3D[];
  private readonly indicators = new SculptedIndicators();
  private readonly anchors: THREE.Vector3[];
  private readonly movedAnchors: Uint8Array;
  private readonly visibleNodes: Uint8Array;
  private hasLinkPositions = false;
  private readonly noteTint: THREE.Color;

  constructor(private readonly graph: VaultGraph, readonly layout: SculptedLayoutResult) {
    this.ids = graph.nodes();
    this.index = new Map(this.ids.map((id, index) => [id, index]));
    this.pairs = graph.mapEdges((_edge, _attrs, source, target) => [source, target]);
    this.anchors = this.ids.map(() => new THREE.Vector3());
    this.movedAnchors = new Uint8Array(this.ids.length);
    this.visibleNodes = new Uint8Array(this.ids.length);
    this.material = createSculptedNoteMaterial(layout.kind, layout.radius);
    this.noteTint = new THREE.Color(layout.kind === "terrain" ? "#425e58" : layout.kind === "city" ? "#829cad" : "#a9c6d8");
    this.background = new THREE.Color(layout.kind === "terrain" ? "#eee9df" : layout.kind === "city" ? "#0a1220" : "#080e19");
    this.scene.background = this.background;
    this.backdrop = createSculptedBackdrop(layout);
    this.scene.add(this.backdrop.group);
    this.nodes = new THREE.InstancedMesh(this.geometry, this.material, Math.max(1, this.ids.length));
    this.nodes.count = this.ids.length;
    this.nodes.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.nodes.frustumCulled = false;
    this.scene.add(this.nodes);
    this.scene.add(this.indicators.group);
    this.outline.visible = false;
    this.outline.matrixAutoUpdate = false;
    this.outline.renderOrder = 10;
    this.scene.add(this.outline);
    const floats = this.pairs.length * LINK_STEPS * 6;
    this.linkGeometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(floats), 3));
    this.linkGeometry.setAttribute("color", new THREE.BufferAttribute(new Float32Array(this.pairs.length * LINK_STEPS * 8), 4));
    this.focusGeometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(floats), 3));
    this.focusGeometry.setDrawRange(0, 0);
    this.focusLines.name = "selected-relationships";
    this.focusLines.frustumCulled = false;
    this.focusLines.renderOrder = 7;
    this.scene.add(this.focusLines);
    this.pathGeometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(floats), 3));
    this.pathGeometry.setDrawRange(0, 0);
    this.links = new THREE.LineSegments(this.linkGeometry, this.linkMaterial);
    this.links.frustumCulled = false;
    this.scene.add(this.links);
    this.pathLines.frustumCulled = false;
    this.pathLines.renderOrder = 8;
    this.scene.add(this.pathLines);
    const ambient = new THREE.HemisphereLight(0xe3edff, 0x33313c, layout.kind === "terrain" ? 1.4 : 1.15);
    ambient.position.set(0, 0, layout.radius);
    this.scene.add(ambient);
    const key = new THREE.DirectionalLight(0xffead4, 3.1);
    key.position.set(-layout.radius, -layout.radius, layout.radius * 2);
    this.scene.add(key);
    const fill = new THREE.DirectionalLight(0x87b8ee, 1.35);
    fill.position.set(layout.radius, layout.radius, layout.radius);
    this.scene.add(fill);
    this.pickTargets = [this.nodes];
    this.backdrop.group.traverse((object) => {
      if (object instanceof THREE.Mesh) this.pickTargets.push(object);
    });
  }

  /** Apply the existing graph's question, focus, search, and hidden-note state. */
  sync(attributes: THREE.BufferGeometry, settings: GraphSettings, selected: string | null, path: readonly string[] | null = null): void {
    const colors = attributes.getAttribute("a_color");
    const alphas = attributes.getAttribute("a_alpha");
    const sizes = attributes.getAttribute("a_size");
    const hits = attributes.getAttribute("a_hit");
    this.outline.visible = false;
    const neighbors = selected && this.graph.hasNode(selected) ? new Set(this.graph.neighbors(selected)) : null;
    const mono = settings.nodeColor === "white" || settings.nodeColor === "black" ||
      (settings.nodeColor === "auto" && this.ids.length < settings.monoBelow);
    this.ids.forEach((id, index) => {
      const node = this.graph.getNodeAttributes(id);
      const shape = this.layout.nodes.get(id);
      if (!shape) return;
      const alpha = alphas.getX(index);
      const ratio = settings.nodeSize * Math.min(2.2, Math.max(0.45, sizes.getX(index) / Math.max(0.01, node.size)));
      this.position.set(node.x, node.y, node.z);
      this.normal.set(shape.normal.x, shape.normal.y, shape.normal.z).normalize();
      this.rotation.setFromUnitVectors(this.up, this.normal);
      this.scale.set(shape.width, shape.depth, shape.height).multiplyScalar(alpha > 0 ? ratio : 0);
      if (this.layout.kind === "city") {
        // Lots occupy 64% of their grid cell; preserve the streets at large sizes.
        const footprint = alpha > 0 ? Math.min(ratio, 1.4) : 0;
        this.scale.x = shape.width * footprint;
        this.scale.y = shape.depth * footprint;
        this.position.z += shape.height * (ratio - 1) / 2;
      }
      this.matrix.compose(this.position, this.rotation, this.scale);
      this.nodes.setMatrixAt(index, this.matrix);
      this.position.addScaledVector(this.normal, this.scale.z / 2);
      const isVisible = alpha > 0 ? 1 : 0;
      this.movedAnchors[index] = !this.anchors[index].equals(this.position) || this.visibleNodes[index] !== isVisible ? 1 : 0;
      this.anchors[index].copy(this.position);
      this.visibleNodes[index] = isVisible;
      this.color.setRGB(colors.getX(index), colors.getY(index), colors.getZ(index));
      if (mono) this.color.set(settings.nodeColor === "black" || this.layout.kind === "terrain" ? "#283d41" : "#e8e5df");
      else {
        this.color.lerp(this.noteTint, this.layout.kind === "terrain" ? 0.12 : 0.16);
        if (this.layout.kind === "terrain") this.color.multiplyScalar(0.72);
      }
      this.color.setRGB(
        Math.pow(this.color.r, settings.nodeColorDepth),
        Math.pow(this.color.g, settings.nodeColorDepth),
        Math.pow(this.color.b, settings.nodeColorDepth),
      );
      this.color.lerp(this.background, 1 - Math.sqrt(Math.min(1, alpha)));
      if (hits.getX(index) > 0) this.color.lerp(new THREE.Color("#efc568"), 0.5);
      if (selected && id !== selected && !neighbors?.has(id)) this.color.lerp(this.background, 0.65);
      this.nodes.setColorAt(index, this.color);
      if (id === selected && alpha > 0) {
        this.outline.matrix.copy(this.matrix).scale(new THREE.Vector3(1.12, 1.12, 1.04));
        this.outline.visible = true;
      }
    });
    this.nodes.instanceMatrix.needsUpdate = true;
    if (this.nodes.instanceColor) this.nodes.instanceColor.needsUpdate = true;
    this.nodes.computeBoundingSphere();
    this.indicators.sync(this.nodes, attributes);
    this.writeLinks(attributes, settings, selected, path);
  }

  private writeLinks(attributes: THREE.BufferGeometry, settings: GraphSettings, selected: string | null, path: readonly string[] | null): void {
    const positions = this.linkGeometry.getAttribute("position") as THREE.BufferAttribute;
    const colors = this.linkGeometry.getAttribute("color") as THREE.BufferAttribute;
    const alphas = attributes.getAttribute("a_alpha");
    const neutral = new THREE.Color(this.layout.kind === "terrain" ? "#244a48" : "#9ac6e0");
    const accent = new THREE.Color(this.layout.kind === "terrain" ? "#a15326" : "#e7bf7b");
    // Preserve every edge, but keep its accumulated ink bounded as vaults grow.
    const density = Math.pow(Math.min(1, 96 / Math.max(1, this.pairs.length)), 0.75);
    const pathEdges = new Set<string>();
    for (let i = 1; i < (path?.length ?? 0); i++) {
      pathEdges.add(JSON.stringify([path![i - 1], path![i]]));
      pathEdges.add(JSON.stringify([path![i], path![i - 1]]));
    }
    const pathPositions: number[] = [];
    const focusPositions: number[] = [];
    let hasMovedLinks = false;
    this.linkMaterial.opacity = 1 - Math.exp(-Math.max(0, settings.linkThickness) * 1.35);
    this.focusMaterial.opacity = this.linkMaterial.opacity;
    this.focusMaterial.color.copy(accent);
    this.pairs.forEach(([source, target], edgeIndex) => {
      const sourceIndex = this.index.get(source)!;
      const targetIndex = this.index.get(target)!;
      // Selection and color changes must not resample every terrain ridge.
      const shouldMove = !this.hasLinkPositions || this.movedAnchors[sourceIndex] > 0 || this.movedAnchors[targetIndex] > 0;
      hasMovedLinks ||= shouldMove;
      const start = this.anchors[sourceIndex];
      const end = this.anchors[targetIndex];
      const sourceNode = this.graph.getNodeAttributes(source);
      const targetNode = this.graph.getNodeAttributes(target);
      const alpha = Math.min(alphas.getX(sourceIndex), alphas.getX(targetIndex));
      const distance = Math.hypot(end.x - start.x, end.y - start.y, end.z - start.z);
      const isPath = pathEdges.has(JSON.stringify([source, target]));
      const isIncident = source === selected || target === selected;
      const visibility = alpha * (isIncident ? 0.92 : (0.025 + 0.48 * density) * (selected ? 0.18 : 1));
      this.color.copy(neutral);
      if (settings.edgeTint === "community") this.color.lerp(new THREE.Color(sourceNode.color), 0.55);
      if (isIncident) this.color.copy(accent);
      for (let segment = 0; segment < LINK_STEPS; segment++) {
        for (let endpoint = 0; endpoint < 2; endpoint++) {
          const vertex = (edgeIndex * LINK_STEPS + segment) * 2 + endpoint;
          if (shouldMove) {
            const t = (segment + endpoint) / LINK_STEPS;
            let x = start.x + (end.x - start.x) * t;
            let y = start.y + (end.y - start.y) * t;
            let z = start.z + (end.z - start.z) * t;
            if (this.layout.kind === "terrain") {
              z = Math.max(z, sampleTerrain(this.layout, x, y)) + this.layout.radius * 0.006;
              z += Math.sin(Math.PI * t) * Math.min(this.layout.radius * 0.05, distance * 0.08);
            } else if (this.layout.kind === "city") {
              // Orthogonal paths keep the architecture distinct from curved star links.
              const height = Math.max(start.z, end.z) + this.layout.radius *
                (sourceNode.community === targetNode.community ? 0.025 : 0.06);
              if (t < 0.2) { x = start.x; y = start.y; z = start.z + (height - start.z) * t / 0.2; }
              else if (t > 0.8) { x = end.x; y = end.y; z = height + (end.z - height) * (t - 0.8) / 0.2; }
              else {
                const along = (t - 0.2) / 0.6;
                x = start.x + (end.x - start.x) * Math.min(1, along * 2);
                y = start.y + (end.y - start.y) * Math.max(0, along * 2 - 1);
                z = height;
              }
            } else {
              z += Math.sin(Math.PI * t) * Math.min(this.layout.radius * 0.12, distance * 0.15);
            }
            positions.setXYZ(vertex, alpha > 0 ? x : 0, alpha > 0 ? y : 0, alpha > 0 ? z : 0);
          }
          colors.setXYZW(vertex, this.color.r, this.color.g, this.color.b, visibility);
          if (alpha > 0 && isIncident) focusPositions.push(positions.getX(vertex), positions.getY(vertex), positions.getZ(vertex));
          if (alpha > 0 && isPath) pathPositions.push(positions.getX(vertex), positions.getY(vertex), positions.getZ(vertex));
        }
      }
    });
    if (hasMovedLinks) positions.needsUpdate = true;
    this.hasLinkPositions = true;
    colors.needsUpdate = true;
    const focusAttribute = this.focusGeometry.getAttribute("position") as THREE.BufferAttribute;
    (focusAttribute.array as Float32Array).set(focusPositions);
    focusAttribute.needsUpdate = true;
    this.focusGeometry.setDrawRange(0, focusPositions.length / 3);
    this.focusLines.visible = focusPositions.length > 0;
    const pathAttribute = this.pathGeometry.getAttribute("position") as THREE.BufferAttribute;
    (pathAttribute.array as Float32Array).set(pathPositions);
    pathAttribute.needsUpdate = true;
    this.pathGeometry.setDrawRange(0, pathPositions.length / 3);
    this.pathLines.visible = pathPositions.length > 0;
  }

  /** Visit rendered geometry rather than fitting empty corners around folded shapes. */
  forEachFramePoint(visit: (point: THREE.Vector3) => void): void {
    this.scene.updateMatrixWorld(true);
    const point = new THREE.Vector3();
    const instance = new THREE.Matrix4();
    this.scene.traverse((object) => {
      if (!(object instanceof THREE.Mesh || object instanceof THREE.LineSegments)) return;
      if (!object.visible || object === this.outline || object === this.pathLines || object === this.focusLines || object.parent === this.indicators.group) return;
      const vertices = object.geometry.getAttribute("position");
      if (!vertices) return;
      const count = object instanceof THREE.InstancedMesh ? object.count : 1;
      for (let index = 0; index < count; index++) {
        if (object instanceof THREE.InstancedMesh) {
          object.getMatrixAt(index, instance);
          instance.premultiply(object.matrixWorld);
        } else instance.copy(object.matrixWorld);
        for (let vertex = 0; vertex < vertices.count; vertex++) {
          point.fromBufferAttribute(vertices, vertex).applyMatrix4(instance);
          visit(point);
        }
      }
    });
  }

  /** Return the current solid bounds, including enlarged and grounded columns. */
  nodeBounds(id: string): THREE.Box3 | null {
    const index = this.index.get(id);
    if (index === undefined) return null;
    this.nodes.getMatrixAt(index, this.matrix);
    return new THREE.Box3(new THREE.Vector3(-0.5, -0.5, -0.5), new THREE.Vector3(0.5, 0.5, 0.5))
      .applyMatrix4(this.matrix);
  }

  /** Pick the visible solid primitive, respecting occlusion by its surface. */
  pick(ndc: THREE.Vector2, camera: THREE.Camera): string | null {
    this.scene.updateMatrixWorld(true);
    this.raycaster.setFromCamera(ndc, camera);
    const first = this.raycaster.intersectObjects(this.pickTargets, false)[0];
    return first?.object === this.nodes && first.instanceId !== undefined
      ? this.ids[first.instanceId] ?? null : null;
  }

  dispose(): void {
    this.backdrop.dispose();
    this.indicators.dispose();
    this.nodes.dispose();
    this.geometry.dispose();
    this.material.dispose();
    this.linkGeometry.dispose();
    this.linkMaterial.dispose();
    this.focusGeometry.dispose();
    this.focusMaterial.dispose();
    this.pathGeometry.dispose();
    this.pathMaterial.dispose();
    this.outline.geometry.dispose();
    this.outline.material.dispose();
    this.scene.clear();
  }
}
