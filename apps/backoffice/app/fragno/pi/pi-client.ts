import { createSessionProjectionDataStore } from "@fragno-dev/pi-harness/client/workflow-lofi-session-projection";
import { createPiFragmentClient } from "@fragno-dev/pi-harness/react";
import { workflowsSchema } from "@fragno-dev/workflows/schema";

import { createLofiRuntime, createLofiRuntimeRegistry, IndexedDbAdapter } from "@fragno-dev/lofi";

const PI_LOFI_ENDPOINT = "backoffice-pi";

const sanitizeDatabaseNamePart = (value: string) => value.replace(/[^a-zA-Z0-9_-]+/g, "_");

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
        schemas: [{ schema: workflowsSchema }],
        ignoreUnknownSchemas: true,
      }),
      sources: [
        {
          id: `pi-workflows:${orgId}`,
          outboxUrl: `/api/pi-workflows/${encodeURIComponent(orgId)}/_internal/outbox`,
        },
      ],
      outboxTransport: "stream",
      streamReconnectIntervalMs: 300,
    }),
});

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
