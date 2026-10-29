export type WorkflowRunStatus =
  | "active"
  | "waiting"
  | "paused"
  | "complete"
  | "errored"
  | "terminated";

export type WorkflowRunStepStatus =
  | "pending"
  | "running"
  | "waiting"
  | "completed"
  | "failed"
  | "skipped";

/** What a step does while it is in progress; replay uses it to show "Running" versus "Waiting". */
export type WorkflowRunStepActivity = "work" | "wait";

/**
 * Durable workflows commit a step when it finishes, so a step that ran inside a single tick only
 * has its commit time. Waits are written when they begin and updated when they resolve, so they
 * have a real span.
 */
export type WorkflowRunStepTiming =
  | { kind: "unstarted" }
  | { kind: "committed"; at: number }
  | { kind: "span"; startedAt: number; endedAt: number | null };

export type WorkflowRunStep = {
  id: string;
  label: string;
  detail: string | null;
  status: WorkflowRunStepStatus;
  activity: WorkflowRunStepActivity;
  attempts: { count: number; max: number };
  timing: WorkflowRunStepTiming;
  children: readonly WorkflowRunStep[];
  /**
   * Each run of a step inside a loop, oldest first and named as it ran; the step's own state sums
   * them up. Empty for steps outside loops and for loop steps that have not run.
   */
  iterations: readonly WorkflowRunStep[];
};

/**
 * A point where the path stops, so it never joins the steps after it. A `caught` end is a throw
 * inside a `try` body: the path stops there and continues in the catch handler instead.
 */
export type WorkflowRunEnd = {
  id: string;
  label: string;
  reason: "return" | "error" | "caught";
};

/**
 * The last branch of a fork continues on the parent's lane; earlier branches detour to the left.
 * A fork either takes one branch (a condition) or runs all of them (`Promise.all` and friends).
 * A section is a labelled stretch of the same path; a loop repeats its body from its header.
 * A try node runs its body, hands any throw from the body to `catch`, and always runs `finally`.
 */
export type WorkflowRunNode =
  | { kind: "step"; step: WorkflowRunStep }
  | { kind: "end"; end: WorkflowRunEnd }
  | { kind: "fork"; id: string; runs: "one" | "all"; branches: readonly WorkflowRunBranch[] }
  | { kind: "section"; id: string; label: string; nodes: readonly WorkflowRunNode[] }
  | { kind: "loop"; id: string; label: string; nodes: readonly WorkflowRunNode[] }
  | {
      kind: "try";
      id: string;
      body: readonly WorkflowRunNode[];
      catch: readonly WorkflowRunNode[];
      finally: readonly WorkflowRunNode[];
    };

export type WorkflowRunBranch = {
  id: string;
  label: string | null;
  nodes: readonly WorkflowRunNode[];
};

export type WorkflowRunEvent = {
  id: string;
  at: number;
  source: string;
  message: string;
};

/** A loop's header row; `steps` are the ones its body runs each iteration, outside nested loops. */
export type WorkflowRunLoop = {
  label: string;
  /** The steps it runs itself, which each of its iterations starts over. */
  steps: readonly WorkflowRunStep[];
  /**
   * Every step inside it, its inner loops' too, which tell whether and when it ran. An inner
   * loop's steps repeat within each iteration, so they cannot count the loop's own.
   */
  allSteps: readonly WorkflowRunStep[];
};

export type WorkflowRunRow = (
  | { kind: "start"; trigger: string }
  | { kind: "step"; step: WorkflowRunStep }
  | { kind: "loop"; loop: WorkflowRunLoop }
  | { kind: "end"; end: WorkflowRunEnd }
) & {
  id: string;
  depth: number;
  lane: number;
  label: string | null;
};

type RailPoint = { lane: number; row: number };

export type WorkflowRunRail = {
  id: string;
  kind: "flow" | "repeat" | "throw";
  fromRowId: string;
  toRowId: string;
  points: readonly RailPoint[];
};

export type WorkflowRunLayout = {
  rows: readonly WorkflowRunRow[];
  rails: readonly WorkflowRunRail[];
  laneCount: number;
};

