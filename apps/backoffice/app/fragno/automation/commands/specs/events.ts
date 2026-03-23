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
  EventReplyArgs,
  ParsedCommandByName,
} from "../types";

const HELP: {
  reply: AutomationCommandHelp;
  emit: AutomationCommandHelp;
} = {
  reply: {
    summary: "event.reply sends a text reply through a source adapter.",
    options: [
      {
        name: "text",
        required: true,
        valueRequired: true,
        valueName: "text",
        description: "Text message to send to the actor",
      },
      {
        name: "source",
        valueRequired: true,
        valueName: "source",
        description: "Override reply source. Defaults to current event source",
      },
      {
        name: "external-actor-id",
        valueRequired: true,
        valueName: "external-actor-id",
        description: "Override actor id. Defaults to current event actor external id",
      },
    ],
    examples: [
      'event.reply --source telegram --external-actor-id user-1 --text "linked successfully"',
    ],
  },
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

export const eventCommandSpecs = {
  "event.reply": {
    name: "event.reply",
    help: HELP.reply,
    parse: parseEventReply,
  },
  "event.emit": {
    name: "event.emit",
    help: HELP.emit,
    parse: parseEventEmit,
  },
} satisfies {
  "event.reply": AutomationCommandSpec<"event.reply", EventReplyArgs>;
  "event.emit": AutomationCommandSpec<"event.emit", EventEmitArgs>;
};
