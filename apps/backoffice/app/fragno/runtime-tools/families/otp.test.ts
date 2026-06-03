import { describe, expect, test } from "vitest";

import { OTP_COMMAND_SPEC_LIST } from "@/fragno/automation/commands/registry";

import { otpRuntimeTools } from "./otp";

describe("otp runtime tools", () => {
  test("derive otp bash commands from runtime tools", () => {
    expect(OTP_COMMAND_SPEC_LIST.map((spec) => spec.name)).toEqual(
      otpRuntimeTools.map((tool) => tool.bash?.command),
    );
  });

  test("parse and validate create identity claim input", () => {
    const [createClaim] = otpRuntimeTools;

    expect(createClaim.name).toBe("createIdentityClaim");
    expect(
      createClaim.inputSchema.parse(
        createClaim.bash!.parse([
          "--source",
          "telegram",
          "--external-actor-id",
          "chat-123",
          "--ttl-minutes",
          "15",
        ]),
      ),
    ).toEqual({
      source: "telegram",
      externalActorId: "chat-123",
      ttlMinutes: 15,
    });
  });
});
