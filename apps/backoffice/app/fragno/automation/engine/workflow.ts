import { defineRemoteWorkflow } from "@fragno-dev/workflows/workflow";

import { MasterFileSystem } from "@/files/master-file-system";
import {
  createRouteBackedAutomationsRuntime,
  type AutomationsRuntime,
} from "@/fragno/automation/identity-runtime";
import type { BackofficeCodemodeEnv } from "@/fragno/codemode/execute";
import type { PiCodemodeWorkflowParams } from "@/fragno/pi/pi-codemode-workflow";
import { createEventRuntime } from "@/fragno/runtime-tools/families/event-runtime";
import { createOtpRuntime } from "@/fragno/runtime-tools/families/otp-runtime";
import { createPiRouteRuntime } from "@/fragno/runtime-tools/families/pi-runtime";
import { createResendRouteRuntime } from "@/fragno/runtime-tools/families/resend-runtime";
import { createReson8RouteRuntime } from "@/fragno/runtime-tools/families/reson8-runtime";
import { createTelegramRuntime } from "@/fragno/runtime-tools/families/telegram-runtime";

import type { AutomationFileSystemConfig, AutomationManifestBindingEntry } from "../catalog";
import { resolveAutomationFileSystem } from "../catalog";
import type { AutomationEvent } from "../contracts";
import type { AutomationRuntimeHostContext } from "./runtime";

export type AutomationCodemodeWorkflowParams = {
  automationEvent: AutomationEvent;
  binding: AutomationManifestBindingEntry;
  idempotencyKey: string;
  script: string;
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

  const automationsRuntime: AutomationsRuntime = createRouteBackedAutomationsRuntime({
    env,
    orgId,
  });

  return {
    automation: {
      event: params.automationEvent,
      orgId,
      binding: {
        source: params.binding.source,
        eventType: params.binding.eventType,
        scriptId: params.binding.scriptId,
        scriptKey: params.binding.scriptKey,
        scriptName: params.binding.scriptName,
        scriptPath: params.binding.scriptPath,
        scriptVersion: params.binding.scriptVersion,
        scriptEnv: params.binding.scriptEnv,
        triggerOrder: params.binding.triggerOrder ?? undefined,
      },
      idempotencyKey: params.idempotencyKey,
      bashEnv: params.binding.scriptEnv,
      runtime: {
        ...automationsRuntime,
        ...createOtpRuntime({ env, orgId }),
        ...createEventRuntime({ env, event: params.automationEvent }),
      },
    },
    automations: { runtime: automationsRuntime },
    otp: { runtime: createOtpRuntime({ env, orgId }) },
    pi: { runtime: createPiRouteRuntime({ env, orgId }) },
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

    const { executeWorkflowCodemodeAutomation } = await import("./codemode");
    const result = await executeWorkflowCodemodeAutomation({
      script: params.script,
      context: createWorkflowAutomationContext({ env: config.env, params }),
      masterFs: resolvedFs,
      env: config.env as BackofficeCodemodeEnv,
      workflowEvent: event,
      remote,
    });

    if (result.exitCode !== 0) {
      throw new Error(
        result.stderr || `Automation workflow script ${params.binding.scriptId} failed.`,
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
