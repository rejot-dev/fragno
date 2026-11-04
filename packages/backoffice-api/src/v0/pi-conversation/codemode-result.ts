import { z } from "zod";

import { codemodeCallsSchema, type CodemodeCalls } from "../pi";

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

/** What a codemode tool result records beside its result; anything else in it is left as it is. */
const resultDetailsSchema = z.looseObject({
  logs: z.unknown().optional(),
  run: z.unknown().optional(),
  shownRuns: z.unknown().optional(),
});

// Older records name the run's workflow too; the instance alone names the run.
const workflowRunSchema = z.object({
  instanceId: z.string().refine((instanceId) => instanceId.trim() !== ""),
});

export function getCodemodeResultDetails(details: unknown): CodemodeResultDetails {
  const parsed = resultDetailsSchema.safeParse(details);
  if (!parsed.success) {
    return { hasResult: false, logs: [], result: undefined, runs: [], calls: null };
  }
  const { logs, run, shownRuns } = parsed.data;
  return {
    hasResult: "result" in parsed.data,
    logs: Array.isArray(logs) ? logs.filter((line) => typeof line === "string") : [],
    result: parsed.data["result"],
    runs: [
      ...(run == null ? [] : [parseWorkflowRunReference(run, "run")]),
      ...parseShownRuns(shownRuns),
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

/** Backoffice writes the references, so a malformed one is a bug to surface, not data to skip. */
function parseWorkflowRunReference(value: unknown, field: string): CodemodeRun {
  const parsed = workflowRunSchema.safeParse(value);
  if (!parsed.success) {
    throw invalidWorkflowRunReferenceError(field);
  }
  return parsed.data;
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
