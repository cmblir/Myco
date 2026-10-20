import { afterEach, describe, expect, it } from "vitest";
import {
  activePlugins,
  fenceShadows,
  manifestError,
  manifestErrorText,
  pluginSlashItems,
  readPlugin,
  runsCode,
  SYSCALLS,
  type PluginEntry,
  type PluginManifest,
} from "./plugins";
import {
  filterSlash,
  slashItems,
  slashSectionRank,
  SLASH_SECTIONS,
} from "./editorCompletions";
import { templateSlashItem } from "./templates";
import { fenceBlock, setPluginFences } from "./blocks";
import { MERMAID } from "./blocks/mermaid";
import { STRINGS } from "./i18n";

const VARS = { date: "2026-09-30", time: "09:05", title: "Standup" };

const KIT = {
  id: "meeting-kit",
  name: "회의 키트",
  version: "1.0.0",
  contributes: {
    slash: [
      { label: "Agenda", detail: "회의 안건", template: "## {{date}}\n- ${}" },
      { label: "graph", detail: "그래프", fence: "graph" },
    ],
    fences: [
      { lang: "graph", renderer: "builtin:mermaid" },
      { lang: "dataview", renderer: "builtin:code" },
    ],
  },
};

const file = (dir: string, manifest: unknown) => ({
  dir,
  raw: JSON.stringify(manifest),
  error: null,
});

/** KIT with one path set to `value` (undefined deletes it). */
function withField(path: (string | number)[], value: unknown): unknown {
  const copy = JSON.parse(JSON.stringify(KIT));
  let at = copy;
  for (const k of path.slice(0, -1)) at = at[k];
  const last = path[path.length - 1];
  if (value === undefined) delete at[last];
  else at[last] = value;
  return copy;
}

describe("manifestError (the guard)", () => {
  it("accepts a full manifest, one with only fences, and unknown keys", () => {
    expect(manifestError(KIT, "meeting-kit")).toBeNull();
    expect(
      manifestError(
        { id: "x", name: "X", version: "1", contributes: { fences: [] } },
        "x",
      ),
    ).toBeNull();
    expect(
      manifestError({ ...KIT, author: "someone", $schema: "…" }, "meeting-kit"),
    ).toBeNull();
  });

  it.each([
    [["id"], undefined, { code: "field", field: "id" }],
    [["name"], "  ", { code: "field", field: "name" }],
    [["version"], 1, { code: "field", field: "version" }],
    [["contributes"], undefined, { code: "field", field: "contributes" }],
    [
      ["contributes", "slash"],
      {},
      { code: "field", field: "contributes.slash" },
    ],
    [
      ["contributes", "slash", 0, "label"],
      "",
      { code: "field", field: "contributes.slash[0].label" },
    ],
    [
      ["contributes", "slash", 1, "detail"],
      undefined,
      { code: "field", field: "contributes.slash[1].detail" },
    ],
    [
      ["contributes", "slash", 0, "fence"],
      "graph",
      { code: "slash", field: "contributes.slash[0]" },
    ],
    [
      ["contributes", "slash", 1, "fence"],
      undefined,
      { code: "slash", field: "contributes.slash[1]" },
    ],
    [
      ["contributes", "slash", 1, "fence"],
      "two words",
      { code: "field", field: "contributes.slash[1].fence" },
    ],
    [
      ["contributes", "fences", 0, "lang"],
      "```",
      { code: "field", field: "contributes.fences[0].lang" },
    ],
    [
      ["contributes", "fences", 1, "renderer"],
      "builtin:iframe",
      {
        code: "renderer",
        field: "contributes.fences[1].renderer",
        value: "builtin:iframe",
      },
    ],
    [
      ["contributes", "fences", 1, "renderer"],
      "./main.js",
      {
        code: "renderer",
        field: "contributes.fences[1].renderer",
        value: "./main.js",
      },
    ],
  ])("rejects %j = %j", (path, value, error) => {
    expect(manifestError(withField(path, value), "meeting-kit")).toEqual(error);
  });

  it("rejects an id that is not its folder's name, or not a plain name", () => {
    expect(manifestError(KIT, "other")).toEqual({
      code: "id",
      value: "meeting-kit",
    });
    const bad = { ...KIT, id: "../raw" };
    expect(manifestError(bad, "../raw")).toEqual({
      code: "id",
      value: "../raw",
    });
  });

  it("rejects a manifest that is not an object", () => {
    for (const v of [null, [], "x", 3])
      expect(manifestError(v, "x")).toEqual({ code: "json" });
  });
});

