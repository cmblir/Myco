// What the notch is waiting on. One ordered list built from the three stores
// that already hold "somebody has to decide this": pending map proposals
// (distillStore), the suggested links Overview offers (linkSuggestStore +
// vaultStore's adjacency), and the harvest queue (harvestStore).
//
// The order is the whole point, and it is not by count: a DECISION someone
// must make outranks an OFFER, which outranks a QUEUE. So one map proposal is
// shown above forty link suggestions — the proposal is blocking a draft, the
// links are an invitation.
//
// This runs in the MAIN window (lib/trayStatus.ts), never inside the notch
// webview: that webview is a third JS context with no vault and no scheduler,
// so its own copies of these stores are permanently empty. The rows reach it
// pre-translated on the tray-status push, the channel that already feeds its
// lip and its task counts.

import type { Adjacency, NotchAgendaPayload, SemEdge } from "./ipc";
import { suggestLinks } from "./linkSuggestions";
import type { LinkSuggestion } from "./linkSuggestions";
import { pendingMapProposals } from "../stores/distillStore";
import type { ProposalMeta } from "../stores/distillStore";

/** How many rows the notch offers before the rest waits for the app. Three
 *  one-line rows is what fits in the card that unfolds from a cutout; a
 *  fourth turns the notch into a window, which is the thing it exists not to
 *  be. */
export const AGENDA_CAP = 3;

/** One waiting decision, still carrying the object it decides — the caller
 *  translates it (labels differ per surface) and the action paths need the
 *  proposal path / the suggestion pair, not a formatted string. */
export type AgendaItem =
  | { kind: "proposal"; id: string; proposal: ProposalMeta }
  | { kind: "link"; id: string; link: LinkSuggestion }
  /** Two or more suggestions collapse into ONE decision. Three rows meant
   *  three trips to a surface you are hovering, and the notch cannot show
   *  enough of a hash-named pair to make row-by-row judgement possible
   *  anyway — the owner's set read `source-codex-01a00124…` three times. */
  | { kind: "links"; id: "links"; count: number; links: LinkSuggestion[] }
  | { kind: "harvest"; id: "harvest"; count: number };

/** The three stores' state, unpacked so the ordering below is testable
 *  without a store, a vault or a webview. */
export interface AgendaSources {
  /** `distillStore.proposals` — filtered to pending draft-map ones here, by
   *  the same `pendingMapProposals` the activity surfaces use. */
  proposals: ProposalMeta[];
  /** `vaultStore.adjacency`. Null (no link graph yet) offers NO link rows:
   *  without it every already-linked pair reads as a fresh suggestion. */
  adjacency: Adjacency | null;
  /** `linkSuggestStore.sem` — null until the first fetch answers. */
  sem: SemEdge[] | null;
  /** `linkSuggestStore.dismissed`. */
  dismissed: ReadonlySet<string>;
  /** `harvestStore.data.items.length`. The queue is ONE decision however
   *  long it is — "harvest these" is a single yes. */
  harvestItems: number;
}

export interface NotchAgenda {
  /** Every waiting decision, counting the harvest queue as one. This is the
   *  number the collapsed notch shows; `rows` is only what fits. */
  total: number;
  rows: AgendaItem[];
}

export const EMPTY_AGENDA: NotchAgenda = { total: 0, rows: [] };

/** The three stores' state → the ordered agenda. Nothing waiting returns
 *  `EMPTY_AGENDA`'s shape, which is what keeps the collapsed notch drawing
 *  nothing at all. */
export function notchAgenda(s: AgendaSources): NotchAgenda {
  const items: AgendaItem[] = [];
  for (const proposal of pendingMapProposals(s.proposals)) {
    items.push({ kind: "proposal", id: proposal.path, proposal });
  }
  // Uncapped: the cap below applies to the WHOLE agenda, so a page of link
  // suggestions must not decide it before the proposals have been counted.
  const links =
    s.adjacency && s.sem
      ? suggestLinks(s.adjacency, s.sem, s.dismissed, Number.POSITIVE_INFINITY)
      : [];
  if (links.length === 1) {
    items.push({ kind: "link", id: links[0].key, link: links[0] });
  } else if (links.length > 1) {
    items.push({ kind: "links", id: "links", count: links.length, links });
  }
  if (s.harvestItems > 0) {
    items.push({ kind: "harvest", id: "harvest", count: s.harvestItems });
  }
  return { total: items.length, rows: items.slice(0, AGENDA_CAP) };
}

/** Drop the rows already decided, and take them off the count with them. The
 *  decision is a write in the main window and only comes back as an absence
 *  on the NEXT push (a second or more later, and only once the store has
 *  refreshed) — without this the row a user just approved sits there still
 *  offering to approve it. `total` shrinks too, so the collapsed count never
 *  reads higher than the rows behind it. */
export function withoutActed(
  agenda: NotchAgendaPayload | null,
  acted: ReadonlySet<string>,
): NotchAgendaPayload | null {
  if (!agenda) return null;
  const rows = agenda.rows.filter((r) => !acted.has(r.id));
  const dropped = agenda.rows.length - rows.length;
  return dropped === 0
    ? agenda
    : { total: Math.max(0, agenda.total - dropped), rows };
}
