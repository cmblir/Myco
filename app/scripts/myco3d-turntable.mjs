// DEV-ONLY: record a 6 s, 360° turntable of the 3D myco in both skins at
// 1080x1080 (spec 2026-10-04-myco-3d.md). It turns the ?window=myco3d preview
// the way a person does, by dragging it, and screenshots each frame with a
// see-through background. ffmpeg then writes, per skin:
//   myco3d-<skin>.webm  VP9 on the skin's own ground (plays in any browser)
//   myco3d-<skin>.mov   ProRes 4444 with alpha (for editing over anything)
// Requires the vite dev server (./node_modules/.bin/vite --port 5701), the
// Playwright chromium, and ffmpeg. Run from app/:
//   MYCO3D_URL=http://localhost:5701 node scripts/myco3d-turntable.mjs
// Output: ../output/myco3d/ (gitignored), or MYCO3D_OUT.
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const BASE = process.env.MYCO3D_URL || "http://localhost:5701";
const OUT = path.resolve(
  process.env.MYCO3D_OUT ||
    path.join(path.dirname(fileURLToPath(import.meta.url)), "../../output/myco3d"),
);
const SIZE = 1080;
const FPS = 30;
const SECONDS = 6;
const FRAMES = FPS * SECONDS;
// lib/myco3d.ts RAD_PER_PX: one px of drag turns myco 0.01 rad.
const PX_PER_TURN = (2 * Math.PI) / 0.01;
// lib/myco3d.ts SKINS[skin].ground, for the WebM's solid background.
const GROUND = { black: "#0b0a10", white: "#dedcd8" };

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    p.stderr.on("data", (d) => (err += d));
    p.on("error", reject);
    p.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}\n${err.slice(-2000)}`)),
    );
  });
}

async function capture(browser, skin, dir) {
  // Reduced motion holds the breathing and blinking still, so the loop is seamless.
  const page = await browser.newPage({
    viewport: { width: SIZE, height: SIZE },
    deviceScaleFactor: 1,
    reducedMotion: "reduce",
  });
  await page.goto(`${BASE}/?window=myco3d&skin=${skin}`);
  await page.waitForSelector('.myco3d[data-status="ready"]', { timeout: 30000 });
  const y = SIZE * 0.85; // below the model: a drag anywhere on the canvas turns it
  const x0 = (SIZE - PX_PER_TURN) / 2;
  await page.mouse.move(x0, y);
  await page.mouse.down();
  for (let i = 0; i < FRAMES; i++) {
    await page.mouse.move(x0 + (i * PX_PER_TURN) / FRAMES, y);
    // Two animation frames: the move is applied, then drawn.
    await page.evaluate(
      () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
    );
    await page.screenshot({
      path: path.join(dir, `f${String(i).padStart(4, "0")}.png`),
      omitBackground: true,
    });
    process.stdout.write(`\r${skin} ${i + 1}/${FRAMES}`);
  }
  await page.mouse.up();
  await page.close();
  process.stdout.write("\n");
}

async function encode(skin, dir) {
  const frames = ["-framerate", String(FPS), "-i", path.join(dir, "f%04d.png")];
  const webm = path.join(OUT, `myco3d-${skin}.webm`);
  const mov = path.join(OUT, `myco3d-${skin}.mov`);
  await run("ffmpeg", [
    "-y",
    "-f", "lavfi",
    "-i", `color=c=${GROUND[skin]}:s=${SIZE}x${SIZE}:r=${FPS}`,
    ...frames,
    "-filter_complex", "[0][1]overlay=shortest=1,format=yuv420p",
    "-c:v", "libvpx-vp9", "-b:v", "0", "-crf", "24", "-row-mt", "1",
    webm,
  ]);
  await run("ffmpeg", [
    "-y",
    ...frames,
    "-c:v", "prores_ks", "-profile:v", "4444", "-pix_fmt", "yuva444p10le",
    mov,
  ]);
  return [webm, mov];
}

await mkdir(OUT, { recursive: true });
// Headless chromium draws WebGL in software (SwiftShader) unless told to use
// the GPU: about 11 s per 1080² frame there against 0.2 s on Metal.
const browser = await chromium.launch({
  args: ["--use-angle=metal", "--ignore-gpu-blocklist", "--enable-gpu"],
});
const written = [];
try {
  for (const skin of ["black", "white"]) {
    const dir = await mkdtemp(path.join(tmpdir(), `myco3d-${skin}-`));
    try {
      await capture(browser, skin, dir);
      written.push(...(await encode(skin, dir)));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
} finally {
  await browser.close();
}
console.log(written.join("\n"));
