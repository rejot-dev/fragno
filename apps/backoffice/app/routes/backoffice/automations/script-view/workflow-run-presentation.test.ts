import { assert, describe, expect, it } from "vitest";

import {
  createWorkflowStepCommittedControlPayload,
  createWorkflowStepStartedControlPayload,
} from "@fragno-dev/workflows/step-emission-control";

import { visualizeWorkflowSource } from "@fragno-dev/workflow-visualizer-tokens";

import {
  projectScriptWorkflowRuns,
  projectWorkflowRun,
  selectScriptWorkflowRun,
  type AutomationWorkflowRun,
  type WorkflowRunEmission,
} from "./workflow-run-presentation";

const absolutePath = "/workspace/automations/demo.workflow.js";
const visualization = visualizeWorkflowSource(
  absolutePath,
  `defineWorkflow({ name: "demo" }, async (event, step) => {
    await step.do("prepare", async (tx) => {
      tx.emit({ phase: "preparing" });
    });
    await step.do("finalize", async () => {});
    await step.sleepUntil("resume later", event.payload.resumeAt);
    await step.waitForEvent("approval", { type: "approved" });
  });`,
);
const nestedDuplicateVisualization = visualizeWorkflowSource(
  absolutePath,
  `defineWorkflow({ name: "demo" }, async (_event, step) => {
    await step.do("outer A", async () => {
      await step.do("shared", async () => {});
    });
    await step.do("outer B", async () => {
      await step.do("shared", async () => {});
    });
  });`,
);
const raceVisualization = visualizeWorkflowSource(
  absolutePath,
  `defineWorkflow({ name: "demo" }, async (_event, step) => {
    await step.do("race", async () => Promise.race([
      step.do("slow", async () => {
        await step.sleep("slow delay", "1 hour");
      }),
      step.do("fast", async () => {}),
    ]));
    await step.waitForEvent("after race", { type: "continue" });
  });`,
);

