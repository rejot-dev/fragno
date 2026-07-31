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
      createClaim.inputSchema.parse(createClaim.adapters!.bash!.parse(["--ttl-minutes", "15"])),
    ).toEqual({ ttlMinutes: 15 });
  });

  test.each(["actor", "actors", "principal", "execution", "propagationContext", "permissions"])(
    "rejects caller-supplied %s metadata",
    (field) => {
      const [createClaim] = otpRuntimeTools;
      expect(() => createClaim.inputSchema.parse({ [field]: {} })).toThrow();
    },
  );

  test("rejects the removed --actor-json bash option", () => {
    const [createClaim] = otpRuntimeTools;
    expect(() => createClaim.adapters!.bash!.parse(["--actor-json", "{}"])).toThrow(
      "does not accept option --actor-json",
    );
  });
});
