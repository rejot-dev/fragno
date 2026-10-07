import { createRouteCaller } from "@fragno-dev/core/api";
import type { RouterContextProvider } from "react-router";

import type { ConversationView, EntryRecord, SubmissionRecord } from "@earendil-works/pi-durable";

import {
  backofficeExecutionScopeRestriction,
  type BackofficeContextScope,
} from "@/backoffice-runtime/context";
import { requireBackofficeContext } from "@/fragno/auth/backoffice-principal.server";
import type {
  PiAgentCompactionStatus,
  PiAgentConfig,
  PiAvailableModel,
  PiManagerSession,
} from "@/fragno/pi-manager/pi-agent-contract";
import type { createPiManagerFragment } from "@/fragno/pi-manager/pi-manager-fragment";
import { captureBackofficeServerEvent } from "@/posthog.server";
import { BackofficeWorkerContext } from "@/worker-runtime/router-context";

const PI_SESSION_PAGE_SIZE = 100;
type PiManagerFragment = ReturnType<typeof createPiManagerFragment>;

type PiRouteError = { message: string; code: string };
type PiRouteErrorResponse = { type: "error"; status: number; error: PiRouteError };

export type PiManagerSessionDetail = {
  session: PiManagerSession;
  view: ConversationView;
};

export type PiManagerSessionsResult = {
  sessions: PiManagerSession[];
  sessionsError: string | null;
};

export type PiManagerSessionDetailResult = {
  detail: PiManagerSessionDetail | null;
  status?: number;
  sessionError: PiRouteError | null;
};

export type PiManagerEntryPage = {
  entries: EntryRecord[];
  cursor: string | null;
  hasNextPage: boolean;
};

async function createPiManagerAuthorizedAccess(
  request: Request,
  context: Readonly<RouterContextProvider>,
  scope: BackofficeContextScope,
) {
  const execution = await requireBackofficeContext(request, context, scope);
  const { runtime, kernel } = context.get(BackofficeWorkerContext);
  const manager = kernel.scoped("PI_MANAGER", scope, runtime.objects.piManager);
  return { execution, manager };
}

async function createPiManagerRouteCaller(
  request: Request,
  context: Readonly<RouterContextProvider>,
  scope: BackofficeContextScope,
) {
  const { execution, manager } = await createPiManagerAuthorizedAccess(request, context, scope);
  const callRoute = createRouteCaller<PiManagerFragment>({
    baseUrl: request.url,
    mountRoute: "/api/pi-manager",
    baseHeaders: request.headers,
    fetch: async (routeRequest) =>
      await manager.http.fetchAuthorized(routeRequest, {
        execution,
        propagationContext: null,
      }),
  });
  return { callRoute, execution };
}

function throwPiManagerAuthorizationFailure(response: PiRouteErrorResponse) {
  if (response.status === 401 || response.status === 403 || response.status === 503) {
    throw Response.json(response.error, { status: response.status });
  }
}

export async function fetchPiManagerAvailableModels(
  request: Request,
  context: Readonly<RouterContextProvider>,
  scope: BackofficeContextScope,
): Promise<PiAvailableModel[]> {
  const { callRoute } = await createPiManagerRouteCaller(request, context, scope);
  const response = await callRoute("GET", "/models", {});
  if (response.type === "json") {
    return response.data;
  }
  if (response.type === "error") {
    throwPiManagerAuthorizationFailure(response);
    throw Response.json(response.error, { status: response.status });
  }
  throw new Response(`Failed to fetch Pi models (${response.status}).`, {
    status: response.status,
  });
}

export async function fetchPiManagerSessions(
  request: Request,
  context: Readonly<RouterContextProvider>,
  scope: BackofficeContextScope,
): Promise<PiManagerSessionsResult> {
  const { callRoute } = await createPiManagerRouteCaller(request, context, scope);
  const response = await callRoute("GET", "/sessions", {
    query: { pageSize: String(PI_SESSION_PAGE_SIZE) },
  });

  if (response.type === "json") {
    return { sessions: response.data.sessions, sessionsError: null };
  }
  if (response.type === "error") {
    throwPiManagerAuthorizationFailure(response);
    return { sessions: [], sessionsError: response.error.message };
  }
  return { sessions: [], sessionsError: `Failed to fetch sessions (${response.status}).` };
}

