import { describe, it, assert, expect } from "vitest";

import { buildFailedStepEmissionFlushDiagnostics } from "./step-live-pump-diagnostics";

describe("buildFailedStepEmissionFlushDiagnostics", () => {
  it("reports the failing workflow, scope, and largest outgoing payload shapes", () => {
    const diagnostics = buildFailedStepEmissionFlushDiagnostics({
      workflowName: "agent-workflow",
      instanceId: "session-1",
      context: {
        handlerTx: (() => undefined) as never,
        scopes: new Map([
          [
            "agent-step",
            {
              key: "agent-step",
              meta: { epoch: "attempt-1" },
              closed: false,
            },
          ],
        ]),
        batch: {
          outgoingByScope: new Map([
            [
              "agent-step",
              [
                { kind: "harness-event", event: { type: "message_update", text: "x".repeat(500) } },
                { kind: "harness-message-update", update: { type: "message_update", delta: "y" } },
              ],
            ],
          ]),
        },
      },
    });

    assert.equal(diagnostics.workflowName, "agent-workflow");
    assert.equal(diagnostics.instanceId, "session-1");
    assert.equal(diagnostics.outgoingCount, 2);
    expect(diagnostics.scopes).toEqual([
      expect.objectContaining({
        stepKey: "agent-step",
        epoch: "attempt-1",
        outgoingCount: 2,
        inspectedOutgoingCount: 2,
        inspectionTruncated: false,
        largestInspectedOutgoingItems: [
          expect.objectContaining({
            index: 0,
            valueShape: expect.stringContaining("event.type=message_update"),
          }),
          expect.objectContaining({
            index: 1,
            valueShape: expect.stringContaining("kind=harness-message-update"),
          }),
        ],
      }),
    ]);
    expect(JSON.stringify(diagnostics)).not.toContain("x".repeat(100));
  });

  it("bounds payload inspection when a failed queue is large", () => {
    let serializationCount = 0;
    const outgoing = Array.from({ length: 1_000 }, (_, index) => ({
      index,
      toJSON() {
        serializationCount += 1;
        return { index };
      },
    }));

    const diagnostics = buildFailedStepEmissionFlushDiagnostics({
      workflowName: "large-workflow",
      instanceId: "large-instance",
      context: {
        handlerTx: (() => undefined) as never,
        scopes: new Map([
          [
            "large-step",
            {
              key: "large-step",
              meta: { epoch: "attempt-1" },
              closed: false,
            },
          ],
        ]),
        batch: { outgoingByScope: new Map([["large-step", outgoing]]) },
      },
    });

    assert.equal(diagnostics.outgoingCount, 1_000);
    assert.equal(diagnostics.inspectedOutgoingCount, 64);
    assert(diagnostics.inspectionTruncated);
    assert.equal(serializationCount, 64);
    expect(diagnostics.scopes[0]).toMatchObject({
      outgoingCount: 1_000,
      inspectedOutgoingCount: 64,
      inspectionTruncated: true,
    });
  });
});
