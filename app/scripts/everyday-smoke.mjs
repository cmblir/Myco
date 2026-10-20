// Frontend-only usability checks against the existing development IPC mock.
// Start Vite first: npm run dev -- --host 127.0.0.1
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright";

const base = process.env.MYCO_TEST_URL ?? "http://127.0.0.1:5173";
const output = process.env.MYCO_SCREENSHOTS ?? "/tmp/myco-ux";
await mkdir(output, { recursive: true });
const browser = await chromium.launch();
const errors = [];
let checks = 0;
function check(condition, message) {
  assert.ok(condition, message);
  checks++;
  console.log(`PASS ${message}`);
}
async function openHome(width, theme = "dark") {
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  page.on("pageerror", (error) => errors.push(error.stack ?? error.message));
  await page.addInitScript(
    ({ width, theme }) => {
      localStorage.setItem(
        "myco-ui",
        JSON.stringify({
          version: 3,
          state: {
            lang: "ko",
            theme,
            sidebarCollapsed: width < 900,
          },
        }),
      );
    },
    { width, theme },
  );
  await page.goto(`${base}/?mock=1`);
  await page.locator(".home-management-toggle").waitFor();
  return page;
}
try {
  for (const width of [320, 375, 768, 1280]) {
    const page = await openHome(width);
    check(
      await page
        .getByRole("button", { name: "자료 추가하기", exact: true })
        .isVisible(),
      `${width}: main action visible`,
    );
    check(
      (await page
        .locator(".home-management-toggle")
        .getAttribute("aria-expanded")) === "false",
      `${width}: tools start collapsed`,
    );
    check(
      await page
        .locator(".home-page")
        .evaluate((el) => el.scrollWidth <= el.clientWidth + 1),
      `${width}: no horizontal overflow`,
    );
    check(
      await page
        .locator(".everyday-hero .u-btn")
        .evaluate((el) => el.offsetHeight >= 44),
      `${width}: primary touch target >= 44px`,
    );
    await page.screenshot({
      path: `${output}/home-${width}.png`,
      fullPage: true,
    });
    await page.close();
  }
  const page = await openHome(1280, "light");
  await page.screenshot({ path: `${output}/home-light.png`, fullPage: true });
  check(
    (await page.locator(".status-details").getAttribute("open")) === null,
    "technical sidebar tiles start collapsed",
  );
  await page.locator(".status-details summary").click();
  await page.locator(".side-status .st-head button").click();
  await page.locator(".status-details summary").click();
  check(await page.locator(".side-status .st-sum-alert").isVisible(), "warning mark stays visible while tiles are collapsed");
  check(!(await page.locator(".side-status .st-note").isVisible()), "warning details remain folded with technical tiles");
  await page.locator(".status-details summary").click();
  check(await page.locator(".side-status .st-note").isVisible(), "opening status reveals the warning and recovery action");
  await page.locator(".status-details summary").click();
  await page
    .getByRole("button", { name: "자료 추가하기", exact: true })
    .click();
  await page.getByRole("heading", { name: "자료 추가", exact: true }).waitFor();
  check(true, "home add action opens source form");
  await page.locator(".brand").click();
  await page.locator(".home-ask__input").fill("합성 노트의 주요 내용은?");
  await page.locator(".home-ask__actions").getByRole("button", { name: "질문하기", exact: true }).click();
  await page.locator(".ask-composer").waitFor();
  check(
    await page
      .getByRole("heading", { name: "내 노트에 질문하기", exact: true })
      .isVisible(),
    "home question action opens Ask",
  );
  await page.locator(".brand").click();
  await page
    .getByRole("button", { name: "새 노트 쓰기", exact: false })
    .click();
  await page.getByRole("dialog").waitFor();
  check(
    await page.getByRole("dialog").getByRole("textbox").isVisible(),
    "home write action opens note creation",
  );
  await page.getByRole("dialog").getByRole("textbox").press("Escape");
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  await page.locator(".home-management-toggle").press("Enter");
  await page.locator(".home-management-tools").waitFor();
  check(
    (await page
      .locator(".home-management-toggle")
      .getAttribute("aria-expanded")) === "true",
    "keyboard opens workspace tools",
  );
  const reviewQueue = await page.getByTestId("harvest-queue").elementHandle();
  await page.locator(".home-management-toggle").click();
  check(
    !(await reviewQueue.evaluate((el) => el.isConnected)),
    "folding releases mounted review widgets",
  );
  // Exercise the same section jump that activity and tray send.
  await page.evaluate(async () => {
    const { useUIStore } = await import("/src/stores/uiStore.ts");
    useUIStore.getState().focusSection("reflect");
  });
  await page.waitForFunction(() =>
    document.activeElement?.matches(
      ".home-management-content section[tabindex='-1']",
    ),
  );
  check(
    (await page
      .locator(".home-management-toggle")
      .getAttribute("aria-expanded")) === "true",
    "activity link reveals collapsed destination",
  );
  check(
    await page.evaluate(() =>
      Boolean(document.activeElement?.closest(".home-management-content")),
    ),
    "activity link moves focus to its section",
  );
  await page
    .locator(".side-head")
    .getByRole("button", { name: "설정", exact: true })
    .click();
  await page.locator(".settings-navigation").waitFor();
  check(
    (await page.locator(".settings-navigation__choice:visible").count()) === 5,
    "settings opens on five everyday choices",
  );
  await page.locator(".settings-navigation .s-box input").fill("ollama");
  await page.locator("#settings-choice-providers").waitFor();
  check(
    (await page
      .locator(".settings-navigation__advanced")
      .getAttribute("open")) !== null,
    "settings search includes advanced connections",
  );
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.locator(".brand").click();
  check(
    await page
      .locator(".myco-motion__figure")
      .evaluate((el) => getComputedStyle(el).animationName === "none"),
    "reduced motion stops mascot",
  );
  await page.evaluate(async () => {
    const { useUIStore } = await import("/src/stores/uiStore.ts");
    useUIStore.getState().setMascotEnabled(false);
  });
  await page.locator(".myco-motion--static").waitFor();
  check(true, "mascot opt-out preserves a static mark");
  // Fail only the mock's recent-note lookup, then exercise recovery in both views.
  await page.evaluate(async () => {
    const original = window.__TAURI_INTERNALS__.invoke;
    window.__restoreMycoMtimes = () => {
      window.__TAURI_INTERNALS__.invoke = original;
    };
    window.__TAURI_INTERNALS__.invoke = (command, args) =>
      command === "file_mtimes"
        ? Promise.reject(new Error("Synthetic recent notes failure"))
        : original(command, args);
    const { useUIStore } = await import("/src/stores/uiStore.ts");
    useUIStore.getState().setRoute("query");
  });
  await page.locator(".ask-composer").waitFor();
  await page.locator(".brand").click();
  await page.locator(".home-recent-status[role=alert]").waitFor();
  check(true, "recent notes failure has recovery in simple view");
  await page.locator(".home-management-toggle").click();
  await page
    .locator(".home-management-content .home-recent-status[role=alert]")
    .waitFor();
  check(true, "recent notes failure stays explicit in workspace tools");
  await page.evaluate(() => window.__restoreMycoMtimes());
  await page
    .locator(".home-management-content .home-recent-status")
    .getByRole("button")
    .click();
  await page.locator(".home-management-content .recent-row").first().waitFor();
  check(true, "recent notes retry restores the list");
  check(errors.length === 0, `no page errors (${errors.join("\n")})`);
  console.log(`\n${checks} usability checks passed. Screenshots: ${output}`);
} finally {
  await browser.close();
}
