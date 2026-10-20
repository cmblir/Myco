import Graph from "graphology";
import * as THREE from "three";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClusterLabels } from "./clusterLabels";
import { resolveClusterTopic } from "./clusterTopics";
import type { GraphNodeAttrs, VaultGraph } from "./graphData";
import { GraphScene } from "./graphScene";

vi.mock("./clusterTopics", () => ({ resolveClusterTopic: vi.fn() }));

// CSS2DObject only needs this DOM surface; layout/ellipsis is checked in a browser.
class LabelElement {
  className = "";
  textContent = "";
  title = "";
  style: Record<string, string> = {};
  parentNode = null;
  ownerDocument = { defaultView: { Element: LabelElement } };
  classList = { remove: vi.fn(), toggle: vi.fn() };
  setAttribute = vi.fn();
  remove = vi.fn();
}

function graphWithNodes(
  nodes: { id: string; label: string; deg: number }[],
): VaultGraph {
  const graph: VaultGraph = new Graph();
  for (const node of nodes) {
    const attrs: GraphNodeAttrs = {
      label: node.label, deg: node.deg, community: 0, galaxy: 0,
      color: "#aabbcc", size: 1, isHub: false, intensity: 0,
      x: 0, y: 0, z: 0,
    };
    graph.addNode(node.id, attrs);
  }
  return graph;
}

const supportingNodes = [
  { id: "/synthetic/context.md", label: "Context", deg: 1 },
  { id: "/synthetic/details.md", label: "Details", deg: 2 },
];

beforeEach(() => {
  vi.stubGlobal("document", { createElement: () => new LabelElement() });
  vi.mocked(resolveClusterTopic).mockReset().mockResolvedValue(null);
});
afterEach(() => vi.unstubAllGlobals());

describe("community label names", () => {
  it("prefers the highest-degree real note over a more connected missing note", () => {
    const ghost = "ghost:synthetic-project-with-a-very-long-unwritten-reference";
    const real = "/synthetic/project-plan.md";
    const labels = new ClusterLabels(graphWithNodes([
      { id: ghost, label: "Unwritten reference", deg: 90 },
      { id: real, label: "프로젝트 계획과 다음 단계", deg: 20 },
      { id: "/synthetic/summary.md", label: "Summary", deg: 5 },
    ]));
    expect(labels.shown[0].el.textContent).toBe("프로젝트 계획과 다음 단계");
    expect(labels.shown[0].el.title).toBe("프로젝트 계획과 다음 단계");
    expect(vi.mocked(resolveClusterTopic).mock.calls[0][1]).toEqual([
      real, "/synthetic/summary.md", ghost,
    ]);
    labels.dispose();
  });

  it("keeps a ghost-only community's display name without its synthetic prefix", () => {
    const labels = new ClusterLabels(graphWithNodes([
      { id: "ghost:synthetic:missing-design", label: "Missing Design", deg: 9 },
      { id: "ghost:synthetic:missing-idea", label: "Missing Idea", deg: 2 },
      { id: "ghost:synthetic:missing-note", label: "Missing Note", deg: 1 },
    ]));
    expect(labels.shown[0].el.textContent).toBe("Missing Design");
    labels.dispose();
  });

  it.each([
    "API",
    "한글 제목을 줄이거나 다시 쓰지 않고 화면에서만 길이를 제한하는 커뮤니티 이름",
    "a-long-note-slug-that-keeps-its-original-meaning-and-case-API-v2",
  ])("preserves the full name while constraining its display: %s", (name) => {
    const labels = new ClusterLabels(graphWithNodes([
      { id: `/synthetic/${name}.md`, label: name, deg: 10 },
      ...supportingNodes,
    ]));
    const label = labels.shown[0].el;
    const mobileWidth = labels.setViewportWidth(320);
    expect(mobileWidth).toBeGreaterThan(0);
    expect(mobileWidth).toBeLessThanOrEqual(320 * 0.4);
    expect(parseFloat(label.style.maxWidth)).toBe(mobileWidth);
    expect(labels.setViewportWidth(1280)).toBeLessThanOrEqual(240);
    expect(label.textContent).toBe(name);
    expect(label.title).toBe(name);
    labels.rebuild();
    expect(parseFloat(labels.shown[0].el.style.maxWidth)).toBeLessThanOrEqual(240);
    labels.dispose();
  });

  it("uses the same width limit and full accessible name after an async topic arrives", async () => {
    const topic = "아주 긴 한글 커뮤니티 주제 이름";
    let resolveTopic!: (value: string) => void;
    vi.mocked(resolveClusterTopic).mockReturnValue(new Promise((resolve) => {
      resolveTopic = resolve;
    }));
    const labels = new ClusterLabels(graphWithNodes([
      { id: "/synthetic/plan.md", label: "Plan", deg: 10 },
      ...supportingNodes,
    ]));
    labels.setViewportWidth(375);
    resolveTopic(topic);
    await Promise.resolve();
    expect(labels.shown[0].el.textContent).toBe(topic);
    expect(labels.shown[0].el.title).toBe(topic);
    expect(parseFloat(labels.shown[0].el.style.maxWidth)).toBeLessThanOrEqual(150);
    labels.dispose();
  });
});

describe("community label decluttering", () => {
  it.each([320, 1280])("reserves the rendered label width at canvas width %s", (width) => {
    const labels = new ClusterLabels(graphWithNodes([
      { id: "/synthetic/long-note.md", label: "아주 긴 커뮤니티 제목 ".repeat(12), deg: 10 },
      ...supportingNodes,
    ]));
    const camera = new THREE.PerspectiveCamera(58, width / 800, 0.5, 40000);
    camera.position.set(0, 0, 900);
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld();
    const placedBoxes: { x0: number; x1: number }[] = [];
    const scene = Object.create(GraphScene.prototype) as GraphScene;
    Object.assign(scene, {
      interacting: false, container: { clientWidth: width, clientHeight: 800 },
      sizeScale: () => 1, settings: { textFadeThreshold: 1.8 },
      style: { hoveredNode: null }, camera, controls: { target: new THREE.Vector3() },
      framedDist: 900, clusterLabels: labels, labelCandidates: new Set(),
      labelRank: [], shownLabels: new Set(), placedBoxes,
      tmpVec: new THREE.Vector3(), labelBoxes: [],
    });
    const updateLabels = Reflect.get(scene, "updateLabels") as () => void;
    updateLabels.call(scene);
    expect(placedBoxes).toHaveLength(1);
    const boxWidth = placedBoxes[0].x1 - placedBoxes[0].x0;
    expect(boxWidth).toBeCloseTo(Math.min(240, width * 0.4));
    expect(parseFloat(labels.shown[0].el.style.maxWidth)).toBeCloseTo(boxWidth);
    labels.dispose();
  });
});
