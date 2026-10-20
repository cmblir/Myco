import * as THREE from "three";
import { describe, expect, it } from "vitest";
import {
  PITCH_LIMIT,
  REST_SPIN,
  breathScale,
  buildMyco3D,
  coastSpin,
  dragSpin,
  eyeOpen,
  isCoasting,
  keySpin,
  spinEuler,
  parseMyco3DParams,
  type Spin,
} from "./myco3d";

const box = (o: THREE.Object3D): THREE.Box3 => new THREE.Box3().setFromObject(o);

describe("buildMyco3D", () => {
  it("builds the character from its seven parts and lights it", () => {
    const m = buildMyco3D("black");
    expect(Object.keys(m.parts).sort()).toEqual(
      ["body", "cap", "capUnder", "eyeL", "eyeR", "handL", "handR"].sort(),
    );
    // Key, rim and fill.
    expect(m.lights.length).toBe(3);
    m.dispose();
  });

  it("matches the poses' proportions: a cap wider than tall over a short body", () => {
    const m = buildMyco3D("white");
    const all = box(m.character);
    const cap = box(m.parts.cap);
    const body = box(m.parts.body);
    const size = all.getSize(new THREE.Vector3());
    // Standing on y = 0, about 2.5 tall, cap about 2.45 wide (poses: 252 px
    // tall, 247 px across the cap, at 100 px a unit).
    expect(all.min.y).toBeCloseTo(0, 1);
    expect(size.y).toBeGreaterThan(2.35);
    expect(size.y).toBeLessThan(2.65);
    const capW = cap.max.x - cap.min.x;
    expect(capW).toBeGreaterThan(2.2);
    expect(capW).toBeLessThan(2.8);
    // The body is about half the cap's width and tucks up under it.
    const bodyW = body.max.x - body.min.x;
    expect(bodyW / capW).toBeGreaterThan(0.4);
    expect(bodyW / capW).toBeLessThan(0.6);
    expect(body.max.y).toBeGreaterThan(cap.min.y);
    // The whole thing is centred on its turning axis.
    expect(Math.abs(all.max.z + all.min.z)).toBeLessThan(0.6);
    m.dispose();
  });

  it("puts both eyes on the face: in front, side by side, just under the cap rim", () => {
    const m = buildMyco3D("black");
    const capRim = box(m.parts.cap).min.y;
    const body = box(m.parts.body);
    const bodyR = (body.max.x - body.min.x) / 2;
    const [l, r] = [m.parts.eyeL.position, m.parts.eyeR.position];
    expect(l.x).toBeLessThan(0);
    expect(r.x).toBeGreaterThan(0);
    expect(l.y).toBeCloseTo(r.y, 5);
    expect(l.z).toBeCloseTo(r.z, 5);
    expect(l.z).toBeGreaterThan(bodyR * 0.75);
    expect(l.y).toBeLessThan(capRim);
    expect(l.y).toBeGreaterThan(capRim - 0.4);
    // Close together, as on the sheet (about a quarter of the body's width).
    expect(r.x - l.x).toBeLessThan(bodyR * 0.8);
    m.dispose();
  });

  it("raises one hand beside the body and keeps it in front of the turning axis", () => {
    const m = buildMyco3D("black");
    const body = box(m.parts.body);
    const hand = m.parts.handR.position;
    expect(hand.x).toBeGreaterThan(body.max.x * 0.8);
    expect(hand.y).toBeGreaterThan(m.parts.handL.position.y);
    m.dispose();
  });

  it("gives each skin its own materials: black with white eyes, white with charcoal eyes", () => {
    const black = buildMyco3D("black");
    const white = buildMyco3D("white");
    const lum = (mesh: THREE.Mesh): number => {
      const c = (mesh.material as THREE.MeshPhysicalMaterial).color;
      return 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
    };
    expect(lum(black.parts.body)).toBeLessThan(0.05);
    expect(lum(black.parts.eyeL)).toBeGreaterThan(0.8);
    expect(lum(white.parts.body)).toBeGreaterThan(0.6);
    expect(lum(white.parts.eyeL)).toBeLessThan(0.1);
    // The underside rim is a shade lighter than the cap on both.
    expect(lum(black.parts.capUnder)).toBeGreaterThan(lum(black.parts.cap));
    for (const m of [black, white]) {
      const mat = m.parts.cap.material as THREE.MeshPhysicalMaterial;
      expect(mat).toBeInstanceOf(THREE.MeshPhysicalMaterial);
      expect(mat.sheen).toBeGreaterThan(0);
    }
    // Black's rim light is violet; white's is neutral.
    const rimB = black.lights[1].color;
    expect(rimB.b).toBeGreaterThan(rimB.g);
    black.dispose();
    white.dispose();
  });
});

