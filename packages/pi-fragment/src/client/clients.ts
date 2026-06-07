import { createClientBuilder, type FragnoPublicClientConfig } from "@fragno-dev/core/client";

import { piFragmentDefinition } from "../pi/definition";
import { piRoutesFactory } from "../routes";
import {
  createPiSessionStore,
  createStorePiSessionTransport,
  type PiSessionStoreArgs,
  type PiSessionStoreDeps,
} from "./session";

export type {
  PiLiveToolCallDraft,
  PiLiveToolExecution,
  PiSessionCommandInput,
  PiSessionConnectionStatus,
  PiSessionStoreArgs,
  PiSessionStoreDeps,
} from "./session";

export type PiFragmentClientConfig = FragnoPublicClientConfig & {
  debugActiveSession?: boolean;
};

export function createPiFragmentClients(fragnoConfig: PiFragmentClientConfig = {}) {
  const builder = createClientBuilder(piFragmentDefinition, fragnoConfig, [piRoutesFactory]);
  const useSessionDetail = builder.createHook("/workflows/:workflowName/sessions/:sessionId");
  const useSessionEvents = builder.createHook(
    "/workflows/:workflowName/sessions/:sessionId/events",
    {
      onErrorRetry: ({ retryCount }) => Math.min(10_000, 500 * 2 ** Math.min(retryCount, 8)),
    },
  );

  const useCommandSession = builder.createMutator(
    "POST",
    "/workflows/:workflowName/sessions/:sessionId/command",
    (invalidate, params) => {
      const workflowName = params.pathParams.workflowName;
      const sessionId = params.pathParams.sessionId;
      if (!workflowName || !sessionId) {
        return;
      }

      invalidate("GET", "/workflows/:workflowName/sessions/:sessionId", {
        pathParams: { workflowName, sessionId },
      });
      invalidate("GET", "/workflows/:workflowName/sessions", {
        pathParams: { workflowName },
      });
    },
  );

  const defaultSessionTransport = createStorePiSessionTransport({
    openEventsStore: ({ workflowName, sessionId }) =>
      useSessionEvents.store({ path: { workflowName, sessionId } }),
    sendCommand: async ({ workflowName, sessionId, command }) => {
      const ack = await useCommandSession.mutateQuery({
        path: { workflowName, sessionId },
        body: command,
      });
      if (!ack) {
        throw new Error("Expected command route to return an acknowledgement.");
      }
      return ack;
    },
  });

  return {
    useSessions: builder.createHook("/workflows/:workflowName/sessions"),
    useSessionDetail,
    useCreateSession: builder.createMutator("POST", "/workflows/:workflowName/sessions"),
    useSessionEvents,
    useCommandSession,
    useSession: builder.createStore(
      (args: PiSessionStoreArgs, deps?: Partial<PiSessionStoreDeps>) =>
        createPiSessionStore(args, {
          transport: deps?.transport ?? defaultSessionTransport,
          now: deps?.now,
          retryDelay: deps?.retryDelay,
        }),
    ),
  };
}
