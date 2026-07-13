// Scale-adaptive simulation cooling. A big vault's force tick is expensive, so
// the default ~185-tick settle took ~14s wall-clock at 11k — and until it
// settled the graph shimmered, the fit-timer re-framed, and every tick flooded
// an applyPositions. Cooling faster at scale converges in ~55 ticks (a huge
// graph can't relax perfectly anyway); small graphs keep the slow, pretty
// settle. Pure + unit-tested; imported by the sim worker.
export function bigGraphDecay(n: number): number {
  const t = Math.min(1, Math.max(0, (n - 2000) / 9000)); // 0 at ≤2k, 1 at 11k
  return 0.028 + t * (0.09 - 0.028);
}
