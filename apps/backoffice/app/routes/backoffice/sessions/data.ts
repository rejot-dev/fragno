import { createRouteCaller } from "@fragno-dev/core/api";
import type { createPiHarness } from "@fragno-dev/pi-harness/factory";
import type { PiSession, PiSessionDetail, PiWorkflowStatus } from "@fragno-dev/pi-harness/types";
import { INTERACTIVE_CHAT_WORKFLOW_NAME } from "@fragno-dev/pi-harness/workflows/interactive-chat-workflow";
import type { RouterContextProvider } from "react-router";

import type { PiConfigState, PiThinkingLevel } from "@/fragno/pi/pi-shared";
import { getPiDurableObject } from "@/worker-runtime/durable-objects";

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

type PiFragment = ReturnType<typeof createPiHarness>;

const createPiRouteCaller = (
  request: Request,
  context: Readonly<RouterContextProvider>,
  orgId: string,
) => {
  const piDo = getPiDurableObject(context, orgId);
  return createRouteCaller<PiFragment>({
    baseUrl: request.url,
    mountRoute: "/api/pi",
    baseHeaders: request.headers,
    fetch: piDo.fetch.bind(piDo),
  });
};

type PiConfigResult = {
  configState: PiConfigState | null;
  configError: string | null;
};

type PiSessionsResult = {
  sessions: PiSession[];
  sessionsError: string | null;
};

type PiRouteError = { message: string; code: string };

type PiSessionDetailResult = {
  session: PiSessionDetail | null;
  status?: number;
  sessionError: PiRouteError | null;
};

type PiCreateSessionResult = {
  session: PiSession | null;
  error: string | null;
};

type PiSendMessageResult = {
  status: PiWorkflowStatus | null;
  error: string | null;
};

export async function fetchPiConfig(
  context: Readonly<RouterContextProvider>,
  orgId: string,
): Promise<PiConfigResult> {
  try {
    const piDo = getPiDurableObject(context, orgId);
    const configState = await piDo.getAdminConfig();
    return { configState, configError: null };
  } catch (error) {
    return {
      configState: null,
      configError: error instanceof Error ? error.message : "Failed to load configuration.",
    };
  }
}

export async function fetchPiSessions(
  request: Request,
  context: Readonly<RouterContextProvider>,
  orgId: string,
  options: { limit?: number } = {},
): Promise<PiSessionsResult> {
  try {
    const callRoute = createPiRouteCaller(request, context, orgId);
    const requestedLimit =
      typeof options.limit === "number" && Number.isFinite(options.limit)
        ? options.limit
        : DEFAULT_PAGE_SIZE;
    const limit = Math.min(MAX_PAGE_SIZE, Math.max(1, requestedLimit));

    const response = await callRoute("GET", "/workflows/:workflowName/sessions", {
      pathParams: { workflowName: INTERACTIVE_CHAT_WORKFLOW_NAME },
      query: { limit: String(limit) },
    });

    if (response.type === "json") {
      return { sessions: response.data, sessionsError: null };
    }

    if (response.type === "error") {
      return { sessions: [], sessionsError: response.error.message };
    }

    return {
      sessions: [],
      sessionsError: `Failed to fetch sessions (${response.status}).`,
    };
  } catch (error) {
    return {
      sessions: [],
      sessionsError: error instanceof Error ? error.message : "Failed to load sessions.",
    };
  }
}

export async function fetchPiSessionDetail(
  request: Request,
  context: Readonly<RouterContextProvider>,
  orgId: string,
  workflowName: string,
  sessionId: string,
): Promise<PiSessionDetailResult> {
  const callRoute = createPiRouteCaller(request, context, orgId);
  const response = await callRoute("GET", "/workflows/:workflowName/sessions/:sessionId", {
    pathParams: { workflowName, sessionId },
  });
  if (response.type === "json") {
    return { session: response.data as PiSessionDetail, sessionError: null };
  }

  if (response.type === "error") {
    return {
      session: null,
      status: response.status,
      sessionError: response.error,
    };
  }

  return {
    session: null,
    status: response.status,
    sessionError: {
      code: "PI_SESSION_FETCH_FAILED",
      message: `Failed to fetch session (${response.status}).`,
    },
  };
}

export async function createPiSession(
  request: Request,
  context: Readonly<RouterContextProvider>,
  orgId: string,
  payload: {
    workflowName?: string;
    input: {
      harnessName: string;
      systemPrompt?: string;
      thinkingLevel?: PiThinkingLevel;
    };
    name?: string;
  },
): Promise<PiCreateSessionResult> {
  try {
    const callRoute = createPiRouteCaller(request, context, orgId);
    const { workflowName = INTERACTIVE_CHAT_WORKFLOW_NAME, ...body } = payload;
    const response = await callRoute("POST", "/workflows/:workflowName/sessions", {
      pathParams: { workflowName },
      body: {
        ...body,
        input: {
          ...body.input,
          systemPrompt: body.input.systemPrompt,
        },
      },
    });

    if (response.type === "json") {
      return { session: response.data, error: null };
    }

    if (response.type === "error") {
      return { session: null, error: response.error.message };
    }

    return {
      session: null,
      error: `Failed to create session (${response.status}).`,
    };
  } catch (error) {
    return {
      session: null,
      error: error instanceof Error ? error.message : "Failed to create session.",
    };
  }
}

export async function sendPiSessionMessage(
  request: Request,
  context: Readonly<RouterContextProvider>,
  orgId: string,
  workflowName: string,
  sessionId: string,
  payload: {
    text: string;
    commandKind?: "followUp" | "steer";
  },
): Promise<PiSendMessageResult> {
  try {
    const callRoute = createPiRouteCaller(request, context, orgId);
    const response = await callRoute(
      "POST",
      "/workflows/:workflowName/sessions/:sessionId/command",
      {
        pathParams: { workflowName, sessionId },
        body: { kind: payload.commandKind ?? "followUp", input: { text: payload.text } },
      },
    );

    if (response.type === "json") {
      return { status: response.data.status, error: null };
    }

    if (response.type === "error") {
      return { status: null, error: response.error.message };
    }

    return {
      status: null,
      error: `Failed to send message (${response.status}).`,
    };
  } catch (error) {
    return {
      status: null,
      error: error instanceof Error ? error.message : "Failed to send message.",
    };
  }
}
