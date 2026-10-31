import { z } from "zod";

import type { BackofficeApiOperation } from "../api";
import { BACKOFFICE_PERMISSION } from "./shared/permissions";
import {
  backofficePermissionRequirementSchema,
  type BackofficePermissionRequirement,
} from "./shared/permissions";
import { piAgentNameSchema } from "./shared/pi-agent-name";

export type AutomationExternalEntityRef<
  TSource extends string = string,
  TType extends string = string,
> = {
  scope: "external";
  source: TSource;
  type: TType;
  id: string;
};

export type AutomationEntityRef<TType extends string = string> =
  | {
      scope: "internal";
      type: TType;
      id: string;
    }
  | AutomationExternalEntityRef<string, TType>;

type AutomationActorRole = "initiator" | "principal" | "delegate" | "assistant";

export type AutomationActor<TRole extends AutomationActorRole = AutomationActorRole> =
  AutomationEntityRef & {
    role: TRole;
  };

export type AutomationActors = Readonly<{
  initiator: AutomationActor<"initiator">;
  principal: AutomationActor<"principal"> | null;
  delegation: readonly (AutomationActor<"delegate"> | AutomationActor<"assistant">)[];
}>;

const automationInternalEntitySchema = z.lazy(() =>
  z.strictObject({
    scope: z.literal("internal"),
    type: z.string().trim().min(1),
    id: z.string().trim().min(1),
  }),
);

const automationExternalEntitySchema = z.lazy(() =>
  z.strictObject({
    scope: z.literal("external"),
    source: z.string().trim().min(1),
    type: z.string().trim().min(1),
    id: z.string().trim().min(1),
  }),
);

const automationInitiatorActorSchema = z.lazy(() =>
  z.discriminatedUnion("scope", [
    automationInternalEntitySchema._zod.innerType.extend({ role: z.literal("initiator") }),
    automationExternalEntitySchema._zod.innerType.extend({ role: z.literal("initiator") }),
  ]),
);

const automationPrincipalActorSchema = z.lazy(() =>
  z.discriminatedUnion("scope", [
    automationInternalEntitySchema._zod.innerType.extend({ role: z.literal("principal") }),
    automationExternalEntitySchema._zod.innerType.extend({ role: z.literal("principal") }),
  ]),
);

const automationDelegateActorSchema = z.lazy(() =>
  z.discriminatedUnion("scope", [
    automationInternalEntitySchema._zod.innerType.extend({ role: z.literal("delegate") }),
    automationExternalEntitySchema._zod.innerType.extend({ role: z.literal("delegate") }),
  ]),
);

const automationAssistantActorSchema = z.lazy(() =>
  z.discriminatedUnion("scope", [
    automationInternalEntitySchema._zod.innerType.extend({ role: z.literal("assistant") }),
    automationExternalEntitySchema._zod.innerType.extend({ role: z.literal("assistant") }),
  ]),
);

export const automationEntityRefsEqual = (left: AutomationEntityRef, right: AutomationEntityRef) =>
  left.scope === right.scope &&
  left.type === right.type &&
  left.id === right.id &&
  (left.scope === "internal" || (right.scope === "external" && left.source === right.source));

export const automationDelegatedActorSchema = z.lazy(() =>
  z.discriminatedUnion("role", [automationDelegateActorSchema, automationAssistantActorSchema]),
);

export const automationActorsSchema: z.ZodType<AutomationActors> = z
  .lazy(() =>
    z
      .strictObject({
        initiator: automationInitiatorActorSchema,
        principal: automationPrincipalActorSchema.nullable(),
        delegation: z.array(automationDelegatedActorSchema),
      })
      .superRefine((actors, context) => {
        const actorSequence = [
          actors.initiator,
          ...(actors.principal ? [actors.principal] : []),
          ...actors.delegation,
        ];

        const hasDuplicateIdentity = actorSequence.some((actor, actorIndex) =>
          actorSequence
            .slice(0, actorIndex)
            .some((previousActor) => automationEntityRefsEqual(previousActor, actor)),
        );

        if (hasDuplicateIdentity) {
          context.addIssue({
            code: "custom",
            message: "Automation actor provenance contains duplicate identities.",
          });
        }
      }),
  )
  .meta({ id: "AutomationActors" });

