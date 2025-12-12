import { Component, type ReactNode } from "react";

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) {
        return this.props.fallback;
      }

      return (
        <div className="border-destructive bg-destructive/10 text-destructive rounded-lg border p-4">
          <p className="font-medium">Something went wrong rendering this component.</p>
          <p className="mt-1 text-sm">{this.state.error?.message}</p>
        </div>
      );
    }

    return this.props.children;
  }
}
