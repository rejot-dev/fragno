import { z } from "zod";

import type { BackofficeCodemodeWorkflowDefinition } from "../codemode/execute";

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
  workflowDefinition?: BackofficeCodemodeWorkflowDefinition;
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
  workflowDefinition?: BackofficeCodemodeWorkflowDefinition;
};

const automationCommandCallResultSchema = z.object({
  command: z.string(),
  output: z.string(),
  exitCode: z.number(),
});

const automationWorkflowDefinitionSchema = z.object({
  name: z.string(),
  options: z.unknown().optional(),
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
  workflowDefinition: automationWorkflowDefinitionSchema.optional(),
  commandCalls: z.array(automationCommandCallResultSchema),
});

const formatAutomationResultAsStdout = (result: unknown) => {
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
  workflowDefinition,
  ...input
}: CreateAutomationRunResultInput<TRuntime>): AutomationRunResult<TRuntime> => {
  const normalized = {
    ...input,
    stdout: stdout ?? formatAutomationResultAsStdout(result),
    stderr: stderr ?? "",
    logs: logs ?? [],
    commandCalls: commandCalls ?? [],
  };

  const withResult = result === undefined ? normalized : { ...normalized, result };
  return workflowDefinition === undefined ? withResult : { ...withResult, workflowDefinition };
};
