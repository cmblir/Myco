// Morning-Report panels (Q4 item 2, mockup M1-a/b/c/d): a since-you-were-here
// headline, the suspect-pages and contradiction lists, and the daily ritual
// section (Q4 item 11) — top resurface pick + FSRS due line.
//
// They default to PageOverview's right rail rather than a full-width band: as
// a band their three cards pushed the vault's actual work (the pulse figures
// and the harvest queue) off the first screen. Same data, same actions, in the
// shared Rail/RailRow parts every other route's rail uses.
//
// A HOOK returning four nodes, not one component rendering four rails: the
// Overview's layout document places each panel independently, and four mounted
// components would mean four copies of the same suspect-pages, run-log and
// contradiction work. One set of fetches, four placements.

import { useEffect, useMemo, useState } from "react";
import type { CSSProperties, JSX } from "react";
import type { Strings } from "../lib/i18n";
import { ipc, type RunSummary, type SuspectReport } from "../lib/ipc";
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
import { Rail, RailRow } from "./Rail";
import { Button } from "./ui";

/** A rail row's two stacked lines — a rail is 248px, so name and reason cannot
 *  share one line the way the old card's grid row did. */
const STACK: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  alignItems: "flex-start",
  gap: 3,
  minWidth: 0,
  width: "100%",
};
/** The row's own buttons wrap inside the rail instead of overflowing it. */
const ACTS: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: 4,
  marginTop: 2,
};
const NAME: CSSProperties = { fontWeight: 500 };

/** The four panels, each `null` when it has nothing to say. */
export interface MorningPanels {
  since: JSX.Element | null;
  suspect: JSX.Element | null;
  contradictions: JSX.Element | null;
  reunions: JSX.Element | null;
}

const NO_PANELS: MorningPanels = {
  since: null,
  suspect: null,
  contradictions: null,
  reunions: null,
};

export function useMorningPanels(t: Strings): MorningPanels {
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
  const [runs, setRuns] = useState<RunSummary[]>([]);
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
    // Real run counts for the headline. `list_distill_runs` (Task 8) landed
    // after this band was written, so the numbers below no longer have to be
    // guessed from `last_run` alone.
    ipc
      .listDistillRuns(vault.path, 20)
      .then((r) => {
        if (!cancelled) setRuns(r);
      })
      .catch(() => {
        if (!cancelled) setRuns([]);
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

  if (!vault) return NO_PANELS;

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
  // Runs since the last visit, and how many pages they actually moved. The
  // run log is the source: this used to report a 0/1 recency flag with
  // pagesMoved pinned to 0, because DistillStatus carries only `last_run`.
  // A first visit (no stamp) counts every run the log still holds rather
  // than claiming the vault was idle.
  const sinceRuns = runs.filter(
    (r) => visitedAt === null || r.started_at * 1000 > visitedAt,
  );
  const runsSince = sinceRuns.length;
  const pagesMoved = sinceRuns.reduce((n, r) => n + r.moves, 0);
  const headline = buildMorningHeadline({ runsSince, pagesMoved, lang }, t);
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

  return {
    since: (
      <Rail title={t.ov_since_eyebrow ?? "Since you were last here"}>
        <RailRow>
          <span style={NAME}>{headline}</span>
        </RailRow>
      </Rail>
    ),
    suspect: (
      <Rail
        title={t.ov_suspect_title ?? "Suspect pages"}
        count={suspects ? suspects.suspects.length : undefined}
      >
        {top.length === 0 ? (
          <RailRow>
            <span className="meta">
              {t.ov_suspect_clean ?? "Every checked page looks sound."}
            </span>
          </RailRow>
        ) : (
          top.map((s) => (
            // Same navigation as RecentNotes rows: the route reads an
            // ABSOLUTE path (it hands it to ipc.readFile).
            <RailRow
              key={s.page}
              onClick={() =>
                setRoute(`page:${vault.path}/wiki/${s.page}` as RouteId)
              }
            >
              <span style={STACK}>
                <span style={NAME}>{s.page}</span>
                <span className="meta">{s.reasons[0]}</span>
              </span>
            </RailRow>
          ))
        )}
      </Rail>
    ),
    contradictions: (
      <Rail
        title={t.contra_title ?? "Contradictions"}
        count={adjacency ? contradictions.length : undefined}
      >
        {contradictions.length === 0 ? (
          <RailRow>
            <span className="meta">
              {t.contra_clean ?? "No contradictions."}
            </span>
          </RailRow>
        ) : (
          // Deliberately not a clickable RailRow: the row carries its own
          // buttons, and a button inside a button is invalid markup.
          contradictions.slice(0, 3).map((c) => (
            <RailRow key={contradictionKey(c)}>
              <span style={STACK}>
                <span style={NAME}>{stem(c.page)}</span>
                <span className="meta">
                  {c.kind === "disputed"
                    ? (t.contra_disputed ?? "Page is flagged disputed")
                    : (t.contra_stale ?? "Cites {t} (superseded)").replace(
                        "{t}",
                        stem(c.target ?? ""),
                      )}
                </span>
                <span style={ACTS}>
                  {c.kind === "disputed" ? (
                    <>
                      <Button
                        variant="quiet"
                        onClick={() => void flip(c, "active")}
                      >
                        {t.contra_mark_active ?? "Resolve: active"}
                      </Button>
                      <Button
                        variant="quiet"
                        onClick={() => void flip(c, "superseded")}
                      >
                        {t.contra_mark_superseded ?? "Mark superseded"}
                      </Button>
                    </>
                  ) : (
                    <>
                      <Button
                        variant="quiet"
                        onClick={() => setRoute(`page:${c.page}` as RouteId)}
                      >
                        {t.contra_open_page ?? "Open linking page"}
                      </Button>
                      <Button
                        variant="quiet"
                        onClick={() =>
                          setRoute(`page:${vault.path}/${c.target}` as RouteId)
                        }
                      >
                        {t.contra_open_target ?? "Open target"}
                      </Button>
                    </>
                  )}
                  <Button variant="quiet" onClick={() => ignore(c)}>
                    {t.contra_ignore ?? "Ignore"}
                  </Button>
                </span>
              </span>
            </RailRow>
          ))
        )}
        {contraError ? (
          <RailRow>
            <span className="meta">{contraError}</span>
          </RailRow>
        ) : null}
      </Rail>
    ),
    reunions:
      ritualPick || dueTotal > 0 ? (
        <Rail title={t.ritual_title ?? "Today's reunions"}>
          {ritualPick ? (
            <RailRow onClick={openRitualPick}>
              <span style={STACK}>
                <span style={NAME}>{ritualPick.stem}</span>
                <span className="meta">{ritualPick.snippet}</span>
              </span>
            </RailRow>
          ) : null}
          {dueTotal > 0 ? (
            <RailRow>
              <span style={STACK}>
                <span className="meta">
                  {(t.ritual_due ?? "{n} review cards are due").replace(
                    "{n}",
                    String(dueTotal),
                  )}
                </span>
                <span style={ACTS}>
                  <Button variant="quiet" onClick={startReview}>
                    {t.ritual_start ?? "Start review"}
                  </Button>
                </span>
              </span>
            </RailRow>
          ) : null}
        </Rail>
      ) : null,
  };
}
