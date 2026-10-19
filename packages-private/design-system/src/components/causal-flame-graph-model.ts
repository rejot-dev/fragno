import {
  positionOnScale,
  timeAtScalePosition,
  timeScaleOverMoments,
  type WorkflowTimeScale,
} from "./workflow-run-timeline-model";

/** A route node stands for what a route did when that left no event or run of its own. */
export type CausalFlameNodeKind = "event" | "route" | "workflow" | "step";

export type CausalFlameStatus = "pending" | "running" | "waiting" | "ok" | "skipped" | "failed";

/**
 * Events happen at an instant, and so do workflow steps that commit within one tick, because only
 * their commit time is durable. Workflows sit queued until their first tick and then span until
 * they settle; waits span until they resolve. `endedAt` is `null` while a span is still open.
 */
export type CausalFlameTiming =
  | { kind: "instant"; at: number }
  | { kind: "queued"; queuedAt: number }
  | {
      kind: "span";
      activity: "work" | "wait";
      queuedAt: number;
      startedAt: number;
      endedAt: number | null;
    };

/** One link in a causal chain: whatever it caused hangs below it as children, oldest first. */
export type CausalFlameNode = {
  id: string;
  kind: CausalFlameNodeKind;
  label: string;
  /** Secondary facts, such as the event source or the route that derived the event. */
  detail: string | null;
  status: CausalFlameStatus;
  timing: CausalFlameTiming;
  children: readonly CausalFlameNode[];
};

/**
 * Where a bar's label sits. `inside` clips it to the bar, so a run's steps can share one lane;
 * `start` puts it before the bar when the bar begins too close to the end of the axis.
 */
export type CausalFlameLabelSide = "end" | "start" | "inside";

/** Positions are fractions of the drawn axis, so bars can be laid out without measuring pixels. */
export type CausalFlameBar = {
  node: CausalFlameNode;
  parentId: string | null;
  row: number;
  /** Where the bar starts, including the time it sat queued. */
  queuedFrom: number;
  from: number;
  to: number;
  labelSide: CausalFlameLabelSide;
  /**
   * The free stretch of the row around the bar, up to its neighbours, which its label may fill.
   * Labels truncate at its edges, so they never cover another bar or leave the axis.
   */
  room: { from: number; to: number };
  open: boolean;
};

export type CausalFlameLayout = {
  bars: readonly CausalFlameBar[];
  rowCount: number;
};

// Leaves room past the end of the scale for the label of the newest instant.
export const CAUSAL_FLAME_AXIS_HEADROOM = 1.16;
// Instants and short bars still claim room for their label, so neighbours never cover it.
const LABEL_SLOT = 0.15;
// A failure's message follows its label, so it gets more room.
const FAILURE_LABEL_SLOT = 0.32;
// Labels of bars that begin past this point go before the bar, so they stay on the axis.
const LABEL_FLIP_POSITION = 0.8;
// Even an instant step in a lane keeps a sliver, so it stays visible and clickable.
const LANE_SLOT = 0.006;
const ROW_GAP = 0.004;

/** A run's steps that take time read as one lane of segments under the run. */
function sitsInLane(node: CausalFlameNode): boolean {
  return node.kind === "step" && node.timing.kind === "span";
}

export function causalFlameNodeStart(node: CausalFlameNode): number {
  const timing = node.timing;
  switch (timing.kind) {
    case "instant":
      return timing.at;
    case "queued":
    case "span":
      return timing.queuedAt;
  }
  throw new Error("Unsupported causal flame timing.");
}

/** Open spans and queued runs reach up to `now`. */
export function causalFlameNodeEnd(node: CausalFlameNode, now: number): number {
  const timing = node.timing;
  switch (timing.kind) {
    case "instant":
      return timing.at;
    case "queued":
      return Math.max(now, timing.queuedAt);
    case "span":
      return timing.endedAt ?? Math.max(now, timing.startedAt);
  }
  throw new Error("Unsupported causal flame timing.");
}

function isOpen(node: CausalFlameNode): boolean {
  return (
    node.timing.kind === "queued" || (node.timing.kind === "span" && node.timing.endedAt === null)
  );
}

export function causalFlameIsLive(root: CausalFlameNode): boolean {
  return isOpen(root) || root.children.some(causalFlameIsLive);
}

function recordedMoments(node: CausalFlameNode): number[] {
  const timing = node.timing;
  const own =
    timing.kind === "instant"
      ? [timing.at]
      : timing.kind === "queued"
        ? [timing.queuedAt]
        : [timing.queuedAt, timing.startedAt, ...(timing.endedAt === null ? [] : [timing.endedAt])];
  return [...own, ...node.children.flatMap(recordedMoments)];
}

/** The newest durable timestamp, used as "now" until the client clock is available. */
export function newestCausalFlameMoment(root: CausalFlameNode): number {
  return Math.max(...recordedMoments(root));
}

