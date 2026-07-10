import { describe, expect, test, assert } from "vitest";

import {
  createTrustedSystemBackofficeToolContext,
  getAvailableRuntimeTools,
} from "../runtime-tools";
import { eventCatalogToolFamily, eventFireToolFamily, eventRuntimeTools } from "./event";

describe("event runtime tools", () => {
  test("derive event bash commands from runtime tools", () => {
    expect(eventRuntimeTools.map((tool) => tool.adapters?.bash?.command)).toEqual([
      "events.fire",
      "events.catalog.list",
      "events.catalog.get",
      "events.catalog.create",
    ]);
  });

  test("only exposes tools backed by an available runtime", () => {
    const families = [eventFireToolFamily, eventCatalogToolFamily];
    const availableToolIds = (runtimes: Record<string, unknown>) =>
      getAvailableRuntimeTools({
        families,
        context: createTrustedSystemBackofficeToolContext({ runtimes }),
      }).map((tool) => tool.id);

    expect(availableToolIds({ event: {} })).toEqual(["events.fire"]);
    expect(availableToolIds({ backoffice: {} })).toEqual([
      "events.catalog.list",
      "events.catalog.get",
      "events.catalog.create",
    ]);
    expect(availableToolIds({})).toEqual([]);
  });

  test("parse and validate emit input", () => {
    const [emit] = eventRuntimeTools;

    assert(emit.name === "fire");
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
          "chat",
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
      actorType: "chat",
      subjectUserId: "user-55",
      payload: { plan: "basic" },
    });
  });
});
