import { awaitWithContext } from "@earendil-works/chord/context";
import {
  type PiAgentDefinition,
  type PiAgentDefinitionCreate,
  type PiManagerAgent,
  type PiManagerAgentDirectory,
  type PiPromptReceipt,
  type piPromptWhenBusySchema,
} from "@fragno-dev/backoffice-api/v0/pi";
import { piAgentNameSchema } from "@fragno-dev/backoffice-api/v0/shared/pi-agent-name";
import type { z } from "zod";

import type { Context } from "@earendil-works/chord";
import type { ConversationView, SubmissionRecord } from "@earendil-works/pi-durable";

import type { BackofficeExecutionContext } from "@/backoffice-runtime/context";
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
import {
  PI_AGENT_SUBMISSION_WAIT_MAX_MS,
  type PiAgentNotification,
  type PiAgentQueueSubmission,
  type PiAgentSubmissionWait,
} from "@/fragno/pi/agent/pi-agent-contract";

export type PiManagerAgentInput = { agentName: string };
export type PiManagerSubmitPromptInput = {
  agentName: string;
  content: string;
  requestId?: string;
  whenBusy?: z.infer<typeof piPromptWhenBusySchema>;
  billingOrganizationId?: string | null;
};
export type PiManagerGetSubmissionInput = { agentName: string; requestId: string };
export type PiManagerRunPromptInput = PiManagerSubmitPromptInput & { timeoutMs?: number };
export type PiManagerNotifyAgentInput = { agentName: string } & PiAgentNotification;

