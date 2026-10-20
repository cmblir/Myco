// Synthetic-only visual evidence for the three sculpted graph looks.
// MYCO_TEST_URL=http://127.0.0.1:5191 MYCO_SCREENSHOTS=/tmp/quality node scripts/sculpted-quality-smoke.mjs 250
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { chromium } from "playwright";

const count = Number(process.argv[2] ?? 250);
const base = process.env.MYCO_TEST_URL ?? "http://127.0.0.1:5191";
const output = process.env.MYCO_SCREENSHOTS ?? "/tmp/myco-sculpted-quality";
const keys = (
  process.env.MYCO_LOOKS ?? "terrain,ribbon,city,sigma,walrus"
).split(",");
const verify = process.env.MYCO_VERIFY === "1";
await mkdir(output, { recursive: true });
const report = {
  synthetic: true,
  requestedNodes: count,
  viewport: { width: 1440, height: 900 },
  errors: [],
  looks: [],
  reducedMotion: [],
};
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
try {
  const page = await browser.newPage({ viewport: report.viewport });
  page.on("pageerror", (error) =>
    report.errors.push(error.stack ?? error.message),
  );
  page.on("console", (message) => {
    if (message.type() === "error") report.errors.push(message.text());
  });
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
        layout: "terrain",
        skin: "white",
        question: "neighbors",
        ambientMotion: false,
      }),
    );
  });
  await page.goto(`${base}/?mock=1&big=${count}`);
  await page.locator(".graph-canvas.graph-ready").waitFor({ timeout: 180000 });
  await page.locator(".graph-drawer-toggle--closed").click();
  const looks = await page.evaluate(async () =>
    Object.entries((await import("/src/lib/graphSettings.ts")).VIBE_PRESETS),
  );
  let expectedEdges;
  for (const key of keys) {
    const index = looks.findIndex(([name]) => name === key);
    assert.ok(index >= 0, `known look ${key}`);
    const preset = looks[index][1];
    const start = Date.now();
    await page.locator(".graph-vibe").nth(index).click();
    await page.waitForFunction(
      (expected) => {
        const scene = window.__graphDev?.scene;
        return (
          scene &&
          Object.entries(expected).every(
            ([name, value]) => scene.settings[name] === value,
          ) &&
          document.querySelector(".graph-canvas.graph-ready")
        );
      },
      preset,
      { timeout: 180000 },
    );
    await page.waitForTimeout(1800);
    const measured = await page.evaluate(async () => {
      const { graph, scene } = window.__graphDev;
      const gl = scene.renderer.getContext();
      const extension = gl.getExtension("WEBGL_debug_renderer_info");
      const frames = [];
      const start = performance.now();
      let last = start;
      await new Promise((resolve) => {
        const tick = (now) => {
          frames.push(now - last);
          last = now;
          if (now - start < 2000) requestAnimationFrame(tick);
          else resolve();
        };
        requestAnimationFrame(tick);
      });
      const sorted = [...frames].sort((a, b) => a - b);
      return {
        nodes: graph.order,
        edges: graph.size,
        finitePositions: graph
          .mapNodes((_id, a) => [a.x, a.y, a.z])
          .every((point) => point.every(Number.isFinite)),
        gpu: extension
          ? gl.getParameter(extension.UNMASKED_RENDERER_WEBGL)
          : gl.getParameter(gl.RENDERER),
        fps: +((1000 * frames.length) / (last - start)).toFixed(1),
        medianMs: +sorted[Math.floor(sorted.length / 2)].toFixed(2),
        p95Ms: +sorted[Math.floor(sorted.length * 0.95)].toFixed(2),
        draw: { ...scene.renderer.info.render },
        camera: scene.camera.position.toArray(),
        settings: scene.settings,
      };
    });
    assert.equal(measured.nodes, count, `${key}: preserve notes`);
    expectedEdges ??= measured.edges;
    assert.equal(measured.edges, expectedEdges, `${key}: preserve links`);
    assert.ok(measured.finitePositions, `${key}: finite positions`);
    await page
      .locator(".graph-canvas")
      .screenshot({ path: `${output}/${key}.png` });
    const result = { key, captureElapsedMs: Date.now() - start, ...measured };
    if (verify && ["terrain", "ribbon", "city"].includes(key)) {
      const identity = await page.evaluate(() => {
        const { graph, scene } = window.__graphDev;
        const layer = scene.sculpted;
        const positions = layer.linkGeometry.getAttribute("position");
        return {
          instances: layer.nodes.count,
          identities: layer.ids,
          identitiesValid: layer.ids.every((id) => graph.hasNode(id)),
          pairs: layer.pairs.length,
          pairsValid: layer.pairs.every(([source, target]) =>
            graph.hasEdge(source, target),
          ),
          finiteLinks: Array.from(positions.array).every(Number.isFinite),
        };
      });
      assert.equal(identity.instances, count, `${key}: one solid per note`);
      assert.equal(
        new Set(identity.identities).size,
        count,
        `${key}: unique note identities`,
      );
      assert.ok(
        identity.identitiesValid && identity.pairsValid && identity.finiteLinks,
        `${key}: real note/link identities and finite link geometry`,
      );
      assert.equal(
        identity.pairs,
        expectedEdges,
        `${key}: renderer retains every explicit link`,
      );
      result.identity = { ...identity, identities: undefined };

      await page.locator(".graph-drawer__btn--icon").click();
      await page.waitForTimeout(450);
      await page
        .locator(".graph-canvas")
        .screenshot({ path: `${output}/${key}-full.png` });
      const pick = await page.evaluate(async () => {
        const { Vector3 } =
          await import("/node_modules/three/build/three.module.js");
        const { graph, scene } = window.__graphDev;
        const rect = scene.renderer.domElement.getBoundingClientRect();
        const candidates = graph
          .mapNodes((id, attrs) => {
            const point = new Vector3(attrs.x, attrs.y, attrs.z).project(
              scene.camera,
            );
            return {
              id,
              z: point.z,
              x: rect.left + ((point.x + 1) * rect.width) / 2,
              y: rect.top + ((1 - point.y) * rect.height) / 2,
            };
          })
          .filter(
            ({ x, y, z }) =>
              z > -1 &&
              z < 1 &&
              x > rect.left + 30 &&
              x < rect.right - 30 &&
              y > rect.top + 30 &&
              y < rect.bottom - 30,
          );
        for (const candidate of candidates) {
          if (scene.pickNode(candidate.x, candidate.y) === candidate.id)
            return candidate;
        }
        return null;
      });
      assert.ok(pick, `${key}: visible note is pickable`);
      await page.mouse.click(pick.x, pick.y);
      await page.waitForFunction(
        (id) => window.__graphDev.scene.selectedNode === id,
        pick.id,
      );
      const inspectorTitle = page.locator(".graph-insp__title");
      await inspectorTitle.waitFor();
      assert.equal(
        await inspectorTitle.getAttribute("title"),
        pick.id,
        `${key}: Inspector uses the clicked note`,
      );
      result.selection = {
        requested: pick.id,
        actual: await page.evaluate(() => window.__graphDev.scene.selectedNode),
        inspectorTitle: await inspectorTitle.textContent(),
        inspectorLinks: await page.locator(".graph-insp__link").count(),
      };
      await page.screenshot({ path: `${output}/${key}-selected.png` });
      await page.locator(".graph-insp__head button").click();
      await page.locator(".graph-drawer-toggle--closed").click();
      const size = page.getByRole("slider", { name: "노드 크기", exact: true });
      if (!(await size.isVisible()))
        await page
          .locator(".graph-drawer__section-head")
          .filter({ hasText: "외형" })
          .click();
      const beforeScale = await page.evaluate(() =>
        Array.from(
          window.__graphDev.scene.sculpted.nodes.instanceMatrix.array.slice(
            0,
            16,
          ),
        ),
      );
      await size.fill("1.2");
      await page.waitForFunction(
        () => window.__graphDev.scene.settings.nodeSize === 1.2,
      );
      const afterScale = await page.evaluate(() =>
        Array.from(
          window.__graphDev.scene.sculpted.nodes.instanceMatrix.array.slice(
            0,
            16,
          ),
        ),
      );
      assert.notDeepEqual(
        afterScale,
        beforeScale,
        `${key}: size control changes actual solid geometry`,
      );
      const links = page.getByRole("slider", {
        name: "링크 두께",
        exact: true,
      });
      await links.fill("0.3");
      await page.waitForFunction(
        () => window.__graphDev.scene.settings.linkThickness === 0.3,
      );
      const weakLinks = await page.evaluate(
        () => window.__graphDev.scene.sculpted.linkMaterial.opacity,
      );
      await links.fill("1");
      await page.waitForFunction(
        () => window.__graphDev.scene.settings.linkThickness === 1,
      );
      const strongLinks = await page.evaluate(
        () => window.__graphDev.scene.sculpted.linkMaterial.opacity,
      );
      assert.ok(
        strongLinks > weakLinks,
        `${key}: link visibility changes actual renderer material`,
      );
      await links.fill("3");
      await page.waitForFunction(
        () => window.__graphDev.scene.settings.linkThickness === 3,
      );
      const maximumLinks = await page.evaluate(
        () => window.__graphDev.scene.sculpted.linkMaterial.opacity,
      );
      assert.ok(
        maximumLinks > strongLinks,
        `${key}: link visibility continues increasing from 1 to 3`,
      );
      await links.fill(String(preset.linkThickness));
      result.controls = {
        nodeSizeChangesGeometry: true,
        linkVisibilityUpdatesRenderer: true,
        linkVisibilityUpperRange: true,
        linkOpacity: {
          low: weakLinks,
          normal: strongLinks,
          maximum: maximumLinks,
        },
      };
      await page.locator(".graph-vibe").nth(index).click();
      await page.waitForFunction(
        (expected) =>
          Object.entries(expected).every(
            ([name, value]) => window.__graphDev.scene.settings[name] === value,
          ),
        preset,
      );
      await page
        .locator(".graph-drawer__section-head")
        .filter({ hasText: "외형" })
        .click();
    }
    report.looks.push(result);
    await writeFile(`${output}/report.json`, JSON.stringify(report, null, 2));
    console.log(
      JSON.stringify({
        key,
        nodes: measured.nodes,
        edges: measured.edges,
        fps: measured.fps,
      }),
    );
  }
  if (verify) {
    await page.close();
    for (const key of keys.filter((key) =>
      ["terrain", "ribbon", "city"].includes(key),
    )) {
      const reduced = await browser.newPage({
        viewport: report.viewport,
        reducedMotion: "reduce",
      });
      reduced.on("pageerror", (error) =>
        report.errors.push(error.stack ?? error.message),
      );
      reduced.on("console", (message) => {
        if (message.type() === "error") report.errors.push(message.text());
      });
      const preset = looks.find(([name]) => name === key)[1];
      await reduced.addInitScript((preset) => {
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
            ...preset,
            question: "neighbors",
            ambientMotion: true,
          }),
        );
      }, preset);
      await reduced.goto(`${base}/?mock=1&big=${count}`);
      await reduced
        .locator(".graph-canvas.graph-ready")
        .waitFor({ timeout: 180000 });
      await reduced.waitForTimeout(800);
      const before = await reduced.evaluate(() => {
        const scene = window.__graphDev.scene;
        return {
          camera: scene.camera.position.toArray(),
          reduced: scene.reducedMotion,
          ambient: scene.ambientOn(),
          autoRotate: scene.controls.autoRotate,
        };
      });
      await reduced.waitForTimeout(650);
      const camera = await reduced.evaluate(() =>
        window.__graphDev.scene.camera.position.toArray(),
      );
      assert.equal(before.reduced, true, `${key}: reads OS reduced motion`);
      assert.equal(before.ambient, false, `${key}: suppresses ambient effects`);
      assert.equal(
        before.autoRotate,
        false,
        `${key}: suppresses auto rotation`,
      );
      const cameraDrift = Math.hypot(
        ...camera.map((value, index) => value - before.camera[index]),
      );
      // OrbitControls round trips spherical coordinates every frame; tolerate
      // floating-point noise while rejecting visible automatic movement.
      assert.ok(
        cameraDrift < 1e-7,
        `${key}: reduced-motion camera stays still (drift ${cameraDrift})`,
      );
      report.reducedMotion.push({
        key,
        ...before,
        cameraStable: true,
        cameraDrift,
      });
      await reduced.close();
    }
  }
  assert.deepEqual(report.errors, []);
} finally {
  await writeFile(`${output}/report.json`, JSON.stringify(report, null, 2));
  await browser.close();
}
