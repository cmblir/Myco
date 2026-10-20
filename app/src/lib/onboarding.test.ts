import { afterEach, describe, expect, it, vi } from "vitest";
import {
  WIZARD_STEPS,
  dismissHomeGuide,
  escapeSkips,
  firstNoteDraft,
  homeGuideOffered,
  keepWizardOpen,
  offerHomeGuide,
  subscribeHomeGuide,
  wizardPrimary,
  wizardStepReady,
  writeFirstNote,
  type FirstNote,
  type NoteIo,
} from "./onboarding";
import { STRINGS } from "./i18n";

afterEach(() => vi.unstubAllGlobals());

// S18: choose a folder, write or load a first note, ask one question about it.
it("has three steps", () => {
  expect(WIZARD_STEPS).toBe(3);
});

describe("wizardStepReady", () => {
  it("step 0 gates on a linked vault", () => {
    expect(wizardStepReady(0, "idle", false)).toBe(false);
    expect(wizardStepReady(0, "idle", true)).toBe(true);
  });

  it("step 1 can always be left — an empty note box goes on without a note", () => {
    expect(wizardStepReady(1, "idle", true)).toBe(true);
    expect(wizardStepReady(1, "indexing", true)).toBe(true);
  });

  it("step 2 holds the question while the index builds", () => {
    expect(wizardStepReady(2, "loading-model", true)).toBe(false);
    expect(wizardStepReady(2, "indexing", true)).toBe(false);
  });

  it("step 2 unlocks on done, on idle and on error — a failed build never traps", () => {
    expect(wizardStepReady(2, "done", true)).toBe(true);
    expect(wizardStepReady(2, "idle", true)).toBe(true);
    expect(wizardStepReady(2, "error", true)).toBe(true);
  });
});

// One primary per step: the step's own action until it is done, then Next.
describe("wizardPrimary", () => {
  it("step 0 leads with Choose a folder until one is linked, then Next", () => {
    expect(wizardPrimary(0, false)).toBe("action");
    expect(wizardPrimary(0, true)).toBe("next");
  });

  it("step 1 leads with Next, which saves the note", () => {
    expect(wizardPrimary(1, true)).toBe("next");
  });

  it("the last step leads with Ask it; Done stays secondary", () => {
    expect(wizardPrimary(2, true)).toBe("action");
  });
});

describe("firstNoteDraft", () => {
  it("is null for an empty box, so Next goes on without a note", () => {
    expect(firstNoteDraft("", null, "First note")).toBeNull();
    expect(firstNoteDraft("  \n\t ", null, "First note")).toBeNull();
  });

  it("titles a typed note with its first line and keeps the rest as the body", () => {
    expect(firstNoteDraft("Rust ownership\nA value has one owner.\n", null, "x")).toEqual({
      title: "Rust ownership",
      body: "A value has one owner.",
    });
  });

  it("drops a heading marker from the first line", () => {
    expect(firstNoteDraft("# 회의 메모\n내용", null, "x")).toEqual({
      title: "회의 메모",
      body: "내용",
    });
  });

  it("keeps a long first line whole in the body and titles the note with its start", () => {
    const line = "오늘 읽은 글에서 가장 기억에 남는 건 작은 습관이 쌓이면 일 년 뒤에는 완전히 다른 사람이 된다는 이야기였다";
    const draft = firstNoteDraft(line, null, "x");
    expect(draft?.body).toBe(line);
    expect(draft!.title.length).toBeLessThanOrEqual(40);
    expect(line.startsWith(draft!.title)).toBe(true);
  });

  it("titles a loaded file with its name, extension dropped, and keeps all its text", () => {
    expect(firstNoteDraft("Line one\nLine two", "Reading list.pdf", "x")).toEqual({
      title: "Reading list",
      body: "Line one\nLine two",
    });
  });

  it("never yields a file name that escapes wiki/ or hides itself", () => {
    expect(firstNoteDraft("a/b\nbody", null, "x")?.title).toBe("a-b");
    expect(firstNoteDraft("...\nbody", null, "First note")?.title).toBe("First note");
  });
});

