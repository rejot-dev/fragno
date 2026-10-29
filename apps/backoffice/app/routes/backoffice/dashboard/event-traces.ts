import type {
  AutomationEventCausation,
  AutomationRouteDispatchOutcome,
  AutomationRouteDispatchSkipReason,
  AutomationRouteDispatchState,
} from "@fragno-dev/backoffice-api/v0/events";
import { backofficeScopePathSegment } from "@fragno-dev/backoffice-api/v0/shared/scope";
import type { WorkflowInstanceStatus } from "@fragno-dev/workflows/workflow";
import type {
  CausalFlameNode,
  CausalFlameStatus,
} from "@fragno-private/design-system/causal-flame-graph-model";

import { readRouteDispatchState } from "@/fragno/automation/route-dispatches-storage-runtime";

import {
  inferWorkflowStepStarts,
  workflowRunTime,
} from "../automations/script-view/workflow-run-presentation";

/** A synchronized dispatch row, as the replica stores it. */
export type EventTraceDispatchRow = Omit<EventTraceDispatch, "state"> & {
  status: string;
  outcome: AutomationRouteDispatchOutcome | null;
  failedAttempts: number;
  error: string | null;
};

export function eventTraceDispatch({
  status,
  outcome,
  failedAttempts,
  error,
  ...dispatch
}: EventTraceDispatchRow): EventTraceDispatch {
  return { ...dispatch, state: readRouteDispatchState({ status, outcome, failedAttempts, error }) };
}

export type EventTraceEvent = {
  id: string;
  source: string;
  eventType: string;
  /** The label the scope's event catalog gives its type, if the scope defines it. */
  label: string | null;
  occurredAt: Date;
  payload: unknown;
  subject: unknown;
  /** `null` for events recorded before causation was tracked; they are origins. */
  causation: AutomationEventCausation | null;
  rootEventId: string | null;
  /** `false` until every route the event matched is recorded, so no route yet means "not yet". */
  routesMatched: boolean;
};

export type EventTraceDispatch = {
  id: string;
  eventId: string;
  rootEventId: string;
  routeId: string;
  routeName: string;
  state: AutomationRouteDispatchState;
  /** When the event matched the route, before it acted. */
  dispatchedAt: Date;
};

export type EventTraceRun = {
  id: string;
  workflowName: string;
  instanceId: string;
  remoteWorkflowName: string | null;
  /** The workflow schema stores statuses as strings, but the runner only persists its own. */
  status: WorkflowInstanceStatus;
  errorMessage: string | null;
  createdAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
};

export type EventTraceStep = {
  id: string;
  instanceRef: string;
  stepKey: string;
  parentStepKey: string | null;
  name: string;
  type: string;
  status: "waiting" | "completed" | "errored";
  attempts: number;
  waitEventType: string | null;
  errorMessage: string | null;
  createdAt: Date;
  updatedAt: Date;
};

/** A workflow event sent to a run; routes send theirs as `<routeId>:<eventId>`. */
export type EventTraceDelivery = {
  id: string;
  instanceRef: string;
  type: string;
  createdAt: Date;
  /** `null` until a step of the run takes the event. */
  deliveredAt: Date | null;
  consumedByStepKey: string | null;
};

/** The records behind each node, so a selected node can show what it stands for. */
export type EventTraceRecord =
  | { kind: "event"; event: EventTraceEvent }
  | { kind: "dispatch"; dispatch: EventTraceDispatch }
  | { kind: "run"; nodeId: string; run: EventTraceRun }
  | { kind: "step"; step: EventTraceStep; run: EventTraceRun; runNodeId: string };

export type EventTrace = {
  rootEventId: string;
  root: CausalFlameNode;
  records: ReadonlyMap<string, EventTraceRecord>;
};

/**
 * Where the work an origin set in motion stands. Failed runs and routes are counted apart from the
 * state, because a trace can hold a failed run and one that is still going.
 */
export type EventTraceOutcome =
  | { kind: "unhandled" }
  | { kind: "in_progress"; state: "running" | "waiting"; failedCount: number }
  | { kind: "settled"; settledAt: Date; failedCount: number };

/**
 * Something an origin set in motion, named by what did it: a workflow run, an agent, or, when a
 * route did nothing else, the route itself.
 */
export type EventTraceEffect = { kind: "workflow" | "agent" | "route"; label: string };