export async function fetchPiManagerSessionDetail(
  request: Request,
  context: Readonly<RouterContextProvider>,
  scope: BackofficeContextScope,
  sessionId: string,
): Promise<PiManagerSessionDetailResult> {
  const { callRoute } = await createPiManagerRouteCaller(request, context, scope);
  const route = "/sessions/:sessionId" as const;
  const sessionResponse = await callRoute("GET", route, { pathParams: { sessionId } });
  if (sessionResponse.type === "error") {
    throwPiManagerAuthorizationFailure(sessionResponse);
    return {
      detail: null,
      status: sessionResponse.status,
      sessionError: sessionResponse.error,
    };
  }
  if (sessionResponse.type !== "json") {
    return {
      detail: null,
      status: sessionResponse.status,
      sessionError: {
        code: "PI_SESSION_FETCH_FAILED",
        message: `Failed to fetch session (${sessionResponse.status}).`,
      },
    };
  }

  const viewResponse = await callRoute("GET", "/sessions/:sessionId/view", {
    pathParams: { sessionId },
  });
  if (viewResponse.type === "error") {
    throwPiManagerAuthorizationFailure(viewResponse);
    return { detail: null, status: viewResponse.status, sessionError: viewResponse.error };
  }
  if (viewResponse.type !== "json") {
    return {
      detail: null,
      status: viewResponse.status,
      sessionError: {
        code: "PI_SESSION_VIEW_FETCH_FAILED",
        message: `Failed to fetch session conversation (${viewResponse.status}).`,
      },
    };
  }

  // The manager intentionally keeps the agent-owned structural view opaque.
  const view = viewResponse.data as ConversationView;
  return { detail: { session: sessionResponse.data, view }, sessionError: null };
}

/** Opens the authorized NDJSON stream produced by the session's durable Pi agent. */
export async function fetchPiManagerSessionViewStream(
  request: Request,
  context: Readonly<RouterContextProvider>,
  scope: BackofficeContextScope,
  sessionId: string,
): Promise<Response> {
  const { execution, manager } = await createPiManagerAuthorizedAccess(request, context, scope);
  const url = new URL(
    `/api/pi-manager/sessions/${encodeURIComponent(sessionId)}/view-stream`,
    request.url,
  );
  return await manager.http.fetchAuthorized(
    new Request(url, {
      method: "GET",
      headers: { accept: "application/x-ndjson" },
      signal: request.signal,
    }),
    { execution, propagationContext: null },
  );
}

export async function createPiManagerSession(
  request: Request,
  context: Readonly<RouterContextProvider>,
  scope: BackofficeContextScope,
  input: {
    name: string | null;
    model: PiAgentConfig["model"];
    instructions: string;
    billingOrganizationId: string | null;
  },
): Promise<{ session: PiAgentConfig | null; error: string | null }> {
  const { callRoute, execution } = await createPiManagerRouteCaller(request, context, scope);
  const response = await callRoute("POST", "/sessions", {
    body: {
      ...input,
      requestId: crypto.randomUUID(),
      actors: execution.actors,
      scopeRestriction: backofficeExecutionScopeRestriction(execution),
    },
  });
  if (response.type === "json") {
    captureBackofficeServerEvent(context, {
      event: "session_created",
      userId: execution.userAuthority.userId,
      properties: {
        session_id: response.data.sessionId,
        scope_kind: scope.kind,
        provider: response.data.model.provider,
        model: response.data.model.modelId,
      },
    });
    return { session: response.data, error: null };
  }
  if (response.type === "error") {
    throwPiManagerAuthorizationFailure(response);
    return { session: null, error: response.error.message };
  }
  return { session: null, error: `Failed to create session (${response.status}).` };
}

export async function submitPiManagerPrompt(
  request: Request,
  context: Readonly<RouterContextProvider>,
  scope: BackofficeContextScope,
  sessionId: string,
  input: { requestId: string; content: string; whenBusy: "followUp" | "steer" | "reject" },
): Promise<{ requestId: string | null; error: string | null }> {
  const { callRoute, execution } = await createPiManagerRouteCaller(request, context, scope);
  const response = await callRoute("POST", "/sessions/:sessionId/prompts", {
    pathParams: { sessionId },
    body: input,
  });
  if (response.type === "json") {
    captureBackofficeServerEvent(context, {
      event: "session_prompt_admitted",
      userId: execution.userAuthority.userId,
      properties: {
        session_id: sessionId,
        prompt_request_id: response.data.requestId,
        when_busy: input.whenBusy,
        scope_kind: scope.kind,
      },
    });
    return { requestId: response.data.requestId, error: null };
  }
  if (response.type === "error") {
    throwPiManagerAuthorizationFailure(response);
    return { requestId: null, error: response.error.message };
  }
  return { requestId: null, error: `Failed to send message (${response.status}).` };
}

