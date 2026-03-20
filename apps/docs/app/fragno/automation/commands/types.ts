import type { AutomationBashEnvironment, AutomationEvent } from "../contracts";

export type AutomationCommandFormat = "text" | "json";

export type AutomationCommandOutputOptions = {
  format: AutomationCommandFormat;
  print?: string;
};

export type AutomationCommandExecutionResult<TData = unknown> = {
  data?: TData;
  stdout?: string;
  stderr?: string;
  exitCode?: number;
};

export const AUTOMATIONS_COMMANDS = [
  "automations.identity.lookup-binding",
  "automations.identity.bind-actor",
] as const;

export const OTP_COMMANDS = ["otp.identity.create-claim"] as const;

export const EVENT_COMMANDS = ["event.reply", "event.emit"] as const;

export type AutomationsCommandName = (typeof AUTOMATIONS_COMMANDS)[number];
export type OtpCommandName = (typeof OTP_COMMANDS)[number];
export type EventCommandName = (typeof EVENT_COMMANDS)[number];

export type ParsedCommand<TName extends string = string, TArgs = unknown> = {
  readonly name: TName;
  readonly args: TArgs;
  readonly output: AutomationCommandOutputOptions;
  readonly rawArgs: readonly string[];
};

export type ParsedCommandMapBase = Record<string, ParsedCommand<string, unknown>>;

export type IdentityCreateClaimArgs = {
  source: string;
  externalActorId: string;
  ttlMinutes?: number;
};

export type IdentityLookupBindingArgs = {
  source: string;
  key: string;
};

export type IdentityBindActorArgs = {
  source: string;
  key: string;
  value: string;
  description?: string;
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
  "automations.identity.lookup-binding": ParsedCommand<
    "automations.identity.lookup-binding",
    IdentityLookupBindingArgs
  >;
  "automations.identity.bind-actor": ParsedCommand<
    "automations.identity.bind-actor",
    IdentityBindActorArgs
  >;
  "otp.identity.create-claim": ParsedCommand<"otp.identity.create-claim", IdentityCreateClaimArgs>;
  "event.reply": ParsedCommand<"event.reply", EventReplyArgs>;
  "event.emit": ParsedCommand<"event.emit", EventEmitArgs>;
};

export type AutomationCommandOptionSpec = {
  name: string;
  description: string;
  required?: boolean;
  valueName?: string;
  valueRequired?: boolean;
};

export type AutomationCommandHelp = {
  summary: string;
  options: readonly AutomationCommandOptionSpec[];
  examples?: readonly string[];
};

export type AutomationCommandSpec<TName extends string = string, TArgs = unknown> = {
  name: TName;
  help: AutomationCommandHelp;
  parse: (args: string[]) => ParsedCommand<TName, TArgs>;
};

export type AutomationCommandSpecs<
  TCommandMap extends ParsedCommandMapBase = ParsedCommandByName,
  TName extends keyof TCommandMap & string = keyof TCommandMap & string,
> = {
  [TCommandName in TName]: AutomationCommandSpec<
    TCommandName,
    TCommandMap[TCommandName]["args"]
  > & {
    parse: (args: string[]) => TCommandMap[TCommandName];
  };
};

export type BashAutomationCommandResult = {
  command: string;
  output: string;
  exitCode: number;
};

export type AutomationTriggerBinding = {
  id?: string;
  source: string;
  eventType: string;
  scriptId: string;
  scriptKey?: string;
  scriptName?: string;
  scriptPath?: string;
  scriptVersion?: number;
  scriptAgent?: string | null;
  scriptEnv?: Record<string, string>;
  /** Default sentinel sorts last among bindings for the same event. */
  triggerOrder?: number;
};

export type AutomationCloudflareEnv = Record<string, string | undefined>;

export type AutomationCommandContext = {
  event: AutomationEvent;
  orgId: string | undefined;
  binding: AutomationTriggerBinding;
  idempotencyKey: string;
  bashEnv: AutomationBashEnvironment;
  cloudflareEnv: AutomationCloudflareEnv;
};

export type AutomationCommandContextValue<TContext = unknown> = TContext;

export type AutomationCommandHandler<
  TContext = unknown,
  TCommand extends ParsedCommand = ParsedCommand,
> = (
  command: TCommand,
  context: AutomationCommandContextValue<TContext>,
) =>
  | Promise<AutomationCommandExecutionResult | unknown>
  | AutomationCommandExecutionResult
  | unknown;

export type AutomationCommandHandlersFor<
  TContext = unknown,
  TCommandMap extends ParsedCommandMapBase = ParsedCommandByName,
  TName extends keyof TCommandMap & string = keyof TCommandMap & string,
> = {
  [TCommandName in TName]: AutomationCommandHandler<TContext, TCommandMap[TCommandName]>;
};

export type AutomationsCommandHandlers<TContext = unknown> = AutomationCommandHandlersFor<
  TContext,
  ParsedCommandByName,
  AutomationsCommandName
>;

export type OtpCommandHandlers<TContext = unknown> = AutomationCommandHandlersFor<
  TContext,
  ParsedCommandByName,
  OtpCommandName
>;

export type EventCommandHandlers<TContext = unknown> = AutomationCommandHandlersFor<
  TContext,
  ParsedCommandByName,
  EventCommandName
>;