export type EventTraceSummary = {
  rootEventId: string;
  source: string;
  eventType: string;
  /** The label the scope's event catalog gives the origin's type, if the scope defines it. */
  label: string | null;
  /** What the origin is about, read from its payload, such as an issue title or a schedule name. */
  headline: string | null;
  occurredAt: Date;
  /** What the origin set in motion: the workflows it started, else what else came of it. */
  effects: EventTraceEffect[];
  outcome: EventTraceOutcome;
};

/**
 * Traces in list order, with adjacent repeats of the same origin folded into one entry. `id` is the
 * oldest trace's, which stays put while newer repeats arrive.
 */
export type EventTraceListEntry =
  | { kind: "trace"; trace: EventTraceSummary }
  | { kind: "repeats"; id: string; traces: EventTraceSummary[] };

function rootIdOf(event: Pick<EventTraceEvent, "id" | "rootEventId">): string {
  return event.rootEventId ?? event.id;
}

// Payloads are whatever their source sent; these are the fields sources commonly title them with.
const HEADLINE_PATHS: readonly (readonly string[])[] = [
  ["title"],
  ["name"],
  ["subject"],
  ["issue"],
  ["pullRequest"],
  ["pull_request"],
];

/** A short human title for an event, such as `#42 Flaky deploy check`. */
function eventHeadline(payload: unknown): string | null {
  for (const path of HEADLINE_PATHS) {
    const value = path.reduce<unknown>(
      (current, key) =>
        typeof current === "object" && current !== null && key in current
          ? (current as Record<string, unknown>)[key]
          : undefined,
      payload,
    );
    if (typeof value === "string" && value.trim() !== "") {
      return value.trim();
    }
    if (typeof value === "object" && value !== null && "title" in value) {
      const { title, number } = value as { title: unknown; number?: unknown };
      if (typeof title === "string" && title.trim() !== "") {
        return typeof number === "number" ? `#${number} ${title.trim()}` : title.trim();
      }
    }
  }
  return null;
}

function eventLabel(event: Pick<EventTraceEvent, "source" | "eventType">): string {
  return `${event.source} · ${event.eventType}`;
}

function runKey(workflowName: string, instanceId: string): string {
  return `${workflowName}\u0000${instanceId}`;
}

function dispatchKey(routeId: string, eventId: string): string {
  return `${routeId}\u0000${eventId}`;
}

function completedOutcome({ state }: EventTraceDispatch): AutomationRouteDispatchOutcome | null {
  return state.status === "completed" ? state.outcome : null;
}

/** The workflow run a route started, if it started one. */
function startedRunKey(dispatch: EventTraceDispatch): string | null {
  const outcome = completedOutcome(dispatch);
  return outcome?.kind === "workflow_started"
    ? runKey(outcome.workflowName, outcome.instanceId)
    : null;
}

/** The workflow run a route started or sent an event to, if it did either. */
function actedOnRunKey(dispatch: EventTraceDispatch): string | null {
  const outcome = completedOutcome(dispatch);
  return outcome?.kind === "workflow_started" || outcome?.kind === "workflow_event_sent"
    ? runKey(outcome.workflowName, outcome.instanceId)
    : null;
}

/** The id a route gives the workflow event it sends for an automation event. */
function routeDeliveryId(dispatch: EventTraceDispatch): string {
  return `${dispatch.routeId}:${dispatch.eventId}`;
}

const TERMINAL_RUN_STATUSES: ReadonlySet<WorkflowInstanceStatus> = new Set([
  "complete",
  "errored",
  "terminated",
]);

const RUN_STATUS: Record<WorkflowInstanceStatus, CausalFlameStatus> = {
  active: "running",
  waiting: "waiting",
  paused: "waiting",
  complete: "ok",
  errored: "failed",
  terminated: "failed",
};

/** A route waiting for its next attempt is waiting; one that has not acted yet is about to. */
const DISPATCH_STATUS: Record<AutomationRouteDispatchState["status"], CausalFlameStatus> = {
  pending: "running",
  retrying: "waiting",
  completed: "ok",
  failed: "failed",
};

const SKIP_REASON_LABEL: Record<AutomationRouteDispatchSkipReason, string> = {
  no_linked_external_sender: "No external sender linked to a user",
  workflow_instance_unresolved: "No workflow run matched the route's target",
  caused_by_notified_agent: "The agent's own turns caused the event",
};

