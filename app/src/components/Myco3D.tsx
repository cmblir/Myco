// The 3D myco (spec 2026-10-04-myco-3d.md): the procedural model from
// lib/myco3d, turned with the mouse (drag + inertia, double-click resets) or
// the arrow keys. It breathes and blinks, holds still under reduced motion,
// and draws only while it is on screen in a visible window.

import { useEffect, useRef, useState, type JSX } from "react";
import * as THREE from "three";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import attentionPose from "../assets/mascot/poses/attention.png";
import { STRINGS } from "../lib/i18n";
import {
  MYCO3D_CENTER_Y,
  REST_SPIN,
  SKINS,
  breathScale,
  buildMyco3D,
  coastSpin,
  dragSpin,
  eyeOpen,
  isCoasting,
  keySpin,
  parseMyco3DParams,
  spinEuler,
  type Myco3DSkin,
  type Spin,
} from "../lib/myco3d";
import { useUIStore } from "../stores/uiStore";

/** A release this long after the last move is a stop, not a fling. */
const FLING_WINDOW_MS = 80;
// Level with the body, a little below the cap's rim. This alone hides the
// underside; REST_SPIN's pitch tips the model so it shows.
const CAMERA_DIST = 7.6;
const CAMERA_Y = 0.45;
const noop = (): void => undefined;

interface Props {
  skin: Myco3DSkin;
  /** Paint the skin's ground instead of a see-through canvas. */
  solid?: boolean;
  /** Starting yaw in radians. */
  initialYaw?: number;
  className?: string;
}

