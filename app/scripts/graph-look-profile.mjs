// Synthetic-vault visual and frame evidence for all built-in looks.
// MYCO_TEST_URL=http://127.0.0.1:5187 node scripts/graph-look-profile.mjs 2500
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { chromium } from "playwright";

const count = Number(process.argv[2] ?? 2500);
const base = process.env.MYCO_TEST_URL ?? "http://127.0.0.1:5173";
const output = process.env.MYCO_SCREENSHOTS ?? "/tmp/myco-graph-look-profile";
await mkdir(output, { recursive: true });
const browser = await chromium.launch({
  args: ["--use-gl=angle", process.platform === "darwin" ? "--use-angle=metal" : "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist", "--enable-webgl"],
});
const report = { synthetic: true, requestedNodes: count, viewport: { width: 1440, height: 900 }, errors: [], looks: [] };
try {
  const page = await browser.newPage({ viewport: report.viewport });
  page.on("pageerror", (error) => report.errors.push(error.stack ?? error.message));
  await page.addInitScript(() => {
    localStorage.setItem("myco-ui", JSON.stringify({ version: 3, state: {
      lang: "ko", theme: "dark", sidebarCollapsed: true, route: "graph",
    } }));
    localStorage.setItem("myco.graph.settings.v26", JSON.stringify({
      layout: "spiral", skin: "galaxy", question: "neighbors", ambientMotion: false,
    }));
  });
  await page.goto(`${base}/?mock=1&big=${count}`);
  await page.locator(".graph-canvas.graph-ready").waitFor({ timeout: 180000 });
  await page.locator(".graph-drawer-toggle--closed").click();
  const looks = await page.evaluate(async () => Object.entries((await import("/src/lib/graphSettings.ts")).VIBE_PRESETS));
  for (const [index, [key, preset]] of looks.entries()) {
    const start = Date.now();
    await page.locator(".graph-vibe").nth(index).click();
    await page.waitForFunction((expected) => {
      const scene = window.__graphDev?.scene;
      return scene && Object.entries(expected).every(([name, value]) => scene.settings[name] === value) && document.querySelector(".graph-canvas.graph-ready");
    }, preset, { timeout: 180000 });
    if (key === "mycelium") await page.waitForFunction(() => window.__myceliumDev?.scene);
    const readyMs = Date.now() - start;
    await page.waitForTimeout(key === "mycelium" ? 9000 : 1500);
    const measured = await page.evaluate(async (isMycelium) => {
      const { graph, scene: graphScene } = window.__graphDev;
      const scene = isMycelium ? window.__myceliumDev.scene : graphScene;
      const gl = scene.renderer.getContext();
      const extension = gl.getExtension("WEBGL_debug_renderer_info");
      const gpu = extension ? gl.getParameter(extension.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
      const frames = [];
      const start = performance.now();
      let last = start;
      await new Promise((resolve) => {
        const tick = (now) => {
          frames.push(now - last);
          last = now;
          if (now - start < 2400) requestAnimationFrame(tick);
          else resolve();
        };
        requestAnimationFrame(tick);
      });
      const sorted = [...frames].sort((a, b) => a - b);
      const positions = graph.mapNodes((_id, a) => [a.x, a.y, a.z]);
      const labels = isMycelium ? null : [...document.querySelectorAll(".graph-label-3d")].filter((label) => label.getBoundingClientRect().width > 0).length;
      return {
        nodes: graph.order, edges: graph.size, gpu, finitePositions: positions.every((point) => point.every(Number.isFinite)),
        frames: frames.length, fps: +(1000 * frames.length / (last - start)).toFixed(1),
        medianMs: +sorted[Math.floor(sorted.length / 2)].toFixed(2),
        p95Ms: +sorted[Math.floor(sorted.length * 0.95)].toFixed(2), labels,
        draw: { ...scene.renderer.info.render },
        camera: scene.camera.position.toArray(),
      };
    }, key === "mycelium");
    assert.equal(measured.nodes, count, `${key} preserves every synthetic note`);
    assert.ok(measured.finitePositions, `${key} has finite layout coordinates`);
    await page.locator(".graph-canvas").screenshot({ path: `${output}/${key}.png` });
    const pick = await page.evaluate(async (isMycelium) => {
      const { Vector3 } = await import("/node_modules/three/build/three.module.js");
      const { graph, scene } = window.__graphDev;
      const renderer = isMycelium ? window.__myceliumDev.scene : scene;
      const rect = renderer.renderer.domElement.getBoundingClientRect();
      const candidates = graph.mapNodes((id, a) => {
        if (isMycelium) {
          const point = renderer.projectToScreen(id);
          return point ? { id, x: point.x + rect.left, y: point.y + rect.top } : null;
        }
        const point = new Vector3(a.x, a.y, a.z).project(scene.camera);
        return Math.abs(point.x) < 0.75 && Math.abs(point.y) < 0.75 && point.z > -1 && point.z < 1
          ? { id, x: rect.left + (point.x + 1) * rect.width / 2, y: rect.top + (1 - point.y) * rect.height / 2 }
          : null;
      }).filter(Boolean).filter((point) => point.x > rect.left + 20 && point.x < rect.right - 20 && point.y > rect.top + 20 && point.y < rect.bottom - 20);
      return candidates[Math.floor(candidates.length / 2)] ?? null;
    }, key === "mycelium");
    assert.ok(pick, `${key} exposes a visible note`);
    await page.mouse.click(pick.x, pick.y);
    await page.waitForTimeout(250);
    const selected = await page.evaluate(() => window.__graphDev.scene.selectedNode);
    // Solid surfaces can occlude a tile; record actual picking rather than
    // asserting that a projected centre must pick the rear note through it.
    const selection = { requested: pick.id, actual: selected, selectedRealNote: await page.evaluate((id) => !!id && window.__graphDev.graph.hasNode(id), selected) };
    report.looks.push({ key, readyMs, ...measured, selection });
    await writeFile(`${output}/report.json`, JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report.looks.at(-1)));
  }
  assert.equal(report.errors.length, 0, report.errors.join("\n"));
} finally {
  await writeFile(`${output}/report.json`, JSON.stringify(report, null, 2));
  await browser.close();
}
