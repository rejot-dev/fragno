import type { LofiSqliteReplica } from "@fragno-dev/lofi/sqlite";

import {
  readAutomationEventsSince,
  readAutomationRoutes,
  readWorkflowRuns,
  readWorkflowRunSummaries,
} from "@/fragno/automation/lofi/reads";
import {
  readCurrentIntegrationConnections,
  readPiAgents,
  readPiAgentTurns,
} from "@/fragno/automation/lofi/views";
import { currentWorkflowWaits } from "@/fragno/automation/tanstack/workflow-waits";

/**
 * What the dashboard overview shows, read from the scope's Automations replica: the inputs of
 * `projectBackofficeDashboard`, and the agents with the turns they ended since `since`.
 */
export async function readDashboardOverview(replica: LofiSqliteReplica, since: Date) {
  const [runs, waitingRuns, events, connections, agents, agentTurns, routes] = await Promise.all([
    readWorkflowRunSummaries(replica),
    readWorkflowRuns(replica, { type: "waiting" }),
    readAutomationEventsSince(replica, since),
    readCurrentIntegrationConnections(replica),
    readPiAgents(replica),
    readPiAgentTurns(replica, since),
    readAutomationRoutes(replica),
  ]);
  // Waits follow from the waiting runs' current steps, which the overview reads anyway.
  const waits = currentWorkflowWaits(
    waitingRuns.map((run) => ({ id: run.id, output: run.output, steps: run.workflowSteps })),
  );
  return { runs, waitingRuns, waits, events, connections, agents, agentTurns, routes };
}