type RailEndpoint = { rowId: string; lane: number; row: number; detourLane: number | null };

export const WORKFLOW_RUN_START_ROW_ID = "run-start";

/** Every layout begins with a start row, so paths that leave before the first step have an origin. */
export function layoutWorkflowRun(
  nodes: readonly WorkflowRunNode[],
  expandedStepIds: ReadonlySet<string>,
  trigger: string,
): WorkflowRunLayout {
  const rows: WorkflowRunRow[] = [
    { kind: "start", trigger, id: WORKFLOW_RUN_START_ROW_ID, depth: 0, lane: 0, label: null },
  ];
  const rails: WorkflowRunRail[] = [];
  let laneCount = 1;

  function placeChildren(step: WorkflowRunStep, lane: number, depth: number) {
    if (!expandedStepIds.has(step.id)) {
      return;
    }
    for (const iteration of step.iterations) {
      rows.push({ kind: "step", step: iteration, id: iteration.id, depth, lane, label: null });
    }
    for (const child of step.children) {
      rows.push({ kind: "step", step: child, id: child.id, depth, lane, label: null });
      placeChildren(child, lane, depth + 1);
    }
  }

  function placeRow(row: WorkflowRunRow, incoming: readonly RailEndpoint[]): RailEndpoint {
    const target = { rowId: row.id, lane: row.lane, row: rows.length, detourLane: null };
    rows.push(row);
    for (const source of incoming) {
      rails.push(connectRail(source, target, "flow"));
    }
    return target;
  }

  /**
   * Side lanes are only reserved while a construct is open, so consecutive guards reuse the same
   * column instead of widening the rail for every `if`.
   */
  function firstFreeLane(reserved: number, incoming: readonly RailEndpoint[]): number {
    return Math.max(
      reserved,
      ...incoming.map((source) => Math.max(source.lane, source.detourLane ?? 0) + 1),
    );
  }

  function placeSequence(
    sequence: readonly WorkflowRunNode[],
    lane: number,
    incoming: readonly RailEndpoint[],
    label: string | null,
    reservedLanes: number,
  ): RailEndpoint[] {
    let current = [...incoming];
    let pendingLabel = label;

    for (const node of sequence) {
      switch (node.kind) {
        case "step": {
          const step = node.step;
          current = [
            placeRow(
              { kind: "step", step, id: step.id, depth: 0, lane, label: pendingLabel },
              current,
            ),
          ];
          placeChildren(step, lane, 1);
          break;
        }
        case "end": {
          const end = node.end;
          placeRow({ kind: "end", end, id: end.id, depth: 0, lane, label: pendingLabel }, current);
          current = [];
          break;
        }
        case "section": {
          current = placeSequence(
            node.nodes,
            lane,
            current,
            joinLabels(pendingLabel, node.label),
            reservedLanes,
          );
          break;
        }
        case "loop": {
          const loopLane = firstFreeLane(reservedLanes, current);
          const header = placeRow(
            {
              kind: "loop",
              loop: {
                label: node.label,
                steps: loopBodySteps(node.nodes, false),
                allSteps: loopBodySteps(node.nodes, true),
              },
              id: node.id,
              depth: 0,
              lane,
              label: pendingLabel,
            },
            current,
          );
          const exits = placeSequence(node.nodes, lane, [header], null, loopLane + 1);
          laneCount = Math.max(laneCount, loopLane + 1);
          for (const exit of exits) {
            rails.push(connectRail({ ...exit, detourLane: loopLane }, header, "repeat"));
          }
          current = exits;
          break;
        }
        case "try": {
          const handlerLane = firstFreeLane(reservedLanes, current);
          const hasHandler = node.catch.length > 0;
          const bodyStart = rows.length;
          const bodyExits = placeSequence(
            node.body,
            lane,
            current,
            joinLabels(pendingLabel, "try"),
            hasHandler ? handlerLane + 1 : reservedLanes,
          );
          const firstBodyRow = rows[bodyStart];
          const handlerStart = rows.length;
          const handlerExits = hasHandler
            ? placeSequence(node.catch, handlerLane, [], "catch", handlerLane + 1)
            : [];
          const firstHandlerRow = rows[handlerStart];
          if (firstBodyRow && firstHandlerRow && handlerStart > bodyStart) {
            laneCount = Math.max(laneCount, handlerLane + 1);
            // Any step in the body may throw, so the rail leaves the body as a whole, from just
            // above its first row, instead of forking from one particular step.
            rails.push({
              id: `throw:${node.id}`,
              kind: "throw",
              fromRowId: firstBodyRow.id,
              toRowId: firstHandlerRow.id,
              points: [
                { lane, row: bodyStart - 0.5 },
                { lane: handlerLane, row: bodyStart - 0.5 },
                { lane: handlerLane, row: handlerStart },
              ],
            });
          }
          const exits = [...bodyExits, ...handlerExits];
          current =
            node.finally.length > 0
              ? placeSequence(node.finally, lane, exits, "finally", reservedLanes)
              : exits;
          break;
        }
        case "fork": {
          const sideLane = firstFreeLane(reservedLanes, current);
          const sideCount = node.branches.length - 1;
          const exits: RailEndpoint[] = [];
          node.branches.forEach((branch, index) => {
            const continuesOnLane = index === sideCount;
            const branchLane = continuesOnLane ? lane : sideLane + index;
            const branchLabel = index === 0 ? joinLabels(pendingLabel, branch.label) : branch.label;
            laneCount = Math.max(laneCount, branchLane + 1);
            if (branch.nodes.length > 0) {
              exits.push(
                ...placeSequence(
                  branch.nodes,
                  branchLane,
                  current,
                  branchLabel,
                  sideLane + sideCount,
                ),
              );
            } else if (continuesOnLane) {
              exits.push(...current);
            } else {
              exits.push(...current.map((source) => ({ ...source, detourLane: branchLane })));
            }
          });
          current = exits;
          break;
        }
      }
      pendingLabel = null;
    }

    return current;
  }

  const start = { rowId: WORKFLOW_RUN_START_ROW_ID, lane: 0, row: 0, detourLane: null };
  placeSequence(nodes, 0, [start], null, 1);
  return { rows, rails, laneCount };
}

