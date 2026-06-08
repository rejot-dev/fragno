import type { RemoteWorkflowStepHost } from "@fragno-dev/workflows/remote-workflow";
import type { WorkflowEvent } from "@fragno-dev/workflows/workflow";

import type { MasterFileSystem } from "@/files/master-file-system";
import {
  runBackofficeCodemode,
  type BackofficeCodemodeEnv,
  type BackofficeCodemodeWorkflowDefinition,
} from "@/fragno/codemode/execute";
import { runBackofficeCodemodeWorkflow } from "@/fragno/codemode/workflow-execute";
import type { PiCodemodeWorkflowParams } from "@/fragno/pi/pi-codemode-workflow";
import type { AutomationExecutionContext } from "@/fragno/runtime-tools/automation-host";
import { createRouteBackedRuntimeContext } from "@/fragno/runtime-tools/route-backed-runtime-context";
import {
  getAvailableRuntimeTools,
  type BackofficeRuntimeToolCall,
} from "@/fragno/runtime-tools/runtime-tools";
import { createBackofficeToolContext } from "@/fragno/runtime-tools/tool-context";
import {
  runtimeToolFamilies,
  type CoreBackofficeToolContext,
} from "@/fragno/runtime-tools/tool-families";

import { createAutomationRunResult, type AutomationRunResult } from "../run-result";
import { createAutomationExecutionFileSystem } from "./execution-file-system";

const createAutomationToolRuntimeContext = (
  context: AutomationExecutionContext,
): CoreBackofficeToolContext => ({
  runtimes: {
    automations: context.automations?.runtime,
    workflow: context.workflow?.runtime,
    durableHooks: context.durableHooks?.runtime,
    event: context.automation.runtime,
    otp: context.otp?.runtime,
    pi: context.pi?.runtime,
    resend: context.resend?.runtime,
    reson8: context.reson8?.runtime,
    sandbox: context.sandbox?.runtime,
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
    contextFiles: {
      "event.json": JSON.stringify(context.automation.event),
      "env.json": JSON.stringify(context.automation.bashEnv),
    },
  });
  const toolContext = createAutomationToolRuntimeContext(context);
  const tools = getAvailableRuntimeTools({
    families: runtimeToolFamilies,
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
  remote,
}: {
  script: string;
  context: AutomationExecutionContext;
  masterFs: MasterFileSystem;
  env: BackofficeCodemodeEnv;
  workflowEvent: WorkflowEvent<unknown>;
  remote: RemoteWorkflowStepHost;
}): Promise<AutomationRunResult<"codemode">> => {
  const executionFs = createAutomationExecutionFileSystem({
    masterFs,
    contextFiles: {
      "event.json": JSON.stringify(context.automation.event),
      "env.json": JSON.stringify(context.automation.bashEnv),
    },
  });
  const toolContext = createAutomationToolRuntimeContext(context);
  const tools = getAvailableRuntimeTools({
    families: runtimeToolFamilies,
    context: toolContext,
  });
  const result = await runBackofficeCodemodeWorkflow({
    code: script,
    event: workflowEvent,
    remote,
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
  remote,
}: {
  params: PiCodemodeWorkflowParams;
  masterFs: MasterFileSystem;
  env: BackofficeCodemodeEnv & CloudflareEnv;
  workflowEvent: WorkflowEvent<unknown>;
  remote: RemoteWorkflowStepHost;
}): Promise<unknown> => {
  const orgId = params.orgId.trim();
  if (!orgId) {
    throw new Error("Pi codemode workflow requires an organisation id.");
  }

  const runtimeContext = createRouteBackedRuntimeContext({ env, orgId });
  const context = createBackofficeToolContext(runtimeContext);
  const tools = getAvailableRuntimeTools({
    families: runtimeToolFamilies,
    context,
  });
  const result = await runBackofficeCodemodeWorkflow({
    code: params.code,
    event: workflowEvent,
    remote,
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
