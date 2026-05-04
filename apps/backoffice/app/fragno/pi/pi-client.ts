import { createPiFragmentClient } from "@fragno-dev/pi-fragment/react";

import type {
  PiLiveToolExecution,
  PiSessionCommandInput,
  PiSessionConnectionState,
  PiSessionDetail,
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
    sendCommand: (command: PiSessionCommandInput) => boolean;
    prompt: (input: { text: string }) => boolean;
    refetch: () => void;
  };
};

export const createOrgPiClient = (orgId: string): OrgPiClient =>
  createPiFragmentClient({
    mountRoute: `/api/pi/${orgId}`,
    debugActiveSession: true,
  });
