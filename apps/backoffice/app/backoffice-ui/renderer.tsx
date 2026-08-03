import { Component, type ReactNode } from "react";

import { JSONUIProvider, Renderer } from "@json-render/react";

import { BackofficeUiInteractionProvider, type BackofficeUiInteractionHost } from "./interaction";
import { backofficeUiRegistry } from "./registry";
import type { BackofficeUiResultV1 } from "./result";

type BackofficeUiErrorBoundaryProps = {
  children?: ReactNode;
  fallback: ReactNode;
};

type BackofficeUiErrorBoundaryState = {
  failed: boolean;
};

export type BackofficeUiStateChange = {
  path: string;
  value: unknown;
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

export function BackofficeUiRenderer({
  interactionHost,
  onStateChange,
  ui,
}: {
  interactionHost?: BackofficeUiInteractionHost;
  onStateChange?: (changes: BackofficeUiStateChange[]) => void;
  ui: BackofficeUiResultV1["$ui"];
}) {
  return (
    <div className="w-full max-w-3xl min-w-0">
      <BackofficeUiInteractionProvider host={interactionHost}>
        <JSONUIProvider
          registry={backofficeUiRegistry}
          initialState={ui.state}
          onStateChange={onStateChange}
        >
          {interactionHost ? (
            <form
              onSubmit={(event) => {
                event.preventDefault();
              }}
            >
              <Renderer spec={ui.spec} registry={backofficeUiRegistry} />
            </form>
          ) : (
            <Renderer spec={ui.spec} registry={backofficeUiRegistry} />
          )}
        </JSONUIProvider>
      </BackofficeUiInteractionProvider>
    </div>
  );
}
