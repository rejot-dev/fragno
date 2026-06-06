import { describe, expect, test } from "vitest";

import { automationBindingsRuntimeTools } from "./automations-bindings";
import { automationScriptRuntimeTools } from "./automations-codemode";
import { automationWorkflowRuntimeTools } from "./automations-workflow";

describe("automation runtime tools", () => {
  test("derive automation bash commands from runtime tools", () => {
    expect(automationBindingsRuntimeTools.map((tool) => tool.adapters?.bash?.command)).toEqual([
      "automations.identity.lookup-binding",
      "automations.identity.bind-actor",
    ]);
    expect(automationScriptRuntimeTools.map((tool) => tool.adapters?.bash?.command)).toEqual([
      "scripts.run",
    ]);
    expect(automationWorkflowRuntimeTools.map((tool) => tool.adapters?.bash?.command)).toEqual([
      "workflow.create-instance",
      "workflow.get-status",
      "workflow.send-event",
    ]);
  });

  test("parse and validate lookupBinding input", () => {
    const [lookupBinding] = automationBindingsRuntimeTools;

    expect(lookupBinding.name).toBe("lookupBinding");
    expect(
      lookupBinding.inputSchema.parse(
        lookupBinding.adapters!.bash!.parse(["--source", "telegram", "--key", "chat-123"]),
      ),
    ).toEqual({ source: "telegram", key: "chat-123" });
  });

  test("parse and validate bindActor input", () => {
    const [, bindActor] = automationBindingsRuntimeTools;

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
