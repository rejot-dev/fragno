import type { WorkflowRunReference } from "@/routes/backoffice/automations/script-view/workflow-run-presentation";

export type ExecCodeModeResultDetails = {
  hasResult: boolean;
  logs: string[];
  result: unknown;
  run: WorkflowRunReference | null;
};

export function getExecCodeModeResultDetails(details: unknown): ExecCodeModeResultDetails {
  if (!details || typeof details !== "object" || Array.isArray(details)) {
    return { hasResult: false, logs: [], result: undefined, run: null };
  }

  const resultDetails = details as Record<string, unknown>;
  return {
    hasResult: "result" in resultDetails,
    logs: Array.isArray(resultDetails.logs)
      ? resultDetails.logs.filter((line): line is string => typeof line === "string")
      : [],
    result: resultDetails.result,
    run: resultDetails.run == null ? null : parseWorkflowRunReference(resultDetails.run),
  };
}

function parseWorkflowRunReference(value: unknown): WorkflowRunReference {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw invalidWorkflowRunReferenceError();
  }

  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.workflowName !== "string" ||
    candidate.workflowName.trim().length === 0 ||
    typeof candidate.instanceId !== "string" ||
    candidate.instanceId.trim().length === 0
  ) {
    throw invalidWorkflowRunReferenceError();
  }

  return { workflowName: candidate.workflowName, instanceId: candidate.instanceId };
}

function invalidWorkflowRunReferenceError() {
  return new TypeError(
    "Invalid execCodeMode result details.run: expected non-empty workflowName and instanceId strings",
  );
}
