import { lofiSqliteTableName, type LofiSqliteReader } from "@fragno-dev/lofi/sqlite";
import { workflowsSchema } from "@fragno-dev/workflows/schema";

import { CODEMODE_WORKFLOW } from "@/fragno/automation/engine/codemode-invocation";
import { readAutomationRoutes } from "@/fragno/automation/lofi/reads";

type CodemodeRunTrigger =
  | { type: "event"; event: { source: string; eventType: string } }
  | { type: "manual" };

const workflowTable = (name: keyof typeof workflowsSchema.tables) =>
  `"${lofiSqliteTableName({ schema: workflowsSchema }, name)}"`;

// A run's params hold its whole program, so the reads take only what they need from them.
const SCRIPT_PATH = `"params" ->> '$.program.filename'`;
// Saved workflows run from their script. An agent's inline workflow runs once from a script of its
// own, which the agent names under `/pi/` (see `codemode-tool.ts`), so it is no workflow to follow.
const SAVED_SCRIPT_RUN = `"workflowName" = ? AND ${SCRIPT_PATH} IS NOT NULL
  AND ${SCRIPT_PATH} NOT LIKE '/pi/%'`;

/**
 * What the Workflows tab lists: each saved workflow script that ran, with how many of its runs
 * failed and its latest run, and the routes, which start scripts that may not have run yet.
 */
export function readWorkflowList(reader: LofiSqliteReader) {
  const instance = workflowsSchema.tables.workflow_instance.columns;
  // With max(), SQLite takes the bare columns from the row holding the maximum.
  const scripts = reader.query({
    sql: `SELECT ${SCRIPT_PATH} AS "scriptPath", "remoteWorkflowName", "status", "createdAt",
            count(*) AS "runCount", sum("status" = 'errored') AS "erroredCount", max("createdAt")
          FROM ${workflowTable("workflow_instance")}
          WHERE ${SAVED_SCRIPT_RUN}
          GROUP BY "scriptPath"
          ORDER BY "scriptPath"`,
    params: [CODEMODE_WORKFLOW],
    columns: {
      scriptPath: "text",
      remoteWorkflowName: instance.remoteWorkflowName,
      status: instance.status,
      createdAt: instance.createdAt,
      runCount: "integer",
      erroredCount: "integer",
    },
  });
  return { scripts, routes: readAutomationRoutes(reader) };
}

/**
 * The latest `limit` runs of the workflow script at `scriptPath`, newest first, each with the steps
 * it recorded in the order it recorded them.
 */
export function readWorkflowScriptRuns(
  reader: LofiSqliteReader,
  { scriptPath, limit }: { scriptPath: string; limit: number },
) {
  const { workflow_instance, workflow_step } = workflowsSchema.tables;
  const instance = workflow_instance.columns;
  const step = workflow_step.columns;
  // Steps reference a run by its internal ID.
  const internalId = `"${workflow_instance.getInternalIdColumn().name}"`;
  const latest = `FROM ${workflowTable("workflow_instance")}
    WHERE ${SAVED_SCRIPT_RUN} AND ${SCRIPT_PATH} = ?
    ORDER BY "createdAt" DESC, "id" DESC
    LIMIT ?`;
  const params = [CODEMODE_WORKFLOW, scriptPath, limit];

  const runs = reader.query({
    sql: `SELECT ${internalId} AS "ref", "instanceId", "remoteWorkflowName", "status",
            "params" -> '$.trigger' AS "trigger",
            "errorName", "errorMessage", "createdAt", "completedAt", "updatedAt"
          ${latest}`,
    params,
    columns: {
      ref: "integer",
      instanceId: instance.instanceId,
      remoteWorkflowName: instance.remoteWorkflowName,
      status: instance.status,
      trigger: instance.params,
      errorName: instance.errorName,
      errorMessage: instance.errorMessage,
      createdAt: instance.createdAt,
      completedAt: instance.completedAt,
      updatedAt: instance.updatedAt,
    },
  });
  // Rows a run's tick writes share one `createdAt`, so ties break by the replica's internal ID,
  // which follows the order the backend wrote them in.
  const steps = reader.query({
    sql: `SELECT "instanceRef" AS "ref", "id", "name", "status", "attempts", "errorName", "errorMessage"
          FROM ${workflowTable("workflow_step")}
          WHERE "instanceRef" IN (SELECT ${internalId} ${latest})
          ORDER BY "createdAt", "${workflow_step.getInternalIdColumn().name}"`,
    params,
    columns: {
      ref: "integer",
      id: "text",
      name: step.name,
      status: step.status,
      attempts: step.attempts,
      errorName: step.errorName,
      errorMessage: step.errorMessage,
    },
  });

  const stepsByRun = new Map<number, Omit<(typeof steps)[number], "ref">[]>();
  for (const { ref, ...row } of steps) {
    const runSteps = stepsByRun.get(ref);
    if (runSteps) {
      runSteps.push(row);
    } else {
      stepsByRun.set(ref, [row]);
    }
  }
  return runs.map(({ ref, trigger, ...run }) => ({
    ...run,
    // Codemode writes every run's trigger as one of these.
    trigger: trigger as CodemodeRunTrigger,
    steps: stepsByRun.get(ref) ?? [],
  }));
}

/**
 * The saved workflow script the Codemode run `instanceId` ran; null for a run of none, such as an
 * agent's inline workflow, or a run that is not in the replica.
 */
export function readWorkflowRunScript(
  reader: LofiSqliteReader,
  { instanceId }: { instanceId: string },
): string | null {
  const [run] = reader.query({
    sql: `SELECT ${SCRIPT_PATH} AS "scriptPath"
          FROM ${workflowTable("workflow_instance")}
          WHERE ${SAVED_SCRIPT_RUN} AND "instanceId" = ?`,
    params: [CODEMODE_WORKFLOW, instanceId],
    columns: { scriptPath: "text" },
  });
  return run?.scriptPath ?? null;
}