describe("automation script workflow run presentation", () => {
  it("filters active runs by workflow name and script path", () => {
    const matching = workflowRun({ instanceId: "matching", status: "waiting" });
    const wrongPath = workflowRun({
      instanceId: "wrong-path",
      params: { workflowScriptPath: "/workspace/automations/other.workflow.js" },
    });
    const wrongWorkflow = workflowRun({
      instanceId: "wrong-workflow",
      remoteWorkflowName: "other",
    });
    const complete = workflowRun({ instanceId: "complete", status: "complete" });

    const runs = projectScriptWorkflowRuns({
      absolutePath,
      visualization,
      instances: [wrongPath, wrongWorkflow, complete, matching],
    });

    expect(runs.map((run) => run.instanceId)).toEqual(["matching"]);
  });

  it("projects an explicitly selected terminal run for session workflow panels", () => {
    const run = projectWorkflowRun({
      visualization,
      instance: workflowRun({
        instanceId: "completed-run",
        status: "complete",
        workflowSteps: [workflowStep({ status: "completed" })],
      }),
    });

    assert(run);
    assert(run.status === "complete");
    expect(run.stepStatesByNodeId.get(stepNode("prepare").id)).toEqual({
      status: "completed",
      attempts: 1,
      emissionCount: 0,
      current: false,
    });
  });

  it("maps durable waiting steps and normalizes sleepUntil to runtime sleep", () => {
    const runs = projectScriptWorkflowRuns({
      absolutePath,
      visualization,
      instances: [
        workflowRun({
          status: "waiting",
          workflowSteps: [
            workflowStep({
              id: "step-1",
              stepKey: "sleep:resume later",
              name: "resume later",
              type: "sleep",
              status: "waiting",
            }),
          ],
        }),
      ],
    });
    const sleepNode = stepNode("resume later");

    expect(runs[0]?.stepStatesByNodeId.get(sleepNode.id)).toEqual({
      status: "waiting",
      attempts: 1,
      emissionCount: 0,
      current: true,
    });
  });

  it("uses step-started controls to highlight an in-flight step", () => {
    const runs = projectScriptWorkflowRuns({
      absolutePath,
      visualization,
      instances: [
        workflowRun({
          workflowStepEmissions: [
            workflowEmission({ payload: createWorkflowStepStartedControlPayload() }),
          ],
        }),
      ],
    });

    expect(runs[0]?.stepStatesByNodeId.get(stepNode("prepare").id)).toEqual({
      status: "active",
      attempts: 1,
      emissionCount: 0,
      current: true,
    });
  });

  it("counts user emissions without using them as activity controls", () => {
    const runs = projectScriptWorkflowRuns({
      absolutePath,
      visualization,
      instances: [
        workflowRun({
          workflowStepEmissions: [
            workflowEmission({
              id: "started",
              payload: createWorkflowStepStartedControlPayload(),
            }),
            workflowEmission({ id: "user-1", actor: "user", payload: { phase: "first" } }),
            workflowEmission({ id: "user-2", actor: "user", payload: { phase: "second" } }),
          ],
        }),
      ],
    });

    expect(runs[0]?.stepStatesByNodeId.get(stepNode("prepare").id)).toEqual({
      status: "active",
      attempts: 1,
      emissionCount: 2,
      current: true,
    });

    const userOnlyRuns = projectScriptWorkflowRuns({
      absolutePath,
      visualization,
      instances: [
        workflowRun({
          workflowStepEmissions: [workflowEmission({ actor: "user" })],
        }),
      ],
    });
    assert(!userOnlyRuns[0]?.stepStatesByNodeId.has(stepNode("prepare").id));
  });

  it("stops highlighting a committed step before emission cleanup", () => {
    const runs = projectScriptWorkflowRuns({
      absolutePath,
      visualization,
      instances: [
        workflowRun({
          workflowSteps: [workflowStep({ status: "completed" })],
          workflowStepEmissions: [
            workflowEmission({
              id: "started",
              payload: createWorkflowStepStartedControlPayload(),
            }),
            workflowEmission({ id: "user", actor: "user" }),
            workflowEmission({
              id: "committed",
              payload: createWorkflowStepCommittedControlPayload("epoch-1"),
            }),
          ],
        }),
      ],
    });

    expect(runs[0]?.stepStatesByNodeId.get(stepNode("prepare").id)).toEqual({
      status: "completed",
      attempts: 1,
      emissionCount: 1,
      current: false,
    });
  });

  it("keeps a new retry epoch active after the previous epoch commits", () => {
    const runs = projectScriptWorkflowRuns({
      absolutePath,
      visualization,
      instances: [
        workflowRun({
          workflowSteps: [workflowStep({ status: "completed", attempts: 2 })],
          workflowStepEmissions: [
            workflowEmission({
              id: "old-started",
              epoch: "epoch-1",
              payload: createWorkflowStepStartedControlPayload(),
            }),
            workflowEmission({
              id: "old-committed",
              epoch: "epoch-1",
              payload: createWorkflowStepCommittedControlPayload("epoch-1"),
            }),
            workflowEmission({
              id: "retry-started",
              epoch: "epoch-2",
              payload: createWorkflowStepStartedControlPayload(),
            }),
          ],
        }),
      ],
    });

    expect(runs[0]?.stepStatesByNodeId.get(stepNode("prepare").id)).toEqual({
      status: "active",
      attempts: 2,
      emissionCount: 0,
      current: true,
    });
  });

  it("highlights multiple concurrent step executions", () => {
    const runs = projectScriptWorkflowRuns({
      absolutePath,
      visualization,
      instances: [
        workflowRun({
          workflowStepEmissions: [
            workflowEmission({
              id: "prepare-started",
              stepKey: "do:prepare",
              epoch: "prepare-epoch",
              payload: createWorkflowStepStartedControlPayload(),
            }),
            workflowEmission({
              id: "finalize-started",
              stepKey: "do:finalize",
              epoch: "finalize-epoch",
              payload: createWorkflowStepStartedControlPayload(),
            }),
          ],
        }),
      ],
    });

    assert(runs[0]?.stepStatesByNodeId.get(stepNode("prepare").id)?.current);
    assert(runs[0]?.stepStatesByNodeId.get(stepNode("finalize").id)?.current);
  });

  it("keeps durable completed state after emission cleanup", () => {
    const runs = projectScriptWorkflowRuns({
      absolutePath,
      visualization,
      instances: [
        workflowRun({
          workflowSteps: [workflowStep({ status: "completed" })],
          workflowStepEmissions: [],
        }),
      ],
    });

    expect(runs[0]?.stepStatesByNodeId.get(stepNode("prepare").id)).toEqual({
      status: "completed",
      attempts: 1,
      emissionCount: 0,
      current: false,
    });
  });

  it("does not mark abandoned waiting descendants of a completed race as current", () => {
    const runs = projectScriptWorkflowRuns({
      absolutePath,
      visualization: raceVisualization,
      instances: [
        workflowRun({
          status: "waiting",
          workflowSteps: [
            workflowStep({
              id: "race",
              stepKey: "do:race",
              name: "race",
              status: "completed",
            }),
            workflowStep({
              id: "slow",
              stepKey: "do:race>do:slow",
              parentStepKey: "do:race",
              name: "slow",
              status: "waiting",
            }),
            workflowStep({
              id: "after-race",
              stepKey: "waitForEvent:after race",
              name: "after race",
              type: "waitForEvent",
              status: "waiting",
            }),
          ],
          workflowStepEmissions: [
            workflowEmission({
              id: "slow-started",
              stepKey: "do:race>do:slow",
              payload: createWorkflowStepStartedControlPayload(),
            }),
            workflowEmission({
              id: "slow-committed",
              stepKey: "do:race>do:slow",
              payload: createWorkflowStepCommittedControlPayload("epoch-1"),
            }),
          ],
        }),
      ],
    });
    const run = runs[0];
    assert(run);

    assert.equal(
      run.stepStatesByNodeId.get(stepNodeIn(raceVisualization, "slow").id)?.current,
      false,
    );
    assert.equal(
      run.stepStatesByNodeId.get(stepNodeIn(raceVisualization, "after race").id)?.current,
      true,
    );
  });

  it("uses the full nested step key to map duplicate live step names", () => {
    const runs = projectScriptWorkflowRuns({
      absolutePath,
      visualization: nestedDuplicateVisualization,
      instances: [
        workflowRun({
          workflowSteps: [
            workflowStep({
              id: "outer-a",
              stepKey: "do:outer A",
              name: "outer A",
              status: "completed",
            }),
            workflowStep({
              id: "outer-a-shared",
              stepKey: "do:outer A>do:shared",
              parentStepKey: "do:outer A",
              name: "shared",
              status: "completed",
            }),
          ],
          workflowStepEmissions: [
            workflowEmission({
              stepKey: "do:outer B>do:shared",
              payload: createWorkflowStepStartedControlPayload(),
            }),
          ],
        }),
      ],
    });
    const run = runs[0];
    assert(run);
    const outerAShared = nestedStepNode(nestedDuplicateVisualization, "outer A", "shared");
    const outerBShared = nestedStepNode(nestedDuplicateVisualization, "outer B", "shared");

    expect(run.stepStatesByNodeId.get(outerAShared.id)).toMatchObject({
      status: "completed",
      current: false,
    });
    expect(run.stepStatesByNodeId.get(outerBShared.id)).toMatchObject({
      status: "active",
      current: true,
    });
  });

  it("ignores malformed synchronized step identities", () => {
    const runs = projectScriptWorkflowRuns({
      absolutePath,
      visualization,
      instances: [
        workflowRun({
          status: "waiting",
          workflowSteps: [
            workflowStep({ id: "malformed-step", stepKey: "malformed" }),
            workflowStep({
              id: "waiting-step",
              stepKey: "do:prepare",
              parentStepKey: "malformed-parent",
              status: "waiting",
            }),
          ],
          workflowStepEmissions: [workflowEmission({ stepKey: "malformed-emission" })],
        }),
      ],
    });
    const run = runs[0];
    assert(run);

    expect(run.stepStatesByNodeId.get(stepNode("prepare").id)).toMatchObject({
      status: "waiting",
      current: true,
    });
    assert.equal(run.stepStatesByNodeId.size, 1);
  });

  it("fails fast when synchronized run timestamps are invalid", () => {
    expect(() =>
      projectScriptWorkflowRuns({
        absolutePath,
        visualization,
        instances: [
          workflowRun({ instanceId: "invalid", updatedAt: "not-a-timestamp" }),
          workflowRun({ instanceId: "valid" }),
        ],
      }),
    ).toThrow();
  });

  it("selects an explicit instance or falls back to the newest run", () => {
    const runs = projectScriptWorkflowRuns({
      absolutePath,
      visualization,
      instances: [
        workflowRun({
          instanceId: "older",
          updatedAt: "2026-07-24T09:00:00.000Z",
        }),
        workflowRun({
          instanceId: "newer",
          updatedAt: "2026-07-24T10:00:00.000Z",
        }),
      ],
    });

    assert.equal(selectScriptWorkflowRun(runs, "older")?.instanceId, "older");
    assert.equal(selectScriptWorkflowRun(runs, "missing")?.instanceId, "newer");
  });
});

