import { Bash } from "just-bash";

import {
  createBackofficeBashCommands,
  getAvailableRuntimeTools,
  type BackofficeToolContext,
} from "@/fragno/runtime-tools/runtime-tools";
import { bashRuntimeToolFamilies } from "@/fragno/runtime-tools/tool-families";

import type { AutomationCommandContext, BashAutomationCommandResult } from "./automation-types";
import type {
  AutomationsRuntime,
  ScriptRunnerRuntime,
  WorkflowsRuntime,
} from "./families/automations";
import type { EventRuntime } from "./families/event-runtime";
import type { RegisteredOtpCommandContext } from "./families/otp-runtime";
import type { RegisteredPiCommandContext } from "./families/pi-runtime";
import type { RegisteredResendCommandContext } from "./families/resend-runtime";
import type { RegisteredReson8CommandContext } from "./families/reson8-runtime";
import type { SandboxRuntime } from "./families/sandbox-runtime";
import type { RegisteredTelegramCommandContext } from "./families/telegram-runtime";

export type RegisteredAutomationsBashCommandContext = {
  runtime: AutomationsRuntime;
  scriptRunner?: ScriptRunnerRuntime;
};

export type RegisteredEventBashCommandContext = AutomationCommandContext & {
  runtime: EventRuntime;
};

export type BashHostContext = {
  automation: RegisteredEventBashCommandContext | null;
  automations: RegisteredAutomationsBashCommandContext | null;
  workflow?: { runtime: WorkflowsRuntime } | null;
  otp: RegisteredOtpCommandContext | null;
  pi: RegisteredPiCommandContext | null;
  reson8: RegisteredReson8CommandContext | null;
  resend: RegisteredResendCommandContext | null;
  sandbox?: { runtime: SandboxRuntime } | null;
  telegram: RegisteredTelegramCommandContext | null;
};

export const EMPTY_BASH_HOST_CONTEXT: BashHostContext = {
  automation: null,
  automations: null,
  workflow: null,
  otp: null,
  pi: null,
  reson8: null,
  resend: null,
  sandbox: null,
  telegram: null,
};

export type InteractiveBashCommandContext = Omit<BashHostContext, "automation"> & {
  automation: null;
  automations: NonNullable<BashHostContext["automations"]>;
  workflow?: BashHostContext["workflow"];
  otp: NonNullable<BashHostContext["otp"]>;
  pi: NonNullable<BashHostContext["pi"]>;
  reson8: NonNullable<BashHostContext["reson8"]>;
  resend: NonNullable<BashHostContext["resend"]>;
  sandbox?: BashHostContext["sandbox"];
  telegram: NonNullable<BashHostContext["telegram"]>;
};

type BashOptions = NonNullable<ConstructorParameters<typeof Bash>[0]>;

type CreateBashHostInput = {
  fs: BashOptions["fs"];
  env?: BashOptions["env"];
  sessionId?: string;
  context: BashHostContext;
  commandCallsResult?: BashAutomationCommandResult[];
};

export type BashHost = {
  bash: Bash;
  sessionId?: string;
  context: BashHostContext;
  commandCallsResult: BashAutomationCommandResult[];
};

export type BashCommandFactoryInput = {
  sessionId?: string;
  commandCallsResult: BashAutomationCommandResult[];
  context: BashHostContext;
};

export const createBashToolContext = (context: BashHostContext): BackofficeToolContext => ({
  runtimes: {
    automations: context.automations?.runtime,
    workflow: context.workflow?.runtime,
    event: context.automation?.runtime,
    otp: context.otp?.runtime,
    pi: context.pi?.runtime,
    resend: context.resend?.runtime,
    reson8: context.reson8?.runtime,
    sandbox: context.sandbox?.runtime,
    telegram: context.telegram?.runtime,
  },
  scriptRunner: context.automations?.scriptRunner,
});

const createRegisteredBashCommands = (input: BashCommandFactoryInput) => {
  const context = createBashToolContext(input.context);
  const tools = getAvailableRuntimeTools({ families: bashRuntimeToolFamilies, context });

  return createBackofficeBashCommands({
    tools,
    context,
    commandCallsResult: input.commandCallsResult,
  });
};

export const createBashHost = (input: CreateBashHostInput): BashHost => {
  const commandCallsResult = input.commandCallsResult ?? [];
  const commandInput: BashCommandFactoryInput = {
    sessionId: input.sessionId,
    commandCallsResult,
    context: input.context,
  };

  return {
    bash: new Bash({
      fs: input.fs,
      env: input.env,
      customCommands: createRegisteredBashCommands(commandInput),
    }),
    sessionId: input.sessionId,
    context: input.context,
    commandCallsResult,
  };
};
