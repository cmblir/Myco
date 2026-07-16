// Near-field LOD planets — the CLOSE end of the cosmic-scale LOD (galaxy
// imposters are the far end). Far away every note is a cheap glowing star
// point; fly in close and the nodes nearest the camera resolve into small
// procedural worlds. To make a cluster read like a real solar system there are
// ~20 procedural FAMILIES (many banded), each recoloured per-node by its
// community hue so the same family shows up in dozens of variations; big
// bodies (gas giants / hubs) carry rings and are orbited by little MOONS.
//
// Everything is instanced: one sphere InstancedMesh (planets + moons share the
// material), one ring InstancedMesh — so the whole layer stays a handful of
// draw calls regardless of vault size, capped at MAX_PLANETS live worlds. The
// layer owns no node positions: GraphScene feeds the live nodeGeom position
// buffer into update() each frame, so a rebuild() never leaves a stale buffer.
// Opaque spheres (they occlude the faint web behind them); fade is scale
// grow-in, never alpha, so there is no transparency sorting. Albedo is kept
// below the bloom threshold so planets read as solid bodies, not glows.
import * as THREE from "three";
import { fieldStar, seededUnit, type VaultGraph } from "./graphData";

const MAX_PLANETS = 24; // hard cap on live worlds → bounded instances / fill
const MOONS_PER = 2; // max satellites per planet
const MAX_MOONS = MAX_PLANETS * MOONS_PER;
const NEAR_DIST = 130; // world units: planets only materialize this close
const NEAR_DIST2 = NEAR_DIST * NEAR_DIST;
const SCAN_EVERY = 10; // re-pick the nearest set every N frames
const FADE_PER_SEC = 3.0; // materialize / dissolve speed (~0.33 s swing)

// Shader family ids (branch selector in the fragment shader). ~20 families;
// per-node hue + optional rings multiply these into 40+ distinct-looking worlds.
const F = {
  TERRAN: 0, OCEAN: 1, DESERT: 2, LAVA: 3, GAS: 4, ICE_GIANT: 5, TOXIC: 6,
  FROZEN: 7, BARREN: 8, CARBON: 9, STORM: 10, TIDAL: 11, JUNGLE: 12, IRON: 13,
  CRYSTAL: 14, MAGMA: 15, SULFUR: 16, GREEN_GAS: 17, EUROPA: 18, EMBER: 19,
} as const;
const FAMILY_COUNT = 20;
// Families read as "gas/ice giants" — big, banded, ring- and moon-bearing.
const GIANTS: number[] = [F.GAS, F.ICE_GIANT, F.STORM, F.GREEN_GAS];

const SPHERE_VERT = /* glsl */ `
attribute float a_family;
attribute float a_seed;
attribute vec3 a_tint;
varying vec3 v_local;
varying vec3 v_nrm;
varying float v_family;
varying float v_seed;
varying vec3 v_tint;
void main() {
  // instanceMatrix carries translate · spin · scale (three injects it for an
  // InstancedMesh). v_local is the un-rotated object point, so the surface
  // pattern spins WITH the mesh while the view normal turns against the fixed
  // key light → a moving day/night terminator.
  vec4 mv = modelViewMatrix * instanceMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  v_local = normalize(position);
  v_nrm = normalize((modelViewMatrix * instanceMatrix * vec4(normal, 0.0)).xyz);
  v_family = a_family;
  v_seed = a_seed;
  v_tint = a_tint;
}
`;

