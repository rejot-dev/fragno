import { assert, describe, test } from "vitest";

import {
  layoutWorkflowRun,
  positionOnScale,
  reachedWorkflowEndIds,
  replayTimeAfter,
  WORKFLOW_RUN_START_ROW_ID,
  timeAtScalePosition,
  workflowStepStatusAt,
  workflowTimeScale,
  type WorkflowRunNode,
  type WorkflowRunStep,
} from "./workflow-run-timeline-model";

function makeStep(id: string, fields: Partial<WorkflowRunStep> = {}): WorkflowRunStep {
  return {
    id,
    label: id,
    detail: null,
    status: "pending",
    activity: "work",
    attempts: { count: 0, max: 1 },
    timing: { kind: "unstarted" },
    children: [],
    ...fields,
  };
}

function node(id: string, fields: Partial<WorkflowRunStep> = {}): WorkflowRunNode {
  return { kind: "step", step: makeStep(id, fields) };
}

function end(id: string, reason: "return" | "error" | "caught" = "return"): WorkflowRunNode {
  return { kind: "end", end: { id, label: id, reason } };
}

function guard(id: string): WorkflowRunNode {
  return {
    kind: "fork",
    id,
    runs: "one",
    branches: [
      { id: `${id}-then`, label: `if ${id}`, nodes: [end(id)] },
      { id: `${id}-fallthrough`, label: null, nodes: [] },
    ],
  };
}

function layout(nodes: readonly WorkflowRunNode[], expanded: readonly string[] = []) {
  return layoutWorkflowRun(nodes, new Set(expanded), "telegram · message.received");
}

const START = WORKFLOW_RUN_START_ROW_ID;

describe("workflow run layout", () => {
  test("detours earlier branches to the left and joins every branch into the next step", () => {
    const placed = layout([
      node("pull"),
      {
        kind: "fork",
        id: "fork",
        runs: "one",
        branches: [
          { id: "side", label: "ok", nodes: [node("promote")] },
          { id: "main", label: "mismatch", nodes: [node("quarantine")] },
        ],
      },
      node("summary"),
    ]);

    assert.deepEqual(
      placed.rows.map((row) => [row.id, row.lane, row.label]),
      [
        [START, 0, null],
        ["pull", 0, null],
        ["promote", 1, "ok"],
        ["quarantine", 0, "mismatch"],
        ["summary", 0, null],
      ],
    );
    assert.equal(placed.laneCount, 2);
    assert.deepEqual(
      placed.rails.map((rail) => [rail.fromRowId, rail.toRowId, rail.points]),
      [
        [
          START,
          "pull",
          [
            { lane: 0, row: 0 },
            { lane: 0, row: 1 },
          ],
        ],
        // Leaves along the source lane, then turns into the detour at the detour's row.
        [
          "pull",
          "promote",
          [
            { lane: 0, row: 1 },
            { lane: 0, row: 2 },
            { lane: 1, row: 2 },
          ],
        ],
        [
          "pull",
          "quarantine",
          [
            { lane: 0, row: 1 },
            { lane: 0, row: 3 },
          ],
        ],
        [
          "promote",
          "summary",
          [
            { lane: 1, row: 2 },
            { lane: 1, row: 4 },
            { lane: 0, row: 4 },
          ],
        ],
        [
          "quarantine",
          "summary",
          [
            { lane: 0, row: 3 },
            { lane: 0, row: 4 },
          ],
        ],
      ],
    );
  });

  test("routes an empty detour branch around the steps it skips", () => {
    const placed = layout([
      node("check"),
      {
        kind: "fork",
        id: "fork",
        runs: "one",
        branches: [
          { id: "bypass", label: null, nodes: [] },
          { id: "main", label: null, nodes: [node("repair")] },
        ],
      },
      node("done"),
    ]);

    const bypass = placed.rails.find(
      (rail) => rail.fromRowId === "check" && rail.toRowId === "done",
    );
    assert.deepEqual(bypass?.points, [
      { lane: 0, row: 1 },
      { lane: 1, row: 1 },
      { lane: 1, row: 3 },
      { lane: 0, row: 3 },
    ]);
  });

  test("shows nested steps only when their parent is expanded and keeps rails on parent rows", () => {
    const nodes = [
      node("parent", { children: [makeStep("child-a"), makeStep("child-b")] }),
      node("next"),
    ];

    assert.deepEqual(
      layout(nodes).rows.map((row) => row.id),
      [START, "parent", "next"],
    );

    const expanded = layout(nodes, ["parent"]);
    assert.deepEqual(
      expanded.rows.map((row) => [row.id, row.depth]),
      [
        [START, 0],
        ["parent", 0],
        ["child-a", 1],
        ["child-b", 1],
        ["next", 0],
      ],
    );
    const parentToNext = expanded.rails.find((rail) => rail.fromRowId === "parent");
    assert.deepEqual(parentToNext?.points, [
      { lane: 0, row: 1 },
      { lane: 0, row: 4 },
    ]);
  });
});

