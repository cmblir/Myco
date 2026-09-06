import { describe, expect, it } from "vitest";
import Graph from "graphology";
import * as THREE from "three";
import { PlanetLayer } from "./planetLayer";
import { PIXEL_ARCHETYPES } from "./pixelPlanet";
import { seededUnit } from "./graphData";

// A node's world position for these tests is carried entirely by the
// `nodePos` buffer passed to update() — NOT the graph's own x/y/z — so a
// distinct z per node id is enough to identify which billboard slot ended up
// holding which node afterwards (match on decomposed translation).
function makeGraph(nodes: { id: string; isHub: boolean; deg: number; hidden?: boolean }[]): Graph {
  const g = new Graph();
  for (const n of nodes) {
    g.addNode(n.id, { color: "#3399cc", deg: n.deg, isHub: n.isHub, hidden: n.hidden ?? false });
  }
  return g;
}

function camera(): THREE.PerspectiveCamera {
  const cam = new THREE.PerspectiveCamera(60, 1, 0.1, 5000);
  cam.position.set(0, 0, 0);
  return cam;
}

function posBuffer(nodes: { z: number }[]): THREE.BufferAttribute {
  const arr = new Float32Array(nodes.length * 3);
  nodes.forEach((n, i) => { arr[i * 3] = 0; arr[i * 3 + 1] = 0; arr[i * 3 + 2] = n.z; });
  return new THREE.BufferAttribute(arr, 3);
}

// Fully fade in every currently-selected slot (FADE_PER_SEC = 3 -> < 1/3s).
function warmUp(layer: PlanetLayer, pos: THREE.BufferAttribute, seconds = 5): void {
  const steps = Math.round(seconds / 0.1);
  for (let i = 0; i < steps; i++) layer.update(0.1, pos, true);
}

// Read an instance's raw matrix elements directly instead of Matrix4.decompose():
// three.js's decompose() special-cases det===0 (our "collapsed" zero-scale
// matrix) by reporting a fake scale of (1,1,1) to avoid propagating NaN from
// a 1/0 rotation extraction — a safe rendering fallback, but it makes
// decompose() useless for telling a collapsed slot apart from a live one.
// Column 0's x (element 0) is the uniform scale (rotation is always identity
// — see PlanetLayer.update()); elements 12-14 are the translation.
function readInstance(mesh: THREE.InstancedMesh, i: number): { scaleX: number; z: number } {
  const arr = mesh.instanceMatrix.array as Float32Array;
  const o = i * 16;
  return { scaleX: arr[o], z: arr[o + 14] };
}

// Find the active billboard slot whose translation matches node z `z`.
function findSlot(mesh: THREE.InstancedMesh, z: number): { slot: number; scale: number } | null {
  for (let i = 0; i < mesh.count; i++) {
    const { scaleX, z: iz } = readInstance(mesh, i);
    if (scaleX > 1e-6 && Math.abs(iz - z) < 1e-3) return { slot: i, scale: scaleX };
  }
  return null;
}

function countActive(mesh: THREE.InstancedMesh): number {
  let n = 0;
  for (let i = 0; i < mesh.count; i++) if (readInstance(mesh, i).scaleX > 1e-6) n++;
  return n;
}