/**
 * Explicit grants narrow the user's authority. `inherit` leaves the user's current permissions
 * unrestricted by the route delegate.
 */
type AutomationUserRouteGrants = readonly BackofficePermissionRequirement[] | "inherit";

/**
 * Selects whose current permissions authorize protected work started by an automation route.
 *
 * A delegate is an additional capability boundary, not an impersonated principal. The kernel
 * requires both the principal and every delegate to grant an operation, so delegation can narrow
 * authority but can never give the principal permissions they do not already have.
 *
 * A personal (user) scope's scheduled routes may use `delegated-user` with explicit grants, which
 * saving the route checks against its author: the route's own action then acts for the scope's
 * owner. Schedule events themselves name no user, so nothing reclassified or forwarded from them
 * does. Other scopes have no user to act for on a schedule, so their scheduled routes must use
 * `organization-automation`.
 */
export type AutomationAuthorityMode =
  | {
      /**
       * Run on behalf of the internal user principal carried by the triggering event. A personal
       * scope's scheduled route acts for the scope's owner instead.
       *
       * The user remains the principal and the stable route automation identity is appended as a
       * delegate. For each protected operation, the authority resolver looks up the user's current
       * role, status, and organization membership, then resolves the internal automation delegate
       * from the owning route's current grants. The kernel requires both resulting grant sets to
       * contain the operation. Missing, disabled, or changed routes and missing, invalid, banned,
       * or no-longer-authorized users therefore fail closed. The delegate can restrict but never
       * elevate the user. The delegate names the route's scope, so the same grants apply in every
       * other scope the workflow reaches as the user.
       */
      kind: "delegated-user";
      grants: AutomationUserRouteGrants;
    }
  | {
      /**
       * Resolve the external initiator's active identity binding before starting the workflow.
       *
       * The linked internal user becomes the principal and the stable route automation identity is
       * appended as a delegate. Events without an active binding do not start the workflow.
       */
      kind: "linked-user";
      grants: AutomationUserRouteGrants;
    }
  | {
      /**
       * Run as an organization-owned automation independently of the triggering user's authority.
       *
       * The stable `automation-route:<routeId>` identity becomes the principal while the original
       * initiator remains provenance and supplies no authority. For each protected operation, the
       * authority resolver reads the owning route's current grants. The stable route ID provides
       * identity for persistence and auditing while making grant changes and route disablement
       * visible to already-running workflows. The route can therefore continue after its creator or
       * triggering user loses organization access, while remaining limited to its current explicit
       * grants.
       */
      kind: "organization-automation";
      grants: readonly BackofficePermissionRequirement[];
    };

export const automationScheduleCadenceSchema = z.lazy(() =>
  z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("once"),
      at: z.iso.datetime(),
    }),
    z.object({
      kind: z.literal("cron"),
      expression: z.string().trim().min(1),
      timeZone: z.string().trim().min(1).default("UTC"),
    }),
  ]),
);

export type AutomationScheduleCadence = z.infer<typeof automationScheduleCadenceSchema>;

export type AutomationActorIdentityMatcher =
  | {
      scope: "internal";
      source?: never;
      type?: string;
      id?: string;
    }
  | {
      scope: "external";
      source?: string;
      type?: string;
      id?: string;
    };

export type AutomationActorMatcher =
  | (AutomationActorIdentityMatcher & { participation: "initiator" })
  | (AutomationActorIdentityMatcher & { participation: "principal" })
  | (AutomationActorIdentityMatcher & {
      participation: "delegation";
      role?: Extract<AutomationActorRole, "delegate" | "assistant">;
    });

