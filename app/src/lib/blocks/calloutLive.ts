// Live callouts (./callout), from ONE StateField: a BlockWrapper box of the
// callout's kind around its lines — the icon, colour and a toggle's chevron
// are CSS on the title line, so no DOM ever lands next to an IME
// composition — the title's `[!type]-` hidden unless a caret is on that
// line, and a folded toggle's body replaced by a block (CM 6.42 throws for
// line-break-replacing decorations from a ViewPlugin). The body lines stay
// text; a caret in a folded body shows it. The fold state lives in the
// field: view-only, never written to the file. `liveCallouts` / `foldTr`
// are the pure part (vitest, node).

import type { SyntaxNode, Tree } from "@lezer/common";
import {
  Facet,
  MapMode,
  Prec,
  StateEffect,
  StateField,
  type EditorState,
  type Extension,
  type Range,
  type RangeSet,
  type Text,
  type Transaction,
} from "@codemirror/state";
import {
  BlockWrapper,
  Decoration,
  type DecorationSet,
  EditorView,
  keymap,
} from "@codemirror/view";
import { syntaxTree } from "@codemirror/language";
import type { Strings } from "../i18n";
import { frontmatterLength } from "../markdown";
import { kindTitle, parseCalloutHead, type CalloutHead } from "./callout";

export interface LiveCallout extends Omit<CalloutHead, "tagLen"> {
  /** The title line's start: the fold state's key. */
  from: number;
  /** The last line's end. */
  to: number;
  /** The title line's end. */
  titleTo: number;
  /** `[!type]-` and the blanks after it. */
  tag: { from: number; to: number };
}

/** The nodes a quote can sit in. */
const CONTAINERS = new Set([
  "Document",
  "Blockquote",
  "BulletList",
  "OrderedList",
  "ListItem",
]);

/** Pure: the callout a Blockquote node is — its head and where its tag
 *  starts — or null for a plain quote. A callout's first paragraph opens on
 *  its first line with a callout head, as markdown-it's calloutRule reads it. */
export function calloutOf(
  quote: SyntaxNode,
  doc: Text,
): { head: CalloutHead; tagFrom: number } | null {
  let para = quote.firstChild;
  while (para?.name === "QuoteMark") para = para.nextSibling;
  const line = doc.lineAt(quote.from);
  if (para?.name !== "Paragraph" || para.from > line.to) return null;
  const head = parseCalloutHead(
    doc.sliceString(para.from, Math.min(para.to, line.to)),
  );
  return head && { head, tagFrom: para.from };
}

/** Pure: every callout in the document, outer before inner. */
export function liveCallouts(tree: Tree, doc: Text): LiveCallout[] {
  const out: LiveCallout[] = [];
  // ponytail: 32 KB frontmatter cap (same as editorLive)
  const fmEnd = frontmatterLength(
    doc.sliceString(0, Math.min(doc.length, 32768)),
  );
  tree.iterate({
    enter(n) {
      if (!CONTAINERS.has(n.name)) return false;
      if (n.name !== "Blockquote" || n.from < fmEnd) return;
      const c = calloutOf(n.node, doc);
      if (!c) return;
      const { head, tagFrom } = c;
      const line = doc.lineAt(n.from);
      out.push({
        from: line.from,
        to: doc.lineAt(n.to).to,
        titleTo: line.to,
        tag: { from: tagFrom, to: tagFrom + head.tagLen },
        type: head.type,
        fold: head.fold,
        title: head.title,
      });
    },
  });
  return out;
}

/** Flip the toggle whose title line starts here. */
const flipFold = StateEffect.define<number>();

/** A composition ended: the fields left stale by its steps rebuild. */
export const composeEnded = StateEffect.define<null>();

/** Sends composeEnded once CM has read the composed text; not while a new
 *  composition already runs (Korean ends one per syllable and starts the
 *  next at once). One constant, so the fields that include it (callouts,
 *  blocks/live) share one handler. */
export const composeEndRefresh: Extension = EditorView.domEventHandlers({
  compositionend(_e, view) {
    setTimeout(() => {
      if (view.dom.isConnected && !view.composing)
        view.dispatch({ effects: composeEnded.of(null) });
    });
  },
});

/** Stale since a composition step, a field rebuilds on a typed edit or the
 *  composition's end — never on the effect-only transactions (autocomplete)
 *  that arrive mid-composition: a rebuild then moved the composed line into
 *  the box and broke the Korean IME. */
export const staysStale = (tr: Transaction): boolean =>
  !tr.docChanged && !tr.effects.some((e) => e.is(composeEnded));

interface CalloutState {
  /** null = stale (after a composition step): see staysStale. */
  callouts: LiveCallout[] | null;
  /** Title-line starts whose fold is the opposite of the file's `-`/`+`. */
  flipped: readonly number[];
  deco: DecorationSet;
  wrappers: RangeSet<BlockWrapper>;
}

const isOpen = (c: LiveCallout, flipped: readonly number[]): boolean =>
  (c.fold === "+") !== flipped.includes(c.from);
const inBody = (c: LiveCallout, heads: readonly number[]): boolean =>
  heads.some((h) => h > c.titleTo && h <= c.to);

/** The UI strings an untitled callout's kind name comes from. */
const calloutStrings = Facet.define<Strings, Strings | undefined>({
  combine: (v) => v[0],
});

const HIDE = Decoration.replace({});
const FOLD = Decoration.replace({ block: true });