describe("readPlugin", () => {
  it("keeps a valid manifest, keyword lower-cased, arrays defaulted", () => {
    const e = readPlugin(file("meeting-kit", KIT));
    expect(e.error).toBeNull();
    expect(e.manifest?.contributes.slash[0].label).toBe("agenda");
    const bare = readPlugin(
      file("x", { id: "x", name: "X", version: "1", contributes: {} }),
    );
    expect(bare.manifest?.contributes).toEqual({ slash: [], fences: [] });
  });

  it("names why a plugin is invalid: unread file, bad JSON, bad field", () => {
    expect(readPlugin({ dir: "a", raw: null, error: "outside" }).error).toEqual(
      { code: "outside" },
    );
    expect(readPlugin({ dir: "a", raw: "{ nope", error: null })).toEqual({
      dir: "a",
      manifest: null,
      error: { code: "json" },
    });
    expect(readPlugin(file("a", { id: "a" })).error).toEqual({
      code: "field",
      field: "name",
    });
  });
});

describe("activePlugins (the trust gate)", () => {
  const entries: PluginEntry[] = [
    readPlugin(file("meeting-kit", KIT)),
    readPlugin(file("broken", { id: "broken" })),
    readPlugin(
      file("second", {
        id: "second",
        name: "2",
        version: "1",
        contributes: {},
      }),
    ),
  ];
  const ids = (ps: PluginManifest[]) => ps.map((p) => p.id);

  it("gives nothing until this vault is trusted", () => {
    expect(activePlugins(entries, "/v", { trusted: [], disabled: {} })).toEqual(
      [],
    );
    expect(
      activePlugins(entries, "/v", { trusted: ["/other"], disabled: {} }),
    ).toEqual([]);
    expect(
      activePlugins(entries, null, { trusted: ["/v"], disabled: {} }),
    ).toEqual([]);
  });

  it("trusted: every valid plugin not switched off in this vault", () => {
    const trusted = ["/v"];
    expect(
      ids(activePlugins(entries, "/v", { trusted, disabled: {} })),
    ).toEqual(["meeting-kit", "second"]);
    expect(
      ids(
        activePlugins(entries, "/v", {
          trusted,
          disabled: { "/v": ["meeting-kit"], "/other": ["second"] },
        }),
      ),
    ).toEqual(["second"]);
  });
});

describe("plugin slash items", () => {
  const kit = readPlugin(file("meeting-kit", KIT)).manifest!;

  it("a template item fills {{date}} and lands the caret at `${}`; a fence item opens the fence", () => {
    const [agenda, graph] = pluginSlashItems([kit], VARS);
    expect(agenda).toMatchObject({
      label: "agenda",
      detail: "회의 안건",
      section: "plugins",
      template: "## 2026-09-30\n- ",
      caret: "## 2026-09-30\n- ".length,
      apart: true,
    });
    expect(graph).toMatchObject({
      label: "graph",
      template: "```graph\n\n```",
      caret: "```graph\n".length,
      apart: true,
    });
  });

  it("merge order: built-ins, then templates, then plugins (by folder, manifest order)", () => {
    const code = {
      id: "z-code",
      name: "Z",
      version: "1",
      contributes: {
        slash: [
          { label: "code", detail: "Plugin code", template: "x" },
          { label: "agenda", detail: "Z agenda", template: "z" },
        ],
      },
    };
    const plugins = [kit, readPlugin(file("z-code", code)).manifest!];
    const template = templateSlashItem(
      "안건.md",
      "---\nslash: agenda\n---\nfrom a template",
      VARS,
    )!;
    const menu = [
      ...slashItems(STRINGS.en),
      template,
      ...pluginSlashItems(plugins, VARS),
    ];
    // Enter takes the first match: a plugin never displaces a built-in or
    // a vault template of the same keyword.
    expect(filterSlash(menu, "code")[0].detail).toBe("Code block");
    expect(filterSlash(menu, "agenda").map((i) => i.detail)).toEqual([
      "안건",
      "회의 안건",
      "Z agenda",
    ]);
    // Browsing: the Plugins section is the menu's last.
    expect(SLASH_SECTIONS[SLASH_SECTIONS.length - 1]).toBe("plugins");
  });

  it("browsing: a template's own slash_section sorts after Templates, before Plugins", () => {
    const template = (fm: string) =>
      templateSlashItem("t.md", `---\n${fm}\n---\nbody`, VARS)!;
    const ranks = [
      template("slash: plain"),
      template("slash: weekly\nslash_section: 루틴"),
      pluginSlashItems([kit], VARS)[0],
    ].map(slashSectionRank);
    expect(ranks[0]).toBeLessThan(ranks[1]);
    expect(ranks[1]).toBeLessThan(ranks[2]);
  });
});

