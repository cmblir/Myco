// Look switching and live-control regressions against the development IPC mock.
// Start Vite, then run: MYCO_TEST_URL=http://127.0.0.1:5184 node scripts/graph-looks-smoke.mjs
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright";

const base = process.env.MYCO_TEST_URL ?? "http://127.0.0.1:5173";
const output = process.env.MYCO_SCREENSHOTS ?? "/tmp/myco-graph-looks-smoke";
// Match the current user-facing picker. Terrain and City remain saved-layout
// compatibility presets, but GraphControls deliberately does not expose them.
const lookNames = {
  default: "Living galaxy", living: "Spiral galaxy", sigma: "Sigma board",
  cosmicweb: "Cosmic web", neural: "Neural", planetarium: "Planetarium",
  paper: "Paper atlas", chronicle: "Chronicle", nebula: "Meaning nebula",
  walrus: "Walrus tree", mycelium: "Mycelium", ribbon: "Woven",
};
await mkdir(output, { recursive: true });
const browser = await chromium.launch({
  args: [
    "--use-gl=angle",
    process.platform === "darwin" ? "--use-angle=metal" : "--use-angle=swiftshader",
    "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist", "--enable-webgl",
  ],
});
const errors = [];
let checks = 0;
function check(condition, message) {
  assert.ok(condition, message);
  checks++;
  console.log(`PASS ${message}`);
}