/** Long stretches where nothing new happens are squeezed, so a tree that waited days stays legible. */
export function causalFlameScale(root: CausalFlameNode, now: number): WorkflowTimeScale {
  const moments = recordedMoments(root);
  const startedAt = Math.min(...moments);
  const endedAt = Math.max(...moments, causalFlameIsLive(root) ? now : startedAt);
  return timeScaleOverMoments(startedAt, endedAt, moments);
}

export function causalFlamePosition(scale: WorkflowTimeScale, at: number): number {
  return positionOnScale(scale, at) / CAUSAL_FLAME_AXIS_HEADROOM;
}

/** The moment at a point on the drawn axis; the headroom past the scale reads as its end. */
export function causalFlameTimeAt(scale: WorkflowTimeScale, position: number): number {
  const onScale = position * CAUSAL_FLAME_AXIS_HEADROOM;
  return onScale >= 1 ? scale.endedAt : timeAtScalePosition(scale, Math.max(onScale, 0));
}

/**
 * A node as it stood at `cursor` during a replay, or `null` before it happened. Runs are queued
 * until they start, and spans are open until they end. What a node caused is left as it is,
 * because each child is replayed on its own.
 */
export function causalFlameNodeAt(node: CausalFlameNode, cursor: number): CausalFlameNode | null {
  const timing = node.timing;
  if (cursor < causalFlameNodeStart(node)) {
    return null;
  }
  if (timing.kind !== "span" || (timing.endedAt !== null && cursor >= timing.endedAt)) {
    return node;
  }
  if (cursor < timing.startedAt) {
    return { ...node, status: "pending", timing: { kind: "queued", queuedAt: timing.queuedAt } };
  }
  return {
    ...node,
    status: timing.activity === "wait" ? "waiting" : "running",
    timing: { ...timing, endedAt: null },
  };
}

/**
 * What someone following a trace wants to look at `at`: the deepest node still in progress, so a
 * running step wins over its run, and the latest started among equals. `null` when nothing is.
 */
export function causalFlameActiveNode(root: CausalFlameNode, at: number): CausalFlameNode | null {
  const active: { node: CausalFlameNode; depth: number }[] = [];
  (function visit(node: CausalFlameNode, depth: number) {
    const atMoment = causalFlameNodeAt(node, at);
    if (atMoment !== null && isOpen(atMoment)) {
      active.push({ node, depth });
    }
    for (const child of node.children) {
      visit(child, depth + 1);
    }
  })(root, 0);
  active.sort(
    (left, right) =>
      right.depth - left.depth ||
      causalFlameNodeStart(right.node) - causalFlameNodeStart(left.node),
  );
  return active[0]?.node ?? null;
}

/**
 * A bar as it stood at `cursor`, cut off at the playhead while it was still open. It keeps its row
 * and room, so the chart does not reflow as a replay plays.
 */
export function causalFlameBarAt(
  bar: CausalFlameBar,
  scale: WorkflowTimeScale,
  cursor: number,
): CausalFlameBar | null {
  const node = causalFlameNodeAt(bar.node, cursor);
  if (node === null) {
    return null;
  }
  // Settled nodes come back unchanged.
  if (!isOpen(node)) {
    return bar;
  }
  const from = node.timing.kind === "queued" ? bar.queuedFrom : bar.from;
  return {
    ...bar,
    node,
    from,
    to: Math.max(Math.min(bar.to, causalFlamePosition(scale, cursor)), from),
    open: true,
  };
}

export type CausalFlameTick = {
  position: number;
  /** Time since the start of the tree, or since the end of the idle gap before the tick. */
  offset: number;
  afterIdle: boolean;
};

