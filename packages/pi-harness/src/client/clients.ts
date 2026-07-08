import { createClientBuilder, type FragnoPublicClientConfig } from "@fragno-dev/core/client";
import type { z } from "zod";

import { piHarnessDefinition } from "../pi/definition";
import type { commandAckSchema, commandInputSchema } from "../pi/route-schemas";
import { piRoutesFactory } from "../routes";

export {
  createSessionProjectionDataStore,
  latestCompletedPiHarnessEntries,
  piAgentMessagesFromSessionEntries,
  projectPiWorkflowSession,
  readPiWorkflowLofiSessionProjection,
} from "./workflow-lofi-session-projection";

export type {
  DraftAgentActivity,
  DraftAgentMessage,
  DraftTool,
  PiWorkflowSessionProjectionState,
} from "./workflow-lofi-session-projection";

export type PiSessionCommandInput = z.infer<typeof commandInputSchema>;
export type PiSessionCommandAck = z.infer<typeof commandAckSchema>;

export type PiFragmentClientConfig = FragnoPublicClientConfig & {
  debugActiveSession?: boolean;
};

export function createPiFragmentClients(fragnoConfig: PiFragmentClientConfig = {}) {
  const builder = createClientBuilder(piHarnessDefinition, fragnoConfig, [piRoutesFactory]);

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

  return {
    useSessions: builder.createHook("/workflows/:workflowName/sessions"),
    useSessionDetail: builder.createHook("/workflows/:workflowName/sessions/:sessionId"),
    useCreateSession: builder.createMutator("POST", "/workflows/:workflowName/sessions"),
    useCommandSession,
  };
}
