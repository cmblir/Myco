// The recording waveform shared by the notch and the spotlight: a canvas
// line drawn from the mic's real RMS history (lib/voiceLevel createLevelHistory),
// so a muted or wrong mic reads as a flat line — the old CSS-keyframe bars
// looked identical either way. Redrawn every frame while mounted: the history
// scrolls ~12×/s and a slow sine carrier keeps the line reading as alive.

import { useEffect, useRef } from "react";
import type { JSX } from "react";
import type { LevelHistory } from "../lib/voiceLevel";

/** RMS → line amplitude. Speech sits around 0.05–0.2 RMS; ×5 puts a normal
 *  voice near the full swing. Tune here if a mic reads consistently low. */
const GAIN = 5;

export default function VoiceWave({
  history,
  color = "#a78bfa",
  height = 22,
  className,
}: {
  history: LevelHistory;
  color?: string;
  height?: number;
  className?: string;
}): JSX.Element {
  const ref = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let frame = 0;
    const draw = (t: number): void => {
      const dpr = window.devicePixelRatio || 1;
      const w = canvas.clientWidth;
      if (canvas.width !== w * dpr || canvas.height !== height * dpr) {
        canvas.width = w * dpr;
        canvas.height = height * dpr;
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, height);
      const levels = history.read();
      const mid = height / 2;
      const phase = still ? 0 : t / 70;
      const trace = (sign: 1 | -1, alpha: number): void => {
        ctx.beginPath();
        for (let i = 0; i < levels.length; i++) {
          const x = (i / (levels.length - 1)) * w;
          const amp = Math.min(1, levels[i] * GAIN) * 0.44 * height;
          const y = mid + sign * Math.sin(i * 0.6 + phase) * amp;
          if (i === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.globalAlpha = alpha;
        ctx.strokeStyle = color;
        ctx.lineWidth = 2;
        ctx.lineJoin = "round";
        ctx.stroke();
      };
      trace(1, 1);
      trace(-1, 0.35);
      frame = window.requestAnimationFrame(draw);
    };
    frame = window.requestAnimationFrame(draw);
    return () => window.cancelAnimationFrame(frame);
  }, [history, color, height]);

  return (
    <canvas
      ref={ref}
      aria-hidden
      className={className ? `voice-wave-canvas ${className}` : "voice-wave-canvas"}
      style={{ height }}
    />
  );
}
