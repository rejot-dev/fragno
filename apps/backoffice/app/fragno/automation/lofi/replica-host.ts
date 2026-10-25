import { readViewEngine } from "@fragno-dev/lofi/sqlite/worker";

import { readPiAgentDirectory } from "@/routes/backoffice/agents/agents-replica";
import {
  readEventTrace,
  readEventTraceSummaries,
} from "@/routes/backoffice/dashboard/event-traces-replica";
import { readDashboardOverview } from "@/routes/backoffice/dashboard/overview-replica";
import {
  readIntegrationConnectionHistory,
  readWebhookDeliveries,
} from "@/routes/backoffice/integrations/integrations-replica";

import { automationPageViewEngine } from "./page-relations";
import {
  readAutomationRoutes,
  readLatestEventsOfType,
  readOrchestrationGraphInputs,
  readOrchestrationRecords,
  readStartedCodemodeRuns,
  readWorkflowRuns,
} from "./reads";
import {
  AUTOMATION_READ_VIEWS,
  AUTOMATION_REPLICA_EPHEMERAL_TABLES,
  AUTOMATION_REPLICA_SCHEMAS,
} from "./replica-schemas";
import { automationViews, readIntegrationConnections } from "./views";

/**
 * The reads pages ask the replica worker for by name, with `automationReadView`. The worker runs
 * each with the database locked, so all of a read's queries see the same state, again after every
 * batch, and sends the result when it changed.
 */
export const automationReads = {
  dashboardOverview: readDashboardOverview,
  automationRoutes: readAutomationRoutes,
  orchestrationRecords: readOrchestrationRecords,
  orchestrationGraphInputs: readOrchestrationGraphInputs,
  latestEventsOfType: readLatestEventsOfType,
  workflowRuns: readWorkflowRuns,
  startedCodemodeRuns: readStartedCodemodeRuns,
  piAgentDirectory: readPiAgentDirectory,
  integrationConnections: readIntegrationConnections,
  integrationConnectionHistory: readIntegrationConnectionHistory,
  webhookDeliveries: readWebhookDeliveries,
  eventTraceSummaries: readEventTraceSummaries,
  eventTrace: readEventTrace,
};

/**
 * What an Automations replica worker serves, in a browser tab and in scenario tests: the replica
 * with the views its projections keep, the reads, and the pages' SQL views.
 */
export const automationReplicaHost = {
  schemas: AUTOMATION_REPLICA_SCHEMAS,
  localSchemas: automationViews.localSchemas,
  projections: automationViews.projections,
  ephemeralTables: AUTOMATION_REPLICA_EPHEMERAL_TABLES,
  engines: [
    readViewEngine({ kind: AUTOMATION_READ_VIEWS, reads: automationReads }),
    automationPageViewEngine,
  ],
};
