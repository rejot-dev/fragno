import { createPiFragmentClient } from "@fragno-dev/pi-fragment/react";

import type {
  PiLiveToolExecution,
  PiSessionConnectionState,
  PiSessionDetail,
  PiSteeringMode,
} from "@fragno-dev/pi-fragment";

import type { AgentEvent, AgentMessage } from "@mariozechner/pi-agent-core";

export type OrgPiClient = {
  useSession: (args: { path: { sessionId: string }; initialData?: PiSessionDetail | null }) => {
    loading: boolean;
    session: PiSessionDetail | null;
    messages: AgentMessage[];
    traceEvents: AgentEvent[];
    runningTools: PiLiveToolExecution[];
    connection: PiSessionConnectionState;
    statusText: string | null;
    readyForInput: boolean;
    sending: boolean;
    error: string | null;
    sendError: string | null;
    sendMessage: (input: {
      text: string;
      done?: boolean;
      steeringMode?: PiSteeringMode;
    }) => boolean;
    refetch: () => void;
  };
};

export const createOrgPiClient = (orgId: string): OrgPiClient =>
  createPiFragmentClient({
    mountRoute: `/api/pi/${orgId}`,
    debugActiveSession: true,
  });
