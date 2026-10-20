import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { EdgeDensityLayer } from "./edgeDensity";

describe("density link visibility", () => {
  it.each(["web", "atmo"] as const)("updates the actual %s composite when the link control changes", (mode) => {
    const geometry = new THREE.BufferGeometry();
    const layer = new EdgeDensityLayer(geometry, 100, 100, 1, mode);
    const material = layer.quad.material as THREE.ShaderMaterial;
    const base = material.uniforms.u_strength.value as number;
    layer.setLinkStrength(0.3);
    expect(material.uniforms.u_strength.value).toBeCloseTo(base * 0.3);
    layer.setLinkStrength(2);
    expect(material.uniforms.u_strength.value).toBeCloseTo(base * 2);
    layer.dispose();
    geometry.dispose();
  });
});
