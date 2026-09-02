import { defineRemoteWorkflow } from "@fragno-dev/workflows/workflow";

import { withBackofficeActorCapabilityGrants } from "@/backoffice-runtime/authority-resolver";
import type { BackofficeExecutionContext } from "@/backoffice-runtime/context";
import { BackofficeKernel } from "@/backoffice-runtime/kernel";
import type { BackofficeRuntimeServices } from "@/backoffice-runtime/runtime-services";
import type { BackofficeCodemodeEnv } from "@/fragno/codemode/execute";
import type { BackofficeWorkflowAgentHarnessOptionsResolver } from "@/fragno/pi/pi-runtime";
import { createEventRuntime } from "@/fragno/runtime-tools/families/event-runtime";
import { createRouteBackedRuntimeContext } from "@/fragno/runtime-tools/route-backed-runtime-context";

import type { AutomationSourceReader } from "../automation-source";
import type { AutomationEvent } from "../contracts";
import {
  assertCodemodeCapabilityGrantsBelongToExecution,
  CODEMODE_WORKFLOW,
  codemodeWorkflowParamsSchema,
  type CodemodeWorkflowParams,
} from "./codemode-invocation";
import { createCodemodeWorkflowAgent } from "./codemode-workflow-agent";
import { type AutomationPiBashContext, type AutomationRuntimeHostContext } from "./runtime";

export type CodemodeWorkflowConfig = {
  readAutomationSource?: AutomationSourceReader;
  env?: BackofficeCodemodeEnv & CloudflareEnv;
  runtime?: BackofficeRuntimeServices;
  createPiAutomationContext?: (input: {
    event: AutomationEvent;
    execution: BackofficeExecutionContext;
    idempotencyKey: string;
  }) => Promise<AutomationPiBashContext | undefined> | AutomationPiBashContext | undefined;
  resolveWorkflowAgentHarnessOptions?: BackofficeWorkflowAgentHarnessOptionsResolver;
};

const runtimeWithCapabilityGrants = ({
  runtime,
  params,
}: {
  runtime: BackofficeRuntimeServices;
  params: CodemodeWorkflowParams;
}) => {
  let currentRuntime = runtime;
  for (const grant of params.execution.capabilityGrants) {
    currentRuntime = {
      ...currentRuntime,
      authorityResolver: withBackofficeActorCapabilityGrants({
        resolver: currentRuntime.authorityResolver,
        actor: grant.actor,
        grants: grant.permissions,
      }),
    };
  }
  return currentRuntime;
};

const createCodemodeWorkflowContext = async ({
  runtime,
  params,
  automationEvent,
  workflowInstanceId,
  createPiAutomationContext,
  sourceReader,
}: {
  runtime: BackofficeRuntimeServices;
  params: CodemodeWorkflowParams;
  automationEvent: AutomationEvent;
  workflowInstanceId: string;
  createPiAutomationContext?: CodemodeWorkflowConfig["createPiAutomationContext"];
  sourceReader?: AutomationSourceReader;
}): Promise<AutomationRuntimeHostContext> => {
  const execution: BackofficeExecutionContext = {
    scope: params.execution.scope,
    actors: params.execution.actors,
  };
  const kernel = new BackofficeKernel(runtime);
  const pi = await createPiAutomationContext?.({
    event: automationEvent,
    execution,
    idempotencyKey: workflowInstanceId,
  });
  const runtimeContext = createRouteBackedRuntimeContext({
    runtime,
    kernel,
    execution,
    emittedEventActors: execution.actors,
    ...(pi ? { pi } : {}),
    workflowSourceReader: sourceReader,
  });
  const eventRuntime = createEventRuntime({
    objects: runtime.objects,
    parentEvent: automationEvent,
    kernel,
    execution,
    emittedEventActors: execution.actors,
  });
  const automationRuntime = {
    ...runtimeContext.automations.runtime,
    ...runtimeContext.otp.runtime,
    ...eventRuntime,
  };

  return {
    ...runtimeContext,
    automation: {
      event: automationEvent,
      orgId:
        automationEvent.scope.kind === "org" || automationEvent.scope.kind === "project"
          ? automationEvent.scope.orgId
          : undefined,
      binding: {
        source: automationEvent.source,
        eventType: automationEvent.eventType,
        scriptId: `codemode:${params.program.workflowName}`,
        scriptKey: params.program.workflowName,
        scriptName: params.program.filename.split("/").at(-1) ?? params.program.filename,
        scriptPath: params.program.filename,
        scriptVersion: 1,
        triggerOrder: undefined,
      },
      idempotencyKey: workflowInstanceId,
      runtime: automationRuntime,
    },
    automations: {
      ...runtimeContext.automations,
      runtime: automationRuntime,
    },
    otp: {
      runtime: automationRuntime,
    },
  };
};

