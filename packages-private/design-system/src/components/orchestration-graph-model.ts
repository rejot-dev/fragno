import type { IconName } from "./icon";

export type OrchestrationSource = { id: string; label: string; icon: IconName };

export type OrchestrationEvent = {
  id: string;
  sourceId: string;
  eventType: string;
  label: string;
  recentCount: number;
};

/** What a route does once its trigger matches; every kind except reclassify ends at a target. */
export type OrchestrationRouteAction =
  | { kind: "start_workflow"; targetId: string }
  | { kind: "send_workflow_event"; targetId: string; eventType: string }
  | { kind: "forward_event"; targetId: string }
  | { kind: "reclassify_event"; eventId: string };

export type OrchestrationRoute = {
  id: string;
  eventId: string;
  label: string;
  priority: number;
  enabled: boolean;
  matcher: string | null;
  action: OrchestrationRouteAction;
};

export type OrchestrationTarget = {
  id: string;
  label: string;
  kind: "workflow" | "scope";
  activeCount: number;
};

export type OrchestrationGraph = {
  scopeLabel: string;
  sources: readonly OrchestrationSource[];
  events: readonly OrchestrationEvent[];
  routes: readonly OrchestrationRoute[];
  targets: readonly OrchestrationTarget[];
};

/** `routes` shows only what is wired; `catalog` shows every event a source can produce. */
export type OrchestrationGraphMode = "routes" | "catalog";

export type OrchestrationGraphItemKind = "source" | "event" | "route" | "target";
export type OrchestrationGraphItem = { kind: OrchestrationGraphItemKind; id: string };

export function itemKey(item: OrchestrationGraphItem): string {
  return `${item.kind}:${item.id}`;
}

export function routesByEventId(routes: readonly OrchestrationRoute[]) {
  const byEvent = new Map<string, OrchestrationRoute[]>();
  for (const route of routes) {
    byEvent.set(route.eventId, [...(byEvent.get(route.eventId) ?? []), route]);
  }
  for (const eventRoutes of byEvent.values()) {
    // Lower priorities are evaluated first, so they come first clockwise.
    eventRoutes.sort(
      (left, right) => left.priority - right.priority || left.id.localeCompare(right.id),
    );
  }
  return byEvent;
}

/**
 * How strongly a route pulls its target towards itself when a layout places targets. Routes that
 * only message or forward to something pull less than the route that starts it, so a workflow sits
 * with the source that creates it and messages from elsewhere show up as long, visible edges.
 */
export function targetPull(action: OrchestrationRouteAction): number {
  return action.kind === "start_workflow" ? 1 : 0.35;
}

/**
 * Events that take part in routing: those with routes, and those a route re-emits. Unrouted events
 * only show when a view asks for the whole catalog.
 */
export function routedEventIds(routes: readonly OrchestrationRoute[]): Set<string> {
  return new Set(
    routes.flatMap((route) =>
      route.action.kind === "reclassify_event"
        ? [route.eventId, route.action.eventId]
        : [route.eventId],
    ),
  );
}

/**
 * Everything upstream and downstream of an item: what can trigger it and what it can cause. A
 * reclassified event counts as caused by the route that emits it.
 */
export function relatedOrchestrationItems(
  graph: OrchestrationGraph,
  item: OrchestrationGraphItem,
): Set<string> {
  const related = new Set<string>([itemKey(item)]);
  const eventsById = new Map(graph.events.map((event) => [event.id, event]));

  function addEvent(eventId: string) {
    related.add(itemKey({ kind: "event", id: eventId }));
    const event = eventsById.get(eventId);
    if (event) {
      related.add(itemKey({ kind: "source", id: event.sourceId }));
    }
  }
  function addRouteChain(route: OrchestrationRoute) {
    related.add(itemKey({ kind: "route", id: route.id }));
    addEvent(route.eventId);
    if (route.action.kind === "reclassify_event") {
      addEvent(route.action.eventId);
    } else {
      related.add(itemKey({ kind: "target", id: route.action.targetId }));
    }
  }
  function addDownstreamOfEvent(eventId: string) {
    addEvent(eventId);
    for (const route of graph.routes) {
      if (route.eventId === eventId) {
        addRouteChain(route);
      }
      if (route.action.kind === "reclassify_event" && route.action.eventId === eventId) {
        related.add(itemKey({ kind: "route", id: route.id }));
        addEvent(route.eventId);
      }
    }
  }

  switch (item.kind) {
    case "source":
      for (const event of graph.events) {
        if (event.sourceId === item.id) {
          addDownstreamOfEvent(event.id);
        }
      }
      break;
    case "event":
      addDownstreamOfEvent(item.id);
      break;
    case "route": {
      const route = graph.routes.find((candidate) => candidate.id === item.id);
      if (route) {
        addRouteChain(route);
      }
      break;
    }
    case "target":
      for (const route of graph.routes) {
        if (route.action.kind !== "reclassify_event" && route.action.targetId === item.id) {
          addRouteChain(route);
        }
      }
      break;
  }
  return related;
}

/** Lowercased words of a search query; an item matches when its text contains every one. */
export function searchTerms(query: string): string[] {
  return query.toLowerCase().split(/\s+/).filter(Boolean);
}

/**
 * The part of a graph a search is about: every item whose text contains all the terms, plus
 * everything upstream and downstream of it, so a match never shows without its flow. A matching
 * source keeps all its events; a matching workflow keeps only the events that reach it.
 */
export function searchOrchestrationGraph(
  graph: OrchestrationGraph,
  terms: readonly string[],
): OrchestrationGraph {
  const kept = new Set<string>();
  function consider(item: OrchestrationGraphItem, texts: readonly string[]) {
    const haystack = texts.join(" ").toLowerCase();
    if (terms.every((term) => haystack.includes(term))) {
      for (const key of relatedOrchestrationItems(graph, item)) {
        kept.add(key);
      }
    }
  }
  for (const source of graph.sources) {
    consider({ kind: "source", id: source.id }, [source.id, source.label]);
  }
  for (const event of graph.events) {
    consider({ kind: "event", id: event.id }, [
      `${event.sourceId}.${event.eventType}`,
      event.label,
    ]);
  }
  for (const route of graph.routes) {
    consider({ kind: "route", id: route.id }, [
      route.id,
      route.label,
      `p${route.priority}`,
      route.matcher ?? "",
    ]);
  }
  for (const target of graph.targets) {
    consider({ kind: "target", id: target.id }, [target.id, target.label]);
  }
  const isKept = (kind: OrchestrationGraphItemKind, id: string) => kept.has(itemKey({ kind, id }));
  return {
    scopeLabel: graph.scopeLabel,
    sources: graph.sources.filter((source) => isKept("source", source.id)),
    events: graph.events.filter((event) => isKept("event", event.id)),
    routes: graph.routes.filter((route) => isKept("route", route.id)),
    targets: graph.targets.filter((target) => isKept("target", target.id)),
  };
}
