import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { confirmAction, promptText, useDialogStore } from "./dialogStore";
import { initialFocus, primaryLabel, settleDialog } from "../components/DialogHost";
import { STRINGS } from "../lib/i18n";

afterEach(() => useDialogStore.getState().close(null));

describe("dialogStore", () => {
  it("carries a caller's primary label on prompts and confirms", () => {
    void promptText({ title: "Rename", confirmLabel: "Rename" });
    expect(useDialogStore.getState().request?.confirmLabel).toBe("Rename");
    useDialogStore.getState().close(null);
    void confirmAction({ title: "Undo?", message: "m", danger: true, confirmLabel: "Undo" });
    expect(useDialogStore.getState().request?.confirmLabel).toBe("Undo");
  });

  it("labels the primary button from the request, else by kind", () => {
    const t = STRINGS.ko;
    expect(primaryLabel({ kind: "prompt", confirmLabel: "이름 바꾸기" }, t)).toBe("이름 바꾸기");
    expect(primaryLabel({ kind: "prompt" }, t)).toBe(t.dlg_create);
    expect(primaryLabel({ kind: "confirm", danger: true }, t)).toBe(t.dlg_delete);
    expect(primaryLabel({ kind: "confirm" }, t)).toBe(t.dlg_ok);
  });

  it("opens a destructive confirm on Cancel, so Enter cannot destroy", () => {
    expect(initialFocus({ kind: "confirm", danger: true })).toBe("cancel");
    expect(initialFocus({ kind: "confirm" })).toBe("primary");
    expect(initialFocus({ kind: "prompt" })).toBe("input");
    expect(initialFocus({ kind: "pick" })).toBe("primary");
  });

  // History disables "Undo this run" and a deleted board's button unmounts in
  // the code after the await: focus restored after that finds nothing.
  it("puts focus back on the opener before the caller's code after the await runs", async () => {
    const log: string[] = [];
    const opener = { focus: () => log.push("opener focused") };
    const confirmed = confirmAction({ title: "Undo?", message: "m", danger: true }).then((ok) => {
      log.push(`caller resumes (${ok})`);
    });
    settleDialog(opener, useDialogStore.getState().close, "ok");
    await confirmed;
    expect(log).toEqual(["opener focused", "caller resumes (true)"]);
    expect(useDialogStore.getState().request).toBeNull();
  });
});

// WKWebView swallows window.prompt/confirm/alert: a call returns null/false at
// once and the action it guarded silently never happens. Every dialog goes
// through dialogStore; a native call anywhere in src fails here. The pattern
// is the member call, not `window.x(`, because a call split across lines
// (`window` on one line, the method on the next) hides from a `window\.x` grep.
describe("native dialogs", () => {
  it("are never called from app code", () => {
    const src = resolve(__dirname, "..");
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) files.push(p);
      }
    };
    walk(src);
    const hits = files.flatMap((p) =>
      readFileSync(p, "utf8")
        .split("\n")
        .flatMap((line, i) =>
          /\.(prompt|confirm|alert)\(/.test(line) ? [`${relative(src, p)}:${i + 1}`] : [],
        ),
    );
    expect(hits).toEqual([]);
  });
});
