import { automationsRuntimeTools } from "@/fragno/runtime-tools/families/automations";
import { eventRuntimeTools } from "@/fragno/runtime-tools/families/event";
import { otpRuntimeTools } from "@/fragno/runtime-tools/families/otp";
import type { AnyBackofficeRuntimeTool } from "@/fragno/runtime-tools/runtime-tools";

import { parseCliTokens, readOutputOptions } from "./cli";
import {
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

export const AUTOMATIONS_COMMAND_SPEC_LIST = automationsRuntimeTools.map(
  toCommandSpec,
) as readonly AutomationCommandSpecs<
  ParsedCommandByName,
  AutomationsCommandName
>[AutomationsCommandName][];

export const OTP_COMMAND_SPEC_LIST = otpRuntimeTools.map(
  toCommandSpec,
) as readonly AutomationCommandSpecs<ParsedCommandByName, OtpCommandName>[OtpCommandName][];

export const EVENT_COMMAND_SPEC_LIST = eventRuntimeTools.map(
  toCommandSpec,
) as readonly AutomationCommandSpecs<ParsedCommandByName, EventCommandName>[EventCommandName][];
