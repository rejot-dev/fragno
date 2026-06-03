import { defineCommand } from "just-bash";
import type { z } from "zod";

import type { ToolProvider } from "@cloudflare/codemode";

import {
  buildCommandHelp,
  ensureTrailingNewline,
  formatCommandStdout,
  hasHelpOption,
  normalizeExecutionResult,
  parseCliTokens,
  readOutputOptions,
} from "@/fragno/automation/commands/cli";
import type {
  AutomationCommandExecutionResult,
  AutomationCommandHelp,
  AutomationCommandOutputOptions,
  BashAutomationCommandResult,
} from "@/fragno/automation/commands/types";

export type BackofficeToolContext<
  TRuntimes extends Record<string, unknown> = Record<string, unknown>,
  TScriptRunner = unknown,
> = {
  runtimes: TRuntimes;
  scriptRunner?: TScriptRunner;
};

export type BackofficeRuntimeToolCall = {
  providerName: string;
  toolName: string;
  toolId: string;
  inputSummary: string;
  status: "success" | "error";
  resultSummary?: string;
  error?: string;
};

export type BackofficeRuntimeTool<
  TInputSchema extends z.ZodType = z.ZodType,
  TOutputSchema extends z.ZodType = z.ZodType,
  TContext extends BackofficeToolContext = BackofficeToolContext,
> = {
  id: string;
  namespace: string;
  name: string;
  description: string;
  inputSchema: TInputSchema;
  outputSchema: TOutputSchema;
  execute(input: z.output<TInputSchema>, context: TContext): Promise<z.output<TOutputSchema>>;
  bash?: {
    command: string;
    help: AutomationCommandHelp;
    parse: (args: string[]) => z.input<TInputSchema>;
    format?(
      output: z.output<TOutputSchema>,
      options: AutomationCommandOutputOptions,
    ): AutomationCommandExecutionResult;
  };
};

export type AnyBackofficeRuntimeTool<
  TContext extends BackofficeToolContext = BackofficeToolContext,
> = BackofficeRuntimeTool<z.ZodType, z.ZodType, TContext>;

export const defineBackofficeRuntimeTool = <
  TInputSchema extends z.ZodType,
  TOutputSchema extends z.ZodType,
  TContext extends BackofficeToolContext = BackofficeToolContext,
>(
  tool: BackofficeRuntimeTool<TInputSchema, TOutputSchema, TContext>,
): BackofficeRuntimeTool<TInputSchema, TOutputSchema, TContext> => tool;

type CodemodeToolDescriptor = {
  description?: string;
  inputSchema: z.ZodType;
  outputSchema: z.ZodType;
  execute: (input: unknown) => Promise<unknown>;
};

const summarizeToolValue = (value: unknown) => {
  try {
    const summary = JSON.stringify(value);
    if (typeof summary === "string") {
      return summary.length > 500 ? `${summary.slice(0, 497)}...` : summary;
    }
  } catch {
    // Fall through to String(...) for unserializable values.
  }

  const summary = String(value);
  return summary.length > 500 ? `${summary.slice(0, 497)}...` : summary;
};

const executeBackofficeRuntimeTool = async <
  TInputSchema extends z.ZodType,
  TOutputSchema extends z.ZodType,
  TContext extends BackofficeToolContext,
>(
  tool: BackofficeRuntimeTool<TInputSchema, TOutputSchema, TContext>,
  input: z.input<TInputSchema>,
  context: TContext,
): Promise<z.output<TOutputSchema>> => {
  const output = await tool.execute(tool.inputSchema.parse(input), context);
  return tool.outputSchema.parse(output);
};

export const createBackofficeCodemodeProviders = <TContext extends BackofficeToolContext>({
  tools,
  context,
  toolCalls,
}: {
  tools: readonly AnyBackofficeRuntimeTool<TContext>[];
  context: TContext;
  toolCalls?: BackofficeRuntimeToolCall[];
}): ToolProvider[] => {
  const grouped = new Map<string, Record<string, CodemodeToolDescriptor>>();

  for (const tool of tools) {
    const providerTools = grouped.get(tool.namespace) ?? {};
    grouped.set(tool.namespace, providerTools);
    providerTools[tool.name] = {
      description: tool.description,
      inputSchema: tool.inputSchema,
      outputSchema: tool.outputSchema,
      execute: async (input) => {
        const call: BackofficeRuntimeToolCall = {
          providerName: tool.namespace,
          toolName: tool.name,
          toolId: tool.id,
          inputSummary: summarizeToolValue(input),
          status: "success",
        };

        try {
          const output = await executeBackofficeRuntimeTool(tool, input, context);
          call.resultSummary = summarizeToolValue(output);
          toolCalls?.push(call);
          return output;
        } catch (error) {
          call.status = "error";
          call.error = error instanceof Error ? error.message : String(error);
          toolCalls?.push(call);
          throw error;
        }
      },
    };
  }

  return [...grouped].map(([name, providerTools]) => ({ name, tools: providerTools }));
};

export const createBackofficeBashCommands = <TContext extends BackofficeToolContext>({
  tools,
  context,
  commandCallsResult,
}: {
  tools: readonly AnyBackofficeRuntimeTool<TContext>[];
  context: TContext;
  commandCallsResult: BashAutomationCommandResult[];
}) =>
  tools.flatMap((tool) => {
    if (!tool.bash) {
      return [];
    }

    const bash = tool.bash;
    return defineCommand(bash.command, async (args) => {
      const parsed = parseCliTokens(args);

      if (hasHelpOption(parsed)) {
        const output = buildCommandHelp({
          name: bash.command,
          help: bash.help,
          parse: (rawArgs) => ({
            name: bash.command,
            args: bash.parse(rawArgs),
            output: readOutputOptions(parseCliTokens(rawArgs)),
            rawArgs,
          }),
        });

        commandCallsResult.push({
          command: bash.command,
          output: output.replace(/\n$/, ""),
          exitCode: 0,
        });

        return { stdout: output, stderr: "", exitCode: 0 };
      }

      try {
        const input = bash.parse(args);
        const commandOutput = readOutputOptions(parsed);
        const output = await executeBackofficeRuntimeTool(tool, input, context);
        const result = normalizeExecutionResult(
          bash.format ? bash.format(output, commandOutput) : { data: output },
        );
        const stdout = formatCommandStdout(commandOutput, result);
        const stderr = typeof result.stderr === "string" ? result.stderr : "";
        const exitCode = typeof result.exitCode === "number" ? result.exitCode : 0;

        commandCallsResult.push({
          command: bash.command,
          output: result.stdoutEncoding === "binary" ? "<binary>" : stdout.replace(/\n$/, ""),
          exitCode,
        });

        return {
          stdout,
          stderr,
          exitCode,
          ...(result.stdoutEncoding ? { stdoutEncoding: result.stdoutEncoding } : {}),
        };
      } catch (error) {
        commandCallsResult.push({ command: bash.command, output: "", exitCode: 1 });
        return {
          stdout: "",
          stderr: ensureTrailingNewline(error instanceof Error ? error.message : String(error)),
          exitCode: 1,
        };
      }
    });
  });
