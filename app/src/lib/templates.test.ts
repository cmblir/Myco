import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  EditorState,
  Transaction,
  type TransactionSpec,
} from "@codemirror/state";
import { history, undo } from "@codemirror/commands";
import {
  autocompletion,
  completionStatus,
  startCompletion,
} from "@codemirror/autocomplete";
import { keymap, type EditorView } from "@codemirror/view";
import {
  applyTemplate,
  createNoteFromTemplate,
  localTime,
  refreshSlashTemplates,
  slashTemplates,
  starterTemplates,
  templateFiles,
  templateSlashItem,
  templateTargetDir,
} from "./templates";
import { getValue, parseFrontmatter } from "./frontmatter";
import { applySlash, blockKeymap, enterTr, mycoMarkdown } from "./editorBlocks";
import { filterSlash, slashItems } from "./editorCompletions";
import { STRINGS } from "./i18n";
import { ipc } from "./ipc";
import type { FileNode } from "./ipc";
import { useVaultStore } from "../stores/vaultStore";
import { useUIStore } from "../stores/uiStore";

const VARS = { date: "2026-09-03", time: "14:07", title: "Attention" };

const MEETING =
  "---\nslash: meeting\nslash_label: 회의록\ntags: [meeting]\n---\n\n" +
  "## {{title}} — {{date}} {{time}}\n\n참석자: ${}\n\n### 결정\n- \n";

describe("templateSlashItem", () => {
  it("turns `slash:` frontmatter into a Templates item holding the filled body", () => {
    expect(templateSlashItem("회의.md", MEETING, VARS)).toEqual({
      label: "meeting",
      detail: "회의록",
      aliases: ["회의"],
      icon: "▤",
      section: "templates",
      template: "## Attention — 2026-09-03 14:07\n\n참석자: \n\n### 결정\n- ",
      caret: "## Attention — 2026-09-03 14:07\n\n참석자: ".length,
      apart: true,
    });
  });

  it("leaves a template without `slash:` (or without frontmatter) out", () => {
    expect(
      templateSlashItem("note.md", "---\ntitle: x\n---\n\nbody", VARS),
    ).toBeNull();
    expect(templateSlashItem("note.md", "# {{title}}\n", VARS)).toBeNull();
    expect(
      templateSlashItem("n.md", "---\nslash:\n---\nbody", VARS),
    ).toBeNull();
    expect(
      templateSlashItem("n.md", "---\nslash: true\n---\nbody", VARS),
    ).toBeNull();
  });

  it("names the item after the file without slash_label; slash_section groups it", () => {
    const item = templateSlashItem(
      "Weekly review.md",
      "---\nslash: Weekly\nslash_section: 루틴\n---\nbody",
      VARS,
    );
    expect(item).toMatchObject({
      label: "weekly",
      detail: "Weekly review",
      aliases: [],
      section: "templates",
      sectionName: "루틴",
    });
  });

  it("puts the caret after the body without `${}`, at the first of several", () => {
    const at = (body: string) => {
      const i = templateSlashItem("n.md", "---\nslash: n\n---\n" + body, VARS)!;
      return i.template.slice(0, i.caret) + "│" + i.template.slice(i.caret);
    };
    expect(at("\nbody\n\n")).toBe("body│");
    expect(at("a ${} b ${}\n")).toBe("a │ b ");
  });

  it("trims the body's trailing blank lines in linear time, whatever blank runs it holds", () => {
    const blanks = " \n".repeat(20000);
    const raw = `---\nslash: big\n---\n## start\n${blanks}end \n\n \t\n`;
    const t0 = performance.now();
    const item = templateSlashItem("big.md", raw, VARS)!;
    expect(performance.now() - t0).toBeLessThan(250);
    expect(item.template).toBe(`## start\n${blanks}end `);
  });

  it("is found by keyword, slash_label and file name, Korean too", () => {
    const item = templateSlashItem("회의.md", MEETING, VARS)!;
    const items = [...slashItems(STRINGS.ko), item];
    for (const q of ["meeting", "mee", "회의록", "회의", "ㅡㄷㄷ샤ㅜㅎ"])
      expect(filterSlash(items, q)[0]?.label, q).toBe("meeting");
  });
});

