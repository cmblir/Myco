import * as THREE from "three";
import type { SculptedVector } from "./sculptedLayouts";

export function surfaceGeometry(positions: number[], indices: number[], colors?: number[]): THREE.BufferGeometry {
  const result = new THREE.BufferGeometry();
  result.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  if (colors) result.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
  result.setIndex(indices);
  result.computeVertexNormals();
  result.computeBoundingSphere();
  return result;
}

export function addSurface(group: THREE.Group, shape: THREE.BufferGeometry, material: THREE.Material, name: string): THREE.Mesh {
  const mesh = new THREE.Mesh(shape, material);
  mesh.name = name;
  group.add(mesh);
  return mesh;
}

export function addLines(group: THREE.Group, positions: number[], color: number, opacity: number, name: string): void {
  if (positions.length === 0) return;
  const shape = new THREE.BufferGeometry();
  shape.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  const material = new THREE.LineBasicMaterial({ color, transparent: true, opacity, depthWrite: false });
  const segments = new THREE.LineSegments(shape, material);
  segments.name = name;
  group.add(segments);
}

export function appendPair(positions: number[], a: SculptedVector, b: SculptedVector): void {
  positions.push(a.x, a.y, a.z, b.x, b.y, b.z);
}

export function triangleIndices(columns: number, rows: number): number[] {
  const indices: number[] = [];
  for (let row = 0; row < rows; row++) for (let column = 0; column < columns; column++) {
    const a = row * (columns + 1) + column;
    const b = a + 1;
    const c = a + columns + 1;
    indices.push(a, b, c, b, c + 1, c);
  }
  return indices;
}

/** A small bevel catches real light without introducing a large model or texture. */
export function addPlinth(
  group: THREE.Group,
  width: number,
  depth: number,
  bottom: number,
  height: number,
  bevel: number,
  color: number,
  name: string,
): THREE.Mesh {
  const outline = new THREE.Shape();
  outline.moveTo(-width / 2 + bevel, -depth / 2 + bevel);
  outline.lineTo(width / 2 - bevel, -depth / 2 + bevel);
  outline.lineTo(width / 2 - bevel, depth / 2 - bevel);
  outline.lineTo(-width / 2 + bevel, depth / 2 - bevel);
  outline.closePath();
  const shape = new THREE.ExtrudeGeometry(outline, {
    depth: height - bevel * 2, steps: 1, bevelEnabled: true,
    bevelThickness: bevel, bevelSize: bevel, bevelSegments: 2, curveSegments: 1,
  });
  shape.translate(0, 0, bottom + bevel);
  return addSurface(group, shape, new THREE.MeshStandardMaterial({ color, roughness: 0.76, metalness: 0.06 }), name);
}

/** An analytic contact shadow costs one small quad and never follows the camera. */
export function addContactShadow(group: THREE.Group, width: number, depth: number, z: number, opacity: number): void {
  const shape = new THREE.PlaneGeometry(width * 1.08, depth * 1.1);
  shape.translate(0, 0, z);
  const material = new THREE.ShaderMaterial({
    uniforms: { opacity: { value: opacity } },
    vertexShader: `varying vec2 vShadowUv;
      void main() { vShadowUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: `uniform float opacity; varying vec2 vShadowUv;
      void main() {
        vec2 edge = abs(vShadowUv * 2.0 - 1.0);
        float mask = (1.0 - smoothstep(0.79, 1.0, edge.x)) * (1.0 - smoothstep(0.76, 1.0, edge.y));
        gl_FragColor = vec4(0.08, 0.07, 0.055, mask * opacity);
      }`,
    transparent: true, depthWrite: false, toneMapped: false,
  });
  addSurface(group, shape, material, "sculpted-contact-shadow");
}
