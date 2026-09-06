// DEV-ONLY: capture the README hero assets for the neural-mesh graph from the
// real three.js scene rendered over a ~10k-node SYNTHETIC vault (src/heroMesh.ts,
// served at /hero-mesh.html). Produces a still PNG + a slow-rotation GIF. The
// data is synthetic, so the output is safe to publish (no real vault content).
//
// Requires: vite dev server running (npm run dev), Playwright chromium
// (npx playwright install chromium), and ffmpeg on PATH.
//   node scripts/capture-mesh.mjs
import { chromium } from "playwright";
import { mkdirSync, rmSync } from "node:fs";
import { execSync } from "node:child_process";

const URL = process.env.MESH_URL || "http://localhost:5173/hero-mesh.html";
// Repo-root docs/ (the script is run from app/, where package.json lives).
const SHOTS = process.env.MESH_SHOTS || "../docs/screenshots";
const FRAMES = process.env.MESH_FRAMES || "/tmp/mesh-frames";
const W = Number(process.env.MESH_W || 1920);
const H = Number(process.env.MESH_H || 1200);
const NF = Number(process.env.MESH_NFRAMES || 48);

rmSync(FRAMES, { recursive: true, force: true });
mkdirSync(FRAMES, { recursive: true });
mkdirSync(SHOTS, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({
  viewport: { width: W, height: H },
  deviceScaleFactor: 1, // DSF 2 made readback of the animating bloom scene stall >30s
  reducedMotion: "no-preference", // let auto-rotate + pulses animate
});
await page.goto(URL, { waitUntil: "load" });
await page.waitForFunction("window.__graphReady === true", { timeout: 60000 });
await page.waitForTimeout(2500); // final fit + settle

const n = await page.evaluate(() => window.__nodeCount);
const e = await page.evaluate(() => window.__edgeCount);
console.log(`graph: ${n} nodes, ${e} edges`);

await page.screenshot({ path: `${SHOTS}/hero-mesh.png`, timeout: 120000 });
console.log(`saved ${SHOTS}/hero-mesh.png`);

// Slow-rotation GIF: the scene auto-rotates, so just sample frames over time.
for (let i = 0; i < NF; i++) {
  await page.waitForTimeout(95);
  await page.screenshot({ path: `${FRAMES}/f_${String(i).padStart(3, "0")}.png`, timeout: 60000 });
  process.stdout.write(`\rframe ${i + 1}/${NF}`);
}
await browser.close();
console.log("");

execSync(
  `ffmpeg -y -framerate 18 -i ${FRAMES}/f_%03d.png ` +
    `-vf "fps=18,scale=900:-1:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=192[p];[s1][p]paletteuse=dither=bayer" ` +
    `${SHOTS}/mesh.gif`,
  { stdio: "inherit" },
);
console.log(`saved ${SHOTS}/mesh.gif`);
