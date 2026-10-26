import { z } from "zod";

import type { BackofficeApiOperation } from "../api";
import {
  type AutomationActors,
  automationActorsSchema,
  automationStewardSchema,
} from "./automation";
import { BACKOFFICE_PERMISSION } from "./shared/permissions";
import { type BackofficeContextScope, backofficeContextScopeSchema } from "./shared/scope";

export type AutomationEventPayload = Record<string, unknown>;

export type AutomationEventSubject = {
  orgId?: string;
  userId?: string;
  [key: string]: unknown;
};

/** The event that led to another event, and the origin event its causal tree grows from. */
export type AutomationEventParent = {
  eventId: string;
  rootEventId: string;
};

/**
 * Why an event exists. Origins enter from outside automations, such as a webhook or a user
 * action. Routes derive events by forwarding or reclassifying their parent. Workflows fire events
 * while they run; a manually started workflow has no parent event.
 */
export type AutomationEventCausation =
  | { kind: "origin" }
  | { kind: "route"; routeId: string; parent: AutomationEventParent }
  | {
      kind: "workflow";
      workflowName: string;
      instanceId: string;
      parent: AutomationEventParent | null;
    };

export type AutomationEvent = {
  id: string;
  scope: BackofficeContextScope;
  scopeRestriction: BackofficeContextScope | null;
  source: string;
  eventType: string;
  occurredAt: string;
  payload: AutomationEventPayload;
  actors: AutomationActors;
  subject?: AutomationEventSubject | null;
  causation: AutomationEventCausation;
};

/** Origin events, and events of manually started workflows, root their own causal tree. */
export function automationEventRootId(event: Pick<AutomationEvent, "id" | "causation">): string {
  const { causation } = event;
  return causation.kind === "origin" || causation.parent === null
    ? event.id
    : causation.parent.rootEventId;
}

/** The parent link for events derived from `event`. */
export function automationEventParentOf(
  event: Pick<AutomationEvent, "id" | "causation">,
): AutomationEventParent {
  return { eventId: event.id, rootEventId: automationEventRootId(event) };
}

export const idSchema = z.lazy(() =>
  z.preprocess((value) => {
    if (typeof value === "string") {
      return value;
    }
    if (value && typeof value === "object" && "valueOf" in value) {
      const primitive = value.valueOf();
      if (typeof primitive === "string" || typeof primitive === "number") {
        return String(primitive);
      }
    }
    return value;
  }, z.string()),
);

const automationEventSubjectSchema: z.ZodType<AutomationEventSubject> = z.lazy(() =>
  z
    .object({
      orgId: z.string().trim().min(1).optional(),
      userId: z.string().trim().min(1).optional(),
    })
    .catchall(z.unknown()),
);

const automationEventParentSchema = z.lazy(() =>
  z.strictObject({
    eventId: z.string().trim().min(1),
    rootEventId: z.string().trim().min(1),
  }),
);

export const automationEventCausationSchema: z.ZodType<AutomationEventCausation> = z.lazy(() =>
  z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("origin") }),
    z.strictObject({
      kind: z.literal("route"),
      routeId: z.string().trim().min(1),
      parent: automationEventParentSchema,
    }),
    z.strictObject({
      kind: z.literal("workflow"),
      workflowName: z.string().trim().min(1),
      instanceId: z.string().trim().min(1),
      parent: automationEventParentSchema.nullable(),
    }),
  ]),
);

export const automationEventSchema = z.lazy(() =>
  z.object({
    id: idSchema,
    scope: backofficeContextScopeSchema,
    scopeRestriction: backofficeContextScopeSchema.nullable(),
    source: z.string().trim().min(1),
    eventType: z.string().trim().min(1),
    occurredAt: z.iso.datetime(),
    payload: z.record(z.string(), z.unknown()),
    actors: automationActorsSchema,
    subject: z.preprocess((value) => value ?? null, automationEventSubjectSchema.nullable()),
    // Events recorded before causation was tracked read as origins.
    causation: z.preprocess((value) => value ?? { kind: "origin" }, automationEventCausationSchema),
  }),
) satisfies z.ZodType<AutomationEvent>;

export const automationEventRecordSchema = z.lazy(() =>
  automationEventSchema._zod.innerType.extend({
    createdAt: z.iso.datetime().optional(),
  }),
);

export type AutomationEventRecord = z.infer<typeof automationEventRecordSchema>;

export const automationEventListInputSchema = z.lazy(() =>
  z.object({
    limit: z.number().int().positive().max(500).optional(),
  }),
);