describe("fenceShadows", () => {
  const kit = readPlugin(file("meeting-kit", KIT));
  const toc = readPlugin(
    file("toc-kit", {
      id: "toc-kit",
      name: "TOC kit",
      version: "1",
      contributes: {
        fences: [
          { lang: "toc", renderer: "builtin:code" },
          { lang: "graph", renderer: "builtin:code" },
          { lang: "tl", renderer: "builtin:code" },
          { lang: "tl", renderer: "builtin:mermaid" },
        ],
      },
    }),
  );
  const entries = [kit, toc];
  const tocKit = toc.manifest!;
  afterEach(() => setPluginFences([]));

  it("names who draws each fence the way the block registry does", () => {
    setPluginFences(entries.flatMap((e) => e.manifest!.contributes.fences));
    expect(fenceShadows(entries, [], tocKit)).toEqual([
      "builtin",
      { by: "meeting-kit" },
      null,
      { by: "toc-kit" },
    ]);
    expect(fenceShadows(entries, [], kit.manifest!)).toEqual([null, null]);
    // What fenceBlock draws: the built-in TOC, meeting-kit's ```graph (its
    // builtin:mermaid renderer), toc-kit's first ```tl (code).
    expect(fenceBlock("toc")?.id).toBe("toc");
    expect(fenceBlock("graph")).toBe(MERMAID);
    expect(fenceBlock("tl")).toBeUndefined();
  });

  it("judges a plugin as if it were on, the others as they are", () => {
    expect(fenceShadows(entries, ["meeting-kit"], tocKit)[1]).toBeNull();
    expect(fenceShadows(entries, ["toc-kit"], tocKit)[1]).toEqual({
      by: "meeting-kit",
    });
  });
});

describe("manifestErrorText", () => {
  it("says what is wrong in the UI's language, field and value filled", () => {
    expect(
      manifestErrorText(STRINGS.ko, {
        code: "renderer",
        field: "contributes.fences[0].renderer",
        value: "builtin:iframe",
      }),
    ).toBe(
      STRINGS.ko.pl_err_renderer
        .replace("{field}", "contributes.fences[0].renderer")
        .replace("{value}", "builtin:iframe")
        .replace(
          "{renderers}",
          "builtin:code, builtin:chart, builtin:mermaid, builtin:query",
        ),
    );
    for (const code of [
      "missing",
      "outside",
      "too_large",
      "unreadable",
      "json",
      "field",
      "id",
      "renderer",
      "slash",
    ] as const)
      for (const t of [STRINGS.en, STRINGS.ko, STRINGS.ja])
        expect(
          manifestErrorText(t, { code, field: "f", value: "v" }),
        ).not.toMatch(/\{\w+\}/);
  });

  it("clips a long value from the manifest", () => {
    const text = manifestErrorText(STRINGS.en, {
      code: "id",
      value: "x".repeat(500),
    });
    expect(text.length).toBeLessThan(200);
  });
});

// Stage 6: a plugin whose `/` item names a `command` runs main.js in a
// worker (lib/pluginSandbox); it lists the calls it needs as `permissions`.
const WC = {
  id: "word-count",
  name: "단어 수",
  version: "1.0.0",
  permissions: ["editor.selection", "editor.insertAtCursor"],
  contributes: {
    slash: [{ label: "WordCount", detail: "단어 수 세기", command: "count" }],
  },
};