export type AutomationEventMatcher =
  | { actor: AutomationActorMatcher }
  | { path: string; op: "exists" }
  | { path: string; op: "eq" | "neq" | "startsWith" | "includes"; value: unknown }
  | { all: AutomationEventMatcher[] }
  | { any: AutomationEventMatcher[] }
  | { not: AutomationEventMatcher };

type AutomationRouteRootOwnerTemplate =
  | { kind: "org"; orgIdTemplate: string }
  | { kind: "user"; userIdTemplate: string };

type AutomationRouteAppScopeTemplate = {
  kind: "app";
  owner: AutomationRouteRootOwnerTemplate;
  appIdTemplate: string;
};

/**
 * Renders to a target scope; app and project scopes name their owner as a scope template too.
 * `subject` is the scope the event is about, as its subject names it.
 */
export type AutomationRouteScopeTemplate =
  | { kind: "system" }
  | { kind: "subject" }
  | AutomationRouteRootOwnerTemplate
  | AutomationRouteAppScopeTemplate
  | {
      kind: "project";
      owner: AutomationRouteRootOwnerTemplate | AutomationRouteAppScopeTemplate;
      projectIdTemplate: string;
    };

export type AutomationStartWorkflowAction = {
  kind: "start_workflow";
  authority: AutomationAuthorityMode;
  workflowScriptPath: string;
  instanceIdTemplate: string;
};

export type AutomationWorkflowEventTarget =
  | { kind: "instance_id"; template: string }
  | { kind: "stored_instance_id"; keyTemplate: string };

export type AutomationSendWorkflowEventAction = {
  kind: "send_workflow_event";
  target: AutomationWorkflowEventTarget;
  eventType: string;
  payload?: unknown;
};

export type AutomationForwardEventAction = {
  kind: "forward_event";
  targetScope: AutomationRouteScopeTemplate;
  idTemplate?: string;
};

export type AutomationEventPayloadProjection = {
  kind: "projection";
  fields: Record<string, string>;
};

export type AutomationReclassifyEventAction = {
  kind: "reclassify_event";
  source: string;
  eventType: string;
  payload: AutomationEventPayloadProjection;
};

/** Delivers the event to an agent in the route's scope as a turn run with the route's authority. */
export type AutomationNotifyAgentAction = {
  kind: "notify_agent";
  agentName: string;
  authority: AutomationAuthorityMode;
};

export type AutomationRouteAction =
  | AutomationStartWorkflowAction
  | AutomationSendWorkflowEventAction
  | AutomationForwardEventAction
  | AutomationReclassifyEventAction
  | AutomationNotifyAgentAction;

/** The authority an action runs its work with, or null for actions that only move events. */
export function automationRouteActionAuthority(
  action: AutomationRouteAction,
): AutomationAuthorityMode | null {
  return action.kind === "start_workflow" || action.kind === "notify_agent"
    ? action.authority
    : null;
}

export type AutomationRouteEventTrigger = {
  kind: "event";
  source: string;
  eventType: string;
  matcher: AutomationEventMatcher | null;
};

export type AutomationRouteScheduleTrigger = {
  kind: "schedule";
  cadence: AutomationScheduleCadence;
};

export type AutomationRouteTrigger = AutomationRouteEventTrigger | AutomationRouteScheduleTrigger;

/**
 * Who maintains a resource's definition, such as a route or an event definition. Backoffice stamps
 * it from the writer, never from input; only the steward changes the definition, while members may
 * still turn a stewarded resource on or off.
 */
export type AutomationSteward = { kind: "members" } | { kind: "package"; listingId: string };

export type AutomationRouteMetadata = {
  createdByActors: AutomationActors;
  updatedByActors: AutomationActors;
};

