import { assert, describe, expect, it } from "vitest";

import {
  createWorkflowStepCommittedControlPayload,
  createWorkflowStepStartedControlPayload,
} from "@fragno-dev/workflows/step-emission-control";

import {
  renderWorkflowVisualizationText,
  visualizeWorkflowSource,
  type StepNode,
  type WorkflowVisualizationSnapshot,
} from "@fragno-dev/workflow-visualizer-tokens";

import {
  currentWorkflowWaitingEventTypes,
  projectScriptWorkflowRuns,
  projectWorkflowRun,
  selectScriptWorkflowRun,
  type AutomationWorkflowRun,
  type ScriptWorkflowRun,
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
const dynamicLoopVisualization = visualizeWorkflowSource(
  absolutePath,
  [
    'defineWorkflow({ name: "demo" }, async (_event, step) => {',
    "  let count = 0;",
    "  while (true) {",
    "    await step.do(`request-oga-upload-${count}`, async () => ({ count }));",
    "    await step.waitForEvent(`wait-for-oga-upload-${count}`, {",
    '      type: "inline-oga-upload-submitted",',
    "    });",
    "    await step.do(`transcribe-oga-${count}`, async () => ({}));",
    "    await step.do(`show-transcription-${count}`, async () => ({}));",
    "    count += 1;",
    "  }",
    "});",
  ].join("\n"),
);
const ambiguousTemplateVisualization = visualizeWorkflowSource(
  absolutePath,
  [
    'defineWorkflow({ name: "demo" }, async (_event, step) => {',
    "  await step.do(`task-${first}`, async () => ({}));",
    "  await step.do(`task-${second}`, async () => ({}));",
    "});",
  ].join("\n"),
);
const exactAndTemplateVisualization = visualizeWorkflowSource(
  absolutePath,
  [
    'defineWorkflow({ name: "demo" }, async (_event, step) => {',
    '  await step.do("task-one", async () => ({}));',
    "  await step.do(`task-${value}`, async () => ({}));",
    "});",
  ].join("\n"),
);
const repeatedTemplateVisualization = visualizeWorkflowSource(
  absolutePath,
  [
    'defineWorkflow({ name: "demo" }, async (_event, step) => {',
    "  while (true) {",
    "    await step.do(`task-${first}`, async () => ({}));",
    "    await step.do(`task-${second}`, async () => ({}));",
    "  }",
    "});",
  ].join("\n"),
);
const skippedLoopTemplateVisualization = visualizeWorkflowSource(
  absolutePath,
  [
    'defineWorkflow({ name: "demo" }, async (_event, step) => {',
    "  while (true) {",
    "    await step.do(`task-${first}`, async () => ({}));",
    "    if (skipSecond) continue;",
    "    await step.do(`task-${second}`, async () => ({}));",
    "  }",
    "});",
  ].join("\n"),
);
const ambiguousLoopWaitVisualization = visualizeWorkflowSource(
  absolutePath,
  [
    'defineWorkflow({ name: "demo" }, async (_event, step) => {',
    "  while (true) {",
    '    await step.waitForEvent(`wait-${first}`, { type: "approved" });',
    '    await step.waitForEvent(`wait-${second}`, { type: "approved" });',
    "  }",
    "});",
  ].join("\n"),
);
const distinctParallelTemplateVisualization = visualizeWorkflowSource(
  absolutePath,
  [
    'defineWorkflow({ name: "demo" }, async (_event, step) => {',
    '  await step.do("parallel", async () => Promise.all([',
    "    step.do(`left-${value}`, async () => ({})),",
    "    step.do(`right-${value}`, async () => ({})),",
    "  ]));",
    "});",
  ].join("\n"),
);
const ambiguousParallelTemplateVisualization = visualizeWorkflowSource(
  absolutePath,
  [
    'defineWorkflow({ name: "demo" }, async (_event, step) => {',
    '  await step.do("parallel", async () => Promise.all([',
    "    step.do(`task-${first}`, async () => ({})),",
    "    step.do(`task-${second}`, async () => ({})),",
    "  ]));",
    "});",
  ].join("\n"),
);
const ambiguousConditionalTemplateVisualization = visualizeWorkflowSource(
  absolutePath,
  [
    'defineWorkflow({ name: "demo" }, async (event, step) => {',
    "  if (event.payload.first) {",
    "    await step.do(`task-${first}`, async () => ({}));",
    "  } else {",
    "    await step.do(`task-${second}`, async () => ({}));",
    "  }",
    "});",
  ].join("\n"),
);

describe("automation script workflow run presentation", () => {
  it("filters active runs by workflow name and script path", () => {
    const matching = workflowRun({ instanceId: "matching", status: "waiting" });
    const wrongPath = workflowRun({
      instanceId: "wrong-path",
      workflowScriptPath: "/workspace/automations/other.workflow.js",
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
        output: { summary: "done" },
        workflowSteps: [workflowStep({ status: "completed" })],
      }),
    });

    assert(run);
    assert(run.status === "complete");
    expect(run.output).toEqual({ summary: "done" });
    expect(run.stepStatesByNodeId.get(stepNode("prepare").id)).toEqual({
      stepRecordId: "step-1",
      status: "completed",
      attempts: 1,
      completedAt: "2026-07-24T10:00:00.000Z",
      emissionCount: 0,
      current: false,
    });
  });

  it("projects a durable result onto its source-derived step", () => {
    const generatedResult = {
      recordId: "record-1",
      $ui: { version: 1, state: {}, spec: { root: "report", elements: {} } },
    };
    const run = projectWorkflowRun({
      visualization,
      instance: workflowRun({
        workflowSteps: [
          workflowStep({
            id: "finalize",
            name: "finalize",
            stepKey: "do:finalize",
            result: generatedResult,
          }),
        ],
      }),
    });

    assert(run);
    expect(run.stepStatesByNodeId.get(stepNode("finalize").id)).toMatchObject({
      status: "completed",
      result: generatedResult,
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
      stepRecordId: "step-1",
      status: "waiting",
      attempts: 1,
      emissionCount: 0,
      current: true,
    });
  });

  it("projects current waitForEvent types and preserves the instance workflow route target", () => {
    const run = projectWorkflowRun({
      visualization,
      instance: workflowRun({
        workflowName: "codemode-script",
        status: "waiting",
        workflowEvents: [
          {
            id: "event-1",
            actor: "user",
            type: "approved",
            payload: { decision: "approve" },
            createdAt: "2026-07-24T10:01:00.000Z",
            deliveredAt: "2026-07-24T10:01:01.000Z",
            consumedByStepKey: "waitForEvent:approval",
          },
        ],
        workflowSteps: [
          workflowStep({
            stepKey: "waitForEvent:approval",
            name: "approval",
            type: "waitForEvent",
            status: "waiting",
            waitEventType: "approved",
          }),
        ],
      }),
    });

    assert(run);
    assert(run.workflowName === "demo");
    assert(run.instanceWorkflowName === "codemode-script");
    expect(run.waitingEventTypes).toEqual(["approved"]);
    expect(run.workflowEvents).toEqual([
      expect.objectContaining({
        id: "event-1",
        type: "approved",
        payload: { decision: "approve" },
      }),
    ]);
    expect(run.stepStatesByNodeId.get(stepNode("approval").id)).toMatchObject({
      status: "waiting",
      waitEventType: "approved",
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
      stepRecordId: "step-1",
      status: "completed",
      attempts: 1,
      completedAt: "2026-07-24T10:00:00.000Z",
      emissionCount: 1,
      current: false,
    });
  });

  it("removes speculative downstream activity from a losing execution", () => {
    const runs = projectScriptWorkflowRuns({
      absolutePath,
      visualization,
      instances: [
        workflowRun({
          workflowSteps: [
            workflowStep({
              stepKey: "do:prepare",
              status: "completed",
              committedByExecutionId: "winning-execution",
            }),
          ],
          workflowStepEmissions: [
            workflowEmission({
              actor: "user",
              executionId: "losing-execution",
              stepKey: "do:prepare",
            }),
            workflowEmission({
              actor: "user",
              executionId: "losing-execution",
              stepKey: "do:finalize",
            }),
          ],
        }),
      ],
    });

    assert(runs[0]?.stepStatesByNodeId.get(stepNode("prepare").id)?.emissionCount === 0);
    expect(runs[0]?.stepStatesByNodeId.get(stepNode("finalize").id)).toBeUndefined();
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
      stepRecordId: "step-1",
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
      stepRecordId: "step-1",
      status: "completed",
      attempts: 1,
      completedAt: "2026-07-24T10:00:00.000Z",
      emissionCount: 0,
      current: false,
    });
  });

  it("does not mark abandoned waiting descendants of a completed race as current", () => {
    const workflowSteps = [
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
        waitEventType: "approved",
      }),
    ];
    const runs = projectScriptWorkflowRuns({
      absolutePath,
      visualization: raceVisualization,
      instances: [
        workflowRun({
          status: "waiting",
          workflowSteps,
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
    expect(
      currentWorkflowWaitingEventTypes([
        workflowSteps[0]!,
        workflowStep({
          id: "abandoned-wait",
          stepKey: "do:race>waitForEvent:abandoned",
          parentStepKey: "do:race",
          name: "abandoned",
          type: "waitForEvent",
          status: "waiting",
          waitEventType: "abandoned",
        }),
        workflowSteps[2]!,
      ]),
    ).toEqual(["approved"]);
  });

  it("maps runtime steps back to template-named loop steps", () => {
    const requestResult = { count: 0 };
    const run = projectWorkflowRun({
      visualization: dynamicLoopVisualization,
      instance: workflowRun({
        status: "waiting",
        workflowSteps: [
          workflowStep({
            id: "request-upload",
            stepKey: "do:request-oga-upload-0",
            name: "request-oga-upload-0",
            result: requestResult,
          }),
          workflowStep({
            id: "wait-upload",
            stepKey: "waitForEvent:wait-for-oga-upload-0",
            name: "wait-for-oga-upload-0",
            type: "waitForEvent",
            status: "waiting",
            waitEventType: "inline-oga-upload-submitted",
          }),
        ],
      }),
    });

    assert(run);
    expect(
      run.stepStatesByNodeId.get(
        stepNodeIn(dynamicLoopVisualization, "request-oga-upload-${count}").id,
      ),
    ).toMatchObject({ status: "completed", result: requestResult });
    expect(
      run.stepStatesByNodeId.get(
        stepNodeIn(dynamicLoopVisualization, "wait-for-oga-upload-${count}").id,
      ),
    ).toMatchObject({
      status: "waiting",
      waitEventType: "inline-oga-upload-submitted",
      current: true,
    });
    expect(run.waitingEventTypes).toEqual(["inline-oga-upload-submitted"]);
  });

  it("maps equally specific template-named steps in runtime order", () => {
    const firstResult = { source: "first" };
    const secondResult = { source: "second" };
    const runtimeSteps = [
      workflowStep({
        id: "second-task",
        stepKey: "do:task-two",
        name: "task-two",
        result: secondResult,
        createdAt: "2026-07-24T10:00:02.000Z",
      }),
      workflowStep({
        id: "first-task",
        stepKey: "do:task-one",
        name: "task-one",
        result: firstResult,
        createdAt: "2026-07-24T10:00:01.000Z",
      }),
    ];
    const run = projectWorkflowRun({
      visualization: ambiguousTemplateVisualization,
      instance: workflowRun({ workflowSteps: runtimeSteps }),
    });

    assert(run);
    expect(renderWorkflowRunPresentationText(ambiguousTemplateVisualization, run, runtimeSteps))
      .toMatchInlineSnapshot(`
        "workflow demo
        ├─ 0. do task-\${first}
        │  returns: ({})
        └─ 1. do task-\${second}
           returns: ({})

        run run-1
        ├─ do task-\${first} => runtime task-one · record first-task · completed · result {"source":"first"}
        └─ do task-\${second} => runtime task-two · record second-task · completed · result {"source":"second"}"
      `);
  });

  it("resolves exact and template names together before applying the occurrence", () => {
    const staticResult = { source: "static" };
    const templateResult = { source: "template" };
    const runtimeSteps = [
      workflowStep({
        id: "static-task",
        stepKey: "do:task-one",
        name: "task-one",
        result: staticResult,
        createdAt: "2026-07-24T10:00:01.000Z",
      }),
      workflowStep({
        id: "template-task",
        stepKey: "do:task-one#1",
        name: "task-one",
        result: templateResult,
        createdAt: "2026-07-24T10:00:02.000Z",
      }),
    ];
    const run = projectWorkflowRun({
      visualization: exactAndTemplateVisualization,
      instance: workflowRun({ workflowSteps: runtimeSteps }),
    });

    assert(run);
    expect(
      run.stepStatesByNodeId.get(stepNodeIn(exactAndTemplateVisualization, "task-one").id),
    ).toMatchObject({ result: staticResult });
    expect(
      run.stepStatesByNodeId.get(stepNodeIn(exactAndTemplateVisualization, "task-${value}").id),
    ).toMatchObject({ result: templateResult });
    expect(run.unmappedRuntimeSteps).toEqual([]);
  });

  it("fails closed for repeated template families across loop iterations", () => {
    const firstIterationSteps = [
      workflowStep({
        id: "first-iteration-first-task",
        stepKey: "do:task-one",
        name: "task-one",
        result: { iteration: 1, source: "first" },
        createdAt: "2026-07-24T10:00:01.000Z",
      }),
      workflowStep({
        id: "first-iteration-second-task",
        stepKey: "do:task-two",
        name: "task-two",
        result: { iteration: 1, source: "second" },
        createdAt: "2026-07-24T10:00:02.000Z",
      }),
    ];
    const secondIterationSteps = [
      workflowStep({
        id: "second-iteration-first-task",
        stepKey: "do:task-three",
        name: "task-three",
        result: { iteration: 2, source: "first" },
        createdAt: "2026-07-24T10:00:03.000Z",
      }),
      workflowStep({
        id: "second-iteration-second-task",
        stepKey: "do:task-four",
        name: "task-four",
        result: { iteration: 2, source: "second" },
        createdAt: "2026-07-24T10:00:04.000Z",
      }),
    ];
    const afterFirstIteration = projectWorkflowRun({
      visualization: repeatedTemplateVisualization,
      instance: workflowRun({ workflowSteps: firstIterationSteps }),
    });
    const partialSecondIterationSteps = [...firstIterationSteps, secondIterationSteps[0]!];
    const duringSecondIteration = projectWorkflowRun({
      visualization: repeatedTemplateVisualization,
      instance: workflowRun({ workflowSteps: partialSecondIterationSteps }),
    });
    const allIterationSteps = [...firstIterationSteps, ...secondIterationSteps];
    const afterSecondIteration = projectWorkflowRun({
      visualization: repeatedTemplateVisualization,
      instance: workflowRun({ workflowSteps: allIterationSteps }),
    });

    assert(afterFirstIteration);
    assert(duringSecondIteration);
    assert(afterSecondIteration);
    expect(
      [
        "after first iteration",
        renderWorkflowRunPresentationText(
          repeatedTemplateVisualization,
          afterFirstIteration,
          firstIterationSteps,
        ),
        "",
        "during second iteration",
        renderWorkflowRunPresentationText(
          repeatedTemplateVisualization,
          duringSecondIteration,
          partialSecondIterationSteps,
        ),
        "",
        "after second iteration",
        renderWorkflowRunPresentationText(
          repeatedTemplateVisualization,
          afterSecondIteration,
          allIterationSteps,
        ),
      ].join("\n"),
    ).toMatchInlineSnapshot(`
      "after first iteration
      workflow demo
      └─ 0. while true
         ├─ 0. do task-\${first}
         │  returns: ({})
         └─ 1. do task-\${second}
            returns: ({})

      run run-1
      ├─ do task-\${first} => (unmapped)
      └─ do task-\${second} => (unmapped)

      unmapped runtime
      ├─ runtime task-one · key do:task-one · completed
      └─ runtime task-two · key do:task-two · completed

      during second iteration
      workflow demo
      └─ 0. while true
         ├─ 0. do task-\${first}
         │  returns: ({})
         └─ 1. do task-\${second}
            returns: ({})

      run run-1
      ├─ do task-\${first} => (unmapped)
      └─ do task-\${second} => (unmapped)

      unmapped runtime
      ├─ runtime task-one · key do:task-one · completed
      ├─ runtime task-two · key do:task-two · completed
      └─ runtime task-three · key do:task-three · completed

      after second iteration
      workflow demo
      └─ 0. while true
         ├─ 0. do task-\${first}
         │  returns: ({})
         └─ 1. do task-\${second}
            returns: ({})

      run run-1
      ├─ do task-\${first} => (unmapped)
      └─ do task-\${second} => (unmapped)

      unmapped runtime
      ├─ runtime task-one · key do:task-one · completed
      ├─ runtime task-two · key do:task-two · completed
      ├─ runtime task-three · key do:task-three · completed
      └─ runtime task-four · key do:task-four · completed"
    `);
  });

  it("fails closed when a loop iteration skips a template-family step", () => {
    const runtimeSteps = [
      workflowStep({
        id: "first-iteration-first-task",
        stepKey: "do:task-one",
        name: "task-one",
        result: { iteration: 1, source: "first" },
        createdAt: "2026-07-24T10:00:01.000Z",
      }),
      workflowStep({
        id: "second-iteration-first-task",
        stepKey: "do:task-two",
        name: "task-two",
        result: { iteration: 2, source: "first" },
        createdAt: "2026-07-24T10:00:02.000Z",
      }),
      workflowStep({
        id: "second-iteration-second-task",
        stepKey: "do:task-three",
        name: "task-three",
        result: { iteration: 2, source: "second" },
        createdAt: "2026-07-24T10:00:03.000Z",
      }),
    ];
    const run = projectWorkflowRun({
      visualization: skippedLoopTemplateVisualization,
      instance: workflowRun({ workflowSteps: runtimeSteps }),
    });

    assert(run);
    expect(renderWorkflowRunPresentationText(skippedLoopTemplateVisualization, run, runtimeSteps))
      .toMatchInlineSnapshot(`
        "workflow demo
        └─ 0. while true
           ├─ 0. do task-\${first}
           │  returns: ({})
           └─ 1. do task-\${second}
              returns: ({})

        run run-1
        ├─ do task-\${first} => (unmapped)
        └─ do task-\${second} => (unmapped)

        unmapped runtime
        ├─ runtime task-one · key do:task-one · completed
        ├─ runtime task-two · key do:task-two · completed
        └─ runtime task-three · key do:task-three · completed"
      `);
  });

  it("keeps an ambiguous loop wait visible at the run level", () => {
    const runtimeSteps = [
      workflowStep({
        id: "waiting-step",
        stepKey: "waitForEvent:wait-one",
        name: "wait-one",
        type: "waitForEvent",
        status: "waiting",
        waitEventType: "approved",
        createdAt: "2026-07-24T10:00:01.000Z",
      }),
    ];
    const run = projectWorkflowRun({
      visualization: ambiguousLoopWaitVisualization,
      instance: workflowRun({ status: "waiting", workflowSteps: runtimeSteps }),
    });

    assert(run);
    expect(run.waitingEventTypes).toEqual(["approved"]);
    assert(run.hasUnmappedCurrentStep);
    expect(renderWorkflowRunPresentationText(ambiguousLoopWaitVisualization, run, runtimeSteps))
      .toMatchInlineSnapshot(`
      "workflow demo
      └─ 0. while true
         ├─ 0. waitForEvent wait-\${first}
         │  event: approved
         └─ 1. waitForEvent wait-\${second}
            event: approved

      run run-1
      ├─ waitForEvent wait-\${first} => (unmapped)
      └─ waitForEvent wait-\${second} => (unmapped)

      unmapped runtime
      └─ runtime wait-one · key waitForEvent:wait-one · current"
    `);
  });

  it("maps distinct template names across parallel branches", () => {
    const runtimeSteps = [
      workflowStep({
        id: "left-task",
        stepKey: "do:parallel>do:left-one",
        parentStepKey: "do:parallel",
        name: "left-one",
        result: { branch: "left" },
        createdAt: "2026-07-24T10:00:01.000Z",
      }),
      workflowStep({
        id: "right-task",
        stepKey: "do:parallel>do:right-one",
        parentStepKey: "do:parallel",
        name: "right-one",
        result: { branch: "right" },
        createdAt: "2026-07-24T10:00:02.000Z",
      }),
      workflowStep({
        id: "parallel-task",
        stepKey: "do:parallel",
        name: "parallel",
        createdAt: "2026-07-24T10:00:03.000Z",
      }),
    ];
    const run = projectWorkflowRun({
      visualization: distinctParallelTemplateVisualization,
      instance: workflowRun({ workflowSteps: runtimeSteps }),
    });

    assert(run);
    expect(
      renderWorkflowRunPresentationText(distinctParallelTemplateVisualization, run, runtimeSteps),
    ).toMatchInlineSnapshot(`
      "workflow demo
      └─ 0. do parallel
         returns: Promise.all([ step.do(\`left-\${value}\`, async () => ({})), step.do(\`right-\${value}\`, async () => ({})), ])
         └─ 0. parallel Promise.all
            ├─ branch 1
            │  └─ 0. do left-\${value}
            │     returns: ({})
            └─ branch 2
               └─ 0. do right-\${value}
                  returns: ({})

      run run-1
      ├─ do parallel => runtime parallel · record parallel-task · completed
      ├─ do left-\${value} => runtime left-one · record left-task · completed · result {"branch":"left"}
      └─ do right-\${value} => runtime right-one · record right-task · completed · result {"branch":"right"}"
    `);
  });

  it("does not use runtime order to guess across parallel branches", () => {
    const runtimeSteps = [
      workflowStep({
        id: "first-parallel-task",
        stepKey: "do:parallel>do:task-one",
        parentStepKey: "do:parallel",
        name: "task-one",
        result: { branch: "first" },
        createdAt: "2026-07-24T10:00:01.000Z",
      }),
      workflowStep({
        id: "second-parallel-task",
        stepKey: "do:parallel>do:task-two",
        parentStepKey: "do:parallel",
        name: "task-two",
        result: { branch: "second" },
        createdAt: "2026-07-24T10:00:02.000Z",
      }),
      workflowStep({
        id: "parallel-task",
        stepKey: "do:parallel",
        name: "parallel",
        createdAt: "2026-07-24T10:00:03.000Z",
      }),
    ];
    const run = projectWorkflowRun({
      visualization: ambiguousParallelTemplateVisualization,
      instance: workflowRun({ workflowSteps: runtimeSteps }),
    });

    assert(run);
    expect(
      renderWorkflowRunPresentationText(ambiguousParallelTemplateVisualization, run, runtimeSteps),
    ).toMatchInlineSnapshot(`
      "workflow demo
      └─ 0. do parallel
         returns: Promise.all([ step.do(\`task-\${first}\`, async () => ({})), step.do(\`task-\${second}\`, async () => ({})), ])
         └─ 0. parallel Promise.all
            ├─ branch 1
            │  └─ 0. do task-\${first}
            │     returns: ({})
            └─ branch 2
               └─ 0. do task-\${second}
                  returns: ({})

      run run-1
      ├─ do parallel => runtime parallel · record parallel-task · completed
      ├─ do task-\${first} => (unmapped)
      └─ do task-\${second} => (unmapped)

      unmapped runtime
      ├─ runtime task-one · key do:parallel>do:task-one · completed
      └─ runtime task-two · key do:parallel>do:task-two · completed"
    `);
  });

  it("does not use runtime order to guess across conditional branches", () => {
    const runtimeSteps = [
      workflowStep({
        id: "selected-branch-task",
        stepKey: "do:task-two",
        name: "task-two",
        result: { branch: "second" },
        createdAt: "2026-07-24T10:00:01.000Z",
      }),
    ];
    const run = projectWorkflowRun({
      visualization: ambiguousConditionalTemplateVisualization,
      instance: workflowRun({ workflowSteps: runtimeSteps }),
    });

    assert(run);
    expect(
      renderWorkflowRunPresentationText(
        ambiguousConditionalTemplateVisualization,
        run,
        runtimeSteps,
      ),
    ).toMatchInlineSnapshot(`
      "workflow demo
      └─ 0. if event.payload.first
         ├─ then
         │  └─ 0. do task-\${first}
         │     returns: ({})
         └─ else
            └─ 0. do task-\${second}
               returns: ({})

      run run-1
      ├─ do task-\${first} => (unmapped)
      └─ do task-\${second} => (unmapped)

      unmapped runtime
      └─ runtime task-two · key do:task-two · completed"
    `);
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

function renderWorkflowRunPresentationText(
  visualization: WorkflowVisualizationSnapshot,
  run: ScriptWorkflowRun,
  runtimeSteps: readonly AutomationWorkflowRun["workflowSteps"][number][],
): string {
  const runtimeStepByRecordId = new Map(runtimeSteps.map((step) => [step.id, step]));
  const stepNodes = visualization.graph.nodes
    .filter(
      (node): node is StepNode => node.kind === "step" && node.workflowName === run.workflowName,
    )
    .sort((left, right) => left.sourceOrder - right.sourceOrder);
  const projectionLines = stepNodes.map((step, index) => {
    const connector = index === stepNodes.length - 1 ? "└─" : "├─";
    const state = run.stepStatesByNodeId.get(step.id);
    if (!state) {
      return `${connector} ${step.stepType} ${step.label} => (unmapped)`;
    }

    const runtimeStep = state.stepRecordId
      ? runtimeStepByRecordId.get(state.stepRecordId)
      : undefined;
    const details = [
      runtimeStep ? `runtime ${runtimeStep.name}` : undefined,
      state.stepRecordId ? `record ${state.stepRecordId}` : undefined,
      state.status,
      state.current ? "current" : undefined,
      state.result !== undefined ? `result ${renderWorkflowRunValue(state.result)}` : undefined,
      state.error ? `error ${JSON.stringify(state.error)}` : undefined,
      state.waitEventType ? `waiting for ${state.waitEventType}` : undefined,
    ].filter((detail): detail is string => detail !== undefined);
    return `${connector} ${step.stepType} ${step.label} => ${details.join(" · ")}`;
  });

  const unmappedLines = run.unmappedRuntimeSteps.map((step, index) => {
    const connector = index === run.unmappedRuntimeSteps.length - 1 ? "└─" : "├─";
    return `${connector} runtime ${step.name ?? step.stepKey} · key ${step.stepKey} · ${step.current ? "current" : step.status}`;
  });

  return [
    renderWorkflowVisualizationText(visualization),
    "",
    `run ${run.instanceId}`,
    ...projectionLines,
    ...(unmappedLines.length ? ["", "unmapped runtime", ...unmappedLines] : []),
  ].join("\n");
}

function renderWorkflowRunValue(value: unknown): string {
  return JSON.stringify(value) ?? String(value);
}

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
    id: `codemode-script:${instanceId}`,
    instanceId,
    workflowName: "codemode-script",
    remoteWorkflowName: "demo",
    status: "active",
    workflowScriptPath: absolutePath,
    output: null,
    createdAt: "2026-07-24T09:00:00.000Z",
    updatedAt: "2026-07-24T10:00:00.000Z",
    workflowSteps: [],
    workflowEvents: [],
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
    committedByExecutionId: "execution-1",
    attempts: 1,
    waitEventType: null,
    result: null,
    errorName: null,
    errorMessage: null,
    createdAt: "2026-07-24T10:00:00.000Z",
    updatedAt: "2026-07-24T10:00:00.000Z",
    ...overrides,
  };
}

function workflowEmission(overrides: Partial<WorkflowRunEmission> = {}): WorkflowRunEmission {
  return {
    id: "emission-1",
    actor: "system",
    stepKey: "do:prepare",
    executionId: "execution-1",
    epoch: "epoch-1",
    sequence: 0,
    payload: createWorkflowStepStartedControlPayload(),
    createdAt: "2026-07-24T10:00:01.000Z",
    ...overrides,
  };
}
