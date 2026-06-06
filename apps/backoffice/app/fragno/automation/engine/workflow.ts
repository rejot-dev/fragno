import { defineRemoteWorkflow } from "@fragno-dev/workflows/workflow";

import { MasterFileSystem } from "@/files/master-file-system";
import { createRouteBackedAutomationBindingsRuntime } from "@/fragno/automation/bindings-route-runtime";
import { createRouteBackedAutomationWorkflowRuntime } from "@/fragno/automation/workflow-route-runtime";
import type { BackofficeCodemodeEnv } from "@/fragno/codemode/execute";
import type { PiCodemodeWorkflowParams } from "@/fragno/pi/pi-codemode-workflow";
import type { AutomationBindingsRuntime } from "@/fragno/runtime-tools/families/automations-bindings";
import { createEventRuntime } from "@/fragno/runtime-tools/families/event-runtime";
import { createOtpRuntime } from "@/fragno/runtime-tools/families/otp-runtime";
import { createPiRouteRuntime } from "@/fragno/runtime-tools/families/pi-runtime";
import { createResendRouteRuntime } from "@/fragno/runtime-tools/families/resend-runtime";
import { createReson8RouteRuntime } from "@/fragno/runtime-tools/families/reson8-runtime";
import { createTelegramRuntime } from "@/fragno/runtime-tools/families/telegram-runtime";

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

  const automationsRuntime: AutomationBindingsRuntime = createRouteBackedAutomationBindingsRuntime({
    env,
    orgId,
  });

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
      runtime: {
        ...automationsRuntime,
        ...createOtpRuntime({ env, orgId }),
        ...createEventRuntime({ env, event: params.automationEvent }),
      },
    },
    automations: { runtime: automationsRuntime },
    otp: { runtime: createOtpRuntime({ env, orgId }) },
    pi: { runtime: createPiRouteRuntime({ env, orgId }) },
    workflow: { runtime: createRouteBackedAutomationWorkflowRuntime({ env, orgId }) },
    reson8: { runtime: createReson8RouteRuntime({ env, orgId }) },
    resend: { runtime: createResendRouteRuntime({ env, orgId }) },
    telegram: { runtime: createTelegramRuntime({ env, orgId }) },
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
      throw new Error(
        result.stderr ||
          `Automation workflow script ${context.automation.binding.scriptId} failed.`,
      );
    }

    return result;
  });

export const definePiCodemodeWorkflow = (
  config: AutomationFileSystemConfig & { env?: CloudflareEnv },
) =>
  defineRemoteWorkflow({ name: "pi-codemode-script" }, async (event, remote) => {
    if (!config.env?.LOADER) {
      throw new Error("Pi codemode workflow requires the Cloudflare Worker Loader.");
    }

    const params = event.payload as PiCodemodeWorkflowParams;
    const orgId = params.orgId?.trim();
    if (!orgId) {
      throw new Error("Pi codemode workflow requires an organisation id.");
    }

    const resolvedFs = await resolveAutomationFileSystem(config, {
      orgId,
      purpose: "runtime",
    });
    if (!(resolvedFs instanceof MasterFileSystem)) {
      throw new Error("Pi codemode workflow filesystem must be a MasterFileSystem.");
    }

    const { executePiCodemodeWorkflow } = await import("./codemode");
    return await executePiCodemodeWorkflow({
      params,
      masterFs: resolvedFs,
      env: config.env as BackofficeCodemodeEnv & CloudflareEnv,
      workflowEvent: event,
      remote,
    });
  });