/** Persisted routes may predate the authority rules enforced on create and activation. */
export type AutomationRouteDefinition = {
  trigger: AutomationRouteTrigger;
  action: AutomationRouteAction;
  id: string;
  name: string;
  enabled: boolean;
  priority: number;
  description?: string | null;
  steward: AutomationSteward;
  metadata?: AutomationRouteMetadata | null;
  nextOccurrenceAt: string | null;
};

export const isAutomationActorProvenancePath = (path: string) =>
  path === "$.actor" ||
  path.startsWith("$.actor.") ||
  path.startsWith("$.actor[") ||
  path === "$.actors" ||
  path.startsWith("$.actors.") ||
  path.startsWith("$.actors[");

const automationActorMatcherSchema: z.ZodType<AutomationActorMatcher> = z.lazy(() =>
  z.discriminatedUnion("participation", [
    z.discriminatedUnion("scope", [
      z.strictObject({
        participation: z.literal("initiator"),
        scope: z.literal("internal"),
        type: z.string().trim().min(1).optional(),
        id: z.string().trim().min(1).optional(),
      }),
      z.strictObject({
        participation: z.literal("initiator"),
        scope: z.literal("external"),
        source: z.string().trim().min(1).optional(),
        type: z.string().trim().min(1).optional(),
        id: z.string().trim().min(1).optional(),
      }),
    ]),
    z.discriminatedUnion("scope", [
      z.strictObject({
        participation: z.literal("principal"),
        scope: z.literal("internal"),
        type: z.string().trim().min(1).optional(),
        id: z.string().trim().min(1).optional(),
      }),
      z.strictObject({
        participation: z.literal("principal"),
        scope: z.literal("external"),
        source: z.string().trim().min(1).optional(),
        type: z.string().trim().min(1).optional(),
        id: z.string().trim().min(1).optional(),
      }),
    ]),
    z.discriminatedUnion("scope", [
      z.strictObject({
        participation: z.literal("delegation"),
        scope: z.literal("internal"),
        type: z.string().trim().min(1).optional(),
        id: z.string().trim().min(1).optional(),
        role: z.enum(["delegate", "assistant"]).optional(),
      }),
      z.strictObject({
        participation: z.literal("delegation"),
        scope: z.literal("external"),
        source: z.string().trim().min(1).optional(),
        type: z.string().trim().min(1).optional(),
        id: z.string().trim().min(1).optional(),
        role: z.enum(["delegate", "assistant"]).optional(),
      }),
    ]),
  ]),
);

const automationEventPathSchema = z.lazy(() =>
  z
    .string()
    .trim()
    .min(1)
    .refine((path) => !isAutomationActorProvenancePath(path), {
      message: "Actor routing must use the structural actor matcher.",
    }),
);

const automationEventMatcherSchema: z.ZodType<AutomationEventMatcher> = z
  .lazy(() =>
    z.lazy(() =>
      z.union([
        z.strictObject({ actor: automationActorMatcherSchema }),
        z.object({ path: automationEventPathSchema, op: z.literal("exists") }),
        z.object({
          path: automationEventPathSchema,
          op: z.union([
            z.literal("eq"),
            z.literal("neq"),
            z.literal("startsWith"),
            z.literal("includes"),
          ]),
          value: z.unknown(),
        }),
        z.object({ all: z.array(automationEventMatcherSchema) }),
        z.object({ any: z.array(automationEventMatcherSchema) }),
        z.object({ not: automationEventMatcherSchema }),
      ]),
    ),
  )
  .meta({ id: "AutomationEventMatcher" });

