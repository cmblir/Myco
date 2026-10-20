// Headless check of the invisible collapsed hotspot, hovered agenda rows,
// acknowledged outcomes and authoritative removal with either mascot setting.
// The broker below is synthetic: this notch-only route has no main writer.
// No native app or vault is opened or written. Run against a loopback dev server.
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
let checks = 0;
function check(name, ok, detail = "") {
  checks++;
  console.log(`${ok ? "  ok" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 420, height: 260 } });
await page.addInitScript(() => {
  window.__importAppModule = (path) => {
    const entry = performance.getEntriesByType("resource").filter((resource) => new URL(resource.name).pathname === path).at(-1);
    if (!entry) throw new Error(`App module was not loaded: ${path}`);
    return import(entry.name);
  };
  localStorage.setItem("myco-ui", JSON.stringify({ state: { lang: "ko", mascotEnabled: true }, version: 3 }));
});
page.on("console", (m) => {
  if (m.type() === "error") console.log(`    [console] ${m.text()}`);
});

// --- with an agenda (the ?mock=1 get_tray_status fixture) -------------------
await page.goto(`${BASE}/?mock=1&window=notch`, { waitUntil: "networkidle" });
await page.waitForTimeout(900);

check("waiting decisions draw no collapsed count", await page.locator(".notch-mark, .notch-mark-n").count() === 0);
check("collapsed draws no mascot, wing or cap", await page.locator(".notch-mascot, .notch-winged, .notch-cap, [data-placement='wing']").count() === 0);
// The invisible input surface still extends 14px beneath devMock's 204x37
// cutout. Removing decoration must not remove the hover/capture target.
const hotspot = await page.locator(".notch").evaluate((element) => {
  const box = element.getBoundingClientRect();
  const css = getComputedStyle(element);
  const hit = document.elementFromPoint(box.x + box.width / 2, box.bottom - 5);
  return { ...box.toJSON(), background: css.backgroundColor, image: css.backgroundImage,
    shadow: css.boxShadow, interactive: css.pointerEvents !== "none" && hit !== null && element.contains(hit) };
});
console.log(`    collapsed hotspot: ${JSON.stringify(hotspot)}`);
check("collapsed keeps a transparent interactive hotspot", hotspot.background === "rgba(0, 0, 0, 0)" && hotspot.image === "none" && hotspot.shadow === "none" && hotspot.interactive);
check("collapsed matches the cutout width and 14px hover extension", hotspot.top === 0 && hotspot.width === 204 && hotspot.height === 51, `${hotspot.width}x${hotspot.height}`);
check(
  "collapsed draws no card",
  (await page.locator(".notch-body").count()) === 0,
);
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
// the OS window the driver asked for (cutout 204 + 80 + 24, plus the mascot's
// 62px column = 370 in the mock; notchOpenWidth in lib/notchDriver).
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
check("the card fits the window the driver asks for", cardBox.width <= 370, `${cardBox.width}px`);
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

// The production driver sends an envelope to a different webview. In this
// notch-only mock there is no main writer, so defer its replies explicitly.
// Updates travel through the real event listeners; never delete rendered DOM.
const copy = await page.evaluate(async () => {
  const { STRINGS } = await window.__importAppModule("/src/lib/i18n.ts");
  const invoke = window.__TAURI_INTERNALS__.invoke;
  const snapshot = await invoke("get_tray_status");
  snapshot.panel.actionScope = { vaultPath: "/synthetic-a", vaultToken: "agenda-open-a" };
  window.__notchBroker = { snapshot, requests: [], completed: [] };
  window.__TAURI_INTERNALS__.invoke = async (command, args) => {
    if (command === "plugin:event|emit" && args.event === "myco://tray-action") {
      const request = args.payload;
      const row = snapshot.panel.agenda.rows.find((row) => row.primaryAction === request.action || row.secondaryAction === request.action);
      window.__notchBroker.requests.push({ ...request, rowId: row?.id });
    }
    return invoke(command, args);
  };
  window.__mycoMock.emit("myco://tray-status", snapshot);
  return { pending: STRINGS.ko.st_loading, done: STRINGS.ko.notch_done, failed: STRINGS.ko.notch_failed };
});
const outcome = page.locator('.notch-agenda [role="status"]');
async function reply(requestId, ok) {
  await page.evaluate(({ requestId, ok }) => {
    window.__mycoMock.emit("myco://tray-action-result", { requestId, ok });
  }, { requestId, ok });
}

await rows.first().locator("button").first().click();
await page.waitForFunction(() => window.__notchBroker.requests.length === 1);
const firstRequest = await page.evaluate(() => window.__notchBroker.requests[0]);
const selected = await page.evaluate(() => window.__notchBroker.snapshot.panel.agenda.rows[0]);
check("the request names exactly the selected proposal", firstRequest.action === selected.primaryAction && firstRequest.rowId === selected.id);
check("the request has a correlation identity", typeof firstRequest.requestId === "string" && firstRequest.requestId.length > 0);
check("the request retains the displayed vault-open identity", firstRequest.scope?.vaultPath === "/synthetic-a" && firstRequest.scope?.vaultToken === "agenda-open-a");
check(
  "delivery reports loading, never successful execution",
  await outcome.textContent() === copy.pending && copy.pending !== copy.done,
  await outcome.textContent(),
);
check("a pending row cannot submit duplicate actions", await rows.first().locator("button").count() === 0);
await page.waitForTimeout(1600);
check("an unacknowledged row stays pending after the outcome beat", await outcome.textContent() === copy.pending && await rows.count() === 3);
await reply("synthetic-unrelated-request", true);
await page.waitForTimeout(50);
check("an unrelated acknowledgement cannot complete the row", await outcome.textContent() === copy.pending);
await reply(firstRequest.requestId, false);
await page.waitForFunction((failed) => document.querySelector('.notch-agenda [role="status"]')?.textContent === failed, copy.failed);
check("a failed writer reports failure and preserves every source row", await outcome.textContent() === copy.failed && JSON.stringify(await rows.locator(".notch-grow").allTextContents()) === JSON.stringify(labels));
await page.screenshot({ path: `${SHOTS}/4-failed-beat.png` });
await rows.first().locator("button").first().waitFor();
check("a failed acknowledgement restores the selected row for retry", await rows.first().locator("button").count() === 2);
await rows.first().locator("button").first().click();
await page.waitForFunction(() => window.__notchBroker.requests.length === 2);
const retry = await page.evaluate(() => window.__notchBroker.requests[1]);
check("retry keeps the selected source with a new request identity", retry.rowId === selected.id && retry.action === selected.primaryAction && retry.requestId !== firstRequest.requestId);
await reply(firstRequest.requestId, true);
await page.waitForTimeout(50);
check("a late acknowledgement of the previous attempt cannot complete the retry", await outcome.textContent() === copy.pending);
await reply(retry.requestId, true);
await page.waitForFunction((done) => document.querySelector('.notch-agenda [role="status"]')?.textContent === done, copy.done);
check("only the matching writer result reports success", await outcome.textContent() === copy.done);
await page.screenshot({ path: `${SHOTS}/5-decided-beat.png` });
await page.waitForTimeout(1600);
check("success alone never hides an unchanged authoritative agenda", await rows.count() === 3);
await page.evaluate((selectedId) => {
  const broker = window.__notchBroker;
  broker.completed.push(selectedId);
  broker.snapshot = { ...broker.snapshot, panel: { ...broker.snapshot.panel, agenda: {
    total: broker.snapshot.panel.agenda.total - 1,
    rows: broker.snapshot.panel.agenda.rows.filter((row) => row.id !== selectedId),
  } } };
  window.__mycoMock.emit("myco://tray-status", broker.snapshot);
}, selected.id);
await page.waitForFunction(() => document.querySelectorAll(".notch-agenda").length === 2);
check("the decided row then leaves", (await rows.count()) === 2);
const leftLabels = await rows.locator(".notch-grow").allTextContents();
console.log(`    rows left: ${JSON.stringify(leftLabels)}`);
check(
  "exactly that row left",
  !leftLabels.includes(labels[0]) && leftLabels.length === 2,
);
check("the other original source rows remain in order", JSON.stringify(leftLabels) === JSON.stringify(labels.slice(1)));
await page.screenshot({ path: `${SHOTS}/6-row-left.png` });

// A late A acknowledgement must not settle B's row with the same relative id.
await page.evaluate((selected) => {
  const broker = window.__notchBroker;
  broker.snapshot = { ...broker.snapshot, panel: { ...broker.snapshot.panel, agenda: {
    total: broker.snapshot.panel.agenda.total + 1,
    rows: [selected, ...broker.snapshot.panel.agenda.rows],
  } } };
  window.__mycoMock.emit("myco://tray-status", broker.snapshot);
}, selected);
await page.waitForFunction((label) => document.querySelector(".notch-agenda .notch-grow")?.textContent === label, labels[0]);
await rows.first().locator("button").first().click();
await page.waitForFunction(() => window.__notchBroker.requests.length === 3);
const oldScopeRequest = await page.evaluate(() => window.__notchBroker.requests[2]);
await page.evaluate(() => {
  const broker = window.__notchBroker;
  broker.snapshot = { ...broker.snapshot, panel: { ...broker.snapshot.panel, actionScope: { vaultPath: "/synthetic-b", vaultToken: "agenda-open-b" } } };
  window.__mycoMock.emit("myco://tray-status", broker.snapshot);
});
await rows.first().locator("button").first().waitFor();
check("changing the vault clears A's pending presentation on B's same-id row", await outcome.count() === 0);
await rows.first().locator("button").first().click();
await page.waitForFunction(() => window.__notchBroker.requests.length === 4);
const currentScopeRequest = await page.evaluate(() => window.__notchBroker.requests[3]);
check("B's same-id row can submit its own scoped request", currentScopeRequest.scope?.vaultToken === "agenda-open-b" && currentScopeRequest.rowId === oldScopeRequest.rowId, JSON.stringify({ old: oldScopeRequest, current: currentScopeRequest }));
await reply(oldScopeRequest.requestId, true);
await page.waitForTimeout(1600);
check("A's late success and cleanup cannot complete or unlock B's pending request", await outcome.textContent() === copy.pending && await rows.first().locator("button").count() === 0);
await reply(currentScopeRequest.requestId, true);
await page.waitForFunction((done) => document.querySelector('.notch-agenda [role="status"]')?.textContent === done, copy.done);
check("B settles only from B's matching acknowledgement", await outcome.textContent() === copy.done);
await rows.first().locator("button").first().waitFor();
const beforeTransition = await page.evaluate(() => window.__notchBroker.requests.length);
await page.evaluate(() => {
  const staleButton = document.querySelector(".notch-agenda button");
  const broker = window.__notchBroker;
  broker.snapshot = { ...broker.snapshot, panel: { ...broker.snapshot.panel, actionScope: { vaultPath: "/synthetic-c", vaultToken: "agenda-open-c" } } };
  window.__mycoMock.emit("myco://tray-status", broker.snapshot);
  // The old render's handler runs in the same task, before React commits C.
  staleButton.click();
});
await page.waitForTimeout(100);
check("an old rendered row cannot adopt a newer listener scope before React commits", await page.evaluate(() => window.__notchBroker.requests.length) === beforeTransition);

// --- with no agenda at all (no backend → no push) --------------------------
const bare = await browser.newPage({ viewport: { width: 420, height: 260 } });
await bare.goto(`${BASE}/?window=notch`, { waitUntil: "networkidle" });
await bare.waitForTimeout(900);
check(
  "an empty agenda draws no collapsed decoration or card",
  (await bare.locator(".notch-mark, .notch-mark-n, .notch-mascot, .notch-winged, .notch-cap, .notch-body").count()) === 0,
);
check(
  "an empty agenda retains a nonzero transparent hotspot",
  await bare.locator(".notch").evaluate((element) => {
    const box = element.getBoundingClientRect();
    const css = getComputedStyle(element);
    return box.width > 0 && box.height > 0 && css.backgroundColor === "rgba(0, 0, 0, 0)" && css.backgroundImage === "none" && css.pointerEvents !== "none";
  }),
);
await bare.screenshot({ path: `${SHOTS}/7-empty-collapsed.png` });

// The collapsed surface stays invisible regardless of the global mascot setting.
const off = await browser.newPage({ viewport: { width: 420, height: 260 } });
await off.addInitScript(() => {
  localStorage.setItem(
    "myco-ui",
    JSON.stringify({ state: { mascotEnabled: false }, version: 3 }),
  );
});
await off.goto(`${BASE}/?window=notch`, { waitUntil: "networkidle" });
await off.waitForTimeout(900);
check(
  "mascot off: an empty agenda draws no collapsed decoration or card",
  await off.locator(".notch-mark, .notch-mark-n, .notch-mascot, .notch-winged, .notch-cap, .notch-body").count() === 0,
);
// Waiting decisions must not restore the old count/cap fallback.
await off.goto(`${BASE}/?mock=1&window=notch`, { waitUntil: "networkidle" });
await off.waitForTimeout(900);
check(
  "mascot off: waiting also draws no collapsed decoration or card",
  await off.locator(".notch-mark, .notch-mark-n, .notch-mascot, .notch-winged, .notch-cap, .notch-body").count() === 0,
);
const offHotspot = await off.locator(".notch").evaluate((element) => {
  const box = element.getBoundingClientRect();
  return { width: box.width, height: box.height, background: getComputedStyle(element).backgroundColor };
});
check("mascot off: waiting keeps the same transparent hover geometry", offHotspot.width === hotspot.width && offHotspot.height === hotspot.height && offHotspot.background === hotspot.background, JSON.stringify(offHotspot));

await browser.close();
console.log(`\n${checks - failures}/${checks} checks passed (synthetic broker/events; not native writes)`);
process.exit(failures === 0 ? 0 : 1);
