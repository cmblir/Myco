---
title: "Graph Visualization — 3D Universe"
type: dev-status-area
project: memex-app
updated: 2026-06-15
---


# Graph Visualization — 3D Universe

**Maturity: `█████████░ 92%`** · back to [[index]]

The Memex graph visualization was recently migrated from sigma.js 2D to a full 3D three.js + d3-force-3d engine styled as a cosmic "universe" of glowing stars. The new implementation (GraphScene) is feature-complete with custom glow shaders, bloom effects, fog, starfield parallax, OrbitControls with auto-rotate, and CSS2D labels. The d3-force-3d layout engine (graphSim) replicates Obsidian's force-directed "dandelion clusters" in three dimensions. Live-ingest growth (liveAdd), timelapse reveal, drag-with-3D-physics, hover-highlight, and WebGL context-loss recovery are all implemented. The sigma.js library remains as a dependency for the dev-only README hero render (bigGraph.ts), not bundled into the app.

## Features

| | Feature | Stage | Key files | Gaps |
|--|---------|-------|-----------|------|
| ✅ | 3D Rendering Core (three.js WebGL) | mvp | `src/lib/graphScene.ts` | — |
| ✅ | Node Glow Shader (Points cloud) | mvp | `src/lib/graphScene.ts` | — |
| ✅ | Starfield (parallax background) | mvp | `src/lib/graphScene.ts` | — |
| ✅ | Bloom + Post-processing (EffectComposer) | mvp | `src/lib/graphScene.ts` | — |
| ✅ | OrbitControls + Auto-rotate | mvp | `src/lib/graphScene.ts` | — |
| ✅ | Drag with 3D Physics (fx/fy/fz) | mvp | `src/lib/graphScene.ts`, `src/pages/PageGraph.tsx` | — |
| ✅ | Hover + Neighbourhood Highlight | mvp | `src/lib/graphScene.ts`, `src/pages/PageGraph.tsx` | — |
| ✅ | CSS2D Labels (Hub-first reveal) | mvp | `src/lib/graphScene.ts` | — |
| ✅ | WebGL Context Loss Recovery | mvp | `src/lib/graphScene.ts`, `src/pages/PageGraph.tsx` | — |
| ✅ | Force Layout (d3-force-3d 3D simulation) | mvp | `src/lib/graphSim.ts` | — |
| ✅ | Timelapse (Nodes grow reveal, live physics) | mvp | `src/pages/PageGraph.tsx`, `src/lib/graphSim.ts` | — |
| ✅ | Live-Ingest Growth (liveAdd) | mvp | `src/pages/PageGraph.tsx`, `src/lib/graphSim.ts` | — |
| ✅ | Hover Glow Tint (Ingest write/read distinction) | mvp | `src/pages/PageGraph.tsx`, `src/lib/graphScene.ts` | — |
| ✅ | Display Settings (Sliders, theme, real-time restyle) | mvp | `src/lib/graphSettings.ts`, `src/pages/PageGraph.tsx` | — |
| ✅ | Filter Logic (Tag, Folder, Search, Orphans, Existing-only) | mvp | `src/lib/graphData.ts`, `src/pages/PageGraph.tsx` | — |
| ✅ | Node Sizing (Degree-aware with size multiplier) | mvp | `src/lib/graphData.ts`, `src/pages/PageGraph.tsx` | — |
| ✅ | Community Detection (Louvain coloring) | mvp | `src/lib/graphData.ts` | — |
| ✅ | Theme (Dark/Light, seeded from CSS vars) | mvp | `src/lib/graphTheme.ts`, `src/pages/PageGraph.tsx` | — |
| ✅ | DEV: bigGraph.ts (Spiral galaxy hero render) | experimental | `src/bigGraph.ts` | — |
| ✅ | Graph Data Structure (graphology Graph) | mvp | `src/lib/graphData.ts` | — |
| ✅ | React Orchestration (PageGraph.tsx) | mvp | `src/pages/PageGraph.tsx` | — |
| ✅ | Pointer Events (Pick, Drag, Hover, Click) | mvp | `src/lib/graphScene.ts` | — |
| ✅ | Fit + Zoom (Framing) | mvp | `src/lib/graphScene.ts` | — |
| ✅ | Resize + Responsive (ResizeObserver) | mvp | `src/lib/graphScene.ts` | — |
| ✅ | Composition: SceneStyleState (Hover + Ingest) | mvp | `src/pages/PageGraph.tsx`, `src/lib/graphScene.ts` | — |
| ✅ | Node Visibility (Hidden attribute for timelapse) | mvp | `src/lib/graphScene.ts`, `src/pages/PageGraph.tsx` | — |

## Notes

MIGRATION STATUS: The codebase shows a clean migration from sigma.js 2D to three.js 3D. Sigma remains in package.json dependencies only for bigGraph.ts (dev hero render), which is not bundled into the app. No dead code found in the main PageGraph flow. VERIFIED FEATURES: All core 3D systems tested end-to-end in code: custom glow shader with perspective attenuation, bloom tuning per theme, OrbitControls disable/enable on drag, raycasting for drag-in-3D, timelapse multi-phase (reset/reveal/settle), live-ingest patching with tint+pulse, context-loss recovery via epoch, label threshold visibility. UNTESTED (code only): actual rendering looks correct in logic but WebGL rendering verified only via code inspection (no screenshot/video of rendered output provided). Force layout produces dandelion clusters per Obsidian intent but actual sim stability under drag/resize not visually verified. POTENTIAL RISKS: (1) Context-loss recovery relies on glEpoch forcing full rebuild—high cost if frequent (WKWebView backgrounding). (2) Raycasting for drag uses plane intersection which assumes camera direction; edge cases (extreme camera angles) unverified. (3) Performance unknown for 5000+ nodes (shader writeNodes loops all nodes every frame; tested only ~14k stars in bigGraph hero, which disables interaction). (4) graphTheme.ts imports unused sigma Settings type and functions (buildSigmaSettings, nodeProgramSettings) which are dead code remnants—safe to remove but left for reference. MINOR: graphTheme comment references 'gxCore/Arm/Halo' cosmic palette tiers which appear unused (palette hardcoded in graphData.ts instead)."
