import { describe, expect, test } from "vitest";

import { eventRuntimeTools } from "./event";

describe("event runtime tools", () => {
  test("derive event bash commands from runtime tools", () => {
    expect(eventRuntimeTools.map((tool) => tool.adapters?.bash?.command)).toEqual(["event.emit"]);
  });

  test("parse and validate emit input", () => {
    const [emit] = eventRuntimeTools;

    expect(emit.name).toBe("emit");
    expect(
      emit.inputSchema.parse(
        emit.adapters!.bash!.parse([
          "--event-type",
          "identity.bound",
          "--source",
          "otp",
          "--external-actor-id",
          "chat-123",
          "--actor-type",
          "external",
          "--subject-user-id",
          "user-55",
          "--payload-json",
          '{"plan":"basic"}',
        ]),
      ),
    ).toEqual({
      eventType: "identity.bound",
      source: "otp",
      externalActorId: "chat-123",
      actorType: "external",
      subjectUserId: "user-55",
      payload: { plan: "basic" },
    });
  });
});
