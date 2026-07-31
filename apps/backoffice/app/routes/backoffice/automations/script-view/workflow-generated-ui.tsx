import { BackofficeUiErrorBoundary, BackofficeUiRenderer } from "@/backoffice-ui/renderer";
import { parseBackofficeUiResult } from "@/backoffice-ui/result";

export function WorkflowGeneratedUi({ value }: { value: unknown }) {
  const parsedResult = parseBackofficeUiResult(value);
  if (parsedResult.kind === "ordinary") {
    return null;
  }

  if (parsedResult.kind === "invalid") {
    return <WorkflowGeneratedUiUnavailable message={parsedResult.message} />;
  }

  return (
    <BackofficeUiErrorBoundary fallback={<WorkflowGeneratedUiUnavailable />}>
      <BackofficeUiRenderer ui={parsedResult.value.$ui} />
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
