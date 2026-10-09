import { backofficeApiV0 } from "@fragno-dev/backoffice-api/v0";
import {
  isBackofficePermissionRequirement,
  type BackofficePermission,
  type BackofficePermissionNamespace,
  type BackofficePermissionRequirement,
} from "@fragno-dev/backoffice-api/v0/shared/permissions";
import type { BackofficeContextScope } from "@fragno-dev/backoffice-api/v0/shared/scope";
import type { ToolProvider } from "@fragno-dev/codemode/runtime-api";
import { defineCommand } from "just-bash";
import type { z } from "zod";

import { unrestrictedBackofficeAuthorityResolver } from "@/backoffice-runtime/authority-resolver";
import type { BackofficeExecutionContext } from "@/backoffice-runtime/context";
import {
  BackofficeForbiddenError,
  BackofficeKernel,
  isBackofficeForbiddenError,
  noopBackofficeKernelObserver,
  type BackofficeForbiddenErrorDetails,
} from "@/backoffice-runtime/kernel";
import { AUTOMATION_SYSTEM_INITIATOR } from "@/fragno/automation/actors";
import type { BackofficeCapabilityId } from "@/fragno/backoffice-capabilities/backoffice-capabilities";
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
> = {
  runtimes: TRuntimes;
  execution: BackofficeExecutionContext;
  kernel: BackofficeKernel;
  createScopedContext(scope: BackofficeContextScope): BackofficeToolContext<TRuntimes>;
};

export const createTrustedSystemBackofficeToolContext = <
  TRuntimes extends Record<string, unknown> = Record<string, unknown>,
