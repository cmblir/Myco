// Verify selected-neighborhood readability using synthetic notes only.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { chromium } from "playwright";

const base = process.env.MYCO_TEST_URL ?? "http://127.0.0.1:5173";
const output = process.env.MYCO_SCREENSHOTS ?? "/tmp/myco-graph-readability";
const lookNames = {
  default: "Living galaxy", living: "Spiral galaxy", sigma: "Sigma board",
  cosmicweb: "Cosmic web", neural: "Neural", planetarium: "Planetarium",
  paper: "Paper atlas", chronicle: "Chronicle", nebula: "Meaning nebula",
  walrus: "Walrus tree", mycelium: "Mycelium", ribbon: "Woven",
};
const browser = await chromium.launch({
  args: [
    "--use-gl=angle",
    process.platform === "darwin" ? "--use-angle=metal" : "--use-angle=swiftshader",
    "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist", "--enable-webgl",
  ],
});
const report = { synthetic: true, errors: [], looks: [] };
await mkdir(output, { recursive: true });
try {
  for (const width of [375, 768, 1280]) {
    const page = await browser.newPage({ viewport: { width, height: 900 }, reducedMotion: "reduce" });
    page.on("pageerror", (error) => report.errors.push(error.stack));
    await page.addInitScript(() => {
      performance.setResourceTimingBufferSize(5000);
      window.__importAppModule = (path) => {
        const entry = performance.getEntriesByType("resource")
          .filter((resource) => new URL(resource.name).pathname === path).at(-1);
        if (!entry) throw new Error(`App module was not loaded: ${path}`);
        return import(entry.name);
      };
      localStorage.setItem("myco.onboarded", "1");
      localStorage.setItem("myco-ui", JSON.stringify({ version: 3, state: {
        lang: "en", route: "graph", sidebarCollapsed: true,
      } }));
    });
    await page.goto(`${base}/?mock=1&big=250`);
    await page.locator(".graph-canvas.graph-ready").waitFor({ timeout: 180000 });
    if (width <= 768) {
      await page.getByRole("button", { name: "Graph tools", exact: true }).click();
    }
    const presets = await page.evaluate(async () =>
      (await window.__importAppModule("/src/lib/graphSettings.ts")).VIBE_PRESETS,
    );
    for (const [key, name] of Object.entries(lookNames)) {
      if ((await page.locator(".graph-drawer").count()) === 0) {
        await page.locator(".graph-more").getByRole("button", { name: "More", exact: true }).click();
        await page.getByRole("menuitemcheckbox", { name: "Graph settings", exact: true }).click();
      }
      const look = page.locator(".graph-vibe").filter({
        has: page.locator(".graph-vibe__name", { hasText: new RegExp(`^${name}$`) }),
      });
      assert.equal(await look.count(), 1, `${name}: the current picker has exactly one named look`);
      await look.click();
      await page.waitForFunction(
        ({ preset, mycelium }) => {
          const scene = window.__graphDev?.scene;
          return scene && Object.entries(preset).every(([name, value]) => scene.settings[name] === value) &&
            document.querySelector(".graph-canvas.graph-ready") &&
            (!mycelium || window.__myceliumDev?.scene);
        },
        { preset: presets[key], mycelium: key === "mycelium" },
        { timeout: 60000 },
      );
      const result = await page.evaluate(async (key) => {
        const { graph, scene } = window.__graphDev;
        if (key === "mycelium") {
          const renderer = window.__myceliumDev.scene;
          const id = graph.nodes().find((id) => {
            const p = renderer.projectToScreen(id);
            return !id.startsWith("ghost:") && p && p.x > 20 && p.y > 20 &&
              p.x < renderer.renderer.domElement.clientWidth - 20 &&
              p.y < renderer.renderer.domElement.clientHeight - 20;
          });
          if (!id) throw new Error(`${key}: no real note is inside the viewport`);
          renderer.opts.onPick(id);
          return { key, id };
        }
        const id = graph.nodes().find((id) => {
          const a = graph.getNodeAttributes(id);
          const p = scene.camera.position.clone().set(a.x, a.y, a.z).project(scene.camera);
          return !id.startsWith("ghost:") && !a.hidden &&
            Math.abs(p.x) < 0.65 && Math.abs(p.y) < 0.65 && Math.abs(p.z) < 1;
        });
        if (!id) throw new Error(`${key}: no real note is inside the viewport`);
        scene.setSelectedNode(id);
        scene.setStyleState({ ...scene.style, hoveredNode: null, neighbors: null });
        scene.interacting = false;
        scene.updateLabels();
        return { key, id, selectedLabelVisible: scene.shownLabels.has(id), labelCount: scene.shownLabels.size };
      }, key);
      assert.ok(result.id, `${key}: a real visible note exists`);
      if (key === "mycelium") {
        await page.waitForFunction((id) => {
          const renderer = window.__myceliumDev.scene;
          renderer.opts.onHover(null);
          return renderer.labelIds[0]?.id === id;
        }, result.id);
        result.selectedLabelCandidate = await page.evaluate(
          () => window.__myceliumDev.scene.labelIds[0]?.id,
        );
        assert.equal(result.selectedLabelCandidate, result.id, "mycelium preserves selected neighborhood after hover leaves");
        const inspector = page.locator(".graph-inspector");
        await inspector.waitFor();
        result.inspectorHead = await inspector.locator(".graph-insp__title").evaluate((title) => {
          const rect = title.getBoundingClientRect();
          const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
          return { readable: !!hit && title.contains(hit), hitClass: hit?.className, top: rect.top };
        });
        await page.locator(".graph-canvas").screenshot({ path: `${output}/${width}-inspector.png` });
        assert.equal(result.inspectorHead.readable, true, `${width}: graph tools cannot cover the inspector title`);
        assert.equal(await inspector.getAttribute("role"), "region");
      } else {
        assert.ok(result.selectedLabelVisible, `${key}: selected note has a visible name`);
        // The drawer otherwise covers the selected name in a narrow screenshot.
        await page.locator(".graph-drawer").getByRole("button", { name: "Close", exact: true }).click();
      }
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
        true,
        `${key}: no horizontal page overflow`,
      );
      await page.locator(".graph-canvas").screenshot({ path: `${output}/${width}-${key}.png` });
      if (key === "mycelium") {
        const inspector = page.locator(".graph-inspector");
        await inspector.getByRole("button", { name: "Close", exact: true }).press("Enter");
        await inspector.waitFor({ state: "hidden" });
      }
      report.looks.push({ width, ...result });
      console.log(JSON.stringify({ width, ...result }));
    }
    await page.close();
  }
  assert.deepEqual(report.errors, []);
} finally {
  await writeFile(`${output}/report.json`, JSON.stringify(report, null, 2));
  await browser.close();
}
