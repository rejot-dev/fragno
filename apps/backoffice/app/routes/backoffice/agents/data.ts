import type {
  PiManagerAgent,
  PiManagerAgentDirectory,
  PiPromptReceipt,
  piPromptWhenBusySchema,
} from "@fragno-dev/backoffice-api/v0/pi";
import type { BackofficeContextScope } from "@fragno-dev/backoffice-api/v0/shared/scope";
import { createRouteCaller } from "@fragno-dev/core/api";
import type { RouterContextProvider } from "react-router";
import type { z } from "zod";

import type { ConversationView, EntryRecord, SubmissionRecord } from "@earendil-works/pi-durable";

import {
  backofficeExecutionScopeRestriction,
  type BackofficeExecutionContext,
} from "@/backoffice-runtime/context";
import { requireBackofficeContext } from "@/fragno/auth/backoffice-principal.server";
import type {
  PiAgentCompactionStatus,
  PiAvailableModel,
} from "@/fragno/pi/agent/pi-agent-contract";
import type { createPiManagerFragment } from "@/fragno/pi/manager/pi-manager-fragment";
import { captureBackofficeServerEvent } from "@/posthog.server";
import { BackofficeWorkerContext } from "@/worker-runtime/router-context";

type PiManagerFragment = ReturnType<typeof createPiManagerFragment>;

type PiRouteError = { message: string; code: string };
type PiRouteErrorResponse = { type: "error"; status: number; error: PiRouteError };

/** `view` is null until the agent's conversation has received its first turn. */
export type PiManagerAgentDetail = {
  agent: PiManagerAgent;
  view: ConversationView | null;
};

export type PiManagerAgentsResult = PiManagerAgentDirectory & {
  agentsError: string | null;
};

