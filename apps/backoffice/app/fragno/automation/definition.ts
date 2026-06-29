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
import { createAutomationProjectServices } from "./projects-storage-runtime";
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

export type { AutomationPiBashContext } from "./engine/runtime";

export type AutomationIngestResult = {
  accepted: boolean;
  eventId: string;
  scope: BackofficeContextScope;
  source: string;
  eventType: string;
};

type AutomationWorkflowsServiceBase = WorkflowsFragmentServices;
export type AutomationWorkflowsInstanceStatus = InstanceStatus;
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
  const params = {
    automationEvent: event,
    workflowScriptPath: action.workflowScriptPath,
    workflowInstanceId: instanceId,
  };

  await runWorkflowServiceCall(
    () =>
      [
        workflows.createInstance(action.workflowName, {
          id: instanceId,
          params,
          remoteWorkflowName: action.remoteWorkflowName,
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

  new BackofficeKernel({ objects: runtime.objects }).assertAutomationForwardTargetAllowed({
    ownerScope,
    targetScope: scope,
    routeId: route.id,
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
      internalIngestEvent: defineHook(async function (event) {
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
              source: route.source,
              eventType: route.eventType,
              matcher: route.matcher,
              action: route.action,
              priority: route.priority,
              description: route.description,
            })),
            store: new Map(storeRows.map((entry) => [entry.key, entry.value])),
          }))
          .execute();

        const runWorkflowServiceCall: RunWorkflowServiceCall = async (call) => {
          await this.handlerTx().withServiceCalls(call).execute();
        };

        for (const route of routes) {
          if (
            !route.enabled ||
            (route.source !== event.source && route.source !== "*") ||
            (route.eventType !== event.eventType && route.eventType !== "*") ||
            !evaluateAutomationEventMatcher(route.matcher, event)
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
    });
    const routeServices = createAutomationRouteServices(defineService);

    return defineService({
      ...storeServices,
      ...projectServices,
      ...sandboxServices,
      ...routeServices,
      seedStarterAutomationRoutes: function () {
        return this.serviceTx(automationFragmentSchema)
          .retrieve((uow) => uow.find("automation_route", (b) => b.whereIndex("primary")))
          .mutate(
            ({ uow, retrieveResult: [existingRoutes] }): StarterAutomationRoutesSeedResult => {
              const now = uow.now();
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
                  source: route.source,
                  eventType: route.eventType,
                  matcher: route.matcher,
                  action: route.action,
                  priority: route.priority,
                  description: route.description ?? null,
                  createdAt: now,
                  updatedAt: now,
                });
                created.push(route.id);
              }

              return { created, skipped };
            },
          )
          .build();
      },
      ingestEvent: function (event: AutomationEvent) {
        return this.serviceTx(automationFragmentSchema)
          .mutate(({ uow }) => {
            uow.triggerHook("internalIngestEvent", event, {
              id: event.id,
            });
          })
          .transform(() => buildIngestResult(event))
          .build();
      },
    });
  })
  .build();
