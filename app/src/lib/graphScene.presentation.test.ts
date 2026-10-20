import * as THREE from "three";
import { describe, expect, it, vi } from "vitest";
import { GraphScene } from "./graphScene";

function sceneHarness(state: Record<string, unknown>): GraphScene {
  const scene = Object.create(GraphScene.prototype) as GraphScene;
  Object.assign(scene, state);
  return scene;
}

describe("chronicle framing", () => {
  it.each([0.55, 1.6])("keeps both rare time endpoints inside the frame at aspect %s", (aspect) => {
    const points = [
      new THREE.Vector3(-3000, -200, 0),
      ...Array.from({ length: 100 }, (_, i) => new THREE.Vector3(i, i % 20, 0)),
      new THREE.Vector3(3000, 200, 0),
    ];
    const camera = new THREE.PerspectiveCamera(58, aspect, 0.5, 40000);
    camera.position.set(0, 0, 900);
    const controls = {
      target: new THREE.Vector3(), minDistance: 8, maxDistance: 30000,
      update: () => { camera.lookAt(controls.target); camera.updateMatrixWorld(); },
    };
    const scene = sceneHarness({
      strataMode: true, nodeIds: points.map((_, i) => String(i)),
      graph: { getNodeAttributes: (id: string) => points[Number(id)] },
      camera, controls, tmpVec: new THREE.Vector3(),
      nodeMat: { uniforms: { u_fogNear: { value: 0 }, u_fogFar: { value: 0 } } },
      scene: { fog: new THREE.FogExp2(0x000000) }, timeAxis: null,
      timeAxisLabels: [],
    });
    scene.fit();
    for (const point of points) {
      const projected = point.clone().project(camera);
      expect(Math.abs(projected.x)).toBeLessThan(0.95);
      expect(Math.abs(projected.y)).toBeLessThan(0.95);
    }
  });
});

describe("spiral labels", () => {
  it("keeps community-centroid labels off in a spiral while other layouts can show them", () => {
    const setEnabled = vi.fn();
    const settings = { layout: "spiral" };
    const scene = sceneHarness({ settings, clusterLabels: { setEnabled } });
    scene.setClusterLabelsVisible(true);
    expect(setEnabled).toHaveBeenLastCalledWith(false);
    settings.layout = "galaxy";
    scene.setClusterLabelsVisible(true);
    expect(setEnabled).toHaveBeenLastCalledWith(true);
    scene.setClusterLabelsVisible(false);
    expect(setEnabled).toHaveBeenLastCalledWith(false);
  });
});

describe("look-specific atmosphere", () => {
  it.each(["spiral", "celestial"])("keeps %s free of cloud and link-density haze", (layout) => {
    const scene = sceneHarness({
      settings: { skin: "galaxy", layout }, darkTheme: true,
    });
    expect(Reflect.get(scene, "nebulaWanted").call(scene)).toBe(false);
    expect(Reflect.get(scene, "desiredDensityMode").call(scene)).toBeNull();
  });

  it("gives Woven the clouds but not the link haze over its bundles", () => {
    const scene = sceneHarness({
      settings: { skin: "galaxy", layout: "ribbon" }, darkTheme: true,
    });
    expect(Reflect.get(scene, "nebulaWanted").call(scene)).toBe(true);
    expect(Reflect.get(scene, "desiredDensityMode").call(scene)).toBeNull();
  });

  it("preserves the meaning nebula's cloud atmosphere", () => {
    const scene = sceneHarness({
      settings: { skin: "galaxy", layout: "semantic" }, darkTheme: true,
    });
    expect(Reflect.get(scene, "nebulaWanted").call(scene)).toBe(true);
    expect(Reflect.get(scene, "desiredDensityMode").call(scene)).toBe("atmo");
  });

  it.each(["void", "grid"])("does not leave decorative stars behind the %s background", (skyStyle) => {
    const scene = sceneHarness({ settings: { skyStyle } });
    const field = Reflect.get(scene, "buildStarfield").call(scene, true) as THREE.Group;
    expect(field.children).toHaveLength(0);
  });
});

describe("baked deep sky", () => {
  it.each([
    ["galaxy", true, true],
    ["auto", true, true],
    ["auto", false, false],
    ["white", false, false],
    ["black", true, false],
    ["sigma", true, false],
    ["web", true, false],
    ["mycelium", true, false],
  ] as const)("on the %s skin (dark ground %s) shows: %s", (skin, darkTheme, shown) => {
    const ground = new THREE.Color("#123456");
    const scene = sceneHarness({ settings: { skin }, darkTheme, scene: { background: ground } });
    const sky = new THREE.Texture();
    scene.setSkyTexture(sky);
    expect(Reflect.get(scene, "scene").background).toBe(shown ? sky : ground);
  });
});

describe("minimap render isolation", () => {
  it("restores the clear colour and alpha before the next nodes-only bloom pass", () => {
    const clearColor = new THREE.Color(0x000000);
    let clearAlpha = 0;
    const sceneBackground = new THREE.Color(0x000000);
    const renderer = {
      domElement: { clientHeight: 800, clientWidth: 1280 }, autoClear: true,
      getClearColor: (target: THREE.Color) => target.copy(clearColor),
      getClearAlpha: () => clearAlpha,
      setClearColor: (color: THREE.ColorRepresentation, alpha: number) => {
        clearColor.set(color); clearAlpha = alpha;
      },
      setScissorTest: vi.fn(), setViewport: vi.fn(), setScissor: vi.fn(),
      clear: vi.fn(), render: vi.fn(),
    };
    const mainScene = { background: sceneBackground };
    const scene = sceneHarness({
      minimapRect: () => ({ x: 1000, y: 600, size: 150 }),
      minimapCam: new THREE.OrthographicCamera(), minimapBoundsTick: 10,
      minimapBounds: { cx: 0, cy: 0, cz: 0, r: 100, rz: 30 },
      minimapClearColor: new THREE.Color(), minimapMarker: null,
      nodeIds: ["synthetic-note"], darkTheme: true, renderer, scene: mainScene,
      starfield: { visible: true }, meteor: { lines: { visible: true } },
      planets: { billboards: { visible: false }, moons: { visible: false } },
      nodeMat: { uniforms: { u_pixelNodes: { value: 1 } } },
    });
    const renderMinimap = Reflect.get(scene, "renderMinimap") as () => void;
    renderMinimap.call(scene);
    expect(renderer.render).toHaveBeenCalledOnce();
    expect(clearColor.getHex()).toBe(0x000000);
    expect(clearAlpha).toBe(0);
    expect(mainScene.background).toBe(sceneBackground);
  });
});
