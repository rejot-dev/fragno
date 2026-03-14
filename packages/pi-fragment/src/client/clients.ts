import { createClientBuilder, type FragnoPublicClientConfig } from "@fragno-dev/core/client";

import { piFragmentDefinition } from "../pi/definition";
import { piRoutesFactory } from "../routes";
import type { CreatePiSessionStoreDependencies } from "./session-store";
import { createPiSessionControllerStore } from "./session-controller";

export type PiFragmentClientConfig = FragnoPublicClientConfig & {
  debugActiveSession?: boolean;
};

const createActiveSessionLogger = (
  enabled: boolean | undefined,
): CreatePiSessionStoreDependencies["activeLogger"] => {
  if (!enabled) {
    return undefined;
  }

  return (event, details) => {
    console.log(`[pi-active] ${event}`, details ?? {});
  };
};

export function createPiFragmentClients(fragnoConfig: PiFragmentClientConfig) {
  const builder = createClientBuilder(piFragmentDefinition, fragnoConfig, [piRoutesFactory]);
  const useSessionDetail = builder.createHook("/sessions/:sessionId");
  const useSendMessage = builder.createMutator(
    "POST",
    "/sessions/:sessionId/messages",
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
  const { fetcher, defaultOptions } = builder.getFetcher();
  const sessionStoreDependencies = {
    createDetailStore: (sessionId) =>
      useSessionDetail.store({ path: { sessionId } }) as ReturnType<
        CreatePiSessionStoreDependencies["createDetailStore"]
      >,
    sendMessage: ({ sessionId, text, done, steeringMode }) =>
      useSendMessage
        .mutateQuery({
          path: { sessionId },
          body: {
            text,
            done,
            steeringMode,
          },
        })
        .then((result) => {
          if (!result) {
            throw new Error("The message mutation did not return a status response.");
          }
          return result;
        }),
    buildActiveUrl: (sessionId) =>
      builder.buildUrl("/sessions/:sessionId/active", {
        path: { sessionId },
      }),
    fetcher,
    defaultOptions,
    enableActiveStream: typeof window === "undefined" ? false : undefined,
    activeLogger: createActiveSessionLogger(fragnoConfig.debugActiveSession),
  } satisfies CreatePiSessionStoreDependencies;
  return {
    useSessions: builder.createHook("/sessions"),
    useSessionDetail,
    useSession: builder.createStore(createPiSessionControllerStore(sessionStoreDependencies)),
    useCreateSession: builder.createMutator("POST", "/sessions"),
    useActiveSession: builder.createHook("/sessions/:sessionId/active"),
    useSendMessage,
  };
}
