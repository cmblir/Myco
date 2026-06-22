// Custom sigma node program: renders each node as a glowing star — a small
// bright core wrapped in a soft radial halo — so the tiny dots read as stars in
// the galaxy. Subclasses the built-in point program and swaps only the shaders;
// the attribute/uniform/buffer layout is inherited unchanged.
import { NodePointProgram } from "sigma/rendering";

// How far the halo extends past the core, in multiples of the node's base point
// size. Larger = softer, wider bloom.
const GLOW_SCALE = 2.6;

const VERTEX_SHADER_SOURCE = /* glsl */ `
attribute vec4 a_id;
attribute vec4 a_color;
attribute vec2 a_position;
attribute float a_size;

uniform float u_sizeRatio;
uniform float u_pixelRatio;
uniform mat3 u_matrix;

varying vec4 v_color;

const float bias = 255.0 / 254.0;

void main() {
  gl_Position = vec4((u_matrix * vec3(a_position, 1)).xy, 0, 1);
  // Enlarge the GL point so the halo has room to fade out around the core.
  gl_PointSize = a_size / u_sizeRatio * u_pixelRatio * 2.0 * ${GLOW_SCALE.toFixed(1)};

  #ifdef PICKING_MODE
  v_color = a_id;
  #else
  v_color = a_color;
  #endif
  v_color.a *= bias;
}
`;

const FRAGMENT_SHADER_SOURCE = /* glsl */ `
precision mediump float;

varying vec4 v_color;

const vec4 transparent = vec4(0.0, 0.0, 0.0, 0.0);

void main(void) {
  // 0 at the point centre, ~1 at the point edge.
  float d = length(gl_PointCoord - vec2(0.5, 0.5)) * 2.0;

  #ifdef PICKING_MODE
  // Pick on the bright core only, so clicks/hover land on the star not its halo.
  if (d < 0.55) gl_FragColor = v_color;
  else gl_FragColor = transparent;
  #else
  float core = 1.0 - smoothstep(0.30, 0.45, d); // solid bright centre
  float glow = pow(max(0.0, 1.0 - d), 2.2);      // soft halo fading to the edge
  float a = max(core, glow * 0.6);
  // sigma blends premultiplied alpha — multiply rgb by coverage too, or the
  // transparent corners stay opaque and the star renders as a square.
  gl_FragColor = v_color * a;
  #endif
}
`;

export default class NodeGlowProgram extends NodePointProgram {
  override getDefinition(): ReturnType<NodePointProgram["getDefinition"]> {
    return {
      ...super.getDefinition(),
      VERTEX_SHADER_SOURCE,
      FRAGMENT_SHADER_SOURCE,
    };
  }
}