/**
 * The part of a run's rows worth showing where little room is left, such as in a conversation.
 * A run that completed sums up as its step count. Otherwise the window runs from the step before
 * where the run is to the step after it, with everything between, such as a loop's header, and
 * the rows the reader expanded under that last step. The run is at its running, waiting, and
 * failed steps, or else at the last step that ran. `from` and `to` are inclusive row indices.
 */
export type WorkflowRunExcerpt =
  | { kind: "summary"; steps: number }
  | { kind: "window"; from: number; to: number; earlierSteps: number; laterSteps: number };

export function workflowRunExcerpt(
  layout: WorkflowRunLayout,
  status: WorkflowRunStatus,
): WorkflowRunExcerpt {
  // Rows nested under a step stay with it, so only the outermost rows bound the window.
  const steps = layout.rows.flatMap((row, index) =>
    row.kind === "step" && row.depth === 0 ? [{ step: row.step, index }] : [],
  );
  if (status === "complete") {
    return { kind: "summary", steps: steps.length };
  }
  const current = steps.filter(({ step }) => CURRENT_STEP_STATUSES.has(step.status));
  const ran = steps.filter(({ step }) => step.status !== "pending" && step.status !== "skipped");
  const anchors = current.length > 0 ? current : ran.slice(-1);
  const first = anchors[0]?.index ?? steps[0]?.index;
  const last = anchors.at(-1)?.index ?? first;
  if (first === undefined || last === undefined) {
    return { kind: "window", from: 0, to: layout.rows.length - 1, earlierSteps: 0, laterSteps: 0 };
  }

  // Without a step before, the window still takes in what leads to the first, such as a loop's
  // header; the start row only repeats the run's own status.
  const before = steps.filter(({ index }) => index < first).at(-1);
  const from =
    before?.index ??
    layout.rows.findIndex(
      (row, index) => index <= first && row.depth === 0 && row.kind !== "start",
    );
  const after = steps.find(({ index }) => index > last);
  // The step after ends where the next outermost row starts, past its children and iterations.
  const nextOutermost =
    after === undefined
      ? -1
      : layout.rows.findIndex((row, index) => index > after.index && row.depth === 0);
  const to =
    after === undefined || nextOutermost === -1 ? layout.rows.length - 1 : nextOutermost - 1;
  return {
    kind: "window",
    from,
    to,
    earlierSteps: steps.filter(({ index }) => index < from).length,
    laterSteps: steps.filter(({ index }) => index > to).length,
  };
}

