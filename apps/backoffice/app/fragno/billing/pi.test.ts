import { assert, describe, expect, test } from "vitest";

import type { PiOperationCompletedHookPayload } from "@fragno-dev/pi-harness/types";

import {
  createPiOperationBillingEvent,
  PiOperationBillingEventValidationError,
  PiOperationBillingOwnerMissingError,
  resolvePiOperationBillingOrganizationId,
} from "./pi";

const payload: PiOperationCompletedHookPayload = {
  actor: { userId: "user-1" },
  workflowName: "interactive-chat-workflow",
  sessionId: "session-1",
  metadata: { model: "default" },
  stepName: "command:command-1",
  operationId: "interactive-chat-workflow:session-1:command:command-1",
  operation: "prompt",
  modelCalls: [
    {
      api: "anthropic-messages",
      provider: "anthropic",
      model: "claude-test",
      usage: {
        input: 100,
        output: 25,
        cacheRead: 50,
        cacheWrite: 10,
        totalTokens: 185,
        cost: {
          input: 0.0003,
          output: 0.000375,
          cacheRead: 0.000015,
          cacheWrite: 0.0000375,
          total: 0.0007275,
        },
      },
      stopReason: "stop",
      timestamp: Date.parse("2026-07-16T12:00:00.000Z"),
    },
  ],
  usage: {
    input: 100,
    output: 25,
    cacheRead: 50,
    cacheWrite: 10,
    totalTokens: 185,
    cost: {
      input: 0.0003,
      output: 0.000375,
      cacheRead: 0.000015,
      cacheWrite: 0.0000375,
      total: 0.0007275,
    },
  },
};

describe("createPiOperationBillingEvent", () => {
  test("resolves the organization that owns scoped usage", () => {
    assert(
      resolvePiOperationBillingOrganizationId({ kind: "org", orgId: "org-1" }, null) === "org-1",
    );
    assert(
      resolvePiOperationBillingOrganizationId(
        { kind: "project", orgId: "org-1", projectId: "project-1" },
        null,
      ) === "org-1",
    );
    assert(
      resolvePiOperationBillingOrganizationId(
        { kind: "user", userId: "user-1" },
        { __backofficeBillingOrganizationId: "org-2" },
      ) === "org-2",
    );
    expect(() =>
      resolvePiOperationBillingOrganizationId({ kind: "user", userId: "user-1" }, null),
    ).toThrow(PiOperationBillingOwnerMissingError);
    assert(
      resolvePiOperationBillingOrganizationId(
        { kind: "system" },
        { __backofficeBillingOrganizationId: "org-2" },
      ) === "org-2",
    );
    expect(resolvePiOperationBillingOrganizationId({ kind: "system" }, null)).toBeNull();
  });

  test("rejects operations without model calls", () => {
    expect(() =>
      createPiOperationBillingEvent({
        scope: { kind: "org", orgId: "org-1" },
        payload: { ...payload, modelCalls: [] },
        hookId: "42",
        idempotencyKey: "pi-hook-key",
      }),
    ).toThrow(PiOperationBillingEventValidationError);
  });

  test("maps operation usage into generic billing measurements", () => {
    const event = createPiOperationBillingEvent({
      scope: { kind: "org", orgId: "org-1" },
      payload,
      hookId: "42",
      idempotencyKey: "pi-hook-key",
    });

    expect(event).toMatchObject({
      id: "pi:org:org-1:42",
      scope: { kind: "org", orgId: "org-1" },
      source: "pi-harness",
      eventType: "operation.completed",
      occurredAt: "2026-07-16T12:00:00.000Z",
    });
    const projectEvent = createPiOperationBillingEvent({
      scope: { kind: "project", orgId: "org-1", projectId: "project-1" },
      payload,
      hookId: "43",
      idempotencyKey: "pi-project-hook-key",
    });
    assert.equal(projectEvent.id, "pi:project:org-1:project-1:43");

    expect(
      Object.fromEntries(event.measurements.map(({ meter, quantity }) => [meter, quantity])),
    ).toMatchObject({
      "ai.tokens.input": 100,
      "ai.tokens.output": 25,
      "ai.tokens.total": 185,
      "ai.cost.input": 300_000,
      "ai.cost.total": 727_500,
    });
  });
});