try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.on("pageerror", (error) => errors.push(error.stack ?? error.message));
  await page.addInitScript(() => {
    localStorage.setItem("myco-ui", JSON.stringify({
      version: 3, state: { lang: "en", theme: "light", sidebarCollapsed: true },
    }));
    localStorage.setItem("myco.graph.settings.v26", JSON.stringify({
      question: "neighbors", skyStyle: "void", pixelNodes: true,
      brightness: 1.6, nodeSize: 2, ambientMotion: false,
    }));
  });
  await page.goto(`${base}/?mock=1`);
  await page.evaluate(async () => {
    const { useUIStore } = await import("/src/stores/uiStore.ts");
    useUIStore.getState().setRoute("graph");
  });
  await page.locator(".graph-canvas.graph-ready").waitFor({ timeout: 60000 });
  await page.locator(".graph-more").getByRole("button", { name: "More", exact: true }).click();
  await page.getByRole("menuitemcheckbox", { name: "Graph settings", exact: true }).click();
  const looks = await page.evaluate(async () => {
    const { VIBE_PRESETS } = await import("/src/lib/graphSettings.ts");
    return Object.entries(VIBE_PRESETS);
  });
  const lookButton = (key) => page.locator(".graph-vibe").filter({
    has: page.locator(".graph-vibe__name", { hasText: new RegExp(`^${lookNames[key]}$`) }),
  });
  check(await page.locator(".graph-vibe").count() === Object.keys(lookNames).length,
    "the picker exposes the 12 current named looks");
  for (const [key, preset] of looks.filter(([key]) => key in lookNames)) {
    await lookButton(key).click();
    await page.waitForFunction((expected) => {
      const scene = window.__graphDev?.scene;
      return scene && Object.entries(expected).every(([name, value]) =>
        scene.settings[name] === value,
      ) && document.querySelector(".graph-canvas.graph-ready");
    }, preset, { timeout: 60000 });
    check(await page.evaluate(() => window.__graphDev.scene.settings.question === "neighbors"),
      `${key}: applying the full look preserves the analysis question`);
  }

  await lookButton("cosmicweb").click();
  await page.waitForFunction(() => window.__graphDev?.scene.settings.skin === "web" &&
    document.querySelector(".graph-canvas.graph-ready"));
  await page.locator(".graph-drawer__section-head").filter({ hasText: "Appearance" }).click();
  await page.getByRole("slider", { name: "Link thickness", exact: true }).fill("0.35");
  await page.waitForFunction(() => Math.abs(window.__graphDev.scene.edgeDensity.quad.material.uniforms.u_strength.value - 1.15 * 0.35) < 0.001);
  check(true, "cosmic web link visibility updates its actual density shader");
  await page.locator(".graph-drawer__section-head").filter({ hasText: "Appearance" }).click();

  // Return from a different renderer, then change one control without touching
  // any other setting. A persisted checkbox alone is not proof of a live update.
  await lookButton("living").click();
  await page.waitForFunction(() => window.__graphDev?.scene.settings.layout === "spiral" &&
    document.querySelector(".graph-canvas.graph-ready"));
  await page.locator(".graph-drawer__section-head").filter({ hasText: "Motion" }).click();
  await page.evaluate(() => { window.__sceneBeforePixel = window.__graphDev.scene; });
  await page.getByRole("switch", { name: /^Pixel nodes/ }).click();
  await page.waitForFunction(() => window.__graphDev.scene.nodeMat.uniforms.u_pixelNodes.value === 1);
  check(await page.evaluate(() => window.__sceneBeforePixel === window.__graphDev.scene),
    "pixel nodes update the shader immediately without rebuilding the graph");
  check(await page.locator("[data-look-adjusted]").count() > 0,
    "a changed preset is marked as adjusted");
  await page.getByRole("button", { name: /Restore.*look|Restore recommended/i }).click();
  await page.waitForFunction(() => window.__graphDev.scene.nodeMat.uniforms.u_pixelNodes.value === 0);
  check(await page.locator("[data-look-adjusted]").count() === 0,
    "restoring the current look clears its adjusted state");

  const ambient = page.getByRole("switch", { name: "Ambient motion", exact: true });
  for (const action of ["click", "Space", "Enter", "click"]) {
    const before = await ambient.getAttribute("aria-checked") === "true";
    if (action === "click") await ambient.click();
    else await ambient.press(action);
    await page.waitForFunction((expected) =>
      window.__graphDev.scene.settings.ambientMotion === expected, !before);
    check(await ambient.getAttribute("aria-checked") === String(!before),
      `${action}: ambient switch updates once and matches the live scene`);
    check(await ambient.evaluate((element) => document.activeElement === element) &&
      await page.locator(".graph-drawer").isVisible(),
    `${action}: the settings panel stays open and the switch keeps focus`);
  }
  const scrollBeforeShortcut = await page.locator(".graph-drawer").evaluate((element) => element.scrollTop);
  await ambient.press("f");
  check(await page.evaluate(() => !window.__graphDev.scene.isFlying()),
    "typing F on a settings control does not trigger the graph flight shortcut");
  check(await ambient.evaluate((element) => document.activeElement === element) &&
    await page.locator(".graph-drawer").evaluate((element) => element.scrollTop) === scrollBeforeShortcut,
  "an unrelated key keeps the settings focus and scroll position");

  await page.locator(".graph-drawer__section-head").filter({ hasText: "Appearance" }).click();
  const preciseSize = page.getByRole("spinbutton", { name: "Node size", exact: true });
  const sizeRange = page.getByRole("slider", { name: "Node size", exact: true });
  await preciseSize.fill("0.65");
  await preciseSize.press("Enter");
  await page.waitForFunction(() => window.__graphDev.scene.settings.nodeSize === 0.65);
  check(await sizeRange.inputValue() === "0.65", "numeric entry updates the live scene and range together");
  await preciseSize.fill("9");
  check(await page.evaluate(() => window.__graphDev.scene.settings.nodeSize === 0.65),
    "an out-of-range draft does not reach the renderer");
  await preciseSize.press("Enter");
  await page.waitForFunction(() => window.__graphDev.scene.settings.nodeSize === 3);
  check(await preciseSize.inputValue() === "3.00", "numeric entry clamps to the supported maximum on commit");
  await preciseSize.fill("");
  await preciseSize.press("Tab");
  check(await preciseSize.inputValue() === "3.00", "an empty entry restores the current value");
  await sizeRange.focus();
  await sizeRange.press("ArrowLeft");
  await page.waitForFunction(() => window.__graphDev.scene.settings.nodeSize === 2.95);
  check(await preciseSize.inputValue() === "2.95", "keyboard range adjustments update the numeric field");
  const nameRange = page.getByRole("slider", { name: "Note name visibility", exact: true });
  check((await nameRange.getAttribute("aria-describedby")) !== null,
    "the label visibility control is linked to its adjustment explanation");
  await page.getByRole("button", { name: /Restore.*look|Restore recommended/i }).click();
  check(await preciseSize.inputValue() === "0.80", "restoring a look also restores numeric entries");
  const playback = page.getByRole("spinbutton", { name: "Timelapse speed", exact: true });
  await playback.fill("0.75");
  await playback.press("Enter");
  await page.waitForFunction(() => JSON.parse(localStorage.getItem("myco.graph.settings.v26")).tlSpeed === 0.75);
  check(await playback.inputValue() === "0.75" && await page.evaluate(() =>
    JSON.parse(localStorage.getItem("myco.graph.settings.v26")).tlSpeed === 0.75),
  "quarter-step controls preserve their exact value after commit");

  const spread = page.getByRole("slider", { name: /^Layout size/ });
  if (!(await spread.count())) {
    await page.locator(".graph-drawer__section-head").filter({ hasText: /Arrangement/ }).click();
  }
  const before = await page.evaluate(() => {
    const { graph, scene } = window.__graphDev;
    window.__sceneBeforeSpread = scene;
    return Math.max(...graph.mapNodes((_id, a) => Math.hypot(a.x, a.y, a.z)));
  });
  await spread.fill("150");
  await page.waitForFunction(() => window.__graphDev.scene !== window.__sceneBeforeSpread &&
    window.__graphDev.scene.settings.linkDistance === 150 &&
    document.querySelector(".graph-canvas.graph-ready"));
  const after = await page.evaluate(() => Math.max(...window.__graphDev.graph.mapNodes(
    (_id, a) => Math.hypot(a.x, a.y, a.z),
  )));
  check(after > before * 1.4, "static layout spread changes actual node positions");
  check(await page.locator('.graph-canvas-wrap[data-graph-theme="dark"]').count() === 1,
    "a galaxy look remains dark inside the light app theme");
  // Spiral deliberately hides community names. Use the labelled celestial
  // arrangement to exercise the same fixed dark skin under a light app theme.
  await lookButton("planetarium").click();
  await page.waitForFunction(() => window.__graphDev.scene.settings.layout === "celestial" &&
    document.querySelector(".graph-canvas.graph-ready"));
  await page.locator(".graph-cluster-label").first().waitFor({ state: "attached" });
  const labelFilters = await page.locator(".graph-cluster-label").evaluateAll((labels) =>
    labels.map((label) => getComputedStyle(label).filter),
  );
  check(labelFilters.length > 0 && labelFilters.every((filter) => filter === "none"),
    "galaxy cluster labels keep their contrast in the light app theme");
  await page.screenshot({ path: `${output}/galaxy-settings.png` });

  for (const [key, label] of [["terrain", "Contour terrain"], ["city", "Block city"]]) {
    check(looks.some(([look]) => look === key) && await page.locator(".graph-vibe__name", { hasText: label }).count() === 0,
      `${key}: the compatibility preset is retained outside the current picker`);
  }
  console.log("UNVERIFIED legacy saved Terrain/City rendering: not part of the current picker workflow");
  for (const key of ["ribbon"]) {
    await lookButton(key).click();
    await page.waitForFunction((layout) => window.__graphDev?.scene.settings.layout === layout &&
      document.querySelector(".graph-canvas.graph-ready"), key);
    const appearance = page.locator(".graph-drawer__section").filter({
      has: page.locator(".graph-drawer__section-head").filter({ hasText: "Appearance" }),
    });
    const motion = page.locator(".graph-drawer__section").filter({
      has: page.locator(".graph-drawer__section-head").filter({ hasText: "Motion" }),
    });
    for (const name of ["Node size", "Link thickness", "Note name visibility"]) {
      check(await appearance.getByRole("slider", { name, exact: true }).isVisible(),
        `${key}: appearance exposes ${name}`);
    }
    check(await appearance.getByRole("switch", { name: "Semantic links", exact: true }).isVisible() &&
      await appearance.getByRole("switch", { name: "Bundled strands", exact: true }).count() === 0,
    `${key}: semantic links remain available without duplicating the woven strands`);
    check(await motion.getByRole("switch", { name: "Ambient motion", exact: true }).isVisible() &&
      await motion.getByRole("switch", { name: /^Pixel nodes/ }).isVisible(),
    `${key}: motion exposes the current orbit and pixel controls`);
    check(await page.getByRole("slider", { name: "Layout size", exact: true }).isVisible() &&
      await page.getByRole("slider", { name: "Repel force", exact: true }).count() === 0,
    `${key}: arrangement exposes its size without ineffective simulation forces`);

    await page.locator(".graph-canvas > canvas").click({ position: { x: 8, y: 8 } });
    await page.keyboard.press("f");
    await page.waitForFunction(() => window.__graphDev.scene.isFlying() && document.querySelector(".ship-hud"));
    check(await page.locator(".ship-hud").isVisible(),
      `${key}: F from the canvas activates its supported flight and HUD`);
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => !window.__graphDev.scene.isFlying() && !document.querySelector(".ship-hud"));
    check(await page.locator(".graph-drawer").isVisible(), `${key}: Escape restores the settings panel`);
  }

  for (const key of ["paper"]) {
    await lookButton("living").click();
    await page.waitForFunction(() => window.__graphDev?.scene.settings.layout === "spiral" &&
      document.querySelector(".graph-canvas.graph-ready"));
    await page.locator(".graph-canvas > canvas").click({ position: { x: 8, y: 8 } });
    await page.keyboard.press("f");
    await page.waitForFunction(() => window.__graphDev.scene.isFlying() && document.querySelector(".ship-hud"));
    check(await page.locator(".ship-hud").isVisible(),
      `${key}: the supported galaxy flight is active before changing the look`);

    // Immersive flight hides the drawer. Invoke its actual preset action to
    // exercise a layout change while flight is still active, without Escape
    // clearing the very state this regression needs to cover.
    await lookButton(key)
      .evaluate((button) => button.click());
    await page.waitForFunction((layout) => window.__graphDev?.scene.settings.layout === layout &&
      !window.__graphDev.scene.isFlying() && !document.querySelector(".ship-hud") &&
      document.querySelector(".graph-canvas.graph-ready"), looks.find(([look]) => look === key)[1].layout);
    check(await page.locator(".graph-drawer").isVisible() &&
      await page.locator(".graph-fullscreen").count() === 0,
    `${key}: switching from flight clears its state, HUD and immersive layout`);
  }
  check(errors.length === 0, `no browser errors (${errors.join("\n")})`);
  console.log(JSON.stringify({ checks, output }));
} finally {
  await browser.close();
}
