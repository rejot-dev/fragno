import { z } from "zod";

import type { BackofficeApiOperation } from "../api";
import { automationRouteManagedBySchema } from "./automation";
import {
  allBackofficePermissionRequirements,
  BACKOFFICE_PERMISSION,
  type BackofficePermissionRequirement,
} from "./shared/permissions";
import { backofficeContextScopeSchema } from "./shared/scope";

export const piAgentModelSchema = z.lazy(() =>
  z.object({
    provider: z.string().min(1),
    modelId: z.string().min(1),
  }),
);

/** Agent names identify an agent's definition and its one ongoing conversation within a scope. */
export const piAgentNameSchema = z.lazy(() =>
  z
    .string()
    .regex(
      /^[a-z][a-z0-9-]{0,62}$/,
      "Agent names start with a lowercase letter and contain only lowercase letters, digits, and hyphens.",
    ),
);

/** Organization and project agents bill their organization; user and system agents choose once. */
export const piBillingOrganizationIdSchema = z.lazy(() => z.string().trim().min(1).nullable());

/** One agent object's immutable provisioning: its address and the billing owner chosen once. */
export const piAgentConfigSchema = z.lazy(() =>
  z.object({
    scope: backofficeContextScopeSchema,
    agentName: piAgentNameSchema,
    billingOrganizationId: piBillingOrganizationIdSchema,
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

/** A defined agent; `provisioning` is null until its durable conversation receives a first turn. */
export const piManagerAgentSchema = z.lazy(() =>
  piAgentDefinitionSchema._zod.innerType.extend({
    provisioning: z.object({ billingOrganizationId: piBillingOrganizationIdSchema }).nullable(),
  }),
);

export type PiManagerAgent = z.infer<typeof piManagerAgentSchema>;

export const piManagerAgentDirectorySchema = z.lazy(() =>
  z.object({
    agents: z.array(piManagerAgentSchema),
  }),
);

export type PiManagerAgentDirectory = z.infer<typeof piManagerAgentDirectorySchema>;

/** `followUp` waits for the current turn; `steer` joins it at the next tool boundary. */
export const piPromptWhenBusySchema = z.lazy(() => z.enum(["followUp", "steer", "reject"]));

const piAgentDirectoryOutputSchema = z.lazy(() =>
  z.object({
    agents: z.array(piAgentDefinitionSchema),
  }),
);

export const piPromptReceiptOutputSchema = z.lazy(() =>
  z.object({
    submissionId: z.number(),
    requestId: z.string(),
    // What Pi applied: a steer from anyone but the running turn's submitter becomes a follow-up.
    whenBusy: piPromptWhenBusySchema,
  }),
);
export type PiPromptReceipt = z.infer<typeof piPromptReceiptOutputSchema>;

const piAgentDetailOutputSchema = z.lazy(() =>
  piAgentDefinitionSchema._zod.innerType.extend({
    // Null until the agent's conversation has received its first turn.
    view: z.unknown(),
  }),
);

const piPromptResultOutputSchema = z.lazy(() =>
  z.object({
    agentName: piAgentNameSchema,
    view: z.unknown(),
    submission: z.unknown(),
    assistantText: z.string(),
  }),
);

const agentInputSchema = z.lazy(() => z.strictObject({ agentName: piAgentNameSchema }));

const promptSubmitInputSchema = z.lazy(() =>
  agentInputSchema._zod.innerType.extend({
    content: z.string().trim().min(1),
    requestId: z.string().trim().min(1).optional(),
    whenBusy: piPromptWhenBusySchema.optional(),
    billingOrganizationId: piBillingOrganizationIdSchema.optional(),
  }),
);

const promptRunInputSchema = z.lazy(() =>
  promptSubmitInputSchema._zod.innerType.extend({
    timeoutMs: z.number().int().positive().optional(),
  }),
);

const submissionGetInputSchema = z.lazy(() =>
  agentInputSchema._zod.innerType.extend({
    requestId: z.string().trim().min(1),
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
    description: "Get one defined agent and its durable conversation view.",
    permissions: [BACKOFFICE_PERMISSION.pi.read],
    input: agentInputSchema,
    output: piAgentDetailOutputSchema,
  },
  "pi.agent.create": {
    description:
      'Define an agent in the current scope. Use permissions ["*"] unless the agent should be limited: each turn already runs with the prompter\'s permissions, and the grants only narrow them.',
    permissions: [BACKOFFICE_PERMISSION.pi.manage],
    input: z.lazy(() => piAgentDefinitionCreateSchema._zod.innerType.strict()),
    output: piAgentDefinitionSchema,
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
  "pi.prompt.submit": {
    description:
      "Durably admit a prompt to an agent and return its deduplicated submission receipt. The turn runs with the caller's current permissions, narrowed by the agent's definition. A user- or system-scoped agent's first turn sets its billing organization; omitting billingOrganizationId inherits the calling Pi agent or workflow's.",
    permissions: [BACKOFFICE_PERMISSION.pi.modify],
    input: promptSubmitInputSchema,
    output: piPromptReceiptOutputSchema,
  },
  "pi.submission.get": {
    description: "Get the durable status of one prompt submission.",
    permissions: [BACKOFFICE_PERMISSION.pi.read],
    input: submissionGetInputSchema,
    output: z.lazy(() => z.unknown()),
  },
  "pi.prompt.run": {
    description:
      "Durably admit a prompt to an agent, wait for settlement, and return its conversation view.",
    permissions: [BACKOFFICE_PERMISSION.pi.modify],
    input: promptRunInputSchema,
    output: piPromptResultOutputSchema,
  },
  "pi.agent.abort": {
    description: "Abort an agent's active foreground and background work.",
    permissions: [BACKOFFICE_PERMISSION.pi.modify],
    input: agentInputSchema,
    output: z.lazy(() => z.object({ aborted: z.literal(true) })),
  },
} satisfies Record<string, BackofficeApiOperation>;
