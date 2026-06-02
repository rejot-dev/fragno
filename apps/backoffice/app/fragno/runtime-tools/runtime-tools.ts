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

export type BackofficeToolContext = {
  runtimes: Record<string, unknown>;
  scriptRunner?: unknown;
};

export type BackofficeRuntimeTool<
  TInputSchema extends z.ZodType = z.ZodType,
  TOutputSchema extends z.ZodType = z.ZodType,
> = {
  id: string;
  namespace: string;
  name: string;
  description: string;
  inputSchema: TInputSchema;
  outputSchema: TOutputSchema;
  execute(
    input: z.output<TInputSchema>,
    context: BackofficeToolContext,
  ): Promise<z.output<TOutputSchema>>;
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

export type AnyBackofficeRuntimeTool = BackofficeRuntimeTool<z.ZodType, z.ZodType>;

export const defineBackofficeRuntimeTool = <
  TInputSchema extends z.ZodType,
  TOutputSchema extends z.ZodType,
>(
  tool: BackofficeRuntimeTool<TInputSchema, TOutputSchema>,
): BackofficeRuntimeTool<TInputSchema, TOutputSchema> => tool;

type CodemodeToolDescriptor = {
  description?: string;
  inputSchema: z.ZodType;
  outputSchema: z.ZodType;
  execute: (input: unknown) => Promise<unknown>;
};

const executeBackofficeRuntimeTool = async <
  TInputSchema extends z.ZodType,
  TOutputSchema extends z.ZodType,
>(
  tool: BackofficeRuntimeTool<TInputSchema, TOutputSchema>,
  input: z.input<TInputSchema>,
  context: BackofficeToolContext,
): Promise<z.output<TOutputSchema>> => {
  const output = await tool.execute(tool.inputSchema.parse(input), context);
  return tool.outputSchema.parse(output);
};

export const createBackofficeCodemodeProviders = ({
  tools,
  context,
}: {
  tools: readonly AnyBackofficeRuntimeTool[];
  context: BackofficeToolContext;
}): ToolProvider[] => {
  const grouped = new Map<string, Record<string, CodemodeToolDescriptor>>();

  for (const tool of tools) {
    const providerTools = grouped.get(tool.namespace) ?? {};
    grouped.set(tool.namespace, providerTools);
    providerTools[tool.name] = {
      description: tool.description,
      inputSchema: tool.inputSchema,
      outputSchema: tool.outputSchema,
      execute: (input) => executeBackofficeRuntimeTool(tool, input, context),
    };
  }

  return [...grouped].map(([name, providerTools]) => ({ name, tools: providerTools }));
};

export const createBackofficeBashCommands = ({
  tools,
  context,
  commandCallsResult,
}: {
  tools: readonly AnyBackofficeRuntimeTool[];
  context: BackofficeToolContext;
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
        const output = await executeBackofficeRuntimeTool(tool, bash.parse(args), context);
        const commandOutput = readOutputOptions(parsed);
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
