import {
  automationActorsSchema,
  automationEntityRefsEqual,
  type AutomationAuthorityMode,
  type AutomationForwardEventAction,
  type AutomationNotifyAgentAction,
  type AutomationReclassifyEventAction,
  type AutomationRouteDefinition,
  type AutomationSendWorkflowEventAction,
  type AutomationStartWorkflowAction,
} from "@fragno-dev/backoffice-api/v0/automation";
import {
  type AutomationEvent,
  type AutomationEventDefinition,
  automationEventParentOf,
  automationEventRootId,
  type AutomationRouteDispatchOutcome,
} from "@fragno-dev/backoffice-api/v0/events";
import {
  type BackofficeContextScope,
  type BackofficeRootOwner,
  type BackofficeScopeIdNames,
  backofficeScopeContains,
  backofficeScopeRootOwner,
} from "@fragno-dev/backoffice-api/v0/shared/scope";
import type { InstanceStatus } from "@fragno-dev/workflows/workflow";

import { defineFragment } from "@fragno-dev/core";
import {
  type DatabaseHandlerTx,
  defaultDurableHookRetryPolicy,
  type DurableHookRetryPolicy,
  withDatabase,
  type TxResult,
} from "@fragno-dev/db";
import type { WorkflowsFragmentServices } from "@fragno-dev/workflows";

import {
  createBackofficeSystemExecution,
  type BackofficeExecutionContext,
} from "@/backoffice-runtime/context";
import { BackofficeKernel, BackofficeForbiddenError } from "@/backoffice-runtime/kernel";
import { BackofficeOperationError } from "@/backoffice-runtime/operation-error";
import type { BackofficeRootOwnerReference } from "@/backoffice-runtime/resolved-scope";
import type { BackofficeRuntimeServices } from "@/backoffice-runtime/runtime-services";
import { readSavedWorkflowProgram } from "@/fragno/codemode/workflow-program";
import { piAgentActor } from "@/fragno/pi/agent/pi-agent-actor";
import { piAgentNotificationEvent } from "@/fragno/pi/agent/pi-agent-contract";
import { createPiManagerRuntime } from "@/fragno/pi/manager/pi-manager-runtime";

import {
  actForScheduledRouteUser,
  automationRouteAuthority,
  createAutomationRuntimeExecution,
  linkAutomationEventToUser,
} from "./authority";
import { resolveAutomationScriptPath, type AutomationSourceReader } from "./automation-source";
import { createAutomationStoreServices } from "./bindings-storage-runtime";
import { SYSTEM_STARTER_AUTOMATION_ROUTES } from "./content/starter-routing";
import { getAutomationEventIdentity, type AutomationEventIdentity } from "./contracts";
import {
  CODEMODE_WORKFLOW,
  createCodemodeWorkflowInstanceInput,
  prepareCodemodeWorkflowInstance,
} from "./engine/codemode-invocation";
import {
  AutomationEventDefinitionValidationError,
  buildAutomationEventDefinitionId,
  validateAutomationEventPayload,
} from "./event-definitions";
import { createAutomationEventDefinitionServices } from "./event-definitions-storage-runtime";
import { createAutomationEventSourceServices } from "./event-sources-storage-runtime";
import { createAutomationEventServices } from "./events-storage-runtime";
import { buildExternalIdentityBindingId, canLinkExternalIdentity } from "./external-identities";
import { createExternalIdentityBindingServices } from "./external-identity-bindings-storage-runtime";
import { createFileShareServices } from "./file-shares-storage-runtime";
import type {
  AutomationEventIngestionPayload,
  AutomationHookUnitOfWork,
  AutomationInternalHooks,
  AutomationRouteDispatchPayload,
} from "./internal-hooks";
import { createPackageInstallationServices } from "./package-installations-storage-runtime";
import { createAutomationProjectServices } from "./projects-storage-runtime";
import {
  buildRouteFailedEvent,
  createAutomationRouteDispatchServices,
  isRouteFailedEvent,
  readRouteDispatchState,
  recordMatchedRoute,
  routeDispatchId,
} from "./route-dispatches-storage-runtime";
import { dispatchAutomationRouteSchedule } from "./route-scheduling-runtime";
import {
  buildWorkflowEventPayload,
  evaluateAutomationEventMatcher,
  projectAutomationEventPayload,
  renderAutomationRawTemplateValue,
  renderAutomationScopeTemplate,
  renderAutomationTemplateValue,
  scheduledRouteUserId,
  type StarterAutomationRoutesSeedResult,
} from "./routing";
import { createAutomationRouteServices } from "./routing-storage-runtime";
import { automationFragmentSchema } from "./schema";

