// Near-field LOD planets — the CLOSE end of the cosmic-scale LOD (galaxy
// imposters are the far end). Far away every note is a cheap glowing star
// point; fly in close and the nodes nearest the camera resolve into small
// pixel-art worlds, shaded by pixel_planet() (see pixelPlanet.ts). Archetype
// (rock/ocean/ice/ember/gas/dead/hub) comes from archetypeFor(), the ramp
// from rampFor() tinted by the node's own community hue — the SAME mapping
// the graph's node sprites use, so a note reads as the same "kind of world"
// whether it's a distant point or a close-up planet.
//
// Rendered as CAMERA-FACING BILLBOARDS, not a lit sphere mesh: pixel_planet()
// already fakes its own sphere shading (uv spherify + a fixed key light baked
// into the shader), so a real lit mesh normal would shade it a second time
// and wash out the pixel banding. A flat billboard is also the shader's
// native form — it was built as a 2D pixel-art sprite, not a 3D texture.
//
// Everything is instanced: one quad InstancedMesh for planets, one for
// moons — both share the shader/material — so the whole layer stays two draw
// calls regardless of vault size, capped at MAX_PLANETS live worlds. Big
// worlds (the "hub" archetype) carry a ring baked into the shader itself
// (pixel_planet's family==6 branch) and are orbited by little MOONS (also
// billboards, muted/flavor-neutral rock+ice bodies). The layer owns no node
// positions: GraphScene feeds the live nodeGeom position buffer into
// update() each frame, so a rebuild() never leaves a stale buffer. Opaque —
// pixel_planet's own alpha is already a hard 0/1 step, so `discard` gives a
// crisp pixel edge with no blending/sorting needed.
import * as THREE from "three";
import { fieldStar, seededUnit, type VaultGraph } from "./graphData";
import {
  PIXEL_ARCHETYPES,
  PIXEL_PLANET_GLSL,
  archetypeFor,
  rampFor,
  type PixelArchetype,
} from "./pixelPlanet";

const MAX_PLANETS = 24; // hard cap on live worlds → bounded instances / fill
const MOONS_PER = 2; // max satellites per planet
const MAX_MOONS = MAX_PLANETS * MOONS_PER;
const NEAR_DIST = 130; // world units: planets only materialize this close
const NEAR_DIST2 = NEAR_DIST * NEAR_DIST;
const SCAN_EVERY = 10; // re-pick the nearest set every N frames
const FADE_PER_SEC = 3.0; // materialize / dissolve speed (~0.33 s swing)

// Full rotation on the order of a minute — a calm drift, not a spin (the old
// sphere version turned as fast as ~20s/rotation, which read too fast). The
// shader's own "rotation" is a fixed seed*2π tilt with no time input in its
// public signature (see pixelPlanet.ts), so this is applied externally by
// slowly rotating the quad's uv before calling pixel_planet() — see
// PLANET_FRAG. Per-planet rate jitters ±25% around this so a cluster of
// planets doesn't visibly lock-step.
const SPIN_RATE = (Math.PI * 2) / 60; // rad/s — ≈60s per full turn, base rate

// Moon ORBIT rate (revolution around the host, distinct from SPIN_RATE which
// is the host's own axial turn). Scales the 0.4-1.0 rad/s per-moon jitter
// below down into the same calm register as SPIN_RATE: unscaled that range
// is a 6-16s lap, which visibly outran a planet that itself takes a full
// slow minute to turn — two different clocks in the same shot.
const MOON_ORBIT_SCALE = 1 / 6;

// Moons are small, flavour-neutral satellites (cratered rock or ice), not
// tinted by the host's community hue — a fixed neutral hue keeps them reading
// as generic background bodies instead of miniature copies of their planet.
const MOON_HUE = 220;

// The 5-stop ramp pixel_planet() expects, threaded per-instance (see below).
const COLOR_ATTRS = ["a_c0", "a_c1", "a_c2", "a_c3", "a_c4"] as const;

