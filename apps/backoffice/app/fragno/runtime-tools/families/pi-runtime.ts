import { createRouteCaller } from "@fragno-dev/core/api";
import type { createPiHarness } from "@fragno-dev/pi-harness/factory";
import type { PiSession, PiSessionDetail, PiWorkflowStatus } from "@fragno-dev/pi-harness/types";
import { INTERACTIVE_CHAT_WORKFLOW_NAME } from "@fragno-dev/pi-harness/workflows/interactive-chat-workflow";

import type { PiObject } from "@/backoffice-runtime/object-registry";

import { isSuccessStatus, throwOnRouteRuntimeError } from "../runtime-errors";

type PiFragment = ReturnType<typeof createPiHarness>;

export type PiSessionCreateArgs = {
  agent: string;
  name?: string;
  systemMessage?: string;
  metadata?: unknown;
  tags?: string[];
  steeringMode?: "all" | "one-at-a-time";
};

export type PiSessionGetArgs = {
  sessionId: string;
  events?: boolean;
  trace?: boolean;
  turns?: boolean;
};

export type PiSessionListArgs = {
  limit?: number;
};

export type PiSessionTurnArgs = {
  sessionId: string;
  text: string;
};

export type PiSessionTurnResult = PiSessionDetail & {
  assistantText: string;
  commandStatus?: PiWorkflowStatus;
  /** @deprecated Use commandStatus. */
  messageStatus: PiWorkflowStatus;
  stream: unknown[];
  /** Agent state after the turn (from session detail fetch). */
  terminalState: PiSessionDetail["agent"]["state"];
};

const extractMessageText = (
  message: PiSessionDetail["agent"]["state"]["messages"][number] | undefined,
): string => {
  if (!message || message.role !== "assistant" || !Array.isArray(message.content)) {
    return "";
  }

  return message.content
    .filter((block) => typeof block === "object" && block !== null && block.type === "text")
    .map((block) => ("text" in block && typeof block.text === "string" ? block.text : ""))
    .join("")
    .trim();
};

const extractAssistantText = (messages: PiSessionDetail["agent"]["state"]["messages"]): string => {
  const assistantMessage = [...messages].reverse().find((message) => message.role === "assistant");
  return extractMessageText(assistantMessage);
};

export type PiRuntime = {
  createSession: (args: PiSessionCreateArgs) => Promise<PiSession>;
  getSession: (args: PiSessionGetArgs) => Promise<PiSessionDetail>;
  listSessions: (args: PiSessionListArgs) => Promise<PiSession[]>;
  runTurn: (args: PiSessionTurnArgs) => Promise<PiSessionTurnResult>;
};

export type RegisteredPiCommandContext = {
  runtime: PiRuntime;
};

export const createUnavailablePiRuntime = (message: string): PiRuntime => ({
  createSession: async () => {
    throw new Error(message);
  },
  getSession: async () => {
    throw new Error(message);
  },
  listSessions: async () => {
    throw new Error(message);
  },
  runTurn: async () => {
    throw new Error(message);
  },
});

const createPiRouteCaller = ({ object, orgId }: { object: PiObject; orgId: string }) =>
  createRouteCaller<PiFragment>({
    // Durable Object route helpers still need absolute URLs, so use a synthetic origin.
    baseUrl: "https://pi.do",
    mountRoute: "/api/pi",
    fetch: async (outboundRequest) => {
      const url = new URL(outboundRequest.url);
      url.searchParams.set("orgId", orgId);
      return object.fetch(new Request(url.toString(), outboundRequest));
    },
  });

const parsePiRuntimeAgentName = (agent: string) => {
  const [harnessId, provider, ...modelParts] = agent.split("::");
  const model = modelParts.join("::");
  if (
    !harnessId ||
    !model ||
    (provider !== "openai" && provider !== "anthropic" && provider !== "gemini")
  ) {
    throw new Error(
      "pi.session.create agent must use the harnessId::provider::model name shown by the Pi UI.",
    );
  }
  return { harnessId, provider, model };
};

