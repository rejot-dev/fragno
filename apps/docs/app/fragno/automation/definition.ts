import { defineFragment } from "@fragno-dev/core";
import { withDatabase, type TxResult } from "@fragno-dev/db";
import type { InstanceStatus, WorkflowsFragmentServices } from "@fragno-dev/workflows";

import { createAutomationBashRuntime } from "./bash-runtime";
import type { AutomationBuiltinScript, AutomationBuiltinTriggerBinding } from "./builtins";
import {
  type AutomationCreateIdentityClaimInput,
  type AutomationCreateIdentityClaimResult,
  type AutomationEvent,
  type AutomationSourceAdapterRegistry,
  getSourceAdapter,
} from "./contracts";
import { createBashAutomationEngine } from "./engine/bash";
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

export interface AutomationFragmentConfig {
  sourceAdapters?: Partial<AutomationSourceAdapterRegistry>;
  createIdentityClaim?: (
    input: AutomationCreateIdentityClaimInput,
  ) => Promise<AutomationCreateIdentityClaimResult>;
  builtinScripts?: AutomationBuiltinScript[];
  builtinBindings?: AutomationBuiltinTriggerBinding[];
}

type ResolvedBuiltinAutomationBinding = {
  source: string;
  eventType: string;
  scriptId: string;
  script: string;
  engine: string;
};

const buildBuiltinScriptId = (script: AutomationBuiltinScript) =>
  `builtin:${script.key}@${script.version}`;

const resolveBuiltinBindings = (
  config: AutomationFragmentConfig,
  event: AutomationEvent,
): ResolvedBuiltinAutomationBinding[] => {
  const builtinBindings = (config.builtinBindings ?? []).filter(
    (binding) =>
      binding.enabled !== false &&
      binding.source === event.source &&
      binding.eventType === event.eventType,
  );

  if (builtinBindings.length === 0) {
    return [];
  }

  const builtinScripts = config.builtinScripts ?? [];

  return builtinBindings.map((binding) => {
    const script = builtinScripts.find(
      (entry) =>
        entry.enabled !== false &&
        entry.key === binding.scriptKey &&
        entry.version === (binding.scriptVersion ?? 1),
    );

    if (!script) {
      throw new Error(
        `Missing built-in automation script for ${binding.source}:${binding.eventType} -> ${binding.scriptKey}@${binding.scriptVersion ?? 1}`,
      );
    }

    return {
      source: binding.source,
      eventType: binding.eventType,
      scriptId: buildBuiltinScriptId(script),
      script: script.script,
      engine: script.engine,
    } satisfies ResolvedBuiltinAutomationBinding;
  });
};

const buildIngestResult = (event: AutomationEvent): AutomationIngestResult => ({
  accepted: true,
  eventId: event.id,
  orgId: event.orgId?.trim() || undefined,
  source: event.source,
  eventType: event.eventType,
});

export const automationFragmentDefinition = defineFragment<AutomationFragmentConfig>("automations")
  .extend(withDatabase(automationFragmentSchema))
  .usesOptionalService<"workflows", AutomationWorkflowsService>("workflows")
  .provideHooks(({ defineHook, config }) => {
    const bashEngine = createBashAutomationEngine({
      sourceAdapters: config.sourceAdapters,
    });

    return {
      internalIngestEvent: defineHook(async function (payload) {
        const builtinBindings = resolveBuiltinBindings(config, payload);
        const storedBindings =
          builtinBindings.length > 0
            ? []
            : await this.handlerTx()
                .retrieve(({ forSchema }) =>
                  forSchema(automationFragmentSchema).find("trigger_binding", (b) =>
                    b
                      .whereIndex("idx_trigger_binding_source_event", (eb) =>
                        eb.and(
                          eb("source", "=", payload.source),
                          eb("eventType", "=", payload.eventType),
                        ),
                      )
                      .join((j) => j.triggerBindingScript()),
                  ),
                )
                .transformRetrieve(([records]) => records)
                .execute();

        const sourceAdapter = getSourceAdapter(config.sourceAdapters, payload.source);

        if (builtinBindings.length > 0) {
          await Promise.all(
            builtinBindings.map(async (binding) => {
              if (binding.engine !== "bash") {
                throw new Error(`Unsupported automation engine: ${binding.engine}`);
              }

              await bashEngine.execute({
                event: { ...payload, orgId: payload.orgId },
                binding: {
                  source: binding.source,
                  eventType: binding.eventType,
                  scriptId: binding.scriptId,
                },
                runtime: createAutomationBashRuntime({
                  hookContext: this,
                  event: payload,
                  createIdentityClaim: config.createIdentityClaim,
                  buildIngestResult,
                }),
                sourceAdapter,
                idempotencyKey: this.idempotencyKey,
                script: binding.script,
              });
            }),
          );
          return;
        }

        if (storedBindings.length === 0) {
          console.warn("No automation binding configured for event", {
            eventId: payload.id,
            source: payload.source,
            eventType: payload.eventType,
            orgId: payload.orgId,
          });
          return;
        }

        await Promise.all(
          storedBindings
            .filter((binding) => binding.enabled)
            .map(async (binding) => {
              if (!binding.triggerBindingScript || !binding.triggerBindingScript.enabled) {
                return;
              }

              if (binding.triggerBindingScript.engine !== "bash") {
                throw new Error(
                  `Unsupported automation engine: ${binding.triggerBindingScript.engine}`,
                );
              }

              await bashEngine.execute({
                event: { ...payload, orgId: payload.orgId },
                binding: {
                  source: binding.source,
                  eventType: binding.eventType,
                  scriptId: binding.triggerBindingScript.id.externalId,
                },
                runtime: createAutomationBashRuntime({
                  hookContext: this,
                  event: payload,
                  createIdentityClaim: config.createIdentityClaim,
                  buildIngestResult,
                }),
                sourceAdapter,
                idempotencyKey: this.idempotencyKey,
                script: binding.triggerBindingScript.script,
              });
            }),
        );
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