const SPHERE_FRAG = /* glsl */ `
precision highp float;
varying vec3 v_local;
varying vec3 v_nrm;
varying float v_family;
varying float v_seed;
varying vec3 v_tint;
uniform float u_time;

float hash(vec3 p){ p=fract(p*0.3183099+0.1); p*=17.0; return fract(p.x*p.y*p.z*(p.x+p.y+p.z)); }
float vnoise(vec3 x){
  vec3 i=floor(x); vec3 f=fract(x); f=f*f*(3.0-2.0*f);
  return mix(mix(mix(hash(i+vec3(0.,0.,0.)),hash(i+vec3(1.,0.,0.)),f.x),
                 mix(hash(i+vec3(0.,1.,0.)),hash(i+vec3(1.,1.,0.)),f.x),f.y),
             mix(mix(hash(i+vec3(0.,0.,1.)),hash(i+vec3(1.,0.,1.)),f.x),
                 mix(hash(i+vec3(0.,1.,1.)),hash(i+vec3(1.,1.,1.)),f.x),f.y),f.z);
}
float fbm(vec3 p){ float a=0.5,s=0.0; for(int k=0;k<4;k++){ s+=a*vnoise(p); p*=2.02; a*=0.5; } return s; }

void surface(int type, vec3 P, vec3 t, float seed, out vec3 albedo, out float spec, out vec3 emis){
  spec=0.0; emis=vec3(0.0);
  if(type==0){ // Terran
    float h=fbm(P*3.0+seed); float land=smoothstep(0.50,0.60,h);
    vec3 sea=mix(vec3(0.04,0.18,0.42), t*0.4, 0.5);
    vec3 g=mix(mix(t,vec3(0.30,0.55,0.30),0.4), t*0.6, smoothstep(0.6,0.8,h));
    albedo=mix(sea,g,land);
    float cl=smoothstep(0.55,0.72,fbm(P*3.4+vec3(20.0)+u_time*0.02));
    albedo=mix(albedo,vec3(0.92),cl*0.5); spec=(1.0-land)*0.4;
  } else if(type==1){ // Ocean
    float h=fbm(P*3.2+seed);
    albedo=mix(t*0.32, t*0.72, smoothstep(0.4,0.62,h));
    albedo=mix(albedo,vec3(0.85,0.82,0.6),smoothstep(0.72,0.78,h)*0.5); spec=0.9;
  } else if(type==2){ // Desert
    float d=0.5+0.5*sin(P.y*22.0+3.0*fbm(P*3.0+seed));
    albedo=mix(t*0.55, t*1.05, d)*(0.85+0.25*fbm(P*6.0+seed));
  } else if(type==3){ // Lava
    float c=fbm(P*3.5+seed); albedo=vec3(0.14,0.09,0.08)*(0.6+0.8*c);
    float ck=smoothstep(0.52,0.44,c);
    emis=mix(vec3(1.0,0.35,0.06),vec3(1.0,0.8,0.2),smoothstep(0.44,0.30,c))*ck*1.0;
  } else if(type==4){ // Gas giant
    float b=0.5+0.5*sin(P.y*10.0+2.0*fbm(P*2.0+seed)+u_time*0.35);
    albedo=mix(t*0.5,mix(t,vec3(1.0),0.4),b)+0.05*fbm(P*8.0+seed);
  } else if(type==5){ // Ice giant
    float b=0.5+0.5*sin(P.y*9.0+1.4*fbm(P*1.8+seed));
    albedo=mix(t*0.55,mix(t,vec3(0.8,0.9,1.0),0.5),b);
    albedo=mix(albedo,vec3(0.9,0.95,1.0),smoothstep(0.9,0.97,fbm(P*3.0+seed))*0.4);
  } else if(type==6){ // Toxic
    float sw=fbm(P*2.4+vec3(u_time*0.15,0.,0.)+seed);
    float b=0.5+0.5*sin(P.y*7.0+6.0*sw);
    vec3 c=mix(vec3(0.75,0.82,0.32),t,0.4);
    albedo=mix(c*0.45,mix(c,vec3(0.95,0.95,0.6),0.5),b); emis=c*0.04;
  } else if(type==7){ // Frozen
    float cr=fbm(P*5.0+seed); float rg=abs(cr-0.5)*2.0;
    vec3 ice=mix(vec3(0.82,0.9,1.0), t*0.6+0.4, 0.35);
    albedo=ice*(0.78+0.22*rg); spec=0.5;
  } else if(type==8){ // Barren (cratered)
    float base=fbm(P*3.0+seed); float cr=0.0;
    for(int k=0;k<3;k++){ float n=fbm(P*(6.0+float(k)*4.0)+seed+float(k)*13.0); cr+=smoothstep(0.62,0.66,n)*0.25; }
    vec3 g=mix(vec3(0.5,0.48,0.52), t*0.7, 0.35); albedo=clamp(g*(0.7+0.5*base)-cr,0.05,1.0);
  } else if(type==9){ // Carbon
    float v=fbm(P*4.0+seed); albedo=mix(vec3(0.09,0.09,0.12), t*0.3, 0.3)*(0.7+0.7*v);
    spec=0.6; emis=t*0.02*smoothstep(0.6,0.85,v);
  } else if(type==10){ // Storm giant (great spot)
    float b=0.5+0.5*sin(P.y*9.0+2.0*fbm(P*2.0+seed)+u_time*0.3);
    albedo=mix(t*0.5,mix(t,vec3(1.0),0.4),b);
    vec3 spotC=normalize(vec3(0.5,-0.25,0.83)); float sd=distance(normalize(P),spotC);
    float spot=smoothstep(0.42,0.10,sd);
    float sw=0.5+0.5*sin(atan(P.y+0.25,P.x-0.5)*6.0+u_time*0.6);
    albedo=mix(albedo,mix(vec3(0.9,0.35,0.2),vec3(1.0,0.7,0.4),sw),spot);
  } else if(type==11){ // Tidal-lock (day=lava / night=ice)
    float day=smoothstep(-0.25,0.25,P.x);
    float c=fbm(P*3.5+seed);
    vec3 hot=vec3(0.9,0.3,0.12)*(0.6+0.8*c);
    vec3 hotE=mix(vec3(1.0,0.35,0.06),vec3(1.0,0.8,0.2),0.5)*smoothstep(0.52,0.44,c);
    vec3 cold=mix(vec3(0.80,0.88,1.0), t*0.5+0.5, 0.3)*(0.8+0.2*abs(fbm(P*5.0+seed)-0.5)*2.0);
    albedo=mix(cold,hot,day); emis=hotE*day; spec=(1.0-day)*0.5;
  } else if(type==12){ // Jungle
    float h=fbm(P*3.2+seed); float land=smoothstep(0.42,0.52,h);
    vec3 sea=mix(vec3(0.06,0.3,0.35), t*0.4, 0.5);
    vec3 lush=mix(vec3(0.12,0.42,0.16), mix(t,vec3(0.32,0.6,0.24),0.5), fbm(P*7.0+seed));
    albedo=mix(sea,lush,land);
    float cl=smoothstep(0.6,0.75,fbm(P*3.4+vec3(30.0)+u_time*0.02)); albedo=mix(albedo,vec3(0.9),cl*0.35);
  } else if(type==13){ // Iron / metallic
    float br=0.5+0.5*sin(P.y*30.0+2.0*fbm(P*3.0+seed));
    albedo=mix(vec3(0.55,0.53,0.5), t*0.8, 0.4)*(0.6+0.5*br); spec=1.0;
  } else if(type==14){ // Crystal
    float cell=fbm(P*4.0+seed); float facet=smoothstep(0.35,0.65,fract(cell*6.0));
    albedo=mix(t*0.4,t,facet); emis=t*facet*0.22; spec=0.8;
  } else if(type==15){ // Magma ocean
    float c=fbm(P*2.6+seed); float crust=smoothstep(0.52,0.62,c);
    vec3 rock=vec3(0.16,0.11,0.10)*(0.7+0.6*fbm(P*5.0+seed));
    albedo=mix(rock*0.6, rock, crust);
    emis=mix(vec3(1.0,0.4,0.08),vec3(1.0,0.7,0.2),0.5)*(1.0-crust)*0.9;
  } else if(type==16){ // Sulfur (Io-like)
    float v=fbm(P*3.4+seed);
    vec3 a1=vec3(0.9,0.8,0.3), a2=vec3(0.75,0.4,0.15);
    albedo=mix(mix(a2,a1,v), t, 0.2);
    float vent=smoothstep(0.82,0.9,fbm(P*6.0+seed)); emis=vec3(1.0,0.5,0.1)*vent*0.5;
  } else if(type==17){ // Green gas
    float b=0.5+0.5*sin(P.y*10.0+2.0*fbm(P*2.0+seed)+u_time*0.3);
    vec3 c=mix(vec3(0.35,0.7,0.4), t, 0.35);
    albedo=mix(c*0.5,mix(c,vec3(0.9,1.0,0.85),0.4),b);
  } else if(type==18){ // Europa (ice + subsurface cracks)
    float base=0.9; float lines=smoothstep(0.02,0.0,abs(fract(fbm(P*3.0+seed)*8.0)-0.5)-0.02);
    vec3 ice=mix(vec3(0.86,0.9,0.96), t*0.5+0.5, 0.25);
    albedo=ice*base; albedo=mix(albedo, mix(vec3(0.7,0.45,0.35),t,0.3), lines*0.6); spec=0.4;
  } else { // Ember (dying world, faint glow)
    float c=fbm(P*3.2+seed); albedo=mix(vec3(0.2,0.08,0.07), t*0.4, 0.3)*(0.6+0.6*c);
    emis=vec3(0.6,0.15,0.05)*smoothstep(0.55,0.75,c)*0.35;
  }
  albedo=clamp(albedo,0.0,0.96);
}

void main() {
  vec3 n = normalize(v_nrm);
  vec3 albedo; float spec; vec3 emis;
  surface(int(v_family + 0.5), v_local, v_tint, v_seed * 37.0, albedo, spec, emis);
  vec3 L = normalize(vec3(0.5, 0.6, 0.8)); // fixed view-space key light (no scene lights)
  float term = smoothstep(-0.25, 0.35, dot(n, L));
  vec3 col = albedo * (0.16 + 0.9 * term) + albedo * v_tint * 0.08 * (1.0 - term);
  if (spec > 0.001) {
    vec3 H = normalize(L + vec3(0.0, 0.0, 1.0));
    col += vec3(1.0) * pow(max(dot(n, H), 0.0), 40.0) * spec * term;
  }
  col += emis; // lava / crystal / ember self-illum
  float rim = pow(1.0 - clamp(dot(n, vec3(0.0, 0.0, 1.0)), 0.0, 1.0), 3.0);
  col += v_tint * rim * 0.12;
  gl_FragColor = vec4(clamp(col, 0.0, 1.6), 1.0); // < bloom threshold (1.9): solid, not glowing
}
`;

