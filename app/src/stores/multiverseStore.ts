// Multiverse store. Tracks the registered projects ("universes") and their
// per-universe link graphs for the multiverse view. Kept SEPARATE from
// vaultStore so the single-vault flow (open/edit/save one vault) is never
// perturbed by the multi-project machinery — the two stores share nothing but
// the IPC layer.
//
// Loading is lazy + parallel: loadProjects() fetches the registry listing
// cheaply, then each universe's graph is built on demand (loadUniverse) or all
// at once (loadAll). Only the ACTIVE universe is auto-refreshed; the rest are
// static snapshots (a far universe that isn't being edited doesn't need to
// re-poll), matching the perf model in the multiverse proposal.

import { create } from "zustand";
import { ipc } from "../lib/ipc";
import type { Adjacency, ProjectInfo } from "../lib/ipc";
import { universeHue } from "../lib/multiverseLayout";

// One universe's slice of the multiverse: its registry metadata, identity hue,
// and its link graph (null until built). `loading`/`error` are per-universe so
// one project's build failure doesn't blank the others.
export interface UniverseData {
  info: ProjectInfo;
  hue: number;
  adjacency: Adjacency | null;
  loading: boolean;
  error: string | null;
}

export interface MultiverseState {
  universes: Record<string, UniverseData>;
  order: string[]; // slug order as listed by the registry
  activeSlug: string | null;
  isLoading: boolean; // top-level (registry listing) load
  error: string | null;
  // False when the open vault has no registry above it (listProjects empty) —
  // the UI reads this as "multiverse unavailable, stay in single-vault".
  available: boolean;
  loadProjects: () => Promise<void>;
  loadUniverse: (slug: string) => Promise<void>;
  loadAll: () => Promise<void>;
  refreshUniverse: (slug: string) => Promise<void>;
  setActiveUniverse: (slug: string) => Promise<void>;
  reset: () => void;
}

// Monotonic guards so a slow in-flight load can never overwrite a newer one
// (mirrors vaultStore's openSeq/refreshSeq). Registry listing has one counter;
// each universe's graph build has its own so parallel loads don't clobber.
let projectsSeq = 0;
const uniSeq = new Map<string, number>();

// Pure: registry listing → the store's universe slice. Exported so the derive
// step (hue assignment, active pointer, order) is unit-testable without IPC.
export function deriveUniverses(projects: ProjectInfo[]): {
  universes: Record<string, UniverseData>;
  order: string[];
  activeSlug: string | null;
} {
  const universes: Record<string, UniverseData> = {};
  const order: string[] = [];
  let activeSlug: string | null = null;
  for (const info of projects) {
    order.push(info.slug);
    universes[info.slug] = {
      info,
      hue: universeHue(info.slug),
      adjacency: null,
      loading: false,
      error: null,
    };
    if (info.active) activeSlug = info.slug;
  }
  return { universes, order, activeSlug };
}

export const useMultiverseStore = create<MultiverseState>((set, get) => ({
  universes: {},
  order: [],
  activeSlug: null,
  isLoading: false,
  error: null,
  available: false,

  async loadProjects() {
    const seq = ++projectsSeq;
    set({ isLoading: true, error: null });
    try {
      const projects = await ipc.listProjects();
      if (seq !== projectsSeq) return; // a newer listing won
      const { universes, order, activeSlug } = deriveUniverses(projects);
      // Preserve any graphs already built for surviving slugs, so re-listing
      // (e.g. after a project switch) doesn't drop loaded adjacencies.
      const prev = get().universes;
      for (const slug of order) {
        const p = prev[slug];
        if (p?.adjacency) {
          universes[slug] = { ...universes[slug], adjacency: p.adjacency };
        }
      }
      set({
        universes,
        order,
        activeSlug,
        available: order.length > 0,
        isLoading: false,
      });
    } catch (err) {
      if (seq !== projectsSeq) return;
      set({ error: errorMessage(err), isLoading: false, available: false });
    }
  },

  async loadUniverse(slug) {
    if (!get().universes[slug]) return; // unknown slug — listProjects first
    const seq = (uniSeq.get(slug) ?? 0) + 1;
    uniSeq.set(slug, seq);
    patchUniverse(set, slug, { loading: true, error: null });
    try {
      const adjacency = await ipc.buildLinkGraphAt(slug);
      if (seq !== uniSeq.get(slug)) return; // a newer load of THIS universe won
      if (!get().universes[slug]) return; // universe vanished (reset/re-list)
      patchUniverse(set, slug, { adjacency, loading: false });
    } catch (err) {
      if (seq !== uniSeq.get(slug)) return;
      patchUniverse(set, slug, { error: errorMessage(err), loading: false });
    }
  },

  async loadAll() {
    await get().loadProjects();
    // Build every universe's graph concurrently; a single failure is captured
    // on that universe and doesn't reject the whole batch.
    await Promise.all(get().order.map((slug) => get().loadUniverse(slug)));
  },

  async refreshUniverse(slug) {
    if (!get().universes[slug]) return;
    const seq = (uniSeq.get(slug) ?? 0) + 1;
    uniSeq.set(slug, seq);
    try {
      const adjacency = await ipc.buildLinkGraphAt(slug);
      if (seq !== uniSeq.get(slug)) return;
      const cur = get().universes[slug];
      if (!cur) return;
      // Only commit when the graph actually changed — an unchanged rebuild must
      // not churn a new adjacency object (the scene keys off it). BTreeMap JSON
      // is key-sorted, so equal content serializes identically.
      if (sameJSON(cur.adjacency, adjacency)) return;
      patchUniverse(set, slug, { adjacency });
    } catch (err) {
      if (seq !== uniSeq.get(slug)) return;
      patchUniverse(set, slug, { error: errorMessage(err) });
    }
  },

  async setActiveUniverse(slug) {
    if (!get().universes[slug]) return;
    try {
      await ipc.setActiveProject(slug);
      // Reflect the switch locally; the registry `active` flag will agree on the
      // next loadProjects. Camera/scene handoff is the scene tier's job.
      set((state) => ({
        activeSlug: slug,
        universes: remapActive(state.universes, slug),
      }));
    } catch (err) {
      set({ error: errorMessage(err) });
    }
  },

  reset() {
    uniSeq.clear();
    set({
      universes: {},
      order: [],
      activeSlug: null,
      isLoading: false,
      error: null,
      available: false,
    });
  },
}));

// Immutably patch one universe's slice, leaving the others (and their loaded
// graphs) untouched. No-op if the slug was removed between call and commit.
function patchUniverse(
  set: (fn: (s: MultiverseState) => Partial<MultiverseState>) => void,
  slug: string,
  patch: Partial<UniverseData>,
): void {
  set((state) => {
    const cur = state.universes[slug];
    if (!cur) return {};
    return { universes: { ...state.universes, [slug]: { ...cur, ...patch } } };
  });
}

// Return a universes record whose `info.active` flags match `activeSlug` — so
// the derived listing stays internally consistent before the next re-list.
function remapActive(
  universes: Record<string, UniverseData>,
  activeSlug: string,
): Record<string, UniverseData> {
  const out: Record<string, UniverseData> = {};
  for (const [slug, u] of Object.entries(universes)) {
    const active = slug === activeSlug;
    out[slug] = active === u.info.active ? u : { ...u, info: { ...u.info, active } };
  }
  return out;
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  return "unknown error";
}

function sameJSON(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
