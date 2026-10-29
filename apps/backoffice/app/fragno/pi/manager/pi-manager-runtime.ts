import { awaitWithContext } from "@earendil-works/chord/context";
import {
  type PiAgentCreated,
  type PiAgentDefinition,
  type PiAgentDefinitionCreate,
  type PiManagerAgent,
  type PiAgentMessagePage,
  type PiManagerAgentDirectory,
  type PiPromptReceipt,
  type PiPromptStatus,
  type piPromptWhenBusySchema,
} from "@fragno-dev/backoffice-api/v0/pi";
import { piAgentNameSchema } from "@fragno-dev/backoffice-api/v0/shared/pi-agent-name";
import { backofficeContextScopesEqual } from "@fragno-dev/backoffice-api/v0/shared/scope";
import type { z } from "zod";

import type { Context } from "@earendil-works/chord";

import {
  backofficeExecutionScopeRestriction,
  type BackofficeExecutionContext,
} from "@/backoffice-runtime/context";
import {
  type BackofficeKernel,
  BackofficeForbiddenError,
  isBackofficeForbiddenError,
} from "@/backoffice-runtime/kernel";
import {
  BackofficeOperationError,
  backofficeOperationErrorKindForStatus,
} from "@/backoffice-runtime/operation-error";
import type { BackofficeRuntimeServices } from "@/backoffice-runtime/runtime-services";
import type { PiAgentAddress, PiAgentNotification } from "@/fragno/pi/agent/pi-agent-contract";

import { backfillPiAgentEvents, type PiAgentBackfilledEvent } from "./pi-agent-change-events";

export type PiManagerAgentInput = { agentName: string };
export type PiManagerPromptInput = { agentName: string; requestId: string };
export type PiManagerSubmitPromptInput = {
  agentName: string;
  content: string;
  requestId?: string;
  whenBusy?: z.infer<typeof piPromptWhenBusySchema>;
  /** Notifies the calling agent of how the prompt ends; see `caller`. */
  notifyWhenDone?: boolean;
  /** Runs the prompt in a new conversation of the agent; see `pi.prompt.submit`. */
  subagent?: boolean;
};
export type PiManagerNotifyAgentInput = { agentName: string } & PiAgentNotification;
export type PiManagerListMessagesInput = {
  agentName: string;
  last: number;
  before: number | null;
  /** The request ID of the subagent whose conversation to read; null reads the agent's. */
  subagent: string | null;
};

/** Structured manager failures survive runtime-tool and codemode boundaries. */
export class PiManagerRuntimeRequestError extends BackofficeOperationError {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(backofficeOperationErrorKindForStatus(status), message);
    this.name = "PiManagerRuntimeRequestError";
    this.status = status;
    this.code = code;
  }
}

function piManagerRuntimeRequestError(status: number, responseText: string) {
  try {
    const parsed = JSON.parse(responseText) as unknown;
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      "code" in parsed &&
      typeof parsed.code === "string" &&
      "message" in parsed &&
      typeof parsed.message === "string"
    ) {
      const denial = {
        name: "BackofficeForbiddenError",
        reason: parsed.code,
        message: parsed.message,
      };
      if ((status === 403 || status === 503) && isBackofficeForbiddenError(denial)) {
        return new BackofficeForbiddenError(denial.message, denial.reason);
      }
      return new PiManagerRuntimeRequestError(status, parsed.code, parsed.message);
    }
  } catch {
    // Non-JSON failures still receive a stable fallback code at this HTTP boundary.
  }
  return new PiManagerRuntimeRequestError(
    status,
    "PI_MANAGER_RUNTIME_REQUEST_FAILED",
    responseText || `Pi manager request failed with HTTP ${status}.`,
  );
}

