import type { LofiSqliteReader } from "@fragno-dev/lofi/sqlite";

import {
  readAutomationRoutes,
  readWorkflowRuns,
  readWorkflowRunSummaries,
} from "@/fragno/automation/lofi/reads";
import {
  readCurrentIntegrationConnections,
  readPiAgents,
  readPiAgentTurns,
} from "@/fragno/automation/lofi/views";
import { currentWorkflowWaits } from "@/fragno/automation/workflow-waits";

/**
 * What the dashboard overview shows, read from the scope's Automations replica: the inputs of
 * `projectBackofficeDashboard`, and the agents with the turns they ended since `since`, in epoch
 * milliseconds.
 */
export function readDashboardOverview(reader: LofiSqliteReader, { since }: { since: number }) {
  const waitingRuns = readWorkflowRuns(reader, { type: "waiting" });
  // Waits follow from the waiting runs' current steps, which the overview reads anyway.
  const waits = currentWorkflowWaits(
    waitingRuns.map((run) => ({
      id: run.id,
      output: run.output,
      steps: run.workflowSteps,
      events: run.workflowEvents,
    })),
  );
  return {
    runs: readWorkflowRunSummaries(reader),
    waitingRuns,
    waits,
    connections: readCurrentIntegrationConnections(reader),
    agents: readPiAgents(reader),
    agentTurns: readPiAgentTurns(reader, new Date(since)),
    routes: readAutomationRoutes(reader),
  };
}
