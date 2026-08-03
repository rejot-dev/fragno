import { describe, expect, test, assert } from "vitest";

import {
  createWorkflowEventConsumedControlPayload,
  createWorkflowStepCommittedControlPayload,
  createWorkflowStepStartedControlPayload,
  isWorkflowEventConsumedControlPayload,
  isWorkflowStepCommittedControlPayload,
  isWorkflowStepStartedControlPayload,
  projectWorkflowStepExecutionActivity,
  selectCanonicalWorkflowStepEmissions,
  selectWorkflowStepCommittedEpochs,
  selectWorkflowStepPresentationEmissions,
  selectWorkflowStepReplayEpochs,
  type WorkflowStepActivityEmission,
} from "./step-emission-control";

describe("workflow step emission controls", () => {
  test("constructs and recognizes lifecycle control payloads", () => {
    const started = createWorkflowStepStartedControlPayload();
    const committed = createWorkflowStepCommittedControlPayload("epoch-1");
    const eventConsumed = createWorkflowEventConsumedControlPayload("event-1");

    expect(started).toEqual({ control: "step-started" });
    expect(committed).toEqual({ control: "step-committed", epoch: "epoch-1" });
    expect(eventConsumed).toEqual({ control: "event-consumed", eventId: "event-1" });
    assert(isWorkflowStepStartedControlPayload(started));
    assert(isWorkflowStepCommittedControlPayload(committed));
    assert(isWorkflowEventConsumedControlPayload(eventConsumed));
    assert(!isWorkflowStepCommittedControlPayload({ control: "step-committed" }));
    assert(!isWorkflowEventConsumedControlPayload({ control: "event-consumed" }));
  });

  test("selects the latest started epoch as the replay source before commit", () => {
    const emissions = [
      startedEmission({ epoch: "epoch-1" }),
      userEmission({ epoch: "epoch-1" }),
      startedEmission({ epoch: "epoch-2" }),
    ];

    expect(selectWorkflowStepReplayEpochs(emissions)).toEqual(new Map([["do:prepare", "epoch-2"]]));
    expect(selectWorkflowStepCommittedEpochs(emissions)).toEqual(new Map());
  });

  test("selects the epoch that durably commits after overlapping starts", () => {
    const emissions = [
      startedEmission({ epoch: "epoch-1" }),
      startedEmission({ epoch: "epoch-2" }),
      committedEmission({ epoch: "epoch-1" }),
    ];

    expect(selectWorkflowStepCommittedEpochs(emissions)).toEqual(
      new Map([["do:prepare", "epoch-1"]]),
    );
    expect(selectWorkflowStepReplayEpochs(emissions)).toEqual(new Map([["do:prepare", "epoch-1"]]));
  });

  test("allows a retry epoch to become the next replay source", () => {
    expect(
      selectWorkflowStepReplayEpochs([
        startedEmission({ epoch: "epoch-1" }),
        committedEmission({ epoch: "epoch-1" }),
        startedEmission({ epoch: "epoch-2" }),
      ]),
    ).toEqual(new Map([["do:prepare", "epoch-2"]]));
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

  test("presents the first observed execution while a step race is unresolved", () => {
    const firstStarted = startedEmission({
      executionId: "execution-z",
      epoch: "epoch-z",
    });
    const firstUpdate = userEmission({
      executionId: "execution-z",
      epoch: "epoch-z",
      payload: { source: "first" },
    });
    const laterStarted = startedEmission({
      executionId: "execution-a",
      epoch: "epoch-a",
    });
    const laterUpdate = userEmission({
      executionId: "execution-a",
      epoch: "epoch-a",
      payload: { source: "later" },
    });

    expect(
      selectWorkflowStepPresentationEmissions([
        firstStarted,
        firstUpdate,
        laterStarted,
        laterUpdate,
      ]),
    ).toEqual([firstStarted, firstUpdate]);
    expect(
      selectWorkflowStepPresentationEmissions([
        laterStarted,
        laterUpdate,
        firstStarted,
        firstUpdate,
      ]),
    ).toEqual([laterStarted, laterUpdate]);
  });

  test("switches presentation when the initially hidden execution commits", () => {
    const firstStarted = startedEmission({
      executionId: "execution-first",
      epoch: "epoch-first",
    });
    const firstUpdate = userEmission({
      executionId: "execution-first",
      epoch: "epoch-first",
      payload: { source: "first" },
    });
    const winnerStarted = startedEmission({
      executionId: "execution-winner",
      epoch: "epoch-winner",
    });
    const winnerUpdate = userEmission({
      executionId: "execution-winner",
      epoch: "epoch-winner",
      payload: { source: "winner" },
    });
    const winnerCommitted = committedEmission({
      executionId: "execution-winner",
      epoch: "epoch-winner",
    });

    expect(
      selectWorkflowStepPresentationEmissions([
        firstStarted,
        firstUpdate,
        winnerStarted,
        winnerUpdate,
        winnerCommitted,
      ]),
    ).toEqual([winnerStarted, winnerUpdate, winnerCommitted]);
  });

  test("removes downstream emissions from an execution proven losing by a commit control", () => {
    const winnerStarted = startedEmission({
      executionId: "execution-winner",
      epoch: "epoch-winner",
    });
    const losingContested = userEmission({
      executionId: "execution-loser",
      epoch: "epoch-loser",
      payload: { source: "losing-contested" },
    });
    const losingDownstream = userEmission({
      stepKey: "do:downstream",
      executionId: "execution-loser",
      epoch: "epoch-loser-downstream",
      payload: { source: "losing-downstream" },
    });
    const winnerCommitted = committedEmission({
      executionId: "execution-winner",
      epoch: "epoch-winner",
    });

    expect(
      selectWorkflowStepPresentationEmissions([
        winnerStarted,
        losingContested,
        losingDownstream,
        winnerCommitted,
      ]),
    ).toEqual([winnerStarted, winnerCommitted]);
  });

  test("keeps parallel steps from the presented execution", () => {
    const first = startedEmission({ executionId: "execution-first" });
    const parallel = startedEmission({
      stepKey: "do:parallel",
      executionId: "execution-first",
      epoch: "parallel-epoch",
    });
    const competitor = startedEmission({
      executionId: "execution-second",
      epoch: "second-epoch",
    });

    expect(selectWorkflowStepPresentationEmissions([first, parallel, competitor])).toEqual([
      first,
      parallel,
    ]);
  });

  test("keeps competing executions until a terminal step establishes a winner", () => {
    const emissions = [
      userEmission({ executionId: "execution-a", epoch: "epoch-a" }),
      userEmission({ executionId: "execution-b", epoch: "epoch-b" }),
    ];

    expect(
      selectCanonicalWorkflowStepEmissions({
        steps: [terminalStep({ status: "waiting", committedByExecutionId: "execution-a" })],
        emissions,
      }),
    ).toEqual(emissions);
  });

  test("removes every emission from an execution that lost a terminal step", () => {
    const winner = userEmission({ executionId: "execution-a", epoch: "epoch-a" });
    const losingContested = userEmission({ executionId: "execution-b", epoch: "epoch-b" });
    const losingDownstream = userEmission({
      stepKey: "do:downstream",
      executionId: "execution-b",
      epoch: "epoch-b-downstream",
    });
    const unrelated = userEmission({
      stepKey: "do:unrelated",
      executionId: "execution-c",
      epoch: "epoch-c",
    });

    expect(
      selectCanonicalWorkflowStepEmissions({
        steps: [terminalStep({ committedByExecutionId: "execution-a" })],
        emissions: [winner, losingContested, losingDownstream, unrelated],
      }),
    ).toEqual([winner, unrelated]);
  });

  test("lets either overlapping execution become the durable winner", () => {
    const older = userEmission({ executionId: "execution-older", epoch: "epoch-older" });
    const newer = userEmission({ executionId: "execution-newer", epoch: "epoch-newer" });

    expect(
      selectCanonicalWorkflowStepEmissions({
        steps: [terminalStep({ committedByExecutionId: "execution-newer" })],
        emissions: [older, newer],
      }),
    ).toEqual([newer]);
  });

  test("treats a terminal errored step as canonical ownership", () => {
    const winner = userEmission({ executionId: "execution-a" });
    const loser = userEmission({ executionId: "execution-b", epoch: "epoch-b" });

    expect(
      selectCanonicalWorkflowStepEmissions({
        steps: [terminalStep({ status: "errored", committedByExecutionId: "execution-a" })],
        emissions: [winner, loser],
      }),
    ).toEqual([winner]);
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
    executionId: "execution-1",
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
    executionId: "execution-1",
    epoch,
    payload: createWorkflowStepCommittedControlPayload(epoch),
    ...overrides,
  };
}

function terminalStep(
  overrides: Partial<{
    stepKey: string;
    status: string;
    committedByExecutionId: string;
  }> = {},
) {
  return {
    stepKey: "do:prepare",
    status: "completed",
    committedByExecutionId: "execution-1",
    ...overrides,
  };
}

function userEmission(
  overrides: Partial<WorkflowStepActivityEmission> = {},
): WorkflowStepActivityEmission {
  return {
    actor: "user",
    stepKey: "do:prepare",
    executionId: "execution-1",
    epoch: "epoch-1",
    payload: { phase: "running" },
    ...overrides,
  };
}
