// pi tools
type PiCodemodeProvider = {
  /** List the built-in agents and the agents defined in the current scope. */
  listAgents(input: PiListAgentsInput): Promise<PiListAgentsOutput>;
  /** Get one defined agent and its durable conversation view. */
  getAgent(input: PiGetAgentInput): Promise<PiGetAgentOutput>;
  /** Read the most recent messages of a started agent's conversation, oldest first, by the agent's name; call `pi.listAgents` to find the agent a request means rather than assuming it is you: what users said and the agent answered, without thinking, tool calls, or tool results. Pass the returned `before` to read further back; it is null at the conversation's start. Includes history before compactions and resets. */
  listMessages(input: PiListMessagesInput): Promise<PiListMessagesOutput>;
  /** Write a started agent's whole conversation history to a JSONL file, by the agent's name; call `pi.listAgents` to find the agent a request means rather than assuming it is you. The file holds a header line, then every durable entry oldest first, including thinking, tool calls, tool results, and history before compactions and resets. */
  exportConversation(input: PiExportConversationInput): Promise<PiExportConversationOutput>;
  /** Define an agent in the current scope. Use permissions ["*"] unless the agent should be limited: each turn already runs with the prompter's permissions, and the grants only narrow them. */
  createAgent(input: PiCreateAgentInput): Promise<PiCreateAgentOutput>;
  /** Replace an agent's whole definition, including its permissions (["*"] narrows nothing). The agent keeps its conversation; the new definition applies from its next turn. */
  updateAgent(input: PiUpdateAgentInput): Promise<PiUpdateAgentOutput>;
  /** Idempotently delete an agent's definition. Its stored conversation is kept and resumes if the name is defined again. */
  deleteAgent(input: PiDeleteAgentInput): Promise<PiDeleteAgentOutput>;
  /** Durably queue a prompt for an agent, or steer its running turn, and return a receipt saying which. A request ID still queued is not queued twice. The turn runs with the caller's current permissions, narrowed by the agent's definition. Usage belongs to the agent scope's root owner, independently of the caller or their active organization. */
  submitPrompt(input: PiSubmitPromptInput): Promise<PiSubmitPromptOutput>;
  /** Get the durable status of one prompt submission. */
  getSubmission(input: PiGetSubmissionInput): Promise<unknown>;
  /** Durably queue a prompt for an agent, wait for its turn to settle, and return its conversation view. */
  runPrompt(input: PiRunPromptInput): Promise<PiRunPromptOutput>;
  /** Stop an agent: abort its running turn and background work, and pause its queue. Queued and new prompts wait until someone resumes the agent in Backoffice. */
  stopAgent(input: PiStopAgentInput): Promise<PiStopAgentOutput>;
  /** Record the scope's defined agents as pi agent.* events, for agents defined before those events were recorded, so views and routes built on the events see every agent. For each agent the events record missing, deleted, or with a different definition, it records agent.created or agent.updated with the current definition, and for each agent they record that is no longer defined, agent.deleted. Routes on those events run for each new event. A rerun records nothing new. Built-in agents are left out: they are defined in every scope. Returns the events it recorded. */
  backfillAgentEvents(input: PiBackfillAgentEventsInput): Promise<PiBackfillAgentEventsOutput>;
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
    instructions: string;
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
  instructions: string;
  agentName: string;
  managedBy:
    | {
        kind: "built-in";
      }
    | AutomationRouteManagedBy
    | null;
  view: unknown;
};
type PiListMessagesInput = {
  /** The agent whose conversation to read, by its name from `pi.listAgents`; it is yours only when you pass your own name. */
  agentName: string;
  /** How many of the most recent messages to return. */
  last?: number;
  /** A previous page's `before`, to read the messages preceding it. */
  before?: number | null;
};
type PiListMessagesOutput = {
  messages: (
    | {
        entryId: number;
        role: "user" | "assistant";
        text: string;
        sentAt: string;
      }
    | {
        entryId: number;
        role: "notification";
        notifications: {
          routeId: string | null;
          eventId: string;
        }[];
        sentAt: string;
      }
  )[];
  before: number | null;
};
type PiExportConversationInput = {
  /** The agent whose conversation to read, by its name from `pi.listAgents`; it is yours only when you pass your own name. */
  agentName: string;
  /** Absolute path of the .jsonl file to write under /workspace. */
  out: string;
};
type PiExportConversationOutput = {
  path: string;
  entryCount: number;
};
type PiCreateAgentInput = {
  description: string;
  model: string | null;
  permissions: string[];
  instructions: string;
  managedBy: AutomationRouteManagedBy | null;
  agentName: string;
};
type PiCreateAgentOutput = {
  description: string;
  model: string | null;
  permissions: string[];
  instructions: string;
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
  instructions: string;
  managedBy: AutomationRouteManagedBy | null;
  agentName: string;
};
type PiUpdateAgentOutput = {
  description: string;
  model: string | null;
  permissions: string[];
  instructions: string;
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
};
type PiSubmitPromptOutput = {
  requestId: string;
  status: "steered" | "queued";
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
  timeoutMs?: number;
};
type PiRunPromptOutput = {
  agentName: string;
  view: unknown;
  submission: unknown;
  assistantText: string;
};
type PiStopAgentInput = {
  agentName: string;
};
type PiStopAgentOutput = {
  stopped: true;
};
type PiBackfillAgentEventsInput = Record<string, unknown>;
type PiBackfillAgentEventsOutput = {
  agents: {
    agentName: string;
    eventType: "agent.created" | "agent.updated" | "agent.deleted";
  }[];
};
