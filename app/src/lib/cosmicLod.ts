// Cosmic-scale LOD — the pure math behind "far = galaxies, near = nodes".
// Given how far the camera sits from what it's looking at (relative to the
// whole vault's framed distance), decide how much the individual-node cloud
// shows vs the galaxy imposters, and name the scale for the HUD.

export type CosmicScale = "cluster" | "galaxy" | "system" | "star";

// zoom01: 0 = the framed graph (or closer), 1 = pulled far back into deep
// space. The DEFAULT view (camera at the fit distance) must sit at 0 so the
// actual node graph is what loads — imposters are a pull-BACK effect, not the
// resting state. Nodes stay full out to 1.4× the framed distance; galaxies
// take over by 3× — between is the cross-fade band.
export function zoomLevel(camDist: number, framedDist: number): number {
  if (framedDist <= 0) return 0;
  const near = framedDist * 1.4;
  const far = framedDist * 3.0;
  return Math.min(1, Math.max(0, (camDist - near) / Math.max(1e-6, far - near)));
}

// Node cloud opacity: full when close, gone when far (imposters take over).
export function nodeLodAlpha(zoom01: number): number {
  return 1 - zoom01;
}

// Imposter opacity for a single galaxy. Driven by the GLOBAL zoom (so the
// whole cluster resolves into discs together) AND that galaxy's own on-screen
// size — a galaxy you fly straight at resolves into stars a beat before the
// distant ones do.
export function imposterAlpha(zoom01: number, galaxyScreenFrac: number): number {
  // Global fade in as you pull back.
  const global = zoom01;
  // Local override: once a galaxy fills a big chunk of the view, kill its
  // imposter regardless of global zoom (you're clearly inside it).
  const local = 1 - Math.min(1, Math.max(0, (galaxyScreenFrac - 0.35) / 0.45));
  return global * local;
}

// Scale label for the HUD — what "altitude" the camera is at. Thresholds are
// on the same 0..1 zoom scale; `manyGalaxies` promotes the outermost band to
// "cluster" only when there are several galaxies to cluster.
export function cosmicScale(zoom01: number, manyGalaxies: boolean): CosmicScale {
  if (zoom01 > 0.8) return manyGalaxies ? "cluster" : "galaxy";
  if (zoom01 > 0.5) return "galaxy";
  if (zoom01 > 0.22) return "system";
  return "star";
}
