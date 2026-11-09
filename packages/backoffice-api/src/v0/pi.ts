import { z } from "zod";

import type { BackofficeApiOperation } from "../api";
import { automationStewardSchema, type AutomationSteward } from "./automation";
import {
  allBackofficePermissionRequirements,
  BACKOFFICE_PERMISSION,
  type BackofficePermissionRequirement,
} from "./shared/permissions";
import { piAgentNameSchema } from "./shared/pi-agent-name";
import { backofficeContextScopeSchema } from "./shared/scope";

export const piAgentModelSchema = z.lazy(() =>
  z.object({
    provider: z.string().min(1),
    modelId: z.string().min(1),
  }),
);

/** Pi's reasoning efforts, from none to the most a model offers. */
export const piThinkingLevelSchema = z.lazy(() =>
  z.enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"]),
);

export type PiThinkingLevel = z.infer<typeof piThinkingLevelSchema>;

/** One agent object's immutable address; usage belongs to its scope's root owner. */
export const piAgentConfigSchema = z.lazy(() =>
  z.object({
    scope: backofficeContextScopeSchema,
    agentName: piAgentNameSchema,
  }),
);

export type PiAgentConfig = z.infer<typeof piAgentConfigSchema>;

const PI_AGENT_INSTRUCTIONS_MAX_LENGTH = 32_768;

/** The permissions a grant names: `*`, `namespace.*`, or one `namespace.permission`. */
export function piAgentPermissionGrantRequirements(
  grant: string,
): readonly BackofficePermissionRequirement[] {
  if (grant === "*") {
    return allBackofficePermissionRequirements;
  }
  const separator = grant.indexOf(".");
  const namespace = separator === -1 ? grant : grant.slice(0, separator);
  const permission = separator === -1 ? "" : grant.slice(separator + 1);
  return allBackofficePermissionRequirements.filter(
    (requirement) =>
      requirement.namespace === namespace &&
      (permission === "*" || requirement.permission === permission),
  );
}

const piAgentPermissionGrantSchema = z.lazy(() =>
  z
    .string()
    .trim()
    .refine((grant) => piAgentPermissionGrantRequirements(grant).length > 0, {
      error: (issue) => `Unknown Backoffice permission '${String(issue.input)}'.`,
    }),
);

const piAgentDefinitionFieldsSchema = z.lazy(() =>
  z.object({
    description: z.string().trim().min(1),
    /** `provider/modelId`; null selects the preferred available model. */
    model: z
      .string()
      .regex(/^[^/\s]+\/\S+$/, "Expected a model as provider/modelId.")
      .nullable(),
    /**
     * How hard the agent reasons. A model that does not offer it runs at the nearest effort below,
     * or else its lowest.
     */
    thinkingLevel: piThinkingLevelSchema,
    /** Narrow every turn: an agent can never do more than the person prompting it. */
    permissions: z.array(piAgentPermissionGrantSchema),
    /** Markdown guidance added to the agent's system prompt; empty adds none. */
    instructions: z.string().max(PI_AGENT_INSTRUCTIONS_MAX_LENGTH),
  }),
);

export type PiAgentSteward = AutomationSteward | { kind: "backoffice" };

/**
 * Who may change an agent: members of its scope, the package that declares it, or Backoffice, which
 * defines the built-in agents.
 */
export const piAgentStewardSchema: z.ZodType<PiAgentSteward> = z
  .lazy(() => z.union([automationStewardSchema, z.strictObject({ kind: z.literal("backoffice") })]))
  .meta({ id: "PiAgentSteward" });

export const piAgentDefinitionSchema = z.lazy(() =>
  piAgentDefinitionFieldsSchema._zod.innerType.extend({
    agentName: piAgentNameSchema,
    steward: piAgentStewardSchema,
  }),
);

export type PiAgentDefinition = z.infer<typeof piAgentDefinitionSchema>;

/**
 * The definition fields an update replaces. An agent granted nothing could only chat, so a
 * definition grants at least one permission.
 */
export const piAgentDefinitionUpdateSchema = z.lazy(() =>
  piAgentDefinitionFieldsSchema._zod.innerType.extend({
    thinkingLevel: piThinkingLevelSchema.default("low"),
    permissions: piAgentDefinitionFieldsSchema._zod.innerType.shape.permissions.min(
      1,
      'Grant at least one permission; use ["*"] to let the agent do whatever its prompter may.',
    ),
  }),
);

