import { parseBackofficeUiResult } from "@/backoffice-ui/result";
import type {
  AutomationWorkflowRun,
  WorkflowRunStep,
} from "@/routes/backoffice/automations/script-view/workflow-run-presentation";

type MarketplaceInstallationGeneratedUi =
  | { kind: "output"; value: unknown }
  | { kind: "step"; step: WorkflowRunStep };

type MarketplaceInstallationObservedStatus = AutomationWorkflowRun["status"] | null;

export function shouldShowMarketplaceInstallationStatus(input: {
  requested: boolean;
  synchronizationFailed: boolean;
  ingestionStatus: MarketplaceInstallationObservedStatus;
  installerStatus: MarketplaceInstallationObservedStatus;
}): boolean {
  if (input.requested || input.synchronizationFailed) {
    return true;
  }

  return [input.ingestionStatus, input.installerStatus].some(
    (status) =>
      status === "active" ||
      status === "paused" ||
      status === "waiting" ||
      status === "errored" ||
      status === "terminated",
  );
}

export function selectMarketplaceInstallationGeneratedUi(
  instance: AutomationWorkflowRun,
): MarketplaceInstallationGeneratedUi | null {
  if (
    instance.status === "complete" &&
    parseBackofficeUiResult(instance.output).kind !== "ordinary"
  ) {
    return { kind: "output", value: instance.output };
  }

  const step = [...instance.workflowSteps]
    .reverse()
    .find((candidate) => parseBackofficeUiResult(candidate.result).kind !== "ordinary");
  return step ? { kind: "step", step } : null;
}
