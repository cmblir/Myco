// Spaceship controller — an immersive third-person flight rig for the graph.
// The hull is a real CC0 spaceship model (Quaternius, src/assets/spaceship.glb)
// loaded at runtime, with the old procedural primitives kept as an instant
// fallback until (or in case) the GLB fails. Flight is inertial (shipPhysics):
// WASD/R/F thrust accelerates, drag glides the ship out when keys lift, Shift
// boosts, and the hull banks into turns like an aircraft. The engine glow
// swells with throttle and a particle trail streams from the tail under
// thrust. Q/E roll, arrows or mouse-drag steer, camera chases from behind.
//
// Listeners live only while enabled, so keys never leak into inputs / orbit.
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import shipUrl from "../assets/spaceship.glb?url";
import { FLIGHT, speedOf, stepBank, stepVelocity } from "./shipPhysics";

// Normalised hull size: the GLB is uniform-scaled so its longest dimension
// lands here (world units). 5.2 read as a speck from the chase distance —
// 7 fills the frame like a piloted craft without blocking the view ahead.
const SHIP_SIZE = 10;
// Engine tail in ship-local space (+Z aft). Past the hull's rear (~4.4 at
// SHIP_SIZE 10) so the glow doesn't bleed through the fuselage mid-body.
const TAIL = new THREE.Vector3(0, 0.3, 4.8);

// Thruster trail: a small pooled Points cloud streaming aft under thrust.
const TRAIL_MAX = 90;
const TRAIL_LIFE = 0.55; // seconds
// Theme-branched exhaust colours: ice glow summed additively on dark, deep
// blue drawn normally on light (additive light-blue vanishes on white paper).
const TRAIL_COLOR_DARK = new THREE.Color("#7fd0ff");
const TRAIL_COLOR_LIGHT = new THREE.Color("#2b5fa8");
const WHITE = new THREE.Color(1, 1, 1);

export class ShipController {
  readonly ship: THREE.Group;
  private body: THREE.Group; // banks + bobs; hull mesh lives inside
  private engineGlow: THREE.Points;
  private glowMat: THREE.PointsMaterial;
  private camera: THREE.PerspectiveCamera;
  private dom: HTMLElement;
  private scene: THREE.Scene;
  private enabled = false;
  private keys = new Set<string>();
  private dragging = false;
  private lastX = 0;
  private lastY = 0;
  private bob = 0;
  // Inertial flight state (shipPhysics integrates it).
  private vel = { x: 0, y: 0, z: 0 };
  private bank = 0;
  private yawRate = 0; // smoothed rad/s, feeds the visual bank
  private yawAccum = 0; // yaw applied since the last update()
  private dark = true; // theme branch (hull tint, exhaust blending)
  // Thruster trail pool (ring buffer; dead particles have life ≤ 0).
  private trail: THREE.Points;
  private trailGeom: THREE.BufferGeometry;
  private trailMat: THREE.ShaderMaterial;
  private trailVel = new Float32Array(TRAIL_MAX * 3);
  private trailLife = new Float32Array(TRAIL_MAX);
  private trailCursor = 0;
  // scratch
  private q = new THREE.Quaternion();
  private v = new THREE.Vector3();
  private v2 = new THREE.Vector3();
  // Behind (+Z) and above the ship — high enough that the flat wings read as
  // a shape instead of an edge-on line.
  private camOffset = new THREE.Vector3(0, 3.2, 13);
  private lookAhead = new THREE.Vector3(0, 2, -40); // look out past the ship into the graph