function stepNode(label: string) {
  return stepNodeIn(visualization, label);
}

function stepNodeIn(snapshot: typeof visualization, label: string) {
  const node = snapshot.graph.nodes.find(
    (candidate) => candidate.kind === "step" && candidate.label === label,
  );
  assert(node?.kind === "step");
  return node;
}

function nestedStepNode(snapshot: typeof visualization, parentLabel: string, label: string) {
  const parent = stepNodeIn(snapshot, parentLabel);
  const node = snapshot.graph.nodes.find(
    (candidate) =>
      candidate.kind === "step" && candidate.label === label && candidate.parentId === parent.id,
  );
  assert(node?.kind === "step");
  return node;
}

function workflowRun(overrides: Partial<AutomationWorkflowRun> = {}): AutomationWorkflowRun {
  const instanceId = overrides.instanceId ?? "run-1";
  return {
    id: `automation-codemode-script:${instanceId}`,
    instanceId,
    remoteWorkflowName: "demo",
    status: "active",
    params: { workflowScriptPath: absolutePath },
    createdAt: "2026-07-24T09:00:00.000Z",
    updatedAt: "2026-07-24T10:00:00.000Z",
    workflowSteps: [],
    workflowStepEmissions: [],
    ...overrides,
  };
}

function workflowStep(
  overrides: Partial<AutomationWorkflowRun["workflowSteps"][number]> = {},
): AutomationWorkflowRun["workflowSteps"][number] {
  return {
    id: "step-1",
    stepKey: "do:prepare",
    parentStepKey: null,
    name: "prepare",
    type: "do",
    status: "completed",
    attempts: 1,
    errorName: null,
    errorMessage: null,
    createdAt: "2026-07-24T10:00:00.000Z",
    ...overrides,
  };
}

function workflowEmission(overrides: Partial<WorkflowRunEmission> = {}): WorkflowRunEmission {
  return {
    id: "emission-1",
    actor: "system",
    stepKey: "do:prepare",
    epoch: "epoch-1",
    sequence: 0,
    payload: createWorkflowStepStartedControlPayload(),
    createdAt: "2026-07-24T10:00:01.000Z",
    ...overrides,
  };
}