export type AutomationIngestResult = {
  accepted: boolean;
  eventId: string;
  scope: BackofficeContextScope;
  source: string;
  eventType: string;
};

const ALL_BUILT_IN_STARTER_AUTOMATION_ROUTE_IDS = SYSTEM_STARTER_AUTOMATION_ROUTES.map(
  (route) => route.id,
);

function getStarterAutomationRoutesForScope(ownerScope: BackofficeContextScope) {
  switch (ownerScope.kind) {
    case "system":
      return SYSTEM_STARTER_AUTOMATION_ROUTES;
    case "org":
    case "user":
    case "app":
    case "project":
      return [];
    default:
      throw new Error("Unsupported Backoffice context scope kind.", {
        cause: ownerScope satisfies never,
      });
  }
}

type AutomationWorkflowsServiceBase = WorkflowsFragmentServices;
type AutomationWorkflowsInstanceStatus = InstanceStatus;
export type AutomationWorkflowsService = Pick<
  AutomationWorkflowsServiceBase,
  "createInstance" | "getInstanceStatus" | "sendEvent"
> & {
  getInstanceStatusBatch?: (
    workflowName: string,
    instanceIds: string[],
  ) => TxResult<AutomationWorkflowsInstanceStatus[], AutomationWorkflowsInstanceStatus[]>;
};

export interface AutomationFragmentConfig {
  readAutomationSource?: AutomationSourceReader;
  builtInEventDefinitions: readonly (Pick<
    AutomationEventDefinition,
    "source" | "eventType" | "enabled" | "payloadSchema"
  > & {
    /** Shrinks the validated payload a stored event keeps; routes still see the whole payload. */
    storedPayload: ((payload: Record<string, unknown>) => Record<string, unknown>) | null;
  })[];
  env?: CloudflareEnv;
  runtime?: BackofficeRuntimeServices;
  ownerScope: BackofficeContextScope;
}

const buildIngestResult = (event: AutomationEvent): AutomationIngestResult => ({
  accepted: true,
  eventId: event.id,
  scope: event.scope,
  source: event.source,
  eventType: event.eventType,
});

type IngestAutomationEventOptions = {
  reclassificationChain?: readonly AutomationEventIdentity[];
  /**
   * A route already selected for this event. This bypasses normal event-trigger matching and
   * snapshots the route across the durable hook boundary, so an accepted scheduled run executes
   * the intended route even if it is later changed or deleted.
   */
  route?: AutomationRouteDefinition;
  /**
   * Shrinks the payload the stored event keeps, for deliveries whose body the receiving integration
   * retains. Routing reads the hook's copy of the event, so it still sees the whole payload.
   */
  storedPayload?: ((payload: Record<string, unknown>) => Record<string, unknown>) | null;
};

const ingestAutomationEvent = (
  uow: AutomationHookUnitOfWork,
  event: AutomationEvent,
  {
    reclassificationChain = [getAutomationEventIdentity(event)],
    route,
    storedPayload = null,
  }: IngestAutomationEventOptions = {},
) => {
  const now = uow.now();
  const actors = automationActorsSchema.parse(event.actors);
  const validatedEvent = { ...event, actors } satisfies AutomationEvent;
  const occurredAt = new Date(validatedEvent.occurredAt);
  if (Number.isNaN(occurredAt.getTime())) {
    throw new Error(`Automation event ${validatedEvent.id} has an invalid occurredAt timestamp.`);
  }

  uow.create("automation_event", {
    id: validatedEvent.id,
    scope: validatedEvent.scope,
    scopeRestriction: validatedEvent.scopeRestriction,
    source: validatedEvent.source,
    eventType: validatedEvent.eventType,
    occurredAt,
    payload:
      storedPayload === null ? validatedEvent.payload : storedPayload(validatedEvent.payload),
    actors: validatedEvent.actors,
    subject: validatedEvent.subject ?? null,
    causation: validatedEvent.causation,
    rootEventId: automationEventRootId(validatedEvent),
    routesMatched: false,
    createdAt: now,
  });

  uow.triggerHook(
    "internalIngestEvent",
    { event: validatedEvent, reclassificationChain, route },
    { id: validatedEvent.id },
  );
};

const toWorkflowIdentifier = (value: string) => value.replaceAll(":", "--");

export const buildAutomationWorkflowInstanceId = (eventId: string, bindingId: string) =>
  `${toWorkflowIdentifier(eventId)}--${toWorkflowIdentifier(bindingId)}`;

/**
 * Commits what a route did together with the service calls that did it, so a dispatch is only
 * recorded when its effect is.
 */
