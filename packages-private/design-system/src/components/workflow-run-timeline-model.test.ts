import { assert, describe, test } from "vitest";

import {
  layoutWorkflowRun,
  positionOnScale,
  reachedWorkflowEndIds,
  replayTimeAfter,
  WORKFLOW_RUN_START_ROW_ID,
  timeAtScalePosition,
  workflowRunExcerpt,
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
    iterations: [],
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

  test("returns from a loop's body to its header on its own lane", () => {
    const placed = layout([
      node("fetch"),
      {
        kind: "loop",
        id: "loop",
        label: "for (page)",
        nodes: [node("import"), node("checkpoint")],
      },
      node("done"),
    ]);

    assert.deepEqual(
      placed.rows.map((row) => [row.id, row.kind]),
      [
        [START, "start"],
        ["fetch", "step"],
        ["loop", "loop"],
        ["import", "step"],
        ["checkpoint", "step"],
        ["done", "step"],
      ],
    );
    const repeat = placed.rails.find((rail) => rail.kind === "repeat");
    assert.deepEqual(
      [repeat?.fromRowId, repeat?.toRowId, repeat?.points],
      [
        "checkpoint",
        "loop",
        [
          { lane: 0, row: 4 },
          { lane: 1, row: 4 },
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

describe("workflow run excerpt", () => {
  const mirror = (download: WorkflowRunStep["status"], publish: WorkflowRunStep["status"]) =>
    [
      node("fetch", { status: "completed" }),
      node("pin", { status: "completed" }),
      {
        kind: "loop",
        id: "loop",
        label: "for (batch)",
        nodes: [node("download", { status: download })],
      },
      node("publish", { status: publish }),
      node("notify"),
      end("return"),
    ] satisfies WorkflowRunNode[];
  const rowIds = (nodes: WorkflowRunNode[], status: Parameters<typeof workflowRunExcerpt>[1]) => {
    const placed = layout(nodes);
    const excerpt = workflowRunExcerpt(placed, status);
    return excerpt.kind === "summary"
      ? excerpt
      : {
          rows: placed.rows.slice(excerpt.from, excerpt.to + 1).map((row) => row.id),
          earlier: excerpt.earlierSteps,
          later: excerpt.laterSteps,
        };
  };

  test("shows the step before the running one, its loop's header, and the step after", () => {
    assert.deepEqual(rowIds(mirror("running", "pending"), "active"), {
      rows: ["pin", "loop", "download", "publish"],
      earlier: 1,
      later: 1,
    });
  });

  test("centres on the last step that ran while nothing runs between ticks", () => {
    assert.deepEqual(rowIds(mirror("completed", "pending"), "waiting"), {
      rows: ["pin", "loop", "download", "publish"],
      earlier: 1,
      later: 1,
    });
  });

  test("centres on the failed step of a failed run", () => {
    assert.deepEqual(rowIds(mirror("completed", "failed"), "errored"), {
      rows: ["download", "publish", "notify"],
      earlier: 2,
      later: 0,
    });
  });

  test("takes in the rest of the run after the last step", () => {
    const nodes = mirror("completed", "completed");
    nodes[4] = node("notify", { status: "waiting" });
    assert.deepEqual(rowIds(nodes, "waiting"), {
      rows: ["publish", "notify", "return"],
      earlier: 3,
      later: 0,
    });
  });

  test("leads into a first step inside a loop from the loop's header, not the start", () => {
    assert.deepEqual(
      rowIds(
        [
          {
            kind: "loop",
            id: "loop",
            label: "for (batch)",
            nodes: [node("a", { status: "running" })],
          },
          node("b"),
        ],
        "active",
      ),
      { rows: ["loop", "a", "b"], earlier: 0, later: 0 },
    );
  });

  test("takes in the rows the reader expanded under the step after", () => {
    const nodes = [
      node("current", { status: "running" }),
      node("next", { children: [makeStep("nested")] }),
      node("later"),
    ] satisfies WorkflowRunNode[];
    const placed = layout(nodes, ["next"]);
    const excerpt = workflowRunExcerpt(placed, "active");
    assert(excerpt.kind === "window");
    assert.deepEqual(
      placed.rows.slice(excerpt.from, excerpt.to + 1).map((row) => row.id),
      ["current", "next", "nested"],
    );
    assert.equal(excerpt.laterSteps, 1);
  });

  test("sums a completed run up as its step count", () => {
    assert.deepEqual(rowIds(mirror("completed", "completed"), "complete"), {
      kind: "summary",
      steps: 5,
    });
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

  test("marks the return after an if whose body was skipped or ran", () => {
    const placed = (body: "completed" | "skipped") =>
      layout([
        node("compare", { status: "completed" }),
        {
          kind: "fork",
          id: "pending",
          runs: "one",
          branches: [
            {
              id: "then",
              label: "if pending",
              nodes: [node("send", { status: body }), node("mark", { status: body })],
            },
            { id: "fallthrough", label: null, nodes: [] },
          ],
        },
        end("return"),
      ]);

    assert.deepEqual([...reachedWorkflowEndIds(placed("skipped"), "complete")], ["return"]);
    assert.deepEqual([...reachedWorkflowEndIds(placed("completed"), "complete")], ["return"]);
  });

  test("counts an outer loop as run when only its inner loop's steps ran", () => {
    const placed = layout([
      {
        kind: "loop",
        id: "pages",
        label: "for (page)",
        nodes: [
          {
            kind: "loop",
            id: "rows",
            label: "for (row)",
            nodes: [node("import row", { status: "completed" })],
          },
        ],
      },
      end("return"),
    ]);
    const outer = placed.rows.find((row) => row.id === "pages");
    assert(outer?.kind === "loop");
    // Inner iterations repeat within each outer one, so they leave the outer count unknown.
    assert.deepEqual(outer.loop.steps, []);
    assert.deepEqual(
      outer.loop.allSteps.map((step) => step.id),
      ["import row"],
    );
    assert.deepEqual([...reachedWorkflowEndIds(placed, "complete")], ["return"]);
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

  test("replays work at the chosen multiple of the recorded speed", () => {
    assert.equal(replayTimeAfter(scale, 0, 5_000, 2), 10_000);
    assert.equal(replayTimeAfter(scale, 10_000, 5_000, 2), 20_000);
    assert.equal(replayTimeAfter(scale, 0, 5_000, 3), 15_000);
  });

  test("crosses a day of waiting in half a second", () => {
    assert.equal(replayTimeAfter(scale, 0, 15_000, 2), 30_000);
    assert.equal(replayTimeAfter(scale, 0, 15_250, 2), 30_000 + DAY / 2);
    assert.equal(replayTimeAfter(scale, 0, 15_500 + 5_000, 2), DAY + 40_000);
  });

  test("finishes after the last recorded moment", () => {
    assert.isNull(replayTimeAfter(scale, 0, 30_501, 2));
  });
});
