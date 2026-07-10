import { piWorkflowStepEmissionEphemeralTable } from "@fragno-dev/pi-harness/client/pi-workflow-emission-stream";
import { createSessionProjectionDataStore } from "@fragno-dev/pi-harness/client/workflow-lofi-session-projection";
import { createPiFragmentClient } from "@fragno-dev/pi-harness/react";
import { piSchema } from "@fragno-dev/pi-harness/schema";
import type { PiSession, PiWorkflowStatus } from "@fragno-dev/pi-harness/types";
import { workflowsSchema } from "@fragno-dev/workflows/schema";

import { createLofiRuntime, createLofiRuntimeRegistry, IndexedDbAdapter } from "@fragno-dev/lofi";

const PI_LOFI_ENDPOINT = "backoffice-pi";

const sanitizeDatabaseNamePart = (value: string) => value.replace(/[^a-zA-Z0-9_-]+/g, "_");

const piWorkflowStatuses = new Set<string>([
  "active",
  "waiting",
  "paused",
  "complete",
  "errored",
  "terminated",
]);

const isPiWorkflowStatus = (value: string): value is PiWorkflowStatus =>
  piWorkflowStatuses.has(value);

const piLofiRuntimeConfig = (orgId: string) => ({
  orgId,
  key: orgId,
  dbName: `fragno_lofi_backoffice_pi_${sanitizeDatabaseNamePart(orgId)}`,
});

const piLofiRuntimes = createLofiRuntimeRegistry({
  getKey: ({ key }: ReturnType<typeof piLofiRuntimeConfig>) => key,
  createRuntime: ({ orgId, dbName }) =>
    createLofiRuntime({
      endpointName: PI_LOFI_ENDPOINT,
      adapter: new IndexedDbAdapter({
        dbName,
        endpointName: PI_LOFI_ENDPOINT,
        schemas: [{ schema: piSchema }, { schema: workflowsSchema }],
        ignoreUnknownSchemas: true,
      }),
      sources: [
        {
          id: `pi:${orgId}`,
          outboxUrl: `/api/pi/${encodeURIComponent(orgId)}/_internal/outbox`,
        },
      ],
      ephemeralTables: [piWorkflowStepEmissionEphemeralTable],
      outboxTransport: "stream",
      streamReconnectIntervalMs: 300,
    }),
});

export type PiLofiSessionListingData = {
  sessions: PiSession[];
  workflowStatuses: Record<string, PiWorkflowStatus | null>;
};

export const createPiLofiSessionListingStore = (
  orgId: string,
  workflowName: string,
  options: { initialData: PiLofiSessionListingData; limit?: number },
) => {
  const runtime = piLofiRuntimes.get(piLofiRuntimeConfig(orgId));
  const limit = options.limit ?? 50;

  return runtime
    .store()
    .retrieve(({ forSchema }) => ({
      sessions: forSchema(piSchema).find("session", (b) =>
        b
          .whereIndex("idx_session_workflow_created", (eb) => eb("workflowName", "=", workflowName))
          .orderByIndex("idx_session_workflow_created", "desc")
          .pageSize(limit)
          .select(["sessionId", "name", "agent", "workflowName", "createdAt", "updatedAt"]),
      ),
      workflows: forSchema(workflowsSchema).find("workflow_instance", (b) =>
        b
          .whereIndex("idx_workflow_instance_workflowName_instanceId", (eb) =>
            eb("workflowName", "=", workflowName),
          )
          .select(["instanceId", "status"]),
      ),
    }))
    .transformRetrieve(({ sessions, workflows }) => {
      const workflowStatusByInstanceId: Record<string, PiWorkflowStatus | null> = {};
      for (const workflow of workflows) {
        workflowStatusByInstanceId[workflow.instanceId] = isPiWorkflowStatus(workflow.status)
          ? workflow.status
          : null;
      }

      const mappedSessions = sessions.map(
        (session): PiSession => ({
          id: session.sessionId,
          name: session.name ?? null,
          agent: session.agent,
          workflowName: session.workflowName,
          createdAt: session.createdAt,
          updatedAt: session.updatedAt,
        }),
      );
      const workflowStatuses: Record<string, PiWorkflowStatus | null> = {};
      for (const session of mappedSessions) {
        workflowStatuses[session.id] = workflowStatusByInstanceId[session.id] ?? null;
      }

      return {
        sessions: mappedSessions,
        workflowStatuses,
      };
    })
    .withInitialData(options.initialData);
};

export const createPiLofiSessionProjectionStore = (
  orgId: string,
  workflowName: string,
  sessionId: string,
  options?: Parameters<typeof createSessionProjectionDataStore>[3],
) => {
  const runtime = piLofiRuntimes.get(piLofiRuntimeConfig(orgId));
  return createSessionProjectionDataStore(runtime, workflowName, sessionId, options);
};

export function createPiClient(orgId: string): ReturnType<typeof createPiFragmentClient> {
  return createPiFragmentClient({
    mountRoute: `/api/pi/${orgId}`,
    debugActiveSession: true,
  });
}
