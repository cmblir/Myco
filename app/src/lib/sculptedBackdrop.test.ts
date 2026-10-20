import Graph from "graphology";
import * as THREE from "three";
import { describe, expect, it } from "vitest";
import type { VaultGraph } from "./graphData";
import { createSculptedBackdrop } from "./sculptedBackdrop";
import { applySculptedLayout, type SculptedLayoutKind } from "./sculptedLayouts";

function fixture(count: number): VaultGraph {
  const graph = new Graph() as VaultGraph;
  for (let i = 0; i < count; i++) graph.addNode(`synthetic-${i}`, {
    label: `Synthetic ${i}`, x: 0, y: 0, z: 0, deg: i % 11, size: 1,
    color: "#ffffff", community: i % 6, galaxy: -1, isHub: false, intensity: 0.3,
  });
  return graph;
}

describe.each(["terrain", "ribbon", "city"] as SculptedLayoutKind[])("%s backdrop", (kind) => {
  it("does not invent content for an empty graph", () => {
    const backdrop = createSculptedBackdrop(applySculptedLayout(fixture(0), kind, { targetRadius: 100 }));
    expect(backdrop.group.children).toHaveLength(0);
    backdrop.dispose();
  });

  it("provides finite background geometry with bounded detail and disposes every resource once", () => {
    const graph = fixture(1024);
    const backdrop = createSculptedBackdrop(applySculptedLayout(graph, kind, { targetRadius: 100 }));
    const parent = new THREE.Group();
    parent.add(backdrop.group);
    const resources = new Map<THREE.BufferGeometry | THREE.Material, number>();
    let vertexCount = 0;
    backdrop.group.traverse((object) => {
      if (object instanceof THREE.Mesh || object instanceof THREE.LineSegments) {
        const position = object.geometry.getAttribute("position");
        vertexCount += position.count;
        expect([...position.array].every(Number.isFinite)).toBe(true);
        const materialList = Array.isArray(object.material) ? object.material : [object.material];
        for (const resource of [object.geometry, ...materialList]) {
          if (resources.has(resource)) continue;
          resources.set(resource, 0);
          resource.addEventListener("dispose", () => resources.set(resource, resources.get(resource)! + 1));
        }
        if (object instanceof THREE.InstancedMesh) expect(object.count).toBe(6);
      }
    });
    expect(vertexCount).toBeGreaterThan(0);
    expect(vertexCount).toBeLessThan(100_000);
    expect(graph.order).toBe(1024);
    backdrop.dispose();
    backdrop.dispose();
    expect([...resources.values()].every((calls) => calls === 1)).toBe(true);
    expect(backdrop.group.children).toHaveLength(0);
    expect(parent.children).toHaveLength(0);
  });
});


describe("sculpted surface details", () => {
  it("gives terrain lit elevation, separate contour weights and a closed cutaway", () => {
    const backdrop = createSculptedBackdrop(applySculptedLayout(fixture(1024), "terrain", { targetRadius: 100 }));
    const surface = backdrop.group.getObjectByName("terrain-surface") as THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>;
    expect(surface.material).toBeInstanceOf(THREE.MeshStandardMaterial);
    expect(surface.material.roughness).toBeGreaterThan(0.8);
    const contours = backdrop.group.getObjectByName("terrain-contours") as THREE.LineSegments<THREE.BufferGeometry, THREE.LineBasicMaterial>;
    const major = backdrop.group.getObjectByName("terrain-major-contours") as THREE.LineSegments<THREE.BufferGeometry, THREE.LineBasicMaterial>;
    expect(major.material.opacity).toBeGreaterThan(contours.material.opacity);
    for (const name of ["terrain-cutaway", "terrain-plinth"]) {
      const mesh = backdrop.group.getObjectByName(name) as THREE.Mesh;
      mesh.geometry.computeBoundingBox();
      expect(mesh.geometry.boundingBox!.min.z).toBeLessThan(0);
      expect(mesh.geometry.boundingBox!.max.z).toBeGreaterThan(mesh.geometry.boundingBox!.min.z);
    }
    const normal = surface.geometry.getAttribute("normal");
    for (let i = 0; i < normal.count; i++) expect(normal.getZ(i)).toBeGreaterThan(0);
    backdrop.dispose();
  });

  it("uses a satin lighting model with valid tangents and a thin solid ribbon edge", () => {
    const backdrop = createSculptedBackdrop(applySculptedLayout(fixture(512), "ribbon", { targetRadius: 100 }));
    const surface = backdrop.group.getObjectByName("ribbon-surface") as THREE.Mesh<THREE.BufferGeometry, THREE.MeshPhysicalMaterial>;
    expect(surface.material).toBeInstanceOf(THREE.MeshPhysicalMaterial);
    expect(surface.material.anisotropy).toBeGreaterThan(0);
    expect(surface.material.sheen).toBeGreaterThan(0);
    expect(surface.material.iridescence).toBeLessThan(0.3);
    const tangent = surface.geometry.getAttribute("tangent");
    expect(tangent.count).toBe(surface.geometry.getAttribute("position").count);
    expect([...tangent.array].every(Number.isFinite)).toBe(true);
    const edge = backdrop.group.getObjectByName("ribbon-edge-thickness") as THREE.Mesh;
    const position = edge.geometry.getAttribute("position");
    for (let i = 0; i < position.count; i += 2) {
      const top = new THREE.Vector3().fromBufferAttribute(position, i);
      const bottom = new THREE.Vector3().fromBufferAttribute(position, i + 1);
      expect(top.distanceTo(bottom)).toBeCloseTo(0.4, 4);
    }
    backdrop.dispose();
  });

  it("grounds the city beneath its real districts without adding content instances", () => {
    const layout = applySculptedLayout(fixture(2048), "city", { targetRadius: 100 });
    if (layout.kind !== "city") throw new Error("Expected city layout");
    const backdrop = createSculptedBackdrop(layout);
    const floors = backdrop.group.getObjectByName("city-district-floors") as THREE.InstancedMesh;
    expect(floors.count).toBe(layout.districts.length);
    const plinth = backdrop.group.getObjectByName("city-plinth") as THREE.Mesh;
    const box = new THREE.Box3().setFromObject(plinth);
    for (const district of layout.districts) {
      expect(box.min.x).toBeLessThan(district.x - district.width / 2);
      expect(box.max.x).toBeGreaterThan(district.x + district.width / 2);
      expect(box.min.y).toBeLessThan(district.y - district.depth / 2);
      expect(box.max.y).toBeGreaterThan(district.y + district.depth / 2);
    }
    expect(box.max.z).toBeLessThan(0);
    backdrop.dispose();
  });
});