  constructor(
    camera: THREE.PerspectiveCamera,
    dom: HTMLElement,
    scene: THREE.Scene,
    _speed = 600, // legacy tuning knob; flight now comes from shipPhysics.FLIGHT
  ) {
    this.camera = camera;
    this.dom = dom;
    this.scene = scene;
    this.ship = new THREE.Group();
    this.body = new THREE.Group();
    this.ship.add(this.body);
    this.body.add(buildFallbackHull());
    const { points, mat } = buildEngineGlow();
    this.engineGlow = points;
    this.glowMat = mat;
    this.ship.add(this.engineGlow);
    this.ship.visible = false;
    scene.add(this.ship);
    this.loadHull();

    // Thruster trail lives in WORLD space (particles stay behind as the ship
    // moves on), so it's a scene child, not a ship child.
    this.trailGeom = new THREE.BufferGeometry();
    this.trailGeom.setAttribute(
      "position",
      new THREE.BufferAttribute(new Float32Array(TRAIL_MAX * 3), 3),
    );
    this.trailGeom.setAttribute(
      "a_pcolor",
      new THREE.BufferAttribute(new Float32Array(TRAIL_MAX * 3), 3),
    );
    // window guard: unit tests construct the controller in a node env.
    const pr =
      typeof window !== "undefined" ? Math.min(window.devicePixelRatio || 1, 2) : 1;
    this.trailMat = new THREE.ShaderMaterial({
      uniforms: { u_pixelRatio: { value: pr } },
      vertexShader: /* glsl */ `
attribute vec3 a_pcolor;
uniform float u_pixelRatio;
varying vec3 v_color;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = clamp(140.0 * u_pixelRatio / max(1.0, -mv.z), 1.5, 9.0);
  v_color = a_pcolor;
}
`,
      fragmentShader: /* glsl */ `
precision mediump float;
varying vec3 v_color;
void main() {
  float d = length(gl_PointCoord - vec2(0.5)) * 2.0;
  float a = pow(max(0.0, 1.0 - d), 1.8);
  if (a < 0.02) discard;
  gl_FragColor = vec4(v_color, a);
}
`,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.trail = new THREE.Points(this.trailGeom, this.trailMat);
    this.trail.frustumCulled = false;
    this.trail.visible = false;
    scene.add(this.trail);
  }

  // Swap the placeholder primitives for the bundled GLB. The model's nose
  // points +Z, so it's flipped to the rig's forward (−Z) and uniform-scaled to
  // SHIP_SIZE. Failures just keep the fallback hull — flying still works.
  private loadHull(): void {
    // Browser only: GLTFLoader fetches a root-relative URL (and decodes
    // textures via DOM APIs), neither of which exists in the node test env —
    // there the procedural fallback hull simply stays.
    if (typeof document === "undefined") return;
    new GLTFLoader().load(
      shipUrl,
      (gltf) => {
        const model = gltf.scene;
        // The scene has NO lights (everything else is shader/Basic material),
        // so the GLB's PBR materials render pitch black. Swap each for an
        // unlit MeshBasicMaterial keeping the albedo colour/texture.
        model.traverse((o) => {
          const mesh = o as THREE.Mesh;
          if (!mesh.isMesh) return;
          const convert = (m: THREE.Material): THREE.Material => {
            const std = m as THREE.MeshStandardMaterial;
            const flat = new THREE.MeshBasicMaterial({
              color: std.color ? std.color.clone() : new THREE.Color(0xcfd6e6),
              map: std.map ?? null,
              vertexColors: std.vertexColors ?? false,
            });
            flat.userData.baseColor = flat.color.clone();
            m.dispose();
            return flat;
          };
          mesh.material = Array.isArray(mesh.material)
            ? mesh.material.map(convert)
            : convert(mesh.material);
        });
        const box = new THREE.Box3().setFromObject(model);
        const dims = box.getSize(new THREE.Vector3());
        const scale = SHIP_SIZE / Math.max(dims.x, dims.y, dims.z, 1e-6);
        const centre = box.getCenter(new THREE.Vector3());
        model.position.sub(centre); // recentre on the flight origin
        const wrap = new THREE.Group();
        wrap.add(model);
        wrap.scale.setScalar(scale);
        wrap.rotation.y = Math.PI; // GLB nose +Z → rig forward −Z
        this.body.clear();
        this.body.add(wrap);
        this.applyHullTint();
      },
      undefined,
      () => {
        /* keep the procedural fallback hull */
      },
    );
  }

  enable(): void {
    if (this.enabled) return;
    this.enabled = true;
    // Seat the ship a little ahead of where the camera was looking, facing the
    // same way, then snap the camera behind it — so entering doesn't teleport.
    const fwd = this.v.set(0, 0, -1).applyQuaternion(this.camera.quaternion).normalize();
    this.ship.position.copy(this.camera.position).addScaledVector(fwd, 30);
    this.ship.quaternion.copy(this.camera.quaternion);
    this.ship.visible = true;
    this.trail.visible = true;
    this.vel = { x: 0, y: 0, z: 0 };
    this.bank = 0;
    this.yawRate = 0;
    this.trailLife.fill(0);
    window.addEventListener("keydown", this.onKeyDown);
    window.addEventListener("keyup", this.onKeyUp);
    this.dom.addEventListener("pointerdown", this.onDown);
    window.addEventListener("pointermove", this.onMove);
    window.addEventListener("pointerup", this.onUp);
    this.syncCamera(true);
  }

  disable(): void {
    if (!this.enabled) return;
    this.enabled = false;
    this.ship.visible = false;
    this.trail.visible = false;
    this.keys.clear();
    this.dragging = false;
    window.removeEventListener("keydown", this.onKeyDown);
    window.removeEventListener("keyup", this.onKeyUp);
    this.dom.removeEventListener("pointerdown", this.onDown);
    window.removeEventListener("pointermove", this.onMove);
    window.removeEventListener("pointerup", this.onUp);
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  /** Current flight speed in world units/s (for the HUD readout). */
  getSpeed(): number {
    return speedOf(this.vel);
  }

  /** Theme branch: on light backgrounds the pale hull washes out and additive
   * exhaust vanishes — darken the hull and draw the glow/trail normally. */
  setDark(dark: boolean): void {
    this.dark = dark;
    this.applyHullTint();
    const blending = dark ? THREE.AdditiveBlending : THREE.NormalBlending;
    this.glowMat.blending = blending;
    this.glowMat.color.set(dark ? 0x7fd0ff : 0x2b5fa8);
    this.glowMat.needsUpdate = true;
    this.trailMat.blending = blending;
    this.trailMat.needsUpdate = true;
  }

  private applyHullTint(): void {
    const k = this.dark ? 1 : 0.45; // slate silhouette on paper
    this.body.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const m of mats) {
        const basic = m as THREE.MeshBasicMaterial;
        if (!basic.color) continue;
        const base = (basic.userData.baseColor ??= basic.color.clone());
        basic.color.copy(base).multiplyScalar(k);
      }
    });
  }

