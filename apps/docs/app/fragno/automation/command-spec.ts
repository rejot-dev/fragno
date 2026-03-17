import { defineCommand } from "just-bash";

import {
  assertNoPositionals,
  ensureTrailingNewline,
  formatCommandStdout,
  normalizeExecutionResult,
  parseCliTokens,
  readIntegerOption,
  readJsonOption,
  readOutputOptions,
  readStringOption,
  type AutomationCommandExecutionResult,
  type AutomationCommandOutputOptions,
} from "./cli";

export const AUTOMATION_COMMANDS = [
  "identity.create-claim",
  "identity.lookup-binding",
  "identity.bind-actor",
  "event.reply",
  "event.emit",
] as const;

export type AutomationCommandName = (typeof AUTOMATION_COMMANDS)[number];

export type ParsedCommand<TName extends string = string, TArgs = unknown> = {
  readonly name: TName;
  readonly args: TArgs;
  readonly output: AutomationCommandOutputOptions;
  readonly rawArgs: readonly string[];
};

export type IdentityCreateClaimArgs = {
  source: string;
  externalActorId: string;
  ttlMinutes?: number;
};

export type IdentityLookupBindingArgs = {
  source: string;
  externalActorId: string;
};

export type IdentityBindActorArgs = {
  source: string;
  externalActorId: string;
  userId: string;
};

export type EventReplyArgs = {
  text: string;
  source?: string;
  externalActorId?: string;
};

export type EventEmitArgs = {
  eventType: string;
  source?: string;
  externalActorId?: string;
  actorType?: string;
  subjectUserId?: string;
  payload?: Record<string, unknown>;
};

export type ParsedCommandByName = {
  "identity.create-claim": ParsedCommand<"identity.create-claim", IdentityCreateClaimArgs>;
  "identity.lookup-binding": ParsedCommand<"identity.lookup-binding", IdentityLookupBindingArgs>;
  "identity.bind-actor": ParsedCommand<"identity.bind-actor", IdentityBindActorArgs>;
  "event.reply": ParsedCommand<"event.reply", EventReplyArgs>;
  "event.emit": ParsedCommand<"event.emit", EventEmitArgs>;
};

export type BashAutomationCommandResult = {
  command: string;
  output: string;
  exitCode: number;
};

export interface AutomationCommandHandlers<TContext = unknown> {
  "identity.create-claim": (
    command: ParsedCommandByName["identity.create-claim"],
    context: TContext,
  ) =>
    | Promise<AutomationCommandExecutionResult | unknown>
    | AutomationCommandExecutionResult
    | unknown;
  "identity.lookup-binding": (
    command: ParsedCommandByName["identity.lookup-binding"],
    context: TContext,
  ) =>
    | Promise<AutomationCommandExecutionResult | unknown>
    | AutomationCommandExecutionResult
    | unknown;
  "identity.bind-actor": (
    command: ParsedCommandByName["identity.bind-actor"],
    context: TContext,
  ) =>
    | Promise<AutomationCommandExecutionResult | unknown>
    | AutomationCommandExecutionResult
    | unknown;
  "event.reply": (
    command: ParsedCommandByName["event.reply"],
    context: TContext,
  ) =>
    | Promise<AutomationCommandExecutionResult | unknown>
    | AutomationCommandExecutionResult
    | unknown;
  "event.emit": (
    command: ParsedCommandByName["event.emit"],
    context: TContext,
  ) =>
    | Promise<AutomationCommandExecutionResult | unknown>
    | AutomationCommandExecutionResult
    | unknown;
}

type AutomationCommandSpec<TName extends AutomationCommandName> = {
  name: TName;
  parse: (args: string[]) => ParsedCommandByName[TName];
};

const parseIdentityCreateClaim = (args: string[]): ParsedCommandByName["identity.create-claim"] => {
  const parsed = parseCliTokens(args);
  assertNoPositionals(parsed, "identity.create-claim");

  return {
    name: "identity.create-claim",
    args: {
      source: readStringOption(parsed, "source", true)!,
      externalActorId: readStringOption(parsed, "external-actor-id", true)!,
      ttlMinutes: readIntegerOption(parsed, "ttl-minutes"),
    },
    output: readOutputOptions(parsed),
    rawArgs: args,
  };
};

const parseIdentityLookupBinding = (
  args: string[],
): ParsedCommandByName["identity.lookup-binding"] => {
  const parsed = parseCliTokens(args);
  assertNoPositionals(parsed, "identity.lookup-binding");

  return {
    name: "identity.lookup-binding",
    args: {
      source: readStringOption(parsed, "source", true)!,
      externalActorId: readStringOption(parsed, "external-actor-id", true)!,
    },
    output: readOutputOptions(parsed),
    rawArgs: args,
  };
};

