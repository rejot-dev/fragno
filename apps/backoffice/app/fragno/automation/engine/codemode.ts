import type { RemoteWorkflowStepHost } from "@fragno-dev/workflows/remote-workflow";
import type { WorkflowEvent } from "@fragno-dev/workflows/workflow";

import type { NpmDependencyMap } from "@/backoffice-runtime/dynamic-workers/npm-dependencies";
import {
  runBackofficeCodemode,
  type BackofficeCodemodeEnv,
  type BackofficeCodemodeWorkflowDefinition,
} from "@/fragno/codemode/execute";
import type { CodemodeWorkflowAgent } from "@/fragno/codemode/workflow-agent-rpc";
import { runBackofficeCodemodeWorkflow } from "@/fragno/codemode/workflow-execute";
import type { AutomationScriptHostContext } from "@/fragno/runtime-tools/automation-host";
import type { BackofficeRuntimeToolCall } from "@/fragno/runtime-tools/runtime-tools";
import { createBackofficeToolContext } from "@/fragno/runtime-tools/tool-context";
import { runtimeToolFamilies } from "@/fragno/runtime-tools/tool-families";

import { createAutomationRunResult, type AutomationRunResult } from "../run-result";

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
  context: AutomationScriptHostContext;
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
  env,
}: {
  script: string;
  context: AutomationScriptHostContext;
  env: BackofficeCodemodeEnv;
}): Promise<AutomationRunResult<"codemode">> => {
  const toolContext = createBackofficeToolContext(context);
  const result = await runBackofficeCodemode({
    code: script,
    env,
    families: runtimeToolFamilies,
    toolContext,
  });

  return createCodemodeAutomationRunResult({ result, context });
};

export const executeWorkflowCodemodeAutomation = async ({
  script,
  dependencies,
  context,
  env,
  workflowEvent,
  remote,
  workflowAgent,
}: {
  script: string;
  dependencies?: NpmDependencyMap;
  context: AutomationScriptHostContext;
  env: BackofficeCodemodeEnv;
  workflowEvent: WorkflowEvent<unknown>;
  remote: RemoteWorkflowStepHost;
  workflowAgent?: CodemodeWorkflowAgent;
}): Promise<AutomationRunResult<"codemode">> => {
  const toolContext = createBackofficeToolContext(context);
  const result = await runBackofficeCodemodeWorkflow({
    code: script,
    dependencies,
    event: { ...workflowEvent, id: context.automation.event.id },
    remote,
    env,
    globalOutbound: null,
    families: runtimeToolFamilies,
    toolContext,
    workflowAgent,
  });

  return createCodemodeAutomationRunResult({ result, context });
};
