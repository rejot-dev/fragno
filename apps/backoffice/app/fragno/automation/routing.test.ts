import { assert, describe, test } from "vitest";

import type { AutomationEvent } from "./contracts";
import {
  assertAutomationRouteDoesNotReclassifyItself,
  evaluateAutomationEventMatcher,
  projectAutomationEventPayload,
} from "./routing";

describe("automation event reclassification", () => {
  test("rejects exact and wildcard triggers that consume their own output", () => {
    for (const trigger of [
      { kind: "event", source: "github", eventType: "issues.opened", matcher: null },
      { kind: "event", source: "*", eventType: "issues.opened", matcher: null },
      { kind: "event", source: "github", eventType: "*", matcher: null },
    ] as const) {
      assert.throws(
        () =>
          assertAutomationRouteDoesNotReclassifyItself({
            routeId: "github-loop",
            trigger,
            action: {
              kind: "reclassify_event",
              source: "github",
              eventType: "issues.opened",
              payload: { kind: "projection", fields: { issue: "$.payload.issue" } },
            },
          }),
        /cannot reclassify an event to its own trigger/,
      );
    }
  });

  test("accepts reclassification to a distinct event identity", () => {
    assert.doesNotThrow(() =>
      assertAutomationRouteDoesNotReclassifyItself({
        routeId: "github-issues-opened",
        trigger: { kind: "event", source: "github", eventType: "webhook.received", matcher: null },
        action: {
          kind: "reclassify_event",
          source: "github",
          eventType: "issues.opened",
          payload: { kind: "projection", fields: { issue: "$.payload.issue" } },
        },
      }),
    );
  });
  test("projects named payload fields from event paths", () => {
    const projected = projectAutomationEventPayload(
      {
        id: "event-1",
        scope: { kind: "org", orgId: "org-1" },
        source: "github",
        eventType: "webhook.received",
        occurredAt: "2026-01-01T00:00:00.000Z",
        payload: { pullRequest: { number: 42 }, ignored: true },
        actors: {
          initiator: { scope: "internal", type: "system", id: "github", role: "initiator" },
          principal: null,
          delegation: [],
        },
        subject: { orgId: "org-1" },
      },
      {
        kind: "projection",
        fields: {
          pullRequest: "$.payload.pullRequest",
          orgId: "$.subject.orgId",
        },
      },
    );

    assert.deepEqual(projected, {
      pullRequest: { number: 42 },
      orgId: "org-1",
    });
  });

  test("rejects projection fields whose paths do not resolve", () => {
    assert.throws(
      () =>
        projectAutomationEventPayload(event, {
          kind: "projection",
          fields: { issue: "$.payload.issue" },
        }),
      /projection field issue resolved no value/,
    );
  });
});

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
