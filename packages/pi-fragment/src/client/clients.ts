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
  const useSessionDetail = builder.createHook("/sessions/:sessionId");
  const useSessionEvents = builder.createHook("/sessions/:sessionId/events", {
    onErrorRetry: ({ retryCount }) => Math.min(10_000, 500 * 2 ** Math.min(retryCount, 8)),
  });

  const useCommandSession = builder.createMutator(
    "POST",
    "/sessions/:sessionId/command",
    (invalidate, params) => {
      const sessionId = params.pathParams.sessionId;
      if (!sessionId) {
        return;
      }

      invalidate("GET", "/sessions/:sessionId", {
        pathParams: { sessionId },
      });
      invalidate("GET", "/sessions", {});
    },
  );

  const defaultSessionTransport = createStorePiSessionTransport({
    openEventsStore: ({ sessionId }) => useSessionEvents.store({ path: { sessionId } }),
    sendCommand: async ({ sessionId, command }) => {
      const ack = await useCommandSession.mutateQuery({ path: { sessionId }, body: command });
      if (!ack) {
        throw new Error("Expected command route to return an acknowledgement.");
      }
      return ack;
    },
  });

  return {
    useSessions: builder.createHook("/sessions"),
    useSessionDetail,
    useCreateSession: builder.createMutator("POST", "/sessions"),
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
