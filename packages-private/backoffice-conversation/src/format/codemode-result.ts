import { codemodeCallsSchema, type CodemodeCalls } from "@fragno-dev/backoffice-api/v0/pi";

/**
 * A workflow run a codemode program started or showed. Saved and inline workflows run on the same
 * codemode host, so a run is only its instance.
 */
export type CodemodeRun = { instanceId: string };

export type CodemodeResultDetails = {
  hasResult: boolean;
  logs: string[];
  result: unknown;
  /** The run an inline workflow started, then the saved runs the program showed. */
  runs: CodemodeRun[];
  /** Null for results recorded before calls were kept with them. */
  calls: CodemodeCalls | null;
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

function parseShownRuns(value: unknown): CodemodeRun[] {
  if (value == null) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw invalidWorkflowRunReferenceError("shownRuns");
  }
  return value.map((run: unknown) => parseWorkflowRunReference(run, "shownRuns"));
}

function parseWorkflowRunReference(value: unknown, field: string): CodemodeRun {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw invalidWorkflowRunReferenceError(field);
  }

  const candidate = value as Record<string, unknown>;
  if (typeof candidate.instanceId !== "string" || candidate.instanceId.trim().length === 0) {
    throw invalidWorkflowRunReferenceError(field);
  }

  return { instanceId: candidate.instanceId };
}

function invalidWorkflowRunReferenceError(field: string) {
  return new TypeError(
    `Invalid codemode result details.${field}: expected a non-empty instanceId string`,
  );
}

/**
 * The calls a tool's details recorded, final or while it runs: a codemode run's. Other tools, and
 * codemode results from before calls were kept with them, have none.
 */
export function getCodemodeCallsDetail(details: unknown): CodemodeCalls | null {
  if (!details || typeof details !== "object" || !("calls" in details)) {
    return null;
  }
  const parsed = codemodeCallsSchema.safeParse(details.calls);
  return parsed.success ? parsed.data : null;
}
