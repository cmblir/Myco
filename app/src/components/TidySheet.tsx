// The Tidy sheet (정리): one focus-trapped modal that every entry point opens
// (useTidyStore). It scans the vault, shows lib/tidy's proposal groups with a
// checkbox each and a few before → after rows, applies the ticked ones
// through lib/tidyRun, and offers undo on the receipt.

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import type { JSX } from "react";
import { Button, Check } from "./ui";
import { useTidyStore } from "../stores/tidyStore";
import { afterTidyWrite, tidyFs } from "../stores/tidyActions";
import { useUIStore } from "../stores/uiStore";
import { flushPendingDrafts, useVaultStore } from "../stores/vaultStore";
import { STRINGS } from "../lib/i18n";
import type { Strings } from "../lib/i18n";
import { ipc } from "../lib/ipc";
import { flattenMarkdown } from "../lib/graphData";
import { listedName } from "../lib/displayName";
import { planTidy, stemOf, tidyEdits } from "../lib/tidy";
import type { TidyGroup, TidyInput, TidyKey, TidyPlan, TidyRow } from "../lib/tidy";
import { applyTidy, scanTidy, undoTidy } from "../lib/tidyRun";
import type { TidyReceipt, TidyUndo } from "../lib/tidyRun";
import { useModalFocus } from "./useModalFocus";

type Phase =
  | { kind: "loading" }
  | { kind: "error"; detail: string; retry: () => void }
  | { kind: "plan"; input: TidyInput; plan: TidyPlan }
  | { kind: "busy"; label: string }
  | { kind: "receipt"; plan: TidyPlan; keys: Set<TidyKey>; receipt: TidyReceipt }
  | { kind: "undone"; result: TidyUndo };

const EXAMPLES = 3;
/** On by default: the move is a bigger change, so it waits to be ticked. */
const DEFAULT_ON: TidyKey[] = ["titles", "links"];

function groupCopy(t: Strings, key: TidyKey): { label: string; desc: string } {
  if (key === "titles") return { label: t.tidy_g_titles, desc: t.tidy_g_titles_desc };
  if (key === "links") return { label: t.tidy_g_links, desc: t.tidy_g_links_desc };
  return { label: t.tidy_g_move, desc: t.tidy_g_move_desc };
}

