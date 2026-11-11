import type { WorkflowInstanceStatus } from "@fragno-dev/workflows/workflow";
import type {
  WorkflowHealthRun,
  WorkflowHealthRunStep,
} from "@fragno-private/design-system/workflow-runs/workflow-health";

import { AUTOMATION_SCHEDULE_SOURCE } from "@/fragno/automation/route-triggers";

import { describeScheduleCadence } from "./overview";
import type { readWorkflowList, readWorkflowScriptRuns } from "./workflows-replica";

/** A saved workflow, by its script, with how its runs have been doing. */
export type WorkflowListEntry = {
  scriptPath: string;
  name: string;
  /** What starts it, in words, one for each route that does. */
  startedBy: string[];
  runCount: number;
  erroredCount: number;
  latestRun: { status: WorkflowInstanceStatus; at: Date } | null;
};

/**
 * The scope's saved workflows by name: every script that ran, and every script a route starts,
 * which may not have run yet.
 */
export function projectWorkflowList({
  scripts,
  routes,
}: ReturnType<typeof readWorkflowList>): WorkflowListEntry[] {
  const startedBy = new Map<string, string[]>();
  for (const route of routes) {
    if (!route.enabled || route.action.kind !== "start_workflow") {
      continue;
    }
    const words =
      route.trigger.kind === "schedule"
        ? describeScheduleCadence(route.trigger.cadence)
        : `${route.trigger.source} · ${route.trigger.eventType}`;
    const path = route.action.workflowScriptPath;
    startedBy.set(path, [...(startedBy.get(path) ?? []), words]);
  }

  const entries = new Map<string, WorkflowListEntry>(
    scripts.map((script) => [
      script.scriptPath,
      {
        scriptPath: script.scriptPath,
        name: script.remoteWorkflowName ?? scriptName(script.scriptPath),
        startedBy: startedBy.get(script.scriptPath) ?? [],
        runCount: script.runCount,
        erroredCount: script.erroredCount,
        // The workflow schema stores status as a string; the runner persists only its own states.
        latestRun: { status: script.status as WorkflowInstanceStatus, at: script.createdAt },
      },
    ]),
  );
  for (const [scriptPath, words] of startedBy) {
    if (!entries.has(scriptPath)) {
      entries.set(scriptPath, {
        scriptPath,
        name: scriptName(scriptPath),
        startedBy: words,
        runCount: 0,
        erroredCount: 0,
        latestRun: null,
      });
    }
  }
  return [...entries.values()].sort(
    (left, right) =>
      left.name.localeCompare(right.name) || left.scriptPath.localeCompare(right.scriptPath),
  );
}

/** A script's file name without its folders and `.workflow.js`, for a script that never ran. */
function scriptName(scriptPath: string): string {
  return scriptPath.slice(scriptPath.lastIndexOf("/") + 1).replace(/\.workflow\.js$/, "");
}

type WorkflowScriptRunRecord = ReturnType<typeof readWorkflowScriptRuns>[number];

type PersistedStepStatus = "completed" | "errored" | "waiting";

const STEP_STATUSES: Record<PersistedStepStatus, WorkflowHealthRunStep["status"]> = {
  completed: "completed",
  errored: "failed",
  waiting: "waiting",
};

/** A script's runs as `WorkflowHealth` shows them, in the order they came. */
export function projectWorkflowHealthRuns(
  records: readonly WorkflowScriptRunRecord[],
): WorkflowHealthRun[] {
  return records.map((record) => {
    const run = {
      id: record.instanceId,
      trigger: describeRunTrigger(record.trigger),
      // The runner stamps `startedAt` when the first tick commits, after the first step ran, so
      // durations count from when the run was created, as the run's timeline does.
      startedAt: record.createdAt.getTime(),
      steps: record.steps.map(
        (step): WorkflowHealthRunStep => ({
          id: step.id,
          name: step.name,
          // The workflow schema stores status as a string; the runner persists only these.
          status: STEP_STATUSES[step.status as PersistedStepStatus],
          attempts: step.attempts,
        }),
      ),
    };
    const endedAt = (record.completedAt ?? record.updatedAt).getTime();
    // The workflow schema stores status as a string; the runner persists only its own states.
    const status = record.status as WorkflowInstanceStatus;
    switch (status) {
      case "active":
      case "waiting":
      case "paused":
        return { ...run, status };
      case "complete":
      case "terminated":
        return { ...run, status, endedAt };
      case "errored":
        return {
          ...run,
          status,
          endedAt,
          error: record.errorMessage ?? record.errorName ?? "The run failed without an error.",
          failedStepId: failedStepId(record),
        };
    }
  });
}

/**
 * The step whose failure ended an errored run. A run may catch a step's failure and go on, which
 * leaves that step errored too, so the failure is the last errored step's only when the run ended
 * with that step's error; otherwise the run failed outside every step.
 */
function failedStepId(record: WorkflowScriptRunRecord): string | null {
  const last = [...record.steps].reverse().find((step) => step.status === "errored");
  return last !== undefined &&
    last.errorName === record.errorName &&
    last.errorMessage === record.errorMessage
    ? last.id
    : null;
}

function describeRunTrigger(trigger: WorkflowScriptRunRecord["trigger"]): string {
  if (trigger.type === "manual") {
    return "Manual";
  }
  return trigger.event.source === AUTOMATION_SCHEDULE_SOURCE
    ? "On schedule"
    : `${trigger.event.source} · ${trigger.event.eventType}`;
}