const RING_INNER = 1.35;
const RING_OUTER = 2.15;

const RING_VERT = /* glsl */ `
attribute float a_seed;
attribute vec3 a_tint;
varying float v_r;
varying float v_seed;
varying vec3 v_tint;
void main() {
  gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
  v_r = length(position.xy);
  v_seed = a_seed;
  v_tint = a_tint;
}
`;

const RING_FRAG = /* glsl */ `
precision highp float;
varying float v_r;
varying float v_seed;
varying vec3 v_tint;
void main() {
  float t = (v_r - ${RING_INNER.toFixed(2)}) / (${(RING_OUTER - RING_INNER).toFixed(2)});
  if (t < 0.0 || t > 1.0) discard;
  float bands = 0.5 + 0.5 * sin(t * 42.0 + v_seed * 25.0);
  float gap = smoothstep(0.03, 0.10, abs(fract(t * 3.0 + v_seed) - 0.5));
  float edge = smoothstep(0.0, 0.09, t) * smoothstep(1.0, 0.82, t);
  float a = bands * gap * edge * 0.7;
  if (a < 0.01) discard;
  gl_FragColor = vec4(v_tint * (0.6 + 0.6 * bands), a);
}
`;

export class PlanetLayer {
  readonly sphere: THREE.InstancedMesh; // planets
  readonly rings: THREE.InstancedMesh;
  readonly moons: THREE.InstancedMesh; // little satellites orbiting big planets
  private sphereMat: THREE.ShaderMaterial;
  private ringMat: THREE.ShaderMaterial;
  private moonMat: THREE.ShaderMaterial;
  private graph: VaultGraph;
  private nodeIds: string[];
  private camera: THREE.PerspectiveCamera;

