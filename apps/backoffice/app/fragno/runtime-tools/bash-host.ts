import { Bash as BashRuntime, type Bash } from "just-bash";

import type {
  BackofficeContextScope,
  BackofficeExecutionContext,
} from "@/backoffice-runtime/context";
import type { BackofficeKernel } from "@/backoffice-runtime/kernel";
import type { AutomationEventActor } from "@/fragno/automation/contracts";
import {
  createBackofficeBashCommands,
  getAvailableRuntimeTools,
} from "@/fragno/runtime-tools/runtime-tools";
import { createBackofficeToolContext } from "@/fragno/runtime-tools/tool-context";
import { runtimeToolFamilies } from "@/fragno/runtime-tools/tool-families";

import type { AutomationCommandContext, BashAutomationCommandResult } from "./automation-types";
import type { RegisteredApiCommandContext } from "./families/api-runtime";
import type { AutomationStoreRuntime } from "./families/automations-bindings";
import type { DurableHooksRuntime } from "./families/automations-durable-hooks";
import type { AutomationWorkflowRuntime } from "./families/automations-workflow";
import type { BackofficeCapabilitiesRuntime } from "./families/backoffice-capabilities";
import type { EventRuntime } from "./families/event-runtime";
import type { InternalRuntime } from "./families/internal";
import type { RegisteredMcpCommandContext } from "./families/mcp-runtime";
import type { RegisteredOtpCommandContext } from "./families/otp-runtime";
import type { RegisteredPiCommandContext } from "./families/pi-runtime";
import type { RegisteredResendCommandContext } from "./families/resend-runtime";
import type { RegisteredReson8CommandContext } from "./families/reson8-runtime";
import type { SandboxRuntime } from "./families/sandbox-runtime";
import type { RegisteredTelegramCommandContext } from "./families/telegram-runtime";
import { isomorphicGitCommand } from "./isomorphic-git-command";

export type RegisteredAutomationsBashCommandContext = {
  runtime: AutomationStoreRuntime;
};

export type RegisteredEventBashCommandContext = AutomationCommandContext & {
  runtime: EventRuntime;
};

export type BashHostContext = {
  defaultActor: AutomationEventActor | null;
  backofficeExecution: BackofficeExecutionContext;
  backofficeKernel: BackofficeKernel;
  createBackofficeScopedContext(scope: BackofficeContextScope): BashHostContext;
  backoffice: { runtime: BackofficeCapabilitiesRuntime } | null;
  automation: RegisteredEventBashCommandContext | null;
  automations: RegisteredAutomationsBashCommandContext | null;
  workflow?: { runtime: AutomationWorkflowRuntime } | null;
  durableHooks?: { runtime: DurableHooksRuntime } | null;
  internal?: { runtime: InternalRuntime } | null;
  api?: RegisteredApiCommandContext | null;
  mcp?: RegisteredMcpCommandContext | null;
  otp: RegisteredOtpCommandContext | null;
  pi: RegisteredPiCommandContext | null;
  reson8: RegisteredReson8CommandContext | null;
  resend: RegisteredResendCommandContext | null;
  sandbox?: { runtime: SandboxRuntime } | null;
  telegram: RegisteredTelegramCommandContext | null;
};

export type InteractiveBashCommandContext = Omit<BashHostContext, "automation"> & {
  automation: null;
  automations: NonNullable<BashHostContext["automations"]>;
  workflow?: BashHostContext["workflow"];
  durableHooks?: BashHostContext["durableHooks"];
  api?: BashHostContext["api"];
  mcp?: BashHostContext["mcp"];
  otp: NonNullable<BashHostContext["otp"]>;
  pi: NonNullable<BashHostContext["pi"]>;
  reson8: NonNullable<BashHostContext["reson8"]>;
  resend: NonNullable<BashHostContext["resend"]>;
  sandbox?: BashHostContext["sandbox"];
  telegram: NonNullable<BashHostContext["telegram"]>;
};

type BashOptions = NonNullable<ConstructorParameters<typeof BashRuntime>[0]>;

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

type BashCommandFactoryInput = {
  sessionId?: string;
  commandCallsResult: BashAutomationCommandResult[];
  context: BashHostContext;
};

const createRegisteredBashCommands = (input: BashCommandFactoryInput) => {
  const context = createBackofficeToolContext(input.context);
  const tools = getAvailableRuntimeTools({
    families: runtimeToolFamilies,
    context,
  });

  return [
    ...createBackofficeBashCommands({
      tools,
      context,
      commandCallsResult: input.commandCallsResult,
    }),
    isomorphicGitCommand,
  ];
};

export const createBashHost = (input: CreateBashHostInput): BashHost => {
  const commandCallsResult = input.commandCallsResult ?? [];
  const commandInput: BashCommandFactoryInput = {
    sessionId: input.sessionId,
    commandCallsResult,
    context: input.context,
  };

  return {
    bash: new BashRuntime({
      fs: input.fs,
      env: input.env,
      defenseInDepth: false,
      customCommands: createRegisteredBashCommands(commandInput),
    }),
    sessionId: input.sessionId,
    context: input.context,
    commandCallsResult,
  };
};
