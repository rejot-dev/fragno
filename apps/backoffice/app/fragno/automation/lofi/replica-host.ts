import { readViewEngine } from "@fragno-dev/lofi/sqlite/worker";

import {
  readEventTrace,
  readEventTraceSummaries,
} from "@/routes/backoffice/dashboard/event-traces-replica";
import { readDashboardOverview } from "@/routes/backoffice/dashboard/overview-replica";

import {
  readAutomationRoutes,
  readLatestEventsOfType,
  readOrchestrationRecords,
  readWorkflowRuns,
} from "./reads";
import {
  AUTOMATION_READ_VIEWS,
  AUTOMATION_REPLICA_EPHEMERAL_TABLES,
  AUTOMATION_REPLICA_SCHEMAS,
} from "./replica-schemas";
import { automationViews } from "./views";

/**
 * The reads pages ask the replica worker for by name, with `automationReadView`. The worker runs
 * each with the database locked, so all of a read's queries see the same state, again after every
 * batch, and sends the result when it changed.
 */
export const automationReads = {
  dashboardOverview: readDashboardOverview,
  automationRoutes: readAutomationRoutes,
  orchestrationRecords: readOrchestrationRecords,
  latestEventsOfType: readLatestEventsOfType,
  workflowRuns: readWorkflowRuns,
  eventTraceSummaries: readEventTraceSummaries,
  eventTrace: readEventTrace,
};

/**
 * What an Automations replica worker serves, in a browser tab and in scenario tests: the replica
 * with the views its projections keep, and the reads.
 */
export const automationReplicaHost = {
  schemas: AUTOMATION_REPLICA_SCHEMAS,
  localSchemas: automationViews.localSchemas,
  projections: automationViews.projections,
  ephemeralTables: AUTOMATION_REPLICA_EPHEMERAL_TABLES,
  engines: [readViewEngine({ kind: AUTOMATION_READ_VIEWS, reads: automationReads })],
};
