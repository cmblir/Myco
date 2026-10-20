// Declarative plugins (block editor roadmap, stage 5): a folder under
// `<vault>/.myco/plugins/<id>/` whose `manifest.json` contributes `/` items
// and fence renderers. No plugin code runs: a manifest is data, checked
// here field by field (`manifestError`), and a fence can only name one of
// the app's own renderers (blocks FENCE_RENDERERS). A vault's plugins stay
// off until the user trusts that vault in Settings → Plugins
// (`activePlugins`); stores/pluginStore keeps the trust and on/off choices.
// Stage 6: a `/` item may instead name a `command` of the plugin's own
// `main.js`, which runs in a Web Worker (lib/pluginSandbox) and can make
// only the calls in SYSCALLS that its manifest lists as `permissions`. Such
// a plugin stays off, even in a trusted vault, until the user grants those
// calls in Settings → Plugins.

import { builtinFence, FENCE_RENDERERS, type FenceRenderer } from "./blocks";
import type { EditorView } from "@codemirror/view";
import type { SlashItem } from "./editorCompletions";
import type { Strings } from "./i18n";
import type { PluginFile } from "./ipc";
import { normalizeQuery } from "./settingsSearch";
import { fillBody, type TemplateVars } from "./templates";

export interface PluginSlash {
  /** The keyword typed after `/`, lower-cased. */
  label: string;
  /** The menu's name for it. */
  detail: string;
  /** Inserted as text (`${}` = the caret, {{date}}/{{time}}/{{title}}
   *  filled as in a template)… */
  template?: string;
  /** …or an empty ```fence of this name, the caret inside… */
  fence?: string;
  /** …or the handler main.js registered under this name, run in the
   *  plugin's worker. */
  command?: string;
}

/** The calls a plugin's worker may make of the app: the whole allowlist.
 *  No file writes, nothing outside `wiki/` (lib/pluginSandbox). */
export const SYSCALLS = [
  "editor.insertAtCursor",
  "editor.replaceSelection",
  "editor.selection",
  "vault.readPage",
  "recall",
  "search",
  "ui.notify",
] as const;
export type Syscall = (typeof SYSCALLS)[number];

export interface PluginFence {
  lang: string;
  renderer: FenceRenderer;
}

export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  /** The calls main.js may make, as the manifest asks for them. */
  permissions: Syscall[];
  contributes: { slash: PluginSlash[]; fences: PluginFence[] };
}

/** Why a plugin is not loaded: the file could not be read (list_plugins'
 *  reasons), or `field` of it is missing or malformed. */
export interface ManifestError {
  code:
    | NonNullable<PluginFile["error"]>
    | "json"
    | "field"
    | "id"
    | "renderer"
    | "slash"
    | "permission";
  field?: string;
  value?: string;
}

export interface PluginEntry {
  /** The plugin's folder name. */
  dir: string;
  manifest: PluginManifest | null;
  error: ManifestError | null;
}