export const createPiRouteRuntime = ({
  object,
  orgId,
}: {
  object: PiObject;
  orgId: string;
}): PiRuntime => {
  const normalizedOrgId = orgId.trim();
  if (!normalizedOrgId) {
    throw new Error("pi.session commands require an organisation id");
  }

  const callRoute = createPiRouteCaller({ object, orgId: normalizedOrgId });

  return {
    createSession: async (args) => {
      parsePiRuntimeAgentName(args.agent);
      const response = await callRoute("POST", "/workflows/:workflowName/sessions", {
        pathParams: { workflowName: INTERACTIVE_CHAT_WORKFLOW_NAME },
        body: {
          name: args.name,
          input: {
            harnessName: args.agent,
            systemPrompt: args.systemMessage,
          },
        },
      });
      if (response.type === "json" && isSuccessStatus(response.status)) {
        return response.data;
      }
      return throwOnRouteRuntimeError(response, {
        runtimeLabel: "Pi harness",
        label: "pi.session.create",
      });
    },
    getSession: async ({ sessionId, events, trace, turns }) => {
      const query: Record<string, string> = {};
      if (typeof events === "boolean") {
        query.events = String(events);
      }
      if (typeof trace === "boolean") {
        query.trace = String(trace);
      }
      if (typeof turns === "boolean") {
        query.turns = String(turns);
      }

      const response = await callRoute("GET", "/workflows/:workflowName/sessions/:sessionId", {
        pathParams: { workflowName: INTERACTIVE_CHAT_WORKFLOW_NAME, sessionId },
        query,
      });
      if (response.type === "json" && isSuccessStatus(response.status)) {
        return response.data;
      }
      return throwOnRouteRuntimeError(response, {
        runtimeLabel: "Pi harness",
        label: "pi.session.get",
      });
    },
    listSessions: async ({ limit }) => {
      const query: Record<string, string> = {};
      if (typeof limit === "number") {
        query.limit = String(limit);
      }

      const response = await callRoute("GET", "/workflows/:workflowName/sessions", {
        pathParams: { workflowName: INTERACTIVE_CHAT_WORKFLOW_NAME },
        query,
      });
      if (response.type === "json" && isSuccessStatus(response.status)) {
        return response.data;
      }
      return throwOnRouteRuntimeError(response, {
        runtimeLabel: "Pi harness",
        label: "pi.session.list",
      });
    },
    runTurn: async ({ sessionId, text }) => {
      const normalizedSessionId = sessionId.trim();
      if (!normalizedSessionId) {
        throw new Error("pi.session.turn requires a session id");
      }

      const normalizedText = text.trim();
      if (!normalizedText) {
        throw new Error("pi.session.turn requires non-empty text");
      }

      const pathParams = {
        workflowName: INTERACTIVE_CHAT_WORKFLOW_NAME,
        sessionId: normalizedSessionId,
      };
      const waitResponse = callRoute(
        "GET",
        "/workflows/:workflowName/sessions/:sessionId/wait-for-agent-end",
        {
          pathParams,
          query: { timeoutMs: "60000" },
        },
      );
      const promptResponse = await callRoute(
        "POST",
        "/workflows/:workflowName/sessions/:sessionId/command",
        {
          pathParams,
          body: {
            kind: "prompt",
            input: { text: normalizedText },
          },
        },
      );
      if (promptResponse.type !== "json" || !isSuccessStatus(promptResponse.status)) {
        return throwOnRouteRuntimeError(promptResponse, {
          runtimeLabel: "Pi harness",
          label: "pi.session.turn prompt",
        });
      }

      const detailResponse = await waitResponse;
      if (detailResponse.type !== "json" || !isSuccessStatus(detailResponse.status)) {
        return throwOnRouteRuntimeError(detailResponse, {
          runtimeLabel: "Pi harness",
          label: "pi.session.turn wait-for-agent-end",
        });
      }

      const detail = detailResponse.data;

      return {
        ...detail,
        assistantText: extractAssistantText(detail.agent.state.messages),
        commandStatus: promptResponse.data.status,
        messageStatus: promptResponse.data.status,
        stream: [],
        terminalState: detail.agent.state,
      };
    },
  };
};
