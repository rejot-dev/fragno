import { defineCommand } from "just-bash";
import type { z } from "zod";

import {
  type BackofficeContextScope,
  type BackofficePrincipal,
} from "@/backoffice-runtime/context";
import { BackofficeKernel } from "@/backoffice-runtime/kernel";
import type { BackofficeCapabilityId } from "@/fragno/backoffice-capabilities/backoffice-capabilities";
import type { ToolProvider } from "@/fragno/codemode/codemode-executor";
import type {
  AutomationCommandExecutionResult,
  AutomationCommandHelp,
  AutomationCommandOutputOptions,
  BashAutomationCommandResult,
} from "@/fragno/runtime-tools/automation-types";
import {
  buildCommandHelp,
  ensureTrailingNewline,
  formatCommandStdout,
  hasHelpOption,
  normalizeExecutionResult,
  parseCliTokens,
  readOutputOptions,
  type ParsedCliTokens,
} from "@/fragno/runtime-tools/bash-cli";

export type BackofficeToolContext<
  TRuntimes extends Record<string, unknown> = Record<string, unknown>,
  TDefaults extends Record<string, unknown> = Record<string, unknown>,
> = {
  runtimes: TRuntimes;
  defaults?: TDefaults;
  actor: BackofficePrincipal;
  scope: BackofficeContextScope;
  kernel: BackofficeKernel;
  createScopedContext(scope: BackofficeContextScope): BackofficeToolContext<TRuntimes, TDefaults>;
};

export const createTrustedSystemBackofficeToolContext = <
  TRuntimes extends Record<string, unknown> = Record<string, unknown>,
  TDefaults extends Record<string, unknown> = Record<string, unknown>,