// Back from the question step and Next again rewrites the note step 2 made.
// The first line is its title: an edited one must rename the note and its
// heading, not vanish between the file name and the body.
describe("writeFirstNote", () => {
  function fakeVault() {
    const disk = new Map<string, string>();
    const calls: string[] = [];
    const io: NoteIo = {
      createFile: (parent, name) => {
        const path = `${parent}/${name}`;
        calls.push(`create_file ${path}`);
        // create_file's stub: frontmatter, then the stem as the heading.
        disk.set(path, `---\ntype: concept\n---\n\n# ${name.replace(/\.md$/, "")}\n`);
        return Promise.resolve(path);
      },
      readFile: (path) => Promise.resolve({ raw: disk.get(path) ?? "" }),
      writeFile: (path, content) => {
        calls.push(`write_file ${path}`);
        disk.set(path, content);
        return Promise.resolve(null);
      },
      renamePath: (from, toName) => {
        const to = `${from.slice(0, from.lastIndexOf("/"))}/${toName}`;
        calls.push(`rename_path ${from} -> ${to}`);
        disk.set(to, disk.get(from) ?? "");
        disk.delete(from);
        return Promise.resolve(to);
      },
    };
    return { disk, calls, io };
  }
  const save = (io: NoteIo, text: string, saved: FirstNote | null) =>
    writeFirstNote(io, "/v/wiki", firstNoteDraft(text, null, "First note")!, saved, text);

  it("renames and retitles the note when the first line changed", async () => {
    const { disk, calls, io } = fakeVault();
    const first = await save(io, "Alpha\nbody one", null);
    const second = await save(io, "Beta renamed\nbody two", first);
    expect(calls).toEqual([
      "create_file /v/wiki/Alpha.md",
      "write_file /v/wiki/Alpha.md",
      "rename_path /v/wiki/Alpha.md -> /v/wiki/Beta renamed.md",
      "write_file /v/wiki/Beta renamed.md",
    ]);
    expect(second).toMatchObject({ path: "/v/wiki/Beta renamed.md", title: "Beta renamed" });
    expect(disk.get(second.path)).toBe("---\ntype: concept\n---\n\n# Beta renamed\n\nbody two\n");
    // The question step names the note by the saved title.
    expect(STRINGS.ko.ob_first_question_note.replace("{title}", second.title)).toContain("Beta renamed");
  });

  it("rewrites the same note in place when only the body changed", async () => {
    const { disk, calls, io } = fakeVault();
    const first = await save(io, "Alpha\nbody one", null);
    const second = await save(io, "Alpha\nbody two", first);
    expect(calls.filter((c) => c.startsWith("rename_path"))).toEqual([]);
    expect(disk.get(second.path)).toContain("# Alpha\n\nbody two\n");
  });
});

// Escape is Skip, but a stray one must not throw away the first note a new
// user is typing: on the note step it waits until the box is saved or empty.
describe("escapeSkips", () => {
  it("skips, except on the note step while its box holds unsaved text", () => {
    expect(escapeSkips(0, "", null)).toBe(true);
    expect(escapeSkips(1, " \n ", null)).toBe(true);
    expect(escapeSkips(1, "Alpha\nbody", null)).toBe(false);
    expect(escapeSkips(1, "Alpha\nbody", "Alpha\nbody")).toBe(true);
    expect(escapeSkips(1, "Alpha\nbody 2", "Alpha\nbody")).toBe(false);
    expect(escapeSkips(2, "Alpha\nbody", "Alpha\nbody")).toBe(true);
  });
});

// Step 1's title says folder and its buttons say vault: the body names the
// folder a vault once, so the first screen calls one thing by one name.
it("introduces the vault word in step 1's body before its buttons use it", () => {
  const word = { en: /vault/i, ko: /볼트/, ja: /ボールト/ };
  for (const lang of ["en", "ko", "ja"] as const) {
    expect(STRINGS[lang].ob_demo_start).toMatch(word[lang]);
    expect(STRINGS[lang].ob_vault_none).toMatch(word[lang]);
    expect(STRINGS[lang].ob_s1_body).toMatch(word[lang]);
  }
});

// The first-run check reads "no pages yet": the first note the wizard writes
// makes that false, which used to unmount the wizard before its last step.
describe("keepWizardOpen", () => {
  it("opens on a first run", () => {
    expect(keepWizardOpen(false, true, false)).toBe(true);
  });

  it("stays open once shown, after the vault gains a page", () => {
    expect(keepWizardOpen(true, false, false)).toBe(true);
  });

  it("closes for good once onboarded", () => {
    expect(keepWizardOpen(true, true, true)).toBe(false);
  });

  it("never opens for a vault that already has notes", () => {
    expect(keepWizardOpen(false, false, false)).toBe(false);
  });
});

// Session import and history left the wizard for a Home card, shown to a
// person who just finished onboarding and gone once they dismiss it.
describe("home guide", () => {
  function storage(): Map<string, string> {
    const m = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => m.get(k) ?? null,
      setItem: (k: string, v: string) => void m.set(k, v),
    });
    return m;
  }

  it("is not offered to someone who never ran the wizard", () => {
    storage();
    expect(homeGuideOffered()).toBe(false);
  });

  it("is offered after onboarding and gone after dismiss", () => {
    storage();
    offerHomeGuide();
    expect(homeGuideOffered()).toBe(true);
    dismissHomeGuide();
    expect(homeGuideOffered()).toBe(false);
    // A later wizard close (a second first run) does not bring it back.
    offerHomeGuide();
    expect(homeGuideOffered()).toBe(false);
  });

  // Home is already on screen behind the wizard, so the card has to hear the
  // offer rather than read it once at mount.
  it("tells subscribers when it is offered or dismissed, until they unsubscribe", () => {
    storage();
    let calls = 0;
    const off = subscribeHomeGuide(() => calls++);
    offerHomeGuide();
    dismissHomeGuide();
    expect(calls).toBe(2);
    off();
    offerHomeGuide();
    expect(calls).toBe(2);
  });

  it("reads as not offered when storage throws", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
    });
    expect(() => offerHomeGuide()).not.toThrow();
    expect(homeGuideOffered()).toBe(false);
  });
});
