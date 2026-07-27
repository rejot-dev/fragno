import { describe, expect, test, assert } from "vitest";

import {
  createWorkflowStepCommittedControlPayload,
  createWorkflowStepStartedControlPayload,
  isWorkflowStepCommittedControlPayload,
  isWorkflowStepStartedControlPayload,
  projectWorkflowStepExecutionActivity,
  type WorkflowStepActivityEmission,
} from "./step-emission-control";

describe("workflow step emission controls", () => {
  test("constructs and recognizes lifecycle control payloads", () => {
    const started = createWorkflowStepStartedControlPayload();
    const committed = createWorkflowStepCommittedControlPayload("epoch-1");

    expect(started).toEqual({ control: "step-started" });
    expect(committed).toEqual({ control: "step-committed", epoch: "epoch-1" });
    assert(isWorkflowStepStartedControlPayload(started));
    assert(isWorkflowStepCommittedControlPayload(committed));
    assert(!isWorkflowStepCommittedControlPayload({ control: "step-committed" }));
  });

  test("projects a started execution as active", () => {
    expect(projectWorkflowStepExecutionActivity([startedEmission()])).toEqual([
      {
        stepKey: "do:prepare",
        epoch: "epoch-1",
        active: true,
        userEmissionCount: 0,
      },
    ]);
  });

  test("counts user emissions without using them to establish activity", () => {
    expect(
      projectWorkflowStepExecutionActivity([
        userEmission({ payload: { phase: "queued" } }),
        startedEmission(),
        userEmission({ payload: { phase: "running" } }),
      ]),
    ).toEqual([
      {
        stepKey: "do:prepare",
        epoch: "epoch-1",
        active: true,
        userEmissionCount: 2,
      },
    ]);

    assert(!projectWorkflowStepExecutionActivity([userEmission()])[0]?.active);
  });

  test("projects a committed execution as inactive before cleanup", () => {
    expect(
      projectWorkflowStepExecutionActivity([
        startedEmission(),
        userEmission(),
        committedEmission(),
      ]),
    ).toEqual([
      {
        stepKey: "do:prepare",
        epoch: "epoch-1",
        active: false,
        userEmissionCount: 1,
      },
    ]);
  });

  test("keeps a retried epoch active after an older epoch commits", () => {
    expect(
      projectWorkflowStepExecutionActivity([
        startedEmission({ epoch: "epoch-1" }),
        committedEmission({ epoch: "epoch-1" }),
        startedEmission({ epoch: "epoch-2" }),
      ]),
    ).toEqual([
      {
        stepKey: "do:prepare",
        epoch: "epoch-1",
        active: false,
        userEmissionCount: 0,
      },
      {
        stepKey: "do:prepare",
        epoch: "epoch-2",
        active: true,
        userEmissionCount: 0,
      },
    ]);
  });

  test("supports multiple active executions", () => {
    const activity = projectWorkflowStepExecutionActivity([
      startedEmission({ stepKey: "do:first", epoch: "first-epoch" }),
      startedEmission({ stepKey: "do:second", epoch: "second-epoch" }),
    ]);

    expect(activity.filter((execution) => execution.active)).toEqual([
      {
        stepKey: "do:first",
        epoch: "first-epoch",
        active: true,
        userEmissionCount: 0,
      },
      {
        stepKey: "do:second",
        epoch: "second-epoch",
        active: true,
        userEmissionCount: 0,
      },
    ]);
  });

  test("ignores duplicate, out-of-order, and mismatched commit controls", () => {
    expect(
      projectWorkflowStepExecutionActivity([
        committedEmission({ payload: { control: "step-committed", epoch: "other-epoch" } }),
        committedEmission(),
        startedEmission(),
        startedEmission(),
      ]),
    ).toEqual([
      {
        stepKey: "do:prepare",
        epoch: "epoch-1",
        active: false,
        userEmissionCount: 0,
      },
    ]);
  });
});

function startedEmission(
  overrides: Partial<WorkflowStepActivityEmission> = {},
): WorkflowStepActivityEmission {
  return {
    actor: "system",
    stepKey: "do:prepare",
    epoch: "epoch-1",
    payload: createWorkflowStepStartedControlPayload(),
    ...overrides,
  };
}

function committedEmission(
  overrides: Partial<WorkflowStepActivityEmission> = {},
): WorkflowStepActivityEmission {
  const epoch = overrides.epoch ?? "epoch-1";
  return {
    actor: "system",
    stepKey: "do:prepare",
    epoch,
    payload: createWorkflowStepCommittedControlPayload(epoch),
    ...overrides,
  };
}

function userEmission(
  overrides: Partial<WorkflowStepActivityEmission> = {},
): WorkflowStepActivityEmission {
  return {
    actor: "user",
    stepKey: "do:prepare",
    epoch: "epoch-1",
    payload: { phase: "running" },
    ...overrides,
  };
}