describe("a `slash:` template applied from the menu", () => {
  // `│` = the caret, in the input (after the `/query`) and the output.
  const apply = (src: string, raw: string, vars = VARS): string => {
    const head = src.indexOf("│");
    const doc = src.replace("│", "");
    let state = EditorState.create({
      doc,
      selection: { anchor: head },
      extensions: [mycoMarkdown(), history()],
    });
    const view = {
      get state() {
        return state;
      },
      dispatch: (t: Transaction) => {
        state = t.state;
      },
    };
    const item = templateSlashItem("t.md", raw, vars)!;
    applySlash(view, item, doc.lastIndexOf("/", head), head);
    const h = state.selection.main.head;
    const out = state.doc.sliceString(0, h) + "│" + state.doc.sliceString(h);
    undo(view);
    expect(state.doc.toString()).toBe(doc);
    return out;
  };

  it("inserts the filled body set apart from the text above, caret at `${}`", () => {
    expect(apply("Intro\n/meeting│", MEETING)).toBe(
      "Intro\n\n## Attention — 2026-09-03 14:07\n\n참석자: │\n\n### 결정\n- ",
    );
  });

  it("keeps every other brace, `${x}` and backslash of the body literal", () => {
    const raw = "---\nslash: tex\n---\n$\\{x\\}$ ${a} #{b} {c} ${}!\n";
    expect(apply("/tex│", raw)).toBe("$\\{x\\}$ ${a} #{b} {c} │!");
  });

  it("called mid-line, opens below the line, which keeps its text as typed", () => {
    expect(apply("see ${x} /meeting│ \\{y}", MEETING)).toBe(
      "see ${x} \\{y}\n\n## Attention — 2026-09-03 14:07\n\n참석자: │\n\n### 결정\n- ",
    );
  });

  it("inserts a CRLF template like an LF one: caret at `${}`, at the note's end too", () => {
    const crlf = (s: string): string => s.replace(/\n/g, "\r\n");
    expect(templateSlashItem("t.md", crlf(MEETING), VARS)!.template).not.toMatch(
      /\r/,
    );
    expect(apply("Intro\n/meeting│\n\nnext", crlf(MEETING))).toBe(
      "Intro\n\n## Attention — 2026-09-03 14:07\n\n참석자: │\n\n### 결정\n- \n\nnext",
    );
    expect(
      apply("Intro\n/crlf│", crlf("---\nslash: crlf\n---\n\n## A\n\nline two\n")),
    ).toBe("Intro\n\n## A\n\nline two│");
  });

  it("fills {{title}} with braces in it as text, not as fields", () => {
    const raw = "---\nslash: t\n---\n# {{title}}";
    expect(apply("/t│", raw, { ...VARS, title: "a ${b} {c}" })).toBe(
      "# a ${b} {c}│",
    );
  });
});