export type PiManagerAgentDetailResult = {
  detail: PiManagerAgentDetail | null;
  status?: number;
  agentError: PiRouteError | null;
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

function callerProvenance(execution: BackofficeExecutionContext) {
  return {
    actors: execution.actors,
    scopeRestriction: backofficeExecutionScopeRestriction(execution),
  };
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

export async function fetchPiManagerAgents(
  request: Request,
  context: Readonly<RouterContextProvider>,
  scope: BackofficeContextScope,
): Promise<PiManagerAgentsResult> {
  const { callRoute } = await createPiManagerRouteCaller(request, context, scope);
  const response = await callRoute("GET", "/agents", {});

  if (response.type === "json") {
    return { ...response.data, agentsError: null };
  }
  if (response.type === "error") {
    throwPiManagerAuthorizationFailure(response);
    return { agents: [], agentsError: response.error.message };
  }
  return {
    agents: [],
    agentsError: `Failed to fetch agents (${response.status}).`,
  };
}

export async function fetchPiManagerAgentDetail(
  request: Request,
  context: Readonly<RouterContextProvider>,
  scope: BackofficeContextScope,
  agentName: string,
): Promise<PiManagerAgentDetailResult> {
  const { callRoute } = await createPiManagerRouteCaller(request, context, scope);
  const agentResponse = await callRoute("GET", "/agents/:agentName", { pathParams: { agentName } });
  if (agentResponse.type === "error") {
    throwPiManagerAuthorizationFailure(agentResponse);
    return { detail: null, status: agentResponse.status, agentError: agentResponse.error };
  }
  if (agentResponse.type !== "json") {
    return {
      detail: null,
      status: agentResponse.status,
      agentError: {
        code: "PI_AGENT_FETCH_FAILED",
        message: `Failed to fetch agent (${agentResponse.status}).`,
      },
    };
  }
  if (!agentResponse.data.provisioning) {
    return { detail: { agent: agentResponse.data, view: null }, agentError: null };
  }

  const viewResponse = await callRoute("GET", "/agents/:agentName/view", {
    pathParams: { agentName },
  });
  if (viewResponse.type === "error") {
    throwPiManagerAuthorizationFailure(viewResponse);
    return { detail: null, status: viewResponse.status, agentError: viewResponse.error };
  }
  if (viewResponse.type !== "json") {
    return {
      detail: null,
      status: viewResponse.status,
      agentError: {
        code: "PI_AGENT_VIEW_FETCH_FAILED",
        message: `Failed to fetch the agent conversation (${viewResponse.status}).`,
      },
    };
  }

  // The manager intentionally keeps the agent-owned structural view opaque.
  const view = viewResponse.data as ConversationView;
  return { detail: { agent: agentResponse.data, view }, agentError: null };
}

/** Opens the authorized NDJSON stream produced by the agent's durable conversation. */
export async function fetchPiManagerAgentViewStream(
  request: Request,
  context: Readonly<RouterContextProvider>,
  scope: BackofficeContextScope,
  agentName: string,
): Promise<Response> {
  const { execution, manager } = await createPiManagerAuthorizedAccess(request, context, scope);
  const url = new URL(
    `/api/pi-manager/agents/${encodeURIComponent(agentName)}/view-stream`,
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

export async function submitPiManagerPrompt(
  request: Request,
  context: Readonly<RouterContextProvider>,
  scope: BackofficeContextScope,
  agentName: string,
  input: {
    requestId: string;
    content: string;
    whenBusy: z.infer<typeof piPromptWhenBusySchema>;
    billingOrganizationId: string | null;
  },
): Promise<{ receipt: PiPromptReceipt; error: null } | { receipt: null; error: string }> {
  const { callRoute, execution } = await createPiManagerRouteCaller(request, context, scope);
  const response = await callRoute("POST", "/agents/:agentName/prompts", {
    pathParams: { agentName },
    // Middleware overwrites the provenance with the authenticated caller's before validation.
    body: { ...input, provenance: callerProvenance(execution) },
  });
  if (response.type === "json") {
    captureBackofficeServerEvent(context, {
      event: "agent_prompt_admitted",
      userId: execution.userAuthority.userId,
      properties: {
        agent_name: agentName,
        prompt_request_id: response.data.requestId,
        when_busy: input.whenBusy,
        scope_kind: scope.kind,
      },
    });
    return { receipt: response.data, error: null };
  }
  if (response.type === "error") {
    throwPiManagerAuthorizationFailure(response);
    return { receipt: null, error: response.error.message };
  }
  return { receipt: null, error: `Failed to send message (${response.status}).` };
}

export async function fetchPiManagerSubmission(
  request: Request,
  context: Readonly<RouterContextProvider>,
  scope: BackofficeContextScope,
  agentName: string,
  requestId: string,
): Promise<SubmissionRecord | null> {
  const { callRoute } = await createPiManagerRouteCaller(request, context, scope);
  const response = await callRoute("GET", "/agents/:agentName/submissions/:requestId", {
    pathParams: { agentName, requestId },
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
  agentName: string,
  input: { cursor?: string | null; pageSize?: number },
): Promise<PiManagerEntryPage> {
  const { callRoute } = await createPiManagerRouteCaller(request, context, scope);
  const response = await callRoute("GET", "/agents/:agentName/entries", {
    pathParams: { agentName },
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
export async function fetchPiManagerAgentExport(
  request: Request,
  context: Readonly<RouterContextProvider>,
  scope: BackofficeContextScope,
  agentName: string,
): Promise<Response> {
  const { execution, manager } = await createPiManagerAuthorizedAccess(request, context, scope);
  const url = new URL(
    `/api/pi-manager/agents/${encodeURIComponent(agentName)}/export`,
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

export async function compactPiManagerAgent(
  request: Request,
  context: Readonly<RouterContextProvider>,
  scope: BackofficeContextScope,
  agentName: string,
  instructions: string | null,
): Promise<{ taskId: number | null; error: string | null }> {
  const { callRoute, execution } = await createPiManagerRouteCaller(request, context, scope);
  const response = await callRoute("POST", "/agents/:agentName/compact", {
    pathParams: { agentName },
    // Middleware overwrites the provenance with the authenticated caller's before validation.
    body: { instructions, provenance: callerProvenance(execution) },
  });
  if (response.type === "json") {
    captureBackofficeServerEvent(context, {
      event: "agent_compaction_admitted",
      userId: execution.userAuthority.userId,
      properties: {
        agent_name: agentName,
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
  return { taskId: null, error: `Failed to compact the conversation (${response.status}).` };
}

export async function fetchPiManagerCompaction(
  request: Request,
  context: Readonly<RouterContextProvider>,
  scope: BackofficeContextScope,
  agentName: string,
  taskId: string,
): Promise<PiAgentCompactionStatus> {
  const { callRoute } = await createPiManagerRouteCaller(request, context, scope);
  const response = await callRoute("GET", "/agents/:agentName/compactions/:taskId", {
    pathParams: { agentName, taskId },
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

export async function abortPiManagerAgent(
  request: Request,
  context: Readonly<RouterContextProvider>,
  scope: BackofficeContextScope,
  agentName: string,
): Promise<string | null> {
  const { callRoute, execution } = await createPiManagerRouteCaller(request, context, scope);
  const response = await callRoute("POST", "/agents/:agentName/abort", {
    pathParams: { agentName },
  });
  if (response.type === "empty") {
    captureBackofficeServerEvent(context, {
      event: "agent_abort_completed",
      userId: execution.userAuthority.userId,
      properties: { agent_name: agentName, scope_kind: scope.kind },
    });
    return null;
  }
  if (response.type === "error") {
    throwPiManagerAuthorizationFailure(response);
    return response.error.message;
  }
  return `Failed to stop the agent (${response.status}).`;
}
