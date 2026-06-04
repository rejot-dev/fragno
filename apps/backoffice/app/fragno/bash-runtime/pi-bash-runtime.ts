import { createRouteCaller } from "@fragno-dev/core/api";

import type {
  PiSession,
  PiSessionDetail,
  PiSessionEventStreamItem,
  createPiFragment,
} from "@fragno-dev/pi-fragment";

import { isSuccessStatus, throwOnRouteRuntimeError } from "../runtime-tools/runtime-errors";

type PiFragment = ReturnType<typeof createPiFragment>;

export type PiSessionCreateArgs = {
  agent: string;
  name?: string;
  systemMessage?: string;
  metadata?: unknown;
  tags?: string[];
  steeringMode?: "all" | "one-at-a-time";
};

const INTERACTIVE_CHAT_WORKFLOW_NAME = "interactive-chat-workflow";

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
  commandStatus?: PiSession["status"];
  /** @deprecated Use commandStatus. */
  messageStatus: PiSession["status"];
  stream: PiSessionEventStreamItem[];
  /** Agent state after the turn (from session detail fetch). */
  terminalState: PiSessionDetail["agent"]["state"];
};

const consumeActiveStream = async (
  stream: AsyncGenerator<PiSessionEventStreamItem>,
): Promise<{ frames: PiSessionEventStreamItem[] }> => {
  const frames: PiSessionEventStreamItem[] = [];

  try {
    for await (const frame of stream) {
      frames.push(frame);
      if ("type" in frame && frame.type === "turn_end") {
        break;
      }
    }
    return { frames };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Pi active session stream failed: ${message}`);
  }
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

const createPiRouteCaller = (env: CloudflareEnv, orgId: string) => {
  const piDo = env.PI.get(env.PI.idFromName(orgId));

  return createRouteCaller<PiFragment>({
    // Durable Object route helpers still need absolute URLs, so use a synthetic origin.
    baseUrl: "https://pi.do",
    mountRoute: "/api/pi",
    fetch: async (outboundRequest) => {
      const url = new URL(outboundRequest.url);
      url.searchParams.set("orgId", orgId);
      return piDo.fetch(new Request(url.toString(), outboundRequest));
    },
  });
};

const extractAssistantText = (messages: PiSessionDetail["agent"]["state"]["messages"]): string => {
  const assistantMessage = [...messages].reverse().find((message) => message.role === "assistant");
  if (!assistantMessage || !Array.isArray(assistantMessage.content)) {
    return "";
  }

  return assistantMessage.content
    .filter((block) => typeof block === "object" && block !== null && block.type === "text")
    .map((block) => ("text" in block && typeof block.text === "string" ? block.text : ""))
    .join("")
    .trim();
};

const closeActiveStream = async (stream: AsyncGenerator<PiSessionEventStreamItem>) => {
  if (typeof stream.return !== "function") {
    return;
  }

  try {
    await stream.return(undefined as never);
  } catch {
    // Best-effort cleanup only.
  }
};

export const createPiRouteRuntime = ({
  env,
  orgId,
}: {
  env: CloudflareEnv;
  orgId: string;
}): PiRuntime => {
  const normalizedOrgId = orgId.trim();
  if (!normalizedOrgId) {
    throw new Error("pi.session commands require an organisation id");
  }

  const callRoute = createPiRouteCaller(env, normalizedOrgId);

  return {
    createSession: async (args) => {
      const response = await callRoute("POST", "/workflows/:workflowName/sessions", {
        pathParams: { workflowName: INTERACTIVE_CHAT_WORKFLOW_NAME },
        body: {
          name: args.name,
          input: {
            agentName: args.agent,
            systemPrompt: args.systemMessage,
          },
        },
      });
      if (response.type === "json" && isSuccessStatus(response.status)) {
        return response.data;
      }
      return throwOnRouteRuntimeError(response, {
        runtimeLabel: "Pi fragment",
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
        runtimeLabel: "Pi fragment",
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
        runtimeLabel: "Pi fragment",
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

      const activeRoute = await callRoute(
        "GET",
        "/workflows/:workflowName/sessions/:sessionId/events",
        {
          pathParams: {
            workflowName: INTERACTIVE_CHAT_WORKFLOW_NAME,
            sessionId: normalizedSessionId,
          },
        },
      );
      if (!isSuccessStatus(activeRoute.status)) {
        return throwOnRouteRuntimeError(activeRoute, {
          runtimeLabel: "Pi fragment",
          label: "pi.session.turn active",
        });
      }
      if (activeRoute.type !== "jsonStream") {
        throw new Error(
          `Pi fragment returned ${activeRoute.status}: session events route did not return a jsonStream response`,
        );
      }

      try {
        const promptResponse = await callRoute(
          "POST",
          "/workflows/:workflowName/sessions/:sessionId/command",
          {
            pathParams: {
              workflowName: INTERACTIVE_CHAT_WORKFLOW_NAME,
              sessionId: normalizedSessionId,
            },
            body: {
              kind: "prompt",
              input: { text: normalizedText },
            },
          },
        );
        if (promptResponse.type !== "json" || !isSuccessStatus(promptResponse.status)) {
          return throwOnRouteRuntimeError(promptResponse, {
            runtimeLabel: "Pi fragment",
            label: "pi.session.turn prompt",
          });
        }

        const { frames } = await consumeActiveStream(activeRoute.stream);

        const detailResponse = await callRoute(
          "GET",
          "/workflows/:workflowName/sessions/:sessionId",
          {
            pathParams: {
              workflowName: INTERACTIVE_CHAT_WORKFLOW_NAME,
              sessionId: normalizedSessionId,
            },
          },
        );
        if (detailResponse.type !== "json" || !isSuccessStatus(detailResponse.status)) {
          return throwOnRouteRuntimeError(detailResponse, {
            runtimeLabel: "Pi fragment",
            label: "pi.session.turn detail",
          });
        }

        const detail = detailResponse.data;
        return {
          ...detail,
          assistantText: extractAssistantText(detail.agent.state.messages),
          commandStatus: promptResponse.data.status,
          messageStatus: promptResponse.data.status,
          stream: frames,
          terminalState: detail.agent.state,
        };
      } catch (error) {
        await closeActiveStream(activeRoute.stream);
        throw error;
      }
    },
  };
};
