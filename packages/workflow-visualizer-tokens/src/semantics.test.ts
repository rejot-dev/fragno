import { assert, describe, expect, it } from "vitest";

import { visualizeWorkflowSource } from "./index.ts";
import type { ConditionNode } from "./model.ts";

describe("workflow condition semantics", () => {
  it("resolves chained aliases and reversed discriminant comparisons", () => {
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
    expect(condition.analysis.annotations).toEqual([
      expect.objectContaining({
        kind: "specific-event-guard",
        subject: {
          kind: "reference",
          root: "event",
          path: ["payload", "automationEvent"],
        },
        eventSource: "pi",
        eventType: "capability.configured",
        acceptedPath: "fallthrough",
        rejectionReason: "wrong-event",
      }),
    ]);
  });

  it("normalizes negated event predicates", () => {
    const condition = visualizeCondition(`
      const automationEvent = event.payload.automationEvent;
      if (!(
        automationEvent.source !== "pi" ||
        automationEvent.eventType !== "capability.configured"
      )) {
        await step.do("configure pi", async () => {});
      } else {
        return { skipped: true, reason: "wrong-event" };
      }
    `);

    assert(condition.analysis.status === "complete");
    expect(condition.analysis.annotations).toEqual([
      expect.objectContaining({
        kind: "specific-event-guard",
        eventSource: "pi",
        eventType: "capability.configured",
        acceptedPath: "then",
      }),
    ]);
  });

  it("recognizes a positive event branch when its else branch exits", () => {
    const condition = visualizeCondition(`
      const automationEvent = event.payload.automationEvent;
      if (
        automationEvent.source === "pi" &&
        automationEvent.eventType === "capability.configured"
      ) {
        await step.do("configure pi", async () => {});
      } else {
        return { skipped: true, reason: "wrong-event" };
      }
    `);

    assert(condition.analysis.status === "complete");
    expect(condition.analysis.annotations).toEqual([
      expect.objectContaining({
        kind: "specific-event-guard",
        eventSource: "pi",
        eventType: "capability.configured",
        acceptedPath: "then",
      }),
    ]);
  });

  it("does not hide an additional accepted-path requirement", () => {
    const condition = visualizeCondition(`
      const automationEvent = event.payload.automationEvent;
      if (
        automationEvent.source === "pi" &&
        automationEvent.eventType === "capability.configured" &&
        event.payload.enabled === true
      ) {
        await step.do("configure pi", async () => {});
      } else {
        return { skipped: true, reason: "wrong-event" };
      }
    `);

    assert(condition.analysis.status === "complete");
    expect(condition.analysis.annotations).toEqual([]);
  });

  it("does not hide an additional rejected-path requirement", () => {
    const condition = visualizeCondition(`
      const automationEvent = event.payload.automationEvent;
      if (
        automationEvent.source !== "pi" ||
        automationEvent.eventType !== "capability.configured" ||
        event.payload.enabled !== true
      ) {
        return { skipped: true, reason: "wrong-event" };
      }
    `);

    assert(condition.analysis.status === "complete");
    expect(condition.analysis.annotations).toEqual([]);
  });

  it("does not call a conditional event branch a guard when both paths continue", () => {
    const condition = visualizeCondition(`
      const automationEvent = event.payload.automationEvent;
      if (
        automationEvent.source === "pi" &&
        automationEvent.eventType === "capability.configured"
      ) {
        await step.do("configure pi", async () => {});
      }
      await step.do("continue", async () => {});
    `);

    assert(condition.analysis.status === "complete");
    expect(condition.analysis.annotations).toEqual([]);
  });

  it("does not hide a rejecting branch that performs durable work", () => {
    const condition = visualizeCondition(`
      const automationEvent = event.payload.automationEvent;
      if (
        automationEvent.source !== "pi" ||
        automationEvent.eventType !== "capability.configured"
      ) {
        await step.do("record rejected event", async () => {});
        return { skipped: true, reason: "wrong-event" };
      }
    `);

    assert(condition.analysis.status === "complete");
    expect(condition.analysis.annotations).toEqual([]);
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
      annotations: [],
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
