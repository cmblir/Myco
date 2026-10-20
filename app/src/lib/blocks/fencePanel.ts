// A fenced block in Live — a chart, a diagram, a formula, a query, a
// plugin's fence (docs/specs/2026-10-01, "Fenced blocks"): always its
// result, never its fence. Hover, or the block selected whole, shows a
// toolbar (편집, 삭제); a click on the result, 편집 or Enter on the selected
// block opens a panel inline under it — not a modal, the text below pushed
// down — whose fields edit the fence's body. The result redraws as the
// fields change (after a 300 ms pause). 완료, ⌘Enter and Escape close it and
// keep the changes; Tab stays inside it while it is open. A press outside
// it leaves it open: closing then moved the text under the pointer, and the
// press landed elsewhere. Each write is one transaction over the block's
// own lines (./fenceSource), and a panel's editing session — until a field
// loses the caret or 1 s passes without a write — is one undo step
// (BlockHost.write). Nothing is written while an IME composes (Korean):
// compositionend writes. The note's update keeps the panel's DOM
// (BlockSpec.update), so a field being typed in is never rebuilt. Each kind
// brings its result's drawing and its fields.

import type { Strings } from "../i18n";
import type { BlockCtx, BlockEdit, BlockHost, BlockSpec } from "./index";
import { fenceBody, withBody } from "./fenceSource";

/** A pause this long redraws the result. */
const DEBOUNCE_MS = 300;
/** A pause this long after a write ends the panel's undo step. */
const IDLE_MS = 1000;

/** A kind's fields, as the panel shows them. */
export interface PanelForm {
  readonly el: HTMLElement;
  /** The body the fields say, given the body the note holds now (a chart
   *  keeps the keys its form does not show). */
  body(now: string): string;
  /** The note changed under the open panel (⌘Z, a table the chart reads):
   *  the fields show it. */
  sync(body: string, ctx: BlockCtx): void;
}

/** What a kind's fields reach of the panel. */
export interface PanelHooks {
  /** A field changed without an input event (a segmented button). */
  changed(): void;
  /** One edit around the block, its own undo step, what the fields hold
   *  written first (a chart's new table above it). */
  edit(change: Parameters<BlockEdit>[0]): void;
  /** The block's lines and container marks as the note holds them now. */
  block(): { source: string; lead: string };
}

export interface FenceKind<P> {
  /** The block's name in the UI (차트, 수식): the panel's label. */
  name(t: Strings | undefined): string;
  /** Draw `p` into `box` (empty the first time); resolves once it has its
   *  size. While the panel is open `report` takes what the result cannot
   *  show (a diagram's parse error, under the fields) and the last good
   *  result may stay; null: the result says it itself. */
  draw(
    box: HTMLElement,
    p: P,
    ctx: BlockCtx,
    edit: BlockEdit | undefined,
    report: ((message: string) => void) | null,
  ): void | Promise<void>;
  form(body: string, ctx: BlockCtx, hooks: PanelHooks): PanelForm;
  /** The body the fields edit, from the block's lines; default: the
   *  fence's lines between. */
  read?(source: string, lead: string): string;
  /** The block's lines for a new body; default: the fence's own lines
   *  around it. */
  write?(source: string, lead: string, body: string): string;
}

export function button(
  cls: string,
  label: string,
  run: () => void,
): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = cls;
  b.textContent = label;
  b.addEventListener("click", run);
  return b;
}

/** A field with its label above it. */
export function field(label: string, control: HTMLElement): HTMLLabelElement {
  const l = document.createElement("label");
  l.className = "fb-field";
  const name = document.createElement("span");
  name.className = "fb-label";
  name.textContent = label;
  l.append(name, control);
  return l;
}

/** A text area as tall as its text (`min` rows, at most 20). */
export function textArea(value: string, min: number): HTMLTextAreaElement {
  const area = document.createElement("textarea");
  area.className = "fb-text";
  area.spellcheck = false;
  const fit = () =>
    (area.rows = Math.min(20, Math.max(min, area.value.split("\n").length)));
  area.value = value;
  fit();
  area.addEventListener("input", fit);
  // The caret at the end, where an edit of what is there goes on.
  area.setSelectionRange(value.length, value.length);
  return area;
}

/** One text area holding the whole body (a formula, a diagram, a plugin's
 *  fence); `keep` reads a value the block cannot hold (an empty formula)
 *  as no change. */
export function textForm(
  label: string,
  body: string,
  { rows = 3, keep }: { rows?: number; keep?: (value: string) => boolean } = {},
): PanelForm {
  const el = document.createElement("div");
  el.className = "fb-fields";
  const area = textArea(body, rows);
  el.append(field(label, area));
  return {
    el,
    body: (now) => (keep?.(area.value) ? now : area.value),
    sync(b) {
      if (area.value === b) return;
      area.value = b;
      area.dispatchEvent(new Event("input"));
    },
  };
}