>({
  runtimes,
  defaults,
}: {
  runtimes: TRuntimes;
  defaults?: TDefaults;
}): BackofficeToolContext<TRuntimes, TDefaults> => {
  const kernel = new BackofficeKernel({});
  const createContext = (
    scope: BackofficeContextScope,
  ): BackofficeToolContext<TRuntimes, TDefaults> => ({
    runtimes,
    ...(typeof defaults === "undefined" ? {} : { defaults }),
    actor: { type: "system", id: "system" },
    scope,
    kernel,
    createScopedContext: createContext,
  });
  return createContext({ kind: "system" });
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

export type BackofficeBashShellContext = {
  cwd: string;
  fs: {
    resolvePath(cwd: string, path: string): string;
    readFileBuffer?(path: string): Promise<ArrayBuffer | Uint8Array> | ArrayBuffer | Uint8Array;
    writeFile(path: string, content: string | Uint8Array): Promise<void> | void;
  };
};

export type BackofficeRuntimeToolBashAdapter<
  TInputSchema extends z.ZodType = z.ZodType,
  TOutputSchema extends z.ZodType = z.ZodType,
  TContext extends BackofficeToolContext = BackofficeToolContext,
> = {
  command: string;
  help: AutomationCommandHelp;
  parse: (args: string[]) => z.input<TInputSchema>;
  outputOptions?(args: string[], parsed: ParsedCliTokens): AutomationCommandOutputOptions;
  format?(
    output: z.output<TOutputSchema>,
    options: AutomationCommandOutputOptions,
  ): AutomationCommandExecutionResult;
  execute?(options: {
    input: z.input<TInputSchema>;
    args: string[];
    context: TContext;
    commandOutput: AutomationCommandOutputOptions;
    shell: BackofficeBashShellContext;
  }): unknown;
};

export type BackofficeRuntimeToolAdapters<
  TInputSchema extends z.ZodType = z.ZodType,
  TOutputSchema extends z.ZodType = z.ZodType,
  TContext extends BackofficeToolContext = BackofficeToolContext,
> = {
  bash?: BackofficeRuntimeToolBashAdapter<TInputSchema, TOutputSchema, TContext>;
};

export type BackofficeRuntimeToolReferenceHints = {
  codemode?: {
    description?: string;
    inputTypeName?: string;
    outputTypeName?: string;
  };
};

export type BackofficeRuntimeTool<
  TInputSchema extends z.ZodType = z.ZodType,
  TOutputSchema extends z.ZodType = z.ZodType,
  TContext extends BackofficeToolContext = BackofficeToolContext,
> = {
  id: string;
  namespace: string;
  name: string;
  capabilityId?: BackofficeCapabilityId;
  authorizationNamespace?: string;
  description: string;
  requiredPermissions: readonly string[];
  getResource?(input: z.output<TInputSchema>): unknown;
  inputSchema: TInputSchema;
  outputSchema: TOutputSchema;
  execute(input: z.output<TInputSchema>, context: TContext): Promise<z.output<TOutputSchema>>;
  adapters?: BackofficeRuntimeToolAdapters<TInputSchema, TOutputSchema, TContext>;
  reference?: BackofficeRuntimeToolReferenceHints;
};

export type AnyBackofficeRuntimeTool = BackofficeRuntimeTool<
  z.ZodType,
  z.ZodType,
  BackofficeToolContext
>;

export type BackofficeRuntimeToolFamily = {
  namespace: string;
  permissions: Readonly<Record<string, string>>;
  tools: readonly AnyBackofficeRuntimeTool[];
  hidden?: boolean;
  isAvailable?: (context: BackofficeToolContext) => boolean;
};

export const defineBackofficeRuntimeTool = <
  TInputSchema extends z.ZodType,
  TOutputSchema extends z.ZodType,
  TContext extends BackofficeToolContext = BackofficeToolContext,
>(
  tool: BackofficeRuntimeTool<TInputSchema, TOutputSchema, TContext>,
): BackofficeRuntimeTool<TInputSchema, TOutputSchema, TContext> => tool;

export const defineBackofficeRuntimeToolFamily = <
  TContext extends BackofficeToolContext = BackofficeToolContext,
>({
  namespace,
  permissions,
  tools,
  hidden,
  isAvailable,
}: {
  namespace: string;
  permissions: Readonly<Record<string, string>>;
  tools: readonly BackofficeRuntimeTool<z.ZodType, z.ZodType, TContext>[];
  hidden?: boolean;
  isAvailable?: (context: TContext) => boolean;
}): BackofficeRuntimeToolFamily => {
  const declaredPermissions = { ...permissions };
  for (const tool of tools) {
    for (const permission of tool.requiredPermissions) {
      if (!declaredPermissions[permission]) {
        throw new Error(
          `Runtime tool '${tool.id}' requires undeclared permission '${permission}' in family '${namespace}'.`,
        );
      }
    }
  }

  return {
    namespace,
    permissions: declaredPermissions,
    tools: tools as readonly AnyBackofficeRuntimeTool[],
    ...(hidden ? { hidden } : {}),
    ...(isAvailable
      ? { isAvailable: (context: BackofficeToolContext) => isAvailable(context as TContext) }
      : {}),
  };
};

export const getAvailableRuntimeTools = ({
  families,
  context,
}: {
  families: readonly BackofficeRuntimeToolFamily[];
  context: BackofficeToolContext;
}): AnyBackofficeRuntimeTool[] => {
  return families.flatMap((family) => {
    if (family.isAvailable && !family.isAvailable(context)) {
      return [];
    }
    return [...family.tools];
  });
};

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

const defaultRuntimeToolResource = (input: unknown) => {
  if (!input || typeof input !== "object") {
    return undefined;
  }

  const record = input as Record<string, unknown>;
  for (const key of ["slug", "path", "workflowName", "capabilityId", "id", "key", "sandboxId"]) {
    if (typeof record[key] === "string" && record[key].trim()) {
      return { [key]: record[key] };
    }
  }

  return undefined;
};

export const assertBackofficeRuntimeToolAllowed = (
  tool: AnyBackofficeRuntimeTool,
  parsedInput: unknown,
  context: BackofficeToolContext,
) => {
  context.kernel.assertAllowed({
    actor: context.actor,
    scope: context.scope,
    requiredPermissions: tool.requiredPermissions.map((permission) => ({
      namespace: tool.authorizationNamespace ?? tool.namespace,
      permission,
    })),
    resource: tool.getResource
      ? tool.getResource(parsedInput as never)
      : defaultRuntimeToolResource(parsedInput),
  });
};

export const executeBackofficeRuntimeTool = async (
  tool: AnyBackofficeRuntimeTool,
  input: unknown,
  context: BackofficeToolContext,
): Promise<unknown> => {
  const parsedInput = tool.inputSchema.parse(input);
  assertBackofficeRuntimeToolAllowed(tool, parsedInput, context);
  const output = await tool.execute(parsedInput, context);
  return tool.outputSchema.parse(output);
};

export const createBackofficeCodemodeProviders = ({
  tools,
  context,
  toolCalls,
}: {
  tools: readonly AnyBackofficeRuntimeTool[];
  context: BackofficeToolContext;
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
    const bash = tool.adapters?.bash;
    if (!bash) {
      return [];
    }

    return defineCommand(bash.command, async (args, shell) => {
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
        const commandOutput = bash.outputOptions
          ? bash.outputOptions(args, parsed)
          : readOutputOptions(parsed);
        let rawResult: unknown;
        if (bash.execute) {
          assertBackofficeRuntimeToolAllowed(tool, input, context);
          rawResult = await bash.execute({
            input,
            args,
            context,
            commandOutput,
            shell: shell as unknown as BackofficeBashShellContext,
          });
        } else if (bash.format) {
          rawResult = bash.format(
            await executeBackofficeRuntimeTool(tool, input, context),
            commandOutput,
          );
        } else {
          rawResult = { data: await executeBackofficeRuntimeTool(tool, input, context) };
        }
        const result = normalizeExecutionResult(rawResult);
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
