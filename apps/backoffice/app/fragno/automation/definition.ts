import { defineFragment } from "@fragno-dev/core";
import { withDatabase, type TxResult } from "@fragno-dev/db";
import type { InstanceStatus, WorkflowsFragmentServices } from "@fragno-dev/workflows";

import { MasterFileSystem } from "@/files/master-file-system";
import { createScriptRunnerRuntime, executeBashAutomation } from "@/fragno/bash-runtime/bash-host";

import type { AutomationFileSystemConfig, AutomationFileSystemResolverInput } from "./catalog";
import {
  getAutomationBindingsForEvent,
  loadAutomationCatalog,
  resolveAutomationFileSystem,
} from "./catalog";
import type { AutomationEvent } from "./contracts";
import {
  createAutomationBashCommandContext,
  createAutomationBashRuntime,
  type AutomationPiBashContext,
} from "./engine/bash";

export type { AutomationPiBashContext } from "./engine/bash";
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
  | "createInstance"
  | "getInstanceStatus"
  | "getLiveInstanceState"
  | "restoreInstanceState"
  | "sendEvent"
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

const buildCatalogResolverInput = (event: AutomationEvent): AutomationFileSystemResolverInput => ({
  orgId: event.orgId?.trim() || undefined,
  purpose: "runtime",
});

export const automationFragmentDefinition = defineFragment<AutomationFragmentConfig>("automations")
  .extend(withDatabase(automationFragmentSchema))
  .usesOptionalService<"workflows", AutomationWorkflowsService>("workflows")
  .provideHooks(({ defineHook, config }) => {
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

        const runtime = createAutomationBashRuntime({
          hookContext: this,
          env: config.env,
          event: payload,
        });
        const pi = await config.createPiAutomationContext?.({
          event: payload,
          idempotencyKey: this.idempotencyKey,
        });
        const scriptRunner = createScriptRunnerRuntime({
          fileSystemConfig: { automationFileSystem: masterFs },
          env: config.env,
          createBashRuntime: (event) =>
            createAutomationBashRuntime({
              hookContext: this,
              env: config.env,
              event,
            }),
          createPiAutomationContext: config.createPiAutomationContext,
        });

        for (const binding of matchingBindings) {
          if (binding.scriptLoadError) {
            throw new Error(binding.scriptLoadError);
          }

          const result = await executeBashAutomation({
            script: binding.scriptBody,
            masterFs,
            context: createAutomationBashCommandContext({
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
              scriptRunner,
            }),
          });

          if (result.exitCode !== 0) {
            throw new Error(
              [
                `Automation bash script ${binding.scriptId} failed for event ${payload.id} with exit code ${result.exitCode}.`,
                result.stderr.trim() || result.stdout.trim(),
              ]
                .filter(Boolean)
                .join(" "),
            );
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