type CommitRouteDispatch = <TResult, TRetrieveSuccessResult = TResult>(
  outcome: AutomationRouteDispatchOutcome,
  effect: (() => TxResult<TResult, TRetrieveSuccessResult>) | null,
) => Promise<void>;

type RouteExecutionContext = {
  event: AutomationEvent;
  route: AutomationRouteDefinition;
  routingKey: string;
  workflows: AutomationWorkflowsService;
  commitDispatch: CommitRouteDispatch;
  /** The stored value under `routeStoredInstanceKey`, when the route reads one. */
  storedInstanceId: string | null;
  linkedUserId: string | null;
  /** The scope the route belongs to. */
  ownerScope: BackofficeContextScope;
};

const routeRoutingKey = (event: AutomationEvent, route: AutomationRouteDefinition) =>
  `${event.id}:${route.id}`;

/** The store entry holding a route's target workflow instance, when the route reads one. */
function routeStoredInstanceKey(
  event: AutomationEvent,
  route: AutomationRouteDefinition,
): string | null {
  const { action } = route;
  return action.kind === "send_workflow_event" && action.target.kind === "stored_instance_id"
    ? renderAutomationTemplateValue(
        action.target.keyTemplate,
        event,
        route.id,
        routeRoutingKey(event, route),
      )
    : null;
}

/**
 * The event an action with its own authority acts on, and the execution it runs as. Null when a
 * linked-user route receives an event from a sender with no linked user. Only the route's own action
 * acts for a derived principal; the event it received, and everything routed from it, does not.
 */
function routeActionExecution({
  authority,
  event,
  route,
  linkedUserId,
  ownerScope,
}: {
  authority: AutomationAuthorityMode;
  event: AutomationEvent;
  route: AutomationRouteDefinition;
  linkedUserId: string | null;
  ownerScope: BackofficeContextScope;
}): { event: AutomationEvent; execution: BackofficeExecutionContext } | null {
  const scheduledUserId = scheduledRouteUserId({
    ownerScope: event.scope,
    trigger: route.trigger,
    authority,
  });
  const actingEvent =
    authority.kind === "linked-user"
      ? linkedUserId &&
        event.actors.initiator.scope === "external" &&
        event.actors.principal === null
        ? linkAutomationEventToUser({ event, userId: linkedUserId })
        : null
      : scheduledUserId
        ? actForScheduledRouteUser({ event, userId: scheduledUserId })
        : event;
  if (!actingEvent) {
    return null;
  }
  return {
    event: actingEvent,
    execution:
      actingEvent.scope.kind === "system"
        ? createBackofficeSystemExecution(actingEvent.scope)
        : createAutomationRuntimeExecution({
            event: actingEvent,
            authority: automationRouteAuthority({
              routeId: route.id,
              routeScope: ownerScope,
              mode: authority,
            }),
          }),
  };
}

const handleStartWorkflowRouteAction = async ({
  action,
  event,
  route,
  routingKey,
  workflows,
  commitDispatch,
  config,
  linkedUserId,
  ownerScope,
}: RouteExecutionContext & {
  action: AutomationStartWorkflowAction;
  config: Pick<AutomationFragmentConfig, "readAutomationSource">;
}) => {
  const acting = routeActionExecution({
    authority: action.authority,
    event,
    route,
    linkedUserId,
    ownerScope,
  });
  if (!acting) {
    await commitDispatch({ kind: "skipped", reason: "no_linked_external_sender" }, null);
    return;
  }
  const { event: workflowEvent, execution } = acting;

  const instanceId = renderAutomationTemplateValue(
    action.instanceIdTemplate,
    workflowEvent,
    route.id,
    routingKey,
  );
  if (!config.readAutomationSource) {
    throw new Error("Automation workflow source reading is not configured.");
  }
  const readAutomationSource = config.readAutomationSource;
  const program = await readSavedWorkflowProgram({
    path: resolveAutomationScriptPath(action.workflowScriptPath),
    readFile: async (path) => await readAutomationSource({ execution, path }),
  });
  const prepared = prepareCodemodeWorkflowInstance({ program, instanceId });
  // A principal the route derived reaches the workflow with the route as its delegate.
  const triggerEvent =
    workflowEvent === event ? workflowEvent : { ...workflowEvent, actors: execution.actors };
  const workflowInput = createCodemodeWorkflowInstanceInput({
    prepared,
    trigger: { type: "event", event: triggerEvent },
    execution,
    replyTo: null,
  });

  await commitDispatch(
    {
      kind: "workflow_started",
      workflowName: workflowInput.workflowName,
      instanceId: workflowInput.instanceId,
    },
    () =>
      workflows.createInstance(workflowInput.workflowName, {
        id: workflowInput.instanceId,
        params: workflowInput.params,
        remoteWorkflowName: workflowInput.remoteWorkflowName,
      }),
  );
};

