// DEV-ONLY: capture animation frames of the big-graph galaxy for the README
// GIF. Drives window.__frame(t) (rotation + boomerang zoom into a star
// cluster) over a seamless loop and screenshots each frame. Requires the vite
// dev server running (npm run dev) and Playwright chromium installed
// (npx playwright install chromium). Frames -> ffmpeg -> docs/screenshots/galaxy.gif.
import { chromium } from "playwright";
import { mkdirSync, rmSync } from "node:fs";

const URL = process.env.GALAXY_URL || "http://localhost:5173/big-graph.html";
const OUT = process.env.GALAXY_OUT || "/tmp/galaxy-frames";
const N = Number(process.env.GALAXY_FRAMES || 64);
const W = Number(process.env.GALAXY_W || 1280);
const H = Number(process.env.GALAXY_H || 720);

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: W, height: H } });
await page.goto(URL, { waitUntil: "load" });
await page.waitForFunction("window.__graphReady === true", { timeout: 30000 });
await page.waitForTimeout(800); // initial render settle

for (let i = 0; i < N; i++) {
  await page.evaluate((t) => window.__frame(t), i / N);
  await page.waitForTimeout(70);
  await page.screenshot({ path: `${OUT}/frame_${String(i).padStart(3, "0")}.png` });
  process.stdout.write(`\rframe ${i + 1}/${N}`);
}
await browser.close();
console.log(`\ncaptured ${N} frames to ${OUT}`);