const automationRouteOrganizationScopeTemplateSchema = z.lazy(() =>
  z.object({
    kind: z.literal("org"),
    orgIdTemplate: z.string().trim().min(1),
  }),
);
const automationRouteUserScopeTemplateSchema = z.lazy(() =>
  z.object({
    kind: z.literal("user"),
    userIdTemplate: z.string().trim().min(1),
  }),
);
const automationRouteAppScopeTemplateSchema = z.lazy(() =>
  z.object({
    kind: z.literal("app"),
    owner: z.discriminatedUnion("kind", [
      automationRouteOrganizationScopeTemplateSchema,
      automationRouteUserScopeTemplateSchema,
    ]),
    appIdTemplate: z.string().trim().min(1),
  }),
);

const automationRouteScopeTemplateSchema: z.ZodType<AutomationRouteScopeTemplate> = z
  .lazy(() =>
    z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("system") }),
      z.object({ kind: z.literal("subject") }),
      automationRouteOrganizationScopeTemplateSchema,
      automationRouteUserScopeTemplateSchema,
      automationRouteAppScopeTemplateSchema,
      z.object({
        kind: z.literal("project"),
        owner: z.discriminatedUnion("kind", [
          automationRouteOrganizationScopeTemplateSchema,
          automationRouteUserScopeTemplateSchema,
          automationRouteAppScopeTemplateSchema,
        ]),
        projectIdTemplate: z.string().trim().min(1),
      }),
    ]),
  )
  .meta({ id: "AutomationRouteScopeTemplate" });

function backofficePermissionKey(grant: BackofficePermissionRequirement): string {
  return `${grant.namespace}.${grant.permission}`;
}

const automationRouteGrantsSchema = z.lazy(() =>
  z.array(backofficePermissionRequirementSchema).superRefine((grants, context) => {
    const encountered = new Set<string>();
    for (const [index, grant] of grants.entries()) {
      const key = backofficePermissionKey(grant);
      if (encountered.has(key)) {
        context.addIssue({
          code: "custom",
          path: [index],
          message: `Automation route grant '${key}' is duplicated.`,
        });
      }
      encountered.add(key);
    }
  }),
) satisfies z.ZodType<readonly BackofficePermissionRequirement[]>;

const automationAuthorityModeSchema = z
  .lazy(() =>
    z.discriminatedUnion("kind", [
      z.strictObject({
        kind: z.literal("delegated-user"),
        grants: z.union([automationRouteGrantsSchema, z.literal("inherit")]),
      }),
      z.strictObject({
        kind: z.literal("linked-user"),
        grants: z.union([automationRouteGrantsSchema, z.literal("inherit")]),
      }),
      z.strictObject({
        kind: z.literal("organization-automation"),
        grants: automationRouteGrantsSchema,
      }),
    ]),
  )
  .meta({ id: "AutomationAuthorityMode" });

const automationStartWorkflowActionSchema = z
  .lazy(() =>
    z.strictObject({
      kind: z.literal("start_workflow"),
      authority: automationAuthorityModeSchema,
      workflowScriptPath: z.string().trim().min(1),
      instanceIdTemplate: z.string().trim().min(1),
    }),
  )
  .meta({ id: "AutomationStartWorkflowAction" }) satisfies z.ZodType<AutomationStartWorkflowAction>;

const automationWorkflowEventTargetSchema: z.ZodType<AutomationWorkflowEventTarget> = z
  .lazy(() =>
    z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("instance_id"), template: z.string().trim().min(1) }).meta({
        id: "AutomationWorkflowEventInstanceIdTarget",
      }),
      z
        .object({ kind: z.literal("stored_instance_id"), keyTemplate: z.string().trim().min(1) })
        .meta({
          id: "AutomationWorkflowEventStoredInstanceIdTarget",
        }),
    ]),
  )
  .meta({ id: "AutomationWorkflowEventTarget" });

const automationSendWorkflowEventActionSchema = z
  .lazy(() =>
    z.strictObject({
      kind: z.literal("send_workflow_event"),
      target: automationWorkflowEventTargetSchema,
      eventType: z.string().trim().min(1),
      payload: z.unknown().optional(),
    }),
  )
  .meta({
    id: "AutomationSendWorkflowEventAction",
  }) satisfies z.ZodType<AutomationSendWorkflowEventAction>;

