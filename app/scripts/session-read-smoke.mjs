// Synthetic read-only session inventory regression; never opens a native vault.
// Usage: MYCO_TEST_URL=http://127.0.0.1:5173 node scripts/session-read-smoke.mjs
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright";

const base = new URL(process.env.MYCO_TEST_URL ?? "http://127.0.0.1:5173");
const loopback = ["127.0.0.1", "localhost", "[::1]"];
assert.ok(loopback.includes(base.hostname), "Use a loopback development server");
const output = process.env.MYCO_SCREENSHOTS;
if (output) await mkdir(output, { recursive: true });
const browser = await chromium.launch();
try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.route("**/*", route => {
    const url = new URL(route.request().url());
    return loopback.includes(url.hostname) || !["http:", "https:"].includes(url.protocol)
      ? route.continue() : route.abort("blockedbyclient");
  });
  await page.addInitScript(() => {
    performance.setResourceTimingBufferSize(5000);
    localStorage.setItem("myco.onboarded", "1");
    localStorage.setItem("myco-ui", JSON.stringify({ version: 3, state: { lang: "ko", theme: "light" } }));
  });
  const readUrl = new URL(base);
  readUrl.search = "?mock=1&local=1&nowriter=1";
  await page.goto(readUrl.toString());
  await page.locator(".home-page").waitFor();
  await page.evaluate(async () => {
    if (!window.__mycoMock || !window.__TAURI_INTERNALS__) throw new Error("Synthetic IPC mock is required");
    const original = window.__TAURI_INTERNALS__.invoke;
    const queue = await original("harvest_candidates", { limit: 50, vaultPath: "/myco" });
    window.__harvestReadFixture = { queue: { ...queue, read_status: "complete", read_issues: [] }, requests: [], writes: [] };
    window.__TAURI_INTERNALS__.invoke = (cmd, args) => {
      if (cmd === "harvest_candidates") return new Promise((resolve, reject) => window.__harvestReadFixture.requests.push({ resolve, reject }));
      if (["harvest_run", "write_file", "write_file_if_unchanged", "archive_inbox_source"].includes(cmd)) window.__harvestReadFixture.writes.push(cmd);
      return original(cmd, args);
    };
  });
  assert.ok(await page.evaluate(() => window.__harvestReadFixture.queue.items.length > 0), "Use checked candidates for read recovery");
  await page.locator(".side-nav .nav-item").filter({ has: page.locator(".ni-text", { hasText: /^자료 추가$/ }) }).click();
  for (const disclosure of [page.getByTestId("intake-more-sources"), page.getByTestId("intake-advanced")]) {
    if ((await disclosure.getAttribute("open")) === null) await disclosure.locator("summary").first().click();
  }
  await page.waitForFunction(() => window.__harvestReadFixture.requests.length > 0);
  await page.evaluate(() => window.__harvestReadFixture.requests.at(-1).reject(new Error("Synthetic session archive read failure")));
  const backfill = page.getByTestId("backfill-panel");
  await backfill.getByRole("alert").filter({ hasText: "Synthetic session archive read failure" }).waitFor({ timeout: 5000 });
  assert.equal(await backfill.locator(".sv-bf-stats").count(), 0, "A failed scan cannot publish empty or completed inventory");
  const retry = backfill.getByRole("button", { name: "다시 시도", exact: true });
  const failedRequests = await page.evaluate(() => window.__harvestReadFixture.requests.length);
  await retry.click();
  await page.waitForFunction(before => window.__harvestReadFixture.requests.length > before, failedRequests);
  assert.equal(await retry.isDisabled(), true);
  await page.evaluate(() => window.__harvestReadFixture.requests.at(-1).resolve(window.__harvestReadFixture.queue));
  await backfill.locator(".sv-bf-stats").waitFor();
  assert.equal(await backfill.getByRole("alert").count(), 0, "A successful retry clears the old scan error");

  await retry.click();
  await page.evaluate(() => {
    const fixture = window.__harvestReadFixture;
    fixture.legacy = { ...fixture.queue };
    delete fixture.legacy.read_status;
    delete fixture.legacy.read_issues;
    fixture.requests.at(-1).resolve(fixture.legacy);
  });
  await backfill.getByRole("alert").filter({ hasText: "세션 아카이브를 읽지 못했습니다" }).waitFor();
  assert.equal(await backfill.locator(".sv-bf-stats").count(), 0);
  assert.equal(await backfill.getByRole("button", { name: /^다음 \d+개 올리기$/ }).count(), 0, "Missing read status cannot authorize candidates");

  await retry.click();
  await page.evaluate(() => {
    const fixture = window.__harvestReadFixture;
    fixture.failed = { ...fixture.queue, read_status: "read_failed", items: [], eligible: 0, total_scanned: 0, distinct_bodies: 0,
      excluded: { duplicate: 0, boilerplate: 0, too_small: 0, too_large: 0, already_harvested: 0 },
      read_issues: [{ path: ".myco/backfill.json", code: "state_decode", message: "Synthetic unreadable harvest state" }] };
    fixture.requests.at(-1).resolve(fixture.failed);
  });
  await backfill.getByRole("alert").filter({ hasText: "Synthetic unreadable harvest state" }).waitFor();
  if (output) await backfill.screenshot({ path: `${output}/backfill-read-failed.png` });
  assert.equal(await backfill.locator(".sv-bf-stats").count(), 0);
  assert.equal(await backfill.getByRole("button", { name: /^다음 \d+개 올리기$/ }).count(), 0, "read_failed has no actionable candidates");
  await retry.click();
  await page.evaluate(() => {
    const fixture = window.__harvestReadFixture;
    fixture.partial = { ...fixture.queue, read_status: "partial", items: fixture.queue.items.slice(0, 1), eligible: 1,
      read_issues: [{ path: `sessions/${"synthetic".repeat(32)}.md`, code: "body_read", message: "Synthetic unreadable session" }] };
    fixture.requests.at(-1).resolve(fixture.partial);
  });
  await backfill.getByRole("alert").filter({ hasText: "Synthetic unreadable session" }).waitFor();
  assert.equal(await backfill.locator(".sv-bf-stat.is-hero .sv-big").innerText(), "최소 1");
  assert.ok((await backfill.locator(".sv-bf-stat .sv-big").allTextContents()).every(value => value.startsWith("최소 ")));
  assert.equal(await backfill.getByRole("button", { name: "다음 1개 올리기", exact: true }).isEnabled(), true);
  assert.doesNotMatch(await backfill.innerText(), /한 번도 수확된 적이 없습니다/);

  for (const width of [375, 768, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    await retry.scrollIntoViewIfNeeded();
    const hit = await retry.boundingBox();
    assert.ok(hit && hit.width >= 44 && hit.height >= 44, `${width}: backfill retry has a 44px target`);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, `${width}: partial backfill does not overflow`);
    if (output) await backfill.screenshot({ path: `${output}/backfill-partial-${width}.png` });
    await retry.focus();
    assert.equal(await retry.evaluate(element => document.activeElement === element), true);
    const before = await page.evaluate(() => window.__harvestReadFixture.requests.length);
    await retry.click();
    await page.waitForFunction(previous => window.__harvestReadFixture.requests.length > previous, before);
    await page.evaluate(() => window.__harvestReadFixture.requests.at(-1).resolve(window.__harvestReadFixture.partial));
    await backfill.getByRole("alert").filter({ hasText: "Synthetic unreadable session" }).waitFor();
  }

  await retry.click();
  await page.evaluate(async () => {
    const resource = performance.getEntriesByType("resource")
      .filter(entry => new URL(entry.name).pathname === "/src/stores/vaultStore.ts").at(-1);
    if (!resource) throw new Error("Mounted vault store module not found");
    const { useVaultStore } = await import(resource.name);
    window.__harvestReadFixture.oldRequest = window.__harvestReadFixture.requests.at(-1);
    window.__harvestReadFixture.finishOpening = () => useVaultStore.setState({ isOpeningVault: false });
    useVaultStore.setState({ vaultToken: "synthetic-read-reopened", isOpeningVault: true });
  });
  assert.equal(await backfill.count(), 0, "The old panel is hidden while the next opening is pending");
  await page.evaluate(() => window.__harvestReadFixture.oldRequest.reject(new Error("Synthetic old opening read failure")));
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await page.evaluate(() => window.__harvestReadFixture.finishOpening());
  await page.waitForFunction(() => window.__harvestReadFixture.requests.at(-1) !== window.__harvestReadFixture.oldRequest);
  assert.equal(await backfill.getByRole("alert").filter({ hasText: "Synthetic old opening read failure" }).count(), 0);
  await page.evaluate(() => window.__harvestReadFixture.requests.at(-1).resolve(window.__harvestReadFixture.queue));
  await backfill.locator(".sv-bf-stats").waitFor();
  assert.equal(await backfill.getByRole("alert").count(), 0);

  const beforeOverview = await page.evaluate(() => window.__harvestReadFixture.requests.length);
  await page.locator(".side-nav .nav-item").filter({ has: page.locator(".ni-text", { hasText: /^홈$/ }) }).click();
  await page.locator(".home-management-toggle").click();
  const card = page.getByTestId("harvest-queue");
  await page.waitForFunction(before => window.__harvestReadFixture.requests.length > before, beforeOverview);
  await page.evaluate(() => window.__harvestReadFixture.requests.at(-1).resolve(window.__harvestReadFixture.failed));
  await card.getByRole("alert").filter({ hasText: "Synthetic unreadable harvest state" }).waitFor();
  assert.equal(await card.locator(".hq-empty, .hq-queue").count(), 0);
  assert.equal(await card.getByRole("button", { name: /^\d+개 수확$/ }).count(), 0);
  const queueRetry = card.getByRole("button", { name: "다시 시도", exact: true });
  await queueRetry.click();
  await page.evaluate(() => window.__harvestReadFixture.requests.at(-1).resolve(window.__harvestReadFixture.legacy));
  await card.getByRole("alert").filter({ hasText: "세션 아카이브를 읽지 못했습니다" }).waitFor();
  assert.equal(await card.locator(".hq-empty, .hq-queue").count(), 0);
  assert.equal(await card.getByRole("button", { name: /^\d+개 수확$/ }).count(), 0, "Missing read status has no actionable queue");
  await queueRetry.click();
  await page.evaluate(() => {
    const fixture = window.__harvestReadFixture;
    fixture.requests.at(-1).resolve({ ...fixture.failed, read_status: "partial" });
  });
  await card.getByText("세션 최소 0개가 위키에 들어갈 만합니다", { exact: true }).waitFor();
  assert.equal(await card.locator(".hq-empty").count(), 0, "Partial empty cannot establish a completed queue");
  await queueRetry.click();
  await page.evaluate(() => window.__harvestReadFixture.requests.at(-1).resolve(window.__harvestReadFixture.partial));
  await card.getByText("세션 최소 1개가 위키에 들어갈 만합니다", { exact: true }).waitFor();
  assert.equal(await card.locator('.hq-queue input[type="checkbox"]').count(), 1);
  await card.locator('.hq-queue input[type="checkbox"]:checked').waitFor();
  assert.equal(await card.getByRole("button", { name: "1개 수확", exact: true }).isEnabled(), true);
  assert.doesNotMatch(await card.innerText(), /한 번도 수확된 적이 없습니다|지금까지 \d+개 수확/);
  for (const width of [375, 768, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    await queueRetry.scrollIntoViewIfNeeded();
    assert.equal(await queueRetry.isEnabled(), true);
    const hit = await queueRetry.boundingBox();
    assert.ok(hit && hit.width >= 44 && hit.height >= 44, `${width}: queue retry has a 44px target`);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, `${width}: partial queue does not overflow`);
    if (output) await card.screenshot({ path: `${output}/queue-partial-${width}.png` });
    await queueRetry.focus();
    assert.equal(await queueRetry.evaluate(element => document.activeElement === element), true);
    const before = await page.evaluate(() => window.__harvestReadFixture.requests.length);
    await queueRetry.click();
    await page.waitForFunction(previous => window.__harvestReadFixture.requests.length > previous, before);
    await page.evaluate(() => window.__harvestReadFixture.requests.at(-1).resolve(window.__harvestReadFixture.partial));
    await card.getByText("세션 최소 1개가 위키에 들어갈 만합니다", { exact: true }).waitFor();
  }
  await queueRetry.click();
  await page.evaluate(() => {
    const fixture = window.__harvestReadFixture;
    fixture.requests.at(-1).resolve({ ...fixture.failed, read_status: "complete", read_issues: [] });
  });
  await card.locator(".hq-empty").waitFor();
  assert.equal(await card.getByRole("alert").count(), 0);
  await page.evaluate(async () => {
    const resource = performance.getEntriesByType("resource")
      .filter(entry => new URL(entry.name).pathname === "/src/stores/vaultStore.ts").at(-1);
    if (!resource) throw new Error("Mounted vault store module not found");
    const { useVaultStore } = await import(resource.name);
    useVaultStore.setState({ vaultToken: "synthetic-queue-reopened", isOpeningVault: true });
  });
  await card.waitFor({ state: "detached", timeout: 5000 });
  const beforeReopen = await page.evaluate(() => window.__harvestReadFixture.requests.length);
  await page.evaluate(() => window.__harvestReadFixture.finishOpening());
  await page.waitForFunction(before => window.__harvestReadFixture.requests.length > before, beforeReopen, { timeout: 5000 });
  await page.evaluate(() => window.__harvestReadFixture.requests.at(-1).resolve(window.__harvestReadFixture.failed));
  await card.getByRole("alert").filter({ hasText: "Synthetic unreadable harvest state" }).waitFor();
  assert.deepEqual(await page.evaluate(() => window.__harvestReadFixture.writes), []);
  assert.deepEqual(errors, []);
  console.log("PASS session-read: IPC failure, real retry, typed failure, partial lower bounds and opening-bound recovery (mock IPC)");
  await context.close();
} finally {
  await browser.close();
}
