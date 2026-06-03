import { z } from "zod";

import type { BackofficeRuntimeToolCall } from "../runtime-tools/runtime-tools";

export type AutomationRunRuntime = "bash" | "codemode";

export type AutomationCommandCallResult = {
  command: string;
  output: string;
  exitCode: number;
};

export type AutomationRunResult<TRuntime extends AutomationRunRuntime = AutomationRunRuntime> = {
  runtime: TRuntime;
  eventId: string;
  scriptId: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  logs: string[];
  result?: unknown;
  commandCalls: AutomationCommandCallResult[];
  toolCalls: BackofficeRuntimeToolCall[];
};

type CreateAutomationRunResultInput<TRuntime extends AutomationRunRuntime> = {
  runtime: TRuntime;
  eventId: string;
  scriptId: string;
  exitCode: number;
  stdout?: string;
  stderr?: string;
  logs?: string[];
  result?: unknown;
  commandCalls?: AutomationCommandCallResult[];
  toolCalls?: BackofficeRuntimeToolCall[];
};

export const automationCommandCallResultSchema = z.object({
  command: z.string(),
  output: z.string(),
  exitCode: z.number(),
});

export const automationRunResultSchema = z.object({
  runtime: z.enum(["bash", "codemode"]),
  eventId: z.string(),
  scriptId: z.string(),
  exitCode: z.number(),
  stdout: z.string(),
  stderr: z.string(),
  logs: z.array(z.string()),
  result: z.unknown().optional(),
  commandCalls: z.array(automationCommandCallResultSchema),
  toolCalls: z.array(
    z.object({
      providerName: z.string(),
      toolName: z.string(),
      toolId: z.string(),
      inputSummary: z.string(),
      status: z.enum(["success", "error"]),
      resultSummary: z.string().optional(),
      error: z.string().optional(),
    }),
  ),
});

export const formatAutomationResultAsStdout = (result: unknown) => {
  if (result === undefined) {
    return "";
  }

  if (typeof result === "string") {
    return result;
  }

  return JSON.stringify(result) ?? "";
};

export const createAutomationRunResult = <TRuntime extends AutomationRunRuntime>({
  result,
  stdout,
  stderr,
  logs,
  commandCalls,
  toolCalls,
  ...input
}: CreateAutomationRunResultInput<TRuntime>): AutomationRunResult<TRuntime> => {
  const normalized = {
    ...input,
    stdout: stdout ?? formatAutomationResultAsStdout(result),
    stderr: stderr ?? "",
    logs: logs ?? [],
    commandCalls: commandCalls ?? [],
    toolCalls: toolCalls ?? [],
  };

  return result === undefined ? normalized : { ...normalized, result };
};