  private isTyping(): boolean {
    const el = document.activeElement as HTMLElement | null;
    return (
      !!el &&
      (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)
    );
  }

  private onKeyDown = (e: KeyboardEvent): void => {
    if (this.isTyping()) return;
    const k = e.key.toLowerCase();
    // Swallow keys that would otherwise scroll the page while flying.
    if (
      [
        "w", "a", "s", "d", "q", "e", "r", "f", " ",
        "arrowup", "arrowdown", "arrowleft", "arrowright",
        "shift",
      ].includes(k) ||
      k === "pageup" || k === "pagedown" || k === "home" || k === "end"
    ) {
      e.preventDefault();
    }
    this.keys.add(k);
  };

  private onKeyUp = (e: KeyboardEvent): void => {
    this.keys.delete(e.key.toLowerCase());
  };

  private onDown = (e: PointerEvent): void => {
    if (e.button !== 0) return;
    this.dragging = true;
    this.lastX = e.clientX;
    this.lastY = e.clientY;
  };
  private onMove = (e: PointerEvent): void => {
    if (!this.dragging) return;
    const dx = e.clientX - this.lastX;
    const dy = e.clientY - this.lastY;
    this.lastX = e.clientX;
    this.lastY = e.clientY;
    // Yaw around the ship's local up, pitch around its local right.
    this.rotateLocal(0, 1, 0, -dx * 0.004, true);
    this.rotateLocal(1, 0, 0, -dy * 0.004, false);
  };
  private onUp = (): void => {
    this.dragging = false;
  };

  private rotateLocal(ax: number, ay: number, az: number, rad: number, isYaw = false): void {
    this.q.setFromAxisAngle(this.v.set(ax, ay, az), rad);
    this.ship.quaternion.multiply(this.q);
    if (isYaw) this.yawAccum += rad; // feeds the visual bank
  }

