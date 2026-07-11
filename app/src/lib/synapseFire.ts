// Idle synapse firing — every few seconds a random node "fires" a small,
// low-intensity activation ripple (1–2 hops), so an untouched graph keeps the
// living-brain feel between real interactions. Pure scheduling helpers only;
// GraphScene drives a dim WaveLayer with these.

// Seconds between spontaneous firings.
export const SYNAPSE_DELAY_MIN = 2.5;
export const SYNAPSE_DELAY_VAR = 3.5;
// Idle firings are ambience, not signal — well under the click impulse's 1.0.
export const SYNAPSE_INTENSITY = 0.35;
// Small ripples: one to two hops, tightly capped.
export const SYNAPSE_MAX_DEPTH = 2;
export const SYNAPSE_MAX_NODES = 40;
export const SYNAPSE_MAX_EDGES = 30;

export function synapseDelay(rand: number): number {
  return SYNAPSE_DELAY_MIN + rand * SYNAPSE_DELAY_VAR;
}

// Degree-weighted pick (weight 1 + √deg): hubs fire more often — activity
// concentrates where the network is dense, like real neural tissue — but every
// node keeps a floor chance. `rand` in [0,1); deterministic for a given rand.
export function pickByDegree(
  ids: string[],
  degOf: (id: string) => number,
  rand: number,
): string | null {
  if (ids.length === 0) return null;
  let total = 0;
  const weights = new Float64Array(ids.length);
  for (let i = 0; i < ids.length; i++) {
    const w = 1 + Math.sqrt(Math.max(0, degOf(ids[i])));
    weights[i] = w;
    total += w;
  }
  let target = rand * total;
  for (let i = 0; i < ids.length; i++) {
    target -= weights[i];
    if (target < 0) return ids[i];
  }
  return ids[ids.length - 1];
}
