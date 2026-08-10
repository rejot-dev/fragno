import { describe, it, assert, expect } from "vitest";

import superjson from "superjson";

import type { OutboxPayload } from "../../outbox/outbox";
import { buildOutboxInsertDiagnostics } from "./outbox-insert-diagnostics";

describe("buildOutboxInsertDiagnostics", () => {
  it("identifies the largest mutations and fields without logging their contents", () => {
    const payload = {
      version: 2,
      operations: [
        {
          op: "create",
          schema: "workflows",
          table: "workflow_step_emission",
          externalId: "emission-large",
          versionstamp: "vs-1",
          values: {
            stepKey: "agent",
            payload: {
              kind: "harness-event",
              event: { type: "message_update", message: "x".repeat(10_000) },
            },
          },
        },
        {
          op: "update",
          schema: "workflows",
          table: "workflow_step",
          externalId: "step-small",
          versionstamp: "vs-2",
          set: { status: "completed" },
        },
      ],
    } satisfies OutboxPayload;
    const payloadSerialized = superjson.serialize(payload);

    const diagnostics = buildOutboxInsertDiagnostics({
      id: "outbox-id",
      versionstamp: "vs-entry",
      uowId: "uow-id",
      payload,
      payloadSerialized,
    });

    assert.equal(diagnostics.operationCount, 2);
    assert(diagnostics.payloadSerializedBytes > 10_000);
    expect(diagnostics.operationGroups).toEqual([
      expect.objectContaining({
        schema: "workflows",
        table: "workflow_step_emission",
        op: "create",
        count: 1,
      }),
      expect.objectContaining({
        schema: "workflows",
        table: "workflow_step",
        op: "update",
        count: 1,
      }),
    ]);
    expect(diagnostics.largestOperations[0]).toEqual(
      expect.objectContaining({
        table: "workflow_step_emission",
        externalId: "emission-large",
        largestFields: [
          expect.objectContaining({
            name: "payload",
            valueShape: expect.stringContaining("event.type=message_update"),
          }),
          expect.objectContaining({ name: "stepKey" }),
        ],
      }),
    );
    expect(JSON.stringify(diagnostics)).not.toContain("x".repeat(1_000));
  });
});