/** `view` is null until the agent's conversation has received its first turn. */
export type PiManagerAgentDetail = PiManagerAgent & { view: ConversationView | null };
export type PiManagerPromptResult = {
  agentName: string;
  view: ConversationView;
  submission: SubmissionRecord;
  assistantText: string;
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
/**
 * Opens a started agent's view stream (see `pi.agent.watch`) for the execution, which needs
 * `pi.read`. Aborting `signal` closes it.
 */
export async function watchPiManagerAgent(input: {
  runtime: BackofficeRuntimeServices;
  kernel: BackofficeKernel;
  execution: BackofficeExecutionContext;
  agentName: string;
  signal: AbortSignal;
}): Promise<ReadableStream<Uint8Array>> {
  const manager = input.kernel.scoped(
    "PI_MANAGER",
    input.execution.scope,
    input.runtime.objects.piManager,
  );
  const response = await manager.http.fetchAuthorized(
    new Request(
      `https://pi-manager.do/api/pi-manager/agents/${encodeURIComponent(input.agentName)}/view-stream`,
      { method: "GET", headers: { accept: "application/x-ndjson" }, signal: input.signal },
    ),
    { execution: input.execution, propagationContext: null },
  );
  if (!response.ok || !response.body) {
    throw piManagerRuntimeRequestError(response.status, await response.text());
  }
  return response.body;
}

export type PiManagerRuntime = {
  listAgents(): Promise<PiManagerAgentDirectory>;
  getAgent(input: PiManagerAgentInput): Promise<PiManagerAgentDetail>;
  createAgent(input: PiAgentDefinitionCreate): Promise<PiAgentDefinition>;
  updateAgent(input: PiAgentDefinitionCreate): Promise<PiAgentDefinition>;
  deleteAgent(input: PiManagerAgentInput): Promise<void>;
  submitPrompt(input: PiManagerSubmitPromptInput): Promise<PiPromptReceipt>;
  getSubmission(
    input: PiManagerGetSubmissionInput,
  ): Promise<SubmissionRecord | PiAgentQueueSubmission>;
  runPrompt(input: PiManagerRunPromptInput): Promise<PiManagerPromptResult>;
  /** Writes an event into a started agent's conversation and asks it to handle the event. */
  notifyAgent(input: PiManagerNotifyAgentInput): Promise<void>;
  abortAgent(input: PiManagerAgentInput): Promise<void>;
};

function assistantTextFromSubmission(view: ConversationView, submission: SubmissionRecord): string {
  if (submission.status !== "done" || submission.type !== "input") {
    return "";
  }
  const answer = view.entries.find((entry) => entry.id === submission.answer);
  return (
    answer?.model
      ?.flatMap((message) =>
        message.role === "assistant"
          ? message.content.flatMap((block) => (block.type === "text" ? [block.text] : []))
          : [],
      )
      .join("") ?? ""
  );
}

/** Creates a runtime for the durable Pi directory selected by the trusted execution scope. */
export function createPiManagerRuntime(input: {
  runtime: BackofficeRuntimeServices;
  kernel: BackofficeKernel;
  execution: BackofficeExecutionContext;
  defaultBillingOrganizationId?: string | null;
  createPromptRequestId?: () => string;
  context?: Context;
}): PiManagerRuntime {
  const createPromptRequestId = input.createPromptRequestId ?? (() => crypto.randomUUID());

  async function awaitRequest<T>(promise: Promise<T>): Promise<T> {
    input.context?.abortSignal?.throwIfAborted();
    return input.context ? await awaitWithContext(promise, input.context) : await promise;
  }

  async function request<T>(
    route: string,
    body: unknown,
    method: "GET" | "POST" | "PUT" | "DELETE" = body === null ? "GET" : "POST",
  ): Promise<T> {
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
    if (response.status === 204) {
      return undefined as T;
    }
    // The signed manager response is authoritative; Pi owns its structural view and submission.
    return (await response.json()) as T;
  }

  function agentRoute(agentName: string) {
    return `/agents/${encodeURIComponent(piAgentNameSchema.parse(agentName.trim()))}`;
  }

  function submissionRoute({ agentName, requestId }: PiManagerGetSubmissionInput) {
    const normalizedRequestId = requestId.trim();
    if (!normalizedRequestId) {
      throw new Error("PI_MANAGER_PROMPT_REQUEST_ID_REQUIRED");
    }
    return `${agentRoute(agentName)}/submissions/${encodeURIComponent(normalizedRequestId)}`;
  }

  async function getSubmission(
    input: PiManagerGetSubmissionInput,
  ): Promise<SubmissionRecord | PiAgentQueueSubmission> {
    return await request<SubmissionRecord | PiAgentQueueSubmission>(submissionRoute(input), null);
  }

  async function waitForSubmission(
    input: PiManagerGetSubmissionInput,
    waitMs: number,
  ): Promise<PiAgentSubmissionWait> {
    const query = new URLSearchParams({ waitMs: String(waitMs) });
    return await request<PiAgentSubmissionWait>(`${submissionRoute(input)}/wait?${query}`, null);
  }

  const managerRuntime: PiManagerRuntime = {
    async listAgents() {
      return await request<PiManagerAgentDirectory>("/agents", null);
    },
    async getAgent({ agentName }) {
      const route = agentRoute(agentName);
      const agent = await request<PiManagerAgent>(route, null);
      return {
        ...agent,
        view: agent.provisioning ? await request<ConversationView>(`${route}/view`, null) : null,
      };
    },
    async createAgent(definition) {
      return await request<PiAgentDefinition>("/agents", definition);
    },
    async updateAgent({ agentName, ...definition }) {
      return await request<PiAgentDefinition>(agentRoute(agentName), definition, "PUT");
    },
    async deleteAgent({ agentName }) {
      await request(agentRoute(agentName), null, "DELETE");
    },
    async submitPrompt({ agentName, content, requestId, whenBusy, billingOrganizationId }) {
      const normalizedContent = content.trim();
      if (!normalizedContent) {
        throw new Error("PI_MANAGER_PROMPT_CONTENT_REQUIRED");
      }
      return await request<PiPromptReceipt>(`${agentRoute(agentName)}/prompts`, {
        requestId: requestId?.trim() || createPromptRequestId(),
        content: normalizedContent,
        ...(whenBusy ? { whenBusy } : {}),
        // Only an agent's first turn uses it, to choose a user- or system-scoped billing owner.
        billingOrganizationId:
          billingOrganizationId === undefined
            ? (input.defaultBillingOrganizationId ?? null)
            : billingOrganizationId,
      });
    },
    getSubmission,
    async runPrompt({ timeoutMs = 120_000, ...prompt }) {
      if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
        throw new Error("PI_MANAGER_PROMPT_TIMEOUT_INVALID: expected positive milliseconds.");
      }
      const receipt = await managerRuntime.submitPrompt(prompt);
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const remainingMs = deadline - Date.now();
        if (remainingMs <= 0) {
          throw new Error(
            `PI_MANAGER_PROMPT_TIMED_OUT: ${prompt.agentName}; request ${receipt.requestId} stays queued or running durably.`,
          );
        }
        const result = await waitForSubmission(
          { agentName: prompt.agentName, requestId: receipt.requestId },
          Math.min(remainingMs, PI_AGENT_SUBMISSION_WAIT_MAX_MS),
        );
        if (result.status === "pending") {
          continue;
        }
        if (result.submission.status === "dropped") {
          throw new PiManagerRuntimeRequestError(
            409,
            "PI_MANAGER_PROMPT_DROPPED",
            `${prompt.agentName}; request ${receipt.requestId} was dropped: ${result.submission.reason}`,
          );
        }
        const view = await request<ConversationView>(`${agentRoute(prompt.agentName)}/view`, null);
        return {
          agentName: prompt.agentName,
          view,
          submission: result.submission,
          assistantText: assistantTextFromSubmission(view, result.submission),
        };
      }
    },
    async notifyAgent({ agentName, ...notification }) {
      await request(`${agentRoute(agentName)}/notifications`, notification);
    },
    async abortAgent({ agentName }) {
      await request(`${agentRoute(agentName)}/abort`, {});
    },
  };

  return managerRuntime;
}
