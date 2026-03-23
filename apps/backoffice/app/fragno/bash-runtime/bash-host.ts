import { Bash } from "just-bash";

import type { BashAutomationCommandResult } from "../automation/commands/types";
import { createAutomationsBashCommands } from "./automations-bash-runtime";
import { createEventBashCommands } from "./event-bash-runtime";
import { createOtpBashCommands } from "./otp-bash-runtime";
import { createPiBashCommands } from "./pi-bash-runtime";
import { createResendBashCommands } from "./resend-bash-runtime";

type BashOptions = NonNullable<ConstructorParameters<typeof Bash>[0]>;

type CreateBashHostInput<TContext = unknown> = {
  fs: BashOptions["fs"];
  env?: BashOptions["env"];
  sessionId?: string;
  context: TContext;
  commandCallsResult?: BashAutomationCommandResult[];
};

type BashHost<TContext = unknown> = {
  bash: Bash;
  sessionId?: string;
  context: TContext;
  commandCallsResult: BashAutomationCommandResult[];
};

export type BashCommandFactoryInput<TContext = unknown> = {
  sessionId?: string;
  commandCallsResult: BashAutomationCommandResult[];
  context: TContext;
};

export const createBashHost = <TContext>(
  input: CreateBashHostInput<TContext>,
): BashHost<TContext> => {
  const commandCallsResult = input.commandCallsResult ?? [];
  const commandInput: BashCommandFactoryInput<TContext> = {
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
      ],
    }),
    sessionId: input.sessionId,
    context: input.context,
    commandCallsResult,
  };
};