export type PiAgentDefinitionUpdate = z.infer<typeof piAgentDefinitionUpdateSchema>;

export const piAgentDefinitionCreateSchema = z.lazy(() =>
  piAgentDefinitionUpdateSchema._zod.innerType.extend({
    agentName: piAgentNameSchema,
  }),
);

export type PiAgentDefinitionCreate = z.infer<typeof piAgentDefinitionCreateSchema>;

/** A created definition, and the model it resolves to, which a null `model` leaves unnamed. */
export const piAgentCreatedSchema = z.lazy(() =>
  piAgentDefinitionSchema._zod.innerType.extend({
    resolvedModel: z
      .string()
      .nullable()
      .describe(
        "The model the agent runs, as provider/modelId: its `model`, or the preferred available model when `model` is null. Null when that model is not available.",
      ),
  }),
);

export type PiAgentCreated = z.infer<typeof piAgentCreatedSchema>;

/** A defined agent; its durable conversation is provisioned by its first turn. */
export const piManagerAgentSchema = z.lazy(() =>
  piAgentDefinitionSchema._zod.innerType.extend({
    provisioned: z.boolean(),
  }),
);

export type PiManagerAgent = z.infer<typeof piManagerAgentSchema>;

export const piManagerAgentDirectorySchema = z.lazy(() =>
  z.object({
    agents: z.array(piManagerAgentSchema),
  }),
);

export type PiManagerAgentDirectory = z.infer<typeof piManagerAgentDirectorySchema>;

/**
 * `followUp` waits in the agent's queue for a turn of its own. `steer` joins the running turn at its
 * next tool boundary when that turn has the same authority, and otherwise waits like `followUp`.
 * `reject` is refused while the agent runs a turn or has queued work.
 */
export const piPromptWhenBusySchema = z.lazy(() => z.enum(["followUp", "steer", "reject"]));

/**
 * `wait` leaves a prompt for an agent someone stopped in its paused queue; `resume` resumes the
 * queue, as a person writing to the agent does.
 */
export const piPromptWhenPausedSchema = z.lazy(() => z.enum(["wait", "resume"]));

const piAgentDirectoryOutputSchema = z.lazy(() =>
  z.object({
    agents: z.array(piAgentDefinitionSchema),
  }),
);

export const piPromptReceiptOutputSchema = z.lazy(() =>
  z.object({
    requestId: z.string(),
    // `steered` joined the running turn; `queued` waits in the agent's queue for a turn of its own.
    status: z.enum(["steered", "queued"]),
  }),
);
export type PiPromptReceipt = z.infer<typeof piPromptReceiptOutputSchema>;

/**
 * Where a submitted prompt stands. `running` is in a turn; `completed` was answered, with the
 * answer's text, null when it said nothing; `failed` will never be answered, e.g. its turn failed
 * or was aborted, or it was dropped from the queue.
 */
export const piPromptStatusSchema = z.lazy(() =>
  z.discriminatedUnion("status", [
    z.object({ requestId: z.string(), status: z.enum(["queued", "running"]) }),
    z.object({
      requestId: z.string(),
      status: z.literal("completed"),
      answer: z.string().nullable(),
    }),
    z.object({ requestId: z.string(), status: z.literal("failed"), reason: z.string() }),
  ]),
);
export type PiPromptStatus = z.infer<typeof piPromptStatusSchema>;

/** An item waiting in an agent's queue, as its viewers see it. */
export type PiAgentQueueEntry =
  | { type: "prompt"; requestId: string; content: string }
  | { type: "notification"; requestId: string; source: string; eventType: string };

/**
 * What the `pi.agent.watch` WebSocket sends, one JSON frame per message: the whole conversation view
 * once, on connecting, then each commit's ops, which turn the view the socket has into the
 * committed one; and the items waiting in the agent's queue whenever they change. The view is Pi
 * Durable's `ConversationView` and the ops are Chord's `Op`, which `applyImmutable` from
 * `@earendil-works/chord/delta` applies.
 */
