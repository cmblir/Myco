// A render-error boundary. React only supports error boundaries as class
// components (there is no hook equivalent), so this stays a class. Without it,
// any throw during render — e.g. a WebGL/three.js failure while building the 3D
// graph — unmounts the whole tree and blanks the window to white.

import { Component } from "react";
import type { ErrorInfo, ReactNode } from "react";
import { STRINGS } from "../lib/i18n";
import type { Strings } from "../lib/i18n";
import { formatCrashReport } from "../lib/crashReport";
import { notice } from "../lib/notice";
import { useUIStore } from "../stores/uiStore";
// MYCO here is NOT MascotClip.
//
// This screen renders because something in the tree threw. MascotClip reads a
// store, sniffs the engine, and decodes alpha video; if any of that is what
// broke, mounting it here would throw inside the boundary that is supposed to
// contain the throw, and blank the window. A crash screen may only use things
// that cannot fail: an <img>, a <video> that falls back to it, and a string.
// The worried clip is imported lazily (this module is in the entry chunk);
// if that import fails, MYCO's slot simply stays empty.
interface CrashMascot {
  poster: string;
  src: string | null;
}

interface Props {
  children: ReactNode;
  // Which area is being guarded. A key rather than a label so the copy stays
  // translatable; defaults to the whole app.
  area?: "app" | "graph";
  // Top-level boundary: offer a full window reload. Route-level boundaries omit
  // this so a single failing view degrades to an inline card while the sidebar
  // and other routes stay usable.
  reload?: boolean;
  // Main-window boundaries: offer a way back to Home. "Try again" re-renders
  // the same view, which throws again when the fault is in the view.
  home?: boolean;
}

interface State {
  error: Error | null;
  /** How the last "Copy a bug report" went. Shown on the button itself: the
   *  top-level and satellite boundaries have no toast stack left. */
  copy: null | "ok" | "failed";
  /** MYCO's worried clip and its still, once the clip module has loaded. */
  mascot?: CrashMascot | null;
  /** The clip proved it plays (the still hides), or it is over (the still
   *  returns): a lit still under an alpha clip reads as two characters. */
  clipPhase?: "still" | "playing" | "done";
}

/** The bug report for a render error: its type and message, its stack, then
 *  where in the tree. */
export function crashReportFor(error: Error, componentStack: string): string {
  // V8's stack starts with "Error: message"; JavaScriptCore's (WKWebView, the
  // macOS app) holds frames only, which left the message out of the report.
  const head = String(error);
  const stack = error.stack ?? "";
  const body = stack.startsWith(head) ? stack : `${head}\n${stack}`;
  return formatCrashReport({
    appVersion: __PACKAGE_VERSION__,
    // No IPC here: this screen may only use what cannot fail.
    osVersion: navigator.userAgent,
    panicLine: `${body}${componentStack}`,
  });
}

