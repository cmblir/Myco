// SINGLE SOURCE OF TRUTH for every galaxy-layout force constant (backlog A1).
//
// These numbers used to live as private consts inside graphSim.worker.ts with
// hand-maintained "mirrors" in other modules — and the mirrors drifted (e.g.
// galaxyLayout's GALAXY_ORBIT_BASE said 0.35/0.07 while the worker actually
// ran 0.32/0.06). Every layout retune then meant hunting the same knob in two
// or three files, and missing one produced the recurring "why did the shape
// regress" churn. Now the worker, the pure layout-geometry module and any test
// import the ONE definition here; cross-module invariants (e.g. a cluster's
// packing footprint must exceed its orbit ring) are unit-tested against these
// exports instead of being silently assumed.
//
// This module must stay dependency-free (plain constants only) — it is pulled
// into the sim worker bundle, the main-thread scene and vitest alike.

// --- charge / gravity ---------------------------------------------------------
export const REPEL_SCALE = 9; // slider repelForce → -charge strength
export const CENTER_SCALE = 0.13; // slider centerForce → origin gravity
export const CHARGE_RANGE_MUL = 3.2; // × linkDistance — Barnes-Hut range cap
export const CLUSTERED_GRAVITY_MUL = 0.15; // clustered nodes feel weak gravity
export const ORPHAN_GRAVITY_MUL = 0.04; // orphans barely pulled (drift check only)

// --- per-community cluster force (dandelion orbit ring) ------------------------
export const CLUSTER_SCALE = 0.18; // slider clusterForce → ring correction gain
export const HUB_PIN = 3; // hubs pinned to their cluster centroid this much harder
export const ORBIT_BASE = 0.32; // × linkDistance — ring radius floor
// × linkDistance × √count — ring growth. Raised from 0.06: these rings were
// tuned when a node was a ~2px dot, and a node now draws as a body of world
// DIAMETER size × NODE_DRAW_DIAMETER (≈24 units at the median). A 30-member
// cluster on the old ring had ~15 units of mean spacing for a 24-unit body, so
// the planets simply sat on top of each other ("따닥따닥 붙어있다"). At 0.15 the
// same cluster's ring is ~51 units and mean spacing ~27 — bodies clear of each
// other, with the cluster still reading as one puff.
export const ORBIT_GROW = 0.15;
// --- node draw size -------------------------------------------------------
// A node of a_size 1 is drawn as a sprite of world DIAMETER
// NODE_RADIUS × GLOW_SCALE. These live here, not in graphScene, because the
// layout has to pack the body that actually gets drawn: the collide force below
// used to size nodes as bare dots while the renderer drew them ~4.6× wider, and
// that mismatch is why the planets overlapped at rest.
export const NODE_RADIUS = 3.4;
// 3.2 → 2.8: that halo scale was set for the old glow star, whose soft falloff
// meant the visible core was far smaller than the point quad. A pixel sprite
// fills its quad almost edge to edge, so the same number drew a body ~14%
// wider than intended and the worlds ran into each other.
export const GLOW_SCALE = 2.8;
export const DUST_PULL = 0.18; // community-less dust drifts toward nearest cluster

// --- inter-cluster / inter-galaxy link weakening --------------------------------
export const INTER_LINK_DIST_MUL = 1.8; // cross-community links stretch longer
// Links between DIFFERENT clusters attract almost not at all, so every cluster
// floats to its OWN anchor as a distinct clump regardless of how densely the
// vault cross-links them (the anti-"뭉침" guard).
export const INTER_LINK_STR_MUL = 0.02;
// Links between top-level folders (galaxies) barely attract — otherwise the
// link force drags every folder into one merged ball.
export const INTER_GALAXY_STR_MUL = 0.02;

// --- folder-galaxies anchor + disc forces --------------------------------------
// Pull each group FIRMLY toward its own anchor. Must be strong enough that
// separation is the STABLE equilibrium — a weak pull only held the seeded
// start, and any reheat let gravity+charge collapse the galaxies into one ball.
export const ANCHOR_SCALE = 0.28;
export const ANCHOR_HUB_MUL = 2.5; // hubs anchor harder (they drag their leaves)
// Disc flattening: cancel the offset along the galaxy's spin axis — the squash
// that turns a ball of stars into something Andromeda-shaped.
export const FLATTEN_SCALE = 0.14;

// --- sim lifecycle --------------------------------------------------------------
export const SIM_ALPHA_MIN = 0.005; // settle threshold
export const BIGBANG_BURST = 22; // timelapse reveal outward velocity

// --- static atlas layout ---------------------------------------------------------
// × linkDistance — world radius the FA2 atlas map is scaled to fill, so atlas
// mode frames like the galaxy layout at the same slider values.
export const ATLAS_RADIUS_MUL = 26;