export function describeRouteDispatchSkipReason(reason: AutomationRouteDispatchSkipReason): string {
  return SKIP_REASON_LABEL[reason];
}

type RouteDispatchProgress = Exclude<AutomationRouteDispatchState, { status: "completed" }>;

/** What a route that has not completed is doing, such as the error it will retry after. */
export function describeRouteDispatchProgress(state: RouteDispatchProgress): string {
  switch (state.status) {
    case "pending":
      return "Not attempted yet";
    case "retrying":
      return `Attempt ${state.failedAttempts} failed, retrying: ${state.error}`;
    case "failed":
      return `Gave up after ${state.failedAttempts} ${state.failedAttempts === 1 ? "attempt" : "attempts"}: ${state.error}`;
  }
  throw new Error("Unsupported automation route dispatch state.");
}

/** The trace node of a recorded workflow step, so views listing steps can point into the trace. */
export function eventTraceStepNodeId(stepId: string): string {
  return `step:${stepId}`;
}

/** Origin events root their own trace; newest first. */
export function projectEventTraceSummaries({
  events,
  dispatches,
  runs,
  limit,
}: {
  events: readonly EventTraceEvent[];
  dispatches: readonly EventTraceDispatch[];
  runs: readonly EventTraceRun[];
  limit: number;
}): EventTraceSummary[] {
  const runsByKey = new Map(runs.map((run) => [runKey(run.workflowName, run.instanceId), run]));
  const eventsByRoot = groupBy(events, rootIdOf);
  const dispatchesByRoot = groupBy(dispatches, (dispatch) => dispatch.rootEventId);

  return events
    .filter((event) => rootIdOf(event) === event.id)
    .sort((left, right) => right.occurredAt.getTime() - left.occurredAt.getTime())
    .slice(0, limit)
    .map((origin) => {
      const derivedEvents = (eventsByRoot.get(origin.id) ?? []).filter(
        (event) => event.id !== origin.id,
      );
      const rootDispatches = [...(dispatchesByRoot.get(origin.id) ?? [])].sort(
        (left, right) => left.dispatchedAt.getTime() - right.dispatchedAt.getTime(),
      );
      const rootRuns = rootDispatches.flatMap((dispatch) => {
        const key = startedRunKey(dispatch);
        const run = key === null ? undefined : runsByKey.get(key);
        return run ? [run] : [];
      });
      return {
        rootEventId: origin.id,
        source: origin.source,
        eventType: origin.eventType,
        label: origin.label,
        headline: eventHeadline(origin.payload),
        occurredAt: origin.occurredAt,
        effects: traceEffects(rootDispatches, runsByKey, derivedEvents),
        outcome: traceOutcome(origin, derivedEvents, rootDispatches, rootRuns),
      };
    });
}

/** Records by `timeOf`, then by ID, so records from any source come out in one order. */
function byTime<T extends { id: string }>(records: readonly T[], timeOf: (record: T) => Date): T[] {
  return [...records].sort(
    (left, right) =>
      timeOf(left).getTime() - timeOf(right).getTime() ||
      (left.id < right.id ? -1 : left.id > right.id ? 1 : 0),
  );
}

function groupBy<T>(items: readonly T[], keyOf: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const key = keyOf(item);
    groups.set(key, [...(groups.get(key) ?? []), item]);
  }
  return groups;
}

function distinctEffects(effects: readonly EventTraceEffect[]): EventTraceEffect[] {
  const byKey = new Map(effects.map((effect) => [`${effect.kind}\u0000${effect.label}`, effect]));
  return [...byKey.values()];
}

/**
 * What each route the trace matched did, in the order they matched, so an event that fanned out
 * lists every branch. A route that started or sent an event to a workflow, or notified an agent, is
 * named by that worker.
 * Reclassifications and skips only stand in when no route did anything else, because the routes of
 * a reclassified event already say what came of it.
 */
