// New-note focus regression against the development IPC mock only.
// Start Vite, then run: node scripts/new-note-writing-smoke.mjs
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright";

const base = process.env.MYCO_TEST_URL ?? "http://127.0.0.1:5173";
const output = process.env.MYCO_SCREENSHOTS ?? "/tmp/myco-new-note-writing";
await mkdir(output, { recursive: true });
const browser = await chromium.launch();
const errors = [];
let checks = 0;

function check(condition, message) {
  assert.ok(condition, message);
  checks++;
  console.log(`PASS ${message}`);
}

async function openHome(mode) {
  const page = await browser.newPage({
    viewport: { width: 1280, height: 900 },
  });
  page.on("pageerror", (error) => errors.push(error.stack ?? error.message));
  await page.addInitScript((editorMode) => {
    localStorage.setItem(
      "myco-ui",
      JSON.stringify({
        version: 3,
        state: {
          lang: "ko",
          theme: "dark",
          editorMode,
          sidebarCollapsed: false,
        },
      }),
    );
  }, mode);
  await page.goto(`${base}/?mock=1`);
  await page.locator(".home-page").waitFor();
  await page.evaluate(() => {
    const invoke = window.__TAURI_INTERNALS__.invoke;
    window.__TAURI_INTERNALS__.invoke = async (command, args) => {
      if (command === "create_file") {
        const path = `${args.parent}/${args.name}`;
        const title = args.name.replace(/\.md$/i, "").replace(/[-_]/g, " ");
        // devMock only echoes a path. Seed the same shape as Rust's
        // wiki_page_stub so this checks caret placement around real metadata.
        const raw = `---\ntype: concept\ntags:\ncreated: 2026-01-01\nconfidence: medium\nstatus: active\n---\n\n# ${title}\n`;
        await invoke("write_file", { path, content: raw });
        window.__createdNote = { path, raw };
        return path;
      }
      return invoke(command, args);
    };
  });
  return page;
}

async function nameNote(page, title) {
  const input = page.getByRole("dialog").getByRole("textbox");
  await input.fill(title);
  await input.press("Enter");
  await page.getByRole("heading", { name: title, exact: true }).waitFor();
  await page.waitForFunction(() =>
    document.activeElement?.matches(".cm-content"),
  );
}

async function waitForSavedText(page, expected) {
  await page.waitForFunction(async (raw) => {
    const { ipc } = await import("/src/lib/ipc.ts");
    return (await ipc.readFile(window.__createdNote.path)).raw === raw;
  }, expected);
}

try {
  for (const [mode, entry] of [
    ["live", "home"],
    ["live", "sidebar"],
    ["source", "home"],
    // An older build's stored Read view: it is read as "live" now.
    ["preview", "home"],
    ["live", "shortcut"],
  ]) {
    const page = await openHome(mode);
    const title = `writing-${mode}-${entry}`;
    if (entry === "home")
      await page
        .getByRole("button", { name: "새 노트 쓰기", exact: false })
        .click();
    else if (entry === "sidebar") await page.locator(".ngl-add").click();
    else await page.keyboard.press("ControlOrMeta+n");
    await nameNote(page, title);

    const before = await page.evaluate(async () => {
      const { ipc } = await import("/src/lib/ipc.ts");
      const { useUIStore } = await import("/src/stores/uiStore.ts");
      return {
        mode: useUIStore.getState().editorMode,
        initial: window.__createdNote.raw,
        raw: (await ipc.readFile(window.__createdNote.path)).raw,
      };
    });
    check(
      before.mode === "live",
      `${mode}/${entry}: new note opens in writing mode`,
    );
    check(
      before.raw === before.initial,
      `${mode}/${entry}: focusing does not rewrite the note`,
    );

    // No click or focus call: typing must follow the naming dialog directly.
    await page.keyboard.insertText("본문 입력");
    await page.keyboard.press("ControlOrMeta+s");
    await waitForSavedText(page, `${before.initial}본문 입력`);
    check(
      true,
      `${mode}/${entry}: immediate Korean input lands below the title and preserves metadata`,
    );

    if (entry === "sidebar") {
      const editor = await page.locator(".cm-content").elementHandle();
      await page.evaluate(async () => {
        const { useVaultStore } = await import("/src/stores/vaultStore.ts");
        const path = window.__createdNote.path;
        // The mock tree is static. Publish this synthetic note so the second
        // creation resolves to it, just as a real refreshed directory does.
        useVaultStore.setState({
          fileTree: [
            ...useVaultStore.getState().fileTree,
            { kind: "file", name: path.split("/").pop(), path },
          ],
        });
      });
      await page.locator(".ngl-add").click();
      await nameNote(page, title);
      check(
        await editor.evaluate((el) => el.isConnected),
        "same-note creation refocuses the existing editor without remounting",
      );
      await page.keyboard.insertText(" 계속");
      await page.keyboard.press("ControlOrMeta+s");
      await waitForSavedText(page, `${before.initial}본문 입력 계속`);
      check(
        true,
        "same-note creation retains existing text and resumes at its end",
      );
    }
    await page.screenshot({
      path: `${output}/${mode}-${entry}.png`,
      fullPage: true,
    });
    await page.close();
  }

  // "source" is the one mode left to choose besides Live (spec 2026-10-01).
  const cancelled = await openHome("source");
  const opener = cancelled.getByRole("button", {
    name: "새 노트 쓰기",
    exact: false,
  });
  await opener.click();
  await cancelled.getByRole("dialog").getByRole("textbox").press("Escape");
  await cancelled.getByRole("dialog").waitFor({ state: "detached" });
  const afterCancel = await cancelled.evaluate(async () => {
    const { useUIStore } = await import("/src/stores/uiStore.ts");
    return {
      created: !!window.__createdNote,
      mode: useUIStore.getState().editorMode,
    };
  });
  check(
    !afterCancel.created && afterCancel.mode === "source",
    "cancelling creates nothing and preserves the chosen mode",
  );
  check(
    await opener.evaluate((el) => el === document.activeElement),
    "cancelling returns focus to the opener",
  );
  await cancelled.close();
  check(errors.length === 0, `no page errors: ${errors.join("\n")}`);
  console.log(
    `\n${checks} new-note writing checks passed. Screenshots: ${output}`,
  );
} finally {
  await browser.close();
}
