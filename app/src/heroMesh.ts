// DEV-ONLY hero render: a ~10k-node SYNTHETIC vault rendered with the REAL
// neural-mesh scene (three.js GraphScene + d3-force-3d + buildGraph), for the
// README hero image / GIF. Captured via Playwright against the vite dev server
// (npm run dev → /hero-mesh.html). The data is fully synthetic (curated LLM/ML
// topic words only) so the published image leaks no real vault content. Never
// bundled into the app — no entry imports this; hero-mesh.html is dev-served.
import { buildGraph, computeAllowed, type VaultGraph } from "./lib/graphData";
import { createSim } from "./lib/graphSim";
import { GraphScene } from "./lib/graphScene";
import { readTheme } from "./lib/graphTheme";
import { DEFAULT_GRAPH_SETTINGS } from "./lib/graphSettings";
import type { Adjacency } from "./lib/ipc";

// Safe, on-theme topic words → become the labelled hub "MOC" nodes. No real
// vault names, no private data.
const TOPICS = [
  "transformer", "attention", "rlhf", "scaling-laws", "tokenizer", "embedding",
  "fine-tuning", "lora", "quantization", "distillation", "pretraining",
  "alignment", "diffusion", "gan", "cnn", "rnn", "lstm", "optimizer",
  "gradient-descent", "backprop", "regularization", "dropout", "batchnorm",
  "activation", "softmax", "cross-entropy", "perplexity", "beam-search",
  "sampling", "temperature", "mixture-of-experts", "retrieval", "rag",
  "vector-db", "prompt-engineering", "chain-of-thought", "agent", "tool-use",
  "mcp", "context-window", "kv-cache", "flash-attention", "rope", "layernorm",
  "residual", "encoder", "decoder", "bert", "gpt", "llama", "mistral", "clip",
  "whisper", "stable-diffusion", "reinforcement-learning", "policy-gradient",
  "q-learning", "actor-critic", "ppo", "dpo", "constitutional-ai",
  "instruction-tuning", "few-shot", "zero-shot", "in-context-learning",
  "hallucination", "benchmark", "evaluation", "dataset", "data-curation",
];

// A vault-shaped link graph: ~70 topic hubs ("maps of content"), each a dense,
// INTERWOVEN cluster of notes. The notes don't just hang off their hub (that
// draws as a radial firework); they cross-link to each other WITHIN the cluster
// (an entangled neural mesh per lobe) and to a few nearby clusters (inter-lobe
// tracts), so the whole thing relaxes into one interconnected brain/galaxy
// instead of a field of separate star-bursts. Plus unresolved "ghost" links.
function buildSyntheticVault(): { adjacency: Adjacency; allFiles: string[] } {
  const forward: Record<string, string[]> = {};
  const unresolved: Record<string, string[]> = {};
  const files: string[] = [];
  const hubs = TOPICS.map((t) => `${t}.md`);
  // Leaves grouped by their topic index, so intra-cluster weaving can pick
  // same-lobe partners (a tight neural knot) and inter-cluster tracts can reach
  // a NEIGHBOURING topic rather than a random far one.
  const leavesByTopic: string[][] = TOPICS.map(() => []);
  const link = (a: string, b: string): void => {
    if (a !== b) (forward[a] ??= []).push(b);
  };
  for (const h of hubs) files.push(h);

  for (let hi = 0; hi < hubs.length; hi++) {
    const hub = hubs[hi];
    const topic = TOPICS[hi];
    const leafCount = 90 + Math.floor(Math.random() * 110); // 90..200
    for (let k = 0; k < leafCount; k++) {
      const leaf = `${topic}-${k}.md`;
      files.push(leaf);
      leavesByTopic[hi].push(leaf);
      link(leaf, hub); // leaf → its hub (the cluster spine)
      if (Math.random() < 0.05) {
        // ghost link → not-yet-created note (renders as a dim ghost node)
        (unresolved[leaf] ??= []).push(`todo-${topic}-${k}`);
      }
    }
  }

  // --- intra-cluster weave: every leaf threads to 1–3 SIBLINGS in its own lobe.
  // This is what turns each hub-and-spokes star into an entangled neural knot —
  // the dominant edge population, so clusters read as woven tissue, not spikes.
  for (const sibs of leavesByTopic) {
    if (sibs.length < 3) continue;
    for (const leaf of sibs) {
      const n = 1 + Math.floor(Math.random() * 3); // 1..3 sibling threads
      for (let i = 0; i < n; i++) {
        link(leaf, sibs[Math.floor(Math.random() * sibs.length)]);
      }
    }
  }

  // --- inter-cluster tracts: ~14% of leaves reach into a NEARBY topic's cluster
  // (wrap-around neighbour window), weaving adjacent lobes together so the galaxy
  // is one connected web with visible bridges, not isolated blobs.
  for (let hi = 0; hi < leavesByTopic.length; hi++) {
    for (const leaf of leavesByTopic[hi]) {
      if (Math.random() >= 0.14) continue;
      const step = 1 + Math.floor(Math.random() * 6); // reach 1..6 topics over
      const oj = (hi + (Math.random() < 0.5 ? -step : step) + TOPICS.length) % TOPICS.length;
      const pool = leavesByTopic[oj];
      // half the tracts land on the neighbour's hub (a strong bridge), half on a
      // random member (a faint capillary).
      link(leaf, Math.random() < 0.5 || pool.length === 0 ? hubs[oj] : pool[Math.floor(Math.random() * pool.length)]);
    }
  }

  // --- hub backbone: each hub links to 2..4 other hubs → the bright core lattice.
  for (let hi = 0; hi < hubs.length; hi++) {
    const n = 2 + Math.floor(Math.random() * 3);
    const targets = new Set<string>();
    for (let i = 0; i < n; i++) {
      const o = Math.floor(Math.random() * hubs.length);
      if (o !== hi) targets.add(hubs[o]);
    }
    (forward[hubs[hi]] ??= []).push(...targets);
  }

  return {
    adjacency: { forward, backward: {}, unresolved, tags: {} },
    allFiles: files,
  };
}

