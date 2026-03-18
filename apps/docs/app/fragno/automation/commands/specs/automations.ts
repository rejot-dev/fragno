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
      "automations.identity.lookup-binding checks whether an external actor is already linked in automation identity bindings.",
    options: [
      {
        name: "source",
        required: true,
        valueRequired: true,
        valueName: "source",
        description: "Identity source name (e.g. telegram)",
      },
      {
        name: "external-actor-id",
        required: true,
        valueRequired: true,
        valueName: "external-actor-id",
        description: "External actor identifier from the source",
      },
    ],
    examples: [
      "automations.identity.lookup-binding --source telegram --external-actor-id chat-123 --print user-id",
    ],
  },
  bindActor: {
    summary:
      "automations.identity.bind-actor creates or updates a linked automation identity mapping.",
    options: [
      {
        name: "source",
        required: true,
        valueRequired: true,
        valueName: "source",
        description: "Identity source name (e.g. telegram)",
      },
      {
        name: "external-actor-id",
        required: true,
        valueRequired: true,
        valueName: "external-actor-id",
        description: "External actor identifier from the source",
      },
      {
        name: "user-id",
        required: true,
        valueRequired: true,
        valueName: "user-id",
        description: "Fragno user id to bind to this external actor",
      },
    ],
    examples: [
      "automations.identity.bind-actor --source telegram --external-actor-id chat-123 --user-id user-55",
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
      externalActorId: readStringOption(parsed, "external-actor-id", true)!,
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
      externalActorId: readStringOption(parsed, "external-actor-id", true)!,
      userId: readStringOption(parsed, "user-id", true)!,
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
