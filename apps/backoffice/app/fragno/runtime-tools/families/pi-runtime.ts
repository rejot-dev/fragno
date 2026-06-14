import { createRouteCaller } from "@fragno-dev/core/api";

import type {
  PiSession,
  PiSessionDetail,
  PiSessionEventStreamItem,
  createPiFragment,
} from "@fragno-dev/pi-fragment";

import type { BackofficeObjectRegistry } from "@/backoffice-runtime/object-registry";

import { isSuccessStatus, throwOnRouteRuntimeError } from "../runtime-errors";

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

const getFramePayload = (frame: PiSessionEventStreamItem): unknown => {
  if (
    "kind" in frame &&
    frame.kind === "step-emission" &&
    typeof frame.payload === "object" &&
    frame.payload !== null
  ) {
    return frame.payload;
  }

  return frame;
};

const isTurnEndFrame = (frame: PiSessionEventStreamItem): boolean => {
  const payload = getFramePayload(frame);
  return (
    typeof payload === "object" &&
    payload !== null &&
    "type" in payload &&
    payload.type === "turn_end"
  );
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

const extractTurnEndAssistantText = (
  frames: PiSessionEventStreamItem[],
): { found: boolean; text: string } => {
  for (const frame of [...frames].reverse()) {
    if (!isTurnEndFrame(frame)) {
      continue;
    }

    const payload = getFramePayload(frame);
    if (typeof payload !== "object" || payload === null || !("message" in payload)) {
      continue;
    }

    return {
      found: true,
      text: extractMessageText(
        payload.message as PiSessionDetail["agent"]["state"]["messages"][number] | undefined,
      ),
    };
  }

  return { found: false, text: "" };
};

const isTerminalTurnFrame = (frame: PiSessionEventStreamItem): boolean => {
  if (!isTurnEndFrame(frame)) {
    return false;
  }

  const payload = getFramePayload(frame);
  if (typeof payload !== "object" || payload === null || !("message" in payload)) {
    return true;
  }

  return (
    extractMessageText(
      payload.message as PiSessionDetail["agent"]["state"]["messages"][number] | undefined,
    ).length > 0
  );
};

const consumeActiveStream = async (
  stream: AsyncGenerator<PiSessionEventStreamItem>,
): Promise<{ frames: PiSessionEventStreamItem[] }> => {
  const frames: PiSessionEventStreamItem[] = [];

  try {
    for await (const frame of stream) {
      frames.push(frame);
      if (isTerminalTurnFrame(frame)) {
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

const createPiRouteCaller = ({
  objects,
  orgId,
}: {
  objects: BackofficeObjectRegistry;
  orgId: string;
}) => {
  const piDo = objects.pi.forOrg(orgId);

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
  return extractMessageText(assistantMessage);
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
  objects,
  orgId,
}: {
  objects: BackofficeObjectRegistry;
  orgId: string;
}): PiRuntime => {
  const normalizedOrgId = orgId.trim();
  if (!normalizedOrgId) {
    throw new Error("pi.session commands require an organisation id");
  }

  const callRoute = createPiRouteCaller({ objects, orgId: normalizedOrgId });

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
        const turnEndAssistantText = extractTurnEndAssistantText(frames);
        return {
          ...detail,
          assistantText: turnEndAssistantText.found
            ? turnEndAssistantText.text
            : extractAssistantText(detail.agent.state.messages),
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
