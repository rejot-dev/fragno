import type { AutomationEvent } from "@fragno-dev/backoffice-api/v0/events";
import {
  backofficeScopeOrganization,
  backofficeScopeRootOwner,
} from "@fragno-dev/backoffice-api/v0/shared/scope";
import { defineRemoteWorkflow } from "@fragno-dev/workflows/workflow";

import { withBackofficeActorCapabilityGrants } from "@/backoffice-runtime/authority-resolver";
import type { BackofficeExecutionContext } from "@/backoffice-runtime/context";
import { BackofficeKernel } from "@/backoffice-runtime/kernel";
import type { BackofficeRuntimeServices } from "@/backoffice-runtime/runtime-services";
import { codemodeRunnerFor } from "@/fragno/codemode/codemode-object-execute";
import {
  createEventRuntime,
  type EventEmitter,
} from "@/fragno/runtime-tools/families/event-runtime";
import { createRouteBackedRuntimeContext } from "@/fragno/runtime-tools/route-backed-runtime-context";

import type { AutomationSourceReader } from "../automation-source";
import {
  assertCodemodeCapabilityGrantsBelongToExecution,
  CODEMODE_WORKFLOW,
  codemodeWorkflowParamsSchema,
  type CodemodeWorkflowParams,
} from "./codemode-invocation";
import type { AutomationRuntimeHostContext } from "./runtime";

export type CodemodeWorkflowConfig = {
  readAutomationSource?: AutomationSourceReader;
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
  emitter,
  sourceReader,
}: {
  runtime: BackofficeRuntimeServices;
  params: CodemodeWorkflowParams;
  emitter: Extract<EventEmitter, { kind: "workflow" }>;
  sourceReader?: AutomationSourceReader;
}): Promise<AutomationRuntimeHostContext> => {
  const { event: automationEvent, instanceId: workflowInstanceId } = emitter;
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
    emitter,
    emittedEventActors: execution.actors,
    workflowSourceReader: sourceReader,
  });
  const eventRuntime = createEventRuntime({
    objects: runtime.objects,
    emitter,
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
      orgId: backofficeScopeOrganization(automationEvent.scope)?.orgId,
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
      const executionOwner = backofficeScopeRootOwner(execution.scope);
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
                executionOwner &&
                (executionOwner.kind === "org"
                  ? { orgId: executionOwner.orgId }
                  : { userId: executionOwner.userId }),
              causation: { kind: "origin" },
            };
      const sourceReader = config.readAutomationSource;

      const [context, { executeWorkflowCodemodeAutomation }] = await Promise.all([
        createCodemodeWorkflowContext({
          runtime,
          params,
          emitter: {
            kind: "workflow",
            workflowName: CODEMODE_WORKFLOW,
            instanceId: event.instanceId,
            startedBy: params.trigger.type === "event" ? "event" : "manual",
            event: automationEvent,
          },
          sourceReader,
        }),
        import("./codemode"),
      ]);
      const result = await executeWorkflowCodemodeAutomation({
        script: params.program.code,
        modules: params.program.modules,
        dependencies: params.program.dependencies,
        context,
        // Each tick is a run of the workflow's scope, billed like any other run there.
        codemode: codemodeRunnerFor(
          new BackofficeKernel(runtime).scoped(
            "CODEMODE",
            execution.scope,
            runtime.objects.codemode,
          ).commands,
          execution,
        ),
        origin: { kind: "file", path: params.program.filename },
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
