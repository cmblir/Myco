import * as THREE from "three";
import type { SculptedLayoutKind } from "./sculptedLayouts";

/** Architectural detail belongs to each real note's material, never extra nodes. */
export function createSculptedNoteMaterial(
  kind: SculptedLayoutKind,
  radius: number,
): THREE.MeshStandardMaterial {
  if (kind === "ribbon")
    return new THREE.MeshPhysicalMaterial({
      roughness: 0.3,
      metalness: 0.24,
      clearcoat: 0.55,
      clearcoatRoughness: 0.28,
    });
  const material = new THREE.MeshStandardMaterial({
    roughness: kind === "terrain" ? 0.78 : 0.5,
    metalness: kind === "terrain" ? 0.02 : 0.18,
  });
  if (kind !== "city") return material;
  material.customProgramCacheKey = () => "myco-city-facades-v1";
  material.onBeforeCompile = (shader) => {
    shader.uniforms.u_blockUnit = { value: radius * 0.011 };
    const varyings = `
      varying vec3 v_blockPosition;
      varying vec3 v_blockNormal;
      varying vec3 v_blockSize;
    `;
    shader.vertexShader = varyings + shader.vertexShader;
    shader.vertexShader = shader.vertexShader.replace(
      "#include <begin_vertex>",
      `
      #include <begin_vertex>
      v_blockPosition = position + 0.5;
      v_blockNormal = normal;
      v_blockSize = vec3(length(instanceMatrix[0].xyz), length(instanceMatrix[1].xyz), length(instanceMatrix[2].xyz));
    `,
    );
    shader.fragmentShader =
      `uniform float u_blockUnit;\n${varyings}` + shader.fragmentShader;
    shader.fragmentShader = shader.fragmentShader.replace(
      "#include <color_fragment>",
      `
      #include <color_fragment>
      float roof = step(0.5, abs(v_blockNormal.z));
      vec2 wall = vec2(abs(v_blockNormal.x) > 0.5 ? v_blockPosition.y * v_blockSize.y : v_blockPosition.x * v_blockSize.x, v_blockPosition.z * v_blockSize.z);
      vec2 cells = wall / u_blockUnit;
      vec2 pixel = max(fwidth(cells), vec2(0.001));
      vec2 pane = abs(fract(cells) - 0.5);
      vec2 glass = 1.0 - smoothstep(vec2(0.22) - pixel, vec2(0.22) + pixel, pane);
      float occupancy = step(0.42, fract(sin(dot(floor(cells), vec2(12.9898, 78.233))) * 43758.5453));
      float resolvable = 1.0 - smoothstep(0.3, 1.0, max(pixel.x, pixel.y));
      float windows = glass.x * glass.y * occupancy * resolvable * (1.0 - roof);
      float foot = smoothstep(0.0, 0.22, v_blockPosition.z);
      diffuseColor.rgb *= mix(0.36, 0.82, roof) * mix(0.65, 1.0, foot);
    `,
    );
    shader.fragmentShader = shader.fragmentShader.replace(
      "#include <emissivemap_fragment>",
      `
      #include <emissivemap_fragment>
      // Windows dim with their owning note's focus/search colour.
      totalEmissiveRadiance += diffuseColor.rgb * vec3(2.8, 2.15, 1.4) * windows;
    `,
    );
  };
  return material;
}
