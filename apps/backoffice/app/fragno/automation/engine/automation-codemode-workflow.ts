import type { RemoteWorkflowStepHost } from "@fragno-dev/workflows/remote-workflow";
import { defineRemoteWorkflow, type WorkflowEvent } from "@fragno-dev/workflows/workflow";

import {
  createBackofficeServiceExecution,
  createBackofficeSystemExecution,
  type BackofficeExecutionContext,
} from "@/backoffice-runtime/context";
import { BackofficeKernel } from "@/backoffice-runtime/kernel";
import type { BackofficeRuntimeServices } from "@/backoffice-runtime/runtime-services";
import { FileSystemError } from "@/files/fs-errors";
import { MasterFileSystem } from "@/files/master-file-system";
import { BACKOFFICE_WORKFLOW_ACTORS_METADATA_KEY } from "@/fragno/automation/actors";
import type { BackofficeCodemodeEnv } from "@/fragno/codemode/execute";
import { createEventRuntime } from "@/fragno/runtime-tools/families/event-runtime";
import { createRouteBackedRuntimeContext } from "@/fragno/runtime-tools/route-backed-runtime-context";

import { createAutomationExecutionFromActors } from "../authority";
import { AUTOMATION_WORKSPACE_ROOT, type AutomationFileSystemConfig } from "../catalog";
import { resolveAutomationFileSystem } from "../catalog";
import type { AutomationEvent } from "../contracts";
import { type AutomationPiBashContext, type AutomationRuntimeHostContext } from "./runtime";
import {
  AUTOMATION_CODEMODE_WORKFLOW,
  type AutomationCodemodeWorkflowParams,
} from "./workflow-start";

const createAutomationFileSystemExecution = (event: AutomationEvent): BackofficeExecutionContext =>
  event.scope.kind === "system"
    ? createBackofficeSystemExecution(event.scope)
    : createBackofficeServiceExecution({
        scope: event.scope,
        service: { type: "automation", id: `automation:${event.id}` },
      });

type AutomationWorkflowContextParams = Pick<
  AutomationCodemodeWorkflowParams,
  "automationEvent" | "workflowInstanceId" | "binding" | "idempotencyKey"
> & {
  workflowScriptPath: string;
  metadata?: AutomationCodemodeWorkflowParams["metadata"];
};