describe("refreshSlashTemplates / slashTemplates", () => {
  const file = (name: string): FileNode => ({
    kind: "file",
    name,
    path: `/v/templates/${name}`,
  });
  const tree = (...names: string[]): FileNode[] => [
    {
      kind: "directory",
      name: "templates",
      path: "/v/templates",
      children: names.map(file),
    },
  ];
  const disk = new Map<string, string>();

  beforeEach(() => {
    vi.restoreAllMocks();
    disk.clear();
    vi.spyOn(ipc, "readFile").mockImplementation(async (path: string) => {
      const raw = disk.get(path);
      if (raw === undefined) throw new Error("gone: " + path);
      return { path, raw, content: raw, frontmatter: null };
    });
  });

  it("reads the vault's templates again on every refresh", async () => {
    disk.set("/v/templates/회의.md", MEETING);
    disk.set("/v/templates/note.md", "---\ntitle: x\n---\n# {{title}}\n");
    useVaultStore.setState({ fileTree: tree("회의.md", "note.md") });
    await refreshSlashTemplates();
    const now = new Date(2026, 8, 3, 14, 7);
    expect(
      slashTemplates("Plan", now).map((i) => [i.label, i.template]),
    ).toEqual([
      ["meeting", "## Plan — 2026-09-03 14:07\n\n참석자: \n\n### 결정\n- "],
    ]);

    // An edit, a new `slash:` template, an unreadable one: all seen next time.
    disk.set(
      "/v/templates/회의.md",
      MEETING.replace("slash: meeting", "slash: mtg"),
    );
    disk.set("/v/templates/daily.md", "---\nslash: daily\n---\n{{date}}");
    useVaultStore.setState({
      fileTree: tree("회의.md", "daily.md", "lost.md"),
    });
    await refreshSlashTemplates();
    expect(slashTemplates("Plan", now).map((i) => i.label)).toEqual([
      "mtg",
      "daily",
    ]);

    useVaultStore.setState({ fileTree: [] });
    await refreshSlashTemplates();
    expect(slashTemplates("Plan", now)).toEqual([]);
  });

  it("never offers one vault's templates in another", async () => {
    const vault = (path: string, files: FileNode[]) =>
      useVaultStore.setState({
        currentVault: { path, name: path },
        fileTree: files,
      });
    const dirOf = (root: string, name: string): FileNode[] => [
      {
        kind: "directory",
        name: "templates",
        path: `${root}/templates`,
        children: [{ kind: "file", name, path: `${root}/templates/${name}` }],
      },
    ];
    disk.set("/a/templates/m.md", "---\nslash: meeting\n---\nVAULT A\n");
    disk.set("/b/templates/m.md", "---\nslash: meeting\n---\nVAULT B\n");
    vault("/a", dirOf("/a", "m.md"));
    await refreshSlashTemplates();
    expect(slashTemplates("n").map((i) => i.template)).toEqual(["VAULT A"]);

    // Switched, not read again yet: nothing rather than vault A's text.
    vault("/b", dirOf("/b", "m.md"));
    expect(slashTemplates("n")).toEqual([]);

    // A read for vault A that outlives the switch does not land over B's.
    let finish!: () => void;
    const slow = new Promise<void>((r) => (finish = r));
    vi.mocked(ipc.readFile).mockImplementationOnce(async (path: string) => {
      await slow;
      const raw = disk.get(path)!;
      return { path, raw, content: raw, frontmatter: null };
    });
    vault("/a", dirOf("/a", "m.md"));
    const late = refreshSlashTemplates();
    vault("/b", dirOf("/b", "m.md"));
    await refreshSlashTemplates();
    finish();
    await late;
    expect(slashTemplates("n").map((i) => i.template)).toEqual(["VAULT B"]);
  });

  describe("`/meeting⏎` typed before the menu has read templates/", () => {
    // The menu's query is still under way (completionStatus "pending").
    const typed = (doc: string) => {
      const view = {
        state: EditorState.create({
          doc,
          selection: { anchor: doc.length },
          extensions: [
            mycoMarkdown(),
            // A source that never answers.
            autocompletion({ override: [() => new Promise(() => undefined)] }),
            blockKeymap(
              STRINGS.en,
              undefined,
              () => slashTemplates("n"),
              refreshSlashTemplates,
            ),
          ],
        }),
        composing: false,
        // startCompletion dispatches a spec, applySlash a transaction.
        dispatch(tr: Transaction | TransactionSpec) {
          view.state =
            tr instanceof Transaction ? tr.state : view.state.update(tr).state;
        },
      };
      startCompletion(view as unknown as EditorView);
      expect(completionStatus(view.state)).toBe("pending");
      const enter = () =>
        view.state
          .facet(keymap)
          .flat()
          .some((b) => b.key === "Enter" && b.run?.(view as never));
      return { view, enter };
    };
    const body = (text: string) => `---\nslash: meeting\n---\n${text}\n`;

    beforeEach(async () => {
      useVaultStore.setState({
        currentVault: { path: "/v", name: "v" },
        fileTree: tree("m.md"),
      });
      disk.set("/v/templates/m.md", body("OLD BODY"));
      await refreshSlashTemplates();
      disk.set("/v/templates/m.md", body("NEW BODY"));
    });

    it("inserts the template as the file holds it now, not the last read", async () => {
      const { view, enter } = typed("/meeting");
      expect(enter()).toBe(true);
      await vi.waitFor(() =>
        expect(view.state.doc.toString()).toBe("NEW BODY"),
      );
    });

    it("gives the Enter back as a new line when the template is gone", async () => {
      disk.delete("/v/templates/m.md");
      const { view, enter } = typed("/meeting");
      const plain = enterTr(view.state)!.state.doc.toString();
      expect(enter()).toBe(true);
      await vi.waitFor(() => expect(view.state.doc.toString()).toBe(plain));
    });

    it("drops it once the note changed meanwhile: typing on wins", async () => {
      const { view, enter } = typed("/meeting");
      expect(enter()).toBe(true);
      view.dispatch(view.state.update({ changes: { from: 8, insert: "s" } }));
      await refreshSlashTemplates();
      await new Promise((r) => setTimeout(r, 0));
      expect(view.state.doc.toString()).toBe("/meetings");
    });
  });
});

