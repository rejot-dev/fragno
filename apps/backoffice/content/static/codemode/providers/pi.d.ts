// pi tools
type PiCodemodeProvider = {
  /** Create a durable Pi agent in the current scoped directory. User-scoped child sessions inherit the calling Pi session or workflow's billing organization when billingOrganizationId is omitted. */
  createSession(input: PiCreateSessionInput): Promise<PiCreateSessionOutput>;
  /** Get a durable Pi directory record and its conversation view. */
  getSession(input: PiGetSessionInput): Promise<PiGetSessionOutput>;
  /** List one cursor-paginated page from the durable Pi directory. */
  listSessions(input: PiListSessionsInput): Promise<PiListSessionsOutput>;
  /** Durably admit a prompt and return its deduplicated submission receipt. */
  submitPrompt(input: PiSubmitPromptInput): Promise<PiSubmitPromptOutput>;
  /** Get the durable status of one prompt submission. */
  getSubmission(input: PiGetSubmissionInput): Promise<unknown>;
  /** Durably admit a prompt, wait for settlement, and return its conversation view. */
  runPrompt(input: PiRunPromptInput): Promise<PiRunPromptOutput>;
  /** Abort active foreground and background work in a durable Pi agent. */
  abortSession(input: PiAbortSessionInput): Promise<PiAbortSessionOutput>;
};
declare const pi: PiCodemodeProvider;

type PiCreateSessionInput = {
  requestId?: string;
  billingOrganizationId?: string | null;
  instructions?: string;
  model?: {
    provider: string;
    modelId: string;
  };
  name?: string | null;
};
type PiCreateSessionOutput = {
  sessionId: string;
  name: string | null;
  model: {
    provider: string;
    modelId: string;
  };
  instructions: string;
  billingOrganizationId: string | null;
};
type PiGetSessionInput = {
  sessionId: string;
};
type PiGetSessionOutput = {
  sessionId: string;
  name: string | null;
  model: {
    provider: string;
    modelId: string;
  };
  instructions: string;
  billingOrganizationId: string | null;
  createdAt: string;
  view: unknown;
};
type PiListSessionsInput = {
  cursor?: string;
  pageSize?: number;
};
type PiListSessionsOutput = {
  sessions: {
    sessionId: string;
    name: string | null;
    model: {
      provider: string;
      modelId: string;
    };
    instructions: string;
    billingOrganizationId: string | null;
    createdAt: string;
  }[];
  cursor: string | null;
  hasNextPage: boolean;
};
type PiSubmitPromptInput = {
  sessionId: string;
  content: string;
  requestId?: string;
  whenBusy?: "followUp" | "steer" | "reject";
};
type PiSubmitPromptOutput = {
  submissionId: number;
  requestId: string;
};
type PiGetSubmissionInput = {
  sessionId: string;
  requestId: string;
};
type PiRunPromptInput = {
  sessionId: string;
  content: string;
  requestId?: string;
  whenBusy?: "followUp" | "steer" | "reject";
  timeoutMs?: number;
};
type PiRunPromptOutput = {
  sessionId: string;
  name: string | null;
  model: {
    provider: string;
    modelId: string;
  };
  instructions: string;
  billingOrganizationId: string | null;
  createdAt: string;
  view: unknown;
  submission: unknown;
  assistantText: string;
};
type PiAbortSessionInput = {
  sessionId: string;
};
type PiAbortSessionOutput = {
  aborted: true;
};