const CURRENT_STEP_STATUSES = new Set<WorkflowRunStepStatus>(["running", "waiting", "failed"]);

/**
 * Ends the finished run provably stopped at. An end counts when something leading into it
 * finished and nothing else that thing leads to ran. Only one path into an end has to be taken:
 * a skipped `if` body still leads into the `return` after it. Two matching ends that compete,
 * like consecutive guards with no step between them, stay unmarked because the records cannot
 * tell them apart.
 */
export function reachedWorkflowEndIds(
  layout: WorkflowRunLayout,
  status: WorkflowRunStatus,
): ReadonlySet<string> {
  const reason = status === "complete" ? "return" : status === "errored" ? "error" : null;
  if (reason === null) {
    return new Set();
  }
  const rowsById = new Map(layout.rows.map((row) => [row.id, row]));
  const flows = layout.rails.filter((rail) => rail.kind === "flow");
  const isCandidate = (row: WorkflowRunRow | undefined) =>
    row?.kind === "end" && row.end.reason === reason;
  const unrun = (step: WorkflowRunStep) => step.status === "pending" || step.status === "skipped";
  // A loop's header is passed once its body has run.
  const finished = (row: WorkflowRunRow | undefined) =>
    row?.kind === "start" ||
    (row?.kind === "step" && row.step.status === "completed") ||
    (row?.kind === "loop" && !row.loop.allSteps.every(unrun));
  const didNotRun = (row: WorkflowRunRow | undefined) =>
    row?.kind === "end"
      ? !isCandidate(row)
      : row?.kind === "step"
        ? unrun(row.step)
        : row?.kind === "loop" && row.loop.allSteps.every(unrun);

  return new Set(
    layout.rows.flatMap((row) => {
      if (!isCandidate(row)) {
        return [];
      }
      const reached = flows
        .filter((rail) => rail.toRowId === row.id)
        .some(
          ({ fromRowId }) =>
            finished(rowsById.get(fromRowId)) &&
            flows
              .filter((rail) => rail.fromRowId === fromRowId && rail.toRowId !== row.id)
              .every((rail) => didNotRun(rowsById.get(rail.toRowId))),
        );
      return reached ? [row.id] : [];
    }),
  );
}

/** The steps in a loop's body, with or without those of the loops inside it. */
function loopBodySteps(nodes: readonly WorkflowRunNode[], innerLoops: boolean): WorkflowRunStep[] {
  return nodes.flatMap((node) => {
    switch (node.kind) {
      case "step":
        return [node.step];
      case "end":
        return [];
      case "loop":
        return innerLoops ? loopBodySteps(node.nodes, innerLoops) : [];
      case "section":
        return loopBodySteps(node.nodes, innerLoops);
      case "try":
        return loopBodySteps([...node.body, ...node.catch, ...node.finally], innerLoops);
      case "fork":
        return node.branches.flatMap((branch) => loopBodySteps(branch.nodes, innerLoops));
    }
    throw new Error("Unsupported workflow run node.");
  });
}

function joinLabels(first: string | null, second: string | null): string | null {
  return first === null ? second : second === null ? first : `${first} · ${second}`;
}