const FOCUSABLE = "button, input, select, textarea, summary";

class Panel<P> {
  /** The result and, once open, the panel: side by side for a diagram in
   *  a wide column (styles.css, a container query on the widget). */
  private readonly body = document.createElement("div");
  private readonly box = document.createElement("div");
  private panel: HTMLElement | null = null;
  private form: PanelForm | null = null;
  private error: HTMLElement | null = null;
  private last: HTMLElement | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private idle: ReturnType<typeof setTimeout> | undefined;
  /** This step's start (BlockHost.write), until a field loses the caret or
   *  a write is IDLE_MS old. */
  private session: number | undefined;
  private composing = false;
  /** The source this panel last wrote: its update is our own. */
  private written: string | null = null;
  /** The result shown is an older one (a diagram that could not draw):
   *  closing draws what the note holds. */
  private kept = false;

  constructor(
    private readonly el: HTMLElement,
    private p: P,
    private ctx: BlockCtx,
    private readonly kind: FenceKind<P>,
    private readonly edit?: BlockEdit,
    private readonly host?: BlockHost,
  ) {
    el.classList.add("fb");
    this.body.className = "fb-body";
    this.box.className = "fb-result";
    this.body.append(this.box);
    el.append(this.body);
    if (!this.editable) return;
    const t = ctx.t;
    const bar = document.createElement("div");
    bar.className = "fb-bar";
    bar.setAttribute("role", "toolbar");
    bar.setAttribute("aria-label", kind.name(t));
    // Out of the tab order: Enter and Backspace on the selected block do
    // the same.
    for (const b of [
      button("fb-btn", t?.fb_edit ?? "Edit", () => this.open()),
      button("fb-btn", t?.fb_delete ?? "Delete", () => this.host?.remove()),
    ]) {
      b.tabIndex = -1;
      bar.append(b);
    }
    el.append(bar);
    el.addEventListener("click", (e) => {
      const at = e.target instanceof Element ? e.target : null;
      if (at && this.box.contains(at) && !at.closest("a, button")) this.open();
    });
  }

  private get editable(): boolean {
    return !!this.host && !this.host.readOnly && !!this.ctx.block;
  }

  /** The fence's body as the note holds it now. */
  private now(): string {
    const { source, lead } = this.ctx.block!;
    return (this.kind.read ?? fenceBody)(source, lead);
  }

  draw(): void | Promise<void> {
    const report = this.form
      ? (m: string) => {
          this.kept = !!m;
          if (this.error) this.error.textContent = m;
          this.host?.remeasure();
        }
      : null;
    return this.kind.draw(this.box, this.p, this.ctx, this.edit, report);
  }

  private redraw(): void {
    void Promise.resolve(this.draw()).then(
      () => this.host?.remeasure(),
      (err: unknown) => console.error("fenced block redraw failed", err),
    );
  }

  /** A new source for this element (live.ts updateDOM): our own write, an
   *  undo, a table the chart reads. The fields keep their DOM. */
  update(p: P, ctx: BlockCtx): boolean {
    const own = ctx.block?.source === this.written;
    this.p = p;
    this.ctx = ctx;
    if (!own) this.endSession();
    this.redraw();
    // What is typed and not written yet stays the fields'.
    if (this.form && !own && !this.composing && this.timer === undefined)
      this.form.sync(this.now(), ctx);
    return true;
  }

  open(): void {
    if (!this.editable) return;
    if (this.panel) return this.focus();
    const t = this.ctx.t;
    const panel = document.createElement("div");
    panel.className = "fb-panel";
    // live.ts: a press here is the panel's, not the block's selection.
    panel.dataset.panel = "";
    panel.setAttribute("role", "group");
    panel.setAttribute(
      "aria-label",
      (t?.fb_panel ?? "Edit {name}").replace("{name}", this.kind.name(t)),
    );
    this.form = this.kind.form(this.now(), this.ctx, {
      changed: () => this.changed(),
      edit: (change) => {
        this.flush();
        this.endSession();
        this.edit?.(change);
      },
      block: () => this.ctx.block!,
    });
    const error = document.createElement("div");
    error.className = "fb-error";
    error.setAttribute("role", "status");
    this.error = error;
    const actions = document.createElement("div");
    actions.className = "fb-actions";
    const done = button(
      "u-btn u-btn--primary fb-done",
      t?.fb_done ?? "Done",
      () => this.close(),
    );
    done.setAttribute("aria-keyshortcuts", "Meta+Enter Escape");
    actions.append(done);
    panel.append(this.form.el, error, actions);
    panel.addEventListener("keydown", this.onKey);
    panel.addEventListener("input", this.onInput);
    panel.addEventListener("compositionstart", () => (this.composing = true));
    panel.addEventListener("compositionend", () => {
      this.composing = false;
      this.changed();
    });
    panel.addEventListener("focusin", (e) => {
      if (e.target instanceof HTMLElement) this.last = e.target;
    });
    // Leaving the panel ends the step; moving between its fields does not.
    panel.addEventListener("focusout", (e) => {
      const to = e.relatedTarget;
      if (to instanceof Node && panel.contains(to)) return;
      this.flush();
      this.endSession();
    });
    this.body.append(panel);
    this.panel = panel;
    this.el.classList.add("is-editing");
    this.focus();
    panel.scrollIntoView({ block: "nearest" });
    this.host?.remeasure();
  }

