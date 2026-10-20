import type { RemoteWorkflowStepHost } from "@fragno-dev/workflows/remote-workflow";
import type { WorkflowEvent } from "@fragno-dev/workflows/workflow";

import type { NpmDependencyMap } from "@/backoffice-runtime/dynamic-workers/npm-dependencies";
import type { CodemodeRunOrigin } from "@/fragno/codemode/codemode-fragment";
import type { CodemodeRunner } from "@/fragno/codemode/codemode-object-execute";
import type { BackofficeCodemodeWorkflowDefinition } from "@/fragno/codemode/execute";
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

export const executeWorkflowCodemodeAutomation = async ({
  script,
  modules,
  dependencies,
  context,
  codemode,
  origin,
  workflowEvent,
  remote,
}: {
  script: string;
  modules: Record<string, string>;
  dependencies?: NpmDependencyMap;
  context: AutomationScriptHostContext;
  codemode: CodemodeRunner;
  origin: CodemodeRunOrigin;
  workflowEvent: WorkflowEvent<unknown>;
  remote: RemoteWorkflowStepHost;
}): Promise<AutomationRunResult<"codemode">> => {
  const toolContext = createBackofficeToolContext(context);
  const result = await runBackofficeCodemodeWorkflow({
    code: script,
    modules,
    dependencies,
    event: { ...workflowEvent, id: context.automation.event.id },
    remote,
    codemode,
    origin,
    allowedHooks: [],
    families: runtimeToolFamilies,
    toolContext,
  });

  return createCodemodeAutomationRunResult({ result, context });
};