export const automationEventListResultSchema = z.lazy(() =>
  z.object({
    events: z.array(automationEventDetailSchema),
    nextCursor: z.string().optional(),
    hasNextPage: z.boolean(),
  }),
);

/**
 * Why a matched route did nothing. `no_linked_external_sender`: a linked-user route only acts for
 * an external sender linked to a user, and the event had none. `workflow_instance_unresolved`: the
 * route's target instance id rendered empty. `caused_by_notified_agent`: the agent's own turns
 * produced the event, and notifying it would let the agent wake itself.
 */
export type AutomationRouteDispatchSkipReason =
  | "no_linked_external_sender"
  | "workflow_instance_unresolved"
  | "caused_by_notified_agent";

/**
 * What a matched route did with an event. Derived events also record the route in their own
 * causation.
 */
export type AutomationRouteDispatchOutcome =
  | { kind: "workflow_started"; workflowName: string; instanceId: string }
  | { kind: "workflow_event_sent"; workflowName: string; instanceId: string; eventType: string }
  | { kind: "event_forwarded"; eventId: string; scope: BackofficeContextScope }
  | { kind: "event_reclassified"; eventId: string }
  | { kind: "agent_notified"; agentName: string }
  | { kind: "skipped"; reason: AutomationRouteDispatchSkipReason };

/**
 * Where a matched route stands. `failedAttempts` counts the attempts that threw; a completed route
 * keeps the count, so one that only acted after retries stays visible. `retrying` and `failed`
 * keep the last error; `failed` is final, because no retry can fix the error or the route ran out
 * of attempts.
 */
export type AutomationRouteDispatchState =
  | { status: "pending" }
  | { status: "retrying"; failedAttempts: number; error: string }
  | { status: "completed"; outcome: AutomationRouteDispatchOutcome; failedAttempts: number }
  | { status: "failed"; failedAttempts: number; error: string };

/** One route an event matched, and where it stands. */
export type AutomationEventRouteDispatch = AutomationRouteDispatchState & {
  routeId: string;
  /** The route's name when it matched; routes can be renamed or deleted after they act. */
  routeName: string;
  matchedAt: string;
};

/**
 * Which routes an event matched. Routes are matched shortly after an event is stored, so a
 * `matching` event's routes are not known yet.
 */
export type AutomationEventRouting =
  | { status: "matching" }
  | { status: "matched"; routes: AutomationEventRouteDispatch[] };

const automationRouteDispatchOutcomeSchema: z.ZodType<AutomationRouteDispatchOutcome> = z.lazy(() =>
  z.discriminatedUnion("kind", [
    z.strictObject({
      kind: z.literal("workflow_started"),
      workflowName: z.string(),
      instanceId: z.string(),
    }),
    z.strictObject({
      kind: z.literal("workflow_event_sent"),
      workflowName: z.string(),
      instanceId: z.string(),
      eventType: z.string(),
    }),
    z.strictObject({
      kind: z.literal("event_forwarded"),
      eventId: z.string(),
      scope: backofficeContextScopeSchema,
    }),
    z.strictObject({ kind: z.literal("event_reclassified"), eventId: z.string() }),
    z.strictObject({ kind: z.literal("agent_notified"), agentName: z.string() }),
    z.strictObject({
      kind: z.literal("skipped"),
      reason: z.enum([
        "no_linked_external_sender",
        "workflow_instance_unresolved",
        "caused_by_notified_agent",
      ]),
    }),
  ]),
);

export const automationEventRouteDispatchSchema: z.ZodType<AutomationEventRouteDispatch> = z.lazy(
  () => {
    const route = {
      routeId: z.string(),
      routeName: z.string(),
      matchedAt: z.iso.datetime(),
    };
    return z.discriminatedUnion("status", [
      z.strictObject({ ...route, status: z.literal("pending") }),
      z.strictObject({
        ...route,
        status: z.literal("retrying"),
        failedAttempts: z.number().int().positive(),
        error: z.string(),
      }),
      z.strictObject({
        ...route,
        status: z.literal("completed"),
        outcome: automationRouteDispatchOutcomeSchema,
        failedAttempts: z.number().int().nonnegative(),
      }),
      z.strictObject({
        ...route,
        status: z.literal("failed"),
        failedAttempts: z.number().int().positive(),
        error: z.string(),
      }),
    ]);
  },
);

const automationEventRoutingSchema: z.ZodType<AutomationEventRouting> = z.lazy(() =>
  z.discriminatedUnion("status", [
    z.strictObject({ status: z.literal("matching") }),
    z.strictObject({
      status: z.literal("matched"),
      routes: z.array(automationEventRouteDispatchSchema),
    }),
  ]),
);

