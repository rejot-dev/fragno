import { automationsCommandSpecs } from "./specs/automations";
import { eventCommandSpecs } from "./specs/events";
import { otpCommandSpecs } from "./specs/otp";
import {
  AUTOMATIONS_COMMANDS,
  EVENT_COMMANDS,
  OTP_COMMANDS,
  type AutomationCommandSpecs,
  type AutomationsCommandName,
  type EventCommandName,
  type OtpCommandName,
  type ParsedCommandByName,
} from "./types";

const AUTOMATIONS_COMMAND_SPECS: AutomationCommandSpecs<
  ParsedCommandByName,
  AutomationsCommandName
> = automationsCommandSpecs;

const OTP_COMMAND_SPECS: AutomationCommandSpecs<ParsedCommandByName, OtpCommandName> =
  otpCommandSpecs;

const EVENT_COMMAND_SPECS: AutomationCommandSpecs<ParsedCommandByName, EventCommandName> =
  eventCommandSpecs;

export const AUTOMATIONS_COMMAND_SPEC_LIST = AUTOMATIONS_COMMANDS.map(
  (name) => AUTOMATIONS_COMMAND_SPECS[name],
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
