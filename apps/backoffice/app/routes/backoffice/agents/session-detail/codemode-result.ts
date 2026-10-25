import { CODEMODE_WORKFLOW } from "@/fragno/automation/engine/codemode-invocation";
import {
  codemodeCallsDetailSchema,
  type CodemodeCallsDetail,
} from "@/fragno/pi/extensions/backoffice/codemode-call-details";
import type { WorkflowRunReference } from "@/routes/backoffice/automations/script-view/workflow-run-presentation";

export type CodemodeResultDetails = {
  hasResult: boolean;
  logs: string[];
  result: unknown;
  run: WorkflowRunReference | null;
  /** Null for results recorded before calls were kept with them. */
  calls: CodemodeCallsDetail | null;
};

/** Conversations recorded before the tool was renamed to `codemode` call it `execCodeMode`. */
export function isCodemodeTool(name: string) {
  return name === "codemode" || name === "execCodeMode";
}

export function getCodemodeResultDetails(details: unknown): CodemodeResultDetails {
  if (!details || typeof details !== "object" || Array.isArray(details)) {
    return { hasResult: false, logs: [], result: undefined, run: null, calls: null };
  }

  const resultDetails = details as Record<string, unknown>;
  return {
    hasResult: "result" in resultDetails,
    logs: Array.isArray(resultDetails.logs)
      ? resultDetails.logs.filter((line): line is string => typeof line === "string")
      : [],
    result: resultDetails.result,
    run: resultDetails.run == null ? null : parseWorkflowRunReference(resultDetails.run),
    calls: getCodemodeCallsDetail(details),
  };
}

/** The calls in a codemode tool's details, final or while it runs. */
export function getCodemodeCallsDetail(details: unknown): CodemodeCallsDetail | null {
  if (!details || typeof details !== "object" || !("calls" in details)) {
    return null;
  }
  const parsed = codemodeCallsDetailSchema.safeParse(details.calls);
  return parsed.success ? parsed.data : null;
}

function parseWorkflowRunReference(value: unknown): WorkflowRunReference {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw invalidWorkflowRunReferenceError();
  }

  const candidate = value as Record<string, unknown>;
  if (typeof candidate.instanceId !== "string" || candidate.instanceId.trim().length === 0) {
    throw invalidWorkflowRunReferenceError();
  }

  return { workflowName: CODEMODE_WORKFLOW, instanceId: candidate.instanceId };
}

function invalidWorkflowRunReferenceError() {
  return new TypeError(
    "Invalid codemode result details.run: expected a non-empty instanceId string",
  );
}