describe("workflow run layout with ends, loops, and try", () => {
  test("hangs guards before the first step off the start row and reuses their lane", () => {
    const placed = layout([guard("not-start"), guard("bad-actor"), node("resolve")]);

    assert.deepEqual(
      placed.rows.map((row) => [row.id, row.lane]),
      [
        [START, 0],
        ["not-start", 1],
        ["bad-actor", 1],
        ["resolve", 0],
      ],
    );
    assert.equal(placed.laneCount, 2);
    // Nothing leaves an end: the only way past both guards is the fall-through.
    assert.deepEqual(
      placed.rails.map((rail) => [rail.fromRowId, rail.toRowId]),
      [
        [START, "not-start"],
        [START, "bad-actor"],
        [START, "resolve"],
      ],
    );
  });

  test("draws a repeating section's way back to its first step on its own lane", () => {
    const placed = layout([
      node("fetch"),
      {
        kind: "section",
        id: "loop",
        label: "for page",
        repeats: true,
        nodes: [node("import"), node("checkpoint")],
      },
      node("done"),
    ]);

    assert.deepEqual(
      placed.rows.map((row) => [row.id, row.label]),
      [
        [START, null],
        ["fetch", null],
        ["import", "for page"],
        ["checkpoint", null],
        ["done", null],
      ],
    );
    const repeat = placed.rails.find((rail) => rail.kind === "repeat");
    assert.deepEqual(
      [repeat?.fromRowId, repeat?.toRowId, repeat?.points],
      [
        "checkpoint",
        "import",
        [
          { lane: 0, row: 3 },
          { lane: 1, row: 3 },
          { lane: 1, row: 2 },
          { lane: 0, row: 2 },
        ],
      ],
    );
  });

  test("hands throws from anywhere in a try body to its handler and joins both into finally", () => {
    const placed = layout([
      {
        kind: "try",
        id: "try",
        body: [node("read"), node("transcribe")],
        catch: [node("discard")],
        finally: [node("cleanup")],
      },
    ]);

    assert.deepEqual(
      placed.rows.map((row) => [row.id, row.lane, row.label]),
      [
        [START, 0, null],
        ["read", 0, "try"],
        ["transcribe", 0, null],
        ["discard", 1, "catch"],
        ["cleanup", 0, "finally"],
      ],
    );
    const throwRail = placed.rails.find((rail) => rail.kind === "throw");
    // Leaves the body as a whole, from between the start row and the first body row.
    assert.deepEqual(throwRail?.points, [
      { lane: 0, row: 0.5 },
      { lane: 1, row: 0.5 },
      { lane: 1, row: 3 },
    ]);
    assert.deepEqual(
      placed.rails
        .filter((rail) => rail.toRowId === "cleanup")
        .map((rail) => rail.fromRowId)
        .sort(),
      ["discard", "transcribe"],
    );
  });
});

describe("reached workflow ends", () => {
  test("marks the exit a finished run provably stopped at", () => {
    const placed = layout([
      node("resolve", { status: "completed" }),
      {
        kind: "fork",
        id: "linked",
        runs: "one",
        branches: [
          {
            id: "then",
            label: "if linked",
            nodes: [node("send linked", { status: "completed" }), end("early return")],
          },
          { id: "fallthrough", label: null, nodes: [] },
        ],
      },
      node("create claim", { status: "skipped" }),
      end("return"),
    ]);

    assert.deepEqual([...reachedWorkflowEndIds(placed, "complete")], ["early return"]);
    assert.deepEqual([...reachedWorkflowEndIds(placed, "active")], []);
  });

  test("leaves competing guards unmarked because the records cannot tell them apart", () => {
    const placed = layout([
      guard("not-start"),
      guard("bad-actor"),
      node("resolve", { status: "pending" }),
    ]);

    assert.deepEqual([...reachedWorkflowEndIds(placed, "complete")], []);
  });

  test("tells a thrown error apart from a competing return by the run's outcome", () => {
    const placed = layout([
      node("receive", { status: "completed" }),
      {
        kind: "fork",
        id: "missing-file",
        runs: "one",
        branches: [
          { id: "then", label: "if !file", nodes: [end("upload required", "error")] },
          { id: "fallthrough", label: null, nodes: [] },
        ],
      },
      guard("too-large"),
      node("read", { status: "pending" }),
    ]);

    assert.deepEqual([...reachedWorkflowEndIds(placed, "errored")], ["upload required"]);
  });
});