function namesRootOwner(
  reference: BackofficeRootOwnerReference,
  owner: BackofficeRootOwner<BackofficeScopeIdNames>,
): boolean {
  return reference.kind === "org"
    ? owner.kind === "org" && owner.orgId === reference.orgId
    : owner.kind === "user" && owner.userId === reference.userId;
}

const handleForwardEventRouteAction = async ({
  action,
  event,
  route,
  routingKey,
  commitDispatch,
  ownerScope,
  runtime,
}: RouteExecutionContext & {
  action: AutomationForwardEventAction;
  runtime: BackofficeRuntimeServices | undefined;
}) => {
  if (!runtime) {
    throw new Error("Forwarding automation events requires Backoffice runtime services.");
  }

  // A route reaches its own owner's scopes by ID; only other owners need Auth to find them.
  const routeOwner = backofficeScopeRootOwner(ownerScope);
  const scope = await renderAutomationScopeTemplate(
    action.targetScope,
    event,
    route.id,
    routingKey,
    async (owner) =>
      routeOwner && namesRootOwner(owner, routeOwner)
        ? routeOwner
        : await runtime.objects.auth.singleton().commands.findRootOwnerScope(owner),
  );

  const kernel = new BackofficeKernel(runtime);
  if (event.scopeRestriction && !backofficeScopeContains(event.scopeRestriction, scope)) {
    throw new BackofficeForbiddenError(
      "Forwarded event exceeds its retained scope ceiling.",
      "context-access-denied",
    );
  }
  await kernel.assertScopeAllowedByOwner({
    ownerScope,
    targetScope: scope,
    operation: "automation.forward-event",
  });

  const forwardedEvent = {
    ...event,
    id: action.idTemplate
      ? renderAutomationRawTemplateValue(action.idTemplate, event, route.id, routingKey)
      : event.id,
    scope,
    causation: { kind: "route", routeId: route.id, parent: automationEventParentOf(event) },
  } satisfies AutomationEvent;

  const targetAutomations = runtime.objects.automations.for(scope);
  if (scope.kind === "system") {
    await targetAutomations.commands.seedStarterAutomationRoutes();
  }
  await targetAutomations.commands.ingestEvent(forwardedEvent);
  // The forwarded event lives in another scope's object, so this commit cannot include it. A
  // failure here replays the forward, which the target ignores once it holds the event.
  await commitDispatch({ kind: "event_forwarded", eventId: forwardedEvent.id, scope }, null);
};

const handleNotifyAgentRouteAction = async ({
  action,
  event,
  route,
  commitDispatch,
  linkedUserId,
  ownerScope,
  runtime,
}: RouteExecutionContext & {
  action: AutomationNotifyAgentAction;
  runtime: BackofficeRuntimeServices | undefined;
}) => {
  if (!runtime) {
    throw new Error("Notifying agents requires Backoffice runtime services.");
  }
  const acting = routeActionExecution({
    authority: action.authority,
    event,
    route,
    linkedUserId,
    ownerScope,
  });
  if (!acting) {
    await commitDispatch({ kind: "skipped", reason: "no_linked_external_sender" }, null);
    return;
  }
  // Everything an agent's turns produce, reclassified or forwarded too, keeps the agent as a
  // delegate. Never delivering such an event to that agent means no route can make an agent wake
  // itself forever.
  const agent = piAgentActor(acting.execution.scope, action.agentName);
  if (event.actors.delegation.some((actor) => automationEntityRefsEqual(actor, agent))) {
    await commitDispatch({ kind: "skipped", reason: "caused_by_notified_agent" }, null);
    return;
  }
  await createPiManagerRuntime({
    runtime,
    kernel: new BackofficeKernel(runtime),
    execution: acting.execution,
    caller: { kind: "none" },
  }).notifyAgent({
    agentName: action.agentName,
    routeId: route.id,
    event: piAgentNotificationEvent(acting.event),
  });
  // The agent's queue lives in the Pi manager's object, so this commit cannot include the
  // notification. A failure here replays the notification, as any failed route does.
  await commitDispatch({ kind: "agent_notified", agentName: action.agentName }, null);
};

const MAX_AUTOMATION_EVENT_RECLASSIFICATION_CHAIN_LENGTH = 32;

/** A reclassification that would cycle or chain too long; retrying the route cannot change it. */
class AutomationEventReclassificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AutomationEventReclassificationError";
  }
}

