import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

test("Windows-style checkout preserves the exact pinned Qwen3 template bytes", () => {
  const repository = fileURLToPath(new URL("../../", import.meta.url));
  const fixture = "app/src-tauri/src/local_llm/fixtures/qwen3-chat-template.jinja";
  const scratch = mkdtempSync(join(tmpdir(), "myco-template-checkout-"));
  try {
    const emptyConfig = join(scratch, "empty-config");
    writeFileSync(emptyConfig, "");
    const git = (...args) => execFileSync("git", ["-c", `core.attributesFile=${emptyConfig}`, ...args], {
      cwd: scratch,
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: emptyConfig },
      stdio: "pipe",
    });
    git("init");
    mkdirSync(dirname(join(scratch, fixture)), { recursive: true });
    copyFileSync(join(repository, fixture), join(scratch, fixture));
    copyFileSync(join(repository, ".gitattributes"), join(scratch, ".gitattributes"));
    git("-c", "core.autocrlf=false", "add", "--", fixture, ".gitattributes");
    unlinkSync(join(scratch, fixture));
    git("-c", "core.autocrlf=true", "-c", "core.eol=crlf", "checkout-index", "--", fixture);
    const checkedOut = readFileSync(join(scratch, fixture));
    assert.equal(checkedOut.length, 4116);
    assert.equal(createHash("sha256").update(checkedOut).digest("hex"),
      "87a2728cb8dc9fe424d624542f6060ec05a1d285ebbec578bb078900e33396b5");
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