  // Per-node identity cache (indexed like nodeIds / the position buffer).
  private family = new Uint8Array(0);
  private seed = new Float32Array(0);
  private tint = new Float32Array(0); // rgb triplets
  private radius = new Float32Array(0);
  private ring = new Uint8Array(0);
  private tilt = new Float32Array(0);
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
  private quat = new THREE.Quaternion();
  private pos = new THREE.Vector3();
  private scl = new THREE.Vector3();
  private euler = new THREE.Euler();
  private col = new THREE.Color();
  private zero = new THREE.Matrix4().makeScale(0, 0, 0);

  constructor(
    graph: VaultGraph,
    nodeIds: string[],
    camera: THREE.PerspectiveCamera,
    _pr: number,
    _dark: boolean,
    enabled: boolean,
  ) {
    this.graph = graph;
    this.nodeIds = nodeIds;
    this.camera = camera;

    this.sphereMat = new THREE.ShaderMaterial({
      uniforms: { u_time: { value: 0 } },
      vertexShader: SPHERE_VERT,
      fragmentShader: SPHERE_FRAG,
      transparent: false,
      depthTest: true,
      depthWrite: true,
    });
    // Planets and moons share the material (same lighting/surface shader), but
    // each mesh needs its own geometry so it can carry its own instance count.
    const planetGeom = new THREE.IcosahedronGeometry(1, 3);
    addSphereAttrs(planetGeom, MAX_PLANETS);
    this.sphere = new THREE.InstancedMesh(planetGeom, this.sphereMat, MAX_PLANETS);
    this.sphere.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.sphere.frustumCulled = false;
    this.sphere.visible = enabled;

    this.moonMat = this.sphereMat; // identical shading
    const moonGeom = new THREE.IcosahedronGeometry(1, 2); // fewer tris — moons are tiny
    addSphereAttrs(moonGeom, MAX_MOONS);
    this.moons = new THREE.InstancedMesh(moonGeom, this.moonMat, MAX_MOONS);
    this.moons.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.moons.frustumCulled = false;
    this.moons.visible = enabled;

    const ringGeom = new THREE.RingGeometry(RING_INNER, RING_OUTER, 64, 1);
    ringGeom.setAttribute("a_seed", new THREE.InstancedBufferAttribute(new Float32Array(MAX_PLANETS), 1));
    ringGeom.setAttribute("a_tint", new THREE.InstancedBufferAttribute(new Float32Array(MAX_PLANETS * 3), 3));
    this.ringMat = new THREE.ShaderMaterial({
      uniforms: {},
      vertexShader: RING_VERT,
      fragmentShader: RING_FRAG,
      transparent: true,
      depthTest: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
    });
    this.rings = new THREE.InstancedMesh(ringGeom, this.ringMat, MAX_PLANETS);
    this.rings.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.rings.frustumCulled = false;
    this.rings.visible = enabled;

    // Collapse every instance to zero scale until claimed.
    for (let s = 0; s < MAX_PLANETS; s++) { this.sphere.setMatrixAt(s, this.zero); this.rings.setMatrixAt(s, this.zero); }
    for (let m = 0; m < MAX_MOONS; m++) this.moons.setMatrixAt(m, this.zero);
    this.sphere.instanceMatrix.needsUpdate = true;
    this.rings.instanceMatrix.needsUpdate = true;
    this.moons.instanceMatrix.needsUpdate = true;

    this.setNodeIds(nodeIds);
  }

