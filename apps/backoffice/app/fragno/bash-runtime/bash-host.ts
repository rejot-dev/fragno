import { Bash } from "just-bash";

import type { BashAutomationCommandResult } from "../automation/commands/types";
import {
  createAutomationsBashCommands,
  type RegisteredAutomationsBashCommandContext,
} from "./automations-bash-runtime";
import {
  createEventBashCommands,
  type RegisteredEventBashCommandContext,
} from "./event-bash-runtime";
import { createOtpBashCommands, type RegisteredOtpBashCommandContext } from "./otp-bash-runtime";
import { createPiBashCommands, type RegisteredPiBashCommandContext } from "./pi-bash-runtime";
import {
  createResendBashCommands,
  type RegisteredResendBashCommandContext,
} from "./resend-bash-runtime";
import {
  createTelegramBashCommands,
  type RegisteredTelegramBashCommandContext,
} from "./telegram-bash-runtime";

export type BashHostContext = {
  automation: RegisteredEventBashCommandContext | null;
  automations: RegisteredAutomationsBashCommandContext | null;
  otp: RegisteredOtpBashCommandContext | null;
  pi: RegisteredPiBashCommandContext | null;
  resend: RegisteredResendBashCommandContext | null;
  telegram: RegisteredTelegramBashCommandContext | null;
};

export const EMPTY_BASH_HOST_CONTEXT: BashHostContext = {
  automation: null,
  automations: null,
  otp: null,
  pi: null,
  resend: null,
  telegram: null,
};

type BashOptions = NonNullable<ConstructorParameters<typeof Bash>[0]>;

type CreateBashHostInput = {
  fs: BashOptions["fs"];
  env?: BashOptions["env"];
  sessionId?: string;
  context: BashHostContext;
  commandCallsResult?: BashAutomationCommandResult[];
};

type BashHost = {
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
      customCommands: [
        ...createAutomationsBashCommands(commandInput),
        ...createOtpBashCommands(commandInput),
        ...createEventBashCommands(commandInput),
        ...createPiBashCommands(commandInput),
        ...createResendBashCommands(commandInput),
        ...createTelegramBashCommands(commandInput),
      ],
    }),
    sessionId: input.sessionId,
    context: input.context,
    commandCallsResult,
  };
};
