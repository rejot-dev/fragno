import { Component, type ReactNode } from "react";

import { JSONUIProvider, Renderer } from "@json-render/react";

import { backofficeUiRegistry } from "./registry";
import type { BackofficeUiResultV1 } from "./result";

type BackofficeUiErrorBoundaryProps = {
  children?: ReactNode;
  fallback: ReactNode;
};

type BackofficeUiErrorBoundaryState = {
  failed: boolean;
};

export class BackofficeUiErrorBoundary extends Component<
  BackofficeUiErrorBoundaryProps,
  BackofficeUiErrorBoundaryState
> {
  state: BackofficeUiErrorBoundaryState = { failed: false };

  static getDerivedStateFromError(): BackofficeUiErrorBoundaryState {
    return { failed: true };
  }

  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

export function BackofficeUiRenderer({ ui }: { ui: BackofficeUiResultV1["$ui"] }) {
  return (
    <div className="w-full max-w-3xl min-w-0 border-l-2 border-[color:var(--bo-accent)] pl-3">
      <JSONUIProvider registry={backofficeUiRegistry} initialState={ui.state}>
        <Renderer spec={ui.spec} registry={backofficeUiRegistry} />
      </JSONUIProvider>
    </div>
  );
}