describe("workflow step replay", () => {
  const failedAfterRetries = makeStep("load", {
    status: "failed",
    timing: { kind: "span", startedAt: 100, endedAt: 200 },
  });
  const resolvedWait = makeStep("wait", {
    status: "completed",
    activity: "wait",
    timing: { kind: "span", startedAt: 100, endedAt: 200 },
  });

  test("moves a step from pending through its in-progress activity to its final status", () => {
    assert.equal(workflowStepStatusAt(failedAfterRetries, 50), "pending");
    assert.equal(workflowStepStatusAt(failedAfterRetries, 150), "running");
    assert.equal(workflowStepStatusAt(resolvedWait, 150), "waiting");
    assert.equal(workflowStepStatusAt(failedAfterRetries, 200), "failed");
  });

  test("reveals reconciled statuses such as skipped only in the live view", () => {
    const skipped = makeStep("promote", { status: "skipped" });
    assert.equal(workflowStepStatusAt(skipped, 10_000), "pending");
    assert.equal(workflowStepStatusAt(skipped, null), "skipped");
  });
});

describe("workflow time scale", () => {
  const HOUR = 3_600_000;

  test("draws a run without long waits to scale", () => {
    const scale = workflowTimeScale(
      0,
      40_000,
      0,
      [
        node("pull", { timing: { kind: "span", startedAt: 0, endedAt: 8_000 } }),
        node("load", { timing: { kind: "span", startedAt: 18_000, endedAt: 33_000 } }),
      ],
      [],
    );

    assert.isTrue(scale.segments.every((segment) => !segment.idle));
    assert.equal(positionOnScale(scale, 20_000), 0.5);
    assert.deepEqual(
      scale.ticks.map((tick) => tick.offset),
      [0, 10_000, 20_000, 30_000, 40_000],
    );
  });

  test("squeezes a days-long wait for a person so the working steps stay readable", () => {
    const end = 30_000 + 359 * HOUR;
    const scale = workflowTimeScale(
      0,
      end,
      0,
      [
        node("command", { timing: { kind: "committed", at: 2_644 } }),
        node("wait", { timing: { kind: "span", startedAt: 30_000, endedAt: null } }),
      ],
      [],
    );

    const idle = scale.segments.filter((segment) => segment.idle);
    assert.deepEqual(
      idle.map((segment) => [segment.from, segment.to]),
      [[30_000, end]],
    );
    // The 30 working seconds keep most of the axis instead of a sliver of it.
    assert.isAbove(positionOnScale(scale, 30_000), 0.85);
    assert.equal(timeAtScalePosition(scale, positionOnScale(scale, 15_000)), 15_000);
    assert.isTrue(scale.ticks.every((tick) => tick.offset <= 30_000));
  });
});

describe("workflow replay clock", () => {
  // Half a minute of work, a day waiting for an approval, then another half minute of work.
  const DAY = 86_400_000;
  const scale = workflowTimeScale(
    0,
    DAY + 60_000,
    0,
    [
      node("work", { timing: { kind: "span", startedAt: 0, endedAt: 30_000 } }),
      node("approval", { timing: { kind: "span", startedAt: 30_000, endedAt: DAY + 30_000 } }),
      node("ship", { timing: { kind: "span", startedAt: DAY + 30_000, endedAt: DAY + 60_000 } }),
    ],
    [],
  );

  test("replays work at twice the recorded speed", () => {
    assert.equal(replayTimeAfter(scale, 0, 5_000), 10_000);
    assert.equal(replayTimeAfter(scale, 10_000, 5_000), 20_000);
  });

  test("crosses a day of waiting in half a second", () => {
    assert.equal(replayTimeAfter(scale, 0, 15_000), 30_000);
    assert.equal(replayTimeAfter(scale, 0, 15_250), 30_000 + DAY / 2);
    assert.equal(replayTimeAfter(scale, 0, 15_500 + 5_000), DAY + 40_000);
  });

  test("finishes after the last recorded moment", () => {
    assert.isNull(replayTimeAfter(scale, 0, 30_501));
  });
});
