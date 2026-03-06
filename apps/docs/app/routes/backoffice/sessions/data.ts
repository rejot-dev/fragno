import { createRouteCaller } from "@fragno-dev/core/api";
import type { RouterContextProvider } from "react-router";
import type {
  createPiFragment,
  PiSession,
  PiSessionStatus,
  PiTurnSummary,
} from "@fragno-dev/pi-fragment";
import type { AgentEvent, AgentMessage } from "@mariozechner/pi-agent-core";
import { getPiDurableObject } from "@/cloudflare/cloudflare-utils";
import type { PiConfigState } from "@/fragno/pi-shared";

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

type PiFragment = ReturnType<typeof createPiFragment>;

type PiSessionDetail = PiSession & {
  workflow: {
    status: PiSessionStatus;
    error?: { name: string; message: string };
    output?: unknown;
  };
  messages: AgentMessage[];
  trace: AgentEvent[];
  summaries: PiTurnSummary[];
};

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

type PiSessionDetailResult = {
  session: PiSessionDetail | null;
  status?: number;
  sessionError: string | null;
};

type PiCreateSessionResult = {
  session: PiSession | null;
  error: string | null;
};

type PiSendMessageResult = {
  status: PiSessionStatus | null;
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

    const response = await callRoute("GET", "/sessions", {
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
  sessionId: string,
): Promise<PiSessionDetailResult> {
  try {
    const callRoute = createPiRouteCaller(request, context, orgId);
    const response = await callRoute("GET", "/sessions/:sessionId", {
      pathParams: { sessionId },
    });

    if (response.type === "json") {
      return { session: response.data as PiSessionDetail, sessionError: null };
    }

    if (response.type === "error") {
      return {
        session: null,
        status: response.status,
        sessionError: response.error.message,
      };
    }

    return {
      session: null,
      status: response.status,
      sessionError: `Failed to fetch session (${response.status}).`,
    };
  } catch (error) {
    return {
      session: null,
      sessionError: error instanceof Error ? error.message : "Failed to load session.",
    };
  }
}

export async function createPiSession(
  request: Request,
  context: Readonly<RouterContextProvider>,
  orgId: string,
  payload: {
    agent: string;
    name?: string;
    steeringMode: "all" | "one-at-a-time";
    tags?: string[];
    metadata?: unknown;
  },
): Promise<PiCreateSessionResult> {
  try {
    const callRoute = createPiRouteCaller(request, context, orgId);
    const response = await callRoute("POST", "/sessions", {
      body: payload,
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
  sessionId: string,
  payload: {
    text: string;
    done?: boolean;
    steeringMode?: "all" | "one-at-a-time";
  },
): Promise<PiSendMessageResult> {
  try {
    const callRoute = createPiRouteCaller(request, context, orgId);
    const response = await callRoute("POST", "/sessions/:sessionId/messages", {
      pathParams: { sessionId },
      body: payload,
    });

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