const DAY_MS = 86_400_000;
const TICK_STEPS_MS = [
  100,
  250,
  500,
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
const MAX_TICKS = 5;
const MIN_TICK_DISTANCE = 0.09;

/**
 * Ticks restart after every idle gap, so the stretch after a two-day wait reads "+10s, +20s"
 * instead of repeating "+2d".
 */
export function causalFlameTicks(scale: WorkflowTimeScale): CausalFlameTick[] {
  // A tree that is a single instant has no stretch of time to divide.
  if (scale.segments.length === 0) {
    return [{ position: 0, offset: 0, afterIdle: false }];
  }
  const active = scale.segments.filter((segment) => !segment.idle);
  const drawnDuration = active.reduce((sum, segment) => sum + segment.to - segment.from, 0);
  const step =
    TICK_STEPS_MS.find((candidate) => drawnDuration / candidate <= MAX_TICKS) ??
    DAY_MS * Math.ceil(drawnDuration / MAX_TICKS / DAY_MS);
  const ticks: CausalFlameTick[] = [];
  let anchor = scale.startedAt;
  let afterIdle = false;
  for (const segment of scale.segments) {
    if (segment.idle) {
      anchor = segment.to;
      afterIdle = true;
      continue;
    }
    // The idle chip already marks where activity resumes, so ticks after a gap start one step in.
    const first = Math.max(Math.ceil((segment.from - anchor) / step), afterIdle ? 1 : 0) * step;
    for (let offset = first; anchor + offset <= segment.to; offset += step) {
      const position = causalFlamePosition(scale, anchor + offset);
      const previous = ticks.at(-1);
      if (!previous || position - previous.position >= MIN_TICK_DISTANCE) {
        ticks.push({ position, offset, afterIdle });
      }
    }
  }
  return ticks;
}

/**
 * Packs the tree into rows like a flame chart. Every node sits below its parent, in the first row
 * where nothing already claims its time range, so a causal chain reads top to bottom.
 */
export function layoutCausalFlame(
  root: CausalFlameNode,
  scale: WorkflowTimeScale,
  now: number,
): CausalFlameLayout {
  const claimed: { from: number; to: number }[][] = [];
  const placed: { bar: Omit<CausalFlameBar, "room">; claim: { from: number; to: number } }[] = [];

  // Segments in a lane may touch, because one step usually starts as the previous one commits.
  function fits(row: number, from: number, to: number, gap: number): boolean {
    return (claimed[row] ?? []).every((slot) => to + gap <= slot.from || from >= slot.to + gap);
  }

  function place(node: CausalFlameNode, parent: Pick<CausalFlameBar, "node" | "row"> | null) {
    const queuedFrom = causalFlamePosition(scale, causalFlameNodeStart(node));
    const from =
      node.timing.kind === "span" ? causalFlamePosition(scale, node.timing.startedAt) : queuedFrom;
    const to = Math.max(causalFlamePosition(scale, causalFlameNodeEnd(node, now)), from);
    const labelSide: CausalFlameLabelSide = sitsInLane(node)
      ? "inside"
      : from > LABEL_FLIP_POSITION
        ? "start"
        : "end";
    const labelSlot =
      node.status === "failed" && node.detail !== null ? FAILURE_LABEL_SLOT : LABEL_SLOT;
    const claim =
      labelSide === "inside"
        ? { from: queuedFrom, to: Math.max(to, queuedFrom + LANE_SLOT) }
        : labelSide === "start"
          ? { from: Math.max(Math.min(queuedFrom, from - labelSlot), 0), to }
          : { from: queuedFrom, to: Math.min(Math.max(to, from + labelSlot), 1) };

    let row = parent === null ? 0 : parent.row + 1;
    while (!fits(row, claim.from, claim.to, labelSide === "inside" ? 0 : ROW_GAP)) {
      row += 1;
    }
    (claimed[row] ??= []).push(claim);

    const bar = {
      node,
      parentId: parent?.node.id ?? null,
      row,
      queuedFrom,
      from,
      to,
      labelSide,
      open: isOpen(node),
    };
    placed.push({ bar, claim });
    // Lanes go first, so what a run caused hangs below its steps rather than between them.
    for (const child of [...node.children].sort(
      (left, right) =>
        Number(sitsInLane(right)) - Number(sitsInLane(left)) ||
        causalFlameNodeStart(left) - causalFlameNodeStart(right),
    )) {
      place(child, bar);
    }
  }

  place(root, null);
  const bars = placed.map(({ bar, claim }) => {
    const neighbours = claimed[bar.row] ?? [];
    const before = neighbours.filter((other) => other.to <= claim.from);
    const after = neighbours.filter((other) => other.from >= claim.to);
    return {
      ...bar,
      room: {
        from: Math.max(0, ...before.map((other) => other.to + ROW_GAP)),
        to: Math.min(1, ...after.map((other) => other.from - ROW_GAP)),
      },
    };
  });
  return { bars, rowCount: claimed.length };
}

/** The chain from the root down to `id`, or empty when the tree does not contain it. */
export function causalFlamePath(root: CausalFlameNode, id: string): CausalFlameNode[] {
  if (root.id === id) {
    return [root];
  }
  for (const child of root.children) {
    const path = causalFlamePath(child, id);
    if (path.length > 0) {
      return [root, ...path];
    }
  }
  return [];
}

/**
 * `failed` counts failures, not failed nodes: a step that fails its run is one failure, so nodes
 * under a failed ancestor are not counted again.
 */
export function countCausalFlameNodes(
  root: CausalFlameNode,
): Record<CausalFlameNodeKind, number> & { failed: number } {
  const counts = { event: 0, route: 0, workflow: 0, step: 0, failed: 0 };
  (function visit(node: CausalFlameNode, underFailure: boolean) {
    counts[node.kind] += 1;
    const failed = node.status === "failed";
    if (failed && !underFailure) {
      counts.failed += 1;
    }
    for (const child of node.children) {
      visit(child, underFailure || failed);
    }
  })(root, false);
  return counts;
}