/** Detours leave sideways from the source row, run along their lane, and rejoin at the target row. */
function connectRail(
  source: RailEndpoint,
  target: RailEndpoint,
  kind: WorkflowRunRail["kind"],
): WorkflowRunRail {
  const from = { lane: source.lane, row: source.row };
  const to = { lane: target.lane, row: target.row };
  const points =
    source.detourLane !== null
      ? [
          from,
          { lane: source.detourLane, row: source.row },
          { lane: source.detourLane, row: target.row },
          to,
        ]
      : source.lane === target.lane
        ? [from, to]
        : [from, { lane: source.lane, row: target.row }, to];

  return {
    id: `${kind}:${source.rowId}->${target.rowId}@${source.detourLane ?? source.lane}`,
    kind,
    fromRowId: source.rowId,
    toRowId: target.rowId,
    points,
  };
}

/** A replay cursor of `null` shows the run as it is now. */
export function workflowStepStatusAt(
  step: WorkflowRunStep,
  cursor: number | null,
): WorkflowRunStepStatus {
  if (cursor === null) {
    return step.status;
  }
  // A repeated step is in the state of its newest iteration so far.
  if (step.iterations.length > 0) {
    const iteration = step.iterations.slice(0, workflowStepIterationsAt(step, cursor)).at(-1);
    return iteration ? workflowStepStatusAt(iteration, cursor) : "pending";
  }

  const timing = step.timing;
  switch (timing.kind) {
    case "unstarted":
      return "pending";
    case "committed":
      return cursor < timing.at ? "pending" : step.status;
    case "span":
      if (cursor < timing.startedAt) {
        return "pending";
      }
      if (timing.endedAt === null || cursor < timing.endedAt) {
        return step.activity === "wait" ? "waiting" : "running";
      }
      return step.status;
  }
  throw new Error("Unsupported workflow step timing.");
}

/** How many of the step's iterations had started by the replay cursor; all of them for `null`. */
export function workflowStepIterationsAt(step: WorkflowRunStep, cursor: number | null): number {
  if (cursor === null) {
    return step.iterations.length;
  }
  return step.iterations.filter(
    (iteration) => workflowStepStatusAt(iteration, cursor) !== "pending",
  ).length;
}

export type WorkflowStepMark =
  | { kind: "none" }
  | { kind: "point"; at: number }
  | { kind: "bar"; startedAt: number; endedAt: number };

export function workflowStepMarkAt(step: WorkflowRunStep, horizon: number): WorkflowStepMark {
  const timing = step.timing;
  switch (timing.kind) {
    case "unstarted":
      return { kind: "none" };
    case "committed":
      return horizon < timing.at ? { kind: "none" } : { kind: "point", at: timing.at };
    case "span":
      if (horizon < timing.startedAt) {
        return { kind: "none" };
      }
      return {
        kind: "bar",
        startedAt: timing.startedAt,
        endedAt: Math.min(timing.endedAt ?? horizon, horizon),
      };
  }
  throw new Error("Unsupported workflow step timing.");
}

type ScaleSegment = {
  from: number;
  to: number;
  position: number;
  width: number;
  idle: boolean;
};

/**
 * Maps run time onto [0, 1]. Long stretches where nothing but an open wait happens are squeezed
 * into short idle segments, so a run that waited days for a person still shows its working steps.
 */
export type WorkflowTimeScale = {
  startedAt: number;
  endedAt: number;
  segments: readonly ScaleSegment[];
  ticks: readonly { offset: number; position: number }[];
};

const IDLE_GAP_MIN_MS = 60_000;
// A gap is only idle when it dominates the time that is still drawn to scale.
const IDLE_GAP_SHARE = 0.3;
const IDLE_SEGMENT_SHARE = 0.12;
const MAX_TICKS_PER_SCALE = 4;
const MIN_TICK_LABEL_DISTANCE = 0.1;

/** `runStartedAt` marks where queueing ends, so a long queue can be squeezed like any idle gap. */
export function workflowTimeScale(
  startedAt: number,
  endedAt: number,
  runStartedAt: number | null,
  nodes: readonly WorkflowRunNode[],
  events: readonly WorkflowRunEvent[],
): WorkflowTimeScale {
  return timeScaleOverMoments(startedAt, endedAt, [
    ...(runStartedAt === null ? [] : [runStartedAt]),
    ...recordedMoments(nodes),
    ...events.map((event) => event.at),
  ]);
}

