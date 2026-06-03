import type { MasterFileSystem } from "@/files/master-file-system";
import type { AutomationExecutionContext } from "@/fragno/bash-runtime/bash-host";
import { runBackofficeCodemode, type BackofficeCodemodeEnv } from "@/fragno/codemode/execute";
import {
  automationIdentityRuntimeTools,
  type AutomationsRuntime,
} from "@/fragno/runtime-tools/families/automations";
import { eventRuntimeTools, type EventRuntime } from "@/fragno/runtime-tools/families/event";
import type {
  AnyBackofficeRuntimeTool,
  BackofficeToolContext,
} from "@/fragno/runtime-tools/runtime-tools";

import { createAutomationRunResult, type AutomationRunResult } from "../run-result";
import { createAutomationExecutionFileSystem } from "./execution-file-system";

type AutomationCodemodeToolContext = BackofficeToolContext<{
  automations?: AutomationsRuntime;
  event?: EventRuntime;
}>;

const createAutomationToolRuntimeContext = (
  context: AutomationExecutionContext,
): AutomationCodemodeToolContext => ({
  runtimes: {
    automations: context.automations?.runtime,
    event: context.automation.runtime,
  },
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
  });
  const toolContext = createAutomationToolRuntimeContext(context);
  const tools: AnyBackofficeRuntimeTool<AutomationCodemodeToolContext>[] = [
    ...automationIdentityRuntimeTools,
    ...eventRuntimeTools,
  ];
  const result = await runBackofficeCodemode({
    code: script,
    fs: executionFs,
    env,
    tools: context.automations ? tools : eventRuntimeTools,
    context: toolContext,
  });

  return createAutomationRunResult({
    runtime: "codemode",
    eventId: context.automation.event.id,
    scriptId: context.automation.binding.scriptId,
    exitCode: result.error ? 1 : 0,
    stderr: result.error ?? "",
    logs: result.logs ?? [],
    result: result.result,
    toolCalls: result.toolCalls,
  });
};