describe("code plugins: permissions and command items", () => {
  const wcWith = (path: (string | number)[], value: unknown): unknown => {
    const copy = JSON.parse(JSON.stringify(WC));
    let at = copy;
    for (const k of path.slice(0, -1)) at = at[k];
    const last = path[path.length - 1];
    if (value === undefined) delete at[last];
    else at[last] = value;
    return copy;
  };

  it("keeps a command item and the calls it asks for", () => {
    const e = readPlugin(file("word-count", WC));
    expect(e.error).toBeNull();
    expect(e.manifest?.permissions).toEqual([
      "editor.selection",
      "editor.insertAtCursor",
    ]);
    expect(e.manifest?.contributes.slash).toEqual([
      { label: "wordcount", detail: "단어 수 세기", command: "count" },
    ]);
    expect(runsCode(e.manifest!)).toBe(true);
  });

  it("a declarative plugin asks for nothing and runs no code", () => {
    const kit = readPlugin(file("meeting-kit", KIT)).manifest!;
    expect(kit.permissions).toEqual([]);
    expect(runsCode(kit)).toBe(false);
  });

  it("the allowlist is exactly the seven calls", () => {
    expect(SYSCALLS).toEqual([
      "editor.insertAtCursor",
      "editor.replaceSelection",
      "editor.selection",
      "vault.readPage",
      "recall",
      "search",
      "ui.notify",
    ]);
  });

  it.each([
    [
      ["permissions"],
      "editor.selection",
      { code: "field", field: "permissions" },
    ],
    [
      ["permissions", 1],
      "vault.writeFile",
      { code: "permission", field: "permissions[1]", value: "vault.writeFile" },
    ],
    [
      ["permissions", 0],
      "__TAURI_INTERNALS__.invoke",
      {
        code: "permission",
        field: "permissions[0]",
        value: "__TAURI_INTERNALS__.invoke",
      },
    ],
    [
      ["contributes", "slash", 0, "command"],
      "two words",
      { code: "field", field: "contributes.slash[0].command" },
    ],
    [
      ["contributes", "slash", 0, "template"],
      "x",
      { code: "slash", field: "contributes.slash[0]" },
    ],
  ])("rejects %j = %j", (path, value, error) => {
    expect(manifestError(wcWith(path, value), "word-count")).toEqual(error);
  });

  it("says which calls exist when a permission is not one", () => {
    const text = manifestErrorText(STRINGS.en, {
      code: "permission",
      field: "permissions[1]",
      value: "vault.writeFile",
    });
    expect(text).toContain("vault.writeFile");
    expect(text).toContain(SYSCALLS.join(", "));
    for (const t of [STRINGS.en, STRINGS.ko, STRINGS.ja])
      expect(
        manifestErrorText(t, { code: "permission", field: "f", value: "v" }),
      ).not.toMatch(/\{\w+\}/);
  });
});

describe("activePlugins (the permission gate)", () => {
  const entries: PluginEntry[] = [
    readPlugin(file("meeting-kit", KIT)),
    readPlugin(file("word-count", WC)),
  ];
  const ids = (ps: PluginManifest[]) => ps.map((p) => p.id);
  const trusted = ["/v"];

  it("a code plugin stays off in a trusted vault until its calls are granted", () => {
    expect(
      ids(activePlugins(entries, "/v", { trusted, disabled: {} })),
    ).toEqual(["meeting-kit"]);
    const granted = {
      "/v": { "word-count": ["editor.insertAtCursor", "editor.selection"] },
    };
    expect(
      ids(activePlugins(entries, "/v", { trusted, disabled: {}, granted })),
    ).toEqual(["meeting-kit", "word-count"]);
    // A grant in another vault, or none at all, is not this one.
    expect(
      ids(
        activePlugins(entries, "/v", {
          trusted,
          disabled: {},
          granted: { "/other": granted["/v"] },
        }),
      ),
    ).toEqual(["meeting-kit"]);
    // Trust still comes first.
    expect(
      activePlugins(entries, "/v", { trusted: [], disabled: {}, granted }),
    ).toEqual([]);
  });

  it("a plugin named like an Object key has no grant of Object's", () => {
    const ctor = readPlugin(file("constructor", { ...WC, id: "constructor" }));
    expect(ctor.error).toBeNull();
    expect(
      activePlugins([ctor], "/v", {
        trusted,
        disabled: {},
        granted: { "/v": {} },
      }),
    ).toEqual([]);
  });

  it("a grant that no longer covers what the manifest asks leaves it off", () => {
    const granted = { "/v": { "word-count": ["editor.selection"] } };
    expect(
      ids(activePlugins(entries, "/v", { trusted, disabled: {}, granted })),
    ).toEqual(["meeting-kit"]);
  });
});

describe("plugin command items", () => {
  const wc = readPlugin(file("word-count", WC)).manifest!;

  it("run the plugin's handler with the view they were picked in", () => {
    const calls: unknown[] = [];
    const items = pluginSlashItems([wc], VARS, (p, command, view) =>
      calls.push([p.id, command, view]),
    );
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      label: "wordcount",
      detail: "단어 수 세기",
      section: "plugins",
    });
    items[0].run?.("the view" as never);
    expect(calls).toEqual([["word-count", "count", "the view"]]);
  });

  it("are left out where nothing can run them", () => {
    expect(pluginSlashItems([wc], VARS)).toEqual([]);
  });
});
