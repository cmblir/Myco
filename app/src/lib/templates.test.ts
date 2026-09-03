import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyTemplate,
  createNoteFromTemplate,
  localTime,
  starterTemplates,
  templateFiles,
  templateTargetDir,
} from "./templates";
import { getValue, parseFrontmatter } from "./frontmatter";
import { STRINGS } from "./i18n";
import { ipc } from "./ipc";
import type { FileNode } from "./ipc";
import { useVaultStore } from "../stores/vaultStore";
import { useUIStore } from "../stores/uiStore";

const VARS = { date: "2026-09-03", time: "14:07", title: "Attention" };

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

  it("returns null for a name that sanitizes to nothing", async () => {
    const read = vi.spyOn(ipc, "readFile");
    expect(await createNoteFromTemplate("/v/templates/note.md", " . ")).toBeNull();
    expect(read).not.toHaveBeenCalled();
  });
});