const PLANET_VERT = /* glsl */ `
attribute float a_family;
attribute float a_seed;
attribute float a_spin;
attribute vec3 a_c0;
attribute vec3 a_c1;
attribute vec3 a_c2;
attribute vec3 a_c3;
attribute vec3 a_c4;
varying vec2 v_uv;
varying float v_family;
varying float v_seed;
varying float v_spin;
varying vec3 v_c0;
varying vec3 v_c1;
varying vec3 v_c2;
varying vec3 v_c3;
varying vec3 v_c4;
void main() {
  v_uv = uv;
  v_family = a_family;
  v_seed = a_seed;
  v_spin = a_spin;
  v_c0 = a_c0; v_c1 = a_c1; v_c2 = a_c2; v_c3 = a_c3; v_c4 = a_c4;
  // Camera-facing billboard: instanceMatrix carries translate + uniform scale
  // only (see PlanetLayer.update() — rotation lives in a_spin instead, a real
  // mesh rotation would turn the quad's edge toward the camera, not its face).
  // Adding the quad's local offset AFTER the view transform keeps it
  // screen-aligned regardless of camera orientation, while staying in
  // world-space units (the view matrix is rigid, no scale), so distance
  // still shrinks it correctly under perspective.
  vec4 center = modelViewMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
  float scale = length(instanceMatrix[0].xyz); // no rotation baked in, so this is the uniform scale
  center.xy += position.xy * scale;
  gl_Position = projectionMatrix * center;
}
`;

const PLANET_FRAG = /* glsl */ `
precision highp float;
varying vec2 v_uv;
varying float v_family;
varying float v_seed;
varying float v_spin;
varying vec3 v_c0;
varying vec3 v_c1;
varying vec3 v_c2;
varying vec3 v_c3;
varying vec3 v_c4;
uniform float u_time;

// pixel_planet() expects a colors[5] ramp already in scope. Every instance
// needs its OWN ramp (community-hue tinted), so it is threaded through as
// instanced attributes → varyings (constant across one quad's 4 corners)
// rather than the single uniform vec3 colors[5] a one-planet consumer
// would declare — same variable name, just instance-varying instead of
// draw-call-constant.
vec3 colors[5];

${PIXEL_PLANET_GLSL}

void main() {
  colors[0] = v_c0; colors[1] = v_c1; colors[2] = v_c2; colors[3] = v_c3; colors[4] = v_c4;
  // Rotate uv around the quad centre before handing it to pixel_planet — its
  // own fixed seed*2π tilt (see pxp_rotate inside PIXEL_PLANET_GLSL) becomes
  // a slow drift once composed with this externally-advancing angle. Rotating
  // about (0.5,0.5) — the same centre pixel_planet's own circle mask uses —
  // leaves the silhouette (alpha) untouched; only the surface pattern turns.
  vec2 c = v_uv - 0.5;
  float cs = cos(v_spin), sn = sin(v_spin);
  c *= mat2(vec2(cs, -sn), vec2(sn, cs));
  vec2 ruv = c + 0.5;
  vec4 col = pixel_planet(ruv, int(v_family + 0.5), u_time, v_seed);
  if (col.a < 0.5) discard; // pixel_planet's alpha is already a hard step — discard keeps the edge crisp, no AA feather
  gl_FragColor = vec4(col.rgb, 1.0);
}
`;

export class PlanetLayer {
  readonly billboards: THREE.InstancedMesh; // planets — camera-facing pixel-planet quads
  readonly moons: THREE.InstancedMesh; // little satellites, same shader/material, smaller scale
  private planetMat: THREE.ShaderMaterial;
  private graph: VaultGraph;
  private nodeIds: string[];
  private camera: THREE.PerspectiveCamera;
  private dark: boolean;

  // Per-node identity cache (indexed like nodeIds / the position buffer).
  private family = new Uint8Array(0); // PIXEL_ARCHETYPES index
  private seed = new Float32Array(0);
  private ramp = new Float32Array(0); // 5 × [r,g,b] per node, flat (rampFor() output)
  private radius = new Float32Array(0);
  private nMoons = new Uint8Array(0);

