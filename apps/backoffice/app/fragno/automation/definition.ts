import type { InstanceStatus } from "@fragno-dev/workflows/workflow";

import { defineFragment } from "@fragno-dev/core";
import { withDatabase, type TxResult } from "@fragno-dev/db";
import type { WorkflowsFragmentServices } from "@fragno-dev/workflows";

import {
  createBackofficeSystemExecution,
  type BackofficeContextScope,
  type BackofficeExecutionContext,
} from "@/backoffice-runtime/context";
import { BackofficeKernel } from "@/backoffice-runtime/kernel";
import type { BackofficeRuntimeServices } from "@/backoffice-runtime/runtime-services";
import type { SandboxRuntimeProvider } from "@/sandbox/contracts";

import { automationActorsSchema } from "./actors";
import {
  automationRouteAuthority,
  createAutomationRuntimeExecution,
  linkAutomationEventToUser,
} from "./authority";
import { createAutomationStoreServices } from "./bindings-storage-runtime";
import { resolveAutomationFileSystem, type AutomationFileSystemConfig } from "./catalog";
import {
  ORGANIZATION_STARTER_AUTOMATION_ROUTES,
  SYSTEM_STARTER_AUTOMATION_ROUTES,
} from "./content/starter-routing";
import {
  getAutomationEventIdentity,
  type AutomationEvent,
  type AutomationEventIdentity,
} from "./contracts";
import {
  CODEMODE_WORKFLOW,
  createCodemodeWorkflowInstanceInput,
  prepareCodemodeWorkflowInstance,
} from "./engine/codemode-invocation";
import { type AutomationPiBashContext } from "./engine/runtime";
import {
  buildAutomationEventDefinitionId,
  validateAutomationEventPayload,
  type AutomationEventDefinition,
} from "./event-definitions";
import { createAutomationEventDefinitionServices } from "./event-definitions-storage-runtime";
import { createAutomationEventSourceServices } from "./event-sources-storage-runtime";
import { createAutomationEventServices } from "./events-storage-runtime";
import { buildExternalIdentityBindingId } from "./external-identities";
import { createExternalIdentityBindingServices } from "./external-identity-bindings-storage-runtime";
import type { AutomationEventIngestionPayload, AutomationHookUnitOfWork } from "./internal-hooks";
import { createAutomationMarketplaceIngestionServices } from "./marketplace-ingestions";
import { createAutomationProjectServices } from "./projects-storage-runtime";
import { dispatchAutomationRouteSchedule } from "./route-scheduling-runtime";
import {
  buildWorkflowEventPayload,
  evaluateAutomationEventMatcher,
  projectAutomationEventPayload,
  renderAutomationRawTemplateValue,
  renderAutomationScopeTemplate,
  renderAutomationTemplateValue,
  type AutomationForwardEventAction,
  type AutomationReclassifyEventAction,
  type AutomationRouteDefinition,
  type AutomationSendWorkflowEventAction,
  type AutomationStartWorkflowAction,
  type StarterAutomationRoutesSeedResult,
} from "./routing";
import { createAutomationRouteServices } from "./routing-storage-runtime";
import { createAutomationSandboxServices } from "./sandboxes-storage-runtime";
import { automationFragmentSchema } from "./schema";

export type AutomationIngestResult = {
  accepted: boolean;
  eventId: string;
  scope: BackofficeContextScope;
  source: string;
  eventType: string;
};

const ALL_BUILT_IN_STARTER_AUTOMATION_ROUTES = [
  ...SYSTEM_STARTER_AUTOMATION_ROUTES,
  ...ORGANIZATION_STARTER_AUTOMATION_ROUTES,
];

