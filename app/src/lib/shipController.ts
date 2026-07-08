// Spaceship controller — an immersive third-person flight rig for the graph.
// A small procedural ship sits in front of the camera; WASD/RF thrust, Q/E roll,
// and mouse-drag steer the ship's heading, and the camera chases from behind and
// slightly above. The world (nodes) flows past — a Google-Earth / game feel.
//
// Self-contained: the ship is built from three.js primitives (no external asset).
// Listeners live only while enabled, so keys never leak into inputs / orbit mode.
import * as THREE from "three";

export class ShipController {
  readonly ship: THREE.Group;
  private camera: THREE.PerspectiveCamera;
  private dom: HTMLElement;
  private scene: THREE.Scene;
  private enabled = false;
  private speed: number;
  private keys = new Set<string>();
  private dragging = false;
  private lastX = 0;
  private lastY = 0;
  private bob = 0;
  // scratch
  private q = new THREE.Quaternion();
  private v = new THREE.Vector3();
  private camOffset = new THREE.Vector3(0, 2.4, 17); // behind (+Z) and above the ship
  private lookAhead = new THREE.Vector3(0, 2, -40); // look out past the ship into the graph

  constructor(
    camera: THREE.PerspectiveCamera,
    dom: HTMLElement,
    scene: THREE.Scene,
    speed = 600,
  ) {
    this.camera = camera;
    this.dom = dom;
    this.scene = scene;
    this.speed = speed;
    this.ship = buildShip();
    this.ship.visible = false;
    scene.add(this.ship);
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
    this.rotateLocal(0, 1, 0, -dx * 0.004);
    this.rotateLocal(1, 0, 0, -dy * 0.004);
  };
  private onUp = (): void => {
    this.dragging = false;
  };

  private rotateLocal(ax: number, ay: number, az: number, rad: number): void {
    this.q.setFromAxisAngle(this.v.set(ax, ay, az), rad);
    this.ship.quaternion.multiply(this.q);
  }

  update(dt: number): void {
    if (!this.enabled) return;
    const boost = this.keys.has("shift") ? 3 : 1;
    const step = this.speed * boost * dt;
    const k = this.keys;
    // Thrust along the ship's local axes.
    if (k.has("w")) this.moveLocal(0, 0, -1, step);
    if (k.has("s")) this.moveLocal(0, 0, 1, step);
    if (k.has("a")) this.moveLocal(-1, 0, 0, step);
    if (k.has("d")) this.moveLocal(1, 0, 0, step);
    if (k.has("r") || k.has(" ")) this.moveLocal(0, 1, 0, step);
    if (k.has("f")) this.moveLocal(0, -1, 0, step);
    // Roll + keyboard yaw/pitch (arrows) for no-mouse steering.
    if (k.has("q")) this.rotateLocal(0, 0, 1, 1.2 * dt);
    if (k.has("e")) this.rotateLocal(0, 0, 1, -1.2 * dt);
    if (k.has("arrowleft")) this.rotateLocal(0, 1, 0, 1.2 * dt);
    if (k.has("arrowright")) this.rotateLocal(0, 1, 0, -1.2 * dt);
    if (k.has("arrowup")) this.rotateLocal(1, 0, 0, 1.2 * dt);
    if (k.has("arrowdown")) this.rotateLocal(1, 0, 0, -1.2 * dt);
    // Idle bob so a stationary ship still feels alive.
    this.bob += dt;
    this.syncCamera(false);
  }

  private moveLocal(x: number, y: number, z: number, dist: number): void {
    this.v.set(x, y, z).applyQuaternion(this.ship.quaternion).multiplyScalar(dist);
    this.ship.position.add(this.v);
  }

  // Place the camera behind + above the ship, looking ahead of it. `snap` places
  // it exactly; otherwise it eases for a smooth chase.
  private syncCamera(snap: boolean): void {
    const targetPos = this.v.copy(this.camOffset).applyQuaternion(this.ship.quaternion).add(this.ship.position);
    if (snap) this.camera.position.copy(targetPos);
    else this.camera.position.lerp(targetPos, 0.15);
    const look = this.lookAhead.clone().applyQuaternion(this.ship.quaternion).add(this.ship.position);
    this.camera.up.set(0, 1, 0).applyQuaternion(this.ship.quaternion);
    this.camera.lookAt(look);
    // Gentle idle bob on the ship mesh (does not affect flight path).
    this.ship.children[0].position.y = Math.sin(this.bob * 1.5) * 0.12;
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
  }
}

// A small stylised ship: a body group (fuselage + wings + cockpit) that can bob,
// plus a glowing engine at the tail. Points forward along -Z.
function buildShip(): THREE.Group {
  const group = new THREE.Group();
  const body = new THREE.Group();

  const metal = new THREE.MeshBasicMaterial({ color: 0xcfd6e6 });
  const accent = new THREE.MeshBasicMaterial({ color: 0x6f8cff });

  // Fuselage: cone tip toward -Z.
  const fus = new THREE.Mesh(new THREE.ConeGeometry(0.6, 3, 12), metal);
  fus.rotation.x = -Math.PI / 2;
  body.add(fus);

  // Wings: two flat wedges.
  const wingGeom = new THREE.BoxGeometry(2.6, 0.12, 0.9);
  const wing = new THREE.Mesh(wingGeom, accent);
  wing.position.z = 0.6;
  body.add(wing);

  // Cockpit bump.
  const cockpit = new THREE.Mesh(new THREE.SphereGeometry(0.34, 12, 8), accent);
  cockpit.position.set(0, 0.22, -0.4);
  body.add(cockpit);

  group.add(body);

  // Engine glow: an additive sprite-ish point at the tail (+Z).
  const glowGeom = new THREE.BufferGeometry();
  glowGeom.setAttribute("position", new THREE.BufferAttribute(new Float32Array([0, 0, 1.7]), 3));
  const glowMat = new THREE.PointsMaterial({
    color: 0x7fd0ff,
    size: 26,
    sizeAttenuation: false,
    transparent: true,
    opacity: 0.9,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  group.add(new THREE.Points(glowGeom, glowMat));

  return group;
}