  update(dt: number): void {
    if (!this.enabled || dt <= 0) return;
    const k = this.keys;
    // Steering: roll + keyboard yaw/pitch (arrows) for no-mouse flying.
    if (k.has("q")) this.rotateLocal(0, 0, 1, 1.2 * dt, false);
    if (k.has("e")) this.rotateLocal(0, 0, 1, -1.2 * dt, false);
    if (k.has("arrowleft")) this.rotateLocal(0, 1, 0, 1.2 * dt, true);
    if (k.has("arrowright")) this.rotateLocal(0, 1, 0, -1.2 * dt, true);
    if (k.has("arrowup")) this.rotateLocal(1, 0, 0, 1.2 * dt, false);
    if (k.has("arrowdown")) this.rotateLocal(1, 0, 0, -1.2 * dt, false);

    // Thrust: sum the local axes, rotate to world, integrate with inertia.
    const t = this.v2.set(0, 0, 0);
    if (k.has("w")) t.z -= 1;
    if (k.has("s")) t.z += 1;
    if (k.has("a")) t.x -= 1;
    if (k.has("d")) t.x += 1;
    if (k.has("r") || k.has(" ")) t.y += 1;
    if (k.has("f")) t.y -= 1;
    const thrusting = t.lengthSq() > 0;
    if (thrusting) t.normalize().applyQuaternion(this.ship.quaternion);
    this.vel = stepVelocity(this.vel, t, k.has("shift"), dt);
    this.ship.position.x += this.vel.x * dt;
    this.ship.position.y += this.vel.y * dt;
    this.ship.position.z += this.vel.z * dt;

    // Visual bank: smooth the yaw input into a rate, roll the hull into it.
    this.yawRate += ((this.yawAccum / dt) - this.yawRate) * Math.min(1, dt * 10);
    this.yawAccum = 0;
    this.bank = stepBank(this.bank, this.yawRate, dt);
    this.body.rotation.z = this.bank;

    // Engine: glow swells with throttle; the trail streams while thrusting.
    const throttle = Math.min(1, this.getSpeed() / FLIGHT.maxSpeed);
    this.glowMat.opacity = 0.35 + 0.6 * throttle;
    this.glowMat.size = 18 + 16 * throttle;
    this.updateTrail(dt, thrusting, throttle);

    // Idle bob so a stationary ship still feels alive.
    this.bob += dt;
    this.syncCamera(false);
  }

  // Spawn/advance the aft particle stream. Particles live in world space with
  // a kick opposite the ship's heading plus a little jitter, fading over
  // TRAIL_LIFE. Zero-alloc: fixed ring buffer, colours encode the fade.
  private updateTrail(dt: number, thrusting: boolean, throttle: number): void {
    const pos = this.trailGeom.getAttribute("position") as THREE.BufferAttribute;
    const col = this.trailGeom.getAttribute("a_pcolor") as THREE.BufferAttribute;
    if (thrusting) {
      const tail = this.v.copy(TAIL).applyQuaternion(this.ship.quaternion).add(this.ship.position);
      const aft = this.v2.set(0, 0, 1).applyQuaternion(this.ship.quaternion);
      const spawn = 2 + Math.round(throttle * 2);
      for (let s = 0; s < spawn; s++) {
        const i = this.trailCursor;
        this.trailCursor = (this.trailCursor + 1) % TRAIL_MAX;
        pos.setXYZ(
          i,
          tail.x + (Math.random() - 0.5) * 0.5,
          tail.y + (Math.random() - 0.5) * 0.5,
          tail.z + (Math.random() - 0.5) * 0.5,
        );
        const kick = 60 + 90 * throttle;
        this.trailVel[i * 3] = aft.x * kick + (Math.random() - 0.5) * 14;
        this.trailVel[i * 3 + 1] = aft.y * kick + (Math.random() - 0.5) * 14;
        this.trailVel[i * 3 + 2] = aft.z * kick + (Math.random() - 0.5) * 14;
        this.trailLife[i] = TRAIL_LIFE;
      }
    }
    for (let i = 0; i < TRAIL_MAX; i++) {
      if (this.trailLife[i] <= 0) {
        col.setXYZ(i, 0, 0, 0); // additive black = invisible
        continue;
      }
      this.trailLife[i] -= dt;
      pos.setXYZ(
        i,
        pos.getX(i) + this.trailVel[i * 3] * dt,
        pos.getY(i) + this.trailVel[i * 3 + 1] * dt,
        pos.getZ(i) + this.trailVel[i * 3 + 2] * dt,
      );
      const f = Math.max(0, this.trailLife[i] / TRAIL_LIFE);
      // Dark: additive → scale toward black. Light: normal blending over a
      // near-white bg → fade toward white instead, so dying particles vanish
      // into the paper rather than turning into black specks.
      const base = this.dark ? TRAIL_COLOR_DARK : TRAIL_COLOR_LIGHT;
      if (this.dark) {
        col.setXYZ(i, base.r * f, base.g * f, base.b * f);
      } else {
        col.setXYZ(
          i,
          WHITE.r + (base.r - WHITE.r) * f,
          WHITE.g + (base.g - WHITE.g) * f,
          WHITE.b + (base.b - WHITE.b) * f,
        );
      }
    }
    pos.needsUpdate = true;
    col.needsUpdate = true;
  }