/** A stored event with what the routes it matched did with it. */
export const automationEventDetailSchema = z.lazy(() =>
  automationEventRecordSchema._zod.innerType.extend({ routing: automationEventRoutingSchema }),
);

export type AutomationEventDetail = z.infer<typeof automationEventDetailSchema>;

export const automationEventRoutesListInputSchema = z.lazy(() =>
  z.object({
    /** The state of the routes to list, such as `failed` or `retrying`. */
    status: z.enum(["pending", "retrying", "completed", "failed"]),
    limit: z.number().int().positive().max(500).optional(),
    cursor: z.string().trim().min(1).optional(),
  }),
);

export type AutomationEventRoutesListInput = z.infer<typeof automationEventRoutesListInputSchema>;

/** Routes in one state, each with the event it matched, by when it matched, newest first. */
export const automationEventRoutesListResultSchema = z.lazy(() =>
  z.object({
    routes: z.array(z.object({ eventId: z.string(), route: automationEventRouteDispatchSchema })),
    nextCursor: z.string().optional(),
    hasNextPage: z.boolean(),
  }),
);

export type AutomationEventRoutesListResult = z.infer<typeof automationEventRoutesListResultSchema>;

const jsonSchemaDocumentSchema = z.lazy(() => z.record(z.string(), z.unknown()));

/**
 * An event definition a workspace adds to the catalog. Members define their own; a package's are
 * declared by the package and only change when it is installed again or uninstalled.
 */
export const automationEventDefinitionSchema = z.lazy(() =>
  z.object({
    id: z.string().trim().min(1),
    source: z.string().trim().min(1),
    eventType: z.string().trim().min(1),
    label: z.string().trim().min(1),
    description: z.string().nullable().optional(),
    payloadSchema: jsonSchemaDocumentSchema.nullable().optional(),
    actorSchema: jsonSchemaDocumentSchema.nullable().optional(),
    subjectSchema: jsonSchemaDocumentSchema.nullable().optional(),
    example: z.unknown().nullable().optional(),
    enabled: z.boolean(),
    capabilityId: z.string(),
    steward: automationStewardSchema,
    createdAt: z.iso.datetime().optional(),
    updatedAt: z.iso.datetime().optional(),
  }),
);

export type AutomationEventDefinition = z.infer<typeof automationEventDefinitionSchema>;

export const automationEventDefinitionCreateInputSchema = z.lazy(() =>
  z.object({
    source: z.string().trim().min(1),
    eventType: z.string().trim().min(1),
    label: z.string().trim().min(1),
    description: z.string().nullable().optional(),
    payloadSchema: jsonSchemaDocumentSchema.nullable().optional(),
    actorSchema: jsonSchemaDocumentSchema.nullable().optional(),
    subjectSchema: jsonSchemaDocumentSchema.nullable().optional(),
    example: z.unknown().nullable().optional(),
    enabled: z.boolean().default(true),
  }),
);

export type AutomationEventDefinitionCreateInput = z.input<
  typeof automationEventDefinitionCreateInputSchema
>;

export const automationEventDefinitionUpdatePayloadSchema = z.lazy(() =>
  z
    .object({
      label: z.string().trim().min(1).optional(),
      description: z.string().nullable().optional(),
      payloadSchema: jsonSchemaDocumentSchema.nullable().optional(),
      actorSchema: jsonSchemaDocumentSchema.nullable().optional(),
      subjectSchema: jsonSchemaDocumentSchema.nullable().optional(),
      example: z.unknown().nullable().optional(),
      enabled: z.boolean().optional(),
    })
    .refine((patch) => Object.values(patch).some((value) => typeof value !== "undefined"), {
      message: "At least one event definition field must be provided.",
    }),
);

export const automationEventDefinitionUpdateInputSchema = z.lazy(() =>
  z.object({
    source: z.string().trim().min(1),
    eventType: z.string().trim().min(1),
    patch: automationEventDefinitionUpdatePayloadSchema,
  }),
);

export type AutomationEventDefinitionUpdateInput = z.input<
  typeof automationEventDefinitionUpdateInputSchema
>;

const eventListInputSchema = z.lazy(() =>
  automationEventListInputSchema._zod.innerType.extend({
    cursor: z.string().trim().min(1).optional(),
  }),
);

export type EventListInput = z.infer<typeof eventListInputSchema>;

const eventEmitInputSchema = z.lazy(() =>
  z.strictObject({
    eventType: z.string().trim().min(1),
    source: z.string().trim().min(1).optional(),
    subjectUserId: z.string().trim().min(1).optional(),
    payload: z.record(z.string(), z.unknown()).optional(),
    targetScope: backofficeContextScopeSchema.optional(),
  }),
);

