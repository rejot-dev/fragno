import { assert, describe, expect, it } from "vitest";

import { visualizeWorkflowSource } from "./index.ts";
import type { ConditionNode } from "./model.ts";

describe("workflow condition semantics", () => {
  it("resolves chained aliases and reversed comparisons", () => {
    const condition = visualizeCondition(`
      const received = event.payload.automationEvent;
      const automationEvent = received;
      if (
        "pi" !== automationEvent.source ||
        "capability.configured" !== automationEvent.eventType
      ) {
        return { skipped: true, reason: "wrong-event" };
      }
    `);

    assert(condition.analysis.status === "complete");
    expect(condition.analysis.outcomes).toEqual([
      expect.objectContaining({
        path: "then",
        completion: expect.objectContaining({ kind: "terminal" }),
      }),
      {
        path: "fallthrough",
        predicate: {
          kind: "all",
          predicates: [
            {
              kind: "comparison",
              operator: "equals",
              left: { kind: "literal", value: "pi" },
              right: {
                kind: "reference",
                root: "event",
                path: ["payload", "automationEvent", "source"],
              },
            },
            {
              kind: "comparison",
              operator: "equals",
              left: { kind: "literal", value: "capability.configured" },
              right: {
                kind: "reference",
                root: "event",
                path: ["payload", "automationEvent", "eventType"],
              },
            },
          ],
        },
        completion: { kind: "continues" },
      },
    ]);
  });

  it("records terminal and continuing outcomes without interpreting event routing", () => {
    const condition = visualizeCondition(`
      if (event.payload.enabled === true) {
        await step.do("configure", async () => {});
      } else {
        return { skipped: true };
      }
    `);

    assert(condition.analysis.status === "complete");
    expect(condition.analysis.outcomes).toEqual([
      expect.objectContaining({ path: "then", completion: { kind: "continues" } }),
      expect.objectContaining({
        path: "else",
        completion: expect.objectContaining({ kind: "terminal" }),
      }),
    ]);
  });

  it("keeps unsupported expressions explicit", () => {
    const condition = visualizeCondition(`
      if (typeof event.payload.id !== "string") {
        return { skipped: true, reason: "missing-id" };
      }
    `);

    expect(condition.analysis).toEqual({
      status: "unsupported",
      outcomes: [],
    });
  });
});

function visualizeCondition(body: string): ConditionNode {
  const snapshot = visualizeWorkflowSource(
    "automations/condition-semantics.workflow.js",
    `defineWorkflow({ name: "condition-semantics" }, async (event, step) => {
      ${body}
      await step.do("after condition", async () => {});
    });`,
  );
  const condition = snapshot.graph.nodes.find(
    (node): node is ConditionNode => node.kind === "condition",
  );
  assert(condition);
  return condition;
}