const automationForwardEventActionSchema = z
  .lazy(() =>
    z.object({
      kind: z.literal("forward_event"),
      targetScope: automationRouteScopeTemplateSchema,
      idTemplate: z.string().trim().min(1).optional(),
    }),
  )
  .meta({ id: "AutomationForwardEventAction" }) satisfies z.ZodType<AutomationForwardEventAction>;

const automationEventPayloadProjectionSchema = z
  .lazy(() =>
    z.strictObject({
      kind: z.literal("projection"),
      fields: z.record(
        z.string().trim().min(1),
        z
          .string()
          .trim()
          .refine((path) => path === "$" || path.startsWith("$."), {
            message: "Projection paths must start with $.",
          }),
      ),
    }),
  )
  .meta({
    id: "AutomationEventPayloadProjection",
  }) satisfies z.ZodType<AutomationEventPayloadProjection>;

const automationReclassifyEventActionSchema = z
  .lazy(() =>
    z.strictObject({
      kind: z.literal("reclassify_event"),
      source: z.string().trim().min(1),
      eventType: z.string().trim().min(1),
      payload: automationEventPayloadProjectionSchema,
    }),
  )
  .meta({
    id: "AutomationReclassifyEventAction",
  }) satisfies z.ZodType<AutomationReclassifyEventAction>;

const automationNotifyAgentActionSchema = z
  .lazy(() =>
    z.strictObject({
      kind: z.literal("notify_agent"),
      agentName: piAgentNameSchema,
      authority: automationAuthorityModeSchema,
    }),
  )
  .meta({ id: "AutomationNotifyAgentAction" }) satisfies z.ZodType<AutomationNotifyAgentAction>;

export const automationRouteActionSchema = z
  .lazy(() =>
    z.discriminatedUnion("kind", [
      automationStartWorkflowActionSchema,
      automationSendWorkflowEventActionSchema,
      automationForwardEventActionSchema,
      automationReclassifyEventActionSchema,
      automationNotifyAgentActionSchema,
    ]),
  )
  .meta({ id: "AutomationRouteAction" }) satisfies z.ZodType<AutomationRouteAction>;

export const automationStewardSchema: z.ZodType<AutomationSteward> = z
  .lazy(() =>
    z.discriminatedUnion("kind", [
      z.strictObject({ kind: z.literal("members") }),
      z.strictObject({ kind: z.literal("package"), listingId: z.string().trim().min(1) }),
    ]),
  )
  .meta({ id: "AutomationSteward" });

const automationRouteMetadataSchema = z.lazy(() =>
  z.strictObject({
    createdByActors: automationActorsSchema,
    updatedByActors: automationActorsSchema,
  }),
);

const automationRouteEventTriggerSchema = z.lazy(() =>
  z.object({
    kind: z.literal("event"),
    source: z.string().trim().min(1),
    eventType: z.string().trim().min(1),
    matcher: automationEventMatcherSchema.nullable().default(null),
  }),
);

const automationRouteScheduleTriggerSchema = z.lazy(() =>
  z.object({
    kind: z.literal("schedule"),
    cadence: automationScheduleCadenceSchema,
  }),
);

const automationRouteTriggerSchema: z.ZodType<AutomationRouteTrigger> = z
  .lazy(() =>
    z.discriminatedUnion("kind", [
      automationRouteEventTriggerSchema,
      automationRouteScheduleTriggerSchema,
    ]),
  )
  .meta({ id: "AutomationRouteTrigger", codemodeInputId: "AutomationRouteTriggerInput" });

