import type { WorkflowEvent, WorkflowStep } from "@fragno-dev/workflows/workflow";

import type { MasterFileSystem } from "@/files/master-file-system";
import {
  createRouteBackedAutomationsRuntime,
  createRouteBackedWorkflowsRuntime,
} from "@/fragno/automation/identity-runtime";
import {
  runBackofficeCodemode,
  type BackofficeCodemodeEnv,
  type BackofficeCodemodeWorkflowDefinition,
} from "@/fragno/codemode/execute";
import { runBackofficeCodemodeWorkflow } from "@/fragno/codemode/workflow-execute";
import type { PiCodemodeWorkflowParams } from "@/fragno/pi/pi-codemode-workflow";
import type { AutomationExecutionContext } from "@/fragno/runtime-tools/automation-host";
import type {
  AutomationsRuntime,
  WorkflowsRuntime,
} from "@/fragno/runtime-tools/families/automations";
import type { EventRuntime } from "@/fragno/runtime-tools/families/event";
import type { OtpRuntime } from "@/fragno/runtime-tools/families/otp";
import { createOtpRuntime } from "@/fragno/runtime-tools/families/otp-runtime";
import type { PiRuntime } from "@/fragno/runtime-tools/families/pi";
import { createPiRouteRuntime } from "@/fragno/runtime-tools/families/pi-runtime";
import type { ResendRuntime } from "@/fragno/runtime-tools/families/resend";
import { createResendRouteRuntime } from "@/fragno/runtime-tools/families/resend-runtime";
import type { Reson8Runtime } from "@/fragno/runtime-tools/families/reson8";
import { createReson8RouteRuntime } from "@/fragno/runtime-tools/families/reson8-runtime";
import type { TelegramRuntime } from "@/fragno/runtime-tools/families/telegram";
import { createTelegramRuntime } from "@/fragno/runtime-tools/families/telegram-runtime";
import {
  getAvailableRuntimeTools,
  type BackofficeRuntimeToolCall,
  type BackofficeToolContext,
} from "@/fragno/runtime-tools/runtime-tools";
import {
  automationRuntimeToolFamilies,
  piCodemodeRuntimeToolFamilies,
} from "@/fragno/runtime-tools/tool-families";

import { createAutomationRunResult, type AutomationRunResult } from "../run-result";
import { createAutomationExecutionFileSystem } from "./execution-file-system";

type AutomationCodemodeToolContext = BackofficeToolContext<{
  automations?: AutomationsRuntime;
  event?: EventRuntime;
  otp?: OtpRuntime;
  pi?: PiRuntime;
  resend?: ResendRuntime;
  reson8?: Reson8Runtime;
  telegram?: TelegramRuntime;
}>;

type PiCodemodeToolContext = BackofficeToolContext<{
  automations?: AutomationsRuntime;
  workflow?: WorkflowsRuntime;
  otp?: OtpRuntime;
  pi?: PiRuntime;
  resend?: ResendRuntime;
  reson8?: Reson8Runtime;
  telegram?: TelegramRuntime;
}>;

const createAutomationToolRuntimeContext = (
  context: AutomationExecutionContext,
): AutomationCodemodeToolContext => ({
  runtimes: {
    automations: context.automations?.runtime,
    event: context.automation.runtime,
    otp: context.otp?.runtime,
    pi: context.pi?.runtime,
    resend: context.resend?.runtime,
    reson8: context.reson8?.runtime,
    telegram: context.telegram?.runtime,
  },
});

const createCodemodeAutomationRunResult = ({
  result,
  context,
}: {
  result: {
    result?: unknown;
    error?: string;
    logs?: string[];
    toolCalls?: BackofficeRuntimeToolCall[];
    workflowDefinition?: BackofficeCodemodeWorkflowDefinition;
  };
  context: AutomationExecutionContext;
}): AutomationRunResult<"codemode"> =>
  createAutomationRunResult({
    runtime: "codemode",
    eventId: context.automation.event.id,
    scriptId: context.automation.binding.scriptId,
    exitCode: result.error ? 1 : 0,
    stderr: result.error ?? "",
    logs: result.logs ?? [],
    result: result.result,
    toolCalls: result.toolCalls,
    workflowDefinition: result.workflowDefinition,
  });

export const executeCodemodeAutomation = async ({
  script,
  context,
  masterFs,
  env,
}: {
  script: string;
  context: AutomationExecutionContext;
  masterFs: MasterFileSystem;
  env: BackofficeCodemodeEnv;
}): Promise<AutomationRunResult<"codemode">> => {
  const executionFs = createAutomationExecutionFileSystem({
    masterFs,
    eventJson: JSON.stringify(context.automation.event),
    envJson: JSON.stringify(context.automation.bashEnv),
  });
  const toolContext = createAutomationToolRuntimeContext(context);
  const tools = getAvailableRuntimeTools({
    families: automationRuntimeToolFamilies,
    context: toolContext,
  });
  const result = await runBackofficeCodemode({
    code: script,
    fs: executionFs,
    env,
    tools,
    context: toolContext,
  });

  return createCodemodeAutomationRunResult({ result, context });
};

export const executeWorkflowCodemodeAutomation = async ({
  script,
  context,
  masterFs,
  env,
  workflowEvent,
  step,
}: {
  script: string;
  context: AutomationExecutionContext;
  masterFs: MasterFileSystem;
  env: BackofficeCodemodeEnv;
  workflowEvent: WorkflowEvent<unknown>;
  step: WorkflowStep;
}): Promise<AutomationRunResult<"codemode">> => {
  const executionFs = createAutomationExecutionFileSystem({
    masterFs,
    eventJson: JSON.stringify(context.automation.event),
    envJson: JSON.stringify(context.automation.bashEnv),
  });
  const toolContext = createAutomationToolRuntimeContext(context);
  const tools = getAvailableRuntimeTools({
    families: automationRuntimeToolFamilies,
    context: toolContext,
  });
  const result = await runBackofficeCodemodeWorkflow({
    code: script,
    event: workflowEvent,
    step,
    fs: executionFs,
    env,
    tools,
    context: toolContext,
  });

  return createCodemodeAutomationRunResult({ result, context });
};

export const executePiCodemodeWorkflow = async ({
  params,
  masterFs,
  env,
  workflowEvent,
  step,
}: {
  params: PiCodemodeWorkflowParams;
  masterFs: MasterFileSystem;
  env: BackofficeCodemodeEnv & CloudflareEnv;
  workflowEvent: WorkflowEvent<unknown>;
  step: WorkflowStep;
}): Promise<unknown> => {
  const orgId = params.orgId.trim();
  if (!orgId) {
    throw new Error("Pi codemode workflow requires an organisation id.");
  }

  const automationsRuntime = createRouteBackedAutomationsRuntime({ env, orgId });
  const context: PiCodemodeToolContext = {
    runtimes: {
      automations: automationsRuntime,
      workflow: createRouteBackedWorkflowsRuntime({ env, orgId }),
      otp: createOtpRuntime({ env, orgId }),
      pi: createPiRouteRuntime({ env, orgId }),
      resend: createResendRouteRuntime({ env, orgId }),
      reson8: createReson8RouteRuntime({ env, orgId }),
      telegram: createTelegramRuntime({ env, orgId }),
    },
  };
  const tools = getAvailableRuntimeTools({
    families: piCodemodeRuntimeToolFamilies,
    context,
  });
  const result = await runBackofficeCodemodeWorkflow({
    code: params.code,
    event: workflowEvent,
    step,
    fs: masterFs,
    env,
    tools,
    context,
  });
  if (result.error) {
    throw new Error(result.error);
  }
  return result.result;
};
