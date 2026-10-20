// The crash screen offers ways out: Try again, Home (main window), and a
// copyable bug report, with the raw message folded under Details. No DOM:
// the boundary's crash state is rendered to markup, its handlers are called
// directly (a throwing child cannot be caught by the server renderer).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ErrorBoundary, { crashReportFor } from "./ErrorBoundary";
import { useUIStore } from "../stores/uiStore";
import { useNoticeStore } from "../stores/noticeStore";
import { STRINGS } from "../lib/i18n";

const t = STRINGS.ko;

function crashed(props: { home?: boolean } = {}): ErrorBoundary {
  const eb = new ErrorBoundary({ children: null, area: "graph", ...props });
  eb.state = { error: new Error("boom at <node>"), copy: null };
  // Not mounted: record state changes instead of scheduling a render.
  eb.setState = vi.fn((patch) => {
    eb.state = { ...eb.state, ...(patch as object) };
  }) as unknown as ErrorBoundary["setState"];
  return eb;
}
const markup = (eb: ErrorBoundary) => renderToStaticMarkup(eb.render() as ReactElement);

beforeEach(() => {
  useUIStore.setState({ lang: "ko" });
  useNoticeStore.setState({ notices: [] });
  vi.stubGlobal("__PACKAGE_VERSION__", "9.9.9-test");
});
afterEach(() => vi.unstubAllGlobals());

describe("ErrorBoundary crash screen", () => {
  it("offers Try again, Home and Copy a bug report, the message under Details", () => {
    const html = markup(crashed({ home: true }));
    for (const label of [t.eb_retry, t.eb_home, t.cr_copy]) expect(html).toContain(`>${label}</button>`);
    expect(html).toMatch(/<details[^>]*><summary>자세히<\/summary>.*boom at &lt;node&gt;.*<\/details>/s);
  });

  it("offers Home only where there is a Home to go to (not the tray or spotlight)", () => {
    expect(markup(crashed())).not.toContain(t.eb_home);
  });

  it("Home routes to overview and leaves the crash screen", () => {
    useUIStore.getState().setRoute("graph");
    const eb = crashed({ home: true });
    eb.goHome();
    expect(useUIStore.getState().route).toBe("overview");
    expect(eb.state.error).toBeNull();
  });

  // Neither boundary knows which pane crashed, and the split is persisted: a
  // crash in it came straight back after Home (graph card) or the reload (top).
  it("Home closes the split pane too, where a crashed view may sit", () => {
    useUIStore.setState({ route: "tasks", splitRoute: "graph" });
    const eb = crashed({ home: true });
    eb.goHome();
    expect(useUIStore.getState()).toMatchObject({ route: "overview", splitRoute: null });
    expect(eb.state.error).toBeNull();
  });

  it("the top-level Home clears a persisted split before it reloads", () => {
    const reload = vi.fn(() => {
      // What the reload will read back.
      expect(useUIStore.getState().splitRoute).toBeNull();
    });
    vi.stubGlobal("window", { location: { reload } });
    useUIStore.setState({ route: "overview", splitRoute: "tasks" });
    const eb = new ErrorBoundary({ children: null, reload: true, home: true });
    eb.goHome();
    expect(reload).toHaveBeenCalledOnce();
    expect(useUIStore.getState()).toMatchObject({ route: "overview", splitRoute: null });
  });

  it("copies a crash report with the error and says so", async () => {
    const writeText = vi.fn(() => Promise.resolve());
    vi.stubGlobal("navigator", { clipboard: { writeText }, userAgent: "test-agent" });
    const eb = crashed();
    await eb.copyReport();
    const text = (writeText.mock.calls[0] as unknown as [string])[0];
    expect(text).toContain("### Crash report");
    expect(text).toContain("9.9.9-test");
    expect(text).toContain("boom at <node>");
    expect(useNoticeStore.getState().notices.at(-1)).toMatchObject({ kind: "ok", title: t.cr_copied });
    // The button says it too: the top-level boundary has no toast stack left.
    expect(markup(eb)).toContain(`>${t.cr_copied}</button>`);
  });

  it("warns when the clipboard refuses", async () => {
    vi.stubGlobal("navigator", {
      clipboard: { writeText: () => Promise.reject(new Error("denied")) },
      userAgent: "test-agent",
    });
    const eb = crashed();
    await eb.copyReport();
    expect(useNoticeStore.getState().notices.at(-1)).toMatchObject({
      kind: "warn",
      title: t.q_copy_failed,
    });
    // On the screen too: the top-level and satellite boundaries have no toasts.
    expect(markup(eb)).toContain(`>${t.q_copy_failed}</button>`);
  });

  it("puts the component stack under the error in the report", () => {
    const e = new Error("kaput");
    const text = crashReportFor(e, "\n    at PageGraph");
    expect(text).toContain("kaput");
    expect(text).toContain("at PageGraph");
  });

  // JavaScriptCore (WKWebView, the macOS app) puts frames only in Error#stack;
  // V8 starts it with "Error: message", which is all Node ever shows a test.
  it("names the error and its message even when the stack holds frames only", () => {
    const e = new TypeError("Error creating WebGL context.");
    e.stack = "WebGLRenderer@http://x/three.js:1:1\nGraphScene@http://x/graphScene.ts:2:2";
    const text = crashReportFor(e, "");
    expect(text).toContain("TypeError: Error creating WebGL context.\nWebGLRenderer@http://x/three.js:1:1");
  });

  it("does not repeat the message when the stack already starts with it", () => {
    const text = crashReportFor(new Error("kaput"), "");
    expect(text.split("Error: kaput")).toHaveLength(2);
  });

  // MYCO's worried clip loads lazily (none of it in the entry chunk), so the
  // screen renders without it first and with it once the import lands. Its
  // 112 px slot is there from the first frame: a box that appeared with the
  // import pushed the title and the buttons down 63 px on a painted screen.
  it("reserves MYCO's slot before the clip module lands, and fills it with the still and clip after", () => {
    const eb = crashed();
    const before = markup(eb);
    expect(before).toContain('<span class="error-boundary__mascot-box" aria-hidden="true"></span>');
    expect(before).not.toContain("<img");
    eb.state = { ...eb.state, mascot: { poster: "/w.poster.png", src: "/w.webm" } };
    const html = markup(eb);
    expect(html).toMatch(/<span class="error-boundary__mascot-box" aria-hidden="true"><img class="error-boundary__mascot" src="\/w.poster.png"/);
    expect(html).toContain('src="/w.webm"');
  });

  it("keeps the still alone when the clip may not play", () => {
    const eb = crashed();
    eb.state = { ...eb.state, mascot: { poster: "/w.poster.png", src: null } };
    const html = markup(eb);
    expect(html).toContain('src="/w.poster.png"');
    expect(html).not.toContain("<video");
  });
});
