// @vitest-environment happy-dom

import { afterEach, assert, describe, test, vi } from "vitest";

import { visualizeWorkflowSource } from "@fragno-dev/workflow-visualizer-tokens";

import { cleanup, render, screen } from "@testing-library/react";

const { useWorkflowRunRecordsMock } = vi.hoisted(() => ({
  useWorkflowRunRecordsMock: vi.fn(),
}));

vi.mock("./use-script-workflow-runs", () => ({
  useWorkflowRunRecords: useWorkflowRunRecordsMock,
}));

import { useWorkflowRun } from "./use-workflow-run";

const visualization = visualizeWorkflowSource(
  "session-workspace/tool-call.js",
  `defineWorkflow({ name: "sleep-workflow" }, async (_event, step) => {
    await step.sleep("pause briefly", "10 seconds");
  });`,
);
const collections = {} as never;

function WorkflowRunHarness() {
  const run = useWorkflowRun({
    collections,
    reference: { workflowName: "pi-codemode-script", instanceId: "run-1" },
    visualization,
  });
  const sleepNode = visualization.graph.nodes.find(
    (node) => node.kind === "step" && node.label === "pause briefly",
  );
  assert(sleepNode);
  const sleepState = run.selectedRun?.stepStatesByNodeId.get(sleepNode.id);

  return (
    <>
      <span>step {sleepState?.status ?? "unavailable"}</span>
      <span>result {JSON.stringify(sleepState?.result)}</span>
      <span>output {JSON.stringify(run.selectedRun?.output)}</span>
    </>
  );
}

afterEach(() => {
  cleanup();
  useWorkflowRunRecordsMock.mockReset();
});

describe("useWorkflowRun", () => {
  test("projects an exact run from the shared TanStack workflow records query", () => {
    useWorkflowRunRecordsMock.mockReturnValue({
      instances: [
        {
          id: "run-row-1",
          instanceId: "run-1",
          remoteWorkflowName: "sleep-workflow",
          status: "waiting",
          params: {},
          output: { status: "pending" },
          createdAt: "2026-07-31T10:00:00.000Z",
          updatedAt: "2026-07-31T10:00:01.000Z",
          workflowSteps: [
            {
              id: "step-1",
              stepKey: "sleep:pause briefly",
              parentStepKey: null,
              name: "pause briefly",
              type: "sleep",
              status: "waiting",
              attempts: 0,
              result: { wakeReason: "timer" },
              errorName: null,
              errorMessage: null,
              createdAt: "2026-07-31T10:00:00.000Z",
            },
          ],
          workflowStepEmissions: [],
        },
      ],
      error: null,
      isLoading: false,
    });

    render(<WorkflowRunHarness />);

    assert(screen.getByText("step waiting"));
    assert(screen.getByText('result {"wakeReason":"timer"}'));
    assert(screen.getByText('output {"status":"pending"}'));
    assert.deepEqual(useWorkflowRunRecordsMock.mock.calls[0]?.[0], {
      collections,
      selector: {
        type: "instance",
        workflowName: "pi-codemode-script",
        instanceId: "run-1",
      },
    });
  });
});