/** A plain id, as its folder is named: never a path. */
const ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
/** A fence's info word: no spaces, no backticks. */
const LANG_RE = /^[A-Za-z0-9][\w.+#-]{0,31}$/;
/** A handler's name in main.js. */
const COMMAND_RE = /^[A-Za-z0-9][\w.-]{0,63}$/;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const isText = (v: unknown): v is string =>
  typeof v === "string" && v.trim() !== "";
const isLang = (v: unknown): v is string =>
  typeof v === "string" && LANG_RE.test(v);
const isRenderer = (v: unknown): v is FenceRenderer =>
  (FENCE_RENDERERS as readonly unknown[]).includes(v);
const isList = (v: unknown): v is unknown[] | undefined =>
  v === undefined || Array.isArray(v);
const isSyscall = (v: unknown): v is Syscall =>
  (SYSCALLS as readonly unknown[]).includes(v);

/** Pure: the first thing wrong with a parsed `manifest.json` found in folder
 *  `dir`, or null when it is a manifest. Keys it does not know are
 *  ignored. */
export function manifestError(v: unknown, dir: string): ManifestError | null {
  const field = (f: string): ManifestError => ({ code: "field", field: f });
  if (!isObj(v)) return { code: "json" };
  for (const k of ["id", "name", "version"]) if (!isText(v[k])) return field(k);
  if (v.id !== dir || !ID_RE.test(dir))
    return { code: "id", value: String(v.id) };
  if (!isList(v.permissions)) return field("permissions");
  for (const [i, p] of (v.permissions ?? []).entries())
    if (!isSyscall(p))
      return {
        code: "permission",
        field: `permissions[${i}]`,
        value: String(p),
      };
  const c = v.contributes;
  if (!isObj(c)) return field("contributes");
  const { slash, fences } = c;
  if (!isList(slash)) return field("contributes.slash");
  if (!isList(fences)) return field("contributes.fences");
  for (const [i, s] of (slash ?? []).entries()) {
    const at = `contributes.slash[${i}]`;
    if (!isObj(s)) return field(at);
    if (!isText(s.label)) return field(`${at}.label`);
    if (!isText(s.detail)) return field(`${at}.detail`);
    const kinds = [s.template, s.fence, s.command].filter(
      (k) => k !== undefined,
    );
    if (kinds.length !== 1) return { code: "slash", field: at };
    if (s.template !== undefined && typeof s.template !== "string")
      return field(`${at}.template`);
    if (s.fence !== undefined && !isLang(s.fence)) return field(`${at}.fence`);
    if (
      s.command !== undefined &&
      !(typeof s.command === "string" && COMMAND_RE.test(s.command))
    )
      return field(`${at}.command`);
  }
  for (const [i, f] of (fences ?? []).entries()) {
    const at = `contributes.fences[${i}]`;
    if (!isObj(f)) return field(at);
    if (!isLang(f.lang)) return field(`${at}.lang`);
    if (!isRenderer(f.renderer))
      return {
        code: "renderer",
        field: `${at}.renderer`,
        value: String(f.renderer),
      };
  }
  return null;
}

/** Pure: one listed plugin folder as a manifest, or the reason it is not
 *  one. Only the fields the app reads are kept. */
export function readPlugin(file: PluginFile): PluginEntry {
  const bad = (error: ManifestError): PluginEntry => ({
    dir: file.dir,
    manifest: null,
    error,
  });
  if (file.raw === null) return bad({ code: file.error ?? "unreadable" });
  let json: unknown;
  try {
    json = JSON.parse(file.raw);
  } catch {
    return bad({ code: "json" });
  }
  const error = manifestError(json, file.dir);
  if (error) return bad(error);
  // Checked above, field by field.
  const m = json as {
    id: string;
    name: string;
    version: string;
    permissions?: Syscall[];
    contributes: { slash?: PluginSlash[]; fences?: PluginFence[] };
  };
  return {
    dir: file.dir,
    error: null,
    manifest: {
      id: m.id,
      name: m.name.trim(),
      version: m.version.trim(),
      permissions: [...new Set(m.permissions ?? [])],
      contributes: {
        slash: (m.contributes.slash ?? []).map((s) => ({
          label: normalizeQuery(s.label),
          detail: s.detail.trim(),
          ...(s.fence !== undefined
            ? { fence: s.fence }
            : s.command !== undefined
              ? { command: s.command }
              : { template: s.template }),
        })),
        fences: (m.contributes.fences ?? []).map((f) => ({
          lang: f.lang,
          renderer: f.renderer,
        })),
      },
    },
  };
}

const ERROR_TEXT: Record<ManifestError["code"], keyof Strings> = {
  missing: "pl_err_missing",
  outside: "pl_err_outside",
  too_large: "pl_err_too_large",
  unreadable: "pl_err_unreadable",
  json: "pl_err_json",
  field: "pl_err_field",
  id: "pl_err_id",
  renderer: "pl_err_renderer",
  slash: "pl_err_slash",
  permission: "pl_err_permission",
};

/** Why a plugin is not loaded, in the UI's language. A value quoted from
 *  the manifest is clipped: it is the author's text, of any length. */
export function manifestErrorText(t: Strings, e: ManifestError): string {
  const value = e.value ?? "";
  return t[ERROR_TEXT[e.code]]
    .replace("{field}", e.field ?? "")
    .replace("{value}", value.length > 60 ? `${value.slice(0, 60)}…` : value)
    .replace("{renderers}", FENCE_RENDERERS.join(", "))
    .replace("{calls}", SYSCALLS.join(", "));
}

/** Each call's line in the permission prompt (Settings → Plugins). */
export const SYSCALL_TEXT: Record<Syscall, keyof Strings> = {
  "editor.insertAtCursor": "pl_sc_insert",
  "editor.replaceSelection": "pl_sc_replace",
  "editor.selection": "pl_sc_selection",
  "vault.readPage": "pl_sc_read",
  recall: "pl_sc_recall",
  search: "pl_sc_search",
  "ui.notify": "pl_sc_notify",
};

/** Runs code of its own: one of its `/` items is a main.js command. */
export const runsCode = (m: PluginManifest): boolean =>
  m.contributes.slash.some((s) => s.command !== undefined);

/** Pure: `m` may run as far as its calls go — it runs no code, or `grants`
 *  (a vault's, by plugin id) covers every call its manifest asks for. */
export function isGranted(
  m: PluginManifest,
  grants: Readonly<Record<string, readonly string[]>>,
): boolean {
  // Own keys only: an id like `constructor` must not find Object's. (Not
  // Object.hasOwn: macOS 10.15's Safari 14 lacks it.)
  return (
    !runsCode(m) ||
    (Object.prototype.hasOwnProperty.call(grants, m.id) &&
      m.permissions.every((p) => grants[m.id].includes(p)))
  );
}

export interface PluginPrefs {
  /** Vault paths whose plugins the user trusted. */
  trusted: readonly string[];
  /** Per vault path: the plugin ids switched off. */
  disabled: Readonly<Record<string, readonly string[]>>;
  /** Per vault path, per plugin id: the calls the user allowed its code. */
  granted?: Readonly<
    Record<string, Readonly<Record<string, readonly string[]>>>
  >;
}

/** Pure — the trust gate: the valid plugins of `vault` that are on; none
 *  until the user trusts the vault, and a plugin that runs code only while
 *  its grant covers every call its manifest asks for (a plugin updated to
 *  ask for more is off until asked again). */
export function activePlugins(
  entries: readonly PluginEntry[],
  vault: string | null,
  prefs: PluginPrefs,
): PluginManifest[] {
  if (!vault || !prefs.trusted.includes(vault)) return [];
  const off = prefs.disabled[vault] ?? [];
  const grants = prefs.granted?.[vault] ?? {};
  return entries.flatMap((e) =>
    e.manifest && !off.includes(e.manifest.id) && isGranted(e.manifest, grants)
      ? [e.manifest]
      : [],
  );
}

/** Pure: why each fence of `m` would not be drawn as its manifest says
 *  once `m` is on, the other plugins not in `off` on too — setPluginFences'
 *  rule: "builtin" = a built-in block has that name; `{ by }` = plugin `by`
 *  (folder order in `entries`; `m` itself for a name it repeats) named it
 *  first; null = drawn as `m` says. Settings shows it: nothing else tells a
 *  plugin's author why a fence does not take. */
export function fenceShadows(
  entries: readonly PluginEntry[],
  off: readonly string[],
  m: PluginManifest,
): ("builtin" | { by: string } | null)[] {
  const first = new Map<string, string>();
  for (const { manifest: p } of entries)
    if (p && (p.id === m.id || !off.includes(p.id)))
      for (const f of p.contributes.fences)
        if (!first.has(f.lang)) first.set(f.lang, p.id);
  const own = m.contributes.fences;
  return own.map((f, i) => {
    if (builtinFence(f.lang)) return "builtin";
    const by = first.get(f.lang) ?? m.id;
    const taken = by !== m.id || own.findIndex((g) => g.lang === f.lang) < i;
    return taken ? { by } : null;
  });
}

/** Runs `command` of plugin `p` for the note in `view` (lib/pluginRuntime). */
export type RunCommand = (
  p: PluginManifest,
  command: string,
  view: EditorView,
) => void;

/** Pure: the plugins' `/` items, plugin by plugin (folder order), each
 *  plugin's in manifest order. Editor lists them after the built-in items
 *  and the vault's templates, so on Enter neither is ever displaced. Each
 *  goes in as a block of its own; a command item hands the note to `run`,
 *  and without one it is left out. */
export function pluginSlashItems(
  plugins: readonly PluginManifest[],
  vars: TemplateVars,
  run?: RunCommand,
): SlashItem[] {
  return plugins.flatMap((p) =>
    p.contributes.slash.flatMap((s): SlashItem[] => {
      const base = {
        label: s.label,
        detail: s.detail,
        aliases: [],
        icon: "◇",
        section: "plugins" as const,
      };
      const { command } = s;
      if (command !== undefined)
        return run
          ? [{ ...base, template: "", run: (view) => run(p, command, view) }]
          : [];
      return [
        {
          ...base,
          ...(s.fence !== undefined
            ? {
                template: "```" + s.fence + "\n\n```",
                caret: 4 + s.fence.length,
              }
            : fillBody(s.template ?? "", vars)),
          apart: true,
        },
      ];
    }),
  );
}
