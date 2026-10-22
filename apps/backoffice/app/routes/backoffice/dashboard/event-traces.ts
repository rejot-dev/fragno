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

import { inArray, type InitialQueryBuilder } from "@tanstack/react-db";

import { readRouteDispatchState } from "@/fragno/automation/route-dispatches-storage-runtime";
import type { AutomationCollections } from "@/fragno/automation/tanstack/collections";

import {
  inferWorkflowStepStarts,
  workflowRunTime,
} from "../automations/script-view/workflow-run-presentation";

export function eventTraceEventsQuery(
  query: InitialQueryBuilder,
  collections: Pick<AutomationCollections, "events">,
) {
  return query.from({ event: collections.events }).select(({ event }) => ({
    id: event.id,
    source: event.source,
    eventType: event.eventType,
    occurredAt: event.occurredAt,
    payload: event.payload,
    subject: event.subject,
    causation: event.causation,
    rootEventId: event.rootEventId,
  }));
}

export function eventTraceDispatchesQuery(
  query: InitialQueryBuilder,
  collections: Pick<AutomationCollections, "routeDispatches">,
) {
  return query.from({ dispatch: collections.routeDispatches }).select(({ dispatch }) => ({
    id: dispatch.id,
    eventId: dispatch.eventId,
    rootEventId: dispatch.rootEventId,
    routeId: dispatch.routeId,
    routeName: dispatch.routeName,
    status: dispatch.status,
    outcome: dispatch.outcome,
    failedAttempts: dispatch.failedAttempts,
    error: dispatch.error,
    dispatchedAt: dispatch.dispatchedAt,
  }));
}

/** A synchronized dispatch row, as `eventTraceDispatchesQuery` selects it. */
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

export function eventTraceRunsQuery(
  query: InitialQueryBuilder,
  collections: Pick<AutomationCollections, "workflowInstances">,
) {
  return query.from({ instance: collections.workflowInstances }).select(({ instance }) => ({
    id: instance.id,
    workflowName: instance.workflowName,
    instanceId: instance.instanceId,
    remoteWorkflowName: instance.remoteWorkflowName,
    status: instance.status,
    errorMessage: instance.errorMessage,
    createdAt: instance.createdAt,
    startedAt: instance.startedAt,
    completedAt: instance.completedAt,
  }));
}

/** Only the steps of the runs in the open trace, by workflow instance row id. */
export function eventTraceStepsQuery(
  query: InitialQueryBuilder,
  collections: Pick<AutomationCollections, "workflowSteps">,
  instanceRefs: readonly string[],
) {
  return query
    .from({ step: collections.workflowSteps })
    .where(({ step }) => inArray(step.instanceRef, [...instanceRefs]))
    .select(({ step }) => ({
      id: step.id,
      instanceRef: step.instanceRef,
      stepKey: step.stepKey,
      parentStepKey: step.parentStepKey,
      name: step.name,
      type: step.type,
      status: step.status,
      attempts: step.attempts,
      waitEventType: step.waitEventType,
      errorMessage: step.errorMessage,
      createdAt: step.createdAt,
      updatedAt: step.updatedAt,
    }));
}

export type EventTraceEvent = {
  id: string;
  source: string;
  eventType: string;
  occurredAt: Date;
  payload: unknown;
  subject: unknown;
  /** `null` for events recorded before causation was tracked; they are origins. */
  causation: AutomationEventCausation | null;
  rootEventId: string | null;
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

/** The records behind each node, so a selected node can show what it stands for. */
export type EventTraceRecord =
  | { kind: "event"; event: EventTraceEvent }
  | { kind: "dispatch"; dispatch: EventTraceDispatch }
  | { kind: "run"; nodeId: string; run: EventTraceRun | null; dispatch: EventTraceDispatch }
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

export type EventTraceSummary = {
  rootEventId: string;
  source: string;
  eventType: string;
  /** What the origin is about, read from its payload, such as an issue title or a schedule name. */
  headline: string | null;
  occurredAt: Date;
  /** What the origin set in motion: the workflows it started, else what else came of it. */
  effects: string[];
  outcome: EventTraceOutcome;
};

/** Traces in list order, with adjacent repeats of the same origin folded into one entry. */
export type EventTraceListEntry =
  | { kind: "trace"; trace: EventTraceSummary }
  /** `id` is the oldest trace's, which stays put while newer repeats arrive. */
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

function dispatchProgressLabel(routeName: string, state: RouteDispatchProgress): string {
  switch (state.status) {
    case "pending":
      return `${routeName} is about to act`;
    case "retrying":
      return `${routeName} is retrying`;
    case "failed":
      return `${routeName} failed`;
  }
  throw new Error("Unsupported automation route dispatch state.");
}

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
        headline: eventHeadline(origin.payload),
        occurredAt: origin.occurredAt,
        effects: traceEffects(rootDispatches, rootRuns, derivedEvents),
        outcome: traceOutcome(origin, derivedEvents, rootDispatches, rootRuns),
      };
    });
}