function decorate(
  state: EditorState,
  callouts: readonly LiveCallout[],
  flipped: readonly number[],
): Pick<CalloutState, "deco" | "wrappers"> {
  const heads = state.selection.ranges.map((r) => r.head);
  const t = state.facet(calloutStrings);
  const deco: Range<Decoration>[] = [];
  const wraps: Range<BlockWrapper>[] = [];
  let foldedTo = -1;
  for (const c of callouts) {
    // In a folded body: nothing of it is drawn (an empty box would show).
    if (c.from <= foldedTo) continue;
    const shown = isOpen(c, flipped) || inBody(c, heads);
    const cls = c.fold ? (shown ? " is-open" : " is-closed") : "";
    wraps.push(
      BlockWrapper.create({
        tagName: "div",
        attributes: { class: `live-callout${cls}`, "data-callout": c.type },
      }).range(c.from, c.to),
    );
    const onTitle = heads.some((h) => h >= c.from && h <= c.titleTo);
    deco.push(
      Decoration.line({
        class: "live-callout-title",
        // An untitled callout reads as its kind, as in Preview.
        attributes:
          onTitle || c.title
            ? undefined
            : { "data-title": kindTitle(c.type, t) },
      }).range(c.from),
    );
    if (!onTitle) deco.push(HIDE.range(c.tag.from, c.tag.to));
    if (c.fold && !shown && c.titleTo < c.to) {
      deco.push(FOLD.range(c.titleTo + 1, c.to));
      foldedTo = c.to;
    }
  }
  return {
    deco: Decoration.set(deco, true),
    wrappers: BlockWrapper.set(wraps, true),
  };
}

const calloutField = StateField.define<CalloutState>({
  create(state) {
    const callouts = liveCallouts(syntaxTree(state), state.doc);
    return { callouts, flipped: [], ...decorate(state, callouts, []) };
  },
  update(v, tr) {
    // A flip goes with its title line when that is deleted.
    let flipped = tr.docChanged
      ? v.flipped.flatMap((p) => {
          const q = tr.changes.mapPos(p, 1, MapMode.TrackDel);
          return q === null ? [] : [q];
        })
      : v.flipped;
    for (const e of tr.effects)
      if (e.is(flipFold))
        flipped = flipped.includes(e.value)
          ? flipped.filter((p) => p !== e.value)
          : [...flipped, e.value];
    // Mid-composition (Korean IME) nothing near the composed text may be
    // redrawn: only map the boxes along.
    if (tr.isUserEvent("input.type.compose"))
      return {
        callouts: null,
        flipped,
        deco: v.deco.map(tr.changes),
        wrappers: v.wrappers.map(tr.changes),
      };
    if (!v.callouts && staysStale(tr) && flipped === v.flipped) return v;
    const tree = syntaxTree(tr.state);
    let { callouts } = v;
    if (!callouts || tr.docChanged || tree !== syntaxTree(tr.startState))
      callouts = liveCallouts(tree, tr.state.doc);
    else if (!tr.selection && flipped === v.flipped) return v;
    return { callouts, flipped, ...decorate(tr.state, callouts, flipped) };
  },
  provide: (f) => [
    EditorView.decorations.from(f, (v) => v.deco),
    EditorView.blockWrappers.from(f, (v) => v.wrappers),
  ],
});

/** The end of the toggle whose title line starts at `from` while it is drawn
 *  folded over a body, else null (Source keeps no fold state: never). */
export function foldedEnd(state: EditorState, from: number): number | null {
  const v = state.field(calloutField, false);
  const c = v?.callouts?.find((c) => c.from === from);
  if (!v || !c?.fold || c.titleTo >= c.to) return null;
  const heads = state.selection.ranges.map((r) => r.head);
  return isOpen(c, v.flipped) || inBody(c, heads) ? null : c.to;
}

/** Open or close a toggle as it looks now — the one whose title line starts
 *  at `at`, else the innermost around the main caret. A body shown only
 *  because a caret is in it closes by moving the caret to the title's end.
 *  Null where there is no toggle. */
export function foldTr(state: EditorState, at?: number): Transaction | null {
  const v = state.field(calloutField, false);
  if (!v?.callouts) return null;
  const { head } = state.selection.main;
  const c =
    at === undefined
      ? v.callouts.filter((c) => c.fold && head >= c.from && head <= c.to).pop()
      : v.callouts.find((c) => c.fold && c.from === at);
  if (!c) return null;
  const heads = state.selection.ranges.map((r) => r.head);
  const open = !(isOpen(c, v.flipped) || inBody(c, heads));
  const moveOut = !open && inBody(c, heads);
  return state.update({
    effects: isOpen(c, v.flipped) === open ? [] : flipFold.of(c.from),
    ...(moveOut
      ? { selection: { anchor: c.titleTo }, scrollIntoView: true }
      : {}),
  });
}

/** `t`: the UI strings an untitled callout's kind name is read from
 *  (absent: English). */
export function calloutBlocks(t?: Strings): Extension {
  return [
    t ? calloutStrings.of(t) : [],
    calloutField,
    composeEndRefresh,
    EditorView.domEventHandlers({
      mousedown(e, view) {
        // The chevron is the title line's ::before, left of the line's box.
        const line = e.target;
        if (
          e.button !== 0 ||
          !(line instanceof HTMLElement) ||
          !line.classList.contains("live-callout-title") ||
          e.clientX >= line.getBoundingClientRect().left
        )
          return false;
        const t = foldTr(view.state, view.posAtDOM(line));
        if (!t) return false;
        e.preventDefault();
        view.dispatch(t);
        return true;
      },
    }),
    // Above the default keymap's Mod-Enter (a blank line), in a toggle only.
    Prec.high(
      keymap.of([
        {
          key: "Mod-Enter",
          run: (view) => {
            if (view.composing) return false;
            const t = foldTr(view.state);
            if (!t) return false;
            view.dispatch(t);
            return true;
          },
        },
      ]),
    ),
  ];
}
