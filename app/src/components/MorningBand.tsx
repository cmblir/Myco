// Morning-Report band (Q4 item 2, mockup M1-a/b/c/d): a since-you-were-here
// headline, the suspect-pages and contradiction cards, and the daily ritual
// section (Q4 item 11) below them — top resurface pick + FSRS due line.

import { useEffect, useMemo, useState } from "react";
import type { JSX } from "react";
import type { Strings } from "../lib/i18n";
import { ipc, type SuspectReport } from "../lib/ipc";
import type { DistillStatus } from "../lib/distill";
import { useVaultStore } from "../stores/vaultStore";
import { useUIStore } from "../stores/uiStore";
import type { RouteId } from "../stores/uiStore";
import { buildMorningHeadline, topSuspects } from "../lib/overviewReport";
import {
  contradictionKey,
  findContradictions,
  loadIgnored,
  saveIgnored,
  setPageStatus,
  type Contradiction,
} from "../lib/contradictions";
import { stem } from "../lib/graphData";
import { useResurfaceStore } from "../stores/resurfaceStore";
import { useStudyStore } from "../stores/studyStore";

export default function MorningBand({ t }: { t: Strings }): JSX.Element | null {
  const vault = useVaultStore((s) => s.currentVault);
  const adjacency = useVaultStore((s) => s.adjacency);
  const lang = useUIStore((s) => s.lang);
  const setRoute = useUIStore((s) => s.setRoute);
  const setStudyDeck = useUIStore((s) => s.setStudyDeck);
  const resurfacePicks = useResurfaceStore((s) => s.picks);
  const studyDecks = useStudyStore((s) => s.decks);
  const dueTotal = useStudyStore((s) => s.dueTotal);
  const refreshStudy = useStudyStore((s) => s.refresh);
  const [suspects, setSuspects] = useState<SuspectReport | null>(null);
  const [distill, setDistill] = useState<DistillStatus | null>(null);
  const [ignored, setIgnored] = useState<ReadonlySet<string>>(() => loadIgnored());
  const [contraError, setContraError] = useState<string | null>(null);
  // Snapshot the PREVIOUS visit once at mount — PageOverview stamps the new
  // visit right after, and a live subscription would compare against that
  // fresh stamp and always read "quiet".
  const [visitedAt] = useState(() => useUIStore.getState().lastVisitAt);

  useEffect(() => {
    if (!vault) return;
    let cancelled = false;
    ipc
      .suspectPages(vault.path)
      .then((r) => {
        if (!cancelled) setSuspects(r);
      })
      .catch(() => {
        if (!cancelled) setSuspects(null);
      });
    ipc
      .distillStatus(vault.path)
      .then((s) => {
        if (!cancelled) setDistill(s);
      })
      .catch(() => {
        if (!cancelled) setDistill(null);
      });
    return () => {
      cancelled = true;
    };
  }, [vault]);

  // FSRS due counts for the ritual card — same refresh PageStudy runs on
  // mount, so the card is live even when Study was never visited.
  useEffect(() => {
    void refreshStudy();
  }, [refreshStudy, vault?.path]);

  // Client-side scan over the already-loaded adjacency (spec item 15) —
  // recomputed whenever the link graph refreshes, so a flip below shows up
  // as soon as refreshLinkGraph republishes.
  const contradictions = useMemo(
    () =>
      vault && adjacency
        ? findContradictions(adjacency, vault.path).filter(
            (c) => !ignored.has(contradictionKey(c)),
          )
        : [],
    [vault, adjacency, ignored],
  );

  if (!vault) return null;

  // Two-click resolution: rewrite the frontmatter status, record the human
  // decision in vault history (undo rides history — the run manifest cannot
  // represent an in-place edit), then rebuild the adjacency so the queue and
  // the graph both reflect the flip.
  const flip = async (c: Contradiction, status: "active" | "superseded") => {
    setContraError(null);
    try {
      const file = await ipc.readFile(c.page);
      await ipc.writeFile(c.page, setPageStatus(file.raw, status));
      void ipc.commitHumanEdit(vault.path, c.rel).catch(() => {
        /* history commit is best-effort; the flip itself already landed */
      });
      void useVaultStore.getState().refreshLinkGraph();
    } catch (err) {
      setContraError(String(err));
    }
  };

  const ignore = (c: Contradiction) => {
    const next = new Set(ignored);
    next.add(contradictionKey(c));
    saveIgnored(next);
    setIgnored(next);
  };
  // DistillStatus has no runs-since counter, only last_run (epoch seconds):
  // report "a run happened since your visit" as 1, else 0. pagesMoved is not
  // derivable from DistillStatus yet, so it stays 0 and the headline leans on
  // the runs count. ponytail: 0/1 recency signal, real counts when
  // list_distill_runs (Task 8) lands.
  const runsSince =
    distill?.last_run != null && (visitedAt === null || distill.last_run * 1000 > visitedAt)
      ? 1
      : 0;
  const headline = buildMorningHeadline({ runsSince, pagesMoved: 0, lang }, t);
  const top = suspects ? topSuspects(suspects, 3) : [];

  // Ritual section (M1-d): top resurface pick + FSRS due line. Opening the
  // pick counts as an accept (the store's self-tuning floor feeds on it);
  // 복습 시작 deep-links Study straight into the first due deck.
  const ritualPick = resurfacePicks[0];
  const firstDueDeck = studyDecks.find((d) => d.due > 0);
  const openRitualPick = () => {
    if (!ritualPick) return;
    useResurfaceStore.getState().open(ritualPick.page);
    setRoute(`page:${vault.path}/${ritualPick.page}` as RouteId);
  };
  const startReview = () => {
    if (firstDueDeck) setStudyDeck(firstDueDeck.path);
    setRoute("study");
  };

  return (
    <section style={{ marginTop: 20 }} data-testid="morning-band">
      <div className="page-eyebrow">{t.ov_since_eyebrow ?? "Since you were last here"}</div>
      <div style={{ fontSize: 20, fontWeight: 650, letterSpacing: "-0.01em" }}>{headline}</div>
      {/* Run drill-in lives on History (W3–6 item 6). */}
      <button
        type="button"
        className="btn"
        style={{ marginTop: 8 }}
        onClick={() => setRoute("history")}
      >
        {t.ov_view_runs ?? "View runs"}
      </button>
      <div className="card-grid" style={{ marginTop: 14 }}>
        <div className="card" style={{ padding: 16 }}>
          <div className="row" style={{ justifyContent: "space-between" }}>
            <b style={{ fontSize: 13.5 }}>{t.ov_suspect_title ?? "Suspect pages"}</b>
            <span
              className="nav-badge"
              style={
                suspects && suspects.suspects.length > 0
                  ? { background: "rgba(217,119,6,.15)", color: "#d97706" }
                  : undefined
              }
            >
              {suspects ? suspects.suspects.length : "…"}
            </span>
          </div>
          {top.length === 0 ? (
            <div className="muted" style={{ fontSize: 12.5, marginTop: 6 }}>
              {t.ov_suspect_clean ?? "Every checked page looks sound."}
            </div>
          ) : (
            <div style={{ marginTop: 6 }}>
              {top.map((s) => (
                <button
                  key={s.page}
                  type="button"
                  className="list-row recent-row"
                  // `.list-row` is a 4-column grid (24px icon / 1fr / auto / auto);
                  // without an icon cell the page name lands in the 24px column and
                  // collides with the reason. These rows stack their own two lines.
                  style={{ display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 2 }}
                  // Same navigation as RecentNotes rows: the route reads an
                  // ABSOLUTE path (it hands it to ipc.readFile).
                  onClick={() => setRoute(`page:${vault.path}/wiki/${s.page}` as RouteId)}
                >
                  <span style={{ fontWeight: 500, fontSize: 12.5 }}>{s.page}</span>
                  <span className="meta">{s.reasons[0]}</span>
                </button>
              ))}
            </div>
          )}
        </div>
        <div className="card" style={{ padding: 16 }}>
          <div className="row" style={{ justifyContent: "space-between" }}>
            <b style={{ fontSize: 13.5 }}>{t.contra_title ?? "Contradictions"}</b>
            <span
              className="nav-badge"
              style={
                contradictions.length > 0
                  ? { background: "var(--accent-soft)" }
                  : undefined
              }
            >
              {adjacency ? contradictions.length : "…"}
            </span>
          </div>
          {contradictions.length === 0 ? (
            <div className="muted" style={{ fontSize: 12.5, marginTop: 6 }}>
              {t.contra_clean ?? "No contradictions."}
            </div>
          ) : (
            <div style={{ marginTop: 6 }}>
              {contradictions.slice(0, 3).map((c) => (
                <div
                  key={contradictionKey(c)}
                  className="list-row"
                  // `.list-row` is a grid — the column stack needs an explicit
                  // `display: flex` or the children fall into its icon column.
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "flex-start",
                    gap: 4,
                  }}
                >
                  <span style={{ fontWeight: 500, fontSize: 12.5 }}>{stem(c.page)}</span>
                  <span className="meta">
                    {c.kind === "disputed"
                      ? (t.contra_disputed ?? "Page is flagged disputed")
                      : (t.contra_stale ?? "Cites {t} (superseded)").replace(
                          "{t}",
                          stem(c.target ?? ""),
                        )}
                  </span>
                  <div className="row" style={{ gap: 6 }}>
                    {c.kind === "disputed" ? (
                      <>
                        <button type="button" className="btn" onClick={() => void flip(c, "active")}>
                          {t.contra_mark_active ?? "Resolve: active"}
                        </button>
                        <button
                          type="button"
                          className="btn"
                          onClick={() => void flip(c, "superseded")}
                        >
                          {t.contra_mark_superseded ?? "Mark superseded"}
                        </button>
                      </>
                    ) : (
                      <>
                        <button
                          type="button"
                          className="btn"
                          onClick={() => setRoute(`page:${c.page}` as RouteId)}
                        >
                          {t.contra_open_page ?? "Open linking page"}
                        </button>
                        <button
                          type="button"
                          className="btn"
                          onClick={() => setRoute(`page:${vault.path}/${c.target}` as RouteId)}
                        >
                          {t.contra_open_target ?? "Open target"}
                        </button>
                      </>
                    )}
                    <button type="button" className="btn" onClick={() => ignore(c)}>
                      {t.contra_ignore ?? "Ignore"}
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
          {contraError && (
            <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
              {contraError}
            </div>
          )}
        </div>
      </div>
      {ritualPick || dueTotal > 0 ? (
        <div className="card" style={{ padding: 16, marginTop: 14 }}>
          <b style={{ fontSize: 13.5 }}>{t.ritual_title ?? "Today's reunions"}</b>
          {ritualPick ? (
            <div style={{ marginTop: 6 }}>
              <button
                type="button"
                className="list-row recent-row"
                // Two stacked lines, not `.list-row`'s icon-first grid.
                style={{ display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 2 }}
                onClick={openRitualPick}
              >
                <span style={{ fontWeight: 500, fontSize: 12.5 }}>
                  {ritualPick.stem}
                </span>
                <span className="meta">{ritualPick.snippet}</span>
              </button>
            </div>
          ) : null}
          {dueTotal > 0 ? (
            <div
              className="row"
              style={{ justifyContent: "space-between", marginTop: 8 }}
            >
              <span className="muted" style={{ fontSize: 12.5 }}>
                {(t.ritual_due ?? "{n} review cards are due").replace(
                  "{n}",
                  String(dueTotal),
                )}
              </span>
              <button type="button" className="btn" onClick={startReview}>
                {t.ritual_start ?? "Start review"}
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