const createWorkflowAutomationContext = async ({
  runtime,
  params,
  execution,
  createPiAutomationContext,
}: {
  runtime: BackofficeRuntimeServices;
  params: AutomationWorkflowContextParams;
  execution?: BackofficeExecutionContext;
  createPiAutomationContext?: (input: {
    event: AutomationEvent;
    execution: BackofficeExecutionContext;
    idempotencyKey: string;
  }) => Promise<AutomationPiBashContext | undefined> | AutomationPiBashContext | undefined;
}): Promise<AutomationRuntimeHostContext> => {
  const resolvedExecution =
    execution ??
    createAutomationExecutionFromActors({
      scope: params.automationEvent.scope,
      actors: params.metadata?.[BACKOFFICE_WORKFLOW_ACTORS_METADATA_KEY],
    });
  const kernel = new BackofficeKernel(runtime);
  const pi = await createPiAutomationContext?.({
    event: params.automationEvent,
    execution: resolvedExecution,
    idempotencyKey: params.idempotencyKey ?? params.workflowInstanceId,
  });
  const emittedEventActors = resolvedExecution.actors;
  const runtimeContext = createRouteBackedRuntimeContext({
    runtime,
    kernel,
    execution: resolvedExecution,
    emittedEventActors,
    ...(pi ? { pi } : {}),
  });
  const eventRuntime = createEventRuntime({
    objects: runtime.objects,
    parentEvent: params.automationEvent,
    kernel,
    execution: resolvedExecution,
    emittedEventActors,
  });
  const automationRuntime = {
    ...runtimeContext.automations.runtime,
    ...runtimeContext.otp.runtime,
    ...eventRuntime,
  };

  const automationScope = params.automationEvent.scope;
  const scriptPath = params.workflowScriptPath ?? params.binding?.scriptPath ?? "workflow.js";
  const binding = params.binding ?? {
    id: `workflow:${scriptPath}`,
    source: "*",
    eventType: "*",
    enabled: true,
    triggerOrder: null,
    scriptId: `script:${scriptPath}`,
    scriptKey: scriptPath
      .replace(/^\/(?:system|workspace)\/automations\//u, "")
      .replace(/\.workflow\.js$/u, ""),
    scriptName: scriptPath.split("/").at(-1) ?? scriptPath,
    scriptPath,
    absoluteScriptPath: scriptPath.startsWith("/")
      ? scriptPath
      : `${AUTOMATION_WORKSPACE_ROOT}/${scriptPath}`,
    scriptVersion: 1,
    scriptEngine: "codemode" as const,
  };

  return {
    ...runtimeContext,
    automation: {
      event: params.automationEvent,
      orgId: automationScope.kind === "org" ? automationScope.orgId : undefined,
      binding: {
        source: binding.source,
        eventType: binding.eventType,
        scriptId: binding.scriptId,
        scriptKey: binding.scriptKey,
        scriptName: binding.scriptName,
        scriptPath: binding.scriptPath,
        scriptVersion: binding.scriptVersion,
        triggerOrder: binding.triggerOrder ?? undefined,
      },
      idempotencyKey: params.idempotencyKey ?? params.automationEvent.id,
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

export const executeAutomationWorkflowSource = async ({
  script,
  automationEvent,
  workflowScriptPath,
  workflowEvent,
  remote,
  config,
  execution,
  metadata,
  masterFs,
}: {
  script: string;
  automationEvent: AutomationEvent;
  workflowScriptPath: string;
  workflowEvent: WorkflowEvent<unknown>;
  remote: RemoteWorkflowStepHost;
  config: AutomationFileSystemConfig & {
    env?: CloudflareEnv;
    runtime?: BackofficeRuntimeServices;
    createPiAutomationContext?: (input: {
      event: AutomationEvent;
      execution: BackofficeExecutionContext;
      idempotencyKey: string;
    }) => Promise<AutomationPiBashContext | undefined> | AutomationPiBashContext | undefined;
  };
  execution?: BackofficeExecutionContext;
  metadata?: AutomationCodemodeWorkflowParams["metadata"];
  masterFs?: MasterFileSystem;
}): Promise<unknown> => {
  if (!config.env?.LOADER) {
    throw new Error("Workflow-backed codemode automation requires the Cloudflare Worker Loader.");
  }
  if (!config.runtime) {
    throw new Error("Workflow-backed codemode automation requires Backoffice runtime services.");
  }

  const resolvedFs =
    masterFs ??
    (await resolveAutomationFileSystem(config, {
      execution: execution ?? createAutomationFileSystemExecution(automationEvent),
      purpose: "runtime",
    }));
  if (!(resolvedFs instanceof MasterFileSystem)) {
    throw new Error("Automation filesystem must be a MasterFileSystem.");
  }

  const [context, { executeWorkflowCodemodeAutomation }] = await Promise.all([
    createWorkflowAutomationContext({
      runtime: config.runtime,
      params: {
        automationEvent,
        workflowScriptPath,
        workflowInstanceId: workflowEvent.instanceId,
        idempotencyKey: workflowEvent.instanceId,
        metadata,
      },
      execution,
      createPiAutomationContext: config.createPiAutomationContext,
    }),
    import("./codemode"),
  ]);
  const result = await executeWorkflowCodemodeAutomation({
    script,
    context,
    masterFs: resolvedFs,
    env: config.env as BackofficeCodemodeEnv,
    workflowEvent,
    remote,
  });

  if (result.exitCode !== 0) {
    throw new Error(result.stderr || "Workflow-backed codemode automation failed.");
  }

  return result.result;
};

const isMissingWorkflowScriptError = (error: unknown) => {
  if (error instanceof FileSystemError) {
    return error.code === "ENOENT";
  }

  return error instanceof Error && /ENOENT:.*no such file or directory/u.test(error.message);
};

export const defineAutomationCodemodeWorkflow = (
  config: AutomationFileSystemConfig & {
    env?: CloudflareEnv;
    runtime?: BackofficeRuntimeServices;
    createPiAutomationContext?: (input: {
      event: AutomationEvent;
      execution: BackofficeExecutionContext;
      idempotencyKey: string;
    }) => Promise<AutomationPiBashContext | undefined> | AutomationPiBashContext | undefined;
  },
) =>
  defineRemoteWorkflow({ name: AUTOMATION_CODEMODE_WORKFLOW }, async (event, remote) => {
    if (!config.env?.LOADER) {
      throw new Error("Workflow-backed codemode automation requires the Cloudflare Worker Loader.");
    }

    const params = event.payload as AutomationCodemodeWorkflowParams;
    if (params.script.kind !== "file") {
      throw new Error("Automation codemode workflows require a file-backed script.");
    }

    const resolvedFs = await resolveAutomationFileSystem(config, {
      execution: createAutomationFileSystemExecution(params.automationEvent),
      purpose: "runtime",
    });
    if (!(resolvedFs instanceof MasterFileSystem)) {
      throw new Error("Automation filesystem must be a MasterFileSystem.");
    }

    let script: string;
    try {
      script = await resolvedFs.readFile(params.script.path, "utf-8");
    } catch (error) {
      if (!isMissingWorkflowScriptError(error)) {
        throw error;
      }

      return {
        skipped: true,
        reason: "workflow-script-not-found",
        workflowScriptPath: params.script.path,
      };
    }

    return await executeAutomationWorkflowSource({
      script,
      automationEvent: params.automationEvent,
      workflowScriptPath: params.script.path,
      workflowEvent: {
        instanceId: event.instanceId,
        timestamp: event.timestamp,
        payload: event.payload,
      },
      remote,
      config,
      metadata: params.metadata,
      masterFs: resolvedFs,
    });
  });
