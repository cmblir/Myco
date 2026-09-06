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
import type { Strings } from "../lib/i18n";
import { ipc } from "../lib/ipc";
import type { HarvestCandidate } from "../lib/ipc";
import {
  clusterColorVar,
  distinctCitations,
  excludedRows,
  formatKb,
  harvestLabel,
  junkExcluded,
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
  const adjacency = useVaultStore((s) => s.adjacency);
  const setRoute = useUIStore((s) => s.setRoute);
  const provRows = useProvenanceStore((s) => s.rows);
  const scanProvenance = useProvenanceStore((s) => s.scan);
  const bumpInbox = useIngestStore((s) => s.bumpInboxRev);

  const data = useHarvestStore((s) => s.data);
  const error = useHarvestStore((s) => s.error);
  const loadQueue = useHarvestStore((s) => s.load);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [openRow, setOpenRow] = useState<string | null>(null);
  const [showExcluded, setShowExcluded] = useState(false);
  const [planning, setPlanning] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const harvestBtn = useRef<HTMLButtonElement | null>(null);
  const runBtn = useRef<HTMLButtonElement | null>(null);

  const root = vault?.path ?? null;

  const load = useCallback(
    async (force = false) => {
      if (root) await loadQueue(root, force);
    },
    [root, loadQueue],
  );

  useEffect(() => {
    void load();
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
  }, [root, scanProvenance]);

  // Keyboard focus follows the one primary action into and out of the gate.
  useEffect(() => {
    if (planning) runBtn.current?.focus();
  }, [planning]);

  if (!root) return null;

  const items = data?.items ?? [];
  const totals = selectionTotals(items, selected);
  const citesNow = provRows ? distinctCitations(provRows) : null;
  const base = citesNow ?? 0;
  const goal = base + totals.citations;
  const running = progress !== null;
  const allSelected = items.length > 0 && totals.count === items.length;

  function toggle(path: string, on: boolean): void {
    setSelected((prev) => {
      const next = new Set(prev);
      if (on) next.add(path);
      else next.delete(path);
      return next;
    });
  }

  async function run(): Promise<void> {
    if (!root || !data || running) return;
    const paths = items.filter((c) => selected.has(c.path)).map((c) => c.path);
    if (paths.length === 0) return;
    setProgress({ done: 0, total: paths.length });
    try {
      const res = await ipc.harvestRun(paths);
      // The pending _inbox list (Ingest page) refetches on this.
      bumpInbox();
      // The existing inbox pass ingests ONE source per call and archives it;
      // one call per copy walks the queue through. It stops early when a
      // pass ingests nothing (another run busy, a held source, an error) —
      // the rest simply wait in _inbox/ for the scheduler.
      let ingested = 0;
      for (let i = 0; i < res.copied; i++) {
        const out = await runInboxPass(root);
        if (!out.ingested) break;
        ingested++;
        setProgress({ done: ingested, total: res.copied });
      }
      await scanProvenance(root, true);
      const after = distinctCitations(useProvenanceStore.getState().rows ?? []);
      notice.ok(harvestLabel(t.hq_done_title, res.copied), {
        icon: "distill",
        sub:
          ingested === res.copied
            ? fill(t.hq_done_sub, { base, goal: after })
            : fill(t.hq_done_partial, { copied: res.copied, ingested }),
      });
    } catch (e) {
      notice.warn(t.hq_failed, { sub: String(e) });
    } finally {
      setProgress(null);
      setPlanning(false);
      await load(true);
    }
  }

  const titleParts = t.hq_title.split("{n}");

  return (
    <section
      className={"hq" + (planning ? " is-planning" : "")}
      aria-labelledby="hq-title"
      data-testid="harvest-queue"
    >
      <div className="hq-hero-wrap">
        <div className="hq-hero-glow" aria-hidden="true" />
        <div className="hq-hero">
          <div className="hq-hero-fig" style={{ "--i": 0 } as CSSProperties}>
            <ActivityIcon name="distill" size={112} />
          </div>
          <div className="hq-hero-text" style={{ "--i": 1 } as CSSProperties}>
            <h1 className="hq-title" id="hq-title">
              {titleParts[0]}
              <b>{items.length.toLocaleString()}</b>
              {titleParts[1] ?? ""}
            </h1>
            <p className="hq-lede">
              {data
                ? fill(t.hq_lede, {
                    total: data.total_scanned,
                    distinct: data.distinct_bodies,
                  })
                : error
                  ? t.hq_error
                  : t.hq_loading}
              {data && data.excluded.already_harvested === 0 && items.length > 0 ? (
                <> {t.hq_never_run}</>
              ) : null}
            </p>
          </div>
          <div className="hq-kpi" style={{ "--i": 2 } as CSSProperties}>
            <span className="hq-kpi-label" id="hq-kpi-label">
              {t.hq_kpi_label}
            </span>
            {/* role=status: the goal number is what changes with every checkbox. */}
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
            <button
              ref={harvestBtn}
              type="button"
              className="btn btn-primary hq-btn"
              disabled={totals.count === 0 || running || planning}
              onClick={() => setPlanning(true)}
            >
              {harvestLabel(t.hq_harvest_btn, totals.count)}
            </button>
          </div>
        </div>
      </div>

      {data ? (
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
            <span>{fill(t.hq_excluded_line, { n: junkExcluded(data.excluded) })}</span>
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
                        <td className="hq-n">{r.count.toLocaleString()}</td>
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

      {error ? (
        <div className="hq-error" role="alert">
          <span>{error}</span>
          <button type="button" className="btn" onClick={() => void load(true)}>
            {t.hq_retry}
          </button>
        </div>
      ) : null}

      {data && items.length === 0 ? (
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

      {items.length > 0 ? (
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
              disabled={running}
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

          {planning ? (
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
                  disabled={running}
                  aria-busy={running}
                  onClick={() => void run()}
                >
                  {t.hq_plan_run}
                </button>
              </div>
            </div>
          ) : null}
        </>
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
  checked,
  open,
  disabled,
  onToggle,
  onOpen,
}: {
  t: Strings;
  c: HarvestCandidate;
  colorVar: string;
  checked: boolean;
  open: boolean;
  disabled: boolean;
  onToggle: (on: boolean) => void;
  onOpen: () => void;
}): JSX.Element {
  const bodyId = `hq-b-${c.rel.replace(/[^a-z0-9]+/gi, "-")}`;
  const name = c.rel.split("/").pop() ?? c.rel;
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
            aria-label={fill(t.hq_row_select, { name: c.title })}
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
            <span className="hq-name">{c.title}</span>
            <span className="hq-sz">{formatKb(c.size_bytes)}</span>
          </span>
          <span className="hq-meta">
            {c.cluster ? (
              <>
                <span className="hq-tb">
                  <span className="hq-tbd" aria-hidden="true" />
                  {c.cluster.page.replace(/\.md$/i, "")}
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
                <dd>
                  {c.cluster.page.replace(/\.md$/i, "")} · {c.cluster.score.toFixed(2)}
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