export type PiAgentWatchFrame<TView = unknown, TOp = unknown> =
  | { type: "view"; view: TView }
  | { type: "ops"; ops: readonly TOp[] }
  | { type: "queue"; paused: boolean; items: PiAgentQueueEntry[] };

/**
 * `pi.agent.watch` closes with a code from 4000 up, and says why, when reconnecting cannot help,
 * such as for a missing permission or a damaged conversation; any other close is worth reconnecting
 * after.
 */
export const PI_AGENT_WATCH_REFUSED = 4000;

const agentInputSchema = z.lazy(() => z.strictObject({ agentName: piAgentNameSchema }));

const promptSubmitInputSchema = z.lazy(() =>
  agentInputSchema._zod.innerType.extend({
    content: z.string().trim().min(1),
    requestId: z.string().trim().min(1).optional(),
    whenBusy: piPromptWhenBusySchema.optional(),
    whenPaused: piPromptWhenPausedSchema
      .optional()
      .describe(
        "When someone stopped the agent: `wait` (the default) leaves the prompt in its paused queue, and `resume` resumes the queue, as a person writing to the agent does.",
      ),
    notifyWhenDone: z
      .boolean()
      .optional()
      .describe(
        "Only from an agent's turn, prompting another agent or starting a subagent: notify you, the calling agent, with the event recording how the prompt ended. Works for agents in other scopes too.",
      ),
    subagent: z
      .boolean()
      .optional()
      .describe(
        "Run the prompt in a subagent of the agent: a new conversation under the agent's definition that answers it alongside the agent's other work, a few at a time, and then ends. Use it for independent tasks, such as one per document; it cannot steer or be refused as busy.",
      ),
  }),
);

/** Another agent's conversation; models otherwise tend to read their own. */
const readAgentInputSchema = z.lazy(() =>
  z.strictObject({
    agentName: piAgentNameSchema.describe(
      "The agent whose conversation to read, by its name from `pi.listAgents`; it is yours only when you pass your own name.",
    ),
  }),
);

const messagesListInputSchema = z.lazy(() =>
  readAgentInputSchema._zod.innerType.extend({
    last: z
      .number()
      .int()
      .min(1)
      .max(100)
      .default(20)
      .describe("How many of the most recent messages to return."),
    before: z
      .number()
      .int()
      .positive()
      .nullable()
      .default(null)
      .describe("A previous page's `before`, to read the messages preceding it."),
    subagent: z
      .string()
      .trim()
      .min(1)
      .nullable()
      .default(null)
      .describe(
        "The request ID that started a subagent of the agent, to read that subagent's conversation instead of the agent's.",
      ),
  }),
);

/**
 * What was said in an agent's conversation, without thinking, tool calls, or tool results. A
 * `notification` marks where the agent was asked to handle delivered events, which explains an
 * answer no one prompted. A `compaction` holds the summary that replaced earlier messages in the
 * agent's context, where it was made.
 */
const piAgentMessageSchema = z.lazy(() =>
  z.union([
    z.object({
      entryId: z.number().int().positive(),
      role: z.enum(["user", "assistant", "compaction"]),
      text: z.string(),
      sentAt: z.string(),
    }),
    z.object({
      entryId: z.number().int().positive(),
      role: z.literal("notification"),
      notifications: z.array(z.object({ routeId: z.string().nullable(), eventId: z.string() })),
      sentAt: z.string(),
    }),
  ]),
);
export type PiAgentMessage = z.infer<typeof piAgentMessageSchema>;

export const piAgentMessagePageSchema = z.lazy(() =>
  z.object({
    messages: z.array(piAgentMessageSchema),
    // The oldest message's entry ID while earlier messages exist; null at the start of what is read.
    before: z.number().int().positive().nullable(),
  }),
);
export type PiAgentMessagePage = z.infer<typeof piAgentMessagePageSchema>;

const historyInputSchema = z.lazy(() =>
  readAgentInputSchema._zod.innerType.extend({
    before: z
      .number()
      .int()
      .positive()
      .describe(
        "The entry where the active context begins, which `pi.agent.watch`'s view leads with as its first entry's `head`: the page reads the entries before it.",
      ),
    cursor: z
      .string()
      .min(1)
      .nullable()
      .default(null)
      .describe("A previous page's `cursor`, to read further back; null for the newest page."),
    pageSize: z
      .number()
      .int()
      .min(1)
      .max(256)
      .default(100)
      .describe("How many entries the page holds at most."),
  }),
);