function traceEffects(
  dispatches: readonly EventTraceDispatch[],
  runsByKey: ReadonlyMap<string, EventTraceRun>,
  events: readonly EventTraceEvent[],
): EventTraceEffect[] {
  const effects = dispatches.map(
    ({ routeName, state }): { effect: EventTraceEffect; acted: boolean } => {
      switch (state.status) {
        case "pending":
        case "retrying":
          return { effect: { kind: "route", label: routeName }, acted: true };
        case "failed":
          return { effect: { kind: "route", label: `${routeName} failed` }, acted: true };
        case "completed":
          break;
      }
      const { outcome } = state;
      switch (outcome.kind) {
        case "workflow_started": {
          const run = runsByKey.get(runKey(outcome.workflowName, outcome.instanceId));
          return {
            effect: {
              kind: "workflow",
              label: run?.remoteWorkflowName ?? run?.workflowName ?? outcome.workflowName,
            },
            acted: true,
          };
        }
        // A delivery is named by the run that took it, like a run a route started.
        case "workflow_event_sent": {
          const run = runsByKey.get(runKey(outcome.workflowName, outcome.instanceId));
          return {
            effect: run?.remoteWorkflowName
              ? { kind: "workflow", label: run.remoteWorkflowName }
              : { kind: "route", label: `${routeName} delivered ${outcome.eventType}` },
            acted: true,
          };
        }
        case "agent_notified":
          return { effect: { kind: "agent", label: outcome.agentName }, acted: true };
        case "event_forwarded":
          return { effect: { kind: "route", label: `${routeName} forwarded` }, acted: true };
        case "event_reclassified":
          return {
            effect: {
              kind: "route",
              label: events.find((event) => event.id === outcome.eventId)?.eventType ?? routeName,
            },
            acted: false,
          };
        case "skipped":
          return { effect: { kind: "route", label: `${routeName} skipped` }, acted: false };
      }
      throw new Error("Unsupported automation route dispatch outcome.");
    },
  );
  const acted = effects.filter((effect) => effect.acted);
  return distinctEffects((acted.length > 0 ? acted : effects).map(({ effect }) => effect));
}

function traceOutcome(
  origin: EventTraceEvent,
  derivedEvents: readonly EventTraceEvent[],
  dispatches: readonly EventTraceDispatch[],
  runs: readonly EventTraceRun[],
): EventTraceOutcome {
  if (!origin.routesMatched) {
    return { kind: "in_progress", state: "running", failedCount: 0 };
  }
  if (dispatches.length === 0 && derivedEvents.length === 0) {
    return { kind: "unhandled" };
  }
  const statuses = [
    ...runs.map((run) => RUN_STATUS[run.status]),
    ...dispatches.map(({ state }) => DISPATCH_STATUS[state.status]),
  ];
  const failedCount = statuses.filter((status) => status === "failed").length;
  if (statuses.includes("running") || statuses.includes("waiting")) {
    return {
      kind: "in_progress",
      state: statuses.includes("running") ? "running" : "waiting",
      failedCount,
    };
  }
  const moments = [
    origin.occurredAt,
    ...derivedEvents.map((event) => event.occurredAt),
    ...dispatches.map((dispatch) => dispatch.dispatchedAt),
    ...runs.flatMap((run) => (run.completedAt === null ? [] : [run.completedAt])),
  ].map((moment) => moment.getTime());
  return { kind: "settled", settledAt: new Date(Math.max(...moments)), failedCount };
}

/**
 * Adjacent traces of the same origin about the same thing, such as one schedule firing every
 * minute, fold into one entry, so the list stays chronological without repeating itself.
 */
export function projectEventTraceList(
  summaries: readonly EventTraceSummary[],
): EventTraceListEntry[] {
  const entries: EventTraceListEntry[] = [];
  for (const summary of summaries) {
    const previous = entries.at(-1);
    const previousTraces =
      previous === undefined ? [] : previous.kind === "trace" ? [previous.trace] : previous.traces;
    const first = previousTraces[0];
    if (
      first === undefined ||
      first.source !== summary.source ||
      first.eventType !== summary.eventType ||
      first.headline !== summary.headline
    ) {
      entries.push({ kind: "trace", trace: summary });
      continue;
    }
    entries[entries.length - 1] = {
      kind: "repeats",
      id: summary.rootEventId,
      traces: [...previousTraces, summary],
    };
  }
  return entries;
}

/**
 * Row ids of the runs routes started or sent events to within one trace, whose steps and workflow
 * events the trace draws.
 */
export function eventTraceRunIds({
  rootEventId,
  dispatches,
  runs,
}: {
  rootEventId: string;
  dispatches: readonly EventTraceDispatch[];
  runs: readonly EventTraceRun[];
}): string[] {
  const runsByKey = new Map(runs.map((run) => [runKey(run.workflowName, run.instanceId), run]));
  return dispatches.flatMap((dispatch) => {
    const key = dispatch.rootEventId === rootEventId ? actedOnRunKey(dispatch) : null;
    const run = key === null ? undefined : runsByKey.get(key);
    return run ? [run.id] : [];
  });
}