  setEnabled(on: boolean): void {
    this.sphere.visible = on;
    this.rings.visible = on;
    this.moons.visible = on;
  }

  // Rebuild the per-node identity cache (node set / colours may have changed)
  // and reset all slots so no slot references a now-invalid node index.
  setNodeIds(ids: string[]): void {
    this.nodeIds = ids;
    const n = ids.length;
    this.family = new Uint8Array(n);
    this.seed = new Float32Array(n);
    this.tint = new Float32Array(n * 3);
    this.radius = new Float32Array(n);
    this.ring = new Uint8Array(n);
    this.tilt = new Float32Array(n);
    this.nMoons = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      const id = ids[i];
      const a = this.graph.getNodeAttributes(id);
      const sd = seededUnit(id, 11);
      const fam = planetFamily(id, a);
      this.family[i] = fam;
      this.seed[i] = sd;
      // Community hue, jittered per-node so a family shows up in many colours.
      this.col.set(a.color || fieldStar(false));
      const jl = 0.8 + seededUnit(id, 21) * 0.5; // ±lightness
      this.col.offsetHSL((seededUnit(id, 22) - 0.5) * 0.08, 0, 0);
      this.tint[i * 3] = Math.min(1, this.col.r * jl);
      this.tint[i * 3 + 1] = Math.min(1, this.col.g * jl);
      this.tint[i * 3 + 2] = Math.min(1, this.col.b * jl);
      const giant = GIANTS.indexOf(fam) >= 0;
      this.radius[i] = giant ? 5.0 + sd * 2.5 : 3.0 + sd * 2.0;
      // Rings: common on giants, rare elsewhere.
      this.ring[i] = seededUnit(id, 17) < (giant ? 0.55 : 0.12) ? 1 : 0;
      this.tilt[i] = (seededUnit(id, 13) - 0.5) * 1.2;
      // Moons: giants (and the biggest rocky worlds) get satellites.
      const moonBudget = giant ? MOONS_PER : this.radius[i] > 4.4 ? 1 : 0;
      this.nMoons[i] = Math.round(seededUnit(id, 18) * moonBudget);
    }
    this.slotNode.fill(-1);
    this.fade.fill(0);
    this.fadeTarget.fill(0);
  }

  update(dt: number, nodePos: THREE.BufferAttribute, ambient: boolean): void {
    if (!this.sphere.visible) return;
    this.sphereMat.uniforms.u_time.value += ambient ? dt : 0;
    if (this.frame++ % SCAN_EVERY === 0) this.rescan(nodePos);

    let anyP = false, anyR = false, anyM = false;
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
        this.sphere.setMatrixAt(s, this.zero);
        this.rings.setMatrixAt(s, this.zero);
        for (let m = 0; m < MOONS_PER; m++) this.moons.setMatrixAt(s * MOONS_PER + m, this.zero);
        anyP = anyR = anyM = true;
        continue;
      }
      const eased = this.fade[s] * this.fade[s] * (3 - 2 * this.fade[s]);
      const r = this.radius[ni] * eased;
      this.pos.set(nodePos.getX(ni), nodePos.getY(ni), nodePos.getZ(ni));
      this.spin[s] += ambient ? dt * this.spinRate[s] : 0;

      // Planet sphere.
      this.euler.set(0, this.spin[s], 0);
      this.quat.setFromEuler(this.euler);
      this.scl.set(r, r, r);
      this.mat.compose(this.pos, this.quat, this.scl);
      this.sphere.setMatrixAt(s, this.mat);
      anyP = true;

      // Ring (only ringed nodes; others collapsed to zero, still one draw).
      if (this.ring[ni]) {
        this.euler.set(Math.PI / 2 + this.tilt[ni], this.spin[s] * 0.15, 0);
        this.quat.setFromEuler(this.euler);
        this.scl.set(r, r, r);
        this.mat.compose(this.pos, this.quat, this.scl);
      } else {
        this.mat.copy(this.zero);
      }
      this.rings.setMatrixAt(s, this.mat);
      anyR = true;

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
        const mr = this.radius[ni] * this.moonSize[mi] * eased;
        this.euler.set(0, ang * 1.5, 0);
        this.quat.setFromEuler(this.euler);
        this.scl.set(mr, mr, mr);
        this.mat.compose(this.pos, this.quat, this.scl);
        this.moons.setMatrixAt(mi, this.mat);
        anyM = true;
      }

      if (this.attrDirty) this.writeSlotAttrs(s, ni);
    }

    if (this.attrDirty) {
      instAttr(this.sphere, "a_family").needsUpdate = true;
      instAttr(this.sphere, "a_seed").needsUpdate = true;
      instAttr(this.sphere, "a_tint").needsUpdate = true;
      instAttr(this.rings, "a_seed").needsUpdate = true;
      instAttr(this.rings, "a_tint").needsUpdate = true;
      instAttr(this.moons, "a_family").needsUpdate = true;
      instAttr(this.moons, "a_seed").needsUpdate = true;
      instAttr(this.moons, "a_tint").needsUpdate = true;
      this.attrDirty = false;
    }
    if (anyP) this.sphere.instanceMatrix.needsUpdate = true;
    if (anyR) this.rings.instanceMatrix.needsUpdate = true;
    if (anyM) this.moons.instanceMatrix.needsUpdate = true;
  }

  dispose(): void {
    this.sphere.geometry.dispose();
    this.rings.geometry.dispose();
    this.moons.geometry.dispose();
    this.sphereMat.dispose();
    this.ringMat.dispose();
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
          this.spinRate[s] = 0.08 + seededUnit(id, 15) * 0.22;
          for (let m = 0; m < MOONS_PER; m++) {
            const mi = s * MOONS_PER + m;
            this.moonAngle[mi] = seededUnit(id, 30 + m) * Math.PI * 2;
            this.moonSpeed[mi] = (0.4 + seededUnit(id, 32 + m) * 0.6) * (m % 2 ? -1 : 1);
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
    instAttr(this.sphere, "a_family").setX(s, this.family[ni]);
    instAttr(this.sphere, "a_seed").setX(s, this.seed[ni]);
    instAttr(this.sphere, "a_tint").setXYZ(s, this.tint[ni * 3], this.tint[ni * 3 + 1], this.tint[ni * 3 + 2]);
    instAttr(this.rings, "a_seed").setX(s, this.seed[ni]);
    instAttr(this.rings, "a_tint").setXYZ(s, this.tint[ni * 3], this.tint[ni * 3 + 1], this.tint[ni * 3 + 2]);
  }

  // Moons are little barren/icy bodies — muted, tinted toward grey.
  private writeMoonAttrs(mi: number, id: string, m: number): void {
    const fam = seededUnit(id, 40 + m) < 0.6 ? F.BARREN : F.FROZEN;
    const g = 0.55 + seededUnit(id, 42 + m) * 0.2;
    instAttr(this.moons, "a_family").setX(mi, fam);
    instAttr(this.moons, "a_seed").setX(mi, seededUnit(id, 44 + m));
    instAttr(this.moons, "a_tint").setXYZ(mi, g, g, g * 1.05);
  }
}