/** A page of a conversation from before its active context, newest entry first. */
export const piAgentHistoryPageSchema = z.lazy(() =>
  z.object({
    entries: z.array(z.unknown()).describe("Pi Durable's `EntryRecord`s, newest first."),
    cursor: z
      .string()
      .nullable()
      .describe("The next page's cursor; null once the page reached the conversation's start."),
  }),
);
export type PiAgentHistoryPage = z.infer<typeof piAgentHistoryPageSchema>;

/** What one call of a codemode run did, as a reader of the run cares. */
export const codemodeCallSubjectSchema = z.lazy(() =>
  z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("skill"), name: z.string() }),
    z.object({ kind: z.literal("read"), path: z.string() }),
    z.object({ kind: z.literal("list"), pattern: z.string() }),
    z.object({ kind: z.literal("search"), keywords: z.array(z.string()), pattern: z.string() }),
    z.object({
      kind: z.literal("action"),
      connectionId: z.string(),
      actionId: z.string(),
      // Another scope a context handle named, such as "org:acme"; null for the run's own scope.
      scope: z.string().nullable(),
      // The action's own input, cut to one line.
      input: z.string(),
    }),
    z.object({
      kind: z.literal("call"),
      // `provider.tool`, as the program called it.
      name: z.string(),
      scope: z.string().nullable(),
      input: z.string(),
    }),
  ]),
);
export type CodemodeCallSubject = z.infer<typeof codemodeCallSubjectSchema>;

const codemodeCallSchema = z.lazy(() =>
  z.discriminatedUnion("status", [
    z.object({
      subject: codemodeCallSubjectSchema,
      // When the call started, counted from the run's `startedAt`.
      offsetMs: z.number(),
      status: z.literal("running"),
    }),
    z.object({
      subject: codemodeCallSubjectSchema,
      offsetMs: z.number(),
      status: z.literal("succeeded"),
      durationMs: z.number(),
    }),
    z.object({
      subject: codemodeCallSubjectSchema,
      offsetMs: z.number(),
      status: z.literal("failed"),
      durationMs: z.number(),
      error: z.string(),
    }),
  ]),
);

/**
 * A codemode run's calls: when it started, its newest calls, oldest first, and how many earlier
 * ones it left out.
 */
export const codemodeCallsSchema = z.lazy(() =>
  z.object({
    // Epoch milliseconds.
    startedAt: z.number(),
    items: z.array(codemodeCallSchema),
    omitted: z.number().int().nonnegative(),
  }),
);
export type CodemodeCalls = z.infer<typeof codemodeCallsSchema>;

const activityInputSchema = z.lazy(() =>
  readAgentInputSchema._zod.innerType.extend({
    subagent: z
      .string()
      .trim()
      .min(1)
      .nullable()
      .default(null)
      .describe(
        "The request ID that started a subagent of the agent, to read that subagent's work instead of the agent's.",
      ),
  }),
);

/**
 * The tools a conversation ran, oldest first, from its newest compaction or clear on: running ones
 * too, and what each codemode run called so far. `calls` is null for other tools.
 */
export const piAgentActivitySchema = z.lazy(() =>
  z.object({
    tools: z.array(
      z.object({
        toolCallId: z.string(),
        name: z.string(),
        status: z.enum(["running", "succeeded", "failed"]),
        calls: codemodeCallsSchema.nullable(),
      }),
    ),
    // The earliest tool runs, which `tools` leaves out.
    omitted: z.number().int().nonnegative(),
  }),
);
export type PiAgentActivity = z.infer<typeof piAgentActivitySchema>;

/**
 * Opens `pi.agent.watch` for one agent without a bearer header, which a browser's WebSocket cannot
 * send. A ticket opens it from the calling app's registered origins, and from clients that send no
 * origin, such as servers.
 */
export const piAgentWatchTicketSchema = z.lazy(() =>
  z.object({
    ticket: z.string().min(1),
    expiresAt: z.iso.datetime(),
  }),
);
export type PiAgentWatchTicket = z.infer<typeof piAgentWatchTicketSchema>;

