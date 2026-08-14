import { Component, type ReactNode } from "react";

import { JSONUIProvider, Renderer } from "@json-render/react";

import { backofficeUiRegistry } from "./registry";
import type { BackofficeUiResultV1 } from "./result";
import {
  WorkflowUiInteractionProvider,
  type WorkflowUiInteractionHost,
} from "./workflow-interaction";

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
  fillAvailableWidth = false,
  workflowInteractionHost,
  onStateChange,
  ui,
}: {
  fillAvailableWidth?: boolean;
  workflowInteractionHost?: WorkflowUiInteractionHost;
  onStateChange?: (changes: BackofficeUiStateChange[]) => void;
  ui: BackofficeUiResultV1["$ui"];
}) {
  return (
    <div className={fillAvailableWidth ? "w-full min-w-0" : "w-full max-w-3xl min-w-0"}>
      <WorkflowUiInteractionProvider host={workflowInteractionHost}>
        <JSONUIProvider
          registry={backofficeUiRegistry}
          initialState={ui.state}
          onStateChange={onStateChange}
        >
          {workflowInteractionHost ? (
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
      </WorkflowUiInteractionProvider>
    </div>
  );
}
