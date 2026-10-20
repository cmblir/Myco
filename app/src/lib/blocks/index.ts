// The block registry: every syntax that draws as a block of its own, in one
// list, so Live (one StateField of widgets, ./live.ts) and Preview
// (createRenderer's fence and image rules, ../markdown.ts) read a block the
// same way. A block is a fence named by its info word (```toc) or a Lezer
// node together with its markdown-it token (Image / image, Image /
// note_embed, Table / table_open); the parity test holds the two parsers to
// the same answer for every template.

import type Token from "markdown-it/lib/token.mjs";
import type { RenderEnv } from "../assets";
import type { SlashSection } from "../editorCompletions";
import type { Strings } from "../i18n";
import { CHART, type TaggedTables } from "./chart";
import { EMBED } from "./embed";
import { IMAGE } from "./image";
import { QUERY, type QueryModel, type QueryRow } from "./query";
import { MATH } from "./math";
import { MERMAID } from "./mermaid";
import { missingRenderer } from "./pluginCode";
import { TABLE } from "./table";
import { TOC } from "./toc";

export interface BlockCtx {
  /** Vault paths → webview URLs; absent (tests, Ask) = sources as written. */
  env?: RenderEnv;
  /** The page's outline (body headings, extractHeadings order); `line` is
   *  0-based in the body (frontmatter stripped). */
  readonly headings: readonly { level: number; text: string; line: number }[];
  /** UI strings; Live only (Preview has none, so it shows no UI copy). */
  t?: Strings;
  /** Live only: Preview's HTML for this block (`src`: its source past
   *  container marks) as the whole note renders it (createRenderer, vault
   *  text escaped) — a table's footnote citations and reference links
   *  resolve, as in Preview. */
  renderBlock?: (src: string) => string;
  /** A note embed's section as Preview's HTML, null when the note or the
   *  heading is missing (lib/embedLoad.ts); absent = always missing. */
  loadEmbed?: (note: string, heading: string | null) => Promise<string | null>;
  /** A query block's pages (lib/queryLoad.ts); absent = it cannot run. */
  runQuery?: (q: QueryModel) => Promise<QueryRow[]>;
  /** The note's tables tagged `^id` (chart.ts taggedTables), read from the
   *  same parse as `headings`; absent = none. */
  readonly tables?: TaggedTables;
  /** Live only: the block's lines as the note holds them (a fence's own
   *  lines included) and the container marks before its first line — what
   *  a fence's panel rewrites (./fencePanel). */
  readonly block?: { readonly source: string; readonly lead: string };
}

/** Live only: rewrite part of the note as one undo step. `change` gets the
 *  note's text and where the block's first line starts now. With `open`,
 *  the block drawn that far into `insert` opens its editor after the write
 *  (a chart's panel, under the table it put above itself); without, focus
 *  goes back to the note. */
export type BlockEdit = (
  change: (
    doc: string,
    from: number,
  ) => { from: number; to: number; insert: string; open?: number } | null,
) => void;

/** Live only: what a block's in-place editor (a table's cells) does to the
 *  note and the editor around it (live.ts). */
export interface BlockHost {
  /** Replace the block's first `length` characters (its own lines; a tag
   *  line under a table is not one) with `insert`. Every write of one
   *  `session` (its start, Date.now()) is one undo step; none: a step of
   *  its own. Focus stays where it is. */
  write(length: number, insert: string, session?: number): void;
  /** Out of the editor, into the note: the block selected whole, or the
   *  caret on the text before (`up`) or after (`down`) it. */
  leave(to: "select" | "up" | "down"): void;
  /** ⌘Z / ⇧⌘Z from inside the widget: the note's own history. */
  undo(redo: boolean): void;
  /** Take the block's lines out, as Backspace on it selected whole does
   *  (a fence's 삭제), the caret back in the note. */
  remove(): void;
  /** The widget's height changed outside a view update (a cell wrapped). */
  remeasure(): void;
  /** The note cannot be written: no field is editable. */
  readonly readOnly: boolean;
}

