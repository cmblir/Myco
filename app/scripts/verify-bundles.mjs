// Headless geometry verification for A1 + GRAPH-01 (software GL — shape only).
// Loads the skewed 8k mock (one dominant folder ~90%, like the real vault),
// waits for the worker settle, then asserts:
//  1) per-cluster separation survived (no blob regression)
//  2) bundled strands were built and are visible after settle
//  3) settle metrics framed the camera (graph-ready + finite camera distance)
import { chromium } from "playwright";

const URL = "http://localhost:5173/?mock=1&big=8000&skew=1#/graph";
const OUT = process.env.OUT || "/tmp/verify-bundles";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
page.on("console", (m) => {
  if (m.type() === "error") console.log("[console.error]", m.text());
});
await page.goto(URL, { waitUntil: "domcontentloaded" });
// The hash route is ignored on a cold load — click into the graph view.
try {
  await page.getByText("그래프", { exact: true }).first().click({ timeout: 30000 });
} catch {
  await page.getByText("Graph", { exact: true }).first().click({ timeout: 30000 });
}
await page.waitForSelector(".graph-canvas.graph-ready", { timeout: 90000 }).catch(() => {});
// graph-ready lands early (300ms reveal); wait for the actual settle: the
// bundle layer only gets strands from layoutSettled().
try {
  await page.waitForFunction(
    () => {
      const dev = window.__graphDev;
      if (!dev) return false;
      const b = dev.scene?.bundles;
      return !!b && b.lines.some((l) => l.visible);
    },
    undefined,
    { timeout: 120000 },
  );
} catch (err) {
  const probe = await page.evaluate(() => {
    const dev = window.__graphDev;
    return {
      hasDev: !!dev,
      hasBundles: !!dev?.scene?.bundles,
      tierVisible: dev?.scene?.bundles?.lines?.map((l) => l.visible) ?? null,
      tierCounts: dev?.scene?.bundles?.lines?.map(
        (l) => l.geometry?.attributes?.instanceStart?.count ?? 0,
      ) ?? null,
      settingsBundles: dev?.scene?.settings?.edgeBundles,
    };
  });
  console.log("PROBE", JSON.stringify(probe));
  throw err;
}
await page.waitForTimeout(1500); // post-settle fit + a few frames

const report = await page.evaluate(() => {
  const dev = window.__graphDev;
  const g = dev.graph;
  // community -> centroid + rms
  const sx = new Map(), sy = new Map(), sz = new Map(), sn = new Map();
  g.forEachNode((_id, a) => {
    if (a.community < 0) return;
    sx.set(a.community, (sx.get(a.community) ?? 0) + a.x);
    sy.set(a.community, (sy.get(a.community) ?? 0) + a.y);
    sz.set(a.community, (sz.get(a.community) ?? 0) + a.z);
    sn.set(a.community, (sn.get(a.community) ?? 0) + 1);
  });
  const cents = [];
  for (const [c, n] of sn) {
    if (n < 20) continue;
    cents.push({ c, n, x: sx.get(c) / n, y: sy.get(c) / n, z: sz.get(c) / n });
  }
  const r2 = new Map();
  g.forEachNode((_id, a) => {
    const e = cents.find((p) => p.c === a.community);
    if (!e) return;
    const dx = a.x - e.x, dy = a.y - e.y, dz = a.z - e.z;
    r2.set(a.community, (r2.get(a.community) ?? 0) + dx * dx + dy * dy + dz * dz);
  });
  for (const e of cents) e.r = Math.sqrt((r2.get(e.c) ?? 0) / e.n);
  cents.sort((p, q) => q.n - p.n);
  const top = cents.slice(0, 12);
  // separation ratio: centroid distance / (rA + rB) for every top pair.
  let minRatio = Infinity, pairs = 0, separated = 0;
  for (let i = 0; i < top.length; i++) {
    for (let j = i + 1; j < top.length; j++) {
      const a = top[i], b = top[j];
      const d = Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
      const ratio = d / (a.r + b.r);
      minRatio = Math.min(minRatio, ratio);
      pairs++;
      if (ratio > 0.8) separated++;
    }
  }
  const bl = dev.scene.bundles;
  const tiers = bl.lines.map((l, i) => ({
    tier: i,
    visible: l.visible,
    segments: l.geometry?.attributes?.instanceStart?.count ?? 0,
  }));
  const cam = dev.scene.camera.position;
  return {
    nodes: g.order,
    clusters: cents.length,
    topPairs: pairs,
    separatedPairs: separated,
    minSepRatio: Number(minRatio.toFixed(3)),
    bundleTiers: tiers,
    camDist: Number(Math.hypot(cam.x, cam.y, cam.z).toFixed(1)),
  };
});
console.log(JSON.stringify(report, null, 2));
await page.screenshot({ path: `${OUT}-settled.png` });

// A quick orbit to a second angle — separation must hold from any viewpoint.
await page.mouse.move(640, 400);
await page.mouse.down();
await page.mouse.move(900, 350, { steps: 12 });
await page.mouse.up();
await page.waitForTimeout(700);
await page.screenshot({ path: `${OUT}-orbit.png` });

// Toggle check (review finding): flip "Bundled strands" OFF in the drawer and
// assert the strands actually disappear (the settings effect must push
// applySettings on edgeBundles change), then back ON -> visible again.
await page.locator(".graph-toolbar button, .graph-page button").filter({ hasText: "" }).first().waitFor({ timeout: 5000 }).catch(() => {});
// Open the settings drawer via the gear button (last toolbar button with the gear svg).
await page.locator('button[title*="설정"], button[aria-label*="설정"], button[title*="Settings"], button[aria-label*="Settings"]').last().click().catch(async () => {
  // fallback: click the gear-looking toolbar button
  await page.locator(".graph-toolbar button").last().click();
});
const strandToggle = page.getByText("번들 스트랜드", { exact: false }).first();
await strandToggle.waitFor({ timeout: 5000 });
await strandToggle.click();
await page.waitForTimeout(400);
const offState = await page.evaluate(() => {
  const b = window.__graphDev.scene.bundles;
  return { groupVisible: b.group.visible, anyLine: b.lines.some((l) => l.visible) };
});
await strandToggle.click();
await page.waitForTimeout(400);
const onState = await page.evaluate(() => {
  const b = window.__graphDev.scene.bundles;
  return { groupVisible: b.group.visible, anyLine: b.lines.some((l) => l.visible) };
});
console.log("toggle off:", JSON.stringify(offState), "on:", JSON.stringify(onState));
const toggleOk = offState.groupVisible === false && onState.groupVisible === true && onState.anyLine;
console.log(toggleOk ? "TOGGLE PASS" : "TOGGLE FAIL");

await browser.close();

const anyBundle = report.bundleTiers.some((t) => t.visible && t.segments > 0);
const ok =
  report.separatedPairs / report.topPairs >= 0.85 &&
  anyBundle &&
  report.camDist > 100 &&
  toggleOk;
console.log(ok ? "VERIFY PASS" : "VERIFY FAIL");
process.exit(ok ? 0 : 1);
