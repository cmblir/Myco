// Synthetic-only integration evidence for the Woven graph renderer.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { chromium } from "playwright";

const output = process.env.MYCO_SCREENSHOTS ?? "/tmp/myco-woven";
const base = process.env.MYCO_TEST_URL ?? "http://127.0.0.1:5187";
const count = Number(process.argv[2] ?? 250);
await mkdir(output, { recursive: true });
const browser = await chromium.launch({
  args: [
    "--use-gl=angle",
    process.platform === "darwin"
      ? "--use-angle=metal"
      : "--use-angle=swiftshader",
    "--enable-unsafe-swiftshader",
    "--ignore-gpu-blocklist",
    "--enable-webgl",
  ],
});
const report = { synthetic: true, count, errors: [] };
try {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 900 },
    reducedMotion: "reduce",
  });
  page.on("pageerror", (error) =>
    report.errors.push(error.stack ?? error.message),
  );
  await page.addInitScript(() => {
    localStorage.setItem(
      "myco-ui",
      JSON.stringify({
        version: 3,
        state: {
          lang: "ko",
          theme: "dark",
          sidebarCollapsed: true,
          route: "graph",
        },
      }),
    );
    localStorage.setItem(
      "myco.graph.settings.v26",
      JSON.stringify({
        layout: "ribbon",
        skin: "black",
        question: "neighbors",
        ambientMotion: false,
        minimap: false,
      }),
    );
  });
  await page.goto(`${base}/?mock=1&big=${count}`);
  await page.locator(".graph-canvas.graph-ready").waitFor({ timeout: 120000 });
  report.topology = await page.evaluate(() => {
    const { scene, graph } = window.__graphDev;
    assertTopology();
    function assertTopology() {
      if (scene.woven?.layout.kind !== "woven") throw Error("Wrong renderer");
      if (scene.woven.layout.routes.length !== graph.size)
        throw Error("Lost edges");
    }
    return {
      notes: graph.order,
      links: graph.size,
      strands: scene.woven.layout.routes.length,
    };
  });
  console.log(JSON.stringify(report.topology));
  await page.waitForTimeout(1200);
  await page.screenshot({ path: `${output}/woven-${count}.png` });
  await page.locator(".graph-drawer-toggle--closed").click();
  assert.equal(await page.locator(".graph-vibe").count(), 12);
  assert.equal(
    await page.locator(".graph-vibe").filter({ hasText: "직조" }).count(),
    1,
  );
  assert.equal(
    await page
      .locator(".graph-vibe")
      .filter({ hasText: /지형도|블록 도시/ })
      .count(),
    0,
  );
  report.controls = "12 looks, Woven visible, Terrain and City hidden";
  await page.locator(".graph-drawer__btn--icon").click();
  await page.waitForTimeout(500);
  const pick = await page.evaluate(async () => {
    const { scene, graph, rect } = window.__graphDev;
    const bounds = rect();
    for (const id of graph
      .nodes()
      .sort((a, b) => graph.degree(b) - graph.degree(a))) {
      const attrs = graph.getNodeAttributes(id);
      const point = scene.camera.position
        .clone()
        .set(attrs.x, attrs.y, attrs.z)
        .project(scene.camera);
      const x = bounds.left + ((point.x + 1) * bounds.width) / 2;
      const y = bounds.top + ((1 - point.y) * bounds.height) / 2;
      // Left of centre: selecting opens the inspector over the canvas's right
      // side, and the drag below must still reach the note.
      if (
        point.x > -0.7 &&
        point.x < 0.2 &&
        Math.abs(point.y) < 0.7 &&
        scene.pickNode(x, y) === id
      )
        return { id, x, y };
    }
  });
  assert.ok(pick);
  await page.mouse.click(pick.x, pick.y);
  report.pick = {
    ...pick,
    actual: await page.evaluate(() => window.__graphDev.scene.selectedNode),
  };
  await page.waitForFunction(
    (id) => window.__graphDev.scene.selectedNode === id,
    pick.id,
    { timeout: 15000 },
  );
  await page.waitForTimeout(600);
  await page.mouse.move(100, 100);
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${output}/woven-${count}-selected.png` });
  report.selection = { id: pick.id, verified: true };
  if (count === 250) {
    const anchor = await page.evaluate((id) => {
      const { scene, graph, rect } = window.__graphDev;
      const node = graph.getNodeAttributes(id);
      const projected = scene.camera.position
        .clone()
        .set(node.x, node.y, node.z)
        .project(scene.camera);
      const bounds = rect();
      return {
        x: node.x,
        y: node.y,
        z: node.z,
        screenX: bounds.left + ((projected.x + 1) * bounds.width) / 2,
        screenY: bounds.top + ((1 - projected.y) * bounds.height) / 2,
      };
    }, pick.id);
    await page.mouse.move(anchor.screenX, anchor.screenY);
    await page.mouse.down();
    await page.mouse.move(anchor.screenX - 45, anchor.screenY - 25, {
      steps: 8,
    });
    await page.waitForFunction(
      ({ id, anchor }) => {
        const node = window.__graphDev.graph.getNodeAttributes(id);
        return (
          Math.hypot(node.x - anchor.x, node.y - anchor.y, node.z - anchor.z) >
          1
        );
      },
      { id: pick.id, anchor },
      { timeout: 5000 },
    );
    await page.mouse.up();
    await page.waitForFunction(
      ({ id, anchor }) => {
        const node = window.__graphDev.graph.getNodeAttributes(id);
        return (
          Math.hypot(node.x - anchor.x, node.y - anchor.y, node.z - anchor.z) <
          0.1
        );
      },
      { id: pick.id, anchor },
      { timeout: 5000 },
    );
    report.drag = "moves the note and restores its anchor on release";
    const label = await page.evaluate(
      (id) => window.__graphDev.graph.getNodeAttribute(id, "label"),
      pick.id,
    );
    await page.locator(".graph-find").fill(label);
    await page.waitForFunction(
      (id) => window.__graphDev.scene.searchHits?.has(id),
      pick.id,
    );
    await page.locator(".graph-find").fill("");
    report.search = "real note matched and cleared";
    const distance = await page.evaluate(() => {
      const { scene } = window.__graphDev;
      return scene.camera.position.distanceTo(scene.controls.target);
    });
    await page.mouse.move(anchor.screenX, anchor.screenY);
    await page.mouse.wheel(0, -250);
    await page.waitForFunction(
      (before) => {
        const { scene } = window.__graphDev;
        return (
          scene.camera.position.distanceTo(scene.controls.target) <
          before * 0.98
        );
      },
      distance,
      { timeout: 5000 },
    );
    report.zoom = "wheel zoom changes camera distance";
  }
  assert.equal(report.errors.length, 0, report.errors.join("\n"));
} finally {
  await writeFile(
    `${output}/report-${count}.json`,
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report));
  await browser.close();
}
