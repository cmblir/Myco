// Ask-intent-routing E2E (anti-hallucination). "What did I do recently?" must
// be answered from git history (factual bullet list), NOT sent to the model
// where a small local model confabulates. A normal topic question must still go
// through the model path.
//
// Usage (dev server on :5173):  node scripts/query-smoke.mjs [--headed]
import { chromium } from "playwright";

const headed = process.argv.includes("--headed");
const BASE = "http://localhost:5173/?mock=1";

const browser = await chromium.launch({ headless: !headed });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
page.on("console", (m) => { if (m.type() === "error") errors.push(`console: ${m.text()}`); });
const results = [];
const check = (n, ok, d = "") => results.push({ n, ok, d });

await page.addInitScript(() => {
  localStorage.setItem("memex.onboarded", "1");
  localStorage.setItem("memex-ui", JSON.stringify({ state: { lang: "ko", theme: "light" }, version: 3 }));
});
await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 60_000 });
await page.waitForSelector(".side-nav .nav-item", { timeout: 30_000 });
await page.locator(".side-quick .qbtn", { hasText: "위키에 질문" }).first().click();
await page.waitForSelector(".input", { timeout: 20_000 });

// --- Activity question → git-log answer (no model) ---
await page.locator("input.input").first().fill("최근에 내가 한 일이 뭐야?");
await page.keyboard.press("Enter");
await page.waitForFunction(
  () => /git 기록/.test(document.querySelector(".workspace")?.innerText || ""),
  { timeout: 15_000 },
).catch(() => {});
const answer = await page.locator(".workspace").innerText();
check("activity → git-log answer", /git 기록/.test(answer), answer.slice(0, 60));
check(
  "answer shows real commit (from mock git_log)",
  /transformer architecture|2024-03-01/.test(answer),
  "no commit content",
);
// The mock git_log subjects are the ground truth; the fabricated file names from
// the old bug ("v24.md", "이뮤노테크") must NOT appear.
check("no hallucinated content", !/이뮤노테크|v24\.md|3PL/.test(answer));

// --- Normal topic question still uses the model path (no git list) ---
await page.locator("input.input").first().fill("어텐션이 뭐야?");
await page.keyboard.press("Enter");
await page.waitForTimeout(1500);
const all = await page.locator(".workspace").innerText();
// The second answer block should NOT be the git-history list.
const blocks = all.split("git 기록").length - 1;
check("topic question not routed to git-log", blocks <= 1, `git-log blocks=${blocks}`);

check("no page errors", errors.length === 0, errors.slice(0, 3).join(" | "));

await browser.close();
let failed = 0;
for (const r of results) { console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.n}${r.d ? "  — " + r.d : ""}`); if (!r.ok) failed++; }
console.log(`\n${results.length - failed}/${results.length} checks clean`);
process.exit(failed ? 1 : 0);
