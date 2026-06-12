import { describe, expect, test, assert } from "vitest";

import { otpRuntimeTools } from "./otp";

describe("otp runtime tools", () => {
  test("derive otp bash commands from runtime tools", () => {
    expect(otpRuntimeTools.map((tool) => tool.adapters?.bash?.command)).toEqual([
      "otp.identity.create-claim",
    ]);
  });

  test("parse and validate create identity claim input", () => {
    const [createClaim] = otpRuntimeTools;

    assert(createClaim.name === "createIdentityClaim");
    expect(
      createClaim.inputSchema.parse(
        createClaim.adapters!.bash!.parse([
          "--actor-json",
          '{"scope":"external","source":"telegram","type":"chat","id":"chat-123"}',
          "--ttl-minutes",
          "15",
        ]),
      ),
    ).toEqual({
      actor: { scope: "external", source: "telegram", type: "chat", id: "chat-123" },
      ttlMinutes: 15,
    });
  });

  test("rejects source-less and internal identity claim actors", () => {
    const [createClaim] = otpRuntimeTools;

    expect(() =>
      createClaim.inputSchema.parse({
        actor: { scope: "external", type: "chat", id: "chat-123" },
      }),
    ).toThrow();
    expect(() =>
      createClaim.inputSchema.parse({
        actor: { scope: "internal", type: "user", id: "user-123" },
      }),
    ).toThrow();
  });
});
