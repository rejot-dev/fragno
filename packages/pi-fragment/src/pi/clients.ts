import { createClientBuilder, type FragnoPublicClientConfig } from "@fragno-dev/core/client";

import { piFragmentDefinition } from "./definition";
import { piRoutesFactory } from "../routes";

export function createPiFragmentClients(fragnoConfig: FragnoPublicClientConfig) {
  const b = createClientBuilder(piFragmentDefinition, fragnoConfig, [piRoutesFactory]);

  return {
    useSessions: b.createHook("/sessions"),
    useSession: b.createHook("/sessions/:sessionId"),
    useCreateSession: b.createMutator("POST", "/sessions"),
    useSendMessage: b.createMutator("POST", "/sessions/:sessionId/messages"),
  };
}
