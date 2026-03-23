import { assertNoPositionals, parseCliTokens, readOutputOptions, readStringOption } from "../cli";
import type {
  AutomationCommandHelp,
  AutomationCommandSpec,
  IdentityBindActorArgs,
  IdentityLookupBindingArgs,
  ParsedCommandByName,
} from "../types";

const HELP: {
  lookupBinding: AutomationCommandHelp;
  bindActor: AutomationCommandHelp;
} = {
  lookupBinding: {
    summary:
      "automations.identity.lookup-binding checks whether a key is already present in automation identity bindings.",
    options: [
      {
        name: "source",
        required: true,
        valueRequired: true,
        valueName: "source",
        description: "Identity source name (e.g. telegram)",
      },
      {
        name: "key",
        required: true,
        valueRequired: true,
        valueName: "key",
        description: "Storage key for this source (e.g. external chat id)",
      },
    ],
    examples: [
      "automations.identity.lookup-binding --source telegram --key chat-123 --print value",
    ],
  },
  bindActor: {
    summary: "automations.identity.bind-actor creates or updates a key/value identity binding.",
    options: [
      {
        name: "source",
        required: true,
        valueRequired: true,
        valueName: "source",
        description: "Identity source name (e.g. telegram)",
      },
      {
        name: "key",
        required: true,
        valueRequired: true,
        valueName: "key",
        description: "Storage key for this source",
      },
      {
        name: "value",
        required: true,
        valueRequired: true,
        valueName: "value",
        description: "Value to store (e.g. Fragno user id)",
      },
      {
        name: "description",
        valueRequired: true,
        valueName: "text",
        description: "Optional human-readable description of this binding",
      },
    ],
    examples: [
      "automations.identity.bind-actor --source telegram --key chat-123 --value user-55",
      'automations.identity.bind-actor --source telegram --key chat-123 --value user-55 --description "Primary device"',
    ],
  },
};

const parseAutomationsIdentityLookupBinding = (
  args: string[],
): ParsedCommandByName["automations.identity.lookup-binding"] => {
  const parsed = parseCliTokens(args);
  assertNoPositionals(parsed, "automations.identity.lookup-binding");

  return {
    name: "automations.identity.lookup-binding",
    args: {
      source: readStringOption(parsed, "source", true)!,
      key: readStringOption(parsed, "key", true)!,
    },
    output: readOutputOptions(parsed),
    rawArgs: args,
  };
};

const parseAutomationsIdentityBindActor = (
  args: string[],
): ParsedCommandByName["automations.identity.bind-actor"] => {
  const parsed = parseCliTokens(args);
  assertNoPositionals(parsed, "automations.identity.bind-actor");

  return {
    name: "automations.identity.bind-actor",
    args: {
      source: readStringOption(parsed, "source", true)!,
      key: readStringOption(parsed, "key", true)!,
      value: readStringOption(parsed, "value", true)!,
      description: readStringOption(parsed, "description"),
    },
    output: readOutputOptions(parsed),
    rawArgs: args,
  };
};

export const automationsCommandSpecs = {
  "automations.identity.lookup-binding": {
    name: "automations.identity.lookup-binding",
    help: HELP.lookupBinding,
    parse: parseAutomationsIdentityLookupBinding,
  },
  "automations.identity.bind-actor": {
    name: "automations.identity.bind-actor",
    help: HELP.bindActor,
    parse: parseAutomationsIdentityBindActor,
  },
} satisfies {
  "automations.identity.lookup-binding": AutomationCommandSpec<
    "automations.identity.lookup-binding",
    IdentityLookupBindingArgs
  >;
  "automations.identity.bind-actor": AutomationCommandSpec<
    "automations.identity.bind-actor",
    IdentityBindActorArgs
  >;
};
