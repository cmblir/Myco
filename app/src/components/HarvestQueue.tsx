// Harvest queue (Overview → 수확대). The first thing on the landing page is
// the vault's real work: which archived sessions become wiki pages today.
// The ranker (harvest_candidates) has already sieved duplicates, boilerplate
// and the size buckets — the exclusion line says so, because a queue is only
// trusted once it shows what it hid. Selection → plan gate ("nothing has been
// created yet") → harvest_run copies into _inbox/ → the EXISTING inbox pass
// turns the copies into pages → one toast. sessions/ is only ever read.

import { useCallback, useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import type { JSX } from "react";
import { displayName } from "../lib/displayName";
import type { Strings } from "../lib/i18n";
import { ipc } from "../lib/ipc";
import type { HarvestCandidate } from "../lib/ipc";
import {
  clusterColorVar,
  clusterLabel,
  distinctCitations,
  excludedRows,
  formatKb,
  harvestLabel,
  harvestSurface,
  harvestSelected,
  junkExcluded,
  queueProgress,
  selectionTotals,
} from "../lib/harvest";
import { runInboxPass } from "../lib/autoIngest";
import { notice } from "../lib/notice";
import { useVaultStore } from "../stores/vaultStore";
import { useUIStore } from "../stores/uiStore";
import { useIngestStore } from "../stores/ingestStore";
import { useProvenanceStore } from "../stores/provenanceStore";
import { useHarvestStore } from "../stores/harvestStore";
import { ActivityIcon } from "./ActivityPanel";
import { Hero } from "./ui";
import MascotClip from "./MascotClip";

function fill(s: string, vars: Record<string, string | number>): string {
  return Object.entries(vars).reduce(
    (acc, [k, v]) =>
      acc.replace(`{${k}}`, typeof v === "number" ? v.toLocaleString() : v),
    s,
  );
}

export default function HarvestQueue({ t }: { t: Strings }): JSX.Element | null {
  const vault = useVaultStore((s) => s.currentVault);
  const vaultToken = useVaultStore((s) => s.vaultToken);
  const isOpeningVault = useVaultStore((s) => s.isOpeningVault);
  const adjacency = useVaultStore((s) => s.adjacency);
  const setRoute = useUIStore((s) => s.setRoute);
  const provRows = useProvenanceStore((s) => s.rows);
  const scanProvenance = useProvenanceStore((s) => s.scan);
  const bumpInbox = useIngestStore((s) => s.bumpInboxRev);

  const cachedData = useHarvestStore((s) => s.data);
  const scannedPath = useHarvestStore((s) => s.scannedPath);
  const scannedToken = useHarvestStore((s) => s.scannedToken);
  const cachedError = useHarvestStore((s) => s.error);
  const sharedRun = useHarvestStore((s) => s.run);
  const loading = useHarvestStore((s) => s.loading);
  const loadQueue = useHarvestStore((s) => s.load);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [openRow, setOpenRow] = useState<string | null>(null);
  const [showExcluded, setShowExcluded] = useState(false);
  const [planning, setPlanning] = useState(false);
  const harvestBtn = useRef<HTMLButtonElement | null>(null);
  const runBtn = useRef<HTMLButtonElement | null>(null);

  const root = vault?.path ?? null;
  const data = scannedPath === root && scannedToken === vaultToken ? cachedData : null;
  const error = scannedPath === root && scannedToken === vaultToken ? cachedError : null;
  const progress = sharedRun.phase === null ? null : sharedRun;
  // Per-vault disclosure: absent = collapsed, which is the default once this
  // vault has been harvested at least once.
  const expanded = useUIStore((s) => (root ? (s.harvestExpanded[root] ?? false) : false));
  const setExpanded = useUIStore((s) => s.setHarvestExpanded);

  const load = useCallback(
    async (force = false) => {
      if (!root || isOpeningVault) return;
      const current = useVaultStore.getState();
      if (root && !current.isOpeningVault && current.currentVault?.path === root && current.vaultToken === vaultToken) await loadQueue(root, force);
    },
    [root, vaultToken, isOpeningVault, loadQueue],
  );

  useEffect(() => {
    void load();
    setPlanning(false);
  }, [load]);

  // Everything eligible starts checked: the ranker already said yes.
  useEffect(() => {
    setSelected(new Set(data?.items.map((c) => c.path) ?? []));
    setOpenRow(null);
  }, [data]);

  // The citation count the hero moves — cached per vault by the provenance
  // store, so a revisit costs nothing.
  useEffect(() => {
    if (root) void scanProvenance(root);
  }, [root, vaultToken, scanProvenance]);

  // Keyboard focus follows the one primary action into and out of the gate.
  useEffect(() => {
    if (planning) runBtn.current?.focus();
  }, [planning]);

  if (!root || isOpeningVault) return null;

  const readFailed = data !== null && data.read_status !== "complete" && data.read_status !== "partial";
  const readIssues = data?.read_issues ?? [];
  const incompleteRead = data !== null && data.read_status !== "complete";
  const completeRead = data?.read_status === "complete" && !loading && !error;
  const readCount = (count: number): string => incompleteRead
    ? t.hq_read_lower_bound.replace("{n}", count.toLocaleString()) : count.toLocaleString();
  const items = readFailed ? [] : data?.items ?? [];
  const totals = selectionTotals(items, selected);
  const citesNow = provRows ? distinctCitations(provRows) : null;
  const queued = completeRead && data ? queueProgress(data) : null;
  const base = citesNow ?? 0;
  const goal = base + totals.citations;
  const running = progress !== null;
  const allSelected = items.length > 0 && totals.count === items.length;
  const surface = completeRead ? harvestSurface(data) : "first-run";
  const collapsed = surface === "working" && !expanded;

  function toggle(path: string, on: boolean): void {
    setSelected((prev) => {
      const next = new Set(prev);
      if (on) next.add(path);
      else next.delete(path);
      return next;
    });
  }

  async function run(): Promise<void> {
    // Overview and the notch share the run lock, including across route changes.
    if (!root || !data || readFailed || error || loading || running) return;
    if (useHarvestStore.getState().run.phase !== null) return;
    const paths = items.filter((c) => selected.has(c.path)).map((c) => c.path);
    if (paths.length === 0) return;
    // The Topbar's activity chip reads the run from the store: a harvest is
    // minutes of work and the bar showed nothing at all for the whole stretch.
    useHarvestStore.getState().startRun(paths.length);
    let ownedRun = useHarvestStore.getState().run;
    const isCurrent = (): boolean => {
      const current = useVaultStore.getState();
      return (
        !current.isOpeningVault &&
        current.currentVault?.path === root &&
        current.vaultToken === vaultToken &&
        useHarvestStore.getState().run === ownedRun
      );
    };
    const endRun = (ok: boolean): void => {
      if (!isCurrent()) return;
      useHarvestStore.getState().endRun(ok);
      ownedRun = useHarvestStore.getState().run;
    };
    try {
      const origin = Object.freeze(await ipc.agentVaultSession());
      if (!isCurrent()) return;
      if (origin.vaultPath !== root || !origin.openingToken)
        throw new Error(
          "The native harvest opening differs from the selected vault",
        );
      const res = await harvestSelected(root, paths, {
        origin,
        expectedVaultToken: vaultToken,
        copy: async (chosen, vaultPath, capturedOrigin) => {
          const copied = await ipc.harvestRun(
            chosen,
            vaultPath,
            capturedOrigin,
          );
          if (isCurrent()) bumpInbox();
          return copied;
        },
        pass: runInboxPass,
        isCurrentVault: (path) => path === root && isCurrent(),
        onProgress: (done, total) => {
          if (!isCurrent()) return;
          useHarvestStore.getState().setRun(done, total);
          ownedRun = useHarvestStore.getState().run;
        },
      });
      const complete =
        res.completed > 0 &&
        res.pending === 0 &&
        res.skipped.length === 0 &&
        res.failed.length === 0 &&
        !res.cancelled;
      if (res.cancelled) {
        endRun(false);
        return;
      }
      if (!isCurrent()) return;
      await scanProvenance(root, true);
      if (!isCurrent()) return;
      const after = distinctCitations(useProvenanceStore.getState().rows ?? []);
      const details = [...res.failed, ...res.skipped]
        .map((failure) => failure.reason)
        .join("; ");
      (complete ? notice.ok : notice.warn)(
        complete ? harvestLabel(t.hq_done_title, res.completed) : t.hq_failed,
        {
          icon: "distill",
          sub: complete
            ? fill(t.hq_done_sub, { base, goal: after })
            : `${fill(t.hq_done_partial, { copied: res.copied, ingested: res.completed })}${details ? ` — ${details}` : ""}`,
        },
      );
      endRun(complete);
    } catch (e) {
      if (isCurrent()) notice.warn(t.hq_failed, { sub: String(e) });
      endRun(false);
    } finally {
      // Refresh only the captured vault; a pending queue stays retryable.
      if (isCurrent()) {
        setPlanning(false);
        setExpanded(root, false);
        await load(true);
      }
    }
  }

  const titleParts = t.hq_title.split("{n}");

  // The number this whole surface exists to move. Same markup in both states —
  // 42px in the hero, 14px in the collapsed row — because "did my harvest do
  // anything" is the question a collapsed row still has to answer. role=status:
  // the goal number is what changes with every checkbox.
  const citesNum = (
    <div className="hq-kpi-num" role="status" aria-labelledby="hq-kpi-label">
      <b>{citesNow === null ? "…" : citesNow.toLocaleString()}</b>
      {totals.count > 0 ? (
        <span className="hq-goal">
          <svg className="hq-arrow" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M5 12h14M13 6l6 6-6 6" />
          </svg>
          <span className="hq-sr">→</span>
          <span key={goal} className="hq-bump">
            {goal.toLocaleString()}
          </span>
        </span>
      ) : null}
    </div>
  );

  // Filled in the hero, glass in the collapsed row: the Overview's one filled
  // primary belongs to whatever is below once the user is mid-harvest.
  const harvestButton = (
    <button
      ref={harvestBtn}
      type="button"
      className={"btn hq-btn" + (collapsed ? "" : " btn-primary")}
      disabled={totals.count === 0 || running || planning || loading}
      onClick={() => setPlanning(true)}
    >
      {harvestLabel(t.hq_harvest_btn, totals.count)}
    </button>
  );

  return (
    <section
      className={
        "hq" + (planning ? " is-planning" : "") + (collapsed ? " is-mini" : "")
      }
      aria-labelledby="hq-title"
      data-testid="harvest-queue"
    >
      {collapsed && queued ? (
        <div className="hq-minirow">
          <button
            type="button"
            className="hq-mini-btn"
            aria-expanded={false}
            onClick={() => setExpanded(root, true)}
          >
            <ActivityIcon name="distill" size={28} />
            <span className="hq-mini-line" id="hq-title">
              {fill(t.hq_mini_line, { left: queued.left, done: queued.done })}
            </span>
            <span className="hq-chev" aria-hidden="true">
              ›
            </span>
          </button>
          <span className="hq-mini-kpi">
            <span className="hq-kpi-label" id="hq-kpi-label">
              {t.hq_kpi_label}
            </span>
            {citesNum}
          </span>
          {harvestButton}
        </div>
      ) : (
        <>
          {/* The way back to the quiet row, for a vault that has harvested
              before — otherwise the disclosure would only ever open. */}
          {surface === "working" ? (
            <div className="hq-foldbar">
              <button
                type="button"
                className="hq-fold"
                aria-expanded={true}
                onClick={() => setExpanded(root, false)}
              >
                <span className="hq-chev" aria-hidden="true">
                  ›
                </span>
                {t.hq_mini_fold}
              </button>
            </div>
          ) : null}
          <Hero
            titleId="hq-title"
            asset={<ActivityIcon name="distill" size={112} />}
            title={
              data && !readFailed ? <>
                {titleParts[0]}
                <b>{readCount(items.length)}</b>
                {titleParts[1] ?? ""}
              </> : t.bf_title
            }
            lede={
              <>
                {readFailed
                  ? t.hq_error
                  : data
                  ? fill(t.hq_lede, {
                      total: readCount(data.total_scanned),
                      distinct: readCount(data.distinct_bodies),
                    })
                  : error
                    ? t.hq_error
                    : t.hq_loading}
                {completeRead && items.length > 0 ? (
                  queued ? (
                    <>
                      {" "}
                      {fill(t.hq_progress, {
                        done: queued.done,
                        left: queued.left,
                        shown: queued.shown,
                      })}
                    </>
                  ) : (
                    <> {t.hq_never_run}</>
                  )
                ) : null}
              </>
            }
            figure={
              <>
                <span className="hq-kpi-label" id="hq-kpi-label">
                  {t.hq_kpi_label}
                </span>
                {citesNum}
              </>
            }
            action={data && !readFailed ? harvestButton : undefined}
          />
        </>
      )}

      {data && !readFailed && !collapsed ? (
        <div className="hq-drop">
          <button
            type="button"
            className="hq-drop-btn"
            id="hq-drop-btn"
            aria-expanded={showExcluded}
            aria-controls="hq-excluded"
            onClick={() => setShowExcluded((v) => !v)}
          >
            <ActivityIcon name="stop" size={28} />
            <span>{fill(t.hq_excluded_line, { n: readCount(junkExcluded(data.excluded)) })}</span>
            <span className="hq-chev" aria-hidden="true">
              ›
            </span>
          </button>
          {showExcluded ? (
            <div className="hq-drop-body" id="hq-excluded" role="region" aria-labelledby="hq-drop-btn">
              <div className="hq-tw">
                <table className="hq-table">
                  <thead>
                    <tr>
                      <th>{t.hq_ex_col_reason}</th>
                      <th className="hq-n">{t.hq_ex_col_count}</th>
                      <th>{t.hq_ex_col_why}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {excludedRows(data.excluded).map((r) => (
                      <tr key={r.key}>
                        <td>{t[`hq_ex_${r.key}`]}</td>
                        <td className="hq-n">{readCount(r.count)}</td>
                        <td className="hq-why">{t[`hq_ex_${r.key}_why`]}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="hq-drop-note">
                <b aria-hidden="true">✓</b> <span>{t.hq_ex_note}</span>
              </p>
            </div>
          ) : null}
        </div>
      ) : null}

      {error || incompleteRead ? (
        <div className="hq-error" role="alert">
          <div style={{ minWidth: 0, overflowWrap: "anywhere" }}>
            <p>{error ?? (readFailed ? t.hq_error : t.hq_read_partial)}</p>
            {readIssues.length ? <ul>{readIssues.map((issue, index) => (
              <li key={`${issue.path}:${issue.code}:${index}`}><code>{issue.path}</code>: {issue.message}</li>
            ))}</ul> : null}
          </div>
          <button type="button" className="btn" style={{ minWidth: 44, minHeight: 44 }} disabled={loading} aria-busy={loading} onClick={() => void load(true)}>
            {t.hq_retry}
          </button>
        </div>
      ) : null}

      {completeRead && data && items.length === 0 ? (
        <div className="hq-empty">
          <MascotClip size={56} />
          <div className="hq-empty-body">
            <h2>{t.hq_empty_title}</h2>
            <p>{fill(t.hq_empty_body, { distinct: data.distinct_bodies })}</p>
            <button type="button" className="btn btn-primary hq-btn" onClick={() => setRoute("ingest")}>
              {t.hq_empty_cta}
            </button>
          </div>
        </div>
      ) : null}

      {items.length > 0 && !collapsed ? (
        <>
          <ul className="hq-queue">
            {items.map((c) => (
              <QueueRow
                key={c.path}
                t={t}
                c={c}
                colorVar={clusterColorVar(
                  c.cluster ? adjacency?.meta?.[`${root}/${c.cluster.page}`]?.type : undefined,
                )}
                clusterName={
                  c.cluster
                    ? clusterLabel(
                        c.cluster.page,
                        adjacency?.meta?.[`${root}/${c.cluster.page}`]?.title,
                      )
                    : ""
                }
                checked={selected.has(c.path)}
                open={openRow === c.path}
                disabled={running}
                onToggle={(on) => toggle(c.path, on)}
                onOpen={() => setOpenRow((cur) => (cur === c.path ? null : c.path))}
              />
            ))}
          </ul>

          <div className="hq-actions">
            <button
              type="button"
              className="btn btn-ghost"
              disabled={running || loading}
              onClick={() =>
                setSelected(allSelected ? new Set() : new Set(items.map((c) => c.path)))
              }
            >
              {allSelected ? t.hq_clear_all : t.hq_select_all}
            </button>
            <span className="hq-est">
              {totals.count === 0
                ? fill(t.hq_est_none, { base })
                : fill(t.hq_est, { n: totals.count, base, goal })}
            </span>
          </div>
        </>
      ) : null}

      {/* Outside the queue list: the plan gate is the "nothing has been created
          yet" contract, and the collapsed row's button has to reach it too. */}
      {items.length > 0 && planning ? (
        <div className="hq-plan" role="group" aria-labelledby="hq-plan-title">
          <h3 id="hq-plan-title">{t.hq_plan_title}</h3>
          <p className="hq-plan-sub">
            {fill(t.hq_plan_sub, { n: totals.count, kb: formatKb(totals.bytes) })}
          </p>
          <ol>
            <li>{fill(t.hq_plan_copy, { n: totals.count })}</li>
            <li>{t.hq_plan_pass}</li>
            <li>{fill(t.hq_plan_cites, { base, goal, n: totals.citations })}</li>
          </ol>
          {progress ? (
            <div
              className="hq-prog"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={progress.total}
              aria-valuenow={progress.done}
            >
              <i style={{ width: `${(progress.done / Math.max(1, progress.total)) * 100}%` }} />
            </div>
          ) : null}
          <div className="hq-plan-foot">
            <span className="hq-plan-note" role="status">
              {progress
                ? fill(t.hq_plan_running, { done: progress.done, total: progress.total })
                : t.hq_plan_note}
            </span>
            <button
              type="button"
              className="btn"
              disabled={running}
              onClick={() => {
                setPlanning(false);
                harvestBtn.current?.focus();
              }}
            >
              {t.hq_plan_cancel}
            </button>
            <button
              ref={runBtn}
              type="button"
              className="btn btn-primary hq-btn"
              disabled={running || loading || readFailed || !!error}
              aria-busy={running}
              onClick={() => void run()}
            >
              {t.hq_plan_run}
            </button>
          </div>
        </div>
      ) : null}
    </section>
  );
}

/** `[User] …` → the speaker tag in the live colour, the line in sans. */
function Line({ text }: { text: string }): JSX.Element {
  const m = /^\[([^\]]+)\]\s?/.exec(text);
  if (!m) return <>{text}</>;
  return (
    <>
      <span className="hq-sp">[{m[1]}]</span> {text.slice(m[0].length)}
    </>
  );
}

function QueueRow({
  t,
  c,
  colorVar,
  clusterName,
  checked,
  open,
  disabled,
  onToggle,
  onOpen,
}: {
  t: Strings;
  c: HarvestCandidate;
  colorVar: string;
  /** The cluster page as the row names it (clusterLabel). */
  clusterName: string;
  checked: boolean;
  open: boolean;
  disabled: boolean;
  onToggle: (on: boolean) => void;
  onOpen: () => void;
}): JSX.Element {
  const bodyId = `hq-b-${c.rel.replace(/[^a-z0-9]+/gi, "-")}`;
  const name = c.rel.split("/").pop() ?? c.rel;
  // Rust falls back to the file stem when a transcript has no `# heading`.
  const title = displayName(c.title);
  return (
    <li
      className={"hq-row" + (checked ? " is-sel" : "") + (open ? " is-open" : "")}
      style={{ "--c": colorVar } as CSSProperties}
    >
      <div className="hq-row-head">
        <label className="hq-cb">
          <input
            type="checkbox"
            checked={checked}
            disabled={disabled}
            aria-label={fill(t.hq_row_select, { name: title })}
            onChange={(e) => onToggle(e.target.checked)}
          />
        </label>
        <button
          type="button"
          className="hq-main"
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={onOpen}
        >
          <span className="hq-row-title">
            <span className="hq-name" title={c.rel}>
              {title}
            </span>
            <span className="hq-sz">{formatKb(c.size_bytes)}</span>
          </span>
          <span className="hq-meta">
            {c.cluster ? (
              <>
                <span className="hq-tb" title={c.cluster.page}>
                  <span className="hq-tbd" aria-hidden="true" />
                  {clusterName}
                </span>
                <span className="hq-near">
                  {fill(t.hq_near, { score: c.cluster.score.toFixed(2) })}
                </span>
                <span className="hq-bar" aria-hidden="true">
                  <i style={{ width: `${Math.round(c.cluster.score * 100)}%` }} />
                </span>
              </>
            ) : (
              <span className="hq-near">{t.hq_unclustered}</span>
            )}
          </span>
          {!open ? (
            <span className="hq-prev">
              {c.preview.slice(0, 2).map((line, i) => (
                <span key={i} className="hq-prev-line">
                  <Line text={line} />
                </span>
              ))}
            </span>
          ) : null}
        </button>
        <span className="hq-side">
          <span className="hq-cite">{fill(t.hq_cites_plus, { n: c.est_citations })}</span>
          <button type="button" className="hq-mini" onClick={onOpen} aria-controls={bodyId} aria-expanded={open}>
            {open ? t.hq_collapse : t.hq_preview}
          </button>
        </span>
      </div>
      {open ? (
        <div className="hq-row-body" id={bodyId}>
          <div className="hq-transcript">
            {c.preview.map((line, i) => (
              <div key={i}>
                <Line text={line} />
              </div>
            ))}
          </div>
          <dl className="hq-will">
            <div>
              <dt>{t.hq_will_copy}</dt>
              <dd>_inbox/{name}</dd>
            </div>
            {c.cluster ? (
              <div>
                <dt>{t.hq_will_cluster}</dt>
                <dd title={c.cluster.page}>
                  {clusterName} · {c.cluster.score.toFixed(2)}
                </dd>
              </div>
            ) : null}
            <div>
              <dt>{t.hq_will_cites}</dt>
              <dd>+{c.est_citations}</dd>
            </div>
          </dl>
          <p className="hq-wont">{fill(t.hq_wont, { rel: c.rel })}</p>
        </div>
      ) : null}
    </li>
  );
}
