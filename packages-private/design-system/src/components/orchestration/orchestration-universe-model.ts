import type { IconName } from "../icon";
import { itemKey, type OrchestrationGraph } from "./orchestration-graph-model";
import {
  layoutWorkflowTriggerGraph,
  UNORIENTED,
  type WorkflowTriggerItem,
  type WorkflowTriggerLayout,
} from "./workflow-trigger-graph-model";

export type OrchestrationUniverseScope = { id: string; graph: OrchestrationGraph };

/**
 * Where a scope's forward route delivers. Forward targets are templates such as "the event's
 * subject", so one route can reach several scopes, each with a forward of its own.
 */
export type OrchestrationForward = { routeId: string; fromScopeId: string; toScopeId: string };

/** A system outside Backoffice that workflows call, such as Telegram or an email provider. */
export type OrchestrationExternal = { id: string; label: string; icon: IconName };

/** A workflow of one scope that calls an outside system somewhere in its steps. */
export type OrchestrationExternalCall = { scopeId: string; workflowId: string; externalId: string };

export type OrchestrationUniverse = {
  scopes: readonly OrchestrationUniverseScope[];
  forwards: readonly OrchestrationForward[];
  externals: readonly OrchestrationExternal[];
  calls: readonly OrchestrationExternalCall[];
};

/** An item of one scope's planet. */
export type UniverseItem = { scopeId: string; item: WorkflowTriggerItem };

/** A forward drawn between planets: the event leaves one scope and arrives in the other as is. */
export type UniverseForward = {
  id: string;
  fromScopeId: string;
  toScopeId: string;
  eventId: string;
  label: string;
};

/** A call drawn from a workflow on a planet out to an outside system. */
export type UniverseCall = { id: string; scopeId: string; workflowId: string; externalId: string };

export type UniversePlanet = {
  scope: OrchestrationUniverseScope;
  layout: WorkflowTriggerLayout;
  forwardCounts: ReadonlyMap<string, number>;
};

export function universeItemKey({ scopeId, item }: UniverseItem): string {
  return `${scopeId}|${itemKey(item)}`;
}

export function forwardKey(forward: UniverseForward): string {
  return `forward|${forward.id}`;
}

export function callKey(call: UniverseCall): string {
  return `call|${call.id}`;
}

export function externalKey(externalId: string): string {
  return `external|${externalId}`;
}

/** Enabled forwards with the event each carries; a disabled route forwards nothing. */
function universeForwards(universe: OrchestrationUniverse): UniverseForward[] {
  const scopes = new Map(universe.scopes.map((scope) => [scope.id, scope]));
  const forwards = new Map<string, UniverseForward>();
  for (const forward of universe.forwards) {
    const route = scopes
      .get(forward.fromScopeId)
      ?.graph.routes.find((candidate) => candidate.id === forward.routeId);
    if (
      !route?.enabled ||
      route.action.kind !== "forward_event" ||
      !scopes.has(forward.toScopeId)
    ) {
      continue;
    }
    const id = `${forward.fromScopeId}→${forward.toScopeId}:${route.eventId}`;
    forwards.set(id, {
      id,
      fromScopeId: forward.fromScopeId,
      toScopeId: forward.toScopeId,
      eventId: route.eventId,
      label: route.label,
    });
  }
  return [...forwards.values()];
}

/**
 * Calls from workflows that are on a planet, once per workflow and outside system. A workflow no
 * enabled route starts has no place to draw a call from.
 */
function universeCalls(
  universe: OrchestrationUniverse,
  planets: readonly UniversePlanet[],
): UniverseCall[] {
  const onPlanets = new Set(
    planets.flatMap(({ scope, layout }) =>
      layout.workflows.map(({ workflow }) => `${scope.id}|${workflow.id}`),
    ),
  );
  const externals = new Set(universe.externals.map((external) => external.id));
  const calls = new Map<string, UniverseCall>();
  for (const call of universe.calls) {
    if (onPlanets.has(`${call.scopeId}|${call.workflowId}`) && externals.has(call.externalId)) {
      const id = `${call.scopeId}|${call.workflowId}→${call.externalId}`;
      calls.set(id, { id, ...call });
    }
  }
  return [...calls.values()];
}

