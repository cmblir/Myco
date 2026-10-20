// Tasks UI plus synthetic markdown round trips; no native/private vault actions.
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright";
const base = process.env.MYCO_TEST_URL ?? "http://127.0.0.1:5173";
assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(new URL(base).hostname));
const output = process.env.MYCO_SCREENSHOTS ?? "/tmp/myco-task-workflows";
await mkdir(output, { recursive: true });
const browser = await chromium.launch({
  headless: !process.argv.includes("--headed"),
});
let checks = 0;
try {
  for (const width of [375, 768, 769, 900, 1280]) {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    page.setDefaultTimeout(15000);
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.route("**/*", (r) => {
      const u = new URL(r.request().url());
      return ["127.0.0.1", "localhost", "[::1]"].includes(u.hostname) ||
        !["http:", "https:"].includes(u.protocol)
        ? r.continue()
        : r.abort("blockedbyclient");
    });
    await page.addInitScript(() => {
      localStorage.setItem("myco.onboarded", "1");
      localStorage.setItem(
        "myco-ui",
        JSON.stringify({
          version: 3,
          state: { lang: "en", theme: "light", editorMode: "source" },
        }),
      );
      const d = new Date();
      window.taskDay = [
        d.getFullYear(),
        String(d.getMonth() + 1).padStart(2, "0"),
        String(d.getDate()).padStart(2, "0"),
      ].join("-");
      window.taskPath = "/myco/daily/" + window.taskDay + ".md";
      window.failTaskRead = false;
      window.taskWrites = 0;
      let internals;
      Object.defineProperty(window, "__TAURI_INTERNALS__", {
        configurable: true,
        get: () => internals,
        set: (value) => {
          const invoke = value.invoke;
          value.invoke = (command, args) => {
            if (command === "write_file" && args.path === window.taskPath)
              window.taskWrites++;
            if (
              command === "read_file" &&
              args.path === window.taskPath &&
              window.failTaskRead
            )
              return Promise.reject(
                new Error("Synthetic existing note read failure"),
              );
            if (
              command === "create_file" &&
              args.parent + "/" + args.name === window.taskPath
            )
              return Promise.reject(
                new Error("already exists: synthetic daily note"),
              );
            return invoke(command, args);
          };
          internals = value;
        },
      });
    });
    const read = () =>
      page.evaluate(
        async () =>
          (
            await window.__TAURI_INTERNALS__.invoke("read_file", {
              path: window.taskPath,
            })
          ).raw,
      );
    async function navigate(label) {
      if (await page.locator(".app.sidebar-collapsed").count())
        await page.getByTitle(/^Toggle sidebar/).click();
      await page
        .locator(".side-nav .nav-item")
        .filter({
          has: page.locator(".ni-text", {
            hasText: new RegExp("^" + label + "$"),
          }),
        })
        .click();
    }
    try {
      await page.goto(base + "/?mock=1", { waitUntil: "domcontentloaded" });
      await page.locator(".home-page").waitFor();
      const original = await page.evaluate(async () => {
        const raw =
          "# " +
          window.taskDay +
          "\n\nSynthetic existing journal must survive.\n";
        await window.__TAURI_INTERNALS__.invoke("write_file", {
          path: window.taskPath,
          content: raw,
        });
        return raw;
      });
      await navigate("Tasks");
      await page.getByTestId("tasks-open").waitFor();
      const open = page.getByTestId("tasks-open");
      const count = await open.locator(".list-row").count();
      assert.ok(count > 0);
      checks++;
      const done = page.getByTestId("tasks-done");
      await done.locator("summary").click();
      assert.ok((await done.locator(".list-row").count()) > 0);
      checks++;
      const title = "Synthetic recurring task " + width;
      const input = page.getByTestId("task-input");
      await input.fill(title);
      await page.evaluate(() => {
        window.failTaskRead = true;
      });
      await page.getByRole("button", { name: "Add", exact: true }).click();
      await page.waitForFunction(
        () =>
          document
            .querySelector(".route-fade")
            ?.textContent.includes("Synthetic existing note read failure") ||
          document
            .querySelector(".route-fade")
            ?.textContent.includes("already exists: synthetic daily note") ||
          window.taskWrites > 1,
      );
      await page.evaluate(() => {
        window.failTaskRead = false;
      });
      assert.equal(
        await read(),
        original,
        "A read failure must never overwrite an existing daily note",
      );
      checks++;
      assert.equal(
        await input.inputValue(),
        title,
        "Keep the draft after a failed save",
      );
      checks++;
      await page.getByTestId("task-composer-toggle").click();
      await page.getByLabel("Repeat", { exact: true }).fill("every week");
      await page.getByRole("button", { name: "Due date", exact: true }).click();
      await page
        .getByRole("dialog", { name: "Due date", exact: true })
        .getByRole("button", { name: "Today", exact: true })
        .click();
      await page.getByRole("button", { name: "Add", exact: true }).click();
      const row = open.locator(".list-row").filter({ hasText: title });
      await row.waitFor();
      assert.equal(await open.locator(".list-row").count(), count + 1);
      checks++;
      assert.match(await read(), /Synthetic existing journal must survive/);
      checks++;
      assert.match(
        await read(),
        new RegExp(
          "- \\[ \\] " + title + " 📅 \\d{4}-\\d{2}-\\d{2} 🔁 every week",
        ),
      );
      checks++;
      await row.getByRole("button").click();
      const detail = page.getByTestId("task-detail");
      await detail.waitFor();
      const bounds = await detail.boundingBox();
      assert.ok(bounds && bounds.y >= 0 && bounds.y + bounds.height <= 892);
      checks++;
      assert.equal(
        await detail
          .getByRole("button", { name: "To do", exact: true })
          .getAttribute("aria-pressed"),
        "true",
      );
      checks++;
      await detail.getByLabel(/^Priority/).selectOption("1");
      await page.waitForFunction(
        () =>
          !document.querySelector('[data-testid="task-detail"] select')
            ?.disabled,
      );
      assert.match(await read(), /!p1/);
      checks++;
      await detail.getByLabel("Estimate", { exact: true }).fill("90m");
      await detail.getByLabel("Estimate", { exact: true }).press("Tab");
      await page.waitForFunction(
        () =>
          !document.querySelector('[data-testid="task-detail"] textarea')
            ?.disabled,
      );
      assert.match(await read(), /⏱ 90m/);
      checks++;
      await detail
        .getByLabel(/^Notes/)
        .fill("Synthetic task context");
      await detail.getByLabel(/^Notes/).press("Tab");
      await page.waitForFunction(
        () =>
          !document.querySelector('[data-testid="task-detail"] textarea')
            ?.disabled,
      );
      assert.match(await read(), /  Synthetic task context/);
      checks++;
      for (const [label, mark] of [
        ["In progress", "/"],
        ["Blocked", "-"],
      ]) {
        await detail.getByRole("button", { name: label, exact: true }).click();
        await page.waitForFunction(
          (label) =>
            document.querySelector(
              '[data-testid="task-detail"] button[aria-pressed="true"]',
            )?.textContent === label,
          label,
        );
        assert.ok((await read()).includes("- [" + mark + "] " + title));
        checks++;
      }
      await detail.getByRole("button", { name: "Done", exact: true }).click();
      await page.waitForFunction(
        () =>
          document.querySelector(
            '[data-testid="task-detail"] button[aria-pressed="true"]',
          )?.textContent === "Done",
      );
      const recurring = await read();
      assert.ok(recurring.includes("- [x] " + title));
      checks++;
      assert.equal(
        recurring
          .split("\n")
          .filter((line) => line.startsWith("- [ ] " + title)).length,
        1,
      );
      checks++;
      const next = await page.evaluate(() => {
        const [y, m, d] = window.taskDay.split("-").map(Number);
        const n = new Date(Date.UTC(y, m - 1, d + 7));
        return n.toISOString().slice(0, 10);
      });
      assert.ok(
        recurring
          .split("\n")
          .some(
            (line) =>
              line.startsWith("- [ ] " + title) && line.includes("📅 " + next),
          ),
      );
      checks++;
      await detail.getByRole("button", { name: /^Open / }).click();
      await page.locator(".cm-content").waitFor();
      assert.match(
        await page.locator(".cm-content").innerText(),
        /Synthetic task context/,
      );
      checks++;
      const deleted = recurring
        .split("\n")
        .filter(
          (line) =>
            !line.includes(title) && !line.includes("Synthetic task context"),
        )
        .join("\n");
      await page.locator(".cm-content").focus();
      await page.keyboard.press("ControlOrMeta+A");
      await page.keyboard.insertText(deleted);
      await page.keyboard.press("ControlOrMeta+s");
      await page.waitForFunction(
        async (deleted) =>
          (
            await window.__TAURI_INTERNALS__.invoke("read_file", {
              path: window.taskPath,
            })
          ).raw === deleted,
        deleted,
      );
      checks++;
      await navigate("Tasks");
      await page.getByTestId("tasks-open").waitFor();
      assert.equal(
        await page
          .getByTestId("tasks-open")
          .locator(".list-row")
          .filter({ hasText: title })
          .count(),
        0,
      );
      checks++;
      assert.equal(
        await page.getByTestId("tasks-open").locator(".list-row").count(),
        count,
      );
      checks++;
      assert.ok(
        (await page.evaluate(() => document.scrollingElement.scrollWidth)) <=
          width,
      );
      checks++;
      assert.deepEqual(errors, []);
      checks++;
      await page.screenshot({ path: output + "/" + width + ".png" });
      console.log(
        "PASS " +
          width +
          "px tasks create/read/update/status/recur/delete + failed-save preservation (mock IPC)",
      );
    } catch(error) {
      console.error(await page.getByTestId("task-detail").evaluate(node=>node.outerHTML).catch(()=>"Detail unavailable"));
      throw error;
    } finally {
      await page.close();
    }
  }
} finally {
  await browser.close();
}
console.log(
  checks + " assertions passed; native IPC/disk behavior is not exercised.",
);
