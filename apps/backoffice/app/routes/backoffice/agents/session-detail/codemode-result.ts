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
  /** The run an inline workflow started, then the saved runs the program showed. */
  runs: WorkflowRunReference[];
  /** Null for results recorded before calls were kept with them. */
  calls: CodemodeCallsDetail | null;
};

/** Conversations recorded before the tool was renamed to `codemode` call it `execCodeMode`. */
export function isCodemodeTool(name: string) {
  return name === "codemode" || name === "execCodeMode";
}

export function getCodemodeResultDetails(details: unknown): CodemodeResultDetails {
  if (!details || typeof details !== "object" || Array.isArray(details)) {
    return { hasResult: false, logs: [], result: undefined, runs: [], calls: null };
  }

  const resultDetails = details as Record<string, unknown>;
  return {
    hasResult: "result" in resultDetails,
    logs: Array.isArray(resultDetails.logs)
      ? resultDetails.logs.filter((line): line is string => typeof line === "string")
      : [],
    result: resultDetails.result,
    runs: [
      ...(resultDetails.run == null ? [] : [parseWorkflowRunReference(resultDetails.run, "run")]),
      ...parseShownRuns(resultDetails.shownRuns),
    ],
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

function parseShownRuns(value: unknown): WorkflowRunReference[] {
  if (value == null) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw invalidWorkflowRunReferenceError("shownRuns");
  }
  return value.map((run: unknown) => parseWorkflowRunReference(run, "shownRuns"));
}

// Saved and inline workflows run on the same codemode host, so a handle is only its instance.
function parseWorkflowRunReference(value: unknown, field: string): WorkflowRunReference {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw invalidWorkflowRunReferenceError(field);
  }

  const candidate = value as Record<string, unknown>;
  if (typeof candidate.instanceId !== "string" || candidate.instanceId.trim().length === 0) {
    throw invalidWorkflowRunReferenceError(field);
  }

  return { workflowName: CODEMODE_WORKFLOW, instanceId: candidate.instanceId };
}

function invalidWorkflowRunReferenceError(field: string) {
  return new TypeError(
    `Invalid codemode result details.${field}: expected a non-empty instanceId string`,
  );
}
