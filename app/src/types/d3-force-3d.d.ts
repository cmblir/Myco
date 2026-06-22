// Local type declarations for `d3-force-3d` (it ships no .d.ts and has no
// @types package). Mirrors the d3-force API we use, extended with the z axis
// (z / vz / fz) so the simulation runs in three dimensions. Only the surface
// graphSim.ts touches is declared; skipLibCheck keeps this from being
// over-scrutinised. Upstream: https://github.com/vasturiano/d3-force-3d
declare module "d3-force-3d" {
  export interface SimulationNodeDatum {
    index?: number;
    x?: number;
    y?: number;
    z?: number;
    vx?: number;
    vy?: number;
    vz?: number;
    fx?: number | null;
    fy?: number | null;
    fz?: number | null;
  }

  export interface SimulationLinkDatum<N extends SimulationNodeDatum> {
    source: N | string | number;
    target: N | string | number;
    index?: number;
  }

  // Second type param is the link type carried by Simulation.force(); it is not
  // referenced inside the call signature itself (underscore-prefixed per lint).
  export interface Force<N extends SimulationNodeDatum, _L> {
    (alpha: number): void;
    initialize?(nodes: N[], random?: () => number): void;
  }

  export interface Simulation<
    N extends SimulationNodeDatum,
    L extends SimulationLinkDatum<N> | undefined,
  > {
    nodes(): N[];
    nodes(nodes: N[]): this;
    alpha(): number;
    alpha(alpha: number): this;
    alphaMin(min: number): this;
    alphaDecay(decay: number): this;
    alphaTarget(target: number): this;
    velocityDecay(decay: number): this;
    force(name: string): Force<N, L> | undefined;
    force(name: string, force: Force<N, L> | null): this;
    restart(): this;
    stop(): this;
    tick(iterations?: number): this;
    on(typenames: string, listener: ((this: Simulation<N, L>) => void) | null): this;
  }

  export function forceSimulation<N extends SimulationNodeDatum>(
    nodes?: N[],
    numDimensions?: number,
  ): Simulation<N, undefined>;
  export function forceSimulation<
    N extends SimulationNodeDatum,
    L extends SimulationLinkDatum<N>,
  >(nodes?: N[], numDimensions?: number): Simulation<N, L>;

  export interface ForceLink<
    N extends SimulationNodeDatum,
    L extends SimulationLinkDatum<N>,
  > extends Force<N, L> {
    links(): L[];
    links(links: L[]): this;
    id(id: (node: N, i: number, nodesData: N[]) => string | number): this;
    distance(distance: number | ((link: L, i: number, links: L[]) => number)): this;
    strength(strength: number | ((link: L, i: number, links: L[]) => number)): this;
    iterations(iterations: number): this;
  }
  export function forceLink<
    N extends SimulationNodeDatum,
    L extends SimulationLinkDatum<N>,
  >(links?: L[]): ForceLink<N, L>;

  export interface ForceManyBody<N extends SimulationNodeDatum>
    extends Force<N, undefined> {
    strength(strength: number | ((node: N, i: number, nodes: N[]) => number)): this;
    theta(theta: number): this;
    distanceMin(distance: number): this;
    distanceMax(distance: number): this;
  }
  export function forceManyBody<N extends SimulationNodeDatum>(): ForceManyBody<N>;

  export interface ForcePositional<N extends SimulationNodeDatum>
    extends Force<N, undefined> {
    strength(strength: number | ((node: N, i: number, nodes: N[]) => number)): this;
  }
  export function forceX<N extends SimulationNodeDatum>(
    x?: number | ((node: N, i: number, nodes: N[]) => number),
  ): ForcePositional<N>;
  export function forceY<N extends SimulationNodeDatum>(
    y?: number | ((node: N, i: number, nodes: N[]) => number),
  ): ForcePositional<N>;
  export function forceZ<N extends SimulationNodeDatum>(
    z?: number | ((node: N, i: number, nodes: N[]) => number),
  ): ForcePositional<N>;

  export interface ForceCollide<N extends SimulationNodeDatum>
    extends Force<N, undefined> {
    radius(radius: number | ((node: N, i: number, nodes: N[]) => number)): this;
    strength(strength: number): this;
    iterations(iterations: number): this;
  }
  export function forceCollide<N extends SimulationNodeDatum>(
    radius?: number | ((node: N, i: number, nodes: N[]) => number),
  ): ForceCollide<N>;

  export function forceCenter<N extends SimulationNodeDatum>(
    x?: number,
    y?: number,
    z?: number,
  ): Force<N, undefined> & { strength(strength: number): unknown };

  export function forceRadial<N extends SimulationNodeDatum>(
    radius: number | ((node: N, i: number, nodes: N[]) => number),
    x?: number,
    y?: number,
    z?: number,
  ): Force<N, undefined> & {
    strength(strength: number | ((node: N, i: number, nodes: N[]) => number)): unknown;
  };
}