function appendAutomationEventReclassificationIdentity(
  chain: readonly AutomationEventIdentity[],
  target: AutomationEventIdentity,
): readonly AutomationEventIdentity[] {
  if (
    chain.some(
      (identity) => identity.source === target.source && identity.eventType === target.eventType,
    )
  ) {
    throw new AutomationEventReclassificationError(
      `AUTOMATION_EVENT_RECLASSIFICATION_CYCLE: ${target.source}/${target.eventType}`,
    );
  }
  if (chain.length >= MAX_AUTOMATION_EVENT_RECLASSIFICATION_CHAIN_LENGTH) {
    throw new AutomationEventReclassificationError(
      `AUTOMATION_EVENT_RECLASSIFICATION_CHAIN_LIMIT: maximum length ${MAX_AUTOMATION_EVENT_RECLASSIFICATION_CHAIN_LENGTH}`,
    );
  }
  return [...chain, target];
}

function buildReclassifiedAutomationEvent({
  action,
  event,
  routeId,
}: {
  action: AutomationReclassifyEventAction;
  event: AutomationEvent;
  routeId: string;
}): AutomationEvent {
  return {
    ...event,
    id: `reclassified:${routeId}:${event.id}`,
    source: action.source,
    eventType: action.eventType,
    payload: projectAutomationEventPayload(event, action.payload),
    causation: { kind: "route", routeId, parent: automationEventParentOf(event) },
  };
}

const handleSendWorkflowEventRouteAction = async ({
  action,
  event,
  route,
  routingKey,
  workflows,
  commitDispatch,
  storedInstanceId,
}: RouteExecutionContext & { action: AutomationSendWorkflowEventAction }) => {
  const instanceId =
    action.target.kind === "instance_id"
      ? renderAutomationTemplateValue(action.target.template, event, route.id, routingKey)
      : (storedInstanceId ?? "");

  if (!instanceId) {
    await commitDispatch({ kind: "skipped", reason: "workflow_instance_unresolved" }, null);
    return;
  }

  try {
    await commitDispatch(
      {
        kind: "workflow_event_sent",
        workflowName: CODEMODE_WORKFLOW,
        instanceId,
        eventType: action.eventType,
      },
      () =>
        workflows.sendEvent(CODEMODE_WORKFLOW, instanceId, {
          id: `${route.id}:${event.id}`,
          type: action.eventType,
          payload: buildWorkflowEventPayload({ action, event }),
        }),
    );
  } catch (error) {
    if (isWorkflowRunFinishedError(error)) {
      throw new AutomationWorkflowRunFinishedError(instanceId, { cause: error });
    }
    throw error;
  }
};

/** The workflows service rejects an event for a run that already finished with this message. */
function isWorkflowRunFinishedError(error: unknown): boolean {
  return error instanceof Error && error.message === "INSTANCE_TERMINAL";
}

/** A replayed route that already failed for good, with the error it failed on. */
class AutomationRouteFailedError extends Error {
  constructor(error: string) {
    super(error);
    this.name = "AutomationRouteFailedError";
  }
}

/** A finished workflow run never takes another event, so no retry can deliver one to it. */
class AutomationWorkflowRunFinishedError extends Error {
  constructor(instanceId: string, options?: ErrorOptions) {
    super(
      `Workflow run ${instanceId} has finished, so it can no longer receive events (INSTANCE_TERMINAL).`,
      options,
    );
    this.name = "AutomationWorkflowRunFinishedError";
  }
}

/**
 * Errors no retry can fix fail a route at once: invalid events, reclassification cycles, denied
 * access, missing targets, and workflow runs that finished. Anything else may be a dependency that
 * is restarting. Errors that crossed an object boundary lost their class and are retried, except a
 * finished run, which is known by its message.
 */
function isRetryableRouteError(error: unknown): boolean {
  if (
    error instanceof AutomationRouteFailedError ||
    error instanceof AutomationWorkflowRunFinishedError ||
    isWorkflowRunFinishedError(error)
  ) {
    return false;
  }
  if (error instanceof BackofficeForbiddenError) {
    return error.reason === "authority-unavailable";
  }
  if (error instanceof BackofficeOperationError) {
    return error.kind === "conflict" || error.kind === "operation_failed";
  }
  return !(
    error instanceof AutomationEventDefinitionValidationError ||
    error instanceof AutomationEventReclassificationError
  );
}

const routeDispatchRetryPolicy: DurableHookRetryPolicy = {
  ...defaultDurableHookRetryPolicy,
  isRetryable: isRetryableRouteError,
};