const eventEmitOutputSchema = z.lazy(() =>
  z.object({
    accepted: z.boolean(),
    eventId: z.string().trim().min(1),
    scope: backofficeContextScopeSchema,
    source: z.string().trim().min(1),
    eventType: z.string().trim().min(1),
  }),
);

const automationEventDescriptorSchema = z.lazy(() =>
  z.object({
    source: z.string(),
    eventType: z.string(),
    label: z.string(),
    description: z.string().optional(),
    capabilityId: z.string(),
    payloadSchema: z.record(z.string(), z.unknown()).optional(),
    actorSchema: z.record(z.string(), z.unknown()).optional(),
    subjectSchema: z.record(z.string(), z.unknown()).optional(),
    example: z.unknown().optional(),
  }),
);

const automationEventsCatalogListOutputSchema = z.lazy(() =>
  z.array(
    automationEventDescriptorSchema._zod.innerType.omit({
      payloadSchema: true,
      actorSchema: true,
      subjectSchema: true,
    }),
  ),
);

const automationEventCatalogGetInputSchema = z.lazy(() =>
  z.object({
    source: z.string().trim().min(1),
    eventType: z.string().trim().min(1),
  }),
);

export const eventsOperations = {
  "events.fire": {
    description:
      "Fire an automation event for the current context or a selected target scope. Sources starting with `app:` belong to installed apps, and only an app's own credential emits them.",
    permissions: [BACKOFFICE_PERMISSION.events.emit],
    input: eventEmitInputSchema,
    output: eventEmitOutputSchema,
  },
  "events.list": {
    description:
      "List stored automation events in the current scope, newest first, each with the routes it matched and where they stand.",
    permissions: [BACKOFFICE_PERMISSION.events.read],
    input: eventListInputSchema,
    output: automationEventListResultSchema,
  },
  "events.get": {
    description:
      "Get one stored automation event by id in the current scope, with each route it matched and where that route stands: about to act, retrying after an error, completed with what it did, or failed for good.",
    permissions: [BACKOFFICE_PERMISSION.events.read],
    input: z.lazy(() => z.object({ id: z.string().trim().min(1) })),
    output: z.lazy(() => automationEventDetailSchema.nullable()),
  },
  "events.routes.list": {
    description:
      "List the routes in one state on stored events in the current scope, such as those that failed for good or are retrying, each with the event it matched, newest match first. Use events.get for the whole event.",
    permissions: [BACKOFFICE_PERMISSION.events.read],
    input: automationEventRoutesListInputSchema,
    output: automationEventRoutesListResultSchema,
  },
  "events.routes.retry": {
    description:
      "Retry a route that failed for good on a stored event, with a fresh set of attempts. The route acts as it was when the event matched it, with the route's current permissions, so retry after fixing what it depends on, such as a missing workflow run or permission; changes to the route's action apply only to new events. Returns the route, now pending, or null when the event did not match it.",
    permissions: [BACKOFFICE_PERMISSION.router.modify],
    input: z.lazy(() =>
      z.object({ eventId: z.string().trim().min(1), routeId: z.string().trim().min(1) }),
    ),
    output: z.lazy(() => automationEventRouteDispatchSchema.nullable()),
  },
  "events.catalog.list": {
    description:
      "List known automation event source/type pairs from the Backoffice capability registry.",
    permissions: [BACKOFFICE_PERMISSION.events.read],
    input: z.void(),
    output: automationEventsCatalogListOutputSchema,
  },
  "events.catalog.get": {
    description: "Get one automation event descriptor and its JSON schemas.",
    permissions: [BACKOFFICE_PERMISSION.events.read],
    input: automationEventCatalogGetInputSchema,
    output: z.lazy(() => automationEventDescriptorSchema.nullable()),
  },
  "events.catalog.create": {
    description: "Create a scoped dynamic automation event definition with optional JSON schemas.",
    permissions: [BACKOFFICE_PERMISSION.events.manage],
    input: automationEventDefinitionCreateInputSchema,
    output: automationEventDefinitionSchema,
  },
} satisfies Record<string, BackofficeApiOperation>;

export type AutomationEventCatalogEntry = z.infer<typeof automationEventDescriptorSchema>;

export type AutomationEventsCatalogListOutput = z.infer<
  typeof automationEventsCatalogListOutputSchema
>;

export type AutomationEventCatalogGetInput = z.infer<typeof automationEventCatalogGetInputSchema>;