/** Gaps between consecutive recorded moments are the candidates for squeezing into idle segments. */
export function timeScaleOverMoments(
  startedAt: number,
  endedAt: number,
  recorded: readonly number[],
): WorkflowTimeScale {
  const moments = [
    ...new Set([startedAt, endedAt, ...recorded].filter((at) => at >= startedAt && at <= endedAt)),
  ].sort((left, right) => left - right);
  const gaps = moments.slice(1).map((to, index) => ({ from: moments[index] ?? to, to }));

  let scaledDuration = endedAt - startedAt;
  const idleGaps = new Set<(typeof gaps)[number]>();
  for (const gap of [...gaps].sort(
    (left, right) => right.to - right.from - (left.to - left.from),
  )) {
    const length = gap.to - gap.from;
    if (length < IDLE_GAP_MIN_MS || length < scaledDuration * IDLE_GAP_SHARE) {
      break;
    }
    idleGaps.add(gap);
    scaledDuration -= length;
  }

  const idleWeight = Math.max(
    Math.min(scaledDuration * IDLE_SEGMENT_SHARE, scaledDuration / Math.max(idleGaps.size, 1)),
    1,
  );
  const merged: { from: number; to: number; idle: boolean }[] = [];
  for (const gap of gaps) {
    const idle = idleGaps.has(gap);
    const previous = merged.at(-1);
    if (previous && !previous.idle && !idle) {
      previous.to = gap.to;
    } else {
      merged.push({ from: gap.from, to: gap.to, idle });
    }
  }
  const weightOf = (segment: { from: number; to: number; idle: boolean }) =>
    segment.idle ? idleWeight : segment.to - segment.from;
  const totalWeight = Math.max(
    merged.reduce((sum, segment) => sum + weightOf(segment), 0),
    1,
  );

  let position = 0;
  const segments = merged.map((segment) => {
    const width = weightOf(segment) / totalWeight;
    const placed = { ...segment, position, width };
    position += width;
    return placed;
  });

  return { startedAt, endedAt, segments, ticks: scaleTicks(startedAt, segments, scaledDuration) };
}

/** How many times faster than recorded a replay plays the time drawn to scale. */
export type WorkflowReplaySpeed = 1 | 2 | 3;
/** Idle gaps are squeezed on the scale, so replay crosses each one in a fixed wall-clock time. */
const IDLE_GAP_REPLAY_MS = 500;

/**
 * Where a replay that started at `from` is after `wallElapsedMs` of playback, or `null` once it
 * has passed the end of the scale.
 */
export function replayTimeAfter(
  scale: WorkflowTimeScale,
  from: number,
  wallElapsedMs: number,
  speed: WorkflowReplaySpeed,
): number | null {
  let remaining = wallElapsedMs;
  for (const segment of scale.segments) {
    if (segment.to <= from) {
      continue;
    }
    const start = Math.max(from, segment.from);
    const length = segment.to - segment.from;
    const wallPerRunMs = segment.idle ? IDLE_GAP_REPLAY_MS / Math.max(length, 1) : 1 / speed;
    const needed = (segment.to - start) * wallPerRunMs;
    if (remaining < needed) {
      return start + remaining / wallPerRunMs;
    }
    remaining -= needed;
  }
  return null;
}

export function positionOnScale(scale: WorkflowTimeScale, at: number): number {
  const segment = scale.segments.find((candidate) => at <= candidate.to) ?? scale.segments.at(-1);
  if (!segment || at <= scale.startedAt) {
    return 0;
  }
  const length = segment.to - segment.from;
  const within = length === 0 ? 1 : Math.min(Math.max((at - segment.from) / length, 0), 1);
  return segment.position + within * segment.width;
}

export function timeAtScalePosition(scale: WorkflowTimeScale, position: number): number {
  const segment =
    scale.segments.find((candidate) => position <= candidate.position + candidate.width) ??
    scale.segments.at(-1);
  if (!segment) {
    return scale.startedAt;
  }
  const within =
    segment.width === 0
      ? 1
      : Math.min(Math.max((position - segment.position) / segment.width, 0), 1);
  return segment.from + within * (segment.to - segment.from);
}

