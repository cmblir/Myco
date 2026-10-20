// The screenshot set behind app/docs/design/graph-visual-rules.md: every look
// the Graph page offers, on the ?mock=1 vault, in the light and the dark app
// theme, 1280x900, both rails folded, each look from its own default framing
// after a fresh load, shot WAIT_MS after the canvas is ready. Also writes
// stats.md: per-canvas background, ink coverage, ink saturation/chroma and
// how many 30° hue bins carry >=3% of the chromatic ink. The stats are taken
// from a second clip with the note labels and cluster names hidden, so they
// measure what the look draws, not the label text; the saved shots keep the
// labels for the eye.
// Start Vite, then run: MYCO_TEST_URL=http://127.0.0.1:5173 node scripts/graph-look-shots.mjs
// env: MYCO_SCREENSHOTS (output dir), QUESTION (orphans|clusters|time|neighbors),
//      LOOKS (comma list), THEMES (comma list), WAIT_MS
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";

const base = process.env.MYCO_TEST_URL ?? "http://127.0.0.1:5173";
const output = process.env.MYCO_SCREENSHOTS ?? "/tmp/myco-graph-look-shots";
// The picker's order (GraphControls vibeMeta); checked against the drawer below.
const PICKER = ["default", "living", "sigma", "cosmicweb", "neural", "planetarium", "paper", "chronicle", "nebula", "walrus", "mycelium", "ribbon"];
const looks = (process.env.LOOKS ?? PICKER.join(",")).split(",");
const themes = (process.env.THEMES ?? "light,dark").split(",");
const waitMs = Number(process.env.WAIT_MS ?? 7000);
const viewport = { width: 1280, height: 900 };
await mkdir(output, { recursive: true });
const browser = await chromium.launch({
  args: ["--use-gl=angle", process.platform === "darwin" ? "--use-angle=metal" : "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist", "--enable-webgl"],
});

async function open(theme, settings) {
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(({ theme, settings }) => {
    localStorage.setItem("myco.onboarded", "1");
    localStorage.setItem("myco-ui", JSON.stringify({ version: 3, state: { lang: "en", theme, route: "graph" } }));
    if (settings) localStorage.setItem("myco.graph.settings.v26", JSON.stringify(settings));
  }, { theme, settings });
  await page.goto(`${base}/?mock=1`);
  await page.locator(".graph-canvas.graph-ready").waitFor({ timeout: 120000 });
  return { context, page, errors };
}

// Pixel stats of one canvas clip, measured in the page (no image library).
function canvasStats(b64) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement("canvas");
      c.width = img.width;
      c.height = img.height;
      const g = c.getContext("2d");
      g.drawImage(img, 0, 0);
      const { width: W, height: H } = c;
      const d = g.getImageData(0, 0, W, H).data;
      // Skip overlay chrome: top band (drawer toggle), rail tabs, minimap corner.
      const chrome = (x, y) => y < 90 || x < 40 || x > W - 40 || (x > W - 170 && y > H - 170);
      const at = [];
      const counts = new Map();
      for (let y = 0; y < H; y += 2) for (let x = 0; x < W; x += 2) {
        if (chrome(x, y)) continue;
        const i = (y * W + x) * 4;
        at.push(i);
        const k = ((d[i] >> 4) << 8) | ((d[i + 1] >> 4) << 4) | (d[i + 2] >> 4);
        counts.set(k, (counts.get(k) ?? 0) + 1);
      }
      const mode = [...counts].sort((a, b) => b[1] - a[1])[0][0];
      const bg = [0, 0, 0];
      let n = 0;
      for (const i of at) {
        if ((((d[i] >> 4) << 8) | ((d[i + 1] >> 4) << 4) | (d[i + 2] >> 4)) !== mode) continue;
        bg[0] += d[i]; bg[1] += d[i + 1]; bg[2] += d[i + 2]; n++;
      }
      bg.forEach((v, k) => { bg[k] = v / n; });
      let ink = 0, sat = 0, chroma = 0, chromatic = 0;
      const bins = new Array(12).fill(0);
      for (const i of at) {
        const [r, gr, b] = [d[i], d[i + 1], d[i + 2]];
        if (Math.abs(r - bg[0]) + Math.abs(gr - bg[1]) + Math.abs(b - bg[2]) < 45) continue;
        ink++;
        const mx = Math.max(r, gr, b), ch = mx - Math.min(r, gr, b);
        chroma += ch;
        sat += mx ? ch / mx : 0;
        if (ch <= 35) continue;
        chromatic++;
        const h = mx === r ? ((gr - b) / ch) % 6 : mx === gr ? (b - r) / ch + 2 : (r - gr) / ch + 4;
        bins[Math.floor(((h * 60 + 360) % 360) / 30)]++;
      }
      const hex = "#" + bg.map((v) => Math.round(v).toString(16).padStart(2, "0")).join("");
      resolve({
        bg: hex,
        inkPct: +(100 * ink / at.length).toFixed(2),
        inkSat: ink ? +(sat / ink).toFixed(2) : 0,
        inkChroma: ink ? Math.round(chroma / ink) : 0,
        hueBins: bins.filter((v) => chromatic && v / chromatic >= 0.03).length,
      });
    };
    img.src = `data:image/png;base64,${b64}`;
  });
}

const rows = [];
try {
  const probe = await open("light", null);
  const { defaults, vibes } = await probe.page.evaluate(async () => {
    const m = await import("/src/lib/graphSettings.ts");
    return { defaults: m.DEFAULT_GRAPH_SETTINGS, vibes: m.VIBE_PRESETS };
  });
  await probe.page.locator(".graph-drawer-toggle--closed").click();
  const cards = await probe.page.locator(".graph-vibe").count();
  if (cards !== PICKER.length) throw new Error(`picker shows ${cards} looks, this script knows ${PICKER.length}`);
  await probe.context.close();
  for (const theme of themes) {
    for (const look of looks) {
      const settings = {
        ...defaults, ...vibes[look], gapsRailOpen: false, legendRailOpen: false,
        ...(process.env.QUESTION ? { question: process.env.QUESTION } : {}),
      };
      const { context, page, errors } = await open(theme, settings);
      await page.waitForTimeout(waitMs);
      const tag = `${look}-${theme}`;
      await page.screenshot({ path: path.join(output, `${tag}.png`) });
      const box = await page.locator(".graph-canvas").boundingBox();
      await page.screenshot({ clip: box, path: path.join(output, `${tag}-canvas.png`) });
      await page.addStyleTag({ content: ".graph-cluster-label,.graph-label-3d{visibility:hidden!important}" });
      await page.waitForTimeout(150);
      const marks = await page.screenshot({ clip: box });
      rows.push({ tag, ...(await page.evaluate(canvasStats, marks.toString("base64"))), errors: errors.length });
      console.log(JSON.stringify(rows.at(-1)));
      await context.close();
    }
  }
} finally {
  const table = ["shot | bg | ink % | ink saturation | ink chroma | hue bins >=3% | page errors", "---|---|---|---|---|---|---"];
  for (const r of rows) table.push(`${r.tag} | ${r.bg} | ${r.inkPct} | ${r.inkSat} | ${r.inkChroma} | ${r.hueBins} | ${r.errors}`);
  await writeFile(path.join(output, "stats.md"), table.join("\n") + "\n");
  await browser.close();
}