  // Per planet-slot bookkeeping (length MAX_PLANETS).
  private slotNode = new Int32Array(MAX_PLANETS).fill(-1);
  private fade = new Float32Array(MAX_PLANETS);
  private fadeTarget = new Float32Array(MAX_PLANETS);
  private spin = new Float32Array(MAX_PLANETS);
  private spinRate = new Float32Array(MAX_PLANETS);

  // Per moon-slot bookkeeping (length MAX_MOONS = MAX_PLANETS * MOONS_PER).
  private moonAngle = new Float32Array(MAX_MOONS);
  private moonSpeed = new Float32Array(MAX_MOONS);
  private moonOrbit = new Float32Array(MAX_MOONS); // × host radius
  private moonTilt = new Float32Array(MAX_MOONS);
  private moonSize = new Float32Array(MAX_MOONS); // × host radius

  // Nearest-N scan scratch (allocation-free).
  private selIdx = new Int32Array(MAX_PLANETS);
  private selD = new Float32Array(MAX_PLANETS);
  private frame = 0;
  private attrDirty = false;

  // Reused math objects.
  private mat = new THREE.Matrix4();
  private identQuat = new THREE.Quaternion(); // billboards never rotate the mesh itself — see PLANET_VERT
  private pos = new THREE.Vector3();
  private scl = new THREE.Vector3();
  private col = new THREE.Color();
  private hsl = { h: 0, s: 0, l: 0 };
  private zero = new THREE.Matrix4().makeScale(0, 0, 0);

  constructor(
    graph: VaultGraph,
    nodeIds: string[],
    camera: THREE.PerspectiveCamera,
    _pr: number,
    dark: boolean,
    enabled: boolean,
  ) {
    this.graph = graph;
    this.nodeIds = nodeIds;
    this.camera = camera;
    this.dark = dark;

    this.planetMat = new THREE.ShaderMaterial({
      uniforms: { u_time: { value: 0 } },
      vertexShader: PLANET_VERT,
      fragmentShader: PLANET_FRAG,
      transparent: false,
      depthTest: true,
      depthWrite: true,
      // The node's own point sprite sits at the exact same 3D position (it
      // renders depthTest:false/transparent:true — see graphScene.ts's
      // nodeMat — so it always paints over opaque geometry regardless of
      // depth; polygonOffset doesn't fix that). This guards the billboard
      // against fighting OTHER coplanar opaque geometry at nearly the same
      // depth instead — adjacent billboards, edge endpoints — by nudging it
      // a hair toward the camera. Cheap, and invisible as a shape change
      // since polygonOffset biases depth only, never vertex position.
      polygonOffset: true,
      polygonOffsetFactor: -4,
      polygonOffsetUnits: -4,
    });
    // Planets and moons share the material (same shader), but each mesh
    // needs its own geometry so it can carry its own instance count.
    const planetGeom = new THREE.PlaneGeometry(1, 1);
    addQuadAttrs(planetGeom, MAX_PLANETS);
    this.billboards = new THREE.InstancedMesh(planetGeom, this.planetMat, MAX_PLANETS);
    this.billboards.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.billboards.frustumCulled = false;
    this.billboards.visible = enabled;

    const moonGeom = new THREE.PlaneGeometry(1, 1);
    addQuadAttrs(moonGeom, MAX_MOONS);
    this.moons = new THREE.InstancedMesh(moonGeom, this.planetMat, MAX_MOONS);
    this.moons.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.moons.frustumCulled = false;
    this.moons.visible = enabled;

    // Collapse every instance to zero scale until claimed.
    for (let s = 0; s < MAX_PLANETS; s++) this.billboards.setMatrixAt(s, this.zero);
    for (let m = 0; m < MAX_MOONS; m++) this.moons.setMatrixAt(m, this.zero);
    this.billboards.instanceMatrix.needsUpdate = true;
    this.moons.instanceMatrix.needsUpdate = true;

    this.setNodeIds(nodeIds);
  }

  setEnabled(on: boolean): void {
    this.billboards.visible = on;
    this.moons.visible = on;
  }