function groupBy<T>(items: readonly T[], keyOf: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const key = keyOf(item);
    groups.set(key, [...(groups.get(key) ?? []), item]);
  }
  return groups;
}

function distinct(values: readonly string[]): string[] {
  return [...new Set(values)];
}

/**
 * The workflows and agents an event set to work say the most about what it did. Without any, the
 * derived events say it, and without those, what the routes did instead.
 */
function traceEffects(
  dispatches: readonly EventTraceDispatch[],
  runs: readonly EventTraceRun[],
  derivedEvents: readonly EventTraceEvent[],
): string[] {
  const workers = [
    ...runs.map((run) => run.remoteWorkflowName ?? run.workflowName),
    ...dispatches.flatMap((dispatch) => {
      const outcome = completedOutcome(dispatch);
      return outcome?.kind === "agent_notified" ? [`${outcome.agentName} agent`] : [];
    }),
  ];
  if (workers.length > 0) {
    return distinct(workers);
  }
  if (derivedEvents.length > 0) {
    return distinct(derivedEvents.map((event) => event.eventType));
  }
  return distinct(
    dispatches.flatMap(({ routeName, state }) => {
      if (state.status === "failed") {
        return [`${routeName} failed`];
      }
      if (state.status !== "completed") {
        return [];
      }
      const { outcome } = state;
      switch (outcome.kind) {
        case "skipped":
          return [`${routeName} skipped`];
        case "workflow_event_sent":
          return [`${routeName} delivered ${outcome.eventType}`];
        case "event_forwarded":
          return [`${routeName} forwarded`];
        case "workflow_started":
        case "event_reclassified":
        case "agent_notified":
          return [];
      }
      throw new Error("Unsupported automation route dispatch outcome.");
    }),
  );
}

function traceOutcome(
  origin: EventTraceEvent,
  derivedEvents: readonly EventTraceEvent[],
  dispatches: readonly EventTraceDispatch[],
  runs: readonly EventTraceRun[],
): EventTraceOutcome {
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

/** Row ids of the runs routes started within one trace, whose steps the trace draws. */
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
    const key = dispatch.rootEventId === rootEventId ? startedRunKey(dispatch) : null;
    const run = key === null ? undefined : runsByKey.get(key);
    return run ? [run.id] : [];
  });
}

/**
 * Builds one origin's causal tree. Derived events hang from their parent event, or from the run
 * that fired them; runs and route outcomes hang from the event a route dispatched them for.
 */
