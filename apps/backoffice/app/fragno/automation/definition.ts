import type { InstanceStatus } from "@fragno-dev/workflows/workflow";

import { defineFragment } from "@fragno-dev/core";
import { withDatabase, type TxResult } from "@fragno-dev/db";
import type { WorkflowsFragmentServices } from "@fragno-dev/workflows";

import type { BackofficeContextScope } from "@/backoffice-runtime/context";
import { BackofficeKernel } from "@/backoffice-runtime/kernel";
import type { BackofficeRuntimeServices } from "@/backoffice-runtime/runtime-services";
import type { SandboxRuntimeProvider } from "@/sandbox/contracts";

import { createAutomationStoreServices } from "./bindings-storage-runtime";
import type { AutomationFileSystemConfig } from "./catalog";
import {
  STARTER_AUTOMATION_ROUTES,
  SYSTEM_STARTER_AUTOMATION_ROUTES,
} from "./content/starter-routing";
import type { AutomationEvent } from "./contracts";
import { type AutomationPiBashContext } from "./engine/runtime";
import { createAutomationCodemodeWorkflowInstanceInput } from "./engine/workflow-start";
import {
  buildAutomationEventDefinitionId,
  validateAutomationEventPayload,
} from "./event-definitions";
import { createAutomationEventDefinitionServices } from "./event-definitions-storage-runtime";
import { createAutomationEventServices } from "./events-storage-runtime";
import type { AutomationHookUnitOfWork } from "./internal-hooks";
import { createAutomationProjectServices } from "./projects-storage-runtime";
import { dispatchAutomationRouteSchedule } from "./route-scheduling-runtime";
import {
  buildWorkflowEventPayload,
  evaluateAutomationEventMatcher,
  renderAutomationRawTemplateValue,
  renderAutomationScopeTemplate,
  renderAutomationTemplateValue,
  type AutomationForwardEventAction,
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
  env?: CloudflareEnv;
  runtime?: BackofficeRuntimeServices;
  ownerScope: BackofficeContextScope;
  sandboxProviders?: Record<string, SandboxRuntimeProvider>;
  createPiAutomationContext?: (input: {
    event: AutomationEvent;
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
  { route }: IngestAutomationEventOptions = {},
) => {
  const now = uow.now();
  const occurredAt = new Date(event.occurredAt);
  if (Number.isNaN(occurredAt.getTime())) {
    throw new Error(`Automation event ${event.id} has an invalid occurredAt timestamp.`);
  }

  uow.create("automation_event", {
    id: event.id,
    scope: event.scope,
    source: event.source,
    eventType: event.eventType,
    occurredAt,
    payload: event.payload,
    actor: event.actor,
    actors: event.actors,
    subject: event.subject ?? null,
    createdAt: now,
  });

  uow.triggerHook("internalIngestEvent", { event, route }, { id: event.id });
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
}: RouteExecutionContext & { action: AutomationStartWorkflowAction }) => {
  const instanceId = renderAutomationTemplateValue(
    action.instanceIdTemplate,
    event,
    route.id,
    routingKey,
  );
  const workflowInput = createAutomationCodemodeWorkflowInstanceInput({
    event,
    workflowScriptPath: action.workflowScriptPath,
    instanceId,
    remoteWorkflowName: action.remoteWorkflowName,
  });

  await runWorkflowServiceCall(
    () =>
      [
        workflows.createInstance(action.workflowName, {
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

  await new BackofficeKernel({ objects: runtime.objects }).assertScopeAllowedByOwner({
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
    await targetAutomations.seedStarterAutomationRoutes();
  }
  await targetAutomations.ingestEvent(forwardedEvent);
};

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
        workflows.sendEvent(action.workflowName, instanceId, {
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
  .provideHooks(({ defineHook, serviceDeps, config }) => {
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
      internalIngestEvent: defineHook(async function (payload) {
        const { routes, store } = await this.handlerTx()
          .retrieve(({ forSchema }) => {
            const uow = forSchema(automationFragmentSchema);
            return uow
              .find("automation_route", (b) =>
                b.whereIndex("primary").orderByIndex("idx_automation_route_priority_id", "asc"),
              )
              .find("kv_store", (b) => b.whereIndex("primary"));
          })
          .transformRetrieve(([routeRows, storeRows]) => ({
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
          }))
          .execute();

        const runWorkflowServiceCall: RunWorkflowServiceCall = async (call) => {
          await this.handlerTx().withServiceCalls(call).execute();
        };

        const event = payload.event;
        const routesToExecute = payload.route ? [payload.route] : routes;
        for (const route of routesToExecute) {
          if (
            !payload.route &&
            (!route.enabled ||
              route.trigger.kind !== "event" ||
              (route.trigger.source !== event.source && route.trigger.source !== "*") ||
              (route.trigger.eventType !== event.eventType && route.trigger.eventType !== "*") ||
              !evaluateAutomationEventMatcher(route.trigger.matcher, event))
          ) {
            continue;
          }

          const context = {
            event,
            route,
            routingKey: routeRoutingKey(event, route),
            workflows: serviceDeps.workflows,
            runWorkflowServiceCall,
            store,
          };
          const action = route.action;
          switch (action.kind) {
            case "start_workflow":
              await handleStartWorkflowRouteAction({ ...context, action });
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
          }
        }
      }),
    };
  })
  .providesBaseService(({ defineService, config, serviceDeps }) => {
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
    const eventDefinitionServices = createAutomationEventDefinitionServices(defineService);

    return defineService({
      ...storeServices,
      ...projectServices,
      ...sandboxServices,
      ...routeServices,
      ...eventServices,
      ...eventDefinitionServices,
      seedStarterAutomationRoutes: function () {
        return this.serviceTx(automationFragmentSchema)
          .retrieve((uow) => uow.find("automation_route", (b) => b.whereIndex("primary")))
          .mutate(
            ({ uow, retrieveResult: [existingRoutes] }): StarterAutomationRoutesSeedResult => {
              const existingIds = new Set(existingRoutes.map((route) => route.id.externalId));
              const created: string[] = [];
              const skipped: string[] = [];

              for (const route of config.ownerScope.kind === "system"
                ? SYSTEM_STARTER_AUTOMATION_ROUTES
                : STARTER_AUTOMATION_ROUTES) {
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

              return { created, skipped };
            },
          )
          .build();
      },
      ingestEvent: function (event: AutomationEvent) {
        return this.serviceTx(automationFragmentSchema)
          .retrieve((uow) =>
            uow.findFirst("automation_event_definition", (b) =>
              b.whereIndex("primary", (eb) =>
                eb("id", "=", buildAutomationEventDefinitionId(event.source, event.eventType)),
              ),
            ),
          )
          .mutate(({ uow, retrieveResult: [definition] }) => {
            validateAutomationEventPayload({ event, definition });
            ingestAutomationEvent(uow, event);
          })
          .transform(() => buildIngestResult(event))
          .build();
      },
    });
  })
  .build();
