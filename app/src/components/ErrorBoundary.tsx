// A render-error boundary. React only supports error boundaries as class
// components (there is no hook equivalent), so this stays a class. Without it,
// any throw during render — e.g. a WebGL/three.js failure while building the 3D
// graph — unmounts the whole tree and blanks the window to white.

import { Component } from "react";
import type { ErrorInfo, ReactNode } from "react";

interface Props {
  children: ReactNode;
  // Short label for the area being guarded, e.g. "the graph". Defaults to "the app".
  area?: string;
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

  override render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    const area = this.props.area ?? "the app";
    return (
      <div className="error-boundary" role="alert">
        <h2 className="error-boundary__title">Something went wrong in {area}.</h2>
        <p className="error-boundary__msg">{error.message || String(error)}</p>
        <button
          className="btn"
          type="button"
          onClick={this.handleReset}
          autoFocus
        >
          {this.props.reload ? "Reload Memex" : "Try again"}
        </button>
      </div>
    );
  }
}