export const defineCodemodeWorkflow = (config: CodemodeWorkflowConfig) =>
  defineRemoteWorkflow(
    {
      name: CODEMODE_WORKFLOW,
      schema: codemodeWorkflowParamsSchema,
      checkpoint: "step",
    },
    async function executeCodemodeWorkflow(event, remote) {
      if (!config.env?.LOADER) {
        throw new Error("Codemode workflows require the Cloudflare Worker Loader.");
      }
      if (!config.runtime) {
        throw new Error("Codemode workflows require Backoffice runtime services.");
      }

      const params = codemodeWorkflowParamsSchema.parse(event.payload);
      const execution: BackofficeExecutionContext = {
        scope: params.execution.scope,
        actors: params.execution.actors,
      };
      assertCodemodeCapabilityGrantsBelongToExecution({
        execution,
        capabilityGrants: params.execution.capabilityGrants,
      });

      const runtime = runtimeWithCapabilityGrants({ runtime: config.runtime, params });
      const automationEvent: AutomationEvent =
        params.trigger.type === "event"
          ? params.trigger.event
          : {
              id: event.instanceId,
              scope: execution.scope,
              source: "manual",
              eventType: "workflow.started",
              occurredAt: event.timestamp.toISOString(),
              payload: params.trigger.payload,
              actors: execution.actors,
              subject:
                execution.scope.kind === "org" || execution.scope.kind === "project"
                  ? { orgId: execution.scope.orgId }
                  : execution.scope.kind === "user"
                    ? { userId: execution.scope.userId }
                    : null,
            };
      const sourceReader = config.readAutomationSource;

      const [context, { executeWorkflowCodemodeAutomation }] = await Promise.all([
        createCodemodeWorkflowContext({
          runtime,
          params,
          automationEvent,
          workflowInstanceId: event.instanceId,
          createPiAutomationContext: config.createPiAutomationContext,
          sourceReader,
        }),
        import("./codemode"),
      ]);
      const resolveWorkflowAgentHarnessOptions = config.resolveWorkflowAgentHarnessOptions;
      const workflowAgent = resolveWorkflowAgentHarnessOptions
        ? createCodemodeWorkflowAgent({
            workflowName: params.program.workflowName,
            workflowInstanceId: event.instanceId,
            createdAt: event.timestamp,
            actor: execution.actors,
            metadata: { filename: params.program.filename },
            remote,
            resolveHarnessOptions: async () =>
              await resolveWorkflowAgentHarnessOptions({
                sessionId: event.instanceId,
                execution,
              }),
          })
        : undefined;
      const result = await executeWorkflowCodemodeAutomation({
        script: params.program.code,
        dependencies: params.program.dependencies,
        context,
        env: config.env,
        workflowEvent: {
          ...automationEvent,
          instanceId: event.instanceId,
          timestamp: event.timestamp,
          payload: automationEvent.payload,
        },
        remote,
        workflowAgent,
      });

      if (result.exitCode !== 0) {
        throw new Error(result.stderr || "Codemode workflow failed.");
      }
      return result.result;
    },
  );