function addSphereAttrs(geom: THREE.BufferGeometry, count: number): void {
  geom.setAttribute("a_family", new THREE.InstancedBufferAttribute(new Float32Array(count), 1));
  geom.setAttribute("a_seed", new THREE.InstancedBufferAttribute(new Float32Array(count), 1));
  geom.setAttribute("a_tint", new THREE.InstancedBufferAttribute(new Float32Array(count * 3), 3));
}

function instAttr(mesh: THREE.InstancedMesh, name: string): THREE.InstancedBufferAttribute {
  return mesh.geometry.getAttribute(name) as THREE.InstancedBufferAttribute;
}

// Deterministic family from the node's id + role. Hubs are gas/storm giants;
// super-connected nodes turn molten; orphans go barren/frozen; the rest spread
// across the whole palette by seed (with light nudges from wiki frontmatter).
export function planetFamily(
  id: string,
  a: { isHub: boolean; community: number; deg: number; nodeType?: string; confidence?: string; status?: string; sourceCount?: number },
): number {
  const r = seededUnit(id, 12);
  if (a.isHub) return r < 0.45 ? F.GAS : r < 0.72 ? F.STORM : r < 0.88 ? F.GREEN_GAS : F.ICE_GIANT;
  if (a.deg >= 14) return r < 0.5 ? F.LAVA : F.MAGMA; // super-connected → molten
  if (a.community < 0) return r < 0.5 ? F.BARREN : r < 0.8 ? F.FROZEN : F.EUROPA; // orphans
  const conf = (a.confidence ?? "").toLowerCase();
  if (conf === "low" || a.status === "draft") return r < 0.5 ? F.TOXIC : F.EMBER;
  if ((a.sourceCount ?? 0) >= 4) return r < 0.4 ? F.OCEAN : r < 0.75 ? F.TERRAN : F.JUNGLE;
  const nt = (a.nodeType ?? "").toLowerCase();
  if (nt === "entity" || nt === "technique") return r < 0.5 ? F.DESERT : F.IRON;
  // Everyone else: spread across the full palette for variety.
  return Math.floor(r * FAMILY_COUNT) % FAMILY_COUNT;
}