export interface BlockSpec<P = unknown> {
  id: string;
  match: { fence: string } | { node: string; token: string };
  /** A `/` menu item inserting `template` (editorCompletions.slashItems);
   *  `name` is the localized label's key. */
  slash?: {
    label: string;
    name: keyof Strings;
    icon: string;
    aliases: readonly string[];
    section: SlashSection;
    /** What the item inserts instead of `template`, set apart from the
     *  text around it (a chart's sample table above its fence), for the
     *  note `doc` it goes into. */
    sample?: (t: Strings, doc: string) => string;
    /** The block's editor (its panel) opens once it is in: the last block
     *  of what the item inserts. */
    open?: boolean;
  };
  /** The block's minimal source, as its slash item inserts it. */
  template: string;
  /** Source → value (a fence: its body), null when this is not the block. */
  parse(src: string): P | null;
  /** markdown-it side of a node block: the token and its inline text. */
  fromToken?(token: Token, text: string): P | null;
  /** Preview HTML. Every piece of vault text in it is escaped. Absent:
   *  markdown-it's own rule draws the block in Preview (a GFM table). */
  renderStatic?(parsed: P, ctx: BlockCtx): string;
  /** Live: fill the widget's element (DOM calls, no innerHTML). A promise
   *  resolves once the widget has its final size (the view remeasures).
   *  `edit` (Live only) writes to the note (a query's bake); `host` (Live
   *  only) is what an in-place editor drives. */
  mount(
    el: HTMLElement,
    parsed: P,
    ctx: BlockCtx,
    edit?: BlockEdit,
    host?: BlockHost,
  ): void | Promise<void>;
  /** Live: redraw `el` (what `mount` filled) for a new `parsed` in place,
   *  so a field being typed in keeps its DOM (Korean IME); false: draw it
   *  anew. Absent: a change always draws anew. */
  update?(el: HTMLElement, parsed: P, ctx: BlockCtx): boolean;
  estimatedHeight(parsed: P, ctx: BlockCtx): number;
  /** What else the widget shows besides its source (a TOC: the outline);
   *  a change redraws it. */
  key?(parsed: P, ctx: BlockCtx): string;
  /** Live: open the block's in-place editor (a table's first cell, a
   *  fence's panel) in `el`, the element `mount` filled — Enter on the
   *  block selected whole (live.ts). Absent: Enter puts the caret on a new
   *  line under the block. */
  openEditor?(el: HTMLElement): void;
}

export const BLOCKS: readonly BlockSpec[] = [
  TOC,
  IMAGE,
  EMBED,
  TABLE,
  QUERY,
  CHART,
  MERMAID,
  MATH,
];

/** What a plugin's fence may be drawn with (lib/plugins): `builtin:<id>`
 *  is the registry block of that id, `builtin:code` a plain code block. */
export const FENCE_RENDERERS = [
  "builtin:code",
  "builtin:chart",
  "builtin:mermaid",
  "builtin:query",
] as const;
export type FenceRenderer = (typeof FENCE_RENDERERS)[number];

/** Pure: the block drawing a plugin's ```lang fence with `renderer`; null =
 *  a plain code block. A renderer not registered in this build draws the
 *  body as code with a note saying so (./pluginCode). */
export function rendererBlock(
  lang: string,
  renderer: FenceRenderer,
  blocks: readonly BlockSpec[] = BLOCKS,
): BlockSpec | null {
  if (renderer === "builtin:code") return null;
  const id = renderer.slice("builtin:".length);
  return blocks.find((b) => b.id === id) ?? missingRenderer(lang, renderer);
}

/** The built-in block a fence of this info word is, if any. */
export const builtinFence = (word: string): BlockSpec | undefined =>
  BLOCKS.find((b) => "fence" in b.match && b.match.fence === word);

/** The enabled plugins' fences, by name (null = plain code). */
let pluginFences = new Map<string, BlockSpec | null>();

/** Set the enabled plugins' fences (lib/plugins). A built-in fence name
 *  stays built-in; of two plugins naming one fence, the first keeps it.
 *  `blocks`: where the renderers resolve (rendererBlock) — a test leaves
 *  one out, as every renderer FENCE_RENDERERS names is in this build. */
export function setPluginFences(
  fences: readonly { lang: string; renderer: FenceRenderer }[],
  blocks: readonly BlockSpec[] = BLOCKS,
): void {
  pluginFences = new Map();
  for (const f of fences)
    if (!pluginFences.has(f.lang) && !builtinFence(f.lang))
      pluginFences.set(f.lang, rendererBlock(f.lang, f.renderer, blocks));
}

/** The block a fence's info string names (its first word): a built-in
 *  one, else an enabled plugin's. */
export function fenceBlock(info: string): BlockSpec | undefined {
  const word = info.trim().split(/\s/, 1)[0];
  return builtinFence(word) ?? pluginFences.get(word) ?? undefined;
}

/** The blocks a Lezer node name or a markdown-it token type may be, in
 *  registry order: one Lezer node can carry several (an Image node is an
 *  image or a note embed), which their `parse` tells apart. */
export function nodeBlocks(name: string): BlockSpec[] {
  return BLOCKS.filter(
    (b) =>
      "node" in b.match && (b.match.node === name || b.match.token === name),
  );
}

/** The first block for a Lezer node name or a markdown-it token type. */
export function nodeBlock(name: string): BlockSpec | undefined {
  return nodeBlocks(name)[0];
}