function main(): void {
  const container = document.getElementById("app") as HTMLDivElement | null;
  if (!container) return;

  const theme = readTheme();
  // Galaxy/brain tuning: SHORT links + GENTLE local repulsion collapse each topic
  // cluster into a tight luminous nucleus (hub-leaf edges shrink to a glowing
  // knot instead of long radial firework spikes), and a FIRM centre gravity packs
  // all ~70 nuclei into one cohesive galaxy with a dense core fading to a halo.
  // Still the real renderer + real forces (range-capped charge in graphSim).
  const s = {
    ...DEFAULT_GRAPH_SETTINGS,
    repelForce: 9,
    linkDistance: 26,
    centerForce: 0.5,
    clusterForce: 0.5, // contract Louvain communities into coloured lobes/nuclei
    brightness: 0.58, // tame the dense-core bloom white-out → colours/structure read
  };
  const { adjacency, allFiles } = buildSyntheticVault();
  const allowed = computeAllowed(adjacency, allFiles, {
    tagFilter: null,
    folderFilter: null,
    vaultRoot: "",
    search: "",
    existingOnly: false,
    showOrphans: true,
  });
  const graph: VaultGraph = buildGraph(adjacency, allowed, {
    nodeSize: s.nodeSize,
    starDim: theme.starDim,
    edgeColor: theme.edge,
    showGhosts: true,
  });

  const w = window as unknown as {
    __graphReady?: boolean;
    __nodeCount?: number;
    __edgeCount?: number;
  };
  w.__nodeCount = graph.order;
  w.__edgeCount = graph.size;
  if (graph.order === 0) return;

  const noop = (): void => undefined; // hero render is non-interactive
  const scene = new GraphScene(container, graph, theme, s, {
    onNodeClick: noop,
    onNodeHover: noop,
    onDragStart: noop,
    onDrag: noop,
    onDragEnd: noop,
    onContextRestored: noop,
  });
  // The sim runs in a worker now; each tick posts a position array we hand
  // straight to the scene (which also mirrors it back into the graph).
  const sim = createSim(graph, s, (positions) => scene.applyPositions(positions));
  scene.start();

  // Re-frame the cluster as the large seeded sphere contracts into the mesh.
  const fitTimer = window.setInterval(() => scene.fit(), 450);
  const finish = (): void => {
    window.clearInterval(fitTimer); // stop re-fitting so the zoom-in below sticks
    scene.fit();
    scene.zoomIn(); // tighten: fit() leaves a wide margin, fill more of the frame
    scene.zoomIn();
    w.__graphReady = true;
  };
  sim.onSettle(finish);
  // Safety: a 10k-node sim may not reach alphaMin in the capture window.
  window.setTimeout(finish, 20000);

  console.info("[heroMesh]", graph.order, "nodes,", graph.size, "edges");
}

main();
