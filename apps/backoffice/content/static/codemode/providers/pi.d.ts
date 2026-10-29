// Agents: define, prompt, stop, and read conversations. Read to work with an agent, including your own definition.
type PiCodemodeProvider = {
  /**
   * List the built-in agents and the agents defined in the current scope.
   * Requires `pi.read`.
   */
  listAgents(input: PiListAgentsInput): Promise<PiListAgentsOutput>;
  /**
   * Get one defined agent.
   * Requires `pi.read`.
   */
  getAgent(input: PiGetAgentInput): Promise<PiGetAgentOutput>;
  /**
   * Read the most recent messages of a started agent's conversation, oldest first, by the agent's name; call `pi.listAgents` to find the agent a request means rather than assuming it is you: what users said and the agent answered, without thinking, tool calls, or tool results. Like the chat, it reads from the agent's newest compaction or clear on, with the compaction's summary where it was made. Pass the returned `before` to read further back; it is null at the newest compaction or clear, or the conversation's start. To read a prompt's answer, use `pi.getPrompt`. Pass `subagent` to read one of the agent's subagents instead.
   * Requires `pi.read`.
   */
  listMessages(input: PiListMessagesInput): Promise<PiListMessagesOutput>;
  /**
   * Write a started agent's conversation to a JSONL file, by the agent's name; call `pi.listAgents` to find the agent a request means rather than assuming it is you. The file holds a header line, then the durable entries oldest first, including thinking, tool calls, and tool results. Like the chat, it holds the entries from the agent's newest compaction or clear on, with that compaction or clear; pass `history` for every entry.
   * Requires `pi.read` and `upload.modify`.
   */
  exportConversation(input: PiExportConversationInput): Promise<PiExportConversationOutput>;
  /**
   * Define an agent in the current scope. Use permissions ["*"] unless the agent should be limited: each turn already runs with the prompter's permissions, and the grants only narrow them.
   * Requires `pi.manage`.
   */
  createAgent(input: PiCreateAgentInput): Promise<PiCreateAgentOutput>;
  /**
   * Replace an agent's whole definition, including its permissions (["*"] narrows nothing). The agent keeps its conversation; the new definition applies from its next turn. Only agents whose `steward` is members change this way: a package's agents change when it is installed again, and built-in agents never.
   * Requires `pi.manage`.
   */
  updateAgent(input: PiUpdateAgentInput): Promise<PiUpdateAgentOutput>;
  /**
   * Idempotently delete an agent's definition, if members are its steward; uninstalling a package deletes its agents. Its stored conversation is kept and resumes if the name is defined again.
   * Requires `pi.manage`.
   */
  deleteAgent(input: PiDeleteAgentInput): Promise<PiDeleteAgentOutput>;
  /**
   * Durably queue a prompt for an agent, or steer its running turn, and return a receipt saying which. A request ID still queued is not queued twice. The prompt's outcome is recorded as a pi turn.completed, turn.failed, turn.aborted, or queue.dropped event, each with the request ID in its subject. With `subagent`, the prompt runs in a new conversation of the agent instead of its own, and ends with it. With `notifyWhenDone`, that event is also delivered to the calling agent as a notification; read the answer with `pi.getPrompt` in the prompted agent's scope. The turn runs with the caller's current permissions, narrowed by the agent's definition. Usage belongs to the agent scope's root owner, independently of the caller or their active organization.
   * Requires `pi.modify`.
   */
  submitPrompt(input: PiSubmitPromptInput): Promise<PiSubmitPromptOutput>;
  /**
   * Where a prompt submitted with a request ID stands: queued, running, completed with the answer's text, or failed with the reason it will not be answered. Null when the agent never received the request. A subagent's prompt is found by its request ID too.
   * Requires `pi.read`.
   */
  getPrompt(input: PiGetPromptInput): Promise<PiGetPromptOutput>;
  /**
   * Stop an agent: abort its running turn and background work, and pause its queue. Queued and new prompts wait until someone resumes the agent in Backoffice.
   * Requires `pi.modify`.
   */
  stopAgent(input: PiStopAgentInput): Promise<PiStopAgentOutput>;
  /**
   * Record the scope's defined agents as pi agent.* events, for agents defined before those events were recorded, so views and routes built on the events see every agent. For each agent the events record missing, deleted, or with a different definition, it records agent.created or agent.updated with the current definition, and for each agent they record that is no longer defined, agent.deleted. Routes on those events run for each new event. A rerun records nothing new. Built-in agents are left out: they are defined in every scope. Returns the events it recorded.
   * Requires `pi.manage`.
   */
  backfillAgentEvents(input: PiBackfillAgentEventsInput): Promise<PiBackfillAgentEventsOutput>;
};
declare const pi: PiCodemodeProvider;

type PiAgentSteward =
  | AutomationSteward
  | {
      kind: "backoffice";
    };
type AutomationSteward =
  | {
      kind: "members";
    }
  | {
      kind: "package";
      listingId: string;
    };
type PiListAgentsInput = Record<string, unknown>;
type PiListAgentsOutput = {
  agents: {
    description: string;
    model: string | null;
    permissions: string[];
    instructions: string;
    agentName: string;
    steward: PiAgentSteward;
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
  steward: PiAgentSteward;
};
type PiListMessagesInput = {
  /** The agent whose conversation to read, by its name from `pi.listAgents`; it is yours only when you pass your own name. */
  agentName: string;
  /** How many of the most recent messages to return. */
  last?: number;
  /** A previous page's `before`, to read the messages preceding it. */
  before?: number | null;
  /** The request ID that started a subagent of the agent, to read that subagent's conversation instead of the agent's. */
  subagent?: string | null;
};
type PiListMessagesOutput = {
  messages: (
    | {
        entryId: number;
        role: "user" | "assistant" | "compaction";
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
  /** Also write what came before the agent's newest compaction or clear, which are left out by default, as in the chat. */
  history?: boolean;
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
  agentName: string;
};
type PiCreateAgentOutput = {
  description: string;
  model: string | null;
  permissions: string[];
  instructions: string;
  agentName: string;
  steward: PiAgentSteward;
  /** The model the agent runs, as provider/modelId: its `model`, or the preferred available model when `model` is null. Null when that model is not available. */
  resolvedModel: string | null;
};
type PiUpdateAgentInput = {
  description: string;
  model: string | null;
  permissions: string[];
  instructions: string;
  agentName: string;
};
type PiUpdateAgentOutput = {
  description: string;
  model: string | null;
  permissions: string[];
  instructions: string;
  agentName: string;
  steward: PiAgentSteward;
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
  /** Only from an agent's turn, prompting another agent or starting a subagent: notify you, the calling agent, with the event recording how the prompt ended. Works for agents in other scopes too. */
  notifyWhenDone?: boolean;
  /** Run the prompt in a subagent of the agent: a new conversation under the agent's definition that answers it alongside the agent's other work, a few at a time, and then ends. Use it for independent tasks, such as one per document; it cannot steer or be refused as busy. */
  subagent?: boolean;
};
type PiSubmitPromptOutput = {
  requestId: string;
  status: "steered" | "queued";
};
type PiGetPromptInput = {
  agentName: string;
  requestId: string;
};
type PiGetPromptOutput =
  | {
      requestId: string;
      status: "queued" | "running";
    }
  | {
      requestId: string;
      status: "completed";
      answer: string | null;
    }
  | {
      requestId: string;
      status: "failed";
      reason: string;
    }
  | null;
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
