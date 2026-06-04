import { describe, expect, test } from "vitest";

import { otpRuntimeTools } from "./otp";

describe("otp runtime tools", () => {
  test("derive otp bash commands from runtime tools", () => {
    expect(otpRuntimeTools.map((tool) => tool.adapters?.bash?.command)).toEqual([
      "otp.identity.create-claim",
    ]);
  });

  test("parse and validate create identity claim input", () => {
    const [createClaim] = otpRuntimeTools;

    expect(createClaim.name).toBe("createIdentityClaim");
    expect(
      createClaim.inputSchema.parse(
        createClaim.adapters!.bash!.parse([
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
