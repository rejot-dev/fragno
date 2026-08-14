import {
  BackofficeUiErrorBoundary,
  BackofficeUiRenderer,
  type BackofficeUiStateChange,
} from "@/backoffice-ui/renderer";
import { parseBackofficeUiResult } from "@/backoffice-ui/result";
import type { WorkflowUiInteractionHost } from "@/backoffice-ui/workflow-interaction";

export type WorkflowEventSender = (input: {
  eventId: string;
  workflowName: string;
  instanceId: string;
  eventType: string;
  payload: unknown;
}) => Promise<void>;

export function WorkflowGeneratedUi({
  fillAvailableWidth = false,
  workflowInteractionHost,
  onStateChange,
  value,
}: {
  fillAvailableWidth?: boolean;
  workflowInteractionHost?: WorkflowUiInteractionHost;
  onStateChange?: (changes: BackofficeUiStateChange[]) => void;
  value: unknown;
}) {
  const parsedResult = parseBackofficeUiResult(value);
  if (parsedResult.kind === "ordinary") {
    return null;
  }

  if (parsedResult.kind === "invalid") {
    return <WorkflowGeneratedUiUnavailable message={parsedResult.message} />;
  }

  return (
    <BackofficeUiErrorBoundary fallback={<WorkflowGeneratedUiUnavailable />}>
      <BackofficeUiRenderer
        fillAvailableWidth={fillAvailableWidth}
        workflowInteractionHost={workflowInteractionHost}
        onStateChange={onStateChange}
        ui={parsedResult.value.$ui}
      />
    </BackofficeUiErrorBoundary>
  );
}

function WorkflowGeneratedUiUnavailable({ message }: { message?: string }) {
  return (
    <p role="alert" className="text-xs text-[var(--bo-failed)]">
      {message ?? "Generated interface unavailable."}
    </p>
  );
}
