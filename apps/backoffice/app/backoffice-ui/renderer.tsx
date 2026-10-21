import { Component, type ReactNode } from "react";

import { JSONUIProvider, Renderer, type StateStore } from "@json-render/react";

import type { BackofficeUiSpec } from "./catalog";
import { backofficeUiRegistry } from "./registry";
import {
  BackofficeUiRenderContextProvider,
  useMinuteClock,
  type BackofficeUiLinks,
} from "./render-context";
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
  const now = useMinuteClock();
  return (
    <div className={fillAvailableWidth ? "w-full min-w-0" : "w-full max-w-3xl min-w-0"}>
      <WorkflowUiInteractionProvider host={workflowInteractionHost}>
        <BackofficeUiRenderContextProvider now={now} links={null}>
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
        </BackofficeUiRenderContextProvider>
      </WorkflowUiInteractionProvider>
    </div>
  );
}

/**
 * Renders a spec whose state the caller owns and keeps changing, such as live query results. The
 * caller's clock is the one its state was computed at, and its links lead within its scope.
 */
export function BackofficeUiStoreRenderer({
  spec,
  store,
  now,
  links,
}: {
  spec: BackofficeUiSpec;
  store: StateStore;
  now: number;
  links: BackofficeUiLinks;
}) {
  return (
    <div className="w-full min-w-0">
      <BackofficeUiRenderContextProvider now={now} links={links}>
        <JSONUIProvider registry={backofficeUiRegistry} store={store}>
          <Renderer spec={spec} registry={backofficeUiRegistry} />
        </JSONUIProvider>
      </BackofficeUiRenderContextProvider>
    </div>
  );
}