const parseIdentityBindActor = (args: string[]): ParsedCommandByName["identity.bind-actor"] => {
  const parsed = parseCliTokens(args);
  assertNoPositionals(parsed, "identity.bind-actor");

  return {
    name: "identity.bind-actor",
    args: {
      source: readStringOption(parsed, "source", true)!,
      externalActorId: readStringOption(parsed, "external-actor-id", true)!,
      userId: readStringOption(parsed, "user-id", true)!,
    },
    output: readOutputOptions(parsed),
    rawArgs: args,
  };
};

const parseEventReply = (args: string[]): ParsedCommandByName["event.reply"] => {
  const parsed = parseCliTokens(args);
  assertNoPositionals(parsed, "event.reply");

  return {
    name: "event.reply",
    args: {
      text: readStringOption(parsed, "text", true)!,
      source: readStringOption(parsed, "source"),
      externalActorId: readStringOption(parsed, "external-actor-id"),
    },
    output: readOutputOptions(parsed),
    rawArgs: args,
  };
};

const parseEventEmit = (args: string[]): ParsedCommandByName["event.emit"] => {
  const parsed = parseCliTokens(args);
  assertNoPositionals(parsed, "event.emit");

  return {
    name: "event.emit",
    args: {
      eventType: readStringOption(parsed, "event-type", true)!,
      source: readStringOption(parsed, "source"),
      externalActorId: readStringOption(parsed, "external-actor-id"),
      actorType: readStringOption(parsed, "actor-type"),
      subjectUserId: readStringOption(parsed, "subject-user-id"),
      payload: readJsonOption(parsed, "payload-json"),
    },
    output: readOutputOptions(parsed),
    rawArgs: args,
  };
};

export const AUTOMATION_COMMAND_SPECS = {
  "identity.create-claim": {
    name: "identity.create-claim",
    parse: parseIdentityCreateClaim,
  },
  "identity.lookup-binding": {
    name: "identity.lookup-binding",
    parse: parseIdentityLookupBinding,
  },
  "identity.bind-actor": {
    name: "identity.bind-actor",
    parse: parseIdentityBindActor,
  },
  "event.reply": {
    name: "event.reply",
    parse: parseEventReply,
  },
  "event.emit": {
    name: "event.emit",
    parse: parseEventEmit,
  },
} satisfies {
  [TName in AutomationCommandName]: AutomationCommandSpec<TName>;
};

const executeAutomationCommand = async <TContext, TName extends AutomationCommandName>(
  spec: AutomationCommandSpec<TName>,
  handler: AutomationCommandHandlers<TContext>[TName],
  context: TContext,
  args: string[],
  commandCallsResult: BashAutomationCommandResult[],
) => {
  try {
    const command = spec.parse(args);
    const typedHandler = handler as (
      command: ParsedCommandByName[TName],
      context: TContext,
    ) =>
      | Promise<AutomationCommandExecutionResult | unknown>
      | AutomationCommandExecutionResult
      | unknown;
    const result = normalizeExecutionResult(await typedHandler(command, context));
    const stdout = formatCommandStdout(command.output, result);
    const stderr = typeof result.stderr === "string" ? result.stderr : "";
    const exitCode = typeof result.exitCode === "number" ? result.exitCode : 0;

    commandCallsResult.push({
      command: spec.name,
      output: stdout.replace(/\n$/, ""),
      exitCode,
    });

    return {
      stdout,
      stderr,
      exitCode,
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

const createAutomationCommand = <TContext, TName extends AutomationCommandName>(
  spec: AutomationCommandSpec<TName>,
  handler: AutomationCommandHandlers<TContext>[TName],
  context: TContext,
  commandCallsResult: BashAutomationCommandResult[],
) =>
  defineCommand(spec.name, (args) =>
    executeAutomationCommand(spec, handler, context, args, commandCallsResult),
  );

export const createAutomationCommands = <TContext>(
  handlers: AutomationCommandHandlers<TContext>,
  context: TContext,
  commandCallsResult: BashAutomationCommandResult[],
) => {
  return [
    createAutomationCommand(
      AUTOMATION_COMMAND_SPECS["identity.create-claim"],
      handlers["identity.create-claim"],
      context,
      commandCallsResult,
    ),
    createAutomationCommand(
      AUTOMATION_COMMAND_SPECS["identity.lookup-binding"],
      handlers["identity.lookup-binding"],
      context,
      commandCallsResult,
    ),
    createAutomationCommand(
      AUTOMATION_COMMAND_SPECS["identity.bind-actor"],
      handlers["identity.bind-actor"],
      context,
      commandCallsResult,
    ),
    createAutomationCommand(
      AUTOMATION_COMMAND_SPECS["event.reply"],
      handlers["event.reply"],
      context,
      commandCallsResult,
    ),
    createAutomationCommand(
      AUTOMATION_COMMAND_SPECS["event.emit"],
      handlers["event.emit"],
      context,
      commandCallsResult,
    ),
  ];
};

export type { AutomationCommandExecutionResult, AutomationCommandOutputOptions } from "./cli";
