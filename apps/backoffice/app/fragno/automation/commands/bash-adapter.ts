import { defineCommand } from "just-bash";

import {
  buildCommandHelp,
  ensureTrailingNewline,
  formatCommandStdout,
  hasHelpOption,
  normalizeExecutionResult,
  parseCliTokens,
} from "./cli";
import type {
  AutomationCommandContextValue,
  AutomationCommandHandler,
  AutomationCommandHandlersFor,
  AutomationCommandSpec,
  BashAutomationCommandResult,
  ParsedCommand,
  ParsedCommandMapBase,
} from "./types";

const executeAutomationCommand = async <
  TContext,
  TName extends string,
  TArgs,
  TCommand extends ParsedCommand<TName, TArgs>,
>(
  spec: AutomationCommandSpec<TName, TArgs> & {
    parse: (args: string[]) => TCommand;
  },
  handler: AutomationCommandHandler<TContext, TCommand>,
  context: AutomationCommandContextValue<TContext>,
  args: string[],
  commandCallsResult: BashAutomationCommandResult[],
) => {
  const parsed = parseCliTokens(args);

  if (hasHelpOption(parsed)) {
    const output = buildCommandHelp(spec);
    commandCallsResult.push({
      command: spec.name,
      output: output.replace(/\n$/, ""),
      exitCode: 0,
    });

    return {
      stdout: output,
      stderr: "",
      exitCode: 0,
    };
  }

  try {
    const command = spec.parse(args) as TCommand;
    const result = normalizeExecutionResult(await handler(command, context));
    const stdout = formatCommandStdout(command.output, result);
    const stderr = typeof result.stderr === "string" ? result.stderr : "";
    const exitCode = typeof result.exitCode === "number" ? result.exitCode : 0;
    const stdoutEncoding = result.stdoutEncoding;

    commandCallsResult.push({
      command: spec.name,
      output: stdoutEncoding === "binary" ? "<binary>" : stdout.replace(/\n$/, ""),
      exitCode,
    });

    return {
      stdout,
      stderr,
      exitCode,
      ...(stdoutEncoding ? { stdoutEncoding } : {}),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    commandCallsResult.push({
      command: spec.name,
      output: "",
      exitCode: 1,
    });

    return {
      stdout: "",
      stderr: ensureTrailingNewline(message),
      exitCode: 1,
    };
  }
};

const createAutomationCommand = <
  TContext,
  TName extends string,
  TArgs,
  TCommand extends ParsedCommand<TName, TArgs>,
>(
  spec: AutomationCommandSpec<TName, TArgs> & {
    parse: (args: string[]) => TCommand;
  },
  handler: AutomationCommandHandler<TContext, TCommand>,
  context: AutomationCommandContextValue<TContext>,
  commandCallsResult: BashAutomationCommandResult[],
) =>
  defineCommand(spec.name, (args) =>
    executeAutomationCommand(spec, handler, context, args, commandCallsResult),
  );

export const createAutomationCommands = <
  TContext,
  TCommandMap extends ParsedCommandMapBase,
  TName extends keyof TCommandMap & string = keyof TCommandMap & string,
>(
  specs: readonly (AutomationCommandSpec<TName, TCommandMap[TName]["args"]> & {
    parse: (args: string[]) => TCommandMap[TName];
  })[],
  handlers: AutomationCommandHandlersFor<TContext, TCommandMap, TName>,
  context: AutomationCommandContextValue<TContext>,
  commandCallsResult: BashAutomationCommandResult[],
) => {
  return specs.map((spec) =>
    createAutomationCommand(spec, handlers[spec.name], context, commandCallsResult),
  );
};