export default function TidySheet(): JSX.Element | null {
  const open = useTidyStore((s) => s.open);
  const setOpen = useTidyStore((s) => s.setOpen);
  const lang = useUIStore((s) => s.lang);
  const t = STRINGS[lang] ?? STRINGS.en;
  const vault = useVaultStore((s) => s.currentVault?.path ?? null);
  const [phase, setPhase] = useState<Phase>({ kind: "loading" });
  const [keys, setKeys] = useState<Set<TidyKey>>(new Set(DEFAULT_ON));
  const [expanded, setExpanded] = useState<Partial<Record<TidyKey, boolean>>>({});
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const titleId = useId();
  const ledeId = useId();
  const num = useMemo(() => new Intl.NumberFormat(lang), [lang]);

  const scan = useCallback(async (): Promise<void> => {
    if (!vault) {
      // Every entry point opens this sheet; without a vault it must say so
      // rather than spin. Retry (or opening one) scans again.
      setPhase({ kind: "error", detail: t.sb_no_vault, retry: () => void scan() });
      return;
    }
    setPhase({ kind: "loading" });
    try {
      // Scan what the editor holds, not what it last saved: an unsaved draft
      // would otherwise land after the scan and set its page aside as changed.
      await flushPendingDrafts();
      const prefix = `${vault}/`;
      const paths = flattenMarkdown(await ipc.listFiles(vault))
        .filter((p) => p.startsWith(prefix))
        .map((p) => p.slice(prefix.length));
      const input = await scanTidy(tidyFs(vault), paths);
      setPhase({ kind: "plan", input, plan: planTidy(input) });
    } catch (e) {
      setPhase({ kind: "error", detail: String(e), retry: () => void scan() });
    }
  }, [vault, t]);

  useEffect(() => {
    if (!open) return;
    setKeys(new Set(DEFAULT_ON));
    setExpanded({});
    void scan();
  }, [open, scan]);

  const busy = phase.kind === "busy";
  const close = (): void => {
    if (!busy) setOpen(false);
  };
  // The first control takes focus whenever the content changes shape, so a
  // keyboard user is never left on a button that just disappeared.
  const { onKeyDown } = useModalFocus(dialogRef, { open, onEscape: close, shape: phase.kind });

  const edits = useMemo(
    () => (phase.kind === "plan" ? tidyEdits(phase.input, keys) : []),
    [phase, keys],
  );

  if (!open) return null;

  async function apply(plan: TidyPlan): Promise<void> {
    if (!vault) return;
    const ticked = new Set(keys);
    setPhase({ kind: "busy", label: t.tidy_applying });
    try {
      // A draft still pending now would save over Tidy's write when its timer
      // fires; written first, its page reads as changed and is left alone.
      await flushPendingDrafts();
      const receipt = await applyTidy(tidyFs(vault), edits);
      await afterTidyWrite(vault, receipt.done.map((e) => ({ from: e.path, to: e.to })));
      setPhase({ kind: "receipt", plan, keys: ticked, receipt });
    } catch (e) {
      setPhase({ kind: "error", detail: String(e), retry: () => void scan() });
    }
  }

  async function undo(receipt: TidyReceipt): Promise<void> {
    if (!vault) return;
    setPhase({ kind: "busy", label: t.tidy_undoing });
    try {
      await flushPendingDrafts();
      const result = await undoTidy(tidyFs(vault), receipt.snapshot);
      await afterTidyWrite(vault, receipt.done.map((e) => ({ from: e.to, to: e.path })));
      setPhase({ kind: "undone", result });
    } catch (e) {
      setPhase({ kind: "error", detail: String(e), retry: () => void undo(receipt) });
    }
  }

  const toggle = (key: TidyKey, on: boolean): void =>
    setKeys((prev) => {
      const next = new Set(prev);
      if (on) next.add(key);
      else next.delete(key);
      return next;
    });

  function renderRow(g: TidyGroup, r: TidyRow, i: number): JSX.Element {
    const page = listedName(stemOf(r.path));
    return (
      <li key={`${r.path}:${i}`} className="tidy-row" title={r.path}>
        {g.key === "links" ? <span className="tidy-row__page">{page}</span> : null}
        <span className={"tidy-row__before" + (g.key === "titles" ? "" : " is-mono")}>
          {r.before}
        </span>
        <span className="tidy-row__arrow">→</span>
        {r.after === null ? (
          <span className="tidy-row__removed">{t.tidy_removed}</span>
        ) : (
          <span className={"tidy-row__after" + (g.key === "titles" ? "" : " is-mono")}>
            {r.after}
          </span>
        )}
      </li>
    );
  }

  function renderGroup(g: TidyGroup): JSX.Element {
    const copy = groupCopy(t, g.key);
    const all = expanded[g.key] === true;
    const rows = all ? g.rows : g.rows.slice(0, EXAMPLES);
    return (
      <section key={g.key} className="tidy-group" aria-label={copy.label}>
        <div className="tidy-group__head">
          <Check checked={keys.has(g.key)} onChange={(on) => toggle(g.key, on)} label={copy.label} />
          <span className="tidy-group__count">{num.format(g.rows.length)}</span>
        </div>
        <p className="tidy-group__desc">{copy.desc}</p>
        <ul className="tidy-rows">{rows.map((r, i) => renderRow(g, r, i))}</ul>
        {g.rows.length > EXAMPLES ? (
          <button
            type="button"
            className="tidy-more"
            aria-expanded={all}
            onClick={() => setExpanded((x) => ({ ...x, [g.key]: !all }))}
          >
            {all ? t.tidy_show_less : t.tidy_show_all.replace("{n}", num.format(g.rows.length))}
          </button>
        ) : null}
      </section>
    );
  }

  const fileList = (items: string[]): JSX.Element => (
    <ul className="tidy-files">
      {items.map((p) => (
        <li key={p} className="is-mono">
          {p}
        </li>
      ))}
    </ul>
  );

  let body: JSX.Element;
  let actions: JSX.Element;
  if (phase.kind === "loading" || phase.kind === "busy") {
    body = (
      <p className="tidy-sheet__status" role="status">
        <span className="agent-spinner" aria-hidden="true">
          ●
        </span>{" "}
        {phase.kind === "loading" ? t.tidy_loading : phase.label}
      </p>
    );
    actions = (
      <Button onClick={close} disabled={busy}>
        {t.dlg_cancel}
      </Button>
    );
  } else if (phase.kind === "error") {
    body = (
      <div className="tidy-sheet__error" role="alert">
        <p>{t.tidy_error}</p>
        <p className="tidy-sheet__detail">{phase.detail}</p>
      </div>
    );
    actions = (
      <>
        <Button onClick={close}>{t.ui_close}</Button>
        <Button variant="primary" onClick={phase.retry}>
          {t.tidy_retry}
        </Button>
      </>
    );
  } else if (phase.kind === "plan") {
    const { plan } = phase;
    const skipped = plan.skipped.length ? (
      <details className="tidy-skipped">
        <summary>{t.tidy_skipped.replace("{n}", num.format(plan.skipped.length))}</summary>
        {fileList(plan.skipped)}
      </details>
    ) : null;
    body =
      plan.groups.length === 0 ? (
        <div className="tidy-sheet__empty" role="status">
          <p>{t.tidy_empty}</p>
          {skipped}
        </div>
      ) : (
        <>
          {plan.groups.map(renderGroup)}
          {skipped}
        </>
      );
    actions =
      plan.groups.length === 0 ? (
        <Button variant="primary" onClick={close}>
          {t.ui_close}
        </Button>
      ) : (
        <>
          <Button onClick={close}>{t.dlg_cancel}</Button>
          <Button
            variant="primary"
            disabled={edits.length === 0}
            onClick={() => void apply(plan)}
          >
            {t.tidy_apply.replace("{n}", num.format(edits.length))}
          </Button>
        </>
      );
  } else if (phase.kind === "receipt") {
    const { receipt, plan } = phase;
    const done = new Set(receipt.done.map((e) => e.path));
    body = (
      <div className="tidy-receipt" role="status">
        <p className="tidy-receipt__head">
          {t.tidy_done.replace("{n}", num.format(receipt.done.length))}
        </p>
        <ul className="tidy-receipt__counts">
          {plan.groups
            .filter((g) => phase.keys.has(g.key))
            .map((g) => (
              <li key={g.key}>
                <span>{groupCopy(t, g.key).label}</span>
                <span className="tidy-group__count">
                  {num.format(g.rows.filter((r) => done.has(r.path)).length)}
                </span>
              </li>
            ))}
        </ul>
        {receipt.failed.length ? (
          <div className="tidy-sheet__error" role="alert">
            <p>{t.tidy_failed.replace("{n}", num.format(receipt.failed.length))}</p>
            <ul className="tidy-files">
              {receipt.failed.map((f) => (
                <li key={f.path} className="is-mono" title={f.error}>
                  {f.path}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        {receipt.changed.length ? (
          <>
            <p className="tidy-group__desc">{t.tidy_changed}</p>
            {fileList(receipt.changed)}
          </>
        ) : null}
      </div>
    );
    actions = (
      <>
        {receipt.changed.length ? (
          <Button onClick={() => void scan()}>{t.tidy_rescan}</Button>
        ) : null}
        <Button onClick={() => void undo(receipt)} disabled={receipt.done.length === 0}>
          {t.tidy_undo}
        </Button>
        <Button variant="primary" onClick={close}>
          {t.ui_close}
        </Button>
      </>
    );
  } else {
    const { result } = phase;
    body = (
      <div className="tidy-receipt" role="status">
        <p className="tidy-receipt__head">
          {t.tidy_undone.replace("{n}", num.format(result.restored))}
        </p>
        {result.skipped.length ? (
          <>
            <p className="tidy-group__desc">{t.tidy_undo_skipped}</p>
            {fileList(result.skipped)}
          </>
        ) : null}
        {result.failed.length ? (
          <div className="tidy-sheet__error" role="alert">
            <p>{t.tidy_failed.replace("{n}", num.format(result.failed.length))}</p>
            {fileList(result.failed.map((f) => f.path))}
          </div>
        ) : null}
      </div>
    );
    actions = (
      <Button variant="primary" onClick={close}>
        {t.ui_close}
      </Button>
    );
  }

  return (
    <div className="myco-modal__backdrop" onClick={close}>
      <div
        ref={dialogRef}
        className="myco-modal tidy-sheet"
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={ledeId}
        aria-busy={busy || phase.kind === "loading"}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        <h2 id={titleId} className="myco-modal__title">
          {t.tidy_title}
        </h2>
        <p id={ledeId} className="myco-modal__message">
          {t.tidy_lede}
        </p>
        <div className="tidy-sheet__body">{body}</div>
        <div className="myco-modal__actions">{actions}</div>
      </div>
    </div>
  );
}
