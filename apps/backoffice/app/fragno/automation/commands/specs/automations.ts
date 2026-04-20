import { assertNoPositionals, parseCliTokens, readOutputOptions, readStringOption } from "../cli";
import type {
  AutomationCommandHelp,
  AutomationCommandSpec,
  IdentityBindActorArgs,
  IdentityLookupBindingArgs,
  ParsedCommandByName,
  ScriptRunArgs,
} from "../types";

const HELP: {
  lookupBinding: AutomationCommandHelp;
  bindActor: AutomationCommandHelp;
  scriptRun: AutomationCommandHelp;
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
  scriptRun: {
    summary:
      "scripts.run executes a script against an event fixture from an interactive shell context for manual testing.",
    options: [
      {
        name: "script",
        required: true,
        valueRequired: true,
        valueName: "path",
        description:
          "Path to the script file. Relative paths resolve under /workspace/automations/; absolute paths resolve against the master filesystem",
      },
      {
        name: "event",
        required: true,
        valueRequired: true,
        valueName: "path",
        description:
          "Path to an event JSON file (e.g. /events/2026-03-25/...json). The current interactive orgId is injected when the fixture omits orgId; mismatches are rejected",
      },
    ],
    examples: [
      "scripts.run --script scripts/my-script.sh --event /events/2026-03-25/2026-03-25T10:00:00.000Z_hook-id.json",
      "scripts.run --script /workspace/automations/scripts/my-script.sh --event /events/2026-03-25/2026-03-25T10:00:00.000Z_hook-id.json --format json",
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

const parseAutomationsScriptRun = (args: string[]): ParsedCommandByName["scripts.run"] => {
  const parsed = parseCliTokens(args);
  assertNoPositionals(parsed, "scripts.run");

  return {
    name: "scripts.run",
    args: {
      script: readStringOption(parsed, "script", true)!,
      event: readStringOption(parsed, "event", true)!,
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
  "scripts.run": {
    name: "scripts.run",
    help: HELP.scriptRun,
    parse: parseAutomationsScriptRun,
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
  "scripts.run": AutomationCommandSpec<"scripts.run", ScriptRunArgs>;
};