describe("PlanetLayer", () => {
  it("starts with everything collapsed and disabled unless told otherwise", () => {
    const g = makeGraph([{ id: "a", isHub: false, deg: 3 }]);
    const layer = new PlanetLayer(g as never, ["a"], camera(), 1, true, false);
    expect(layer.billboards.visible).toBe(false);
    expect(layer.moons.visible).toBe(false);
    layer.setEnabled(true);
    expect(layer.billboards.visible).toBe(true);
    expect(layer.moons.visible).toBe(true);
  });

  it("only claims a billboard for nodes inside NEAR_DIST and not hidden", () => {
    const nodes = [
      { id: "near", isHub: false, deg: 3, z: -40 },
      { id: "hidden", isHub: false, deg: 3, z: -15, hidden: true },
      { id: "far", isHub: false, deg: 3, z: -500 },
    ];
    const g = makeGraph(nodes);
    const layer = new PlanetLayer(g as never, nodes.map((n) => n.id), camera(), 1, true, true);
    warmUp(layer, posBuffer(nodes));
    expect(findSlot(layer.billboards, -40)).not.toBeNull(); // near, visible
    expect(findSlot(layer.billboards, -15)).toBeNull(); // hidden, excluded
    expect(findSlot(layer.billboards, -500)).toBeNull(); // beyond NEAR_DIST
    expect(countActive(layer.billboards)).toBe(1);
  });

  it("caps live worlds at MAX_PLANETS (24), keeping the nearest candidates", () => {
    const nodes: { id: string; isHub: boolean; deg: number; z: number }[] = [];
    for (let i = 0; i < 6; i++) nodes.push({ id: `hub-${i}`, isHub: true, deg: 20, z: -(20 + i * 3) }); // nearest
    nodes.push({ id: "reg-a", isHub: false, deg: 5, z: -40 });
    for (let i = 0; i < 30; i++) nodes.push({ id: `cap-${i}`, isHub: false, deg: 3, z: -(60 + i * 2) }); // 37 candidates total
    const g = makeGraph(nodes);
    const layer = new PlanetLayer(g as never, nodes.map((n) => n.id), camera(), 1, true, true);
    warmUp(layer, posBuffer(nodes));
    expect(countActive(layer.billboards)).toBe(24);
    // The 6 closest (hub-*) must all have made the cut.
    for (let i = 0; i < 6; i++) expect(findSlot(layer.billboards, -(20 + i * 3))).not.toBeNull();
  });

  it("gives a hub node the giant radius bracket and the 'hub' archetype", () => {
    const nodes = [
      { id: "hub-0", isHub: true, deg: 20, z: -20 },
      { id: "reg-0", isHub: false, deg: 5, z: -40 },
    ];
    const g = makeGraph(nodes);
    const layer = new PlanetLayer(g as never, nodes.map((n) => n.id), camera(), 1, true, true);
    warmUp(layer, posBuffer(nodes));

    const hubSlot = findSlot(layer.billboards, -20)!;
    const regSlot = findSlot(layer.billboards, -40)!;
    expect(hubSlot).not.toBeNull();
    expect(regSlot).not.toBeNull();

    const hubFamily = layer.billboards.geometry.getAttribute("a_family").getX(hubSlot.slot);
    expect(PIXEL_ARCHETYPES[hubFamily]).toBe("hub");
    const regFamily = layer.billboards.geometry.getAttribute("a_family").getX(regSlot.slot);
    expect(PIXEL_ARCHETYPES[regFamily]).not.toBe("hub"); // archetypeFor() never gives a non-hub node "hub"

    // Radius formula: giant (hub) = 5.0 + sd*2.5; regular = 3.0 + sd*2.0.
    // Billboard full width is 2r (quad half-extent 0.5 * scale = r).
    const sdHub = seededUnit("hub-0", 11);
    const sdReg = seededUnit("reg-0", 11);
    expect(hubSlot.scale).toBeCloseTo(2 * (5.0 + sdHub * 2.5), 3);
    expect(regSlot.scale).toBeCloseTo(2 * (3.0 + sdReg * 2.0), 3);
  });

  it("spins slowly while ambient motion is on and freezes when it's off", () => {
    const nodes = [{ id: "hub-0", isHub: true, deg: 20, z: -20 }];
    const g = makeGraph(nodes);
    const layer = new PlanetLayer(g as never, nodes.map((n) => n.id), camera(), 1, true, true);
    const pos = posBuffer(nodes);
    warmUp(layer, pos);
    const slot = findSlot(layer.billboards, -20)!.slot;
    const spinAttr = layer.billboards.geometry.getAttribute("a_spin");

    const a = spinAttr.getX(slot);
    layer.update(1.0, pos, true);
    const b = spinAttr.getX(slot);
    expect(b).toBeGreaterThan(a);
    // A full turn is targeted at ~60s — one second of ambient motion should
    // advance well under a full radian, i.e. clearly a drift, not a spin.
    expect(b - a).toBeLessThan(0.3);

    layer.update(1.0, pos, false); // ambient off (reduced motion / paused)
    const c = spinAttr.getX(slot);
    expect(c).toBe(b);
  });

  it("retints ramps on a theme flip (setDark) without losing the claimed node", () => {
    const nodes = [{ id: "hub-0", isHub: true, deg: 20, z: -20 }];
    const g = makeGraph(nodes);
    const layer = new PlanetLayer(g as never, nodes.map((n) => n.id), camera(), 1, true, true);
    const pos = posBuffer(nodes);
    warmUp(layer, pos);
    const c0Attr = layer.billboards.geometry.getAttribute("a_c0");
    const slotBefore = findSlot(layer.billboards, -20)!.slot;
    const darkSum = c0Attr.getX(slotBefore) + c0Attr.getY(slotBefore) + c0Attr.getZ(slotBefore);

    layer.setDark(false);
    warmUp(layer, pos); // slots reset by setDark -> needs a fresh rescan + fade-in
    const slotAfter = findSlot(layer.billboards, -20)!.slot;
    const lightSum = c0Attr.getX(slotAfter) + c0Attr.getY(slotAfter) + c0Attr.getZ(slotAfter);

    expect(lightSum).toBeLessThan(darkSum); // rampFor(): light theme reads darker overall
  });

  it("disposes without throwing", () => {
    const g = makeGraph([{ id: "a", isHub: false, deg: 3 }]);
    const layer = new PlanetLayer(g as never, ["a"], camera(), 1, true, true);
    expect(() => layer.dispose()).not.toThrow();
  });
});
