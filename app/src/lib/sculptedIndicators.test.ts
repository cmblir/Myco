import * as THREE from "three";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SculptedIndicators } from "./sculptedIndicators";

const cleanup: (() => void)[] = [];
afterEach(() => { cleanup.splice(0).forEach((dispose) => dispose()); });

function fixture(rings: number[], alphas = rings.map(() => 1)) {
  const nodes = new THREE.InstancedMesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial(), rings.length);
  for (let index = 0; index < rings.length; index++) nodes.setMatrixAt(index, new THREE.Matrix4().makeTranslation(index * 10, 0, 0));
  const attributes = new THREE.BufferGeometry();
  attributes.setAttribute("a_ring", new THREE.Float32BufferAttribute(rings, 1));
  attributes.setAttribute("a_alpha", new THREE.Float32BufferAttribute(alphas, 1));
  const indicators = new SculptedIndicators();
  const lines = indicators.group.children[0] as THREE.LineSegments<THREE.BufferGeometry, THREE.LineBasicMaterial>;
  cleanup.push(() => {
    indicators.dispose(); attributes.dispose(); nodes.geometry.dispose(); nodes.material.dispose(); nodes.dispose();
  });
  const vertices = (): THREE.Vector3[] => {
    const positions = lines.geometry.getAttribute("position");
    return Array.from({ length: lines.geometry.drawRange.count }, (_, index) => new THREE.Vector3().fromBufferAttribute(positions, index));
  };
  indicators.sync(nodes, attributes);
  return { nodes, attributes, indicators, lines, vertices };
}

describe("sculpted note indicators", () => {
  it("distinguishes dashed gaps, dotted unresolved notes and solid fresh notes by geometry", () => {
    const lengths = (ring: number): number[] => {
      const points = fixture([ring]).vertices();
      return Array.from({ length: points.length / 2 }, (_, index) => points[index * 2].distanceTo(points[index * 2 + 1]));
    };
    const gaps = lengths(1);
    const mapless = lengths(3);
    const unresolved = lengths(2);
    const fresh = lengths(4);
    expect(gaps).toEqual(mapless);
    expect(Math.max(...unresolved)).toBeLessThan(Math.min(...gaps) / 3);
    expect(Math.max(...gaps)).toBeLessThan(Math.min(...fresh) / 3);
    expect(unresolved.length).toBeGreaterThan(gaps.length);
  });

  it.each([5, 6])("gives status %s two solid contours instead of relying on line width", (ring) => {
    const regular = fixture([4]).vertices();
    const prominent = fixture([ring]).vertices();
    expect(prominent).toHaveLength(regular.length * 2);
    const bounds = new THREE.Box3().setFromPoints(prominent);
    expect(bounds.max.x).toBeCloseTo(1.23 / 2);
    expect(prominent.every((point) => [point.x, point.y, point.z].every(Number.isFinite))).toBe(true);
  });

  it("supports sphere-radius transforms without burying the frame inside the note", () => {
    const { nodes, attributes, indicators, vertices } = fixture([4]);
    indicators.sync(nodes, attributes, 2);
    const bounds = new THREE.Box3().setFromPoints(vertices());
    expect(bounds.min.x).toBeCloseTo(-1.15);
    expect(bounds.max.x).toBeCloseTo(1.15);
  });

  it("tracks the exact note transform without changing the node or attribute buffers", () => {
    const { nodes, attributes, indicators, vertices } = fixture([4]);
    const transform = new THREE.Matrix4().compose(
      new THREE.Vector3(20, -10, 4),
      new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 3),
      new THREE.Vector3(4, 2, 0.5),
    );
    nodes.setMatrixAt(0, transform);
    const originalMatrix = [...nodes.instanceMatrix.array];
    const originalRings = [...attributes.getAttribute("a_ring").array];
    indicators.sync(nodes, attributes);
    const inverse = transform.clone().invert();
    for (const point of vertices()) {
      const local = point.applyMatrix4(inverse);
      expect(Math.abs(local.x)).toBeCloseTo(0.575, 5);
      expect(Math.abs(local.y)).toBeCloseTo(0.575, 5);
      expect(Math.abs(local.z)).toBeCloseTo(0.575, 5);
    }
    expect([...nodes.instanceMatrix.array]).toEqual(originalMatrix);
    expect([...attributes.getAttribute("a_ring").array]).toEqual(originalRings);
  });

  it("removes hidden and cleared indicators without leaving stale vertices visible", () => {
    const { nodes, attributes, indicators, lines, vertices } = fixture([1, 2, 4, 5, 6, 0], [1, 0, 1, 0, 1, 1]);
    expect(vertices().every((point) => point.x < 1 || (point.x > 19 && point.x < 21) || (point.x > 39 && point.x < 41))).toBe(true);
    const buffer = lines.geometry.getAttribute("position");
    attributes.getAttribute("a_alpha").setX(0, 0);
    attributes.getAttribute("a_ring").setX(2, 0);
    attributes.getAttribute("a_ring").setX(4, 0);
    indicators.sync(nodes, attributes);
    expect(lines.geometry.drawRange.count).toBe(0);
    expect(lines.geometry.getAttribute("position")).toBe(buffer);
    attributes.getAttribute("a_alpha").setX(0, 1);
    indicators.sync(nodes, attributes);
    expect(vertices().length).toBeGreaterThan(0);
    expect(vertices().every((point) => Math.abs(point.x) < 1)).toBe(true);
  });

  it("disposes owned geometry and material once and detaches its group", () => {
    const { indicators, lines } = fixture([4]);
    const parent = new THREE.Scene();
    parent.add(indicators.group);
    const geometryDisposed = vi.fn();
    const materialDisposed = vi.fn();
    lines.geometry.addEventListener("dispose", geometryDisposed);
    lines.material.addEventListener("dispose", materialDisposed);
    indicators.dispose();
    indicators.dispose();
    expect(geometryDisposed).toHaveBeenCalledOnce();
    expect(materialDisposed).toHaveBeenCalledOnce();
    expect(parent.children).toHaveLength(0);
    expect(indicators.group.children).toHaveLength(0);
  });

  it("reuses the reserved GPU attributes when a question changes the frame pattern", () => {
    const { nodes, attributes, indicators, lines } = fixture([0]);
    const positions = lines.geometry.getAttribute("position");
    const colors = lines.geometry.getAttribute("color");
    for (const ring of [4, 2, 1, 5, 6, 0]) {
      attributes.getAttribute("a_ring").setX(0, ring);
      indicators.sync(nodes, attributes);
      expect(lines.geometry.getAttribute("position")).toBe(positions);
      expect(lines.geometry.getAttribute("color")).toBe(colors);
    }
    expect(lines.geometry.drawRange.count).toBe(0);
  });
});
