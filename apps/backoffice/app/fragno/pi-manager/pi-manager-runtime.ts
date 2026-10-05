import { awaitWithContext } from "@earendil-works/chord/context";

import type { Context } from "@earendil-works/chord";
import type { ConversationView, SubmissionRecord } from "@earendil-works/pi-durable";

import type { BackofficeExecutionContext } from "@/backoffice-runtime/context";
import type { BackofficeKernel } from "@/backoffice-runtime/kernel";
import { BACKOFFICE_PERMISSION } from "@/backoffice-runtime/permissions";
import type { BackofficeRuntimeServices } from "@/backoffice-runtime/runtime-services";

import {
  PI_AGENT_SUBMISSION_WAIT_MAX_MS,
  type PiAgentConfig,
  type PiAgentSubmissionWait,
  type PiManagerSession,
} from "./pi-agent-contract";

export type PiManagerCreateSessionInput = {
  requestId?: string;
  billingOrganizationId?: string | null;
  instructions?: string;
  model?: PiAgentConfig["model"];
  name?: string | null;
};

export type PiManagerGetSessionInput = { sessionId: string };
export type PiManagerListSessionsInput = { cursor?: string; pageSize?: number };
export type PiManagerSubmitPromptInput = {
  sessionId: string;
  content: string;
  requestId?: string;
  whenBusy?: "followUp" | "steer" | "reject";
};
export type PiManagerGetSubmissionInput = { sessionId: string; requestId: string };
export type PiManagerRunPromptInput = PiManagerSubmitPromptInput & { timeoutMs?: number };
export type PiManagerAbortSessionInput = { sessionId: string };

export type PiManagerSessionDetail = PiManagerSession & { view: ConversationView };
export type PiManagerSessionPage = {
  sessions: PiManagerSession[];
  cursor: string | null;
  hasNextPage: boolean;
};
export type PiManagerPromptReceipt = { submissionId: number; requestId: string };
export type PiManagerPromptResult = PiManagerSessionDetail & {
  submission: SubmissionRecord;
  assistantText: string;
};

/** Structured manager failures survive runtime-tool and codemode boundaries. */
export class PiManagerRuntimeRequestError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
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
  createSession(input: PiManagerCreateSessionInput): Promise<PiAgentConfig>;
  getSession(input: PiManagerGetSessionInput): Promise<PiManagerSessionDetail>;
  listSessions(input: PiManagerListSessionsInput): Promise<PiManagerSessionPage>;
  submitPrompt(input: PiManagerSubmitPromptInput): Promise<PiManagerPromptReceipt>;
  getSubmission(input: PiManagerGetSubmissionInput): Promise<SubmissionRecord>;
  runPrompt(input: PiManagerRunPromptInput): Promise<PiManagerPromptResult>;
  abortSession(input: PiManagerAbortSessionInput): Promise<void>;
};