function getStarterAutomationRoutesForScope(ownerScope: BackofficeContextScope) {
  switch (ownerScope.kind) {
    case "system":
      return SYSTEM_STARTER_AUTOMATION_ROUTES;
    case "org":
      return ORGANIZATION_STARTER_AUTOMATION_ROUTES;
    case "project":
    case "user":
      return [];
  }

  throw new Error("Unsupported Backoffice context scope kind.");
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

export interface AutomationFragmentConfig extends AutomationFileSystemConfig {
  builtInEventDefinitions: readonly Pick<
    AutomationEventDefinition,
    "source" | "eventType" | "enabled" | "payloadSchema"
  >[];
  env?: CloudflareEnv;
  runtime?: BackofficeRuntimeServices;
  ownerScope: BackofficeContextScope;
  sandboxProviders?: Record<string, SandboxRuntimeProvider>;
  createPiAutomationContext?: (input: {
    event: AutomationEvent;
    execution: BackofficeExecutionContext;
    idempotencyKey: string;
  }) => Promise<AutomationPiBashContext | undefined> | AutomationPiBashContext | undefined;
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
};

const ingestAutomationEvent = (
  uow: AutomationHookUnitOfWork,
  event: AutomationEvent,
  {
    reclassificationChain = [getAutomationEventIdentity(event)],
    route,
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
    source: validatedEvent.source,
    eventType: validatedEvent.eventType,
    occurredAt,
    payload: validatedEvent.payload,
    actors: validatedEvent.actors,
    subject: validatedEvent.subject ?? null,
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

type RunWorkflowServiceCall = <TResult, TRetrieveSuccessResult = TResult>(
  call: () => readonly [TxResult<TResult, TRetrieveSuccessResult>],
) => Promise<void>;

type AutomationStoreSnapshot = ReadonlyMap<string, string>;

type RouteExecutionContext = {
  event: AutomationEvent;
  route: AutomationRouteDefinition;
  routingKey: string;
  workflows: AutomationWorkflowsService;
  runWorkflowServiceCall: RunWorkflowServiceCall;
  store: AutomationStoreSnapshot;
  linkedUserId: string | null;
};

const routeRoutingKey = (event: AutomationEvent, route: AutomationRouteDefinition) =>
  `${event.id}:${route.id}`;

const handleStartWorkflowRouteAction = async ({
  action,
  event,
  route,
  routingKey,
  workflows,
  runWorkflowServiceCall,
  config,
  linkedUserId,
}: RouteExecutionContext & {
  action: AutomationStartWorkflowAction;
  config: AutomationFileSystemConfig;
}) => {
  const workflowEvent =
    action.authority.kind === "linked-user"
      ? linkedUserId &&
        event.actors.initiator.scope === "external" &&
        event.actors.principal === null
        ? linkAutomationEventToUser({ event, userId: linkedUserId })
        : null
      : event;
  if (!workflowEvent) {
    return;
  }

  const instanceId = renderAutomationTemplateValue(
    action.instanceIdTemplate,
    workflowEvent,
    route.id,
    routingKey,
  );
  const execution =
    workflowEvent.scope.kind === "system"
      ? createBackofficeSystemExecution(workflowEvent.scope)
      : createAutomationRuntimeExecution({
          event: workflowEvent,
          authority: automationRouteAuthority({ routeId: route.id, mode: action.authority }),
        });
  const fileSystem = await resolveAutomationFileSystem(config, {
    execution,
    purpose: "runtime",
  });
  const code = await fileSystem.readFile(action.workflowScriptPath, "utf-8");
  const prepared = prepareCodemodeWorkflowInstance({
    code,
    filename: action.workflowScriptPath,
    instanceId,
  });
  const triggerEvent =
    action.authority.kind === "linked-user"
      ? { ...workflowEvent, actors: execution.actors }
      : workflowEvent;
  const workflowInput = createCodemodeWorkflowInstanceInput({
    prepared,
    trigger: { type: "event", event: triggerEvent },
    execution,
  });

  await runWorkflowServiceCall(
    () =>
      [
        workflows.createInstance(workflowInput.workflowName, {
          id: workflowInput.instanceId,
          params: workflowInput.params,
          remoteWorkflowName: workflowInput.remoteWorkflowName,
        }),
      ] as const,
  );
};

const handleForwardEventRouteAction = async ({
  action,
  event,
  route,
  routingKey,
  ownerScope,
  runtime,
}: RouteExecutionContext & {
  action: AutomationForwardEventAction;
  ownerScope: BackofficeContextScope;
  runtime: BackofficeRuntimeServices | undefined;
}) => {
  if (!runtime) {
    throw new Error("Forwarding automation events requires Backoffice runtime services.");
  }

  const scope = renderAutomationScopeTemplate(action.targetScope, event, route.id, routingKey);
  if (scope.kind === "org" && !scope.orgId) {
    throw new Error(`Automation route ${route.id} resolved an empty target org id.`);
  }
  if (scope.kind === "project" && (!scope.orgId || !scope.projectId)) {
    throw new Error(`Automation route ${route.id} resolved an empty target project scope.`);
  }
  if (scope.kind === "user" && !scope.userId) {
    throw new Error(`Automation route ${route.id} resolved an empty target user id.`);
  }

  await new BackofficeKernel(runtime).assertScopeAllowedByOwner({
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
  } satisfies AutomationEvent;

  const targetAutomations = runtime.objects.automations.for(scope);
  if (scope.kind === "system") {
    await targetAutomations.commands.seedStarterAutomationRoutes();
  }
  await targetAutomations.commands.ingestEvent(forwardedEvent);
};

const MAX_AUTOMATION_EVENT_RECLASSIFICATION_CHAIN_LENGTH = 32;

function appendAutomationEventReclassificationIdentity(
  chain: readonly AutomationEventIdentity[],
  target: AutomationEventIdentity,
): readonly AutomationEventIdentity[] {
  if (
    chain.some(
      (identity) => identity.source === target.source && identity.eventType === target.eventType,
    )
  ) {
    throw new Error(
      `AUTOMATION_EVENT_RECLASSIFICATION_CYCLE: ${target.source}/${target.eventType}`,
    );
  }
  if (chain.length >= MAX_AUTOMATION_EVENT_RECLASSIFICATION_CHAIN_LENGTH) {
    throw new Error(
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
  };
}

const handleSendWorkflowEventRouteAction = async ({
  action,
  event,
  route,
  routingKey,
  workflows,
  runWorkflowServiceCall,
  store,
}: RouteExecutionContext & { action: AutomationSendWorkflowEventAction }) => {
  let instanceId = "";
  switch (action.target.kind) {
    case "instance_id":
      instanceId = renderAutomationTemplateValue(
        action.target.template,
        event,
        route.id,
        routingKey,
      );
      break;

    case "stored_instance_id": {
      const storeKey = renderAutomationTemplateValue(
        action.target.keyTemplate,
        event,
        route.id,
        routingKey,
      );
      instanceId = store.get(storeKey) ?? "";
      break;
    }
  }

  if (!instanceId) {
    return;
  }

  await runWorkflowServiceCall(
    () =>
      [
        workflows.sendEvent(CODEMODE_WORKFLOW, instanceId, {
          id: `${route.id}:${event.id}`,
          type: action.eventType,
          payload: buildWorkflowEventPayload({ action, event }),
        }),
      ] as const,
  );
};

export const automationFragmentDefinition = defineFragment<AutomationFragmentConfig>("automations")
  .extend(withDatabase(automationFragmentSchema))
  .usesService<"workflows", AutomationWorkflowsService>("workflows")
  .providesBaseService(({ defineService, config, serviceDeps }) => {
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
    const sandboxServices = createAutomationSandboxServices(defineService, {
      workflows: serviceDeps.workflows,
      ownerScope: config.ownerScope,
      sandboxProviders: config.sandboxProviders,
      ingestEvent: ingestAutomationEvent,
    });
    const routeServices = createAutomationRouteServices(defineService);
    const eventServices = createAutomationEventServices(defineService);
    const eventSourceServices = createAutomationEventSourceServices(defineService);
    const eventDefinitionServices = createAutomationEventDefinitionServices(defineService);
    const marketplaceIngestionServices =
      createAutomationMarketplaceIngestionServices(defineService);
    const externalIdentityBindingServices = createExternalIdentityBindingServices(defineService);

    return defineService({
      ...storeServices,
      ...projectServices,
      ...sandboxServices,
      ...routeServices,
      ...eventServices,
      ...eventSourceServices,
      ...eventDefinitionServices,
      ...marketplaceIngestionServices,
      ...externalIdentityBindingServices,
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
              const allStarterRouteIds = new Set(
                ALL_BUILT_IN_STARTER_AUTOMATION_ROUTES.map((route) => route.id),
              );
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
            const definition =
              builtInEventDefinitionsById.get(
                buildAutomationEventDefinitionId(event.source, event.eventType),
              ) ?? storedDefinition;
            validateAutomationEventPayload({ event, definition });
            ingestAutomationEvent(uow as AutomationHookUnitOfWork, event, {
              reclassificationChain,
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
      internalIngestEvent: defineHook(async function (payload: AutomationEventIngestionPayload) {
        const event = payload.event;
        const externalIdentityBindingId =
          event.actors.initiator.scope === "external"
            ? buildExternalIdentityBindingId(event.actors.initiator)
            : "";
        const { routes, store, linkedUserId } = await this.handlerTx({
          name: "automations.internalIngestEvent",
        })
          .retrieve(({ forSchema }) => {
            const uow = forSchema(automationFragmentSchema);
            return uow
              .find("automation_route", (b) =>
                b.whereIndex("primary").orderByIndex("idx_automation_route_priority_id", "asc"),
              )
              .find("kv_store", (b) => b.whereIndex("primary"))
              .findFirst("external_identity_binding", (b) =>
                b.whereIndex("primary", (eb) => eb("id", "=", externalIdentityBindingId)),
              );
          })
          .transformRetrieve(([routeRows, storeRows, externalIdentityBinding]) => ({
            routes: routeRows.map((route) => ({
              id: route.id.externalId,
              name: route.name,
              enabled: route.enabled,
              priority: route.priority,
              trigger: route.trigger,
              action: route.action,
              description: route.description,
              nextOccurrenceAt: null,
            })),
            store: new Map(storeRows.map((entry) => [entry.key, entry.value])),
            linkedUserId:
              externalIdentityBinding?.revokedAt === null ? externalIdentityBinding.userId : null,
          }))
          .execute();
        const routesToExecute = payload.route
          ? [payload.route]
          : routes.filter(
              (route) =>
                route.enabled &&
                route.trigger.kind === "event" &&
                (route.trigger.source === event.source || route.trigger.source === "*") &&
                (route.trigger.eventType === event.eventType || route.trigger.eventType === "*") &&
                evaluateAutomationEventMatcher(route.trigger.matcher, event),
            );
        const runWorkflowServiceCall: RunWorkflowServiceCall = async (call) => {
          await this.handlerTx().withServiceCalls(call).execute();
        };
        const results = await Promise.allSettled(
          routesToExecute.map(async (route) => {
            const context = {
              event,
              route,
              routingKey: routeRoutingKey(event, route),
              workflows: serviceDeps.workflows,
              runWorkflowServiceCall,
              store,
              linkedUserId,
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
                  ownerScope: config.ownerScope,
                  runtime: config.runtime,
                });
                break;

              case "reclassify_event": {
                const reclassifiedEvent = buildReclassifiedAutomationEvent({
                  action,
                  event,
                  routeId: route.id,
                });
                const reclassificationChain = appendAutomationEventReclassificationIdentity(
                  payload.reclassificationChain,
                  getAutomationEventIdentity(reclassifiedEvent),
                );
                await this.handlerTx()
                  .withServiceCalls(
                    () => [services.ingestEvent(reclassifiedEvent, reclassificationChain)] as const,
                  )
                  .execute();
                break;
              }
            }
          }),
        );
        const failures = results.flatMap((result, index) =>
          result.status === "rejected"
            ? [{ route: routesToExecute[index], cause: result.reason }]
            : [],
        );
        if (failures.length === 1) {
          const cause = failures[0].cause;
          throw cause instanceof Error ? cause : new Error(String(cause));
        }
        if (failures.length > 1) {
          throw new AggregateError(
            failures.map(
              ({ route, cause }) =>
                new Error(
                  `Automation route ${route.id} failed: ${cause instanceof Error ? cause.message : String(cause)}`,
                  { cause },
                ),
            ),
            `Automation event ${event.id} failed for routes: ${failures.map(({ route }) => route.id).join(", ")}`,
          );
        }
      }),
    };
  })
  .build();