/** Durable Pi operations map directly to the scoped manager and agent contracts. */
export type PiManagerRuntime = {
  listAgents(): Promise<PiManagerAgentDirectory>;
  getAgent(input: PiManagerAgentInput): Promise<PiManagerAgent>;
  createAgent(input: PiAgentDefinitionCreate): Promise<PiAgentCreated>;
  updateAgent(input: PiAgentDefinitionCreate): Promise<PiAgentDefinition>;
  deleteAgent(input: PiManagerAgentInput): Promise<void>;
  submitPrompt(input: PiManagerSubmitPromptInput): Promise<PiPromptReceipt>;
  /** Where a submitted prompt stands; null when the agent never received it. */
  getPrompt(input: PiManagerPromptInput): Promise<PiPromptStatus | null>;
  /** Writes an event into a started agent's conversation and asks it to handle the event. */
  notifyAgent(input: PiManagerNotifyAgentInput): Promise<void>;
  /** Aborts the agent's work and pauses its queue until someone resumes it. */
  stopAgent(input: PiManagerAgentInput): Promise<void>;
  /** Records the scope's defined agents as `agent.*` events where the events lack them. */
  backfillAgentEvents(): Promise<{ agents: PiAgentBackfilledEvent[] }>;
  /** What users and the agent said, oldest first; see `pi.agent.messages`. */
  listMessages(input: PiManagerListMessagesInput): Promise<PiAgentMessagePage>;
  /** The agent's whole history as JSONL, newest entry last; see `pi.agent.export`. */
  exportConversation(input: PiManagerAgentInput): Promise<string>;
};

/**
 * Who calls: an agent's own turn, which prompts may notify, from the tool call `toolCallId` names,
 * which its page shows the subagents it starts under, or from no tool call, such as a prompt
 * section; a subagent's turn, which can neither be notified, as replies reach its agent's own
 * conversation, nor start subagents; or no agent.
 */
export type PiManagerCaller =
  | { kind: "agent"; agent: PiAgentAddress; toolCallId: string | null }
  | { kind: "subagent" }
  | { kind: "none" };