describe("applyTemplate", () => {
  it("substitutes date, time and title, repeatedly", () => {
    expect(
      applyTemplate("{{title}} on {{date}} at {{time}} ({{title}})", VARS),
    ).toBe("Attention on 2026-09-03 at 14:07 (Attention)");
  });

  it("tolerates spaces inside the braces", () => {
    expect(applyTemplate("{{ date }}|{{  title}}", VARS)).toBe(
      "2026-09-03|Attention",
    );
  });

  it("leaves unknown placeholders and empty input untouched", () => {
    expect(applyTemplate("{{foo}} {{date}}", VARS)).toBe("{{foo}} 2026-09-03");
    expect(applyTemplate("", VARS)).toBe("");
  });
});

describe("localTime", () => {
  it("formats the local wall clock as zero-padded HH:MM", () => {
    expect(localTime(new Date(2026, 0, 1, 9, 5))).toBe("09:05");
  });
});

describe("templateFiles", () => {
  const file = (path: string): FileNode => ({
    kind: "file",
    name: path.split("/").pop() ?? "",
    path,
  });

  it("lists .md files directly under top-level templates/ only", () => {
    const tree: FileNode[] = [
      file("/v/templates.md"),
      {
        kind: "directory",
        name: "templates",
        path: "/v/templates",
        children: [
          file("/v/templates/note.md"),
          file("/v/templates/readme.txt"),
          {
            kind: "directory",
            name: "nested",
            path: "/v/templates/nested",
            children: [file("/v/templates/nested/deep.md")],
          },
        ],
      },
      {
        kind: "directory",
        name: "wiki",
        path: "/v/wiki",
        children: [
          {
            kind: "directory",
            name: "templates",
            path: "/v/wiki/templates",
            children: [file("/v/wiki/templates/x.md")],
          },
        ],
      },
    ];
    expect(templateFiles(tree).map((f) => f.path)).toEqual([
      "/v/templates/note.md",
    ]);
  });

  it("is empty without the folder, or when templates is a file", () => {
    expect(templateFiles([])).toEqual([]);
    expect(templateFiles([file("/v/templates")])).toEqual([]);
  });
});

describe("templateTargetDir", () => {
  it("redirects raw/ and its subfolders to the default (wiki/)", () => {
    expect(templateTargetDir("/v", "/v/raw/x")).toBeUndefined();
    expect(templateTargetDir("/v", "/v/raw")).toBeUndefined();
  });

  it("keeps any other folder and passes undefined through", () => {
    expect(templateTargetDir("/v", "/v/wiki/a")).toBe("/v/wiki/a");
    expect(templateTargetDir("/v", "/v/rawer")).toBe("/v/rawer");
    expect(templateTargetDir("/v", undefined)).toBeUndefined();
  });
});

describe("starterTemplates", () => {
  it.each(["en", "ko", "ja"] as const)(
    "%s: two .md starters whose filled frontmatter parses",
    (lang) => {
      const starters = starterTemplates(STRINGS[lang]);
      expect(starters).toHaveLength(2);
      for (const s of starters) {
        expect(s.name.endsWith(".md")).toBe(true);
        expect(s.content).toContain("{{title}}");
        expect(s.content).toContain("{{date}}");
        const filled = applyTemplate(s.content, VARS);
        expect(filled).not.toContain("{{");
        const fm = parseFrontmatter(filled);
        expect(getValue(fm, "title")).toBe(VARS.title);
        expect(getValue(fm, "status")).toBe("active");
      }
    },
  );
});

