import { defineRemoteWorkflow } from "@fragno-dev/workflows/workflow";

import type { BackofficeExecutionContext } from "@/backoffice-runtime/context";
import { BackofficeKernel } from "@/backoffice-runtime/kernel";
import type { BackofficeRuntimeServices } from "@/backoffice-runtime/runtime-services";
import { FileSystemError } from "@/files/fs-errors";
import { MasterFileSystem } from "@/files/master-file-system";
import type { BackofficeCodemodeEnv } from "@/fragno/codemode/execute";
import type { PiCodemodeWorkflowParams } from "@/fragno/pi/pi-codemode-workflow";
import { createEventRuntime } from "@/fragno/runtime-tools/families/event-runtime";
import { createRouteBackedRuntimeContext } from "@/fragno/runtime-tools/route-backed-runtime-context";

import type { AutomationTriggerBinding } from "../../runtime-tools/automation-types";
import { AUTOMATION_WORKSPACE_ROOT, type AutomationFileSystemConfig } from "../catalog";
import { resolveAutomationFileSystem } from "../catalog";
import type { AutomationEvent } from "../contracts";
import { type AutomationRuntimeHostContext } from "./runtime";
import { AUTOMATION_CODEMODE_WORKFLOW, PI_CODEMODE_WORKFLOW } from "./workflow-start";

export type AutomationCodemodeWorkflowParams = {
  automationEvent: AutomationEvent;
  workflowScriptPath: string;
  workflowInstanceId: string;
  binding?: AutomationTriggerBinding;
  idempotencyKey?: string;
};

const automationEventOrganizationIds = (event: AutomationEvent) =>
  event.scope.kind === "org" || event.scope.kind === "project" ? [event.scope.orgId] : undefined;

const createWorkflowExecution = (event: AutomationEvent): BackofficeExecutionContext => {
  if (event.scope.kind === "system") {
    return {
      actor: { type: "system", id: "system" },
      scope: event.scope,
    };
  }

  const organizationIds = automationEventOrganizationIds(event);
  return {
    actor: {
      type: "automation",
      id: `automation:${event.id}`,
      ...(organizationIds ? { organizationIds } : {}),
    },
    scope: event.scope,
  };
};

const createWorkflowAutomationContext = ({
  runtime,
  params,
}: {
  runtime: BackofficeRuntimeServices;
  params: AutomationCodemodeWorkflowParams;
}): AutomationRuntimeHostContext => {
  const kernel = new BackofficeKernel({ objects: runtime.objects });
  const execution = createWorkflowExecution(params.automationEvent);
  const runtimeContext = createRouteBackedRuntimeContext({
    runtime,
    kernel,
    execution,
  });
  const eventRuntime = createEventRuntime({
    objects: runtime.objects,
    parentEvent: params.automationEvent,
    kernel,
    execution,
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

const isMissingWorkflowScriptError = (error: unknown) => {
  if (error instanceof FileSystemError) {
    return error.code === "ENOENT";
  }

  return error instanceof Error && /ENOENT:.*no such file or directory/u.test(error.message);
};

export const defineAutomationCodemodeWorkflow = (
  config: AutomationFileSystemConfig & { env?: CloudflareEnv; runtime?: BackofficeRuntimeServices },
) =>
  defineRemoteWorkflow({ name: AUTOMATION_CODEMODE_WORKFLOW }, async (event, remote) => {
    if (!config.env?.LOADER) {
      throw new Error("Workflow-backed codemode automation requires the Cloudflare Worker Loader.");
    }

    const params = event.payload as AutomationCodemodeWorkflowParams;
    const resolvedFs = await resolveAutomationFileSystem(config, {
      execution: createWorkflowExecution(params.automationEvent),
      purpose: "runtime",
    });
    if (!(resolvedFs instanceof MasterFileSystem)) {
      throw new Error("Automation filesystem must be a MasterFileSystem.");
    }

    let script: string;
    try {
      script = await resolvedFs.readFile(params.workflowScriptPath, "utf-8");
    } catch (error) {
      if (!isMissingWorkflowScriptError(error)) {
        throw error;
      }

      return {
        skipped: true,
        reason: "workflow-script-not-found",
        workflowScriptPath: params.workflowScriptPath,
      };
    }

    const { executeWorkflowCodemodeAutomation } = await import("./codemode");
    if (!config.runtime) {
      throw new Error("Workflow-backed codemode automation requires Backoffice runtime services.");
    }

    const context = createWorkflowAutomationContext({
      runtime: config.runtime,
      params,
    });
    const result = await executeWorkflowCodemodeAutomation({
      script,
      context,
      masterFs: resolvedFs,
      env: config.env as BackofficeCodemodeEnv,
      workflowEvent: event,
      remote,
    });

    if (result.exitCode !== 0) {
      throw new Error(result.stderr || "Workflow-backed codemode automation failed.");
    }

    return result.result;
  });

export const definePiCodemodeWorkflow = (config: {
  env?: BackofficeCodemodeEnv & CloudflareEnv;
  runtime?: BackofficeRuntimeServices;
}) =>
  defineRemoteWorkflow({ name: PI_CODEMODE_WORKFLOW }, async (event, remote) => {
    if (!config.env?.LOADER) {
      throw new Error("Pi codemode workflow requires the Cloudflare Worker Loader.");
    }

    const params = event.payload as PiCodemodeWorkflowParams;
    const { executePiCodemodeWorkflow } = await import("./codemode");
    return await executePiCodemodeWorkflow({
      params,
      masterFs: new MasterFileSystem({
        mounts: [],
      }),
      env: config.env,
      runtime: config.runtime,
      workflowEvent: event,
      remote,
    });
  });