/** Creates a runtime for the durable Pi directory selected by the trusted execution scope. */
export function createPiManagerRuntime(input: {
  runtime: BackofficeRuntimeServices;
  kernel: BackofficeKernel;
  execution: BackofficeExecutionContext;
  caller: PiManagerCaller;
  createPromptRequestId?: () => string;
  context?: Context;
}): PiManagerRuntime {
  const createPromptRequestId = input.createPromptRequestId ?? (() => crypto.randomUUID());

  async function awaitRequest<T>(promise: Promise<T>): Promise<T> {
    input.context?.abortSignal?.throwIfAborted();
    return input.context ? await awaitWithContext(promise, input.context) : await promise;
  }

  async function fetchManager(
    route: string,
    body: unknown,
    method: "GET" | "POST" | "PUT" | "DELETE",
  ): Promise<Response> {
    const object = input.kernel.scoped(
      "PI_MANAGER",
      input.execution.scope,
      input.runtime.objects.piManager,
    );
    const response = await awaitRequest(
      object.http.fetchAuthorized(
        new Request(`https://pi-manager.do/api/pi-manager${route}`, {
          method,
          headers: body === null ? {} : { "content-type": "application/json" },
          body: body === null ? undefined : JSON.stringify(body),
        }),
        {
          execution: input.execution,
          propagationContext: null,
        },
      ),
    );
    if (!response.ok) {
      throw piManagerRuntimeRequestError(response.status, await response.text());
    }
    return response;
  }

  async function request<T>(
    route: string,
    body: unknown,
    method: "GET" | "POST" | "PUT" | "DELETE" = body === null ? "GET" : "POST",
  ): Promise<T> {
    const response = await fetchManager(route, body, method);
    if (response.status === 204) {
      return undefined as T;
    }
    // The signed manager response is authoritative.
    return (await response.json()) as T;
  }

  function agentRoute(agentName: string) {
    return `/agents/${encodeURIComponent(piAgentNameSchema.parse(agentName.trim()))}`;
  }

  return {
    async listAgents() {
      return await request<PiManagerAgentDirectory>("/agents", null);
    },
    async backfillAgentEvents() {
      const { agents } = await request<PiManagerAgentDirectory>("/agents", null);
      return {
        agents: await backfillPiAgentEvents({
          automations: input.runtime.objects.automations.for(input.execution.scope).commands,
          scope: input.execution.scope,
          definitions: agents
            .filter((agent) => agent.steward.kind !== "backoffice")
            .map(({ provisioned: _provisioned, ...definition }) => definition),
          occurredAt: new Date(),
          provenance: {
            actors: input.execution.actors,
            scopeRestriction: backofficeExecutionScopeRestriction(input.execution),
          },
          context: { propagationContext: null },
        }),
      };
    },
    async getAgent({ agentName }) {
      return await request<PiManagerAgent>(agentRoute(agentName), null);
    },
    async createAgent(definition) {
      return await request<PiAgentCreated>("/agents", definition);
    },
    async updateAgent({ agentName, ...definition }) {
      return await request<PiAgentDefinition>(agentRoute(agentName), definition, "PUT");
    },
    async deleteAgent({ agentName }) {
      await request(agentRoute(agentName), null, "DELETE");
    },
    async submitPrompt({ agentName, content, requestId, whenBusy, notifyWhenDone, subagent }) {
      const normalizedContent = content.trim();
      if (!normalizedContent) {
        throw new Error("PI_MANAGER_PROMPT_CONTENT_REQUIRED");
      }
      const { caller } = input;
      if (subagent && caller.kind === "subagent") {
        throw new PiManagerRuntimeRequestError(
          400,
          "SUBAGENT_NESTING_NOT_ALLOWED",
          "A subagent cannot start subagents; do the task yourself.",
        );
      }
      if (notifyWhenDone && caller.kind !== "agent") {
        throw new PiManagerRuntimeRequestError(
          400,
          "REPLY_NOT_ALLOWED",
          caller.kind === "subagent"
            ? "A subagent cannot be notified when a prompt ends; its reply would reach its agent's own conversation."
            : "Only an agent's turn can be notified when a prompt ends.",
        );
      }
      // Only an agent's own subagents show under the call that started them.
      const itself =
        caller.kind === "agent" &&
        caller.agent.agentName === piAgentNameSchema.parse(agentName.trim()) &&
        backofficeContextScopesEqual(caller.agent.scope, input.execution.scope);
      return await request<PiPromptReceipt>(`${agentRoute(agentName)}/prompts`, {
        requestId: requestId?.trim() || createPromptRequestId(),
        content: normalizedContent,
        ...(whenBusy ? { whenBusy } : {}),
        subagent: subagent ?? false,
        replyTo: notifyWhenDone && caller.kind === "agent" ? caller.agent : null,
        askingToolCall: subagent && itself ? caller.toolCallId : null,
      });
    },
    async getPrompt({ agentName, requestId }) {
      try {
        return await request<PiPromptStatus>(
          `${agentRoute(agentName)}/prompts/${encodeURIComponent(requestId)}`,
          null,
        );
      } catch (error) {
        // The agent has no such request, or no turns at all.
        if (error instanceof PiManagerRuntimeRequestError && error.status === 404) {
          return null;
        }
        throw error;
      }
    },
    async notifyAgent({ agentName, ...notification }) {
      await request(`${agentRoute(agentName)}/notifications`, notification);
    },
    async stopAgent({ agentName }) {
      await request(`${agentRoute(agentName)}/stop`, {});
    },
    async listMessages({ agentName, last, before, subagent }) {
      const query = new URLSearchParams({ last: String(last) });
      if (before !== null) {
        query.set("before", String(before));
      }
      if (subagent !== null) {
        query.set("subagent", subagent);
      }
      return await request<PiAgentMessagePage>(`${agentRoute(agentName)}/messages?${query}`, null);
    },
    async exportConversation({ agentName }) {
      const response = await fetchManager(`${agentRoute(agentName)}/export`, null, "GET");
      return await awaitRequest(response.text());
    },
  };
}