/** The newest durable timestamp, used as "now" until the client clock is available. */
export function newestWorkflowMoment(
  nodes: readonly WorkflowRunNode[],
  events: readonly WorkflowRunEvent[],
  createdAt: number,
): number {
  return Math.max(createdAt, ...recordedMoments(nodes), ...events.map((event) => event.at));
}

function recordedMoments(nodes: readonly WorkflowRunNode[]): number[] {
  return nodes.flatMap((node) => {
    switch (node.kind) {
      case "step":
        return stepMoments(node.step);
      case "end":
        return [];
      case "section":
      case "loop":
        return recordedMoments(node.nodes);
      case "try":
        return recordedMoments([...node.body, ...node.catch, ...node.finally]);
      case "fork":
        return node.branches.flatMap((branch) => recordedMoments(branch.nodes));
    }
    throw new Error("Unsupported workflow run node.");
  });
}

function stepMoments(step: WorkflowRunStep): number[] {
  const timing = step.timing;
  const own =
    timing.kind === "committed"
      ? [timing.at]
      : timing.kind === "span"
        ? [timing.startedAt, ...(timing.endedAt === null ? [] : [timing.endedAt])]
        : [];
  return [...own, ...step.iterations.flatMap(stepMoments), ...step.children.flatMap(stepMoments)];
}

const DAY_MS = 86_400_000;
const TICK_STEPS_MS = [
  1_000,
  2_000,
  5_000,
  10_000,
  15_000,
  30_000,
  60_000,
  120_000,
  300_000,
  600_000,
  900_000,
  1_800_000,
  3_600_000,
  7_200_000,
  21_600_000,
  43_200_000,
  DAY_MS,
];

/** Ticks fall on round offsets from the run start, and only inside segments drawn to scale. */
function scaleTicks(
  startedAt: number,
  segments: readonly ScaleSegment[],
  scaledDuration: number,
): { offset: number; position: number }[] {
  const step =
    TICK_STEPS_MS.find((candidate) => scaledDuration / candidate <= MAX_TICKS_PER_SCALE) ??
    DAY_MS * Math.ceil(scaledDuration / MAX_TICKS_PER_SCALE / DAY_MS);
  const idleLabelPositions = segments.flatMap((segment) =>
    segment.idle ? [segment.position + segment.width / 2] : [],
  );
  const ticks: { offset: number; position: number }[] = [];
  for (const segment of segments) {
    if (segment.idle) {
      continue;
    }
    const length = segment.to - segment.from;
    for (
      let offset = Math.ceil((segment.from - startedAt) / step) * step;
      offset <= segment.to - startedAt;
      offset += step
    ) {
      const within = length === 0 ? 0 : (offset - (segment.from - startedAt)) / length;
      const position = segment.position + within * segment.width;
      const previous = ticks.at(-1);
      const clearOfIdleLabels = idleLabelPositions.every(
        (labelPosition) => Math.abs(labelPosition - position) >= MIN_TICK_LABEL_DISTANCE,
      );
      if (
        clearOfIdleLabels &&
        (!previous || position - previous.position >= MIN_TICK_LABEL_DISTANCE)
      ) {
        ticks.push({ offset, position });
      }
    }
  }
  return ticks;
}

export function formatWorkflowDuration(ms: number, precision: "coarse" | "fine"): string {
  const seconds = ms / 1000;
  if (seconds < 60) {
    if (precision === "fine" || seconds < 1) {
      return `${seconds.toFixed(1).replace(/\.0$/, "")}s`;
    }
    return `${Math.round(seconds)}s`;
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    const rest = Math.round(seconds - minutes * 60);
    return rest === 0 ? `${minutes}m` : `${minutes}m ${rest}s`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    const restMinutes = minutes - hours * 60;
    return restMinutes === 0 ? `${hours}h` : `${hours}h ${restMinutes}m`;
  }
  const days = Math.floor(hours / 24);
  const restHours = hours - days * 24;
  return restHours === 0 ? `${days}d` : `${days}d ${restHours}h`;
}
