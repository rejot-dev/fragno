import { assert, describe, expect, it } from "vitest";

import { visualizeWorkflowSource } from "@fragno-dev/workflow-visualizer-tokens";

import {
  countRenderedWorkflowSteps,
  createWorkflowGraphPresentation,
  workflowTerminalDetails,
} from "./workflow-graph-presentation";

describe("workflow graph presentation", () => {
  it("moves a leading event guard into workflow metadata", () => {
    const visualization = visualizeWorkflowSource(
      "automations/pi-configure.workflow.js",
      `defineWorkflow({ name: "pi-configure" }, async (event, step) => {
        const automationEvent = event;
        if (
          automationEvent.source !== "pi" ||
          automationEvent.eventType !== "capability.configured"
        ) {
          return { skipped: true, reason: "wrong-event" };
        }
        await step.do("configure pi", async () => {});
      });`,
    );
    const workflow = visualization.graph.nodes.find((node) => node.kind === "workflow");
    assert(workflow?.kind === "workflow");

    const presentation = createWorkflowGraphPresentation(visualization);

    expect(presentation.eventGuardByWorkflowId.get(workflow.id)).toMatchObject({
      eventSource: "pi",
      eventType: "capability.configured",
    });
    expect(presentation.childrenByParent.get(workflow.id)).toEqual([
      expect.objectContaining({ kind: "step", label: "configure pi", order: 0 }),
    ]);
    assert.equal(countRenderedWorkflowSteps(workflow.id, presentation.childrenByParent), 1);
  });

  it("promotes the accepted branch and removes the rejected branch", () => {
    const visualization = visualizeWorkflowSource(
      "automations/positive-event.workflow.js",
      `defineWorkflow({ name: "positive-event" }, async (event, step) => {
        const automationEvent = event;
        if (
          automationEvent.source === "pi" &&
          automationEvent.eventType === "capability.configured"
        ) {
          await step.do("configure pi", async () => {});
        } else {
          return { skipped: true, reason: "wrong-event" };
        }
        await step.do("finish", async () => {});
      });`,
    );
    const workflow = visualization.graph.nodes.find((node) => node.kind === "workflow");
    assert(workflow?.kind === "workflow");

    const presentation = createWorkflowGraphPresentation(visualization);

    expect(
      presentation.childrenByParent
        .get(workflow.id)
        ?.map((node) => ({ kind: node.kind, label: node.label, order: node.order })),
    ).toEqual([
      { kind: "step", label: "configure pi", order: 0 },
      { kind: "step", label: "finish", order: 1 },
    ]);
    assert.equal(countRenderedWorkflowSteps(workflow.id, presentation.childrenByParent), 2);
  });

  it("counts rendered steps recursively", () => {
    const visualization = visualizeWorkflowSource(
      "automations/nested-step.workflow.js",
      `defineWorkflow({ name: "nested-step" }, async (event, step) => {
        if (event.payload.enabled) {
          await step.do("nested", async () => {});
        }
        await step.do("finish", async () => {});
      });`,
    );
    const workflow = visualization.graph.nodes.find((node) => node.kind === "workflow");
    assert(workflow?.kind === "workflow");

    const presentation = createWorkflowGraphPresentation(visualization);

    assert.equal(countRenderedWorkflowSteps(workflow.id, presentation.childrenByParent), 2);
  });

  it("hides terminal values and errors in simple mode", () => {
    const visualization = visualizeWorkflowSource(
      "automations/detail-mode.workflow.js",
      `defineWorkflow({ name: "detail-mode" }, async (event, step) => {
        if (event.payload.skip) {
          return { skipped: true, reason: "not-ready" };
        }
        if (event.payload.fail) {
          throw new Error("failed");
        }
        await step.do("finish", async () => {});
        return { finished: true };
      });`,
    );
    const terminals = visualization.graph.nodes.filter((node) => node.kind === "terminal");

    expect(terminals.map((terminal) => workflowTerminalDetails(terminal, "simple"))).toEqual([
      { label: "not-ready" },
      { label: "failed" },
      {},
    ]);
    expect(terminals.map((terminal) => workflowTerminalDetails(terminal, "verbose"))).toEqual([
      { label: "not-ready", value: '{ skipped: true, reason: "not-ready" }' },
      { label: "failed", value: 'new Error("failed")' },
      { value: "{ finished: true }" },
    ]);
  });

  it("keeps additional event requirements visible", () => {
    const visualization = visualizeWorkflowSource(
      "automations/conditional-event.workflow.js",
      `defineWorkflow({ name: "conditional-event" }, async (event, step) => {
        const automationEvent = event;
        if (
          automationEvent.source !== "pi" ||
          automationEvent.eventType !== "capability.configured" ||
          event.payload.enabled !== true
        ) {
          return { skipped: true, reason: "wrong-event" };
        }
        await step.do("configure pi", async () => {});
      });`,
    );
    const workflow = visualization.graph.nodes.find((node) => node.kind === "workflow");
    assert(workflow?.kind === "workflow");

    const presentation = createWorkflowGraphPresentation(visualization);

    assert(!presentation.eventGuardByWorkflowId.has(workflow.id));
    expect(presentation.childrenByParent.get(workflow.id)?.map((node) => node.kind)).toEqual([
      "condition",
      "step",
    ]);
  });

  it("keeps a non-leading event condition in the workflow tree", () => {
    const visualization = visualizeWorkflowSource(
      "automations/late-event-check.workflow.js",
      `defineWorkflow({ name: "late-event-check" }, async (event, step) => {
        const automationEvent = event;
        await step.do("before guard", async () => {});
        if (
          automationEvent.source !== "pi" ||
          automationEvent.eventType !== "capability.configured"
        ) {
          return { skipped: true, reason: "wrong-event" };
        }
      });`,
    );
    const workflow = visualization.graph.nodes.find((node) => node.kind === "workflow");
    assert(workflow?.kind === "workflow");

    const presentation = createWorkflowGraphPresentation(visualization);

    assert(!presentation.eventGuardByWorkflowId.has(workflow.id));
    expect(presentation.childrenByParent.get(workflow.id)?.map((node) => node.kind)).toEqual([
      "step",
      "condition",
    ]);
  });
});