function assistantTextFromSubmission(
  detail: PiManagerSessionDetail,
  submission: SubmissionRecord,
): string {
  if (submission.status !== "done" || submission.type !== "input") {
    return "";
  }
  const answer = detail.view.entries.find((entry) => entry.id === submission.answer);
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
  createSessionRequestId?: () => string;
  createPromptRequestId?: () => string;
  context?: Context;
}): PiManagerRuntime {
  const createSessionRequestId = input.createSessionRequestId ?? (() => crypto.randomUUID());
  const createPromptRequestId = input.createPromptRequestId ?? (() => crypto.randomUUID());

  async function awaitRequest<T>(promise: Promise<T>): Promise<T> {
    input.context?.abortSignal?.throwIfAborted();
    return input.context ? await awaitWithContext(promise, input.context) : await promise;
  }

  async function request<T>(route: string, body: unknown): Promise<T> {
    await input.kernel.assertAuthorized({
      execution: input.execution,
      operation: body === null ? BACKOFFICE_PERMISSION.pi.read : BACKOFFICE_PERMISSION.pi.modify,
      resource: { kind: "pi-session-directory", scope: input.execution.scope },
    });
    const object = input.kernel.scoped(
      "PI_MANAGER",
      input.execution.scope,
      input.runtime.objects.piManager,
    );
    const response = await awaitRequest(
      object.http.fetchAuthorized(
        new Request(`https://pi-manager.do/api/pi-manager${route}`, {
          method: body === null ? "GET" : "POST",
          headers: body === null ? {} : { "content-type": "application/json" },
          body: body === null ? undefined : JSON.stringify(body),
        }),
        {
          execution: input.execution,
          propagationContext: null,
          authorization: "preauthorized",
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

  function sessionRoute(sessionId: string) {
    const normalizedSessionId = sessionId.trim();
    if (!normalizedSessionId) {
      throw new Error("PI_MANAGER_SESSION_ID_REQUIRED");
    }
    return `/sessions/${encodeURIComponent(normalizedSessionId)}`;
  }

  function submissionRoute({ sessionId, requestId }: PiManagerGetSubmissionInput) {
    const normalizedRequestId = requestId.trim();
    if (!normalizedRequestId) {
      throw new Error("PI_MANAGER_PROMPT_REQUEST_ID_REQUIRED");
    }
    return `${sessionRoute(sessionId)}/submissions/${encodeURIComponent(normalizedRequestId)}`;
  }

  async function getSubmission(input: PiManagerGetSubmissionInput): Promise<SubmissionRecord> {
    return await request<SubmissionRecord>(submissionRoute(input), null);
  }

  async function waitForSubmission(
    input: PiManagerGetSubmissionInput,
    waitMs: number,
  ): Promise<PiAgentSubmissionWait> {
    const query = new URLSearchParams({ waitMs: String(waitMs) });
    return await request<PiAgentSubmissionWait>(`${submissionRoute(input)}/wait?${query}`, null);
  }

  const managerRuntime: PiManagerRuntime = {
    async createSession(args) {
      const billingOrganizationId =
        args.billingOrganizationId ?? input.defaultBillingOrganizationId ?? null;
      if (
        billingOrganizationId !== null &&
        (input.execution.scope.kind === "user" || input.execution.scope.kind === "system")
      ) {
        await input.kernel.assertAuthorized({
          execution: {
            ...input.execution,
            scope: { kind: "org", orgId: billingOrganizationId },
          },
          operation: BACKOFFICE_PERMISSION.pi.modify,
          resource: { kind: "pi-session-billing" },
        });
      }
      return await request<PiAgentConfig>("/sessions", {
        requestId: args.requestId?.trim() || createSessionRequestId(),
        name: args.name ?? null,
        model: args.model,
        instructions: args.instructions ?? "",
        billingOrganizationId,
      });
    },
    async getSession({ sessionId }) {
      const route = sessionRoute(sessionId);
      const [session, view] = await Promise.all([
        request<PiManagerSession>(route, null),
        request<ConversationView>(`${route}/view`, null),
      ]);
      return { ...session, view };
    },
    async listSessions({ cursor, pageSize = 20 }) {
      if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100) {
        throw new Error("PI_MANAGER_SESSION_PAGE_SIZE_INVALID: expected an integer from 1 to 100.");
      }
      const query = new URLSearchParams({ pageSize: String(pageSize) });
      if (cursor) {
        query.set("cursor", cursor);
      }
      return await request<PiManagerSessionPage>(`/sessions?${query}`, null);
    },
    async submitPrompt({ sessionId, content, requestId, whenBusy }) {
      const normalizedContent = content.trim();
      if (!normalizedContent) {
        throw new Error("PI_MANAGER_PROMPT_CONTENT_REQUIRED");
      }
      return await request<PiManagerPromptReceipt>(`${sessionRoute(sessionId)}/prompts`, {
        requestId: requestId?.trim() || createPromptRequestId(),
        content: normalizedContent,
        ...(whenBusy ? { whenBusy } : {}),
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
            `PI_MANAGER_PROMPT_TIMED_OUT: ${prompt.sessionId}; admitted request ${receipt.requestId} continues durably.`,
          );
        }
        const result = await waitForSubmission(
          { sessionId: prompt.sessionId, requestId: receipt.requestId },
          Math.min(remainingMs, PI_AGENT_SUBMISSION_WAIT_MAX_MS),
        );
        if (result.status === "pending") {
          continue;
        }
        const detail = await managerRuntime.getSession({ sessionId: prompt.sessionId });
        return {
          ...detail,
          submission: result.submission,
          assistantText: assistantTextFromSubmission(detail, result.submission),
        };
      }
    },
    async abortSession({ sessionId }) {
      await request(`${sessionRoute(sessionId)}/abort`, {});
    },
  };

  return managerRuntime;
}
