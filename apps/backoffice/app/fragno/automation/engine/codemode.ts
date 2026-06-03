import type { MasterFileSystem } from "@/files/master-file-system";
import type { BashAutomationCommandResult } from "@/fragno/automation/commands/types";
import type { AutomationExecutionContext } from "@/fragno/bash-runtime/bash-host";
import { runBackofficeCodemode, type BackofficeCodemodeEnv } from "@/fragno/codemode/execute";
import type { BackofficeRuntimeToolCall } from "@/fragno/runtime-tools/runtime-tools";

import { createAutomationExecutionFileSystem } from "./execution-file-system";

export type CodemodeAutomationRunResult = {
  runtime: "codemode";
  eventId: string;
  scriptId: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  logs: string[];
  result?: unknown;
  commandCalls: BashAutomationCommandResult[];
  toolCalls: BackofficeRuntimeToolCall[];
};

const formatCodemodeStdout = (result: unknown) => {
  if (result === undefined) {
    return "";
  }

  if (typeof result === "string") {
    return result;
  }

  return JSON.stringify(result) ?? "";
};

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
}): Promise<CodemodeAutomationRunResult> => {
  const executionFs = createAutomationExecutionFileSystem({
    masterFs,
    eventJson: JSON.stringify(context.automation.event),
  });
  const result = await runBackofficeCodemode({
    code: script,
    fs: executionFs,
    env,
  });

  return {
    runtime: "codemode",
    eventId: context.automation.event.id,
    scriptId: context.automation.binding.scriptId,
    exitCode: result.error ? 1 : 0,
    stdout: formatCodemodeStdout(result.result),
    stderr: result.error ?? "",
    logs: result.logs ?? [],
    result: result.result,
    commandCalls: [],
    toolCalls: result.toolCalls,
  };
};
