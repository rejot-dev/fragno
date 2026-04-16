import {
  assertNoPositionals,
  parseCliTokens,
  readJsonOption,
  readOutputOptions,
  readStringOption,
} from "../cli";
import type {
  AutomationCommandHelp,
  AutomationCommandSpec,
  EventEmitArgs,
  ParsedCommandByName,
} from "../types";

const HELP: { emit: AutomationCommandHelp } = {
  emit: {
    summary: "event.emit triggers another Fragno automation event.",
    options: [
      {
        name: "event-type",
        required: true,
        valueRequired: true,
        valueName: "event-type",
        description: "Event type to emit",
      },
      {
        name: "source",
        valueRequired: true,
        valueName: "source",
        description: "Event source override. Defaults to current source",
      },
      {
        name: "external-actor-id",
        valueRequired: true,
        valueName: "external-actor-id",
        description: "Actor external id override",
      },
      {
        name: "actor-type",
        valueRequired: true,
        valueName: "actor-type",
        description: "Actor type for emitted event",
      },
      {
        name: "subject-user-id",
        valueRequired: true,
        valueName: "subject-user-id",
        description: "Subject user id for emitted event",
      },
      {
        name: "payload-json",
        valueRequired: true,
        valueName: "json",
        description: "Event payload as JSON object",
      },
    ],
    examples: [
      "event.emit --event-type identity.binding.completed --source otp --format json",
      'event.emit --event-type identity.bound --payload-json \'{"plan":"basic"}\'',
    ],
  },
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

export const eventCommandSpecs = {
  "event.emit": {
    name: "event.emit",
    help: HELP.emit,
    parse: parseEventEmit,
  },
} satisfies {
  "event.emit": AutomationCommandSpec<"event.emit", EventEmitArgs>;
};