export function Myco3D({ skin, solid = false, initialYaw = 0, className }: Props): JSX.Element {
  const lang = useUIStore((s) => s.lang);
  const t = STRINGS[lang];
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const spin = useRef<Spin>({ ...REST_SPIN, yaw: initialYaw });
  // Set by the scene effect: draw again (and keep drawing while there is motion).
  const wake = useRef<() => void>(noop);
  const drag = useRef<{ id: number; x: number; y: number; at: number } | null>(null);
  const reduced = useRef(false);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: !solid });
    } catch (e) {
      console.error("[myco3d] WebGL unavailable", e);
      setStatus("error");
      return;
    }
    const motionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
    reduced.current = motionQuery.matches;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.NeutralToneMapping;

    const scene = new THREE.Scene();
    const s = SKINS[skin];
    if (solid) scene.background = new THREE.Color(s.ground);
    const pmrem = new THREE.PMREMGenerator(renderer);
    const room = new RoomEnvironment();
    const envMap = pmrem.fromScene(room, 0.04).texture;
    scene.environment = envMap;
    scene.environmentIntensity = s.env;

    const model = buildMyco3D(skin);
    const pivot = new THREE.Group();
    pivot.position.y = MYCO3D_CENTER_Y;
    model.character.position.y = -MYCO3D_CENTER_Y;
    pivot.add(model.character);
    scene.add(pivot, ...model.lights);

    const camera = new THREE.PerspectiveCamera(28, 1, 0.1, 50);
    const fit = (): void => {
      const w = canvas.clientWidth || 1;
      const h = canvas.clientHeight || 1;
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      // Narrow boxes back the camera off so the cap's width still fits.
      const dist = CAMERA_DIST * Math.max(1, 0.85 / camera.aspect);
      camera.position.set(0, CAMERA_Y, dist);
      camera.lookAt(0, MYCO3D_CENTER_Y, 0);
      camera.updateProjectionMatrix();
    };

    let onScreen = true;
    let raf = 0;
    let last = 0;
    let drawn = false;
    const visible = (): boolean => onScreen && !document.hidden;
    const frame = (now: number): void => {
      raf = 0;
      const dt = last ? Math.min(now - last, 100) : 16;
      last = now;
      if (!drag.current && isCoasting(spin.current)) spin.current = coastSpin(spin.current, dt);
      pivot.rotation.copy(spinEuler(spin.current));
      const idle = !reduced.current;
      const k = idle ? breathScale(now) : 1;
      model.character.scale.set(1 + (1 - k) * 0.5, k, 1 + (1 - k) * 0.5);
      const open = idle ? eyeOpen(now) : 1;
      model.parts.eyeL.scale.y = open;
      model.parts.eyeR.scale.y = open;
      renderer.render(scene, camera);
      if (!drawn) {
        drawn = true;
        setStatus("ready");
      }
      if (visible() && (idle || drag.current || isCoasting(spin.current))) {
        raf = requestAnimationFrame(frame);
      } else {
        last = 0;
      }
    };
    wake.current = () => {
      if (!raf && visible()) raf = requestAnimationFrame(frame);
    };
    const sleep = (): void => {
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      last = 0;
    };
    const onVisibility = (): void => (visible() ? wake.current() : sleep());
    const onMotion = (e: MediaQueryListEvent): void => {
      reduced.current = e.matches;
      wake.current();
    };

    fit();
    const ro = new ResizeObserver(() => {
      fit();
      wake.current();
    });
    ro.observe(canvas);
    const io = new IntersectionObserver(([entry]) => {
      onScreen = entry.isIntersecting;
      onVisibility();
    });
    io.observe(canvas);
    document.addEventListener("visibilitychange", onVisibility);
    motionQuery.addEventListener("change", onMotion);
    wake.current();

    return () => {
      sleep();
      wake.current = noop;
      ro.disconnect();
      io.disconnect();
      document.removeEventListener("visibilitychange", onVisibility);
      motionQuery.removeEventListener("change", onMotion);
      model.dispose();
      envMap.dispose();
      room.dispose();
      pmrem.dispose();
      renderer.dispose();
    };
  }, [skin, solid]);

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>): void => {
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { id: e.pointerId, x: e.clientX, y: e.clientY, at: e.timeStamp };
    spin.current = { ...spin.current, vYaw: 0, vPitch: 0 };
    wake.current();
  };
  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>): void => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    spin.current = dragSpin(spin.current, e.clientX - d.x, e.clientY - d.y, e.timeStamp - d.at);
    drag.current = { id: d.id, x: e.clientX, y: e.clientY, at: e.timeStamp };
    wake.current();
  };
  const onPointerUp = (e: React.PointerEvent<HTMLCanvasElement>): void => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    drag.current = null;
    // Reduced motion: it stops where it is let go, no coasting.
    if (reduced.current || e.timeStamp - d.at > FLING_WINDOW_MS) {
      spin.current = { ...spin.current, vYaw: 0, vPitch: 0 };
    }
    wake.current();
  };
  const onKeyDown = (e: React.KeyboardEvent<HTMLCanvasElement>): void => {
    const next = keySpin(spin.current, e.key);
    if (!next) return;
    e.preventDefault();
    spin.current = next;
    wake.current();
  };
  const onDoubleClick = (): void => {
    spin.current = { ...REST_SPIN };
    wake.current();
  };

  const classes = `myco3d myco3d--${skin}${solid ? " myco3d--solid" : ""} ${className ?? ""}`;
  if (status === "error") {
    return (
      <figure className={`${classes} myco3d--error`}>
        <img className="myco3d-still" src={attentionPose} alt="" />
        <figcaption className="myco3d-note" role="status">
          {t.myco3d_error}
        </figcaption>
      </figure>
    );
  }
  return (
    <div className={classes} data-status={status}>
      <canvas
        ref={canvasRef}
        className="myco3d-canvas"
        role="img"
        aria-label={t.myco3d_label}
        tabIndex={0}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onKeyDown={onKeyDown}
        onDoubleClick={onDoubleClick}
      />
      {status === "loading" && (
        <p className="myco3d-note" role="status">
          {t.myco3d_loading}
        </p>
      )}
    </div>
  );
}

/** `?window=myco3d&skin=black|white&bg=solid&yaw=<deg>`: myco alone, filling
 *  the window, for looking at and for recording turntables. */
export default function Myco3DPreview(): JSX.Element {
  const p = parseMyco3DParams(location.search);
  useEffect(() => {
    document.documentElement.classList.add("myco3d-window");
    if (p.solid) document.documentElement.style.background = SKINS[p.skin].ground;
  }, [p.solid, p.skin]);
  return (
    <main className="myco3d-preview">
      <Myco3D skin={p.skin} solid={p.solid} initialYaw={p.yaw} />
    </main>
  );
}