  /** Close the panel, what the fields hold written, the block selected
   *  whole in the note, where Enter opens it again. */
  close(): void {
    if (!this.panel) return;
    this.flush();
    this.endSession();
    const panel = this.panel;
    this.panel = this.form = this.error = this.last = null;
    this.composing = false;
    panel.remove();
    this.el.classList.remove("is-editing");
    if (this.kept) {
      this.kept = false;
      this.redraw();
    }
    this.host?.remeasure();
    this.host?.leave("select");
  }

  /** The field last typed in, else the first text field (else the first
   *  control). */
  private focus(): void {
    const items = this.focusables();
    const target =
      this.last && this.panel?.contains(this.last)
        ? this.last
        : (items.find((x) => x.matches("input, textarea")) ?? items[0]);
    target?.focus({ preventScroll: true });
  }

  private focusables(): HTMLElement[] {
    return [
      ...(this.panel?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []),
    ].filter(
      (x) => !(x as HTMLButtonElement).disabled && x.getClientRects().length,
    );
  }

  private changed(): void {
    if (this.composing) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      // A composition begun since (the next Korean syllable) writes at its
      // compositionend, never its half-typed jamo.
      if (this.composing) this.timer = undefined;
      else this.flush();
    }, DEBOUNCE_MS);
  }

  /** What the fields hold, into the note: one write over the block's
   *  lines, nothing when they say what the note says. */
  private flush(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    const b = this.ctx.block;
    if (!this.form || !this.host || !b || !this.el.isConnected) return;
    const now = this.now();
    const next = this.form.body(now);
    if (next === now) return;
    const src = (this.kind.write ?? withBody)(b.source, b.lead, next);
    if (src === b.source) return;
    this.session ??= Date.now();
    clearTimeout(this.idle);
    this.idle = setTimeout(() => this.endSession(), IDLE_MS);
    this.written = src;
    this.host.write(b.source.length, src, this.session);
  }

  private endSession(): void {
    clearTimeout(this.idle);
    this.session = undefined;
  }

  private onInput = (e: Event): void => {
    this.host?.remeasure();
    if ((e as InputEvent).isComposing || this.composing) return;
    this.changed();
  };

  private onKey = (e: KeyboardEvent): void => {
    // The IME owns its keys (Enter commits a syllable).
    if (e.isComposing || e.keyCode === 229 || this.composing) return;
    const mod = e.metaKey || e.ctrlKey;
    const k = e.key.toLowerCase();
    const done = () => {
      e.preventDefault();
      e.stopPropagation();
    };
    if (e.key === "Escape" || (mod && e.key === "Enter")) {
      done();
      this.close();
    } else if (mod && !e.altKey && (k === "z" || k === "y")) {
      // The note's history, not the field's: the fields redraw from it.
      done();
      this.flush();
      this.endSession();
      this.host?.undo(k === "y" || e.shiftKey);
    } else if (e.key === "Tab" && !mod && !e.altKey) {
      // Focus stays in the panel while it is open.
      e.stopPropagation();
      const items = this.focusables();
      const i = items.indexOf(e.target as HTMLElement);
      const to = e.shiftKey
        ? i <= 0 && items[items.length - 1]
        : (i < 0 || i === items.length - 1) && items[0];
      if (to) {
        e.preventDefault();
        to.focus();
      }
    }
  };
}

/** A fenced block's Live side: the result in a box of its own, the
 *  toolbar, the panel (BlockSpec.mount / update / openEditor). */
export function fenced<P>(
  kind: FenceKind<P>,
): Pick<BlockSpec<P>, "mount" | "update" | "openEditor"> {
  const panels = new WeakMap<HTMLElement, Panel<P>>();
  return {
    mount(el, p, ctx, edit, host) {
      const panel = new Panel(el, p, ctx, kind, edit, host);
      panels.set(el, panel);
      return panel.draw();
    },
    update: (el, p, ctx) => panels.get(el)?.update(p, ctx) ?? false,
    openEditor: (el) => panels.get(el)?.open(),
  };
}
