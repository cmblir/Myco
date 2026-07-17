// A render-error boundary. React only supports error boundaries as class
// components (there is no hook equivalent), so this stays a class. Without it,
// any throw during render — e.g. a WebGL/three.js failure while building the 3D
// graph — unmounts the whole tree and blanks the window to white.

import { Component } from "react";
import type { ErrorInfo, ReactNode } from "react";
import { STRINGS } from "../lib/i18n";
import type { Strings } from "../lib/i18n";
import { useUIStore } from "../stores/uiStore";
// The still frame, imported directly — NOT MascotClip.
//
// This screen renders because something in the tree threw. MascotClip reads a
// store, sniffs the engine, and decodes alpha video; if any of that is what
// broke, mounting it here would throw inside the boundary that is supposed to
// contain the throw, and blank the window. A crash screen may only use things
// that cannot fail: an <img> and a string.
import mascotPosterUrl from "../assets/mascot/idle.poster.png";

interface Props {
  children: ReactNode;
  // Which area is being guarded. A key rather than a label so the copy stays
  // translatable; defaults to the whole app.
  area?: "app" | "graph";
  // Top-level boundary: offer a full window reload. Route-level boundaries omit
  // this so a single failing view degrades to an inline card while the sidebar
  // and other routes stay usable.
  reload?: boolean;
}

interface State {
  error: Error | null;
}

export default class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // Surface for debugging; structured telemetry can hook in here later.
    console.error("[ErrorBoundary]", error, info.componentStack);
  }

  private handleReset = (): void => {
    if (this.props.reload) window.location.reload();
    else this.setState({ error: null });
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
    const { error } = this.state;
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
        <img
          className="error-boundary__mascot"
          src={mascotPosterUrl}
          alt=""
          draggable={false}
        />
        <h2 className="error-boundary__title">{title}</h2>
        <p className="error-boundary__msg">{error.message || String(error)}</p>
        <button
          className="btn"
          type="button"
          onClick={this.handleReset}
          autoFocus
        >
          {this.props.reload
            ? (t.eb_reload ?? "Reload Memex")
            : (t.eb_retry ?? "Try again")}
        </button>
      </div>
    );
  }
}
