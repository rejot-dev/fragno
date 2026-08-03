import type { BackofficeUiInteractionHost } from "@/backoffice-ui/interaction";
import {
  BackofficeUiErrorBoundary,
  BackofficeUiRenderer,
  type BackofficeUiStateChange,
} from "@/backoffice-ui/renderer";
import { parseBackofficeUiResult } from "@/backoffice-ui/result";

export type WorkflowEventSender = (input: {
  eventId: string;
  workflowName: string;
  instanceId: string;
  eventType: string;
  payload: unknown;
}) => Promise<void>;

export function WorkflowGeneratedUi({
  interactionHost,
  onStateChange,
  value,
}: {
  interactionHost?: BackofficeUiInteractionHost;
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
        interactionHost={interactionHost}
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