>({
  runtimes,
}: {
  runtimes: TRuntimes;
}): BackofficeToolContext<TRuntimes> => {
  const kernel = new BackofficeKernel({
    authorityResolver: unrestrictedBackofficeAuthorityResolver,
    kernelObserver: noopBackofficeKernelObserver,
  });
  const createContext = (scope: BackofficeContextScope): BackofficeToolContext<TRuntimes> => ({
    runtimes,
    execution: {
      kind: "deferred",
      scopeRestriction: null,
      scope,
      actors: {
        initiator: AUTOMATION_SYSTEM_INITIATOR,
        principal: null,
        delegation: [],
      },
    },
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
  TBashInput = z.input<TInputSchema>,
> = {
  command: string;
  help: AutomationCommandHelp;
  parse: (args: string[]) => TBashInput;
  outputOptions?(args: string[], parsed: ParsedCliTokens): AutomationCommandOutputOptions;
  format?(
    output: z.output<TOutputSchema>,
    options: AutomationCommandOutputOptions,
  ): AutomationCommandExecutionResult;
  execute?(options: {
    input: TBashInput;
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
  TBashInput = z.input<TInputSchema>,
> = {
  bash?: BackofficeRuntimeToolBashAdapter<TInputSchema, TOutputSchema, TContext, TBashInput>;
};

export type BackofficeRuntimeToolReferenceHints = {
  codemode?: {
    description?: string;
    inputTypeName?: string;
    outputTypeName?: string;
  };
  workflow?: {
    summary?: string;
    description?: string;
  };
};

export type BackofficeRuntimeTool<
  TInputSchema extends z.ZodType = z.ZodType,
  TOutputSchema extends z.ZodType = z.ZodType,
  TContext extends BackofficeToolContext = BackofficeToolContext,
  TBashInput = z.input<TInputSchema>,
> = {
  id: string;
  namespace: string;
  name: string;
  capabilityId?: BackofficeCapabilityId;
  authorizationNamespace?: BackofficePermissionNamespace;
  description: string;
  requiredPermissions: readonly BackofficePermission[];
  getResource?(input: z.output<TInputSchema>): unknown;
  inputSchema: TInputSchema;
  outputSchema: TOutputSchema;
  /** Secret-bearing output is returned to the caller but omitted from tool-call records. */
  resultLogging: "summary" | "redacted";
  /** Returns the output schema's input; callers receive it parsed, e.g. with dates as ISO strings. */
  execute(input: z.output<TInputSchema>, context: TContext): Promise<z.input<TOutputSchema>>;
  adapters?: BackofficeRuntimeToolAdapters<TInputSchema, TOutputSchema, TContext, TBashInput>;
  reference?: BackofficeRuntimeToolReferenceHints;
};

export type AnyBackofficeRuntimeTool = BackofficeRuntimeTool;

export type BackofficeRuntimeToolFamily = {
  namespace: string;
  permissions: Readonly<Record<string, string>>;
  tools: readonly AnyBackofficeRuntimeTool[];
  hidden?: boolean;
  isAvailable?: (context: BackofficeToolContext) => boolean;
};

type BackofficeApiOperations = typeof backofficeApiV0.operations;

/**
 * Tools that are API operations take their id, description, and schemas from the current API
 * version, so Bash, Codemode, and HTTP callers share one contract.
 */
export function backofficeApiOperationToolFields<TId extends keyof BackofficeApiOperations>(
  id: TId,
): {
  id: TId;
  description: string;
  inputSchema: BackofficeApiOperations[TId]["input"];
  outputSchema: BackofficeApiOperations[TId]["output"];
} {
  const { description, input, output } = backofficeApiV0.operations[id];
  return { id, description, inputSchema: input, outputSchema: output };
}

export function defineBackofficeRuntimeTool<
  TInputSchema extends z.ZodType,
  TOutputSchema extends z.ZodType,
  TContext extends BackofficeToolContext = BackofficeToolContext,
  TBashInput = z.input<TInputSchema>,
>(
  tool: Omit<
    BackofficeRuntimeTool<TInputSchema, TOutputSchema, TContext, TBashInput>,
    "resultLogging"
  >,
  resultLogging: "summary" | "redacted" = "summary",
): BackofficeRuntimeTool<TInputSchema, TOutputSchema, TContext, TBashInput> {
  const authorizationNamespace = tool.authorizationNamespace ?? tool.namespace;
  for (const permission of tool.requiredPermissions) {
    if (!isBackofficePermissionRequirement({ namespace: authorizationNamespace, permission })) {
      throw new Error(
        `Runtime tool '${tool.id}' requires unknown permission '${authorizationNamespace}.${permission}'.`,
      );
    }
  }
  return { ...tool, resultLogging };
}

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
  tools: readonly BackofficeRuntimeTool<z.ZodType, z.ZodType, TContext, unknown>[];
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
  inputMode: "none" | "value";
  outputSchema: z.ZodType;
  execute: (input: unknown) => Promise<unknown>;
};

function runtimeToolInputMode(schema: z.ZodType): CodemodeToolDescriptor["inputMode"] {
  return schema._zod.def.type === "void" ? "none" : "value";
}

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

function runtimeToolAuthorizationError(
  tool: AnyBackofficeRuntimeTool,
  operation: BackofficePermissionRequirement,
  cause: BackofficeForbiddenErrorDetails,
): BackofficeForbiddenError {
  return new BackofficeForbiddenError(
    [
      `Permission denied for ${tool.namespace}.${tool.name}.`,
      `Action: ${tool.description}`,
      `Required permission: ${operation.namespace}.${operation.permission}.`,
      `Reason: ${cause.message}`,
    ].join("\n"),
    cause.reason,
  );
}

const authorizeBackofficeRuntimeTool = async (
  tool: AnyBackofficeRuntimeTool,
  parsedInput: unknown,
  context: BackofficeToolContext,
) => {
  const namespace = tool.authorizationNamespace ?? tool.namespace;
  const resource = tool.getResource?.(parsedInput) ?? { kind: "runtime-tool", toolId: tool.id };

  // TODO: Express this ordered authorization chain without triggering async-await-in-loop.
  for (const permission of tool.requiredPermissions) {
    const operation = { namespace, permission };
    if (!isBackofficePermissionRequirement(operation)) {
      throw new Error(
        `Runtime tool '${tool.id}' requires unknown permission '${namespace}.${permission}'.`,
      );
    }

    try {
      await context.kernel.assertAuthorized({
        execution: context.execution,
        operation,
        resource,
      });
    } catch (error) {
      if (isBackofficeForbiddenError(error)) {
        throw runtimeToolAuthorizationError(tool, operation, error);
      }
      throw error;
    }
  }
};

/** Authorizes each invocation and returns the output established by the selected tool's schema. */
export async function executeBackofficeRuntimeTool<TTool extends AnyBackofficeRuntimeTool>(
  tool: TTool,
  input: unknown,
  context: BackofficeToolContext,
): Promise<z.output<TTool["outputSchema"]>> {
  const parsedInput = tool.inputSchema.parse(input);
  await authorizeBackofficeRuntimeTool(tool, parsedInput, context);
  const output = await tool.execute(parsedInput, context);
  return tool.outputSchema.parse(output) as z.output<TTool["outputSchema"]>;
}

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
      inputMode: runtimeToolInputMode(tool.inputSchema),
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
          call.resultSummary =
            tool.resultLogging === "redacted" ? "[redacted]" : summarizeToolValue(output);
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
          await authorizeBackofficeRuntimeTool(tool, tool.inputSchema.parse(input), context);
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
          output:
            tool.resultLogging === "redacted"
              ? "[redacted]"
              : result.stdoutEncoding === "binary"
                ? "<binary>"
                : stdout.replace(/\n$/, ""),
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