  // Theme flip: rampFor()'s value curve depends on dark/light, so the cached
  // per-node ramps need recomputing. setNodeIds() both rebuilds them and
  // resets slot claims, which lets rescan() re-fade the (now retinted)
  // planets back in on the next scan.
  setDark(dark: boolean): void {
    if (dark === this.dark) return;
    this.dark = dark;
    this.setNodeIds(this.nodeIds);
  }

  // Rebuild the per-node identity cache (node set / colours may have changed)
  // and reset all slots so no slot references a now-invalid node index.
  setNodeIds(ids: string[]): void {
    this.nodeIds = ids;
    const n = ids.length;
    this.family = new Uint8Array(n);
    this.seed = new Float32Array(n);
    this.ramp = new Float32Array(n * 15);
    this.radius = new Float32Array(n);
    this.nMoons = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      const id = ids[i];
      const a = this.graph.getNodeAttributes(id);
      const sd = seededUnit(id, 11);
      this.seed[i] = sd;
      const archetype = archetypeFor(id, a.deg, a.isHub);
      this.family[i] = PIXEL_ARCHETYPES.indexOf(archetype);
      // Community hue, reused as-is (rampFor does its own clamped rotation
      // per archetype) — no extra per-node jitter on top, archetypeFor()'s
      // own per-node pick plus pixel_planet's per-node seed already vary the
      // silhouette/pattern between same-archetype, same-community planets.
      this.col.set(a.color || fieldStar(false));
      this.col.getHSL(this.hsl);
      writeRamp(this.ramp, i * 15, rampFor(archetype, this.hsl.h * 360, this.dark));
      const isGiant = archetype === "hub"; // only isHub nodes ever reach "hub" (archetypeFor)
      this.radius[i] = isGiant ? 5.0 + sd * 2.5 : 3.0 + sd * 2.0;
      // Moons: giants (and the biggest rocky worlds) get satellites.
      const moonBudget = isGiant ? MOONS_PER : this.radius[i] > 4.4 ? 1 : 0;
      this.nMoons[i] = Math.round(seededUnit(id, 18) * moonBudget);
    }
    this.slotNode.fill(-1);
    this.fade.fill(0);
    this.fadeTarget.fill(0);
  }

  update(dt: number, nodePos: THREE.BufferAttribute, ambient: boolean): void {
    if (!this.billboards.visible) return;
    this.planetMat.uniforms.u_time.value += ambient ? dt : 0;
    if (this.frame++ % SCAN_EVERY === 0) this.rescan(nodePos);

    let anyP = false, anyM = false;
    for (let s = 0; s < MAX_PLANETS; s++) {
      const tgt = this.fadeTarget[s];
      if (this.fade[s] !== tgt) {
        const step = FADE_PER_SEC * dt;
        this.fade[s] = tgt > this.fade[s] ? Math.min(tgt, this.fade[s] + step) : Math.max(tgt, this.fade[s] - step);
      }
      const ni = this.slotNode[s];
      if (ni < 0) continue;
      if (this.fade[s] <= 0 && tgt <= 0) {
        this.slotNode[s] = -1;
        this.billboards.setMatrixAt(s, this.zero);
        for (let m = 0; m < MOONS_PER; m++) this.moons.setMatrixAt(s * MOONS_PER + m, this.zero);
        anyP = anyM = true;
        continue;
      }
      const eased = this.fade[s] * this.fade[s] * (3 - 2 * this.fade[s]);
      const r = this.radius[ni] * eased;
      this.pos.set(nodePos.getX(ni), nodePos.getY(ni), nodePos.getZ(ni));
      this.spin[s] += ambient ? dt * this.spinRate[s] : 0;

      // Planet billboard: translate + uniform scale only (no rotation baked
      // into the mesh — see file header / PLANET_VERT). Quad half-extent is
      // 0.5, so a full width of 2r keeps the visible disc's radius at r,
      // matching the old sphere's radius semantics.
      const w = r * 2;
      this.scl.set(w, w, w);
      this.mat.compose(this.pos, this.identQuat, this.scl);
      this.billboards.setMatrixAt(s, this.mat);
      instAttr(this.billboards, "a_spin").setX(s, this.spin[s]);
      anyP = true;

      // Moons orbiting this planet.
      const moons = this.nMoons[ni];
      for (let m = 0; m < MOONS_PER; m++) {
        const mi = s * MOONS_PER + m;
        if (m >= moons) { this.moons.setMatrixAt(mi, this.zero); anyM = true; continue; }
        this.moonAngle[mi] += ambient ? dt * this.moonSpeed[mi] : 0;
        const ang = this.moonAngle[mi];
        const orb = this.radius[ni] * this.moonOrbit[mi];
        const oz = Math.sin(ang) * orb;
        const st = Math.sin(this.moonTilt[mi]), ct = Math.cos(this.moonTilt[mi]);
        this.pos.set(
          nodePos.getX(ni) + Math.cos(ang) * orb,
          nodePos.getY(ni) - oz * st,
          nodePos.getZ(ni) + oz * ct,
        );
        const mw = this.radius[ni] * this.moonSize[mi] * eased * 2;
        this.scl.set(mw, mw, mw);
        this.mat.compose(this.pos, this.identQuat, this.scl);
        this.moons.setMatrixAt(mi, this.mat);
        instAttr(this.moons, "a_spin").setX(mi, ang * 1.5); // reuse the orbital clock — no extra per-moon accumulator needed
        anyM = true;
      }

      if (this.attrDirty) this.writeSlotAttrs(s, ni);
    }

    if (this.attrDirty) {
      instAttr(this.billboards, "a_family").needsUpdate = true;
      instAttr(this.billboards, "a_seed").needsUpdate = true;
      for (const name of COLOR_ATTRS) instAttr(this.billboards, name).needsUpdate = true;
      instAttr(this.moons, "a_family").needsUpdate = true;
      instAttr(this.moons, "a_seed").needsUpdate = true;
      for (const name of COLOR_ATTRS) instAttr(this.moons, name).needsUpdate = true;
      this.attrDirty = false;
    }
    if (anyP) {
      this.billboards.instanceMatrix.needsUpdate = true;
      instAttr(this.billboards, "a_spin").needsUpdate = true;
    }
    if (anyM) {
      this.moons.instanceMatrix.needsUpdate = true;
      instAttr(this.moons, "a_spin").needsUpdate = true;
    }
  }

  dispose(): void {
    this.billboards.geometry.dispose();
    this.moons.geometry.dispose();
    this.planetMat.dispose();
  }

  // --- internals -----------------------------------------------------------

  private rescan(nodePos: THREE.BufferAttribute): void {
    const cam = this.camera.position;
    const count = Math.min(this.nodeIds.length, nodePos.count);
    let sel = 0, worst = -Infinity, worstK = -1;
    const selD = this.selD;
    for (let i = 0; i < count; i++) {
      if (this.graph.getNodeAttributes(this.nodeIds[i]).hidden) continue;
      const dx = nodePos.getX(i) - cam.x, dy = nodePos.getY(i) - cam.y, dz = nodePos.getZ(i) - cam.z;
      const d = dx * dx + dy * dy + dz * dz;
      if (d >= NEAR_DIST2) continue;
      if (sel < MAX_PLANETS) {
        this.selIdx[sel] = i; selD[sel] = d;
        if (d > worst) { worst = d; worstK = sel; }
        sel++;
      } else if (d < worst) {
        this.selIdx[worstK] = i; selD[worstK] = d;
        worst = -Infinity; worstK = -1;
        for (let k = 0; k < MAX_PLANETS; k++) if (selD[k] > worst) { worst = selD[k]; worstK = k; }
      }
    }

    // Existing slots: keep if still selected, else dissolve.
    for (let s = 0; s < MAX_PLANETS; s++) {
      const ni = this.slotNode[s];
      if (ni < 0) continue;
      let still = false;
      for (let k = 0; k < sel; k++) if (this.selIdx[k] === ni) { still = true; break; }
      this.fadeTarget[s] = still ? 1 : 0;
    }
    // Newly selected nodes with no slot: claim a free slot + roll its moons.
    for (let k = 0; k < sel; k++) {
      const ni = this.selIdx[k];
      let has = false;
      for (let s = 0; s < MAX_PLANETS; s++) if (this.slotNode[s] === ni) { has = true; break; }
      if (has) continue;
      for (let s = 0; s < MAX_PLANETS; s++) {
        if (this.slotNode[s] < 0) {
          this.slotNode[s] = ni;
          this.fade[s] = 0;
          this.fadeTarget[s] = 1;
          const id = this.nodeIds[ni];
          this.spin[s] = seededUnit(id, 14) * Math.PI * 2;
          this.spinRate[s] = SPIN_RATE * (0.75 + seededUnit(id, 15) * 0.5); // ±25% jitter, still "on the order of a minute"
          for (let m = 0; m < MOONS_PER; m++) {
            const mi = s * MOONS_PER + m;
            this.moonAngle[mi] = seededUnit(id, 30 + m) * Math.PI * 2;
            this.moonSpeed[mi] =
              (0.4 + seededUnit(id, 32 + m) * 0.6) * MOON_ORBIT_SCALE * (m % 2 ? -1 : 1);
            this.moonOrbit[mi] = 1.9 + m * 0.7 + seededUnit(id, 34 + m) * 0.4;
            this.moonTilt[mi] = (seededUnit(id, 36 + m) - 0.5) * 1.4;
            this.moonSize[mi] = 0.20 + seededUnit(id, 38 + m) * 0.14;
            this.writeMoonAttrs(mi, id, m);
          }
          this.writeSlotAttrs(s, ni);
          break;
        }
      }
    }
    this.attrDirty = true;
  }

  private writeSlotAttrs(s: number, ni: number): void {
    instAttr(this.billboards, "a_family").setX(s, this.family[ni]);
    instAttr(this.billboards, "a_seed").setX(s, this.seed[ni]);
    const base = ni * 15;
    for (let k = 0; k < 5; k++) {
      instAttr(this.billboards, COLOR_ATTRS[k]).setXYZ(s, this.ramp[base + k * 3], this.ramp[base + k * 3 + 1], this.ramp[base + k * 3 + 2]);
    }
  }

  // Moons are little rock/ice bodies — muted, flavour-neutral (not tinted
  // toward their host's community hue, see MOON_HUE).
  private writeMoonAttrs(mi: number, id: string, m: number): void {
    const archetype: PixelArchetype = seededUnit(id, 40 + m) < 0.6 ? "dead" : "ice";
    const ramp = rampFor(archetype, MOON_HUE, this.dark);
    instAttr(this.moons, "a_family").setX(mi, PIXEL_ARCHETYPES.indexOf(archetype));
    instAttr(this.moons, "a_seed").setX(mi, seededUnit(id, 44 + m));
    for (let k = 0; k < 5; k++) {
      const [r, g, b] = ramp[k];
      instAttr(this.moons, COLOR_ATTRS[k]).setXYZ(mi, r, g, b);
    }
  }
}

function writeRamp(dst: Float32Array, offset: number, ramp: ReturnType<typeof rampFor>): void {
  for (let k = 0; k < 5; k++) {
    dst[offset + k * 3] = ramp[k][0];
    dst[offset + k * 3 + 1] = ramp[k][1];
    dst[offset + k * 3 + 2] = ramp[k][2];
  }
}

function addQuadAttrs(geom: THREE.BufferGeometry, count: number): void {
  geom.setAttribute("a_family", new THREE.InstancedBufferAttribute(new Float32Array(count), 1));
  geom.setAttribute("a_seed", new THREE.InstancedBufferAttribute(new Float32Array(count), 1));
  geom.setAttribute("a_spin", new THREE.InstancedBufferAttribute(new Float32Array(count), 1));
  for (const name of COLOR_ATTRS) {
    geom.setAttribute(name, new THREE.InstancedBufferAttribute(new Float32Array(count * 3), 3));
  }
}

function instAttr(mesh: THREE.InstancedMesh, name: string): THREE.InstancedBufferAttribute {
  return mesh.geometry.getAttribute(name) as THREE.InstancedBufferAttribute;
}