export function projectEventTrace({
  rootEventId,
  events,
  dispatches,
  runs,
  steps,
}: {
  rootEventId: string;
  events: readonly EventTraceEvent[];
  dispatches: readonly EventTraceDispatch[];
  runs: readonly EventTraceRun[];
  steps: readonly EventTraceStep[];
}): EventTrace | null {
  const traceEvents = events.filter((event) => rootIdOf(event) === rootEventId);
  const root = traceEvents.find((event) => event.id === rootEventId);
  if (!root) {
    return null;
  }
  const traceDispatches = dispatches.filter((dispatch) => dispatch.rootEventId === rootEventId);
  const runsByKey = new Map(runs.map((run) => [runKey(run.workflowName, run.instanceId), run]));
  const routeNames = new Map(
    traceDispatches.map((dispatch) => [
      dispatchKey(dispatch.routeId, dispatch.eventId),
      dispatch.routeName,
    ]),
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
    const routeChildren = traceEvents.flatMap((child) =>
      child.causation?.kind === "route" && child.causation.parent.eventId === event.id
        ? [
            eventNode(
              child,
              `via ${routeNames.get(dispatchKey(child.causation.routeId, event.id)) ?? child.causation.routeId}`,
            ),
          ]
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
      dispatch.eventId === event.id ? dispatchNodes(dispatch) : [],
    );
    return {
      id,
      kind: "event",
      label: eventLabel(event),
      detail,
      status: "ok",
      timing: { kind: "instant", at: event.occurredAt.getTime() },
      children: [...routeChildren, ...orphanedWorkflowChildren, ...dispatchChildren],
    };
  }

  function dispatchNodes(dispatch: EventTraceDispatch): CausalFlameNode[] {
    const { state } = dispatch;
    const id = `dispatch:${dispatch.id}`;
    const at = dispatch.dispatchedAt.getTime();
    if (state.status !== "completed") {
      records.set(id, { kind: "dispatch", dispatch });
      return [
        routeNode(id, dispatchProgressLabel(dispatch.routeName, state), {
          detail: describeRouteDispatchProgress(state),
          status: DISPATCH_STATUS[state.status],
          at,
        }),
      ];
    }
    const { outcome } = state;
    switch (outcome.kind) {
      // The derived event is a node of its own, which already names the route.
      case "event_reclassified":
        return [];
      case "workflow_started":
        return [runNode(dispatch, outcome)];
      case "workflow_event_sent":
        records.set(id, { kind: "dispatch", dispatch });
        return [
          routeNode(id, `${dispatch.routeName} delivered ${outcome.eventType}`, {
            detail: `To run ${outcome.instanceId}`,
            status: "ok",
            at,
          }),
        ];
      case "event_forwarded":
        records.set(id, { kind: "dispatch", dispatch });
        return [
          routeNode(id, `${dispatch.routeName} forwarded the event`, {
            detail: `To ${backofficeScopePathSegment(outcome.scope)}`,
            status: "ok",
            at,
          }),
        ];
      case "agent_notified":
        records.set(id, { kind: "dispatch", dispatch });
        return [
          routeNode(id, `${dispatch.routeName} notified ${outcome.agentName}`, {
            // Turns are queued and answered later, so an answer roots a trace of its own.
            detail: "The agent's answer starts its own trace",
            status: "ok",
            at,
          }),
        ];
      case "skipped":
        records.set(id, { kind: "dispatch", dispatch });
        return [
          routeNode(id, `${dispatch.routeName} skipped`, {
            detail: describeRouteDispatchSkipReason(outcome.reason),
            status: "skipped",
            at,
          }),
        ];
    }
    throw new Error("Unsupported automation route dispatch outcome.");
  }

  function runNode(
    dispatch: EventTraceDispatch,
    outcome: Extract<AutomationRouteDispatchOutcome, { kind: "workflow_started" }>,
  ): CausalFlameNode {
    const run = runsByKey.get(runKey(outcome.workflowName, outcome.instanceId)) ?? null;
    const id = `run:${outcome.workflowName}:${outcome.instanceId}`;
    records.set(id, { kind: "run", nodeId: id, run, dispatch });
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
      return {
        id,
        kind: "workflow",
        label,
        detail: `via ${dispatch.routeName}; the run is no longer recorded`,
        status: "pending",
        timing: { kind: "instant", at: dispatch.dispatchedAt.getTime() },
        children: firedEvents,
      };
    }
    return {
      id,
      kind: "workflow",
      label,
      detail: run.errorMessage ?? `via ${dispatch.routeName}`,
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

  function stepNodes(run: EventTraceRun, runNodeId: string): CausalFlameNode[] {
    const runSteps = steps.filter((step) => step.instanceRef === run.id);
    const starts = inferWorkflowStepStarts(runSteps, run.createdAt.getTime());
    return nestedStepNodes(null);

    function nestedStepNodes(parentStepKey: string | null): CausalFlameNode[] {
      return runSteps
        .filter((step) => step.parentStepKey === parentStepKey)
        .map((step) => {
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

  function routeNode(
    id: string,
    label: string,
    fields: { detail: string; status: CausalFlameStatus; at: number },
  ): CausalFlameNode {
    return {
      id,
      kind: "route",
      label,
      detail: fields.detail,
      status: fields.status,
      timing: { kind: "instant", at: fields.at },
      children: [],
    };
  }

  return { rootEventId, root: eventNode(root, null), records };
}
