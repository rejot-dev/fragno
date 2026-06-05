import type { InstanceStatus } from "@fragno-dev/workflows/workflow";

import { defineFragment } from "@fragno-dev/core";
import { withDatabase, type TxResult } from "@fragno-dev/db";
import type { WorkflowsFragmentServices } from "@fragno-dev/workflows";

import { MasterFileSystem } from "@/files/master-file-system";
import { executeAutomationScript } from "@/fragno/runtime-tools/automation-host";

import type { AutomationFileSystemConfig, AutomationFileSystemResolverInput } from "./catalog";
import {
  getAutomationBindingsForEvent,
  loadAutomationCatalog,
  resolveAutomationFileSystem,
} from "./catalog";
import type { AutomationEvent } from "./contracts";
import {
  createAutomationExecutionContext,
  createAutomationRuntime,
  type AutomationPiBashContext,
} from "./engine/runtime";
import type { AutomationCodemodeWorkflowParams } from "./engine/workflow";

export type { AutomationPiBashContext } from "./engine/runtime";
import { automationFragmentSchema } from "./schema";

export type AutomationIngestResult = {
  accepted: boolean;
  eventId: string;
  orgId?: string;
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
  createPiAutomationContext?: (input: {
    event: AutomationEvent;
    idempotencyKey: string;
  }) => Promise<AutomationPiBashContext | undefined> | AutomationPiBashContext | undefined;
}

const buildIngestResult = (event: AutomationEvent): AutomationIngestResult => ({
  accepted: true,
  eventId: event.id,
  orgId: event.orgId?.trim() || undefined,
  source: event.source,
  eventType: event.eventType,
});

const toWorkflowIdentifier = (value: string) => value.replaceAll(":", "--");

export const buildAutomationWorkflowInstanceId = (eventId: string, bindingId: string) =>
  `${toWorkflowIdentifier(eventId)}--${toWorkflowIdentifier(bindingId)}`;

const buildCatalogResolverInput = (event: AutomationEvent): AutomationFileSystemResolverInput => ({
  orgId: event.orgId?.trim() || undefined,
  purpose: "runtime",
});

export const automationFragmentDefinition = defineFragment<AutomationFragmentConfig>("automations")
  .extend(withDatabase(automationFragmentSchema))
  .usesOptionalService<"workflows", AutomationWorkflowsService>("workflows")
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
        const matchingBindings = getAutomationBindingsForEvent(catalog, payload);

        if (matchingBindings.length === 0) {
          console.warn("No automation binding configured for event", {
            eventId: payload.id,
            source: payload.source,
            eventType: payload.eventType,
            orgId: payload.orgId,
          });
          return;
        }

        const runtime = createAutomationRuntime({
          hookContext: this,
          env: config.env,
          event: payload,
        });
        const pi = await config.createPiAutomationContext?.({
          event: payload,
          idempotencyKey: this.idempotencyKey,
        });
        for (const binding of matchingBindings) {
          if (binding.scriptLoadError) {
            throw new Error(binding.scriptLoadError);
          }

          const context = createAutomationExecutionContext({
            event: payload,
            binding: {
              id: binding.id,
              source: binding.source,
              eventType: binding.eventType,
              scriptId: binding.scriptId,
              scriptKey: binding.scriptKey,
              scriptName: binding.scriptName,
              scriptPath: binding.scriptPath,
              scriptVersion: binding.scriptVersion,
              scriptEnv: binding.scriptEnv,
              triggerOrder: binding.triggerOrder ?? undefined,
            },
            idempotencyKey: this.idempotencyKey,
            runtime,
            env: config.env,
            pi: pi ?? null,
          });

          const result = await executeAutomationScript({
            engine: binding.scriptEngine,
            script: binding.scriptBody,
            masterFs,
            context,
            env: config.env,
          });

          if (result.exitCode !== 0) {
            throw new Error(
              [
                `Automation ${binding.scriptEngine} script ${binding.scriptId} failed for event ${payload.id} with exit code ${result.exitCode}.`,
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
                `No workflows service available to run workflow automation script ${binding.scriptId}.`,
              );
            }

            const workflowParams: AutomationCodemodeWorkflowParams = {
              automationEvent: payload,
              binding,
              idempotencyKey: this.idempotencyKey,
              script: binding.scriptBody,
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
  .providesBaseService(({ defineService }) =>
    defineService({
      ingestEvent: function (event: AutomationEvent) {
        return this.serviceTx(automationFragmentSchema)
          .mutate(({ uow }) => {
            uow.triggerHook(
              "internalIngestEvent",
              { ...event, orgId: event.orgId?.trim() },
              { id: event.id },
            );
          })
          .transform(() => buildIngestResult(event))
          .build();
      },
    }),
  )
  .build();
