/** Test-only: the fastest of three runs of `run`, in this process's CPU ms.
 *  A loaded machine stretches wall time (a 90 ms render took 1.4 s in a full
 *  run) but not the work done, so a time budget holds on CPU time. */
export function cpuMs(run: () => unknown): number {
  let best = Infinity;
  for (let i = 0; i < 3; i++) {
    const t = process.cpuUsage();
    run();
    const d = process.cpuUsage(t);
    best = Math.min(best, (d.user + d.system) / 1000);
  }
  return best;
}
