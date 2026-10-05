import { defineRemoteWorkflow } from "@fragno-dev/workflows/workflow";

import { withBackofficeActorCapabilityGrants } from "@/backoffice-runtime/authority-resolver";
import type { BackofficeExecutionContext } from "@/backoffice-runtime/context";
import { BackofficeKernel } from "@/backoffice-runtime/kernel";
import type { BackofficeRuntimeServices } from "@/backoffice-runtime/runtime-services";
import type { BackofficeCodemodeEnv } from "@/fragno/codemode/execute";
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
import type { AutomationRuntimeHostContext } from "./runtime";

export type CodemodeWorkflowConfig = {
  readAutomationSource?: AutomationSourceReader;
  env?: BackofficeCodemodeEnv;
  runtime?: BackofficeRuntimeServices;
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
  sourceReader,
}: {
  runtime: BackofficeRuntimeServices;
  params: CodemodeWorkflowParams;
  automationEvent: AutomationEvent;
  workflowInstanceId: string;
  sourceReader?: AutomationSourceReader;
}): Promise<AutomationRuntimeHostContext> => {
  const execution: BackofficeExecutionContext = {
    kind: "deferred",
    scope: params.execution.scope,
    scopeRestriction: params.execution.scopeRestriction,
    actors: params.execution.actors,
  };
  const kernel = new BackofficeKernel(runtime);
  const runtimeContext = createRouteBackedRuntimeContext({
    runtime,
    kernel,
    execution,
    billingOrganizationId: params.execution.billingOrganizationId,
    emittedEventActors: execution.actors,
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
      if (!config.env) {
        throw new Error("Codemode workflows require a configured executor.");
      }
      if (!config.runtime) {
        throw new Error("Codemode workflows require Backoffice runtime services.");
      }

      const params = codemodeWorkflowParamsSchema.parse(event.payload);
      const execution: BackofficeExecutionContext = {
        kind: "deferred",
        scope: params.execution.scope,
        scopeRestriction: params.execution.scopeRestriction,
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
              scopeRestriction: execution.scopeRestriction,
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
          sourceReader,
        }),
        import("./codemode"),
      ]);
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
      });

      if (result.exitCode !== 0) {
        throw new Error(result.stderr || "Codemode workflow failed.");
      }
      return result.result;
    },
  );
