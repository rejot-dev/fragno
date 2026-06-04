import { describe, expect, test } from "vitest";

import { automationIdentityRuntimeTools, automationsRuntimeTools } from "./automations";

describe("automation runtime tools", () => {
  test("derive automation bash commands from runtime tools", () => {
    expect(automationsRuntimeTools.map((tool) => tool.adapters?.bash?.command)).toEqual([
      "automations.identity.lookup-binding",
      "automations.identity.bind-actor",
      "scripts.run",
    ]);
  });

  test("parse and validate lookupBinding input", () => {
    const [lookupBinding] = automationIdentityRuntimeTools;

    expect(lookupBinding.name).toBe("lookupBinding");
    expect(
      lookupBinding.inputSchema.parse(
        lookupBinding.adapters!.bash!.parse(["--source", "telegram", "--key", "chat-123"]),
      ),
    ).toEqual({ source: "telegram", key: "chat-123" });
  });

  test("parse and validate bindActor input", () => {
    const [, bindActor] = automationIdentityRuntimeTools;

    expect(bindActor.name).toBe("bindActor");
    expect(
      bindActor.inputSchema.parse(
        bindActor.adapters!.bash!.parse([
          "--source",
          "telegram",
          "--key",
          "chat-123",
          "--value",
          "user-55",
          "--description",
          "Primary device",
        ]),
      ),
    ).toEqual({
      source: "telegram",
      key: "chat-123",
      value: "user-55",
      description: "Primary device",
    });
  });
});
