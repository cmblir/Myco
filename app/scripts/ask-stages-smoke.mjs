// Ask staged-status E2E.
//
// The wait used to be theatre: a random shuffle of vault stems pulsing under a
// static "searching the wiki…", while the code that actually picked the pages
// said nothing. Streaming was measured and killed (prefill dominates — tokens
// would appear ~100 ms sooner and no more), so honest staging is what is left,
// and it is only worth anything if the stages are true.
//
// Usage (dev server on :5173):  node scripts/ask-stages-smoke.mjs [--headed]
import { chromium } from "playwright";

const headed = process.argv.includes("--headed");
const BASE = "http://localhost:5173/?mock=1";

const browser = await chromium.launch({ headless: !headed });
const results = [];
const check = (n, ok, d = "") => results.push({ n, ok, d });

/** Ask a question on the non-tool provider path and collect the status labels. */
async function askAndWatch({ indexed }) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(`console: ${m.text()}`);
  });
  await page.addInitScript(() => {
    localStorage.setItem("memex.onboarded", "1");
    localStorage.setItem(
      "memex-ui",
      JSON.stringify({ state: { lang: "en", theme: "light" }, version: 3 }),
    );
  });
  await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForSelector(".side-nav .nav-item", { timeout: 30_000 });

  // Force the builtin model. Settings' picker only lists ENABLED providers, so
  // a mock configured for the CLI cannot be switched to the builtin through the
  // UI — and the staged path is the non-tool one, so it would be unreachable.
  await page.evaluate(
    (n) => {
      window.__memexMock.settings({ query_provider: "builtin-local", query_model: "gemma-3-1b" });
      window.__memexMock.indexedPages(n);
    },
    indexed,
  );

  await page.locator(".side-quick .qbtn", { hasText: "Ask the wiki" }).first().click();
  await page.waitForSelector("input.input", { timeout: 20_000 });

  // The label is an aria-label on the status element — ThinkingGalaxy paints the
  // rest to a canvas, so there is no text node to read.
  const labels = [];
  const poll = setInterval(async () => {
    try {
      if (await page.locator(".thinking-galaxy").count()) {
        const l = await page.locator(".thinking-galaxy").first().getAttribute("aria-label");
        if (l && !labels.includes(l)) labels.push(l);
      }
    } catch {
      /* mid-navigation */
    }
  }, 50);
  await page.locator("input.input").first().fill("what is attention?");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(3_500);
  clearInterval(poll);

  const answer = await page.locator(".workspace").innerText();
  await page.close();
  return { labels, answer, errors };
}

// --- with an index: the app names the pages it actually retrieved ----------
{
  const { labels, answer, errors } = await askAndWatch({ indexed: 51 });
  check(
    "the wait says it is searching while it searches",
    labels[0] === "searching the wiki…",
    JSON.stringify(labels),
  );
  check(
    "it names the pages it is answering FROM during the long wait",
    /answering from \d+ pages/.test(labels[labels.length - 1] ?? ""),
    JSON.stringify(labels),
  );
  check("an answer arrives", /local model reply/.test(answer));
  check("no page errors", errors.length === 0, errors.slice(0, 2).join(" | "));
}

// --- with no index: it must not claim to be reading anything ---------------
{
  const { labels, errors } = await askAndWatch({ indexed: 0 });
  check(
    "with no index it never claims to have read any page",
    !labels.some((l) => /answering from/.test(l)),
    JSON.stringify(labels),
  );
  check(
    "with no index it does not pretend to search either",
    !labels.includes("searching the wiki…"),
    JSON.stringify(labels),
  );
  check("no page errors (unindexed)", errors.length === 0, errors.slice(0, 2).join(" | "));
}

await browser.close();
let failed = 0;
for (const r of results) {
  console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.n}${r.d ? "  — " + r.d : ""}`);
  if (!r.ok) failed++;
}
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
