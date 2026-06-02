import { automationsRuntimeTools } from "@/fragno/runtime-tools/families/automations";
import type { AnyBackofficeRuntimeTool } from "@/fragno/runtime-tools/runtime-tools";

import { parseCliTokens, readOutputOptions } from "./cli";
import { eventCommandSpecs } from "./specs/events";
import { otpCommandSpecs } from "./specs/otp";
import {
  EVENT_COMMANDS,
  OTP_COMMANDS,
  type AutomationCommandSpecs,
  type AutomationsCommandName,
  type EventCommandName,
  type OtpCommandName,
  type ParsedCommandByName,
} from "./types";

const toCommandSpec = (tool: AnyBackofficeRuntimeTool) => {
  if (!tool.bash) {
    throw new Error(`Runtime tool ${tool.id} does not define a bash command`);
  }

  const { command, help, parse } = tool.bash;
  return {
    name: command,
    help,
    parse: (args: string[]) => ({
      name: command,
      args: parse(args),
      output: readOutputOptions(parseCliTokens(args)),
      rawArgs: args,
    }),
  };
};

const OTP_COMMAND_SPECS: AutomationCommandSpecs<ParsedCommandByName, OtpCommandName> =
  otpCommandSpecs;

const EVENT_COMMAND_SPECS: AutomationCommandSpecs<ParsedCommandByName, EventCommandName> =
  eventCommandSpecs;

export const AUTOMATIONS_COMMAND_SPEC_LIST = automationsRuntimeTools.map(
  toCommandSpec,
) as readonly AutomationCommandSpecs<
  ParsedCommandByName,
  AutomationsCommandName
>[AutomationsCommandName][];

export const OTP_COMMAND_SPEC_LIST = OTP_COMMANDS.map(
  (name) => OTP_COMMAND_SPECS[name],
) as readonly AutomationCommandSpecs<ParsedCommandByName, OtpCommandName>[OtpCommandName][];

export const EVENT_COMMAND_SPEC_LIST = EVENT_COMMANDS.map(
  (name) => EVENT_COMMAND_SPECS[name],
) as readonly AutomationCommandSpecs<ParsedCommandByName, EventCommandName>[EventCommandName][];
