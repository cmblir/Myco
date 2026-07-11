// Graph skins — fixed palettes must be DOM-independent (the whole point: the
// graph's colors no longer follow the app theme unless skin === "auto").
import { describe, expect, it } from "vitest";
import { skinAmbience, skinTheme } from "./graphSkins";
import { DEFAULT_GRAPH_SETTINGS, loadGraphSettings } from "./graphSettings";

describe("skinTheme (fixed skins)", () => {
  it("black pins a true-black scene background", () => {
    const t = skinTheme("black");
    expect(t.bg).toBe("#000000");
    expect(t.sceneBg).toBe("#000000");
  });

  it("white pins a white background with the light palette", () => {
    const t = skinTheme("white");
    expect(t.bg).toBe("#ffffff");
    expect(t.sceneBg).toBe("#ffffff");
    expect(t.ink).toBe("#111418");
  });

  it("galaxy pins the deep-space background with the dark palette", () => {
    const t = skinTheme("galaxy");
    expect(t.bg).toBe("#05060d");
    expect(t.sceneBg).toBe("#05060d");
    expect(t.ink).toBe("#e6e8eb");
  });

  it("returns a fresh object per call (scene code mutates themes freely)", () => {
    expect(skinTheme("black")).not.toBe(skinTheme("black"));
  });
});

describe("skinAmbience", () => {
  it("black and white strip the ambient layers", () => {
    expect(skinAmbience("black", true)).toEqual({ starfield: false, nebula: false });
    expect(skinAmbience("white", false)).toEqual({ starfield: false, nebula: false });
  });

  it("galaxy shows starfield and nebula regardless of app darkness", () => {
    expect(skinAmbience("galaxy", false)).toEqual({ starfield: true, nebula: true });
  });

  it("auto keeps the pre-skin behaviour (starfield always, nebula dark-only)", () => {
    expect(skinAmbience("auto", true)).toEqual({ starfield: true, nebula: true });
    expect(skinAmbience("auto", false)).toEqual({ starfield: true, nebula: false });
  });
});

describe("graph settings skin field", () => {
  it("defaults to auto and back-fills persisted settings missing it", () => {
    expect(DEFAULT_GRAPH_SETTINGS.skin).toBe("auto");
    // node env has no localStorage — loadGraphSettings must fall back cleanly.
    expect(loadGraphSettings().skin).toBe("auto");
  });
});
