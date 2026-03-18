import {
  assertNoPositionals,
  parseCliTokens,
  readIntegerOption,
  readOutputOptions,
  readStringOption,
} from "../cli";
import type {
  AutomationCommandHelp,
  AutomationCommandSpec,
  IdentityCreateClaimArgs,
  ParsedCommandByName,
} from "../types";

const HELP: {
  createClaim: AutomationCommandHelp;
} = {
  createClaim: {
    summary:
      "otp.identity.create-claim creates a short-lived identity claim URL for an external actor.",
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
        name: "ttl-minutes",
        valueRequired: true,
        valueName: "minutes",
        description: "Optional claim TTL, in minutes",
      },
    ],
    examples: [
      "otp.identity.create-claim --source telegram --external-actor-id chat-123",
      "otp.identity.create-claim --source telegram --external-actor-id chat-123 --ttl-minutes 15 --print url",
    ],
  },
};

const parseOtpIdentityCreateClaim = (
  args: string[],
): ParsedCommandByName["otp.identity.create-claim"] => {
  const parsed = parseCliTokens(args);
  assertNoPositionals(parsed, "otp.identity.create-claim");

  const ttlMinutes = readIntegerOption(parsed, "ttl-minutes");
  if (typeof ttlMinutes !== "undefined" && ttlMinutes <= 0) {
    throw new Error("--ttl-minutes must be a positive integer");
  }

  return {
    name: "otp.identity.create-claim",
    args: {
      source: readStringOption(parsed, "source", true)!,
      externalActorId: readStringOption(parsed, "external-actor-id", true)!,
      ...(typeof ttlMinutes !== "undefined" ? { ttlMinutes } : {}),
    },
    output: readOutputOptions(parsed),
    rawArgs: args,
  };
};

export const otpCommandSpecs = {
  "otp.identity.create-claim": {
    name: "otp.identity.create-claim",
    help: HELP.createClaim,
    parse: parseOtpIdentityCreateClaim,
  },
} satisfies {
  "otp.identity.create-claim": AutomationCommandSpec<
    "otp.identity.create-claim",
    IdentityCreateClaimArgs
  >;
};