export const automationRouteSchema: z.ZodType<AutomationRouteDefinition> = z
  .lazy(() =>
    z.object({
      id: z.string().trim().min(1),
      name: z.string().trim().min(1),
      enabled: z.boolean(),
      priority: z.number().int(),
      trigger: automationRouteTriggerSchema,
      action: automationRouteActionSchema,
      description: z.string().nullable().optional(),
      steward: automationStewardSchema,
      metadata: automationRouteMetadataSchema.nullable(),
      nextOccurrenceAt: z.iso.datetime().nullable(),
    }),
  )
  .meta({ id: "AutomationRoute" });

export const automationRouteCreateInputSchema = z.lazy(() =>
  z.object({
    id: z.string().trim().min(1),
    name: z.string().trim().min(1),
    enabled: z.boolean().default(true),
    priority: z.number().int().default(1000),
    description: z.string().nullable().optional(),
    trigger: automationRouteTriggerSchema,
    action: automationRouteActionSchema,
  }),
);

const automationRouteUpdateObjectSchema = z.lazy(() =>
  z.object({
    id: z.string().trim().min(1),
    name: z.string().trim().min(1).optional(),
    enabled: z.boolean().optional(),
    priority: z.number().int().optional(),
    trigger: automationRouteTriggerSchema.optional(),
    action: automationRouteActionSchema.optional(),
    description: z.string().nullable().optional(),
  }),
);

export const automationRouteUpdatePayloadSchema = z.lazy(() =>
  automationRouteUpdateObjectSchema._zod.innerType
    .omit({ id: true })
    .refine((patch) => Object.values(patch).some((value) => typeof value !== "undefined"), {
      message: "At least one route field must be provided.",
    }),
);

export const automationRouteUpdateInputSchema = z.lazy(() =>
  automationRouteUpdateObjectSchema.refine(
    ({ id: _id, ...patch }) => Object.values(patch).some((value) => typeof value !== "undefined"),
    { message: "At least one route field must be provided." },
  ),
);

export type AutomationRouteCreateInput = z.infer<typeof automationRouteCreateInputSchema>;

export type AutomationRouteUpdateInput = z.infer<typeof automationRouteUpdateInputSchema>;

export const automationRouterOperations = {
  "router.list": {
    description: "List database-backed automation routing rules.",
    permissions: [BACKOFFICE_PERMISSION.router.read],
    input: z.void(),
    output: z.lazy(() => z.array(automationRouteSchema)),
  },
  "router.get": {
    description: "Get one database-backed automation routing rule.",
    permissions: [BACKOFFICE_PERMISSION.router.read],
    input: z.lazy(() => z.object({ id: z.string().trim().min(1) })),
    output: z.lazy(() => automationRouteSchema.nullable()),
  },
  "router.create": {
    description: "Create a database-backed automation routing rule.",
    permissions: [BACKOFFICE_PERMISSION.router.modify],
    input: automationRouteCreateInputSchema,
    output: automationRouteSchema,
  },
  "router.update": {
    description:
      "Update a database-backed automation routing rule. A route a package manages (steward kind 'package') only accepts enabling or disabling it; change its definition through the package.",
    permissions: [BACKOFFICE_PERMISSION.router.modify],
    input: automationRouteUpdateInputSchema,
    output: z.lazy(() => automationRouteSchema.nullable()),
  },
  "router.delete": {
    description:
      "Idempotently delete a database-backed automation route. Routes a package manages are removed by uninstalling the package.",
    permissions: [BACKOFFICE_PERMISSION.router.modify],
    input: z.lazy(() => z.object({ id: z.string().trim().min(1) })),
    output: z.lazy(() => z.object({ deleted: z.literal(true) })),
  },
  "router.trigger-now": {
    description: "Trigger a scheduled automation route immediately without changing its cadence.",
    permissions: [BACKOFFICE_PERMISSION.router.modify],
    input: z.lazy(() => z.object({ id: z.string().trim().min(1) })),
    output: z.lazy(() => z.object({ accepted: z.literal(true), eventId: z.string() }).nullable()),
  },
} satisfies Record<string, BackofficeApiOperation>;
