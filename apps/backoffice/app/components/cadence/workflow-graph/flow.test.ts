import { describe, expect, test, assert } from "vitest";

import { createInterpreter, selectWorkflow } from "@fragno-dev/workflow-visualizer";

import { buildFlowElements } from "./flow";

function focusedGraph() {
  const interp = createInterpreter();
  interp.updateFile(
    "/system/automations/init.workflow.js",
    `defineWorkflow({ name: "init" }, async (event, step) => {
      await step.do("first", async () => {});
      await step.do("second", async () => {});
      await step.do("third", async () => {});
    });`,
  );
  return selectWorkflow(interp.snapshot(), "init");
}

describe("buildFlowElements (sub-flow)", () => {
  test("renders the workflow as a container with its steps as children", () => {
    const { nodes } = buildFlowElements(focusedGraph());

    const group = nodes.find((n) => n.type === "workflowGroup");
    assert(group?.id === "workflow:init");
    expect(group?.style?.width).toBeGreaterThan(0);
    expect(group?.style?.height).toBeGreaterThan(0);

    const steps = nodes.filter((n) => n.data.node.kind === "step");
    expect(steps).toHaveLength(3);
    // every step is parented to the workflow container and clipped to it
    assert(steps.every((s) => s.parentId === "workflow:init"));
    assert(steps.every((s) => s.extent === "parent"));
  });

  test("the parent container precedes its children in the node array", () => {
    const { nodes } = buildFlowElements(focusedGraph());
    const groupIndex = nodes.findIndex((n) => n.id === "workflow:init");
    const firstChildIndex = nodes.findIndex((n) => n.parentId === "workflow:init");
    expect(groupIndex).toBeLessThan(firstChildIndex);
  });

  test("steps stack top→bottom by source order", () => {
    const { nodes } = buildFlowElements(focusedGraph());
    const steps = nodes
      .filter((n) => n.data.node.kind === "step")
      .sort((a, b) => a.position.y - b.position.y);
    expect(steps.map((s) => s.data.node.label)).toEqual(["first", "second", "third"]);
  });

  test("wires the step sequence bottom → top between consecutive steps", () => {
    const { edges } = buildFlowElements(focusedGraph());
    const sequence = edges.filter((e) => e.sourceHandle === "step-out");
    expect(sequence).toHaveLength(2); // first→second, second→third
    assert(sequence.every((e) => e.sourceHandle === "step-out" && e.targetHandle === "step-in"));
  });

  test("does not draw `contains` edges (containment is visual)", () => {
    const { edges } = buildFlowElements(focusedGraph());
    assert(!edges.some((e) => e.id.startsWith("contains:")));
  });
});
