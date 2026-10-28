import { guardedSqlViewEngine, readViewEngine } from "@fragno-dev/lofi/sqlite/worker";
import { PAGE_LIMITS } from "@fragno-private/backoffice-ui/pages/definition";

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

import { AUTOMATION_PAGE_DERIVED_RELATIONS, AUTOMATION_PAGE_VIEWS_SQL } from "./page-relations";
import {
  readAutomationRoutes,
  readLatestEventsOfType,
  readOrchestrationGraphInputs,
  readOrchestrationRecords,
  readStartedCodemodeRuns,
  readWorkflowRuns,
} from "./reads";
import {
  AUTOMATION_PAGE_VIEWS,
  AUTOMATION_READ_VIEWS,
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
 * The live SQL views pages ask the replica worker for: each page query is one SELECT over the
 * page relations, guarded so that a page cannot change the replica or stall the worker.
 */
const automationPageViewEngine = guardedSqlViewEngine({
  kind: AUTOMATION_PAGE_VIEWS,
  views: AUTOMATION_PAGE_VIEWS_SQL,
  derived: AUTOMATION_PAGE_DERIVED_RELATIONS,
  // 25 million operations take about 200 ms; the home page's eleven queries take under one
  // million together over a scope with 12,000 events.
  limits: {
    rows: PAGE_LIMITS.rowsPerQuery,
    bytes: 4_000_000,
    operations: 25_000,
    length: 16_000_000,
  },
});

/**
 * What an Automations replica worker serves, in a browser tab and in scenario tests: the replica
 * with the views its projections keep, the reads, and the pages' SQL views.
 */
export const automationReplicaHost = {
  schemas: AUTOMATION_REPLICA_SCHEMAS,
  localSchemas: automationViews.localSchemas,
  projections: automationViews.projections,
  ephemeralTables: [],
  engines: [
    readViewEngine({ kind: AUTOMATION_READ_VIEWS, reads: automationReads }),
    automationPageViewEngine,
  ],
};