  // Place the camera behind + above the ship, looking ahead of it. `snap` places
  // it exactly; otherwise it eases for a smooth chase.
  private syncCamera(snap: boolean): void {
    const targetPos = this.v.copy(this.camOffset).applyQuaternion(this.ship.quaternion).add(this.ship.position);
    // 0.15 lagged so far behind at cruise speed that the ship shrank to a
    // speck — 0.25 keeps the chase smooth but the hull framed.
    if (snap) this.camera.position.copy(targetPos);
    else this.camera.position.lerp(targetPos, 0.25);
    const look = this.lookAhead.clone().applyQuaternion(this.ship.quaternion).add(this.ship.position);
    this.camera.up.set(0, 1, 0).applyQuaternion(this.ship.quaternion);
    this.camera.lookAt(look);
    // Gentle idle bob on the hull (does not affect flight path or banking).
    this.body.position.y = Math.sin(this.bob * 1.5) * 0.12;
  }

  dispose(): void {
    this.disable();
    this.scene.remove(this.ship);
    this.ship.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.geometry) m.geometry.dispose();
      if (m.material) {
        const mat = m.material as THREE.Material | THREE.Material[];
        if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
        else mat.dispose();
      }
    });
    this.scene.remove(this.trail);
    this.trailGeom.dispose();
    this.trailMat.dispose();
  }
}

// The old stylised primitive ship — instant to build, shown until the GLB
// lands (and kept if it never does). Points forward along -Z.
function buildFallbackHull(): THREE.Group {
  const hull = new THREE.Group();
  const metal = new THREE.MeshBasicMaterial({ color: 0xcfd6e6 });
  const accent = new THREE.MeshBasicMaterial({ color: 0x6f8cff });

  // Fuselage: cone tip toward -Z.
  const fus = new THREE.Mesh(new THREE.ConeGeometry(0.6, 3, 12), metal);
  fus.rotation.x = -Math.PI / 2;
  hull.add(fus);

  // Wings: two flat wedges.
  const wing = new THREE.Mesh(new THREE.BoxGeometry(2.6, 0.12, 0.9), accent);
  wing.position.z = 0.6;
  hull.add(wing);

  // Cockpit bump.
  const cockpit = new THREE.Mesh(new THREE.SphereGeometry(0.34, 12, 8), accent);
  cockpit.position.set(0, 0.22, -0.4);
  hull.add(cockpit);

  return hull;
}

// Engine glow: an additive point at the tail (+Z). Opacity/size are
// throttle-driven in update(). A radial-gradient sprite texture rounds the
// point off — an untextured PointsMaterial draws a hard SQUARE.
function buildEngineGlow(): { points: THREE.Points; mat: THREE.PointsMaterial } {
  const geom = new THREE.BufferGeometry();
  geom.setAttribute(
    "position",
    new THREE.BufferAttribute(new Float32Array([TAIL.x, TAIL.y, TAIL.z]), 3),
  );
  const mat = new THREE.PointsMaterial({
    color: 0x7fd0ff,
    size: 22,
    sizeAttenuation: false,
    transparent: true,
    opacity: 0.9,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  // Canvas is a DOM API — the node test env just keeps the plain point.
  if (typeof document !== "undefined") {
    const c = document.createElement("canvas");
    c.width = c.height = 64;
    const ctx = c.getContext("2d");
    if (ctx) {
      const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
      g.addColorStop(0, "rgba(255,255,255,1)");
      g.addColorStop(0.35, "rgba(255,255,255,0.55)");
      g.addColorStop(1, "rgba(255,255,255,0)");
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, 64, 64);
      mat.map = new THREE.CanvasTexture(c);
      mat.alphaTest = 0.01;
      mat.needsUpdate = true;
    }
  }
  return { points: new THREE.Points(geom, mat), mat };
}