const exportInputSchema = z.lazy(() =>
  readAgentInputSchema._zod.innerType.extend({
    out: z
      .string()
      .trim()
      // `/system` is the System scope's writable root.
      .regex(/^\/(workspace|system)\/.+\.jsonl$/u, {
        message:
          "Write the export to a .jsonl file under /workspace, such as /workspace/agent.jsonl.",
      })
      .describe("Absolute path of the .jsonl file to write under /workspace."),
    history: z
      .boolean()
      .default(false)
      .describe(
        "Also write what came before the agent's newest compaction or clear, which are left out by default, as in the chat.",
      ),
  }),
);

export const piOperations = {
  "pi.agent.list": {
    description: "List the built-in agents and the agents defined in the current scope.",
    permissions: [BACKOFFICE_PERMISSION.pi.read],
    input: z.lazy(() => z.strictObject({})),
    output: piAgentDirectoryOutputSchema,
  },
  "pi.agent.get": {
    description:
      "Get one defined agent, and whether its conversation is provisioned: its first prompt provisions it, and `pi.agent.watch` opens only then.",
    permissions: [BACKOFFICE_PERMISSION.pi.read],
    input: agentInputSchema,
    output: piManagerAgentSchema,
  },
  "pi.agent.create": {
    description:
      'Define an agent in the current scope. Use permissions ["*"] unless the agent should be limited: each turn already runs with the prompter\'s permissions, and the grants only narrow them.',
    permissions: [BACKOFFICE_PERMISSION.pi.manage],
    input: z.lazy(() => piAgentDefinitionCreateSchema._zod.innerType.strict()),
    output: piAgentCreatedSchema,
  },
  "pi.agent.update": {
    description:
      "Replace an agent's whole definition, including its permissions ([\"*\"] narrows nothing). The agent keeps its conversation; the new definition applies from its next turn. Only agents whose `steward` is members change this way: a package's agents change when it is installed again, and built-in agents never.",
    permissions: [BACKOFFICE_PERMISSION.pi.manage],
    input: z.lazy(() => piAgentDefinitionCreateSchema._zod.innerType.strict()),
    output: piAgentDefinitionSchema,
  },
  "pi.agent.delete": {
    description:
      "Idempotently delete an agent's definition, if members are its steward; uninstalling a package deletes its agents. Its stored conversation is kept and resumes if the name is defined again.",
    permissions: [BACKOFFICE_PERMISSION.pi.manage],
    input: agentInputSchema,
    output: z.lazy(() => z.object({ deleted: z.literal(true) })),
  },
  "pi.agent.messages": {
    description:
      "Read the most recent messages of a started agent's conversation, oldest first, by the agent's name; call `pi.listAgents` to find the agent a request means rather than assuming it is you: what users said and the agent answered, without thinking, tool calls, or tool results. Like the chat, it reads from the agent's newest compaction or clear on, with the compaction's summary where it was made. Pass the returned `before` to read further back; it is null at the newest compaction or clear, or the conversation's start. To read a prompt's answer, use `pi.getPrompt`. Pass `subagent` to read one of the agent's subagents instead.",
    permissions: [BACKOFFICE_PERMISSION.pi.read],
    input: messagesListInputSchema,
    output: piAgentMessagePageSchema,
  },
  "pi.agent.history": {
    description:
      "Read a page of a started agent's conversation from before its newest compaction or clear, newest entry first, as Pi Durable's entries with thinking, tool calls, and tool results: the history `pi.agent.watch`'s view leaves out, for a chat that shows it. Pass `before` where the view's active context begins, and each page's `cursor` to read further back. To read what was said since the newest compaction, use `pi.agent.messages`.",
    permissions: [BACKOFFICE_PERMISSION.pi.read],
    input: historyInputSchema,
    output: piAgentHistoryPageSchema,
  },
  "pi.agent.activity": {
    description:
      "What a started agent's conversation, or one of its subagents', does with its tools, by the agent's name: each tool it ran, oldest first, including those still running, and for each codemode run the calls it made, such as the skills it loaded, the files it read, and the integration actions it ran. Like the chat, it reads from the agent's newest compaction or clear on. Pass `subagent` to read a subagent, by the request ID that started it.",
    permissions: [BACKOFFICE_PERMISSION.pi.read],
    input: activityInputSchema,
    output: piAgentActivitySchema,
  },
  "pi.agent.watchTicket": {
    description:
      "A ticket that opens the `pi.agent.watch` WebSocket for one agent, with your permissions, as the `ticket` query parameter instead of a bearer credential: for an app's browser, which cannot send WebSocket headers. Connect within a minute; the socket stays open after the ticket expires, and reconnecting needs a new one. An app's ticket opens the socket only from its registered origins.",
    permissions: [BACKOFFICE_PERMISSION.pi.read],
    input: agentInputSchema,
    output: piAgentWatchTicketSchema,
  },
  "pi.agent.export": {
    description:
      "Write a started agent's conversation to a JSONL file, by the agent's name; call `pi.listAgents` to find the agent a request means rather than assuming it is you. The file holds a header line, then the durable entries oldest first, including thinking, tool calls, and tool results. Like the chat, it holds the entries from the agent's newest compaction or clear on, with that compaction or clear; pass `history` for every entry.",
    permissions: [BACKOFFICE_PERMISSION.pi.read, BACKOFFICE_PERMISSION.upload.modify],
    input: exportInputSchema,
    output: z.lazy(() =>
      z.object({ path: z.string(), entryCount: z.number().int().nonnegative() }),
    ),
  },
  "pi.prompt.submit": {
    description:
      "Durably queue a prompt for an agent, or steer its running turn, and return a receipt saying which. A request ID still queued is not queued twice. The prompt's outcome is recorded as a pi turn.completed, turn.failed, turn.aborted, or queue.dropped event, each with the request ID in its subject. With `subagent`, the prompt runs in a new conversation of the agent instead of its own, and ends with it. With `notifyWhenDone`, that event is also delivered to the calling agent as a notification; read the answer with `pi.getPrompt` in the prompted agent's scope. The turn runs with the caller's current permissions, narrowed by the agent's definition. Usage belongs to the agent scope's root owner, independently of the caller or their active organization.",
    permissions: [BACKOFFICE_PERMISSION.pi.modify],
    input: promptSubmitInputSchema,
    output: piPromptReceiptOutputSchema,
  },
  "pi.prompt.get": {
    description:
      "Where a prompt submitted with a request ID stands: queued, running, completed with the answer's text, or failed with the reason it will not be answered. Null when the agent never received the request. A subagent's prompt is found by its request ID too.",
    permissions: [BACKOFFICE_PERMISSION.pi.read],
    input: z.lazy(() =>
      agentInputSchema._zod.innerType.extend({ requestId: z.string().trim().min(1) }),
    ),
    output: z.lazy(() => piPromptStatusSchema.nullable()),
  },
  "pi.agent.stop": {
    description:
      'Stop an agent: abort its running turn and background work, and pause its queue. Queued and new prompts wait until `pi.agent.resume`, or a prompt submitted with `whenPaused: "resume"`, resumes it.',
    permissions: [BACKOFFICE_PERMISSION.pi.modify],
    input: agentInputSchema,
    output: z.lazy(() => z.object({ stopped: z.literal(true) })),
  },
  "pi.agent.resume": {
    description:
      "Resume an agent someone stopped: its paused queue starts again with its oldest prompt, and its waiting subagents start.",
    permissions: [BACKOFFICE_PERMISSION.pi.modify],
    input: agentInputSchema,
    output: z.lazy(() => z.object({ resumed: z.literal(true) })),
  },
  "pi.agent.backfillEvents": {
    description:
      "Record the scope's defined agents as pi agent.* events, for agents defined before those events were recorded, so views and routes built on the events see every agent. For each agent the events record missing, deleted, or with a different definition, it records agent.created or agent.updated with the current definition, and for each agent they record that is no longer defined, agent.deleted. Routes on those events run for each new event. A rerun records nothing new. Built-in agents are left out: they are defined in every scope. Returns the events it recorded.",
    permissions: [BACKOFFICE_PERMISSION.pi.manage],
    input: z.lazy(() => z.strictObject({})),
    output: z.lazy(() =>
      z.object({
        agents: z.array(
          z.object({
            agentName: piAgentNameSchema,
            eventType: z.enum(["agent.created", "agent.updated", "agent.deleted"]),
          }),
        ),
      }),
    ),
  },
} satisfies Record<string, BackofficeApiOperation>;
