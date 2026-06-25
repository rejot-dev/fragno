import type { InstanceStatus } from "@fragno-dev/workflows/workflow";

import { defineFragment } from "@fragno-dev/core";
import { withDatabase, type TxResult } from "@fragno-dev/db";
import type { WorkflowsFragmentServices } from "@fragno-dev/workflows";

import type {
  BackofficeContextScope,
  BackofficeExecutionContext,
} from "@/backoffice-runtime/context";
import type { BackofficeRuntimeServices } from "@/backoffice-runtime/runtime-services";
import { MasterFileSystem } from "@/files/master-file-system";
import { executeAutomationScript } from "@/fragno/runtime-tools/automation-host";
import type { SandboxRuntimeProvider } from "@/sandbox/contracts";

import type { AutomationFileSystemConfig, AutomationFileSystemResolverInput } from "./catalog";
import { loadAutomationCatalog, resolveAutomationFileSystem } from "./catalog";
import type { AutomationEvent } from "./contracts";
import {
  createAutomationExecutionContext,
  createAutomationRuntime,
  type AutomationPiBashContext,
} from "./engine/runtime";
import type { AutomationCodemodeWorkflowParams } from "./engine/workflow";

export type { AutomationPiBashContext } from "./engine/runtime";
import { createAutomationStoreServices } from "./bindings-storage-runtime";
import { createAutomationProjectServices } from "./projects-storage-runtime";
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

const buildCatalogResolverInput = (event: AutomationEvent): AutomationFileSystemResolverInput => ({
  execution: {
    actor: {
      type: "automation",
      id: `automation:${event.id}`,
      ...(event.scope.kind === "org" || event.scope.kind === "project"
        ? { organizationIds: [event.scope.orgId] }
        : {}),
    },
    scope: event.scope,
  } satisfies BackofficeExecutionContext,
  purpose: "runtime",
});

export const automationFragmentDefinition = defineFragment<AutomationFragmentConfig>("automations")
  .extend(withDatabase(automationFragmentSchema))
  .usesService<"workflows", AutomationWorkflowsService>("workflows")
  .provideHooks(({ defineHook, config, serviceDeps }) => {
    return {
      internalIngestEvent: defineHook(async function (payload) {
        const resolvedFs = await resolveAutomationFileSystem(
          config,
          buildCatalogResolverInput(payload),
        );
        if (!(resolvedFs instanceof MasterFileSystem)) {
          throw new Error("Automation filesystem must be a MasterFileSystem.");
        }
        const masterFs = resolvedFs;
        const catalog = await loadAutomationCatalog(masterFs);
        const scripts = catalog.scripts.filter((script) => script.enabled);

        if (scripts.length === 0) {
          console.warn("No automation scripts configured for event", {
            eventId: payload.id,
            source: payload.source,
            eventType: payload.eventType,
            scope: payload.scope,
          });
          return;
        }

        const runtime = createAutomationRuntime({
          runtime: config.runtime,
          event: payload,
        });
        const pi = await config.createPiAutomationContext?.({
          event: payload,
          idempotencyKey: this.idempotencyKey,
        });
        for (const script of scripts) {
          if (script.scriptLoadError) {
            throw new Error(script.scriptLoadError);
          }

          const binding = {
            id: script.id,
            source: "*",
            eventType: "*",
            scriptId: script.id,
            scriptKey: script.key,
            scriptName: script.name,
            scriptPath: script.path,
            scriptVersion: script.version,
          };

          const context = createAutomationExecutionContext({
            event: payload,
            binding,
            idempotencyKey: this.idempotencyKey,
            runtime,
            runtimeServices: config.runtime,
            pi: pi ?? null,
          });

          const result = await executeAutomationScript({
            engine: script.engine,
            script: script.body,
            masterFs,
            context,
            env: config.env,
          });

          if (result.exitCode !== 0) {
            throw new Error(
              [
                `Automation ${script.engine} script ${script.id} failed for event ${payload.id} with exit code ${result.exitCode}.`,
                result.stderr.trim() || result.stdout.trim(),
              ]
                .filter(Boolean)
                .join(" "),
            );
          }

          const workflowDefinition = result.workflowDefinition;
          if (workflowDefinition) {
            if (!serviceDeps.workflows) {
              throw new Error(
                `No workflows service available to run workflow automation script ${script.id}.`,
              );
            }

            const workflowParams: AutomationCodemodeWorkflowParams = {
              automationEvent: payload,
              binding,
              idempotencyKey: this.idempotencyKey,
              script: script.body,
            };
            await this.handlerTx()
              .withServiceCalls(
                () =>
                  [
                    serviceDeps.workflows!.createInstance("automation-codemode-script", {
                      id: buildAutomationWorkflowInstanceId(payload.id, binding.id),
                      params: workflowParams,
                      remoteWorkflowName: workflowDefinition.name,
                    }),
                  ] as const,
              )
              .execute();
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
      sandboxProviders: config.sandboxProviders,
    });

    return defineService({
      ...storeServices,
      ...projectServices,
      ...sandboxServices,
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