export default class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null, copy: null };
  private componentStack = "";

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error, copy: null };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // Surface for debugging; structured telemetry can hook in here later.
    console.error("[ErrorBoundary]", error, info.componentStack);
    this.componentStack = info.componentStack ?? "";
    void import("../lib/mascotClips").then(
      ({ crashMascot, wantsHevc }) => {
        // Read defensively: the store may be what broke.
        let mascotEnabled = false;
        let reduced = true;
        try {
          mascotEnabled = useUIStore.getState().mascotEnabled;
          reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
        } catch (e) {
          console.error("[ErrorBoundary] MYCO stays still", e);
        }
        const mascot = crashMascot({
          mascotEnabled,
          reduced,
          hidden: document.hidden,
          hevc: wantsHevc(),
        });
        this.setState({ mascot, clipPhase: "still" });
      },
      (e: unknown) => console.error("[ErrorBoundary] MYCO's clip did not load", e),
    );
  }

  private handleReset = (): void => {
    if (this.props.reload) window.location.reload();
    else this.setState({ error: null });
  };

  goHome = (): void => {
    try {
      // The crash may sit in the split pane, and neither boundary knows which
      // pane threw: close the split too, or the persisted splitRoute brings
      // the crashing view straight back (after the reload, too).
      useUIStore.setState({ splitRoute: null });
      useUIStore.getState().setRoute("overview");
    } catch (e) {
      // The store may be what broke; the reset below still leaves this screen.
      console.error("[ErrorBoundary] route to Home failed", e);
    }
    this.handleReset();
  };

  copyReport = (): Promise<void> => {
    const { error } = this.state;
    if (!error) return Promise.resolve();
    const t = this.strings();
    // Inside the chain, so a missing clipboard API lands in the warning too.
    const report = crashReportFor(error, this.componentStack);
    return Promise.resolve()
      .then(() => navigator.clipboard.writeText(report))
      .then(
        () => {
          this.setState({ copy: "ok" });
          notice.ok(t.cr_copied);
        },
        (e: unknown) => {
          this.setState({ copy: "failed" });
          notice.warn(t.q_copy_failed, { sub: String(e) });
        },
      );
  };

  /**
   * Strings for the crash screen.
   *
   * A class cannot use hooks, and the top-level boundary must survive the case
   * where the store itself is what threw — so read the language non-reactively
   * and fall back to English if anything about that read goes wrong. Losing
   * live language switching costs nothing here: a crash screen renders once.
   */
  private strings(): Strings {
    try {
      return STRINGS[useUIStore.getState().lang] ?? STRINGS.en;
    } catch {
      return STRINGS.en;
    }
  }

  override render(): ReactNode {
    const { error, mascot, clipPhase } = this.state;
    if (!error) return this.props.children;
    const t = this.strings();
    const area =
      this.props.area === "graph"
        ? (t.eb_area_graph ?? "the graph")
        : (t.eb_area_app ?? "the app");
    const title = (t.eb_title ?? "Something went wrong in {area}.").replace(
      "{area}",
      area,
    );
    return (
      <div className="error-boundary" role="alert">
        {/* The slot is there from the first frame, so the lazy clip lands
            without moving the title and buttons; it stays empty if the
            import fails. */}
        <span className="error-boundary__mascot-box" aria-hidden>
          {mascot ? (
            <img
              className="error-boundary__mascot"
              src={mascot.poster}
              alt=""
              draggable={false}
              style={{ opacity: clipPhase === "playing" ? 0 : 1 }}
            />
          ) : null}
          {mascot?.src && clipPhase !== "done" ? (
            <video
              className="error-boundary__mascot"
              src={mascot.src}
              autoPlay
              muted
              playsInline
              style={{ opacity: clipPhase === "playing" ? 1 : 0 }}
              onPlaying={() => this.setState({ clipPhase: "playing" })}
              onEnded={() => this.setState({ clipPhase: "done" })}
              onError={() => this.setState({ clipPhase: "done" })}
            />
          ) : null}
        </span>
        <h2 className="error-boundary__title">{title}</h2>
        <div className="error-boundary__actions">
          <button
            className="btn"
            type="button"
            onClick={this.handleReset}
            autoFocus
          >
            {this.props.reload
              ? (t.eb_reload ?? "Reload myco")
              : (t.eb_retry ?? "Try again")}
          </button>
          {this.props.home ? (
            <button className="btn" type="button" onClick={this.goHome}>
              {t.eb_home ?? "Go to Home"}
            </button>
          ) : null}
          <button className="btn btn-ghost" type="button" onClick={() => void this.copyReport()}>
            {this.state.copy === "ok"
              ? (t.cr_copied ?? "Copied")
              : this.state.copy === "failed"
                ? (t.q_copy_failed ?? "Couldn't copy to the clipboard")
                : (t.cr_copy ?? "Copy a bug report")}
          </button>
        </div>
        <details className="error-boundary__details">
          <summary>{t.eb_details ?? "Details"}</summary>
          <p className="error-boundary__msg">{error.message || String(error)}</p>
        </details>
      </div>
    );
  }
}
