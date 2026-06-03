import type { MasterFileSystem } from "@/files/master-file-system";
import type { AutomationExecutionContext } from "@/fragno/bash-runtime/bash-host";
import { runBackofficeCodemode, type BackofficeCodemodeEnv } from "@/fragno/codemode/execute";
import type { AutomationsRuntime } from "@/fragno/runtime-tools/families/automations";
import type { EventRuntime } from "@/fragno/runtime-tools/families/event";
import type { OtpRuntime } from "@/fragno/runtime-tools/families/otp";
import type { TelegramRuntime } from "@/fragno/runtime-tools/families/telegram";
import {
  getAvailableRuntimeTools,
  type BackofficeToolContext,
} from "@/fragno/runtime-tools/runtime-tools";
import { automationRuntimeToolFamilies } from "@/fragno/runtime-tools/tool-families";

import { createAutomationRunResult, type AutomationRunResult } from "../run-result";
import { createAutomationExecutionFileSystem } from "./execution-file-system";

type AutomationCodemodeToolContext = BackofficeToolContext<{
  automations?: AutomationsRuntime;
  event?: EventRuntime;
  otp?: OtpRuntime;
  telegram?: TelegramRuntime;
}>;

const createAutomationToolRuntimeContext = (
  context: AutomationExecutionContext,
): AutomationCodemodeToolContext => ({
  runtimes: {
    automations: context.automations?.runtime,
    event: context.automation.runtime,
    otp: context.otp?.runtime,
    telegram: context.telegram?.runtime,
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