describe("spin math", () => {
  const still: Spin = { ...REST_SPIN };

  it("rests tipped ~10° toward the camera so the cap's underside shows", () => {
    // Negative pitch is the ArrowUp direction: it turns the underside to the camera.
    expect(REST_SPIN.pitch).toBeCloseTo((-10 * Math.PI) / 180, 2);
    expect(REST_SPIN.yaw).toBe(0);
  });

  it("tips toward the camera at every yaw, so a turntable does not wobble", () => {
    // The underside's normal must lean to the camera (+z), never sideways.
    for (const yaw of [0, Math.PI / 2, Math.PI, -Math.PI / 2]) {
      const down = new THREE.Vector3(0, -1, 0).applyEuler(spinEuler({ ...REST_SPIN, pitch: -0.17, yaw }));
      expect(down.z).toBeGreaterThan(0.15);
      expect(Math.abs(down.x)).toBeLessThan(1e-9);
    }
  });

  it("drags yaw freely and clamps pitch to ±25°", () => {
    const s = dragSpin(still, 400, 0, 16);
    expect(s.yaw).toBeGreaterThan(1);
    expect(s.vYaw).toBeGreaterThan(0);
    const up = dragSpin(still, 0, -5000, 16);
    expect(up.pitch).toBeCloseTo(-PITCH_LIMIT, 5);
    const down = dragSpin(still, 0, 5000, 16);
    expect(down.pitch).toBeCloseTo(PITCH_LIMIT, 5);
    expect(PITCH_LIMIT).toBeCloseTo((25 * Math.PI) / 180, 6);
  });

  it("coasts after release and decays to a stop", () => {
    let s = dragSpin(still, 60, 0, 16);
    const yaw0 = s.yaw;
    s = coastSpin(s, 16);
    expect(s.yaw).toBeGreaterThan(yaw0);
    const v1 = s.vYaw;
    s = coastSpin(s, 16);
    expect(s.vYaw).toBeLessThan(v1);
    for (let i = 0; i < 400 && isCoasting(s); i++) s = coastSpin(s, 16);
    expect(isCoasting(s)).toBe(false);
    expect(s.vYaw).toBe(0);
    // A pitch fling still stops at the clamp.
    let p = dragSpin(still, 0, 30, 16);
    for (let i = 0; i < 400 && isCoasting(p); i++) p = coastSpin(p, 16);
    expect(Math.abs(p.pitch)).toBeLessThanOrEqual(PITCH_LIMIT + 1e-9);
  });

  it("decays the same for one long frame as for many short ones", () => {
    const s = dragSpin(still, 60, 0, 16);
    let a = s;
    for (let i = 0; i < 4; i++) a = coastSpin(a, 25);
    const b = coastSpin(s, 100);
    expect(b.vYaw).toBeCloseTo(a.vYaw, 6);
  });

  it("turns with the arrow keys, resets with Home, ignores other keys", () => {
    expect(keySpin(still, "ArrowRight")!.yaw).toBeGreaterThan(0);
    expect(keySpin(still, "ArrowLeft")!.yaw).toBeLessThan(0);
    expect(keySpin(still, "ArrowUp")!.pitch).toBeLessThan(0);
    let s = still;
    for (let i = 0; i < 20; i++) s = keySpin(s, "ArrowDown")!;
    expect(s.pitch).toBeCloseTo(PITCH_LIMIT, 5);
    expect(keySpin(s, "Home")).toEqual(REST_SPIN);
    expect(keySpin(s, "a")).toBeNull();
  });
});

describe("idle motion", () => {
  it("breathes within a percent or two", () => {
    for (let t = 0; t < 8000; t += 97) {
      const k = breathScale(t);
      expect(k).toBeGreaterThan(0.98);
      expect(k).toBeLessThan(1.02);
    }
    expect(breathScale(0)).not.toBe(breathScale(1000));
  });

  it("blinks briefly: eyes are open most of the time and close once per cycle", () => {
    let closed = 0;
    let n = 0;
    for (let t = 0; t < 10000; t += 10, n++) {
      const o = eyeOpen(t);
      expect(o).toBeGreaterThan(0);
      expect(o).toBeLessThanOrEqual(1);
      if (o < 0.5) closed++;
    }
    expect(closed).toBeGreaterThan(0);
    expect(closed / n).toBeLessThan(0.06);
  });
});

describe("parseMyco3DParams", () => {
  it("reads the skin, the ground and a starting angle", () => {
    expect(parseMyco3DParams("?window=myco3d")).toEqual({ skin: "black", solid: false, yaw: 0 });
    expect(parseMyco3DParams("?window=myco3d&skin=white&bg=solid&yaw=90")).toEqual({
      skin: "white",
      solid: true,
      yaw: Math.PI / 2,
    });
  });

  it("falls back on anything it does not know", () => {
    expect(parseMyco3DParams("?skin=pink&bg=x&yaw=nope")).toEqual({
      skin: "black",
      solid: false,
      yaw: 0,
    });
  });
});
