import { Component, type ErrorInfo, type ReactNode } from "react";

/**
 * The last wall before a white screen. A render throw anywhere below this boundary swaps
 * the broken screen for a reload button — the owner keeps the shell, the navigation and
 * every other tab's work, and the error is logged rather than swallowed.
 *
 * Deliberately no i18n dependency: if the tree that broke included the language store,
 * the fallback must still be readable, so it states itself in both languages the app ships.
 */
interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // The app logs nothing client-side by design; a render crash is the one thing worth
    // putting in the console, because that is where the owner pastes it from.
    console.error("render_failed", { message: error.message, stack: info.componentStack });
  }

  override render(): ReactNode {
    if (!this.state.error) return this.props.children;
    return (
      <div className="page" role="alert">
        <h1>Something here stopped drawing / Màn hình này vừa lỗi</h1>
        <p className="muted">{this.state.error.message}</p>
        <div className="row">
          <button className="primary" onClick={() => window.location.reload()}>
            Reload / Tải lại
          </button>
          <button onClick={() => this.setState({ error: null })}>Try again / Thử lại</button>
        </div>
      </div>
    );
  }
}