/**
 * Builds one origin's causal tree. Every route an event matched hangs from it, so an event that
 * fans out to several routes reads as siblings; what a route caused, a derived event or a run,
 * hangs from the route. Events a run fired hang from the run. A run a route only sent an event to
 * appears for what that event set off: the steps from when it took the event until it waits for
 * the next one.
 */
export function projectEventTrace({
  rootEventId,
  events,
  dispatches,
  runs,
  steps: unorderedSteps,
  deliveries: unorderedDeliveries,
}: {
  rootEventId: string;
  events: readonly EventTraceEvent[];
  dispatches: readonly EventTraceDispatch[];
  runs: readonly EventTraceRun[];
  steps: readonly EventTraceStep[];
  deliveries: readonly EventTraceDelivery[];
}): EventTrace | null {
  // Siblings keep the order of these lists, so the trace orders them by time rather than by how
  // its source happened to return them.
  const traceEvents = byTime(
    events.filter((event) => rootIdOf(event) === rootEventId),
    (event) => event.occurredAt,
  );
  const root = traceEvents.find((event) => event.id === rootEventId);
  if (!root) {
    return null;
  }
  const traceDispatches = byTime(
    dispatches.filter((dispatch) => dispatch.rootEventId === rootEventId),
    (dispatch) => dispatch.dispatchedAt,
  );
  const steps = byTime(unorderedSteps, (step) => step.createdAt);
  const deliveries = byTime(unorderedDeliveries, (delivery) => delivery.createdAt);
  const runsByKey = new Map(runs.map((run) => [runKey(run.workflowName, run.instanceId), run]));
  const dispatchKeys = new Set(
    traceDispatches.map((dispatch) => dispatchKey(dispatch.routeId, dispatch.eventId)),
  );
  const startedRunKeys = new Set(
    traceDispatches.flatMap((dispatch) => {
      const key = startedRunKey(dispatch);
      return key === null ? [] : [key];
    }),
  );
  const records = new Map<string, EventTraceRecord>();

  function eventNode(event: EventTraceEvent, detail: string | null): CausalFlameNode {
    const id = `event:${event.id}`;
    records.set(id, { kind: "event", event });
    // A derived event hangs from the route that derived it, unless that route's record is gone.
    const unroutedChildren = traceEvents.flatMap((child) =>
      child.causation?.kind === "route" &&
      child.causation.parent.eventId === event.id &&
      !dispatchKeys.has(dispatchKey(child.causation.routeId, event.id))
        ? [eventNode(child, `via route ${child.causation.routeId}`)]
        : [],
    );
    // Events fired by a run outside this trace, such as a manual one, hang from their parent.
    const orphanedWorkflowChildren = traceEvents.flatMap((child) =>
      child.causation?.kind === "workflow" &&
      child.causation.parent?.eventId === event.id &&
      !startedRunKeys.has(runKey(child.causation.workflowName, child.causation.instanceId))
        ? [eventNode(child, `fired by ${child.causation.instanceId}`)]
        : [],
    );
    const dispatchChildren = traceDispatches.flatMap((dispatch) =>
      dispatch.eventId === event.id ? [dispatchNode(dispatch)] : [],
    );
    return {
      id,
      kind: "event",
      label: eventLabel(event),
      detail,
      status: "ok",
      timing: { kind: "instant", at: event.occurredAt.getTime() },
      children: [...dispatchChildren, ...unroutedChildren, ...orphanedWorkflowChildren],
    };
  }

  function dispatchNode(dispatch: EventTraceDispatch): CausalFlameNode {
    const { state } = dispatch;
    const id = `dispatch:${dispatch.id}`;
    records.set(id, { kind: "dispatch", dispatch });
    const route = {
      id,
      kind: "route",
      label: dispatch.routeName,
      timing: { kind: "instant", at: dispatch.dispatchedAt.getTime() },
    } as const;
    // The events this route caused: what it reclassified the event into, and the route.failed
    // events announcing each time it failed, which stay after a retry succeeds.
    const caused = traceEvents
      .filter(
        (event) =>
          event.causation?.kind === "route" &&
          event.causation.routeId === dispatch.routeId &&
          event.causation.parent.eventId === dispatch.eventId,
      )
      .map((event) => eventNode(event, null));
    if (state.status !== "completed") {
      return {
        ...route,
        detail: describeRouteDispatchProgress(state),
        status: DISPATCH_STATUS[state.status],
        children: caused,
      };
    }
    const { outcome } = state;
    switch (outcome.kind) {
      case "event_reclassified":
        return {
          ...route,
          detail: "Reclassified the event",
          status: "ok",
          children: caused,
        };
      case "workflow_started":
        return {
          ...route,
          detail: "Started a run",
          status: "ok",
          children: [runNode(dispatch, outcome), ...caused],
        };
      case "workflow_event_sent":
        return {
          ...route,
          detail: `Delivered ${outcome.eventType} to run ${outcome.instanceId}`,
          status: "ok",
          children: [...deliveredRunNodes(dispatch, outcome), ...caused],
        };
      case "event_forwarded":
        return {
          ...route,
          detail: `Forwarded to ${backofficeScopePathSegment(outcome.scope)}`,
          status: "ok",
          children: caused,
        };
      case "agent_notified":
        return {
          ...route,
          // Turns are queued and answered later, so an answer roots a trace of its own.
          detail: `Notified ${outcome.agentName}; its answer starts its own trace`,
          status: "ok",
          children: caused,
        };
      case "skipped":
        return {
          ...route,
          detail: `Skipped: ${describeRouteDispatchSkipReason(outcome.reason)}`,
          status: "skipped",
          children: caused,
        };
    }
    throw new Error("Unsupported automation route dispatch outcome.");
  }

  function runNode(
    dispatch: EventTraceDispatch,
    outcome: Extract<AutomationRouteDispatchOutcome, { kind: "workflow_started" }>,
  ): CausalFlameNode {
    const run = runsByKey.get(runKey(outcome.workflowName, outcome.instanceId)) ?? null;
    const id = `run:${outcome.workflowName}:${outcome.instanceId}`;
    const label = run === null ? outcome.instanceId : (run.remoteWorkflowName ?? run.workflowName);
    // The events a run fired still belong under it when its row is gone, or not synchronized yet.
    const firedEvents = traceEvents.flatMap((event) =>
      event.causation?.kind === "workflow" &&
      event.causation.workflowName === outcome.workflowName &&
      event.causation.instanceId === outcome.instanceId
        ? [eventNode(event, `fired by ${label}`)]
        : [],
    );
    if (run === null) {
      // Only the route that started it still tells anything about it.
      records.set(id, { kind: "dispatch", dispatch });
      return {
        id,
        kind: "workflow",
        label,
        detail: "The run is no longer recorded",
        status: "pending",
        timing: { kind: "instant", at: dispatch.dispatchedAt.getTime() },
        children: firedEvents,
      };
    }
    records.set(id, { kind: "run", nodeId: id, run });
    return {
      id,
      kind: "workflow",
      label,
      detail: run.errorMessage,
      status: RUN_STATUS[run.status],
      // The runner stamps `startedAt` when a run's first tick commits, not when it begins, so it
      // cannot separate queueing from work: a started run spans from its creation.
      timing:
        run.startedAt === null
          ? { kind: "queued", queuedAt: run.createdAt.getTime() }
          : {
              kind: "span",
              activity: "work",
              queuedAt: run.createdAt.getTime(),
              startedAt: run.createdAt.getTime(),
              endedAt: run.completedAt?.getTime() ?? null,
            },
      children: [...stepNodes(run, id), ...firedEvents],
    };
  }

  /**
   * The run as far as one delivered event set it to work. Its span starts when the event was sent,
   * not when the run was created, so a run that waited days before the trace does not stretch it.
   */
  function deliveredRunNodes(
    dispatch: EventTraceDispatch,
    outcome: Extract<AutomationRouteDispatchOutcome, { kind: "workflow_event_sent" }>,
  ): CausalFlameNode[] {
    const run = runsByKey.get(runKey(outcome.workflowName, outcome.instanceId));
    if (!run) {
      return [];
    }
    const id = `delivery:${dispatch.id}`;
    records.set(id, { kind: "run", nodeId: id, run });
    const label = run.remoteWorkflowName ?? run.workflowName;
    const delivery = deliveries.find(
      (candidate) => candidate.instanceRef === run.id && candidate.id === routeDeliveryId(dispatch),
    );
    const sentAt = (delivery?.createdAt ?? dispatch.dispatchedAt).getTime();
    if (!delivery || delivery.deliveredAt === null || delivery.consumedByStepKey === null) {
      return [
        {
          id,
          kind: "workflow",
          label,
          detail: `Has not taken ${outcome.eventType} yet`,
          status: TERMINAL_RUN_STATUSES.has(run.status) ? "failed" : "pending",
          timing: { kind: "queued", queuedAt: sentAt },
          children: [],
        },
      ];
    }

    // What the event set off is what the run did after taking it, until it took its next event.
    // Steps that commit in one tick share a timestamp, so time bounds them, not step order.
    const deliveredAt = delivery.deliveredAt.getTime();
    const consumer = steps.find(
      (step) => step.instanceRef === run.id && step.stepKey === delivery.consumedByStepKey,
    );
    const nextTakenAt = Math.min(
      ...deliveries.flatMap((other) =>
        other.instanceRef === run.id &&
        other.deliveredAt !== null &&
        other.deliveredAt.getTime() > deliveredAt
          ? [other.deliveredAt.getTime()]
          : [],
      ),
    );
    const later = steps
      .filter(
        (step) =>
          step.instanceRef === run.id &&
          step.parentStepKey === (consumer?.parentStepKey ?? null) &&
          step.stepKey !== delivery.consumedByStepKey &&
          step.createdAt.getTime() >= deliveredAt &&
          step.createdAt.getTime() < nextTakenAt,
      )
      .sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime());
    const caused = later.filter((step) => step.type !== "waitForEvent");
    const waitsAgain = later.some((step) => step.type === "waitForEvent");
    const settled =
      waitsAgain || Number.isFinite(nextTakenAt) || TERMINAL_RUN_STATUSES.has(run.status);
    const failedStep = caused.find((step) => step.status === "errored");
    const failed =
      failedStep !== undefined ||
      (!waitsAgain && (run.status === "errored" || run.status === "terminated"));
    const endedAt = settled
      ? Math.max(
          deliveredAt,
          ...caused.map((step) => step.updatedAt.getTime()),
          ...(!waitsAgain && run.completedAt !== null ? [run.completedAt.getTime()] : []),
        )
      : null;
    return [
      {
        id,
        kind: "workflow",
        label,
        detail: failed
          ? (failedStep?.errorMessage ?? run.errorMessage)
          : `Took ${outcome.eventType}`,
        status: failed
          ? "failed"
          : settled
            ? "ok"
            : run.status === "waiting" || run.status === "paused"
              ? "waiting"
              : "running",
        timing: {
          kind: "span",
          activity: "work",
          queuedAt: sentAt,
          startedAt: deliveredAt,
          endedAt,
        },
        children: stepNodes(run, id, caused),
      },
    ];
  }

  function stepNodes(
    run: EventTraceRun,
    runNodeId: string,
    /** The top-level steps to draw, when only part of the run belongs to the trace. */
    topLevel?: readonly EventTraceStep[],
  ): CausalFlameNode[] {
    const runSteps = steps.filter((step) => step.instanceRef === run.id);
    const starts = inferWorkflowStepStarts(runSteps, run.createdAt.getTime());
    return nestedStepNodes(null);

    function nestedStepNodes(parentStepKey: string | null): CausalFlameNode[] {
      return (
        parentStepKey === null && topLevel !== undefined
          ? topLevel
          : runSteps.filter((step) => step.parentStepKey === parentStepKey)
      ).map((step) => {
        const id = eventTraceStepNodeId(step.id);
        records.set(id, { kind: "step", step, run, runNodeId });
        const startedAt = starts.get(step.id) ?? workflowRunTime(step.createdAt);
        return {
          id,
          kind: "step",
          label: step.name,
          detail:
            step.errorMessage ??
            (step.waitEventType === null ? null : `Waits for ${step.waitEventType}`),
          status:
            step.status === "completed" ? "ok" : step.status === "errored" ? "failed" : "waiting",
          timing: {
            kind: "span",
            activity: step.type === "do" ? "work" : "wait",
            queuedAt: startedAt,
            startedAt,
            endedAt: step.status === "waiting" ? null : step.updatedAt.getTime(),
          },
          children: nestedStepNodes(step.stepKey),
        };
      });
    }
  }

  return { rootEventId, root: eventNode(root, null), records };
}