export function layoutUniverse(universe: OrchestrationUniverse): {
  planets: UniversePlanet[];
  forwards: UniverseForward[];
  externals: OrchestrationExternal[];
  calls: UniverseCall[];
} {
  const forwards = universeForwards(universe);
  const planets = universe.scopes.map((scope) => {
    const destinations = new Map<string, Set<string>>();
    for (const forward of forwards) {
      if (forward.fromScopeId === scope.id) {
        destinations.set(
          forward.eventId,
          new Set([...(destinations.get(forward.eventId) ?? []), forward.toScopeId]),
        );
      }
    }
    const forwardCounts = new Map(
      [...destinations].map(([eventId, scopeIds]) => [eventId, scopeIds.size]),
    );
    return {
      scope,
      layout: layoutWorkflowTriggerGraph(scope.graph, forwardCounts, UNORIENTED),
      forwardCounts,
    };
  });
  const calls = universeCalls(universe, planets);
  const called = new Set(calls.map((call) => call.externalId));
  return {
    planets,
    forwards,
    externals: universe.externals.filter((external) => called.has(external.id)),
    calls,
  };
}

/** Which events start which workflows and which forwards and calls leave where, across scopes. */
function universeIndex(
  planets: readonly UniversePlanet[],
  forwards: readonly UniverseForward[],
  calls: readonly UniverseCall[],
) {
  const at = (scopeId: string, id: string) => `${scopeId}|${id}`;
  const sourceOfEvent = new Map<string, string>();
  const workflowsOfEvent = grouped(
    planets.flatMap(({ scope, layout }) =>
      layout.triggers.map(({ eventId, workflowId }) => ({
        key: at(scope.id, eventId),
        workflowId,
      })),
    ),
    ({ key }) => key,
  );
  const eventsOfWorkflow = grouped(
    planets.flatMap(({ scope, layout }) =>
      layout.triggers.map(({ eventId, workflowId }) => ({
        key: at(scope.id, workflowId),
        eventId,
      })),
    ),
    ({ key }) => key,
  );
  for (const { scope, layout } of planets) {
    for (const { event } of layout.events) {
      sourceOfEvent.set(at(scope.id, event.id), event.sourceId);
    }
  }
  const forwardsLeaving = grouped(forwards, (forward) => at(forward.fromScopeId, forward.eventId));
  const forwardsArriving = grouped(forwards, (forward) => at(forward.toScopeId, forward.eventId));
  return {
    sourceOf: (scopeId: string, eventId: string) => sourceOfEvent.get(at(scopeId, eventId)),
    workflowsOf: (scopeId: string, eventId: string) =>
      (workflowsOfEvent.get(at(scopeId, eventId)) ?? []).map(({ workflowId }) => workflowId),
    eventsOf: (scopeId: string, workflowId: string) =>
      (eventsOfWorkflow.get(at(scopeId, workflowId)) ?? []).map(({ eventId }) => eventId),
    forwardsLeaving: (scopeId: string, eventId: string) =>
      forwardsLeaving.get(at(scopeId, eventId)) ?? [],
    forwardsArriving: (scopeId: string, eventId: string) =>
      forwardsArriving.get(at(scopeId, eventId)) ?? [],
    forwardsFrom: grouped(forwards, (forward) => forward.fromScopeId),
    callsFrom: grouped(calls, (call) => call.scopeId),
    callsTo: grouped(calls, (call) => call.externalId),
  };
}

type UniverseIndex = ReturnType<typeof universeIndex>;

function grouped<T>(items: readonly T[], keyOf: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const key = keyOf(item);
    const group = groups.get(key);
    if (group) {
      group.push(item);
    } else {
      groups.set(key, [item]);
    }
  }
  return groups;
}

