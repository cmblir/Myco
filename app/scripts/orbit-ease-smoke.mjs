// Usage (dev server on :5173):  node scripts/orbit-ease-smoke.mjs
//
// One stable page load, no source-swap. Measures the eased setOrbitTarget vs a
// direct target.copy (what the old code did) with the SAME frame-sampling
// metric, proving both the fix and that the metric discriminates a snap.
import { chromium } from "playwright";
const b = await chromium.launch({ headless: true, args: ["--use-gl=swiftshader", "--enable-unsafe-swiftshader"] });
const page = await b.newPage({ viewport: { width: 1280, height: 800 } });
await page.addInitScript(() => {
  localStorage.setItem("memex.onboarded", "1");
  localStorage.setItem("memex-ui", JSON.stringify({ state: { lang: "en", theme: "light" }, version: 3 }));
});
await page.goto("http://localhost:5173/?mock=1", { waitUntil: "domcontentloaded", timeout: 60000 });
await page.waitForSelector(".side-nav .nav-item", { timeout: 30000 });
await page.evaluate(() => {
  const k = "memex.graph.settings.v26";
  const cur = JSON.parse(localStorage.getItem(k) || "{}");
  localStorage.setItem(k, JSON.stringify(cur.state ? { ...cur, state: { ...cur.state, multiverse: true } } : { ...cur, multiverse: true }));
});
await page.reload({ waitUntil: "domcontentloaded", timeout: 60000 });
await page.waitForSelector(".side-nav .nav-item", { timeout: 30000 });
await page.locator(".side-nav .nav-item", { hasText: "Graph" }).first().click();
await page.waitForFunction(() => Boolean(window.__mvDev), null, { timeout: 30000 });
await page.waitForTimeout(2500);

async function movingFramesAfter(mode) {
  return await page.evaluate(async (mode) => {
    const scene = window.__mvDev.scene;
    const start = scene.getOrbitTarget();
    const to = start.clone(); to.x += 4000; to.y += 1500; to.z -= 2500;
    if (mode === "ease") scene.setOrbitTarget(to);
    else scene.controls.target.copy(to); // the old snap, via the (runtime-visible) field
    const samples = [];
    await new Promise((res) => { let n=0; const t=()=>{const p=scene.getOrbitTarget();samples.push({x:p.x,y:p.y,z:p.z});if(++n>=30)return res();requestAnimationFrame(t);}; requestAnimationFrame(t); });
    const d=(a,b)=>Math.hypot(a.x-b.x,a.y-b.y,a.z-b.z);
    let mv=0; for(let i=1;i<samples.length;i++) if(d(samples[i],samples[i-1])>1) mv++;
    // reset the pivot for the next measurement
    scene.controls.target.copy(start);
    return mv;
  }, mode);
}

const ease = await movingFramesAfter("ease");
await page.waitForTimeout(400);
const snap = await movingFramesAfter("snap");
console.log(JSON.stringify({ easeMovingFrames: ease, snapMovingFrames: snap }));
const ok = ease >= 4 && snap <= 1;
console.log(ok ? "PASS  ease spreads over frames; a direct copy is a 1-frame snap" : "FAIL");
await b.close();
process.exit(ok ? 0 : 1);
