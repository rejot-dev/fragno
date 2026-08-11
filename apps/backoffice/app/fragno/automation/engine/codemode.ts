import type { RemoteWorkflowStepHost } from "@fragno-dev/workflows/remote-workflow";
import type { WorkflowEvent } from "@fragno-dev/workflows/workflow";

import type { NpmDependencyMap } from "@/backoffice-runtime/dynamic-workers/npm-dependencies";
import type { MasterFileSystem } from "@/files/master-file-system";
import {
  runBackofficeCodemode,
  type BackofficeCodemodeEnv,
  type BackofficeCodemodeWorkflowDefinition,
} from "@/fragno/codemode/execute";
import { runBackofficeCodemodeWorkflow } from "@/fragno/codemode/workflow-execute";
import type { AutomationScriptHostContext } from "@/fragno/runtime-tools/automation-host";
import type { BackofficeRuntimeToolCall } from "@/fragno/runtime-tools/runtime-tools";
import { createBackofficeToolContext } from "@/fragno/runtime-tools/tool-context";
import { runtimeToolFamilies } from "@/fragno/runtime-tools/tool-families";

import { createAutomationRunResult, type AutomationRunResult } from "../run-result";
import { createAutomationExecutionFileSystem } from "./execution-file-system";

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
  masterFs,
  env,
}: {
  script: string;
  context: AutomationScriptHostContext;
  masterFs: MasterFileSystem;
  env: BackofficeCodemodeEnv;
}): Promise<AutomationRunResult<"codemode">> => {
  const executionFs = createAutomationExecutionFileSystem({
    masterFs,
    contextFiles: {
      "event.json": JSON.stringify(context.automation.event),
    },
  });
  const toolContext = createBackofficeToolContext(context);
  const result = await runBackofficeCodemode({
    code: script,
    fs: executionFs,
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
  masterFs,
  env,
  workflowEvent,
  remote,
}: {
  script: string;
  dependencies?: NpmDependencyMap;
  context: AutomationScriptHostContext;
  masterFs: MasterFileSystem;
  env: BackofficeCodemodeEnv;
  workflowEvent: WorkflowEvent<unknown>;
  remote: RemoteWorkflowStepHost;
}): Promise<AutomationRunResult<"codemode">> => {
  const executionFs = createAutomationExecutionFileSystem({
    masterFs,
    contextFiles: {
      "event.json": JSON.stringify(context.automation.event),
    },
  });
  const toolContext = createBackofficeToolContext(context);
  const result = await runBackofficeCodemodeWorkflow({
    code: script,
    dependencies,
    event: { ...workflowEvent, id: context.automation.event.id },
    remote,
    fs: executionFs,
    env,
    globalOutbound: null,
    families: runtimeToolFamilies,
    toolContext,
  });

  return createCodemodeAutomationRunResult({ result, context });
};
