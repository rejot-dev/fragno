import { z } from "zod";

import type { BackofficeApiOperation, BackofficeApiStream } from "../api";
import { automationRouteManagedBySchema } from "./automation";
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
    /** Narrow every turn: an agent can never do more than the person prompting it. */
    permissions: z.array(piAgentPermissionGrantSchema),
    /** Markdown guidance added to the agent's system prompt; empty adds none. */
    instructions: z.string().max(PI_AGENT_INSTRUCTIONS_MAX_LENGTH),
  }),
);

/** Built-in agents are defined by Backoffice; others are created in a scope, by hand or a package. */
const piAgentManagedBySchema = z.lazy(() =>
  z.union([z.object({ kind: z.literal("built-in") }), automationRouteManagedBySchema]),
);

export const piAgentDefinitionSchema = z.lazy(() =>
  piAgentDefinitionFieldsSchema._zod.innerType.extend({
    agentName: piAgentNameSchema,
    managedBy: piAgentManagedBySchema.nullable(),
  }),
);

export type PiAgentDefinition = z.infer<typeof piAgentDefinitionSchema>;

/**
 * The definition fields an update replaces; packages set `managedBy` to claim their agents. An
 * agent granted nothing could only chat, so a definition grants at least one permission.
 */
export const piAgentDefinitionUpdateSchema = z.lazy(() =>
  piAgentDefinitionFieldsSchema._zod.innerType.extend({
    permissions: piAgentDefinitionFieldsSchema._zod.innerType.shape.permissions.min(
      1,
      'Grant at least one permission; use ["*"] to let the agent do whatever its prompter may.',
    ),
    managedBy: automationRouteManagedBySchema.nullable(),
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

const agentInputSchema = z.lazy(() => z.strictObject({ agentName: piAgentNameSchema }));

const promptSubmitInputSchema = z.lazy(() =>
  agentInputSchema._zod.innerType.extend({
    content: z.string().trim().min(1),
    requestId: z.string().trim().min(1).optional(),
    whenBusy: piPromptWhenBusySchema.optional(),
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
  }),
);

/**
 * What was said in an agent's conversation, without thinking, tool calls, or tool results. A
 * `notification` marks where the agent was asked to handle delivered events, which explains an
 * answer no one prompted.
 */
const piAgentMessageSchema = z.lazy(() =>
  z.union([
    z.object({
      entryId: z.number().int().positive(),
      role: z.enum(["user", "assistant"]),
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
    // The oldest message's entry ID while earlier messages exist; null at the conversation's start.
    before: z.number().int().positive().nullable(),
  }),
);
export type PiAgentMessagePage = z.infer<typeof piAgentMessagePageSchema>;

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
  }),
);

const piAgentQueueEntrySchema = z.lazy(() =>
  z.discriminatedUnion("type", [
    z.object({ type: z.literal("prompt"), requestId: z.string(), content: z.string() }),
    z.object({
      type: z.literal("notification"),
      requestId: z.string(),
      source: z.string(),
      eventType: z.string(),
    }),
  ]),
);
export type PiAgentQueueEntry = z.infer<typeof piAgentQueueEntrySchema>;

/**
 * `snapshot` and `update` replace the agent's whole durable conversation view with one committed
 * revision, and `queue` replaces the items waiting in its queue and whether the queue is paused.
 */
export const piAgentWatchFrameSchema = z.lazy(() =>
  z.discriminatedUnion("type", [
    z.object({ type: z.enum(["snapshot", "update"]), view: z.unknown() }),
    z.object({
      type: z.literal("queue"),
      paused: z.boolean(),
      items: z.array(piAgentQueueEntrySchema),
    }),
  ]),
);

export const piOperations = {
  "pi.agent.list": {
    description: "List the built-in agents and the agents defined in the current scope.",
    permissions: [BACKOFFICE_PERMISSION.pi.read],
    input: z.lazy(() => z.strictObject({})),
    output: piAgentDirectoryOutputSchema,
  },
  "pi.agent.get": {
    description: "Get one defined agent.",
    permissions: [BACKOFFICE_PERMISSION.pi.read],
    input: agentInputSchema,
    output: piAgentDefinitionSchema,
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
      'Replace an agent\'s whole definition, including its permissions (["*"] narrows nothing). The agent keeps its conversation; the new definition applies from its next turn.',
    permissions: [BACKOFFICE_PERMISSION.pi.manage],
    input: z.lazy(() => piAgentDefinitionCreateSchema._zod.innerType.strict()),
    output: piAgentDefinitionSchema,
  },
  "pi.agent.delete": {
    description:
      "Idempotently delete an agent's definition. Its stored conversation is kept and resumes if the name is defined again.",
    permissions: [BACKOFFICE_PERMISSION.pi.manage],
    input: agentInputSchema,
    output: z.lazy(() => z.object({ deleted: z.literal(true) })),
  },
  "pi.agent.messages": {
    description:
      "Read the most recent messages of a started agent's conversation, oldest first, by the agent's name; call `pi.listAgents` to find the agent a request means rather than assuming it is you: what users said and the agent answered, without thinking, tool calls, or tool results. Pass the returned `before` to read further back; it is null at the conversation's start. Includes history before compactions and resets.",
    permissions: [BACKOFFICE_PERMISSION.pi.read],
    input: messagesListInputSchema,
    output: piAgentMessagePageSchema,
  },
  "pi.agent.export": {
    description:
      "Write a started agent's whole conversation history to a JSONL file, by the agent's name; call `pi.listAgents` to find the agent a request means rather than assuming it is you. The file holds a header line, then every durable entry oldest first, including thinking, tool calls, tool results, and history before compactions and resets.",
    permissions: [BACKOFFICE_PERMISSION.pi.read, BACKOFFICE_PERMISSION.upload.modify],
    input: exportInputSchema,
    output: z.lazy(() =>
      z.object({ path: z.string(), entryCount: z.number().int().nonnegative() }),
    ),
  },
  "pi.prompt.submit": {
    description:
      "Durably queue a prompt for an agent, or steer its running turn, and return a receipt saying which. A request ID still queued is not queued twice. The prompt's outcome is recorded as a pi turn.completed event naming the answer's entry, or turn.failed, turn.aborted, or queue.dropped, each with the request ID in its subject. The turn runs with the caller's current permissions, narrowed by the agent's definition. Usage belongs to the agent scope's root owner, independently of the caller or their active organization.",
    permissions: [BACKOFFICE_PERMISSION.pi.modify],
    input: promptSubmitInputSchema,
    output: piPromptReceiptOutputSchema,
  },
  "pi.agent.stop": {
    description:
      "Stop an agent: abort its running turn and background work, and pause its queue. Queued and new prompts wait until someone resumes the agent in Backoffice.",
    permissions: [BACKOFFICE_PERMISSION.pi.modify],
    input: agentInputSchema,
    output: z.lazy(() => z.object({ stopped: z.literal(true) })),
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

export const piStreams = {
  "pi.agent.watch": {
    description:
      "Watch an agent's conversation live. The stream opens with a queue frame and a snapshot of the conversation view, then sends an update with the whole view whenever it commits, including partial answers while the agent generates, and a queue frame whenever its queue changes. Reconnecting starts again from a snapshot. An agent that has never had a turn answers 404.",
    permissions: [BACKOFFICE_PERMISSION.pi.read],
    input: agentInputSchema,
    frame: piAgentWatchFrameSchema,
  },
} satisfies Record<string, BackofficeApiStream>;
