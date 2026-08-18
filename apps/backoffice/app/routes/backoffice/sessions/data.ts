import { createRouteCaller } from "@fragno-dev/core/api";
import type { createPiHarness } from "@fragno-dev/pi-harness/factory";
import type { PiSession, PiSessionDetail, PiWorkflowStatus } from "@fragno-dev/pi-harness/types";
import type { RouterContextProvider } from "react-router";

import { fetchFragnoOutboxDescription } from "@fragno-dev/tanstack-db-adapter";

import type { BackofficeContextScope } from "@/backoffice-runtime/context";
import { backofficeContextScopeSinglePathSegment } from "@/backoffice-runtime/scope-codec";
import { requireBackofficeContext } from "@/fragno/auth/backoffice-principal.server";
import { BACKOFFICE_PI_WORKFLOW_NAME } from "@/fragno/pi/pi-shared";
import type { PiModel, PiRuntimeState, PiThinkingLevel } from "@/fragno/pi/pi-shared";
import { getScopedAutomationsDurableObject } from "@/worker-runtime/durable-objects";
import { BackofficeWorkerContext } from "@/worker-runtime/router-context";

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

type PiFragment = ReturnType<typeof createPiHarness>;

const createPiRouteCaller = async (
  request: Request,
  context: Readonly<RouterContextProvider>,
  scope: BackofficeContextScope,
) => {
  const execution = await requireBackofficeContext(request, context, scope);
  const { runtime, kernel } = context.get(BackofficeWorkerContext);
  const piObject = kernel.scoped("AUTOMATIONS", scope, runtime.objects.automations);

  return createRouteCaller<PiFragment>({
    baseUrl: request.url,
    mountRoute: "/api/pi",
    baseHeaders: request.headers,
    fetch: async (routeRequest) =>
      await piObject.fetchWithContext(routeRequest, {
        execution,
        propagationContext: null,
      }),
  });
};

type PiRuntimeStateResult = {
  runtimeState: PiRuntimeState | null;
  runtimeError: string | null;
};

type PiSessionsResult = {
  sessions: PiSession[];
  sessionsError: string | null;
};

type PiRouteError = { message: string; code: string };

type PiRouteErrorResponse = {
  type: "error";
  status: number;
  error: PiRouteError;
};

const throwPiAuthorizationFailure = (response: PiRouteErrorResponse) => {
  if (response.status === 401 || response.status === 403 || response.status === 503) {
    throw Response.json(response.error, { status: response.status });
  }
};

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

export async function fetchPiAdapterIdentity(
  request: Request,
  context: Readonly<RouterContextProvider>,
  scope: BackofficeContextScope,
): Promise<string> {
  const piDo = getScopedAutomationsDurableObject(context, scope);
  const scopeKey = backofficeContextScopeSinglePathSegment(scope);
  const description = await fetchFragnoOutboxDescription({
    baseUrl: new URL("/api/pi", request.url),
    signal: request.signal,
    fetch: (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      url.searchParams.set("scope", scopeKey);
      return piDo.fetch(new Request(url, { ...init, headers: request.headers }));
    },
  });

  return description.adapterIdentity;
}

export async function fetchPiRuntimeState(
  context: Readonly<RouterContextProvider>,
  scope: BackofficeContextScope,
): Promise<PiRuntimeStateResult> {
  try {
    const piDo = getScopedAutomationsDurableObject(context, scope);
    const runtimeState = await piDo.getPiRuntimeState();
    return { runtimeState, runtimeError: null };
  } catch (error) {
    return {
      runtimeState: null,
      runtimeError: error instanceof Error ? error.message : "Failed to initialize Pi.",
    };
  }
}

export async function fetchPiSessions(
  request: Request,
  context: Readonly<RouterContextProvider>,
  scope: BackofficeContextScope,
  options: { limit?: number } = {},
): Promise<PiSessionsResult> {
  const callRoute = await createPiRouteCaller(request, context, scope);
  const requestedLimit =
    typeof options.limit === "number" && Number.isFinite(options.limit)
      ? options.limit
      : DEFAULT_PAGE_SIZE;
  const limit = Math.min(MAX_PAGE_SIZE, Math.max(1, requestedLimit));

  const response = await callRoute("GET", "/workflows/:workflowName/sessions", {
    pathParams: { workflowName: BACKOFFICE_PI_WORKFLOW_NAME },
    query: { limit: String(limit) },
  });

  if (response.type === "json") {
    return { sessions: response.data, sessionsError: null };
  }

  if (response.type === "error") {
    throwPiAuthorizationFailure(response);
    return { sessions: [], sessionsError: response.error.message };
  }

  return {
    sessions: [],
    sessionsError: `Failed to fetch sessions (${response.status}).`,
  };
}

export async function fetchPiSessionDetail(
  request: Request,
  context: Readonly<RouterContextProvider>,
  scope: BackofficeContextScope,
  workflowName: string,
  sessionId: string,
): Promise<PiSessionDetailResult> {
  const callRoute = await createPiRouteCaller(request, context, scope);
  const response = await callRoute("GET", "/workflows/:workflowName/sessions/:sessionId", {
    pathParams: { workflowName, sessionId },
  });
  if (response.type === "json") {
    return { session: response.data as PiSessionDetail, sessionError: null };
  }

  if (response.type === "error") {
    throwPiAuthorizationFailure(response);
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
  scope: BackofficeContextScope,
  payload: {
    workflowName?: string;
    metadata: { model: PiModel } & Record<string, unknown>;
    input: {
      systemPrompt?: string;
      thinkingLevel?: PiThinkingLevel;
    };
    name?: string;
  },
): Promise<PiCreateSessionResult> {
  const callRoute = await createPiRouteCaller(request, context, scope);
  const { workflowName = BACKOFFICE_PI_WORKFLOW_NAME, ...body } = payload;
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
    throwPiAuthorizationFailure(response);
    return { session: null, error: response.error.message };
  }

  return {
    session: null,
    error: `Failed to create session (${response.status}).`,
  };
}

export async function sendPiSessionMessage(
  request: Request,
  context: Readonly<RouterContextProvider>,
  scope: BackofficeContextScope,
  workflowName: string,
  sessionId: string,
  payload: {
    text: string;
    commandKind?: "prompt" | "followUp" | "steer";
  },
): Promise<PiSendMessageResult> {
  const callRoute = await createPiRouteCaller(request, context, scope);
  const response = await callRoute("POST", "/workflows/:workflowName/sessions/:sessionId/command", {
    pathParams: { workflowName, sessionId },
    body: { kind: payload.commandKind ?? "prompt", input: { text: payload.text } },
  });

  if (response.type === "json") {
    return { status: response.data.status, error: null };
  }

  if (response.type === "error") {
    throwPiAuthorizationFailure(response);
    return { status: null, error: response.error.message };
  }

  return {
    status: null,
    error: `Failed to send message (${response.status}).`,
  };
}
