import type {
  PiManagerAgent,
  PiPromptReceipt,
  piPromptWhenBusySchema,
} from "@fragno-dev/backoffice-api/v0/pi";
import type { BackofficeContextScope } from "@fragno-dev/backoffice-api/v0/shared/scope";
import { createRouteCaller } from "@fragno-dev/core/api";
import type { RouterContextProvider } from "react-router";
import type { z } from "zod";

import type { ConversationView, EntryRecord } from "@earendil-works/pi-durable";

import {
  backofficeExecutionScopeRestriction,
  type BackofficeExecutionContext,
} from "@/backoffice-runtime/context";
import { requireBackofficeContext } from "@/fragno/auth/backoffice-principal.server";
import {
  piAgentViewSocketRequest,
  type PiAgentCompactionStatus,
  type PiAgentModelChoice,
  type PiAvailableModel,
} from "@/fragno/pi/agent/pi-agent-contract";
import { formatPiAgentName } from "@/fragno/pi/agent/pi-agent-name";
import type { piAgentSubagentListSchema } from "@/fragno/pi/manager/pi-manager-conversation-routes";
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

export type PiManagerAgentLookup =
  | { found: true; agent: PiManagerAgent }
  | { found: false; message: string };

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
  // A spent usage limit refuses the work, not the person, so the page says why where it was asked.
  if (response.error.code === "USAGE_LIMIT_EXCEEDED") {
    return;
  }
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

