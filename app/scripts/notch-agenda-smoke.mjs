// Headless check of the notch agenda: collapsed mark, hovered rows, the
// decided-row beat, and the empty case. Run against a dev server on :5173.
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Port and output come from the env so the script rides whatever dev server
// is up and writes where the caller wants.
const PORT = process.env.NOTCH_SMOKE_PORT ?? "5173";

const BASE = `http://localhost:${PORT}`;
const SHOTS = process.env.NOTCH_SMOKE_OUT ?? join(tmpdir(), "notch-agenda-shots");
mkdirSync(SHOTS, { recursive: true });

let failures = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "  ok" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 420, height: 260 } });
page.on("console", (m) => {
  if (m.type() === "error") console.log(`    [console] ${m.text()}`);
});

// --- with an agenda (the ?mock=1 get_tray_status fixture) -------------------
await page.goto(`${BASE}/?mock=1&window=notch`, { waitUntil: "networkidle" });
await page.waitForTimeout(900);

const markText = await page
  .locator(".notch-mark")
  .textContent()
  .catch(() => null);
check("collapsed shows the waiting count", markText === "4", `mark=${markText}`);
check(
  "collapsed shows the lit cap",
  (await page.locator(".notch-mark .notch-cap-live").count()) === 1,
);
check(
  "collapsed draws no card",
  (await page.locator(".notch-body").count()) === 0,
);
const markBox = await page.locator(".notch-mark").boundingBox();
console.log(`    mark box: ${JSON.stringify(markBox)}`);
await page.screenshot({ path: `${SHOTS}/1-collapsed-waiting.png` });

await page.hover(".notch");
await page.waitForTimeout(700);
const rows = page.locator(".notch-agenda");
check("hover lists three rows", (await rows.count()) === 3);
const labels = await rows.locator(".notch-grow").allTextContents();
console.log(`    rows: ${JSON.stringify(labels)}`);
const buttons = await rows.locator("button").allTextContents();
console.log(`    buttons: ${JSON.stringify(buttons)}`);
check(
  "the queue row offers one button, the decisions two",
  buttons.length === 5,
  `${buttons.length}`,
);
const cardBox = await page.locator(".notch").boundingBox();
console.log(`    card box: ${JSON.stringify(cardBox)}`);
// The real invariant: every button is inside the card, and the card is inside
// the OS window the driver asked for (cutout 204 + 80 + 24 = 308 in the mock).
const btnBoxes = await rows.locator("button").evaluateAll((els) =>
  els.map((el) => {
    const r = el.getBoundingClientRect();
    return { left: r.left, right: r.right, w: r.width };
  }),
);
console.log(`    buttons: ${JSON.stringify(btnBoxes)}`);
check(
  "no button is clipped by the card",
  btnBoxes.every(
    (b) => b.left >= cardBox.x - 0.5 && b.right <= cardBox.x + cardBox.width + 0.5,
  ),
);
check("the card fits the window the driver asks for", cardBox.width <= 308, `${cardBox.width}px`);
check(
  "no row wraps to a second line",
  (await rows.first().boundingBox()).height <= 32,
  `${(await rows.first().boundingBox()).height}px`,
);
await page.screenshot({ path: `${SHOTS}/2-hover-agenda.png` });

// Tab order: the rows' buttons come before the record/note pair.
await page.keyboard.press("Tab");
const focused = await page.evaluate(
  () => document.activeElement?.textContent ?? "",
);
check("Tab lands on the first decision", focused === "승인", focused);
await page.screenshot({ path: `${SHOTS}/3-hover-focus.png` });

// Decide the first row: it says so, then leaves.
await rows.first().locator("button").first().click();
await page.waitForTimeout(200);
check(
  "the decided row reports its outcome",
  (await page.locator('.notch-agenda [role="status"]').count()) === 1,
  await page
    .locator('.notch-agenda [role="status"]')
    .textContent()
    .catch(() => ""),
);
await page.screenshot({ path: `${SHOTS}/4-decided-beat.png` });
await page.waitForTimeout(1600);
check("the decided row then leaves", (await rows.count()) === 2);
const leftLabels = await rows.locator(".notch-grow").allTextContents();
console.log(`    rows left: ${JSON.stringify(leftLabels)}`);
check(
  "exactly that row left",
  !leftLabels.includes(labels[0]) && leftLabels.length === 2,
);
await page.screenshot({ path: `${SHOTS}/5-row-left.png` });

// --- with no agenda at all (no backend → no push) --------------------------
const bare = await browser.newPage({ viewport: { width: 420, height: 260 } });
await bare.goto(`${BASE}/?window=notch`, { waitUntil: "networkidle" });
await bare.waitForTimeout(900);
check(
  "an empty agenda draws no mark",
  (await bare.locator(".notch-mark").count()) === 0,
);
const inner = await bare.locator(".notch").innerHTML();
check(
  "collapsed with nothing waiting draws nothing visible",
  inner.replace(/<div class="notch-live"[^>]*><\/div>/, "").trim() === "",
  JSON.stringify(inner),
);
await bare.screenshot({ path: `${SHOTS}/6-empty-collapsed.png` });

await browser.close();
console.log(failures === 0 ? "\nALL OK" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
