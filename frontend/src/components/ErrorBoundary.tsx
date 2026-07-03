import React from 'react';

type Props = {
  children: React.ReactNode;
};

type State = {
  hasError: boolean;
  message: string;
  stack?: string;
};

export class ErrorBoundary extends React.Component<Props, State> {
  state: State = { hasError: false, message: '' };

  static getDerivedStateFromError(error: unknown): State {
    return {
      hasError: true,
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    };
  }

  componentDidCatch(error: unknown) {
    console.error('Dashboard render error:', error);
  }

  render() {
    if (this.state.hasError) {
      return (
        <main className="appShell">
          <section className="card span2">
            <div className="cardHeader">
              <div>
                <h2>Errore nella dashboard</h2>
                <p>La pagina non è più bianca: ora l'errore resta visibile.</p>
              </div>
            </div>
            <div className="errorBox">
              <strong>{this.state.message}</strong>
              {this.state.stack ? <pre className="errorStack">{this.state.stack}</pre> : null}
            </div>
            <button type="button" onClick={() => this.setState({ hasError: false, message: '', stack: undefined })}>
              Riprendi
            </button>
          </section>
        </main>
      );
    }

    return this.props.children;
  }
}
