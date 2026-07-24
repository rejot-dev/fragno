import { assert, describe, test } from "vitest";

import type { AutomationEvent } from "./contracts";
import { evaluateAutomationEventMatcher } from "./routing";

const event = {
  id: "event-1",
  scope: { kind: "org", orgId: "org-1" },
  source: "test",
  eventType: "created",
  occurredAt: "2026-01-01T00:00:00.000Z",
  payload: { status: "open" },
  actors: {
    initiator: {
      scope: "external",
      source: "telegram",
      type: "chat",
      id: "chat-1",
      role: "initiator",
    },
    principal: {
      scope: "internal",
      type: "user",
      id: "user-1",
      role: "principal",
    },
    delegation: [
      {
        scope: "internal",
        type: "automation",
        id: "automation-1",
        role: "delegate",
      },
      {
        scope: "internal",
        type: "agent",
        id: "agent-1",
        role: "assistant",
      },
    ],
  },
  subject: { orgId: "org-1" },
} satisfies AutomationEvent;

describe("evaluateAutomationEventMatcher", () => {
  test("matches actor participation through structural slots", () => {
    assert(
      evaluateAutomationEventMatcher(
        {
          actor: {
            participation: "initiator",
            scope: "external",
            source: "telegram",
            type: "chat",
          },
        },
        event,
      ),
    );
    assert(
      evaluateAutomationEventMatcher(
        {
          actor: {
            participation: "principal",
            scope: "internal",
            type: "user",
            id: "user-1",
          },
        },
        event,
      ),
    );
    assert(
      evaluateAutomationEventMatcher(
        {
          actor: {
            participation: "delegation",
            scope: "internal",
            role: "assistant",
            type: "agent",
          },
        },
        event,
      ),
    );
    assert(
      !evaluateAutomationEventMatcher(
        {
          actor: {
            participation: "delegation",
            scope: "internal",
            role: "delegate",
            type: "agent",
          },
        },
        event,
      ),
    );
  });

  test("does not treat a delegation match as an initiator match", () => {
    assert(
      !evaluateAutomationEventMatcher(
        {
          actor: {
            participation: "initiator",
            scope: "internal",
            type: "automation",
          },
        },
        event,
      ),
    );
  });

  test("does not allow generic paths to bypass structural actor matching", () => {
    assert(
      !evaluateAutomationEventMatcher(
        { path: "$.actors.delegation[0].type", op: "eq", value: "automation" },
        event,
      ),
    );
    assert(
      !evaluateAutomationEventMatcher(
        { path: "$.actors.missing", op: "neq", value: "anything" },
        event,
      ),
    );
    assert(
      !evaluateAutomationEventMatcher(
        { path: "$.actor.source", op: "neq", value: "telegram" },
        event,
      ),
    );
  });

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