export const automationFragmentDefinition = defineFragment<AutomationFragmentConfig>("automations")
  .extend(withDatabase(automationFragmentSchema))
  .usesService<"workflows", AutomationWorkflowsService>("workflows")
  .providesBaseService(({ defineService, config }) => {
    const builtInEventDefinitionsById = new Map(
      config.builtInEventDefinitions.map((definition) => [
        buildAutomationEventDefinitionId(definition.source, definition.eventType),
        definition,
      ]),
    );
    const storeServices = createAutomationStoreServices(defineService);
    const projectServices = createAutomationProjectServices(defineService, {
      ownerScope: config.ownerScope,
    });
    const routeServices = createAutomationRouteServices(defineService, {
      ownerScope: config.ownerScope,
    });
    const eventServices = createAutomationEventServices(defineService);
    const eventSourceServices = createAutomationEventSourceServices(defineService);
    const eventDefinitionServices = createAutomationEventDefinitionServices(defineService);
    const externalIdentityBindingServices = createExternalIdentityBindingServices(defineService);
    const routeDispatchServices = createAutomationRouteDispatchServices(defineService);
    const packageInstallationServices = createPackageInstallationServices(defineService);
    const fileShareServices = createFileShareServices(defineService);

    return defineService({
      ...storeServices,
      ...projectServices,
      ...routeServices,
      ...eventServices,
      ...eventSourceServices,
      ...eventDefinitionServices,
      ...externalIdentityBindingServices,
      ...routeDispatchServices,
      ...packageInstallationServices,
      ...fileShareServices,
      seedStarterAutomationRoutes: function () {
        return this.serviceTx(automationFragmentSchema)
          .retrieve((uow) =>
            uow
              .find("automation_route", (b) => b.whereIndex("primary"))
              .find("automation_route_schedule_state", (b) => b.whereIndex("primary")),
          )
          .mutate(
            ({
              uow,
              retrieveResult: [existingRoutes, existingScheduleStates],
            }): StarterAutomationRoutesSeedResult => {
              const scopedStarterRoutes = getStarterAutomationRoutesForScope(config.ownerScope);
              const scopedStarterRouteIds = new Set(scopedStarterRoutes.map((route) => route.id));
              const allStarterRouteIds = new Set(ALL_BUILT_IN_STARTER_AUTOMATION_ROUTE_IDS);
              const scheduleStatesByRouteId = new Map(
                existingScheduleStates.map((state) => [state.id.externalId, state]),
              );
              const existingIds = new Set(existingRoutes.map((route) => route.id.externalId));
              const created: string[] = [];
              const removed: string[] = [];
              const skipped: string[] = [];

              for (const existingRoute of existingRoutes) {
                const routeId = existingRoute.id.externalId;
                if (!allStarterRouteIds.has(routeId) || scopedStarterRouteIds.has(routeId)) {
                  continue;
                }

                const scheduleState = scheduleStatesByRouteId.get(routeId);
                if (scheduleState) {
                  uow.delete("automation_route_schedule_state", scheduleState.id, (b) => b.check());
                }
                uow.delete("automation_route", existingRoute.id, (b) => b.check());
                removed.push(routeId);
              }

              for (const route of scopedStarterRoutes) {
                if (existingIds.has(route.id)) {
                  skipped.push(route.id);
                  continue;
                }

                uow.create("automation_route", {
                  id: route.id,
                  name: route.name,
                  enabled: route.enabled,
                  priority: route.priority,
                  trigger: route.trigger,
                  action: route.action,
                  description: route.description ?? null,
                  metadata: null,
                  createdAt: uow.now(),
                  updatedAt: uow.now(),
                });
                if (route.trigger.kind === "schedule") {
                  uow.create("automation_route_schedule_state", {
                    id: route.id,
                    initializationAt: route.enabled ? uow.now() : null,
                    nextOccurrenceAt: null,
                  });
                  if (route.enabled) {
                    uow.triggerHook(
                      "internalDispatchRouteSchedule",
                      { kind: "initialize", routeId: route.id },
                      { processAt: uow.now() },
                    );
                  }
                }
                created.push(route.id);
              }

              return { created, removed, skipped };
            },
          )
          .build();
      },
      ingestEvent: function (
        event: AutomationEvent,
        reclassificationChain: readonly AutomationEventIdentity[] = [
          getAutomationEventIdentity(event),
        ],
      ) {
        return this.serviceTx(automationFragmentSchema, { name: "automations.ingestEvent" })
          .retrieve((uow) =>
            uow
              .findFirst("automation_event_definition", (b) =>
                b.whereIndex("primary", (eb) =>
                  eb("id", "=", buildAutomationEventDefinitionId(event.source, event.eventType)),
                ),
              )
              .findFirst("automation_event", (b) =>
                b.whereIndex("primary", (eb) => eb("id", "=", event.id)),
              ),
          )
          .mutate(({ uow, retrieveResult: [storedDefinition, existingEvent] }) => {
            if (existingEvent) {
              return;
            }
            const builtInDefinition = builtInEventDefinitionsById.get(
              buildAutomationEventDefinitionId(event.source, event.eventType),
            );
            const definition = builtInDefinition ?? storedDefinition;
            validateAutomationEventPayload({ event, definition });
            ingestAutomationEvent(uow as AutomationHookUnitOfWork, event, {
              reclassificationChain,
              storedPayload: builtInDefinition?.storedPayload ?? null,
            });
          })
          .transform(() => buildIngestResult(event))
          .build();
      },
    });
  })
  .provideHooks(({ defineHook, services, serviceDeps, config }) => {
    return {
      internalDispatchRouteSchedule: defineHook(async function (payload) {
        await dispatchAutomationRouteSchedule({
          payload,
          hookCreatedAt: this.createdAt,
          ownerScope: config.ownerScope,
          ingestEvent: ingestAutomationEvent,
          handlerTx: this.handlerTx.bind(this),
        });
      }),
      /**
       * Matches an event to routes and hands each matched route a hook of its own, so a route that
       * fails retries alone and its siblings neither wait for it nor act again.
       */
      internalIngestEvent: defineHook(async function ({
        event,
        reclassificationChain,
        route,
      }: AutomationEventIngestionPayload) {
        const handlerTx: DatabaseHandlerTx<AutomationInternalHooks> = this.handlerTx.bind(this);
        await handlerTx({ name: "automations.internalIngestEvent" })
          .retrieve(({ forSchema }) =>
            forSchema(automationFragmentSchema)
              .find("automation_route", (b) =>
                b.whereIndex("primary").orderByIndex("idx_automation_route_priority_id", "asc"),
              )
              .find("automation_route_dispatch", (b) =>
                b.whereIndex("idx_automation_route_dispatch_eventId", (eb) =>
                  eb("eventId", "=", event.id),
                ),
              )
              .findFirst("automation_event", (b) =>
                b.whereIndex("primary", (eb) => eb("id", "=", event.id)),
              ),
          )
          .mutate(({ forSchema, retrieveResult: [routeRows, dispatchRows, storedEvent] }) => {
            const uow = forSchema(automationFragmentSchema);
            // Project lifecycle events are matched without being stored.
            if (storedEvent && !storedEvent.routesMatched) {
              uow.update("automation_event", storedEvent.id, (b) =>
                b.set({ routesMatched: true }).check(),
              );
            }
            const matchedRoutes = route
              ? [route]
              : routeRows
                  .map(
                    (row) =>
                      ({
                        id: row.id.externalId,
                        name: row.name,
                        enabled: row.enabled,
                        priority: row.priority,
                        trigger: row.trigger,
                        action: row.action,
                        description: row.description,
                        nextOccurrenceAt: null,
                      }) as AutomationRouteDefinition,
                  )
                  .filter(
                    (candidate) =>
                      candidate.enabled &&
                      candidate.trigger.kind === "event" &&
                      (candidate.trigger.source === event.source ||
                        candidate.trigger.source === "*") &&
                      (candidate.trigger.eventType === event.eventType ||
                        candidate.trigger.eventType === "*") &&
                      evaluateAutomationEventMatcher(candidate.trigger.matcher, event),
                  );
            // A replayed match, whose first commit landed before its hook completed, finds the
            // routes it recorded then.
            const recordedRouteIds = new Set(dispatchRows.map((dispatch) => dispatch.routeId));
            for (const matched of matchedRoutes) {
              if (recordedRouteIds.has(matched.id)) {
                continue;
              }
              recordMatchedRoute(uow, { event, route: matched });
              uow.triggerHook(
                "internalDispatchRoute",
                { event, route: matched, reclassificationChain },
                // Named after the dispatch, so a failed route can find its hook to retry it.
                { id: routeDispatchId({ eventId: event.id, routeId: matched.id }) },
              );
            }
          })
          .execute();
      }),
      internalDispatchRoute: defineHook(
        async function ({ event, route, reclassificationChain }: AutomationRouteDispatchPayload) {
          const subject = { event, route };
          try {
            const externalIdentityBindingId =
              event.actors.initiator.scope === "external" &&
              canLinkExternalIdentity(event.actors.initiator)
                ? buildExternalIdentityBindingId(event.actors.initiator)
                : "";
            const storedInstanceKey = routeStoredInstanceKey(event, route);
            const { recorded, storedInstanceId, linkedUserId } = await this.handlerTx({
              name: "automations.internalDispatchRoute",
            })
              .retrieve(({ forSchema }) =>
                forSchema(automationFragmentSchema)
                  .findFirst("automation_route_dispatch", (b) =>
                    b.whereIndex("primary", (eb) =>
                      eb("id", "=", routeDispatchId({ eventId: event.id, routeId: route.id })),
                    ),
                  )
                  .findFirst("kv_store", (b) =>
                    b.whereIndex("idx_kv_store_key", (eb) =>
                      eb("key", "=", storedInstanceKey ?? ""),
                    ),
                  )
                  .findFirst("external_identity_binding", (b) =>
                    b.whereIndex("primary", (eb) => eb("id", "=", externalIdentityBindingId)),
                  ),
              )
              .transformRetrieve(([dispatch, storedInstance, externalIdentityBinding]) => ({
                recorded: dispatch ? readRouteDispatchState(dispatch) : null,
                storedInstanceId:
                  storedInstanceKey === null ? null : (storedInstance?.value ?? null),
                linkedUserId:
                  externalIdentityBinding?.revokedAt === null
                    ? externalIdentityBinding.userId
                    : null,
              }))
              .execute();
            // A replay finds the state the route settled with first. One that failed fails its hook
            // again, so a hook that stopped after recording the failure can still be retried.
            if (recorded?.status === "failed") {
              throw new AutomationRouteFailedError(recorded.error);
            }
            if (recorded?.status === "completed") {
              return;
            }

            const commitDispatch: CommitRouteDispatch = async (outcome, effect) => {
              const record = () =>
                services.updateRouteDispatch({
                  ...subject,
                  // Each attempt before this one threw.
                  state: { status: "completed", outcome, failedAttempts: this.attempts },
                });
              await (
                effect === null
                  ? this.handlerTx().withServiceCalls(() => [record()] as const)
                  : this.handlerTx().withServiceCalls(() => [effect(), record()] as const)
              ).execute();
            };
            const context = {
              event,
              route,
              routingKey: routeRoutingKey(event, route),
              workflows: serviceDeps.workflows,
              commitDispatch,
              storedInstanceId,
              linkedUserId,
              ownerScope: config.ownerScope,
            };
            const action = route.action;
            switch (action.kind) {
              case "start_workflow":
                await handleStartWorkflowRouteAction({ ...context, action, config });
                break;

              case "send_workflow_event":
                await handleSendWorkflowEventRouteAction({ ...context, action });
                break;

              case "forward_event":
                await handleForwardEventRouteAction({
                  ...context,
                  action,
                  runtime: config.runtime,
                });
                break;

              case "notify_agent":
                await handleNotifyAgentRouteAction({
                  ...context,
                  action,
                  runtime: config.runtime,
                });
                break;

              case "reclassify_event": {
                const reclassifiedEvent = buildReclassifiedAutomationEvent({
                  action,
                  event,
                  routeId: route.id,
                });
                const nextReclassificationChain = appendAutomationEventReclassificationIdentity(
                  reclassificationChain,
                  getAutomationEventIdentity(reclassifiedEvent),
                );
                await commitDispatch(
                  { kind: "event_reclassified", eventId: reclassifiedEvent.id },
                  () => services.ingestEvent(reclassifiedEvent, nextReclassificationChain),
                );
                break;
              }
            }
          } catch (error) {
            // The processor gives up under the same rule, so `failed` is recorded on the last attempt.
            const failedAttempts = this.attempts + 1;
            const exhausted =
              failedAttempts >= this.maxAttempts || !routeDispatchRetryPolicy.isRetryable(error);
            const message = error instanceof Error ? error.message : String(error);
            const handlerTx: DatabaseHandlerTx<AutomationInternalHooks> = this.handlerTx.bind(this);
            await handlerTx()
              .withServiceCalls(
                () =>
                  [
                    services.updateRouteDispatch({
                      ...subject,
                      state: {
                        status: exhausted ? "failed" : "retrying",
                        failedAttempts,
                        error: message,
                      },
                    }),
                  ] as const,
              )
              .mutate(({ forSchema, serviceIntermediateResult: [update] }) => {
                // A route that fails on an announcement, or on an event reclassified from one,
                // announces nothing, so failures cannot feed each other.
                if (
                  !exhausted ||
                  !update.settles ||
                  isRouteFailedEvent(event) ||
                  reclassificationChain.some(isRouteFailedEvent)
                ) {
                  return;
                }
                ingestAutomationEvent(
                  forSchema(automationFragmentSchema),
                  buildRouteFailedEvent({ event, route, failedAttempts, error: message }),
                );
              })
              .execute();
            throw error;
          }
        },
        { retryPolicy: routeDispatchRetryPolicy },
      ),
    };
  })
  .build();
