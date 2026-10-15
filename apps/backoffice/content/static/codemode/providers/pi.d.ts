// pi tools
type PiCodemodeProvider = {
  /** List the built-in agents and the agents defined in the current scope. */
  listAgents(input: PiListAgentsInput): Promise<PiListAgentsOutput>;
  /** Get one defined agent and its durable conversation view. */
  getAgent(input: PiGetAgentInput): Promise<PiGetAgentOutput>;
  /** Define an agent in the current scope. Its instructions file must exist; edits to the file apply from the agent's next turn. */
  createAgent(input: PiCreateAgentInput): Promise<PiCreateAgentOutput>;
  /** Replace an agent's definition. The agent keeps its conversation; the new definition applies from its next turn. */
  updateAgent(input: PiUpdateAgentInput): Promise<PiUpdateAgentOutput>;
  /** Idempotently delete an agent's definition. Its stored conversation is kept and resumes if the name is defined again. */
  deleteAgent(input: PiDeleteAgentInput): Promise<PiDeleteAgentOutput>;
  /** Durably admit a prompt to an agent and return its deduplicated submission receipt. The turn runs with the caller's current permissions, narrowed by the agent's definition. A user- or system-scoped agent's first turn sets its billing organization; omitting billingOrganizationId inherits the calling Pi agent or workflow's. */
  submitPrompt(input: PiSubmitPromptInput): Promise<PiSubmitPromptOutput>;
  /** Get the durable status of one prompt submission. */
  getSubmission(input: PiGetSubmissionInput): Promise<unknown>;
  /** Durably admit a prompt to an agent, wait for settlement, and return its conversation view. */
  runPrompt(input: PiRunPromptInput): Promise<PiRunPromptOutput>;
  /** Abort an agent's active foreground and background work. */
  abortAgent(input: PiAbortAgentInput): Promise<PiAbortAgentOutput>;
};
declare const pi: PiCodemodeProvider;

type AutomationRouteManagedBy = {
  kind: "marketplace";
  listingId: string;
  resourceKey: string;
  version: string;
};
type PiListAgentsInput = Record<string, unknown>;
type PiListAgentsOutput = {
  agents: {
    description: string;
    model: string | null;
    permissions: string[];
    instructionsPath: string | null;
    agentName: string;
    managedBy:
      | {
          kind: "built-in";
        }
      | AutomationRouteManagedBy
      | null;
  }[];
};
type PiGetAgentInput = {
  agentName: string;
};
type PiGetAgentOutput = {
  description: string;
  model: string | null;
  permissions: string[];
  instructionsPath: string | null;
  agentName: string;
  managedBy:
    | {
        kind: "built-in";
      }
    | AutomationRouteManagedBy
    | null;
  view: unknown;
};
type PiCreateAgentInput = {
  description: string;
  model: string | null;
  permissions: string[];
  instructionsPath: string | null;
  managedBy: AutomationRouteManagedBy | null;
  agentName: string;
};
type PiCreateAgentOutput = {
  description: string;
  model: string | null;
  permissions: string[];
  instructionsPath: string | null;
  agentName: string;
  managedBy:
    | {
        kind: "built-in";
      }
    | AutomationRouteManagedBy
    | null;
};
type PiUpdateAgentInput = {
  description: string;
  model: string | null;
  permissions: string[];
  instructionsPath: string | null;
  managedBy: AutomationRouteManagedBy | null;
  agentName: string;
};
type PiUpdateAgentOutput = {
  description: string;
  model: string | null;
  permissions: string[];
  instructionsPath: string | null;
  agentName: string;
  managedBy:
    | {
        kind: "built-in";
      }
    | AutomationRouteManagedBy
    | null;
};
type PiDeleteAgentInput = {
  agentName: string;
};
type PiDeleteAgentOutput = {
  deleted: true;
};
type PiSubmitPromptInput = {
  agentName: string;
  content: string;
  requestId?: string;
  whenBusy?: "followUp" | "steer" | "reject";
  billingOrganizationId?: string | null;
};
type PiSubmitPromptOutput = {
  submissionId: number;
  requestId: string;
  whenBusy: "followUp" | "steer" | "reject";
};
type PiGetSubmissionInput = {
  agentName: string;
  requestId: string;
};
type PiRunPromptInput = {
  agentName: string;
  content: string;
  requestId?: string;
  whenBusy?: "followUp" | "steer" | "reject";
  billingOrganizationId?: string | null;
  timeoutMs?: number;
};
type PiRunPromptOutput = {
  agentName: string;
  view: unknown;
  submission: unknown;
  assistantText: string;
};
type PiAbortAgentInput = {
  agentName: string;
};
type PiAbortAgentOutput = {
  aborted: true;
};
