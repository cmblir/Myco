// "Thinking" visualization shown while a query runs: a neural-net-style
// mini graph where signal pulses travel from the question hub out to real
// vault pages (sampled names), lighting each one up as if the model were
// walking the knowledge graph. Pure canvas 2D, self-contained, unmounts when
// the answer arrives. Honors prefers-reduced-motion (static dots, no pulses).

import { useEffect, useRef } from "react";
import type { JSX } from "react";

const W = 640;
const H = 220;
const MAX_NODES = 18;
const PULSE_EVERY_MS = 650; // launch a new signal roughly this often
const PULSE_SPEED = 0.0016; // progress per ms along an edge
const FLASH_DECAY = 0.0008; // node highlight fade per ms

const NODE_COLORS = ["#6fb3ff", "#5fe0c0", "#ffd27a", "#b58cff", "#ff9ec4"];

interface VizNode {
  x: number;
  y: number;
  label: string;
  color: string;
  flash: number; // 0..1 highlight, decays
}
interface Pulse {
  from: number; // -1 = hub
  to: number;
  p: number; // 0..1 along the edge
  chain: boolean; // continue with a node→node hop on arrival
}

export default function ThinkingGalaxy({
  pages,
  label,
}: {
  /** Real vault page names to light up (sampled by the caller). */
  pages: string[];
  /** Status line under the canvas (e.g. "searching the vault…"). */
  label: string;
}): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    ctx.scale(dpr, dpr);

    // Scatter nodes on loose rings around the hub — stable for the mount.
    const names = pages.slice(0, MAX_NODES);
    const nodes: VizNode[] = names.map((label, i) => {
      const ring = i % 2 === 0 ? 0.62 : 0.92;
      const angle = (i / Math.max(1, names.length)) * Math.PI * 2 + ring;
      const rx = (W / 2 - 70) * ring;
      const ry = (H / 2 - 34) * ring;
      return {
        x: W / 2 + Math.cos(angle) * rx,
        y: H / 2 + Math.sin(angle) * ry,
        label,
        color: NODE_COLORS[i % NODE_COLORS.length],
        flash: 0,
      };
    });
    const hub = { x: W / 2, y: H / 2 };
    const pulses: Pulse[] = [];
    let last = performance.now();
    let sinceLaunch = PULSE_EVERY_MS; // fire one immediately
    let raf = 0;

    const posOf = (i: number): { x: number; y: number } =>
      i < 0 ? hub : nodes[i];

    const draw = (now: number): void => {
      const dt = Math.min(100, now - last);
      last = now;

      // Launch pulses on a cadence (skip entirely under reduced motion).
      if (!reduced && nodes.length > 0) {
        sinceLaunch += dt;
        if (sinceLaunch >= PULSE_EVERY_MS && pulses.length < 5) {
          sinceLaunch = 0;
          pulses.push({
            from: -1,
            to: Math.floor(Math.random() * nodes.length),
            p: 0,
            chain: Math.random() < 0.45,
          });
        }
      }

      ctx.clearRect(0, 0, W, H);

      // Edges: faint hub tethers.
      ctx.lineWidth = 1;
      for (const n of nodes) {
        ctx.strokeStyle = "rgba(139, 147, 168, 0.13)";
        ctx.beginPath();
        ctx.moveTo(hub.x, hub.y);
        ctx.lineTo(n.x, n.y);
        ctx.stroke();
      }

      // Pulses: bright dots traveling the tethers.
      for (let i = pulses.length - 1; i >= 0; i--) {
        const pu = pulses[i];
        pu.p += PULSE_SPEED * dt;
        const a = posOf(pu.from);
        const b = posOf(pu.to);
        if (pu.p >= 1) {
          nodes[pu.to].flash = 1;
          if (pu.chain && nodes.length > 1) {
            let next = Math.floor(Math.random() * nodes.length);
            if (next === pu.to) next = (next + 1) % nodes.length;
            pulses[i] = { from: pu.to, to: next, p: 0, chain: false };
          } else {
            pulses.splice(i, 1);
          }
          continue;
        }
        const x = a.x + (b.x - a.x) * pu.p;
        const y = a.y + (b.y - a.y) * pu.p;
        ctx.fillStyle = "rgba(255, 255, 255, 0.9)";
        ctx.beginPath();
        ctx.arc(x, y, 2.2, 0, Math.PI * 2);
        ctx.fill();
      }

      // Hub: breathing core.
      const breathe = reduced ? 1 : 1 + 0.08 * Math.sin(now * 0.003);
      const hubGrad = ctx.createRadialGradient(hub.x, hub.y, 0, hub.x, hub.y, 16 * breathe);
      hubGrad.addColorStop(0, "rgba(255, 255, 255, 0.95)");
      hubGrad.addColorStop(0.4, "rgba(160, 190, 255, 0.5)");
      hubGrad.addColorStop(1, "rgba(160, 190, 255, 0)");
      ctx.fillStyle = hubGrad;
      ctx.beginPath();
      ctx.arc(hub.x, hub.y, 16 * breathe, 0, Math.PI * 2);
      ctx.fill();

      // Nodes: dim dots that flash + show their name when a pulse lands.
      ctx.font = "10px ui-monospace, SFMono-Regular, Menlo, monospace";
      ctx.textAlign = "center";
      for (const n of nodes) {
        n.flash = Math.max(0, n.flash - FLASH_DECAY * dt);
        const r = 2.5 + n.flash * 2.5;
        ctx.globalAlpha = 0.45 + n.flash * 0.55;
        ctx.fillStyle = n.color;
        ctx.beginPath();
        ctx.arc(n.x, n.y, r, 0, Math.PI * 2);
        ctx.fill();
        if (n.flash > 0.35) {
          ctx.globalAlpha = Math.min(1, n.flash);
          ctx.fillStyle = "rgba(230, 235, 245, 0.9)";
          ctx.fillText(n.label, n.x, n.y - 8);
        }
        ctx.globalAlpha = 1;
      }

      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [pages]);

  return (
    <div className="thinking-galaxy" role="status" aria-label={label}>
      <canvas
        ref={canvasRef}
        style={{ width: "100%", maxWidth: W, height: H, display: "block" }}
      />
      <div className="thinking-galaxy__label">{label}</div>
    </div>
  );
}
