import { describe, expect, test } from "vitest";

import { AUTOMATIONS_COMMAND_SPEC_LIST } from "@/fragno/automation/commands/registry";

import { automationIdentityRuntimeTools, automationsRuntimeTools } from "./automations";

describe("automation runtime tools", () => {
  test("derive automation bash commands from runtime tools", () => {
    expect(AUTOMATIONS_COMMAND_SPEC_LIST.map((spec) => spec.name)).toEqual(
      automationsRuntimeTools.map((tool) => tool.bash?.command),
    );
  });

  test("parse and validate lookupBinding input", () => {
    const [lookupBinding] = automationIdentityRuntimeTools;

    expect(lookupBinding.name).toBe("lookupBinding");
    expect(
      lookupBinding.inputSchema.parse(
        lookupBinding.bash!.parse(["--source", "telegram", "--key", "chat-123"]),
      ),
    ).toEqual({ source: "telegram", key: "chat-123" });
  });

  test("parse and validate bindActor input", () => {
    const [, bindActor] = automationIdentityRuntimeTools;

    expect(bindActor.name).toBe("bindActor");
    expect(
      bindActor.inputSchema.parse(
        bindActor.bash!.parse([
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
