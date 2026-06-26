import { describe, test, assert } from "vitest";

import type { AutomationEvent } from "./contracts";
import { evaluateAutomationEventMatcher } from "./routing";

const event = {
  id: "event-1",
  scope: { kind: "org", orgId: "org-1" },
  source: "test",
  eventType: "created",
  occurredAt: "2026-01-01T00:00:00.000Z",
  payload: { status: "open" },
  actor: { scope: "internal", type: "system", id: "test" },
  actors: [{ scope: "internal", type: "system", id: "test" }],
  subject: { orgId: "org-1" },
} satisfies AutomationEvent;

describe("evaluateAutomationEventMatcher", () => {
  test("treats missing paths as not equal", () => {
    assert(
      evaluateAutomationEventMatcher(
        { path: "$.payload.missing", op: "neq", value: "closed" },
        event,
      ),
    );
  });

  test("keeps neq false when the value matches", () => {
    assert(
      !evaluateAutomationEventMatcher(
        { path: "$.payload.status", op: "neq", value: "open" },
        event,
      ),
    );
  });
});
