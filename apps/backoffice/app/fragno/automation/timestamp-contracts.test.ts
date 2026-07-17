import { describe, expect, test, assert } from "vitest";

import { automationEventDefinitionSchema } from "./event-definitions";
import { normalizeAutomationEventRecord } from "./events";
import { automationRouteSchema } from "./routing-schemas";
import { automationStoreEntrySchema } from "./store";

const actor = {
  scope: "internal" as const,
  type: "user",
  id: "user-1",
};

const invalidTimestamps = [
  new Date("2026-01-01T00:00:00.000Z"),
  Date.UTC(2026, 0, 1),
  { tag: "db-now" },
];

describe("automation public timestamp contracts", () => {
  test.each(invalidTimestamps)("store entries reject non-ISO timestamp value %#", (createdAt) => {
    const result = automationStoreEntrySchema.safeParse({
      key: "example",
      value: "value",
      category: [],
      actor,
      createdAt,
    });

    assert(!result.success);
  });

  test("event definitions reject database timestamp expressions", () => {
    const result = automationEventDefinitionSchema.safeParse({
      id: "custom:example",
      source: "custom",
      eventType: "example",
      label: "Example",
      enabled: true,
      capabilityId: "custom",
      updatedAt: { tag: "db-now" },
    });

    assert(!result.success);
  });

  test("events reject database timestamp expressions", () => {
    expect(() =>
      normalizeAutomationEventRecord({
        id: "event-1",
        scope: { kind: "system" },
        source: "custom",
        eventType: "example",
        occurredAt: { tag: "db-now" },
        payload: {},
        actor,
        actors: [actor],
        subject: null,
      }),
    ).toThrow();
  });

  test("routes reject database timestamp expressions", () => {
    const result = automationRouteSchema.safeParse({
      id: "route-1",
      name: "Route",
      enabled: true,
      priority: 1000,
      trigger: {
        kind: "event",
        source: "custom",
        eventType: "example",
        matcher: null,
      },
      action: {
        kind: "start_workflow",
        workflowScriptPath: "/workspace/example.workflow.js",
        instanceIdTemplate: "example-${event.id}",
      },
      nextOccurrenceAt: { tag: "db-now" },
    });

    assert(!result.success);
  });
});