/** Lights an event with its source and, when `withWorkflows`, the workflows it starts. */
function lightEvent(
  lit: Set<string>,
  index: UniverseIndex,
  scopeId: string,
  eventId: string,
  withWorkflows: boolean,
) {
  lit.add(universeItemKey({ scopeId, item: { kind: "event", id: eventId } }));
  const sourceId = index.sourceOf(scopeId, eventId);
  if (sourceId !== undefined) {
    lit.add(universeItemKey({ scopeId, item: { kind: "source", id: sourceId } }));
  }
  if (withWorkflows) {
    for (const workflowId of index.workflowsOf(scopeId, eventId)) {
      lit.add(universeItemKey({ scopeId, item: { kind: "target", id: workflowId } }));
    }
  }
}

/**
 * What a scope sends elsewhere, as item, forward, call and external keys: its forwards, everything
 * the forwarded events reach and start in the scopes they land in, and the outside systems the
 * scope's own workflows call. What reached workflows call is left out, so only the scope's own
 * calls show. The scope's own items are left out too; whoever shows them decides how.
 */
function outgoingItems(index: UniverseIndex, scopeId: string): Set<string> {
  const lit = new Set<string>();
  const reached = new Set<string>();
  function leave(scope: string, eventId: string) {
    for (const forward of index.forwardsLeaving(scope, eventId)) {
      lit.add(forwardKey(forward));
      const key = `${forward.toScopeId}|${eventId}`;
      if (!reached.has(key)) {
        reached.add(key);
        lightEvent(lit, index, forward.toScopeId, eventId, true);
        leave(forward.toScopeId, eventId);
      }
    }
  }
  for (const forward of index.forwardsFrom.get(scopeId) ?? []) {
    leave(scopeId, forward.eventId);
  }
  for (const call of index.callsFrom.get(scopeId) ?? []) {
    lit.add(callKey(call));
    lit.add(externalKey(call.externalId));
  }
  return lit;
}

/**
 * What ends up calling an outside system, as item, forward, call and external keys: the calls,
 * the workflows making them, the events that start those workflows with their sources, and the
 * forwards that carry those events in from other scopes, back to where they first arrive.
 */
function callingItems(index: UniverseIndex, externalId: string): Set<string> {
  const lit = new Set<string>([externalKey(externalId)]);
  const reached = new Set<string>();
  function trace(scope: string, eventId: string) {
    const key = `${scope}|${eventId}`;
    if (reached.has(key)) {
      return;
    }
    reached.add(key);
    lightEvent(lit, index, scope, eventId, false);
    for (const forward of index.forwardsArriving(scope, eventId)) {
      lit.add(forwardKey(forward));
      trace(forward.fromScopeId, eventId);
    }
  }
  for (const call of index.callsTo.get(externalId) ?? []) {
    lit.add(callKey(call));
    lit.add(
      universeItemKey({ scopeId: call.scopeId, item: { kind: "target", id: call.workflowId } }),
    );
    for (const eventId of index.eventsOf(call.scopeId, call.workflowId)) {
      trace(call.scopeId, eventId);
    }
  }
  return lit;
}

/** What lights up when each planet or outside system is focused, worked out once for all. */
export type UniverseHighlights = {
  scopes: ReadonlyMap<string, ReadonlySet<string>>;
  externals: ReadonlyMap<string, ReadonlySet<string>>;
};

export function universeHighlights(
  planets: readonly UniversePlanet[],
  forwards: readonly UniverseForward[],
  externals: readonly OrchestrationExternal[],
  calls: readonly UniverseCall[],
): UniverseHighlights {
  const index = universeIndex(planets, forwards, calls);
  return {
    scopes: new Map(planets.map(({ scope }) => [scope.id, outgoingItems(index, scope.id)])),
    externals: new Map(externals.map(({ id }) => [id, callingItems(index, id)])),
  };
}
