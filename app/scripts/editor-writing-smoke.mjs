// Writing regression against development mock IPC; never opens a real vault.
// Start Vite, then run: node scripts/editor-writing-smoke.mjs
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright";

const base = process.env.MYCO_TEST_URL ?? "http://127.0.0.1:5173";
const output = process.env.MYCO_SCREENSHOTS ?? "/tmp/myco-editor-writing";
const note = [
  "---",
  "type: overview",
  "tags: []",
  "status: active",
  "---",
  "",
  "# 작성 연습",
  "",
  "회의 내용을 정리합니다.",
  "",
  "### 진행 중인 작업",
  "- 첫 번째 항목",
  "- 두 번째 항목",
  "",
  "> 인용문은 인용문으로 표시합니다.",
  "",
  "- [ ] 확인할 일",
  "",
  "**강조한 내용**과 [[연결할 메모]]",
  "",
].join("\n");
await mkdir(output, { recursive: true });
const browser = await chromium.launch();
const errors = [];
let checks = 0;
function check(condition, message) {
  assert.ok(condition, message);
  checks++;
  console.log(`PASS ${message}`);
}
async function openNote(
  width = 1280,
  theme = "dark",
  hasHistory = true,
  mode = "source",
) {
  const page = await browser.newPage({ viewport: { width, height: 1000 } });
  page.on("pageerror", (error) => errors.push(error.stack ?? error.message));
  await page.addInitScript(
    ({ width, theme, mode }) => {
      performance.setResourceTimingBufferSize(5000);
      // Use the module mounted by Vite, including its HMR version. Importing an
      // unversioned URL can create a second Zustand store with no open vault.
      window.__importAppModule = (path) => {
        const entry = performance.getEntriesByType("resource")
          .filter((resource) => new URL(resource.name).pathname === path).at(-1);
        if (!entry) throw new Error(`App module was not loaded: ${path}`);
        return import(entry.name);
      };
      localStorage.setItem(
        "myco-ui",
        JSON.stringify({
          version: 3,
          state: {
            lang: "ko",
            theme,
            editorMode: mode,
            sidebarCollapsed: width < 900,
          },
        }),
      );
    },
    { width, theme, mode },
  );
  await page.goto(`${base}/?mock=1`);
  await page.locator(".home-page").waitFor();
  await page.waitForFunction(async () => {
    const { useVaultStore } = await window.__importAppModule("/src/stores/vaultStore.ts");
    return useVaultStore.getState().currentVault !== null;
  });
  await page.evaluate(
    async ({ note, hasHistory }) => {
      const { ipc } = await window.__importAppModule("/src/lib/ipc.ts");
      const { useVaultStore } = await window.__importAppModule("/src/stores/vaultStore.ts");
      const { useUIStore } = await window.__importAppModule("/src/stores/uiStore.ts");
      const root = useVaultStore.getState().currentVault.path;
      const path = `${root}/wiki/writing-regression.md`;
      const original = window.__TAURI_INTERNALS__.invoke;
      window.__TAURI_INTERNALS__.invoke = (command, args) => {
        if (command === "page_authorship")
          return Promise.resolve(
            hasHistory
              ? {
                  human_lines: 20,
                  agent_lines: 1,
                  last_human_at: 1700000000,
                  runs: [
                    {
                      from: 1,
                      to: 8,
                      agent: false,
                      sha: "1".repeat(40),
                      ts: 1700000000,
                    },
                    {
                      from: 9,
                      to: 9,
                      agent: true,
                      sha: "2".repeat(40),
                      ts: 1700000000,
                    },
                    {
                      from: 10,
                      to: 40,
                      agent: false,
                      sha: "1".repeat(40),
                      ts: 1700000000,
                    },
                  ],
                }
              : null,
          );
        return original(command, args);
      };
      await ipc.writeFile(path, note);
      useUIStore.getState().setRoute(`page:${path}`);
      window.__writingTestPath = path;
    },
    { note, hasHistory },
  );
  await page.locator(".cm-content").waitFor();
  if (hasHistory) {
    await openInfo(page);
    await page.locator(".auth-badge").waitFor();
    await closeInfo(page);
  }
  return page;
}
async function sourceText(page) {
  return page
    .locator(".cm-content .cm-line")
    .evaluateAll((lines) => lines.map((line) => line.textContent).join("\n"));
}
async function toggleAuthorship(page, visible) {
  await page.getByRole("button", { name: "더 보기", exact: true }).click();
  await page
    .getByRole("menuitem", {
      name: visible ? "작성자 표시 켜기" : "작성자 표시 끄기",
      exact: true,
    })
    .press("Enter");
}
async function editSource(page) {
  await page.getByRole("button", { name: "더 보기", exact: true }).click();
  await page
    .getByRole("menuitem", { name: "마크다운 원문 편집", exact: true })
    .press("Enter");
  await page.locator(".reader-source-notice").waitFor();
}
async function writeNormally(page) {
  await page
    .getByRole("button", { name: "원문 편집 닫기", exact: true })
    .click();
  await page.locator(".myco-editor.live").waitFor();
}
async function checkOverflow(page, label) {
  const widths = await page
    .locator(".reader-head, .myco-editor, .reader-rail")
    .evaluateAll((elements) =>
      elements.map((el) => ({
        name: el.className,
        scroll: el.scrollWidth,
        client: el.clientWidth,
      })),
    );
  if (widths.some((el) => el.scroll > el.client + 1)) {
    console.error(`Overflow dimensions: ${JSON.stringify(widths)}`);
    await page.screenshot({
      path: `${output}/overflow-${label.replaceAll(" ", "-")}.png`,
      fullPage: true,
    });
  }
  check(
    widths.every((el) => el.scroll <= el.client + 1),
    `${label}: reader controls, editor and note information have no horizontal overflow`,
  );
  check(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth + 1,
    ),
    `${label}: page has no horizontal overflow`,
  );
}
async function openInfo(page) {
  const toggle = page.getByRole("button", { name: "노트 정보", exact: true });
  if (await toggle.count()) await toggle.press("Enter");
  else {
    await page.getByRole("button", { name: "더 보기", exact: true }).press("Enter");
    await page.getByRole("menuitem", { name: "노트 정보", exact: true }).press("Enter");
  }
}
async function closeInfo(page) {
  const sheet = page.getByRole("dialog", { name: "노트 정보", exact: true });
  if (await sheet.count()) await sheet.getByRole("button", { name: "닫기", exact: true }).press("Enter");
  else await page.getByRole("button", { name: "노트 정보", exact: true }).press("Enter");
}
async function checkInfoPanel(page, label, placed = false) {
  const phone = page.viewportSize().width <= 768;
  const toggle = page.getByRole("button", { name: phone ? "더 보기" : "노트 정보", exact: true });
  check(
    await toggle.isVisible(),
    `${label}: note information toggle is visible`,
  );
  check(
    (await page.locator(".reader-rail").count()) === 0,
    `${label}: note information starts closed`,
  );
  const editor = await page.locator(".cm-content").elementHandle();
  await openInfo(page);
  const panel = page.getByRole("complementary", {
    name: "노트 정보",
    exact: true,
  });
  await panel.waitFor();
  check(
    await panel.isVisible(),
    `${label}: keyboard activation opens note information`,
  );
  if (placed) {
    // Note info no longer wraps below the note, off-screen on a long one
    // (1a3a9fe, 2d9c448): it sits beside the note while the body holds both
    // columns, and is a drawer over the note's right edge from its top
    // otherwise. Either way it opens in view.
    const sectionBox = await page
      .locator(".reader-body > section")
      .boundingBox();
    const sheet = page.getByRole("dialog", { name: "노트 정보", exact: true });
    const drawer = (await sheet.count()) > 0;
    if (drawer) await page.waitForFunction(() => {
      const rect = document.querySelector(".reader-sheet")?.getBoundingClientRect();
      return rect && rect.y >= 0 && rect.x >= -1 && rect.right <= window.innerWidth + 1;
    });
    const panelBox = await (drawer ? sheet : panel).boundingBox();
    check(
      sectionBox &&
        panelBox &&
        panelBox.y < page.viewportSize().height &&
        (drawer
            ? panelBox.y >= 0 && panelBox.x >= 0 &&
            panelBox.x + panelBox.width <= page.viewportSize().width + 1
          : panelBox.x >= sectionBox.x + sectionBox.width - 1),
      `${label}: note information opens in view, beside the note or over its edge`,
    );
  }
  await checkOverflow(page, `${label} with note information`);
  await page.screenshot({
    path: `${output}/information-${label}.png`,
    fullPage: true,
  });
  await closeInfo(page);
  check(
    (await panel.count()) === 0 &&
      (await editor.evaluate((el) => el.isConnected)),
    `${label}: closing note information preserves the editor instance`,
  );
}
try {
  const page = await openNote();
  await page.screenshot({ path: `${output}/after.png`, fullPage: true });
  check(
    (await page.locator(".reader-head .segmented").count()) === 0 &&
      (await page.getByRole("button", { name: "읽기", exact: true }).count()) === 0,
    "one editor: the reader head has no 쓰기 / 읽기 toggle",
  );
  check(
    await page
      .locator(".reader-source-notice")
      .getByText("마크다운 원문 편집 중", { exact: true })
      .isVisible(),
    "persisted source mode has an explicit status and return path",
  );
  check(
    (await sourceText(page)) === note,
    "Source preserves markdown and frontmatter",
  );
  check(
    (await page.locator(".cm-auth-gutter").count()) === 0,
    "writing starts without authorship bars or an empty gutter",
  );

  const content = page.locator(".cm-content");
  const editor = await content.elementHandle();
  const more = page.getByRole("button", { name: "더 보기", exact: true });
  await more.press("Enter");
  check(
    await page
      .getByRole("menu")
      .evaluate((el) => el.contains(document.activeElement)),
    "opening More moves keyboard focus into the menu",
  );
  // Layout runs in 1/64 px units: at a fractional offset (the 46.19px title
  // above) a 2.75rem item measures 43.99998, so compare with a float epsilon.
  check(
    await page
      .getByRole("menuitem")
      .evaluateAll((items) =>
        items.every((el) => el.getBoundingClientRect().height >= 44 - 0.01),
      ),
    "all More menu items have at least 44px touch height",
  );
  await page.keyboard.press("Escape");
  check(
    (await page.getByRole("menu").count()) === 0 &&
      (await more.evaluate((el) => el === document.activeElement)),
    "Escape closes More and restores focus to its button",
  );
  await content.focus();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.insertText("입력 확인");
  await toggleAuthorship(page, true);
  await page.locator(".auth-run.is-agent").waitFor();
  check(
    await editor.evaluate((el) => el.isConnected),
    "showing history preserves the editor instance",
  );
  check(
    (await sourceText(page)).endsWith("입력 확인"),
    "history toggle preserves unsaved Korean input",
  );
  await page.locator(".auth-run.is-agent").click();
  await page.getByRole("dialog", { name: "이 문단을 쓴 사람" }).waitFor();
  check(
    await page.getByRole("button", { name: "이 문단 되돌리기" }).isEnabled(),
    "explicit history view retains paragraph review and revert",
  );
  await page.keyboard.press("Escape");
  await toggleAuthorship(page, false);
  check(
    (await page.locator(".cm-auth-gutter").count()) === 0,
    "hiding history removes bars and gutter width",
  );
  await content.focus();
  await page.keyboard.press("ControlOrMeta+z");
  check(
    (await sourceText(page)) === note,
    "undo history survives both toggles",
  );

  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.insertText("모드 전환 확인");
  await writeNormally(page);
  check(
    await editor.evaluate((el) => el.isConnected),
    "returning from source to writing preserves the editor instance",
  );
  await editSource(page);
  check(
    (await sourceText(page)).endsWith("모드 전환 확인") &&
      (await editor.evaluate((el) => el.isConnected)),
    "entering source through More preserves unsaved Korean input and editor instance",
  );
  await content.focus();
  await page.keyboard.press("ControlOrMeta+z");
  check(
    (await sourceText(page)) === note,
    "undo history survives source and writing switches",
  );

  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.insertText("- 새 항목");
  await page.keyboard.press("Enter");
  check(
    (await sourceText(page)).endsWith("- 새 항목\n- "),
    "Enter continues a markdown list",
  );
  await page.keyboard.insertText("다음 항목");
  await page.keyboard.press("ControlOrMeta+s");
  const edited = await sourceText(page);
  await page.waitForFunction(async () => {
    const { ipc } = await window.__importAppModule("/src/lib/ipc.ts");
    return (await ipc.readFile(window.__writingTestPath)).raw.endsWith(
      "다음 항목",
    );
  });
  await writeNormally(page);
  await page.locator(".myco-editor.live .live-h3").waitFor();
  check(
    (await page.locator(".cm-auth-gutter").count()) === 0,
    "Live mode also keeps authorship bars hidden",
  );
  check(
    (await page.locator(".live-quote").count()) === 1,
    "only the actual markdown quote gets quote styling",
  );
  await editSource(page);
  await page.locator(".cm-content").waitFor();
  check(
    (await sourceText(page)) === edited,
    "Source/Live round trip is lossless",
  );
  await toggleAuthorship(page, true);
  await page.locator(".cm-auth-gutter").waitFor();
  await page.evaluate(async () => {
    const { ipc } = await window.__importAppModule("/src/lib/ipc.ts");
    const { useUIStore } = await window.__importAppModule("/src/stores/uiStore.ts");
    const path = window.__writingTestPath.replace(
      "writing-regression.md",
      "writing-next.md",
    );
    await ipc.writeFile(path, "# Another note\n\nStart writing here.\n");
    useUIStore.getState().setRoute(`page:${path}`);
  });
  await page
    .getByRole("heading", { name: "writing-next", exact: true })
    .waitFor();
  await page.locator(".cm-content").waitFor();
  check(
    (await page.locator(".cm-auth-gutter").count()) === 0,
    "the next note starts without marks after reviewing history",
  );
  await page.close();

  for (const width of [320, 375, 768, 960, 1280]) {
    const narrow = await openNote(
      width,
      width === 1280 ? "light" : "dark",
      true,
      "live",
    );
    check(
      (await narrow.locator(".cm-auth-gutter").count()) === 0,
      `${width}: no writing bars`,
    );
    await checkOverflow(narrow, `${width} writing`);
    await narrow.screenshot({
      path: `${output}/writing-${width}.png`,
      fullPage: true,
    });
    await checkInfoPanel(narrow, String(width), width <= 960);
    await editSource(narrow);
    await checkOverflow(narrow, `${width} source`);
    await narrow.screenshot({
      path: `${output}/source-${width}.png`,
      fullPage: true,
    });
    await narrow.close();
  }
  const split = await openNote(1280, "dark", true, "live");
  await split.evaluate(async () => {
    const { useUIStore } = await window.__importAppModule("/src/stores/uiStore.ts");
    useUIStore.getState().setRoute("overview");
    useUIStore.getState().setSplitRoute(`page:${window.__writingTestPath}`);
  });
  await split.locator(".workspace-pane--secondary .cm-content").waitFor();
  await checkInfoPanel(split, "split", true);
  await split.close();

  const imported = await openNote(1280, "dark", false, "live");
  const originalSource =
    "# Imported reference\n\nKeep the imported text unchanged.\n";
  await imported.evaluate(async (text) => {
    const { ipc } = await window.__importAppModule("/src/lib/ipc.ts");
    const { useVaultStore } = await window.__importAppModule("/src/stores/vaultStore.ts");
    const { useUIStore } = await window.__importAppModule("/src/stores/uiStore.ts");
    const path = `${useVaultStore.getState().currentVault.path}/raw/reader-imported.md`;
    // The development mock allows fixture seeding under raw/. Count every
    // later attempted write, independently of the native backend's protection.
    await ipc.writeFile(path, text);
    const invoke = window.__TAURI_INTERNALS__.invoke;
    window.__rawTestPath = path;
    window.__rawWriteAttempts = 0;
    window.__TAURI_INTERNALS__.invoke = (command, args) => {
      if (command === "write_file" && args.path === path)
        window.__rawWriteAttempts++;
      return invoke(command, args);
    };
    useUIStore.getState().setRoute(`page:${path}`);
  }, originalSource);
  await imported
    .getByText(/^가져온 원본 파일은 읽기만 가능합니다\./)
    .waitFor();
  check(
    (await imported.locator(".cm-content").count()) === 0 &&
      (await imported.locator(".myco-viewer h1").textContent()) ===
        "Imported reference",
    "imported originals render as readable markdown without an editor",
  );
  check(
    (await imported.locator(".reader-head .segmented").count()) === 0,
    "imported originals offer no mode toggle",
  );
  await imported.getByRole("button", { name: "더 보기", exact: true }).click();
  check(
    !(await imported
      .getByRole("menuitem", { name: "마크다운 원문 편집", exact: true })
      .isEnabled()),
    "imported originals disable source editing in More",
  );
  await imported.keyboard.press("Escape");
  await imported.keyboard.press("ControlOrMeta+e");
  check(
    (await imported.locator(".cm-content").count()) === 0,
    "⌘E cannot edit an imported original",
  );
  const sourceState = await imported.evaluate(async () => {
    const { ipc } = await window.__importAppModule("/src/lib/ipc.ts");
    const { useUIStore } = await window.__importAppModule("/src/stores/uiStore.ts");
    return {
      text: (await ipc.readFile(window.__rawTestPath)).raw,
      writes: window.__rawWriteAttempts,
      mode: useUIStore.getState().editorMode,
    };
  });
  check(
    sourceState.text === originalSource && sourceState.writes === 0,
    "opening an imported original and its controls makes no write attempt",
  );
  check(
    sourceState.mode === "live",
    "reading an original preserves the preferred writing mode",
  );
  check(
    (await imported.locator(".reader-save-status").count()) === 0,
    "read-only originals do not show an editing save status",
  );
  await imported.evaluate(async () => {
    const { useUIStore } = await window.__importAppModule("/src/stores/uiStore.ts");
    useUIStore.getState().setRoute(`page:${window.__writingTestPath}`);
  });
  await imported.locator(".myco-editor.live").waitFor();
  check(
    (await imported.locator(".myco-editor.live .cm-content").count()) === 1,
    "returning to a normal note restores writing",
  );
  await imported.close();

  const feedback = await openNote(1280, "dark", false);
  const saveStatus = feedback.locator(".reader-save-status");
  await saveStatus.getByText("저장됨", { exact: true }).waitFor();
  check(
    (await saveStatus.getAttribute("role")) === "status",
    "saved notes expose a polite save status",
  );
  await feedback.evaluate(() => {
    const invoke = window.__TAURI_INTERNALS__.invoke;
    window.__feedbackWrites = 0;
    window.__TAURI_INTERNALS__.invoke = (command, args) => {
      if (command === "write_file" && args.path === window.__writingTestPath) {
        window.__feedbackWrites++;
        return new Promise((resolve, reject) => {
          window.__releaseFeedbackWrite = () =>
            invoke(command, args).then(resolve, reject);
        });
      }
      return invoke(command, args);
    };
  });
  await feedback.locator(".cm-content").focus();
  await feedback.keyboard.press("ControlOrMeta+End");
  await feedback.keyboard.insertText("첫 번째 수정");
  check(
    (await saveStatus.textContent()) === "자동 저장 대기 중…",
    "typing shows pending autosave before the debounce ends",
  );
  await feedback.waitForFunction(() => window.__feedbackWrites === 1);
  check(
    (await saveStatus.textContent()) === "저장 중…",
    "autosave shows saving until the write actually completes",
  );
  await feedback.keyboard.insertText(" 그리고 추가 수정");
  await feedback.keyboard.press("ControlOrMeta+s");
  await feedback.evaluate(() => window.__releaseFeedbackWrite());
  await feedback.waitForFunction(() => window.__feedbackWrites === 2);
  check(
    (await saveStatus.textContent()) === "저장 중…",
    "an earlier completed write cannot mark a newer queued edit as saved",
  );
  await feedback.evaluate(() => window.__releaseFeedbackWrite());
  await saveStatus.getByText("저장됨", { exact: true }).waitFor();
  check(
    await feedback.evaluate(async (expected) => {
      const { ipc } = await window.__importAppModule("/src/lib/ipc.ts");
      return (await ipc.readFile(window.__writingTestPath)).raw === expected;
    }, `${note}첫 번째 수정 그리고 추가 수정`),
    "saved status appears only after the latest text reaches disk",
  );
  await feedback.close();

  const recovery = await openNote(1280, "dark", false);
  await recovery.evaluate(() => {
    const invoke = window.__TAURI_INTERNALS__.invoke;
    window.__rejectWritingSave = true;
    window.__holdWritingSave = false;
    window.__TAURI_INTERNALS__.invoke = (command, args) => {
      if (command === "write_file" && args.path === window.__writingTestPath) {
        if (window.__rejectWritingSave)
          return Promise.reject(new Error("Writing regression: EROFS"));
        if (window.__holdWritingSave)
          return new Promise((resolve, reject) => {
            window.__releaseWritingSave = () =>
              invoke(command, args).then(resolve, reject);
          });
      }
      return invoke(command, args);
    };
  });
  const recoveredText = `${note}복구해야 할 내용`;
  await recovery.locator(".cm-content").focus();
  await recovery.keyboard.press("ControlOrMeta+End");
  await recovery.keyboard.insertText("복구해야 할 내용");
  await recovery.keyboard.press("ControlOrMeta+s");
  const failure = recovery.locator(".reader-save-error");
  await failure
    .getByText(
      "저장되지 않은 내용이 있어요. 앱을 닫기 전에 다시 저장해 주세요.",
      { exact: true },
    )
    .waitFor();
  check(
    (await failure.getAttribute("role")) === "alert" &&
      (await sourceText(recovery)) === recoveredText,
    "a failed save gives an actionable alert and keeps the draft in the editor",
  );
  check(
    (await recovery.locator(".reader-save-status").textContent()) === "저장 필요",
    "failed writes cannot show a saved status",
  );
  check(
    await recovery.evaluate(async (expected) => {
      const { ipc } = await window.__importAppModule("/src/lib/ipc.ts");
      return (await ipc.readFile(window.__writingTestPath)).raw === expected;
    }, note),
    "a rejected write leaves the on-disk mock content unchanged",
  );
  await recovery.evaluate(async () => {
    const { ipc } = await window.__importAppModule("/src/lib/ipc.ts");
    const { useUIStore } = await window.__importAppModule("/src/stores/uiStore.ts");
    const path = window.__writingTestPath.replace(
      "writing-regression.md",
      "writing-safe.md",
    );
    await ipc.writeFile(path, "# Another note\n\nA separate saved note.\n");
    useUIStore.getState().setRoute(`page:${path}`);
  });
  await recovery
    .getByRole("heading", { name: "writing-safe", exact: true })
    .waitFor();
  await recovery.evaluate(async () => {
    const { useUIStore } = await window.__importAppModule("/src/stores/uiStore.ts");
    useUIStore.getState().setRoute(`page:${window.__writingTestPath}`);
  });
  await recovery
    .getByRole("heading", { name: "writing-regression", exact: true })
    .waitFor();
  await failure.waitFor();
  check(
    (await sourceText(recovery)) === recoveredText,
    "returning to a note restores its failed draft within the same app session",
  );
  await recovery.screenshot({
    path: `${output}/save-retry.png`,
    fullPage: true,
  });
  await recovery.evaluate(() => {
    window.__rejectWritingSave = false;
    window.__holdWritingSave = true;
  });
  await failure.getByRole("button", { name: "다시 저장", exact: true }).click();
  await recovery.waitForFunction(
    () => typeof window.__releaseWritingSave === "function",
  );
  check(
    !(await failure
      .getByRole("button", { name: "저장 중…", exact: true })
      .isEnabled()),
    "retry shows saving progress and disables repeated submissions",
  );
  await recovery.evaluate(() => window.__releaseWritingSave());
  await failure.waitFor({ state: "detached" });
  await recovery.locator(".reader-save-status").getByText("저장됨", { exact: true }).waitFor();
  check(
    await recovery.evaluate(async (expected) => {
      const { ipc } = await window.__importAppModule("/src/lib/ipc.ts");
      return (await ipc.readFile(window.__writingTestPath)).raw === expected;
    }, recoveredText),
    "retry persists the recovered draft and clears the save alert",
  );
  await recovery.close();

  const undone = await openNote(1280, "dark", false);
  await undone.evaluate(() => {
    const invoke = window.__TAURI_INTERNALS__.invoke;
    window.__rejectUndoSave = true;
    window.__TAURI_INTERNALS__.invoke = (command, args) => {
      if (command === "write_file" && args.path === window.__writingTestPath && window.__rejectUndoSave)
        return Promise.reject(new Error("Writing regression: undo save rejected"));
      return invoke(command, args);
    };
  });
  await undone.locator(".cm-content").focus();
  await undone.keyboard.press("ControlOrMeta+End");
  await undone.keyboard.insertText("되돌릴 내용");
  await undone.keyboard.press("ControlOrMeta+z");
  await undone.keyboard.press("ControlOrMeta+s");
  await undone.locator(".reader-save-error").waitFor();
  await undone.evaluate(async () => {
    const { useUIStore } = await window.__importAppModule("/src/stores/uiStore.ts");
    useUIStore.getState().setRoute("overview");
  });
  await undone.locator(".home-page").waitFor();
  await undone.evaluate(async () => {
    const { useUIStore } = await window.__importAppModule("/src/stores/uiStore.ts");
    useUIStore.getState().setRoute(`page:${window.__writingTestPath}`);
  });
  await undone.locator(".cm-content").waitFor();
  check(
    (await undone.locator(".reader-save-status").textContent()) === "저장 필요" &&
      await undone.getByRole("button", { name: "다시 저장", exact: true }).isVisible(),
    "returning after an undone save fails offers retry instead of waiting without a timer",
  );
  check(
    (await sourceText(undone)) === note,
    "restoring an undone draft preserves the original note exactly",
  );
  await undone.evaluate(() => { window.__rejectUndoSave = false; });
  await undone.getByRole("button", { name: "다시 저장", exact: true }).click();
  await undone.locator('.reader-save-status[data-state="saved"]').waitFor();
  check(
    await undone.evaluate(async () => {
      const { pendingDrafts } = await window.__importAppModule("/src/stores/vaultStore.ts");
      return !pendingDrafts.has(window.__writingTestPath);
    }),
    "retry confirms an undone draft and clears its pending ownership",
  );
  await undone.close();

  for (const navigateBeforeResolve of [false, true]) {
    const delayed = await openNote(1280, "dark", false);
    await delayed.evaluate(() => {
      const invoke = window.__TAURI_INTERNALS__.invoke;
      let holdFirstWrite = true;
      window.__TAURI_INTERNALS__.invoke = (command, args) => {
        if (
          command === "write_file" &&
          args.path === window.__writingTestPath &&
          holdFirstWrite
        ) {
          holdFirstWrite = false;
          return new Promise((resolve, reject) => {
            window.__releaseStaleSave = () =>
              invoke(command, args).then(resolve, reject);
          });
        }
        return invoke(command, args);
      };
    });
    await delayed.locator(".cm-content").focus();
    await delayed.keyboard.press("ControlOrMeta+End");
    await delayed.keyboard.insertText("느린 저장 중 되돌릴 내용");
    await delayed.keyboard.press("ControlOrMeta+s");
    await delayed.waitForFunction(
      () => typeof window.__releaseStaleSave === "function",
    );
    await delayed.keyboard.press("ControlOrMeta+z");
    check(
      (await sourceText(delayed)) === note,
      "undo restores the original while a save is pending",
    );
    if (navigateBeforeResolve) {
      await delayed.evaluate(async () => {
        const { ipc } = await window.__importAppModule("/src/lib/ipc.ts");
        const { useUIStore } = await window.__importAppModule("/src/stores/uiStore.ts");
        const path = window.__writingTestPath.replace(
          "writing-regression.md",
          "writing-during-save.md",
        );
        await ipc.writeFile(
          path,
          "# Another note\n\nLeave the pending save behind.\n",
        );
        useUIStore.getState().setRoute(`page:${path}`);
      });
      await delayed
        .getByRole("heading", { name: "writing-during-save", exact: true })
        .waitFor();
    }
    await delayed.evaluate(() => window.__releaseStaleSave());
    // Let React apply the completed write before examining the editor, without
    // waiting long enough to hide a stale reseed behind the next autosave.
    await delayed.evaluate(
      () =>
        new Promise((resolve) => {
          requestAnimationFrame(() => requestAnimationFrame(resolve));
        }),
    );
    if (!navigateBeforeResolve) {
      check(
        (await sourceText(delayed)) === note,
        "an older save response cannot overwrite an undo made while it was pending",
      );
    }
    await delayed.waitForFunction(async (expected) => {
      const { ipc } = await window.__importAppModule("/src/lib/ipc.ts");
      return (await ipc.readFile(window.__writingTestPath)).raw === expected;
    }, note);
    if (navigateBeforeResolve) {
      await delayed.evaluate(async () => {
        const { useUIStore } = await window.__importAppModule("/src/stores/uiStore.ts");
        useUIStore.getState().setRoute(`page:${window.__writingTestPath}`);
      });
      await delayed
        .getByRole("heading", { name: "writing-regression", exact: true })
        .waitFor();
      await delayed.locator(".cm-content").waitFor();
    }
    check(
      (await sourceText(delayed)) === note,
      navigateBeforeResolve
        ? "navigation flush saves the undone text after an older pending write and restores it on return"
        : "autosave persists the undone text after the older write completes",
    );
    await delayed.close();
  }

  const untracked = await openNote(1280, "dark", false);
  await untracked.getByRole("button", { name: "더 보기", exact: true }).click();
  check(
    (await untracked
      .getByRole("menuitem", { name: "작성자 표시 켜기" })
      .count()) === 0,
    "untracked notes show no unusable authorship control",
  );
  await untracked.close();

  const parseRetry = await openNote(1280, "dark", false);
  const parseSource = "Filler paragraph text.\n\n".repeat(150) +
    "- parent\n  - child one\n  - child two\n- next";
  const parsePosition = parseSource.indexOf("child one") + 7;
  const parseBlock = "> Synthetic retrieved quote\n— [[synthetic-source]]";
  const preserved = await parseRetry.evaluate(async ({ raw, pos, block }) => {
    const entry = performance.getEntriesByType("resource").find((resource) =>
      new URL(resource.name).pathname.endsWith("/@codemirror_view.js"),
    );
    if (!entry) throw new Error("The editor view module was not loaded");
    const { EditorView } = await import(entry.name);
    const { useNoteInsertStore } = await window.__importAppModule("/src/stores/noteInsertStore.ts");
    const view = EditorView.findFromDOM(document.querySelector(".cm-editor"));
    if (!view) throw new Error("The note editor is not mounted");
    window.__parseRetryView = view;
    const clock = Date.now;
    let now = clock();
    Date.now = () => (now += 1000);
    try {
      // Seed through the existing state's extensions without emitting an edit
      // to React. A fixture edit and a refused insertion in the same event
      // would let the reader's normal edit cleanup clear the new advice.
      view.setState(view.state.update({
        changes: { from: 0, to: view.state.doc.length, insert: raw },
        selection: { anchor: pos },
      }).state);
      useNoteInsertStore.getState().insert(block, true);
      return view.state.doc.toString() === raw && view.state.selection.main.head === pos;
    } finally {
      Date.now = clock;
    }
  }, { raw: parseSource, pos: parsePosition, block: parseBlock });
  check(preserved, "busy parsing keeps the entire note and insertion caret unchanged");
  const parseAdvice = parseRetry.getByRole("alert").filter({
    hasText: "노트를 아직 준비 중입니다. 내용을 넣지 않았어요. 잠시 후 다시 시도해 주세요.",
  });
  await parseAdvice.waitFor();
  check(await parseAdvice.isVisible(), "busy parsing gives visible advice to retry the insertion");
  await parseRetry.evaluate(async (block) => {
    const { useNoteInsertStore } = await window.__importAppModule("/src/stores/noteInsertStore.ts");
    useNoteInsertStore.getState().insert(block, true);
  }, parseBlock);
  await parseAdvice.waitFor({ state: "detached" });
  check(
    await parseRetry.evaluate(({ raw, block }) => window.__parseRetryView.state.doc.toString() ===
      raw.replace("  - child two\n- next", `  - child two\n\n${block}\n\n- next`),
    { raw: parseSource, block: parseBlock }),
    "retry inserts below the complete parent list and clears the earlier advice",
  );
  await parseRetry.locator(".cm-content").focus();
  await parseRetry.keyboard.press("ControlOrMeta+z");
  check(
    await parseRetry.evaluate((raw) => window.__parseRetryView.state.doc.toString() === raw, parseSource),
    "one undo restores the note after a declined insertion and its successful retry",
  );
  await parseRetry.close();
  check(errors.length === 0, `no page errors: ${errors.join("\n")}`);
  console.log(`\n${checks} writing checks passed. Screenshots: ${output}`);
} finally {
  await browser.close();
}
