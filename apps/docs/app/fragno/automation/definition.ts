import { defineFragment } from "@fragno-dev/core";
import { withDatabase, type TxResult } from "@fragno-dev/db";
import type { InstanceStatus, WorkflowsFragmentServices } from "@fragno-dev/workflows";

import type { AutomationBuiltinScript, AutomationBuiltinTriggerBinding } from "./builtins";
import {
  type AutomationEvent,
  type AutomationSourceAdapterRegistry,
  getSourceAdapter,
} from "./contracts";
import {
  createAutomationBashCommandContext,
  createAutomationBashRuntime,
  executeBashAutomation,
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

export interface AutomationFragmentConfig {
  env?: CloudflareEnv;
  sourceAdapters?: Partial<AutomationSourceAdapterRegistry>;
  createPiAutomationContext?: (input: {
    event: AutomationEvent;
    idempotencyKey: string;
  }) => Promise<AutomationPiBashContext | undefined> | AutomationPiBashContext | undefined;
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
    const sourceAdapters = config.sourceAdapters ?? {};

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
                      .whereIndex("idx_trigger_binding_source_event_created_at_id", (eb) =>
                        eb.and(
                          eb("source", "=", payload.source),
                          eb("eventType", "=", payload.eventType),
                        ),
                      )
                      .orderByIndex("idx_trigger_binding_source_event_created_at_id", "asc")
                      .join((j) => j.triggerBindingScript()),
                  ),
                )
                .transformRetrieve(([records]) => records)
                .execute();

        if (builtinBindings.length === 0 && storedBindings.length === 0) {
          console.warn("No automation binding configured for event", {
            eventId: payload.id,
            source: payload.source,
            eventType: payload.eventType,
            orgId: payload.orgId,
          });
          return;
        }

        const sourceAdapter = getSourceAdapter(sourceAdapters, payload.source);
        const runtime = createAutomationBashRuntime({
          hookContext: this,
          env: config.env,
          event: payload,
          sourceAdapters,
          sourceAdapter,
        });
        const pi = await config.createPiAutomationContext?.({
          event: payload,
          idempotencyKey: this.idempotencyKey,
        });
        if (builtinBindings.length > 0) {
          for (const binding of builtinBindings) {
            if (binding.engine !== "bash") {
              throw new Error(`Unsupported automation engine: ${binding.engine}`);
            }

            const result = await executeBashAutomation({
              script: binding.script,
              context: createAutomationBashCommandContext({
                event: payload,
                binding: {
                  source: binding.source,
                  eventType: binding.eventType,
                  scriptId: binding.scriptId,
                },
                idempotencyKey: this.idempotencyKey,
                runtime,
                sourceAdapter,
                cloudflareEnv: {},
                pi,
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

          return;
        }

        for (const binding of storedBindings) {
          if (!binding.enabled || !binding.triggerBindingScript?.enabled) {
            continue;
          }

          if (binding.triggerBindingScript.engine !== "bash") {
            throw new Error(
              `Unsupported automation engine: ${binding.triggerBindingScript.engine}`,
            );
          }

          const result = await executeBashAutomation({
            script: binding.triggerBindingScript.script,
            context: createAutomationBashCommandContext({
              event: payload,
              binding: {
                source: binding.source,
                eventType: binding.eventType,
                scriptId: binding.triggerBindingScript.id.externalId,
              },
              idempotencyKey: this.idempotencyKey,
              runtime,
              sourceAdapter,
              cloudflareEnv: {},
              pi,
            }),
          });

          if (result.exitCode !== 0) {
            throw new Error(
              [
                `Automation bash script ${binding.triggerBindingScript.id.externalId} failed for event ${payload.id} with exit code ${result.exitCode}.`,
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
