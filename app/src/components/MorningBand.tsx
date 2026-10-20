// Morning-Report panels (Q4 item 2, mockup M1-c/d): the contradiction list and
// the daily ritual section (Q4 item 11) — top resurface pick + FSRS due line.
// The since-you-were-here headline and the suspect pages became Home's notices
// (HomeNotices, spec 2026-10-02); contradictions are a notice too, and its
// row brings the user here, where the resolve buttons are.
//
// Both sit in Home's one column (the right rail is gone) in the shared
// Rail/RailRow parts, and each is null when it has nothing to say.
//
// A HOOK returning the nodes, not components: the Overview's layout document
// places each panel independently.

import { useEffect, useState } from "react";
import type { CSSProperties, JSX } from "react";
import type { Strings } from "../lib/i18n";
import { ipc } from "../lib/ipc";
import { useVaultStore } from "../stores/vaultStore";
import { useUIStore } from "../stores/uiStore";
import type { RouteId } from "../stores/uiStore";
import { contradictionKey, setPageStatus, type Contradiction } from "../lib/contradictions";
import { stem } from "../lib/graphData";
import { useFocusTarget } from "../lib/useFocusTarget";
import { useContradictions, useNoticesStore } from "../stores/noticesStore";
import { useResurfaceStore } from "../stores/resurfaceStore";
import { TODAY_REVIEW, useStudyStore } from "../stores/studyStore";
import { Rail, RailRow } from "./Rail";
import { Button } from "./ui";

/** After Later snoozed the last pick its row is gone: keyboard focus goes to
 *  the rail's remaining button (Start review) or, with the rail gone too, to
 *  Home's management toggle — never back to <body>. */
export function refocusAfterLater(
  rail: Element | null,
  doc: Pick<Document, "querySelector">,
): void {
  const target =
    (rail?.isConnected ? rail.querySelector<HTMLElement>("button") : null) ??
    doc.querySelector<HTMLElement>(".home-management-toggle");
  target?.focus();
}

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

/** The panels, each `null` when it has nothing to say. */
export interface MorningPanels {
  contradictions: JSX.Element | null;
  reunions: JSX.Element | null;
}

const NO_PANELS: MorningPanels = {
  contradictions: null,
  reunions: null,
};

export function useMorningPanels(t: Strings): MorningPanels {
  const vault = useVaultStore((s) => s.currentVault);
  const setRoute = useUIStore((s) => s.setRoute);
  const setStudyDeck = useUIStore((s) => s.setStudyDeck);
  const resurfacePicks = useResurfaceStore((s) => s.picks);
  const dueTotal = useStudyStore((s) => s.dueTotal);
  const refreshStudy = useStudyStore((s) => s.refresh);
  const [contraError, setContraError] = useState<string | null>(null);
  // The bell's contradictions row lands here (focusSection).
  const contraRef = useFocusTarget<HTMLDivElement>("contradictions");

  // FSRS due counts for the ritual card — same refresh PageStudy runs on
  // mount, so the card is live even when Study was never visited.
  useEffect(() => {
    void refreshStudy();
  }, [refreshStudy, vault?.path]);

  // Client-side scan over the already-loaded adjacency (spec item 15) —
  // recomputed whenever the link graph refreshes, so a flip below shows up
  // as soon as refreshLinkGraph republishes. The same list the bell counts.
  const contradictions = useContradictions();

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

  const ignore = (c: Contradiction) => useNoticesStore.getState().ignoreContradiction(c);

  // Ritual section (M1-d): top resurface pick + FSRS due line. Opening the
  // pick counts as an accept (the store's self-tuning floor feeds on it);
  // 복습 시작 deep-links Study into today's review: every deck's due cards,
  // the dueTotal this line shows (UX S34).
  const ritualPick = resurfacePicks[0];
  const openRitualPick = () => {
    if (!ritualPick) return;
    useResurfaceStore.getState().open(ritualPick.page);
    setRoute(`page:${vault.path}/${ritualPick.page}` as RouteId);
  };
  const startReview = () => {
    setStudyDeck(TODAY_REVIEW);
    setRoute("study");
  };

  return {
    // No empty panel on the page: "no contradictions" is no panel at all.
    contradictions:
      contradictions.length === 0 && !contraError ? null : (
        // tabIndex: the bell's row moves keyboard focus here (useFocusTarget).
        <div ref={contraRef} className="home-contra" tabIndex={-1}>
          <Rail title={t.contra_title ?? "Contradictions"} count={contradictions.length}>
            {
              // Deliberately not a clickable RailRow: the row carries its own
              // buttons, and a button inside a button is invalid markup.
              contradictions.slice(0, 3).map((c) => (
                <RailRow key={contradictionKey(c)}>
                  <span style={STACK}>
                    <span style={NAME}>{stem(c.page)}</span>
                    <span className="meta">
                      {c.kind === "disputed"
                        ? (t.contra_disputed ?? "Two notes say different things here")
                        : (t.contra_stale ?? "Cites {t}, which is out of date").replace(
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
                            {t.contra_mark_active ?? "Mark as settled"}
                          </Button>
                          <Button
                            variant="quiet"
                            onClick={() => void flip(c, "superseded")}
                          >
                            {t.contra_mark_superseded ?? "Mark as out of date"}
                          </Button>
                        </>
                      ) : (
                        <>
                          <Button
                            variant="quiet"
                            onClick={() => setRoute(`page:${c.page}` as RouteId)}
                          >
                            {t.contra_open_page ?? "Open this note"}
                          </Button>
                          <Button
                            variant="quiet"
                            onClick={() =>
                              setRoute(`page:${vault.path}/${c.target}` as RouteId)
                            }
                          >
                            {t.contra_open_target ?? "Open the cited note"}
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
            }
            {contraError ? (
              <RailRow>
                <span className="meta">{contraError}</span>
              </RailRow>
            ) : null}
          </Rail>
        </div>
      ),
    reunions:
      ritualPick || dueTotal > 0 ? (
        <Rail title={t.ritual_title ?? "Today's reunions"}>
          {ritualPick ? (
            // Not a clickable RailRow any more: the row carries its own
            // buttons. Keep opens the pick (an accept); Later snoozes it for
            // a week, which drops it from `picks` so the next one shows.
            <RailRow>
              <span style={STACK}>
                <span style={NAME}>{ritualPick.stem}</span>
                <span className="meta">{ritualPick.snippet}</span>
                <span style={ACTS}>
                  <Button variant="quiet" onClick={openRitualPick}>
                    {t.ritual_keep}
                  </Button>
                  <Button
                    variant="quiet"
                    title={t.rs_snooze}
                    onClick={(e) => {
                      const rail = e.currentTarget.closest(".u-rail");
                      const last = resurfacePicks.length === 1;
                      useResurfaceStore.getState().snooze(ritualPick.page);
                      if (last) requestAnimationFrame(() => refocusAfterLater(rail, document));
                    }}
                  >
                    {t.ritual_later}
                  </Button>
                </span>
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