describe("createNoteFromTemplate", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    useVaultStore.setState({
      currentVault: { path: "/v", name: "v" },
      fileTree: [],
      adjacency: null,
      error: null,
    });
    useUIStore.setState({ route: "overview" });
    vi.spyOn(ipc, "buildLinkGraph").mockResolvedValue({
      forward: {},
      backward: {},
      unresolved: {},
      tags: {},
    } as never);
    vi.spyOn(ipc, "listFiles").mockResolvedValue([] as never);
    vi.spyOn(ipc, "createFolder").mockResolvedValue("/v/wiki" as never);
  });

  it("creates the stub, overwrites it with the filled template, routes", async () => {
    vi.spyOn(ipc, "readFile").mockResolvedValue({
      raw: "# {{title}}\n",
    } as never);
    vi.spyOn(ipc, "createFile").mockResolvedValue("/v/wiki/Attention.md");
    const write = vi.spyOn(ipc, "writeFile").mockResolvedValue(null);
    const p = await createNoteFromTemplate("/v/templates/note.md", "Attention");
    expect(p).toBe("/v/wiki/Attention.md");
    expect(write).toHaveBeenCalledWith("/v/wiki/Attention.md", "# Attention\n");
    expect(useUIStore.getState().route).toBe("page:/v/wiki/Attention.md");
  });

  it("drops a `slash:` template's menu keys and `${}` markers from the note", async () => {
    vi.spyOn(ipc, "createFile").mockResolvedValue("/v/wiki/Plan.md");
    const write = vi.spyOn(ipc, "writeFile").mockResolvedValue(null);
    const read = vi.spyOn(ipc, "readFile");
    read.mockResolvedValue({ raw: MEETING } as never);
    await createNoteFromTemplate("/v/templates/회의.md", "Plan");
    expect(write.mock.calls[0][1]).toMatch(
      /^---\ntags: \[meeting\]\n---\n\n## Plan — .*\n\n참석자: \n\n### 결정\n- \n$/,
    );
    // Only menu keys in its frontmatter: the note starts at its body.
    read.mockResolvedValue({
      raw: "---\nslash: x\nslash_label: X\nslash_section: S\n---\n\n# {{title}} ${}\n",
    } as never);
    useVaultStore.setState({ fileTree: [] });
    await createNoteFromTemplate("/v/templates/x.md", "Plan");
    expect(write.mock.calls[1][1]).toBe("# Plan \n");
    // Any other template is copied as it is, `${}` included.
    read.mockResolvedValue({ raw: "# {{title}} ${}\n" } as never);
    await createNoteFromTemplate("/v/templates/note.md", "Plan");
    expect(write.mock.calls[2][1]).toBe("# Plan ${}\n");
  });

  it("opens an existing stem without applying the template", async () => {
    useVaultStore.setState({
      fileTree: [
        { kind: "file", name: "attention.md", path: "/v/wiki/attention.md" },
      ],
    });
    const read = vi.spyOn(ipc, "readFile");
    const write = vi.spyOn(ipc, "writeFile");
    const p = await createNoteFromTemplate("/v/templates/note.md", "Attention");
    expect(p).toBe("/v/wiki/attention.md");
    expect(read).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
    expect(useUIStore.getState().route).toBe("page:/v/wiki/attention.md");
  });

  it("does not treat templates/<stem>.md as an existing note", async () => {
    useVaultStore.setState({
      fileTree: [
        {
          kind: "directory",
          name: "templates",
          path: "/v/templates",
          children: [
            { kind: "file", name: "note.md", path: "/v/templates/note.md" },
          ],
        },
      ],
    });
    vi.spyOn(ipc, "readFile").mockResolvedValue({
      raw: "# {{title}}\n",
    } as never);
    vi.spyOn(ipc, "createFile").mockResolvedValue("/v/wiki/note.md");
    const write = vi.spyOn(ipc, "writeFile").mockResolvedValue(null);
    const p = await createNoteFromTemplate("/v/templates/note.md", "note");
    expect(p).toBe("/v/wiki/note.md");
    expect(write).toHaveBeenCalledWith("/v/wiki/note.md", "# note\n");
  });

  // UX backlog S15: the template row beside "New note" in ⌘K lands its note
  // where ⌘N would — beside the open note, wiki/ from a managed folder.
  it("creates beside the open note, or in wiki/ from a folder myco manages", async () => {
    vi.spyOn(ipc, "readFile").mockResolvedValue({ raw: "# {{title}}\n" } as never);
    vi.spyOn(ipc, "writeFile").mockResolvedValue(null);
    const create = vi.spyOn(ipc, "createFile").mockResolvedValue("/v/daily/Plan.md");
    useUIStore.setState({ route: "page:/v/daily/x.md" });
    await createNoteFromTemplate("/v/templates/note.md", "Plan");
    expect(create).toHaveBeenLastCalledWith("/v/daily", "Plan.md");
    create.mockResolvedValue("/v/wiki/Deck.md");
    useUIStore.setState({ route: "page:/v/cards/x.md" });
    await createNoteFromTemplate("/v/templates/note.md", "Deck");
    expect(create).toHaveBeenLastCalledWith("/v/wiki", "Deck.md");
  });

  it("returns null for a name that sanitizes to nothing", async () => {
    const read = vi.spyOn(ipc, "readFile");
    expect(await createNoteFromTemplate("/v/templates/note.md", " . ")).toBeNull();
    expect(read).not.toHaveBeenCalled();
  });
});