/** One agent of the scope, with whether it has started; the detail page opens on it. */
export async function fetchPiManagerAgent(
  request: Request,
  context: Readonly<RouterContextProvider>,
  scope: BackofficeContextScope,
  agentName: string,
): Promise<PiManagerAgentLookup> {
  const { callRoute } = await createPiManagerRouteCaller(request, context, scope);
  const response = await callRoute("GET", "/agents/:agentName", { pathParams: { agentName } });
  if (response.type === "json") {
    return { found: true, agent: response.data };
  }
  if (response.type === "error") {
    throwPiManagerAuthorizationFailure(response);
    return {
      found: false,
      message:
        response.error.code === "AGENT_NOT_FOUND"
          ? `${formatPiAgentName(agentName)} is not an agent in this scope.`
          : response.error.message,
    };
  }
  return { found: false, message: `Failed to fetch agent (${response.status}).` };
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
  if (!agentResponse.data.provisioned) {
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

/** The agent's view socket upgrade, which the agent serves once its manager authorizes the viewer. */
export async function openPiAgentViewSocket(
  request: Request,
  context: Readonly<RouterContextProvider>,
  scope: BackofficeContextScope,
  agentName: string,
): Promise<Response> {
  // The agent upgrades whatever it is handed, so a plain GET must not reach it.
  if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
    return new Response("The agent's view is a WebSocket; request an upgrade.", { status: 426 });
  }
  const execution = await requireBackofficeContext(request, context, scope);
  const { runtime } = context.get(BackofficeWorkerContext);
  const agent = { scope, agentName };
  return await runtime.objects
    .piAgent(agent)
    .fetchAuthorized(piAgentViewSocketRequest(agent), { execution, propagationContext: null });
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
    whenPaused: "wait" | "resume";
    /** A built-in agent's model for this turn; null keeps the conversation's. */
    model: PiAgentModelChoice | null;
  },
): Promise<{ receipt: PiPromptReceipt; error: null } | { receipt: null; error: string }> {
  const { callRoute, execution } = await createPiManagerRouteCaller(request, context, scope);
  const response = await callRoute("POST", "/agents/:agentName/prompts", {
    pathParams: { agentName },
    // Middleware overwrites the provenance with the authenticated caller's before validation.
    // People are not agents, so nothing replies to them. People talk with the agent itself.
    body: {
      ...input,
      subagent: false,
      replyTo: null,
      askingToolCall: null,
      provenance: callerProvenance(execution),
    },
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

export async function fetchPiManagerEntryPage(
  request: Request,
  context: Readonly<RouterContextProvider>,
  scope: BackofficeContextScope,
  agentName: string,
  input: { before: string; cursor: string | null; pageSize: string },
): Promise<PiManagerEntryPage> {
  const { callRoute } = await createPiManagerRouteCaller(request, context, scope);
  const response = await callRoute("GET", "/agents/:agentName/entries", {
    pathParams: { agentName },
    query: {
      before: input.before,
      pageSize: input.pageSize,
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

/** The agent's latest subagents, newest first, with where each stands. */
export type PiManagerSubagentList = z.infer<typeof piAgentSubagentListSchema>;

export async function fetchPiManagerSubagents(
  request: Request,
  context: Readonly<RouterContextProvider>,
  scope: BackofficeContextScope,
  agentName: string,
): Promise<PiManagerSubagentList> {
  const { callRoute } = await createPiManagerRouteCaller(request, context, scope);
  const response = await callRoute("GET", "/agents/:agentName/subagents", {
    pathParams: { agentName },
  });
  if (response.type === "json") {
    return response.data;
  }
  if (response.type === "error") {
    throwPiManagerAuthorizationFailure(response);
    throw Response.json(response.error, { status: response.status });
  }
  throw new Response(`Failed to list Pi subagents (${response.status}).`, {
    status: response.status,
  });
}

/** A subagent's conversation view; null while it waits for a conversation, or for none. */
export async function fetchPiManagerSubagentView(
  request: Request,
  context: Readonly<RouterContextProvider>,
  scope: BackofficeContextScope,
  agentName: string,
  requestId: string,
): Promise<ConversationView | null> {
  const { callRoute } = await createPiManagerRouteCaller(request, context, scope);
  const response = await callRoute("GET", "/agents/:agentName/subagents/:requestId/view", {
    pathParams: { agentName, requestId },
  });
  if (response.type === "json") {
    // The manager forwards Pi's view unchanged.
    return response.data as ConversationView;
  }
  if (response.type === "error") {
    throwPiManagerAuthorizationFailure(response);
    if (response.error.code === "SUBAGENT_NOT_FOUND") {
      return null;
    }
    throw Response.json(response.error, { status: response.status });
  }
  throw new Response(`Failed to read the Pi subagent (${response.status}).`, {
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
  // The download is the whole history, which the chat also reaches by loading earlier entries.
  const url = new URL(
    `/api/pi-manager/agents/${encodeURIComponent(agentName)}/export?history=true`,
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

export async function resumePiManagerAgent(
  request: Request,
  context: Readonly<RouterContextProvider>,
  scope: BackofficeContextScope,
  agentName: string,
): Promise<string | null> {
  const { callRoute, execution } = await createPiManagerRouteCaller(request, context, scope);
  const response = await callRoute("POST", "/agents/:agentName/resume", {
    pathParams: { agentName },
    // Middleware overwrites the provenance with the authenticated caller's before validation.
    body: { provenance: callerProvenance(execution) },
  });
  if (response.type === "empty") {
    return null;
  }
  if (response.type === "error") {
    throwPiManagerAuthorizationFailure(response);
    return response.error.message;
  }
  return `Failed to resume the agent (${response.status}).`;
}

export async function resetPiManagerAgent(
  request: Request,
  context: Readonly<RouterContextProvider>,
  scope: BackofficeContextScope,
  agentName: string,
): Promise<string | null> {
  const { callRoute, execution } = await createPiManagerRouteCaller(request, context, scope);
  const response = await callRoute("POST", "/agents/:agentName/reset", {
    pathParams: { agentName },
  });
  if (response.type === "empty") {
    captureBackofficeServerEvent(context, {
      event: "agent_context_reset",
      userId: execution.userAuthority.userId,
      properties: { agent_name: agentName, scope_kind: scope.kind },
    });
    return null;
  }
  if (response.type === "error") {
    throwPiManagerAuthorizationFailure(response);
    return response.error.message;
  }
  return `Failed to clear the context (${response.status}).`;
}

export async function stopPiManagerAgent(
  request: Request,
  context: Readonly<RouterContextProvider>,
  scope: BackofficeContextScope,
  agentName: string,
): Promise<string | null> {
  const { callRoute, execution } = await createPiManagerRouteCaller(request, context, scope);
  const response = await callRoute("POST", "/agents/:agentName/stop", {
    pathParams: { agentName },
    // Middleware overwrites the provenance with the authenticated caller's before validation.
    body: { provenance: callerProvenance(execution) },
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
