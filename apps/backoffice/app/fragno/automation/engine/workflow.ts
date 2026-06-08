import { defineRemoteWorkflow } from "@fragno-dev/workflows/workflow";

import { MasterFileSystem } from "@/files/master-file-system";
import type { BackofficeCodemodeEnv } from "@/fragno/codemode/execute";
import type { PiCodemodeWorkflowParams } from "@/fragno/pi/pi-codemode-workflow";
import { createEventRuntime } from "@/fragno/runtime-tools/families/event-runtime";
import { createRouteBackedRuntimeContext } from "@/fragno/runtime-tools/route-backed-runtime-context";

import {
  AUTOMATION_WORKSPACE_ROOT,
  type AutomationBindingCatalogEntry,
  type AutomationFileSystemConfig,
} from "../catalog";
import { resolveAutomationFileSystem } from "../catalog";
import type { AutomationEvent } from "../contracts";
import type { AutomationRuntimeHostContext } from "./runtime";

export type AutomationCodemodeWorkflowParams = {
  automationEvent: AutomationEvent;
  binding?: AutomationBindingCatalogEntry;
  idempotencyKey?: string;
  script?: string;
  workflowScriptPath?: string;
};

const createWorkflowAutomationContext = ({
  env,
  params,
}: {
  env: CloudflareEnv;
  params: AutomationCodemodeWorkflowParams;
}): AutomationRuntimeHostContext => {
  const orgId = params.automationEvent.orgId?.trim() || undefined;
  if (!orgId) {
    throw new Error("Workflow-backed automation requires an organisation id.");
  }

  const runtimeContext = createRouteBackedRuntimeContext({ env, orgId });
  const eventRuntime = createEventRuntime({ env, event: params.automationEvent });
  const automationRuntime = {
    ...runtimeContext.automations.runtime,
    ...runtimeContext.otp.runtime,
    ...eventRuntime,
  };

  const scriptPath = params.workflowScriptPath ?? params.binding?.scriptPath ?? "workflow.js";
  const binding = params.binding ?? {
    id: `workflow:${scriptPath}`,
    source: "*",
    eventType: "*",
    enabled: true,
    triggerOrder: null,
    scriptId: `script:${scriptPath}`,
    scriptKey: scriptPath
      .replace(/^\/workspace\/automations\//u, "")
      .replace(/\.workflow\.js$/u, ""),
    scriptName: scriptPath.split("/").at(-1) ?? scriptPath,
    scriptPath,
    absoluteScriptPath: scriptPath.startsWith("/")
      ? scriptPath
      : `${AUTOMATION_WORKSPACE_ROOT}/${scriptPath}`,
    scriptVersion: 1,
    scriptEngine: "codemode" as const,
    scriptEnv: {},
  };

  return {
    automation: {
      event: params.automationEvent,
      orgId,
      binding: {
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
      idempotencyKey: params.idempotencyKey ?? params.automationEvent.id,
      bashEnv: binding.scriptEnv,
      runtime: automationRuntime,
    },
    automations: {
      ...runtimeContext.automations,
      runtime: automationRuntime,
    },
    workflow: runtimeContext.workflow,
    durableHooks: runtimeContext.durableHooks,
    otp: {
      runtime: automationRuntime,
    },
    pi: runtimeContext.pi,
    reson8: runtimeContext.reson8,
    resend: runtimeContext.resend,
    sandbox: runtimeContext.sandbox,
    telegram: runtimeContext.telegram,
  };
};

export const defineAutomationCodemodeWorkflow = (
  config: AutomationFileSystemConfig & { env?: CloudflareEnv },
) =>
  defineRemoteWorkflow({ name: "automation-codemode-script" }, async (event, remote) => {
    if (!config.env?.LOADER) {
      throw new Error("Workflow-backed codemode automation requires the Cloudflare Worker Loader.");
    }

    const params = event.payload as AutomationCodemodeWorkflowParams;
    const resolvedFs = await resolveAutomationFileSystem(config, {
      orgId: params.automationEvent.orgId?.trim() || undefined,
      purpose: "runtime",
    });
    if (!(resolvedFs instanceof MasterFileSystem)) {
      throw new Error("Automation filesystem must be a MasterFileSystem.");
    }

    const script =
      params.script ??
      (params.workflowScriptPath
        ? await resolvedFs.readFile(params.workflowScriptPath, "utf-8")
        : null);
    if (!script) {
      throw new Error("Automation codemode workflow requires either script or workflowScriptPath.");
    }

    const { executeWorkflowCodemodeAutomation } = await import("./codemode");
    const context = createWorkflowAutomationContext({ env: config.env, params });
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

export const definePiCodemodeWorkflow = (config: { env?: BackofficeCodemodeEnv & CloudflareEnv }) =>
  defineRemoteWorkflow({ name: "pi-codemode-script" }, async (event, remote) => {
    if (!config.env?.LOADER) {
      throw new Error("Pi codemode workflow requires the Cloudflare Worker Loader.");
    }

    const params = event.payload as PiCodemodeWorkflowParams;
    const { executePiCodemodeWorkflow } = await import("./codemode");
    return await executePiCodemodeWorkflow({
      params,
      masterFs: new MasterFileSystem({ mounts: [] }),
      env: config.env,
      workflowEvent: event,
      remote,
    });
  });