export async function fetchPiManagerSubmission(
  request: Request,
  context: Readonly<RouterContextProvider>,
  scope: BackofficeContextScope,
  sessionId: string,
  requestId: string,
): Promise<SubmissionRecord | null> {
  const { callRoute } = await createPiManagerRouteCaller(request, context, scope);
  const response = await callRoute("GET", "/sessions/:sessionId/submissions/:requestId", {
    pathParams: { sessionId, requestId },
  });
  if (response.type === "json") {
    return response.data as SubmissionRecord;
  }
  if (response.type === "error") {
    throwPiManagerAuthorizationFailure(response);
    if (response.status === 404) {
      return null;
    }
    throw Response.json(response.error, { status: response.status });
  }
  throw new Response(`Failed to fetch submission (${response.status}).`, {
    status: response.status,
  });
}

export async function fetchPiManagerEntryPage(
  request: Request,
  context: Readonly<RouterContextProvider>,
  scope: BackofficeContextScope,
  sessionId: string,
  input: { cursor?: string | null; pageSize?: number },
): Promise<PiManagerEntryPage> {
  const { callRoute } = await createPiManagerRouteCaller(request, context, scope);
  const response = await callRoute("GET", "/sessions/:sessionId/entries", {
    pathParams: { sessionId },
    query: {
      pageSize: String(input.pageSize ?? 100),
      ...(input.cursor ? { cursor: input.cursor } : {}),
    },
  });
  if (response.type === "json") {
    return response.data as PiManagerEntryPage;
  }
  if (response.type === "error") {
    throwPiManagerAuthorizationFailure(response);
    throw Response.json(response.error, { status: response.status });
  }
  throw new Response(`Failed to fetch Pi entry history (${response.status}).`, {
    status: response.status,
  });
}

/** Proxies the authorized durable JSONL export without buffering it in the application Worker. */
export async function fetchPiManagerSessionExport(
  request: Request,
  context: Readonly<RouterContextProvider>,
  scope: BackofficeContextScope,
  sessionId: string,
): Promise<Response> {
  const { execution, manager } = await createPiManagerAuthorizedAccess(request, context, scope);
  const url = new URL(
    `/api/pi-manager/sessions/${encodeURIComponent(sessionId)}/export`,
    request.url,
  );
  return await manager.http.fetchAuthorized(
    new Request(url, { method: "GET", signal: request.signal }),
    {
      execution,
      propagationContext: null,
    },
  );
}

export async function compactPiManagerSession(
  request: Request,
  context: Readonly<RouterContextProvider>,
  scope: BackofficeContextScope,
  sessionId: string,
  instructions: string | null,
): Promise<{ taskId: number | null; error: string | null }> {
  const { callRoute, execution } = await createPiManagerRouteCaller(request, context, scope);
  const response = await callRoute("POST", "/sessions/:sessionId/compact", {
    pathParams: { sessionId },
    body: { instructions },
  });
  if (response.type === "json") {
    captureBackofficeServerEvent(context, {
      event: "session_compaction_admitted",
      userId: execution.userAuthority.userId,
      properties: {
        session_id: sessionId,
        task_id: response.data.taskId,
        has_instructions: instructions !== null,
        scope_kind: scope.kind,
      },
    });
    return { taskId: response.data.taskId, error: null };
  }
  if (response.type === "error") {
    throwPiManagerAuthorizationFailure(response);
    return { taskId: null, error: response.error.message };
  }
  return { taskId: null, error: `Failed to compact session (${response.status}).` };
}

export async function fetchPiManagerCompaction(
  request: Request,
  context: Readonly<RouterContextProvider>,
  scope: BackofficeContextScope,
  sessionId: string,
  taskId: string,
): Promise<PiAgentCompactionStatus> {
  const { callRoute } = await createPiManagerRouteCaller(request, context, scope);
  const response = await callRoute("GET", "/sessions/:sessionId/compactions/:taskId", {
    pathParams: { sessionId, taskId },
  });
  if (response.type === "json") {
    return response.data;
  }
  if (response.type === "error") {
    throwPiManagerAuthorizationFailure(response);
    throw Response.json(response.error, { status: response.status });
  }
  throw new Response(`Failed to fetch Pi compaction (${response.status}).`, {
    status: response.status,
  });
}

export async function abortPiManagerSession(
  request: Request,
  context: Readonly<RouterContextProvider>,
  scope: BackofficeContextScope,
  sessionId: string,
): Promise<string | null> {
  const { callRoute, execution } = await createPiManagerRouteCaller(request, context, scope);
  const response = await callRoute("POST", "/sessions/:sessionId/abort", {
    pathParams: { sessionId },
  });
  if (response.type === "empty") {
    captureBackofficeServerEvent(context, {
      event: "session_abort_completed",
      userId: execution.userAuthority.userId,
      properties: { session_id: sessionId, scope_kind: scope.kind },
    });
    return null;
  }
  if (response.type === "error") {
    throwPiManagerAuthorizationFailure(response);
    return response.error.message;
  }
  return `Failed to stop session (${response.status}).`;
}
