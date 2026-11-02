import {
  routedEventIds,
  routesByEventId,
  targetPull,
  type OrchestrationEvent,
  type OrchestrationGraph,
  type OrchestrationGraphMode,
  type OrchestrationRoute,
  type OrchestrationSource,
  type OrchestrationTarget,
} from "./orchestration-graph-model";

/**
 * Angles are radians, clockwise from 12 o'clock. Radii belong to the renderer, so the layout only
 * decides who gets which part of the circle. `presence` is 1 for a settled layout and fades items
 * in while a transition is running.
 */
export type RadialArc = { id: string; startAngle: number; endAngle: number; presence: number };
export type RadialPoint = { id: string; angle: number; presence: number };

export type OrchestrationRadialLayout = {
  sources: readonly (RadialArc & { source: OrchestrationSource })[];
  events: readonly (RadialArc & { event: OrchestrationEvent })[];
  routes: readonly (RadialPoint & { route: OrchestrationRoute })[];
  targets: readonly (RadialPoint & { target: OrchestrationTarget })[];
  hidden: (RadialArc & { sourceCount: number; eventCount: number }) | null;
};

const TAU = Math.PI * 2;
const SOURCE_GAP = 0.035;
// Unrouted events stay visible in the catalog without crowding out the events that do something.
const UNROUTED_EVENT_WEIGHT = 0.45;
const HIDDEN_WEDGE_WEIGHT = 0.9;
const FOCUSED_SOURCE_SCALE = 2.4;
const TARGET_MIN_GAP = 0.22;

export const HIDDEN_WEDGE_ID = "hidden";

function normalizeAngle(angle: number): number {
  const wrapped = angle % TAU;
  return wrapped < 0 ? wrapped + TAU : wrapped;
}

function circularMean(samples: readonly { angle: number; weight: number }[]): number {
  let x = 0;
  let y = 0;
  for (const { angle, weight } of samples) {
    x += Math.sin(angle) * weight;
    y += Math.cos(angle) * weight;
  }
  return normalizeAngle(Math.atan2(x, y));
}

/** Pushes neighbours apart around the ring until every pair is at least `gap` apart. */
function spreadAround(angles: readonly number[], gap: number): number[] {
  if (angles.length < 2) {
    return [...angles];
  }
  const minGap = Math.min(gap, TAU / angles.length);
  const order = angles.map((angle, index) => ({ angle: normalizeAngle(angle), index }));
  order.sort((left, right) => left.angle - right.angle);
  for (let iteration = 0; iteration < 60; iteration += 1) {
    let moved = false;
    for (let position = 0; position < order.length; position += 1) {
      const current = order[position];
      const next = order[(position + 1) % order.length];
      const distance = normalizeAngle(next.angle - current.angle);
      if (distance < minGap - 1e-6) {
        const push = (minGap - distance) / 2;
        current.angle -= push;
        next.angle += push;
        moved = true;
      }
    }
    if (!moved) {
      break;
    }
  }
  const spread: number[] = [];
  for (const { angle, index } of order) {
    spread[index] = normalizeAngle(angle);
  }
  return spread;
}

export function layoutOrchestrationGraph(
  graph: OrchestrationGraph,
  { mode, focusSourceId }: { mode: OrchestrationGraphMode; focusSourceId: string | null },
): OrchestrationRadialLayout {
  const eventRoutes = routesByEventId(graph.routes);
  const routedEvents = routedEventIds(graph.routes);
  const isVisible = (event: OrchestrationEvent) => mode === "catalog" || routedEvents.has(event.id);
  const eventWeight = (event: OrchestrationEvent) =>
    eventRoutes.get(event.id)?.length ?? UNROUTED_EVENT_WEIGHT;
  const routeCountOf = (event: OrchestrationEvent) => eventRoutes.get(event.id)?.length ?? 0;

  const sections = graph.sources
    .map((source) => {
      const events = graph.events
        .filter((event) => event.sourceId === source.id && isVisible(event))
        .sort(
          (left, right) =>
            routeCountOf(right) - routeCountOf(left) ||
            left.eventType.localeCompare(right.eventType),
        );
      const scale = source.id === focusSourceId ? FOCUSED_SOURCE_SCALE : 1;
      return {
        source,
        events,
        scale,
        routeCount: events.reduce((count, event) => count + routeCountOf(event), 0),
        weight: events.reduce((weight, event) => weight + eventWeight(event), 0) * scale,
      };
    })
    .filter((section) => section.events.length > 0)
    .sort(
      (left, right) =>
        right.routeCount - left.routeCount || left.source.label.localeCompare(right.source.label),
    );

  const hiddenSourceCount = graph.sources.length - sections.length;
  const hiddenEventCount =
    graph.events.length - sections.reduce((count, section) => count + section.events.length, 0);
  const hasHiddenWedge = mode === "routes" && hiddenEventCount > 0;
  const totalWeight =
    sections.reduce((weight, section) => weight + section.weight, 0) +
    (hasHiddenWedge ? HIDDEN_WEDGE_WEIGHT : 0);
  const gapCount = sections.length + (hasHiddenWedge ? 1 : 0);
  const unit = totalWeight === 0 ? 0 : (TAU - gapCount * SOURCE_GAP) / totalWeight;

  const sources: (RadialArc & { source: OrchestrationSource })[] = [];
  const events: (RadialArc & { event: OrchestrationEvent })[] = [];
  const routes: (RadialPoint & { route: OrchestrationRoute })[] = [];
  let cursor = 0;
  for (const section of sections) {
    const sourceStart = cursor;
    for (const event of section.events) {
      const span = eventWeight(event) * section.scale * unit;
      events.push({
        id: event.id,
        startAngle: cursor,
        endAngle: cursor + span,
        presence: 1,
        event,
      });
      const ordered = eventRoutes.get(event.id) ?? [];
      ordered.forEach((route, index) => {
        routes.push({
          id: route.id,
          angle: cursor + ((index + 0.5) * span) / ordered.length,
          presence: 1,
          route,
        });
      });
      cursor += span;
    }
    sources.push({
      id: section.source.id,
      startAngle: sourceStart,
      endAngle: cursor,
      presence: 1,
      source: section.source,
    });
    cursor += SOURCE_GAP;
  }
  const hidden = hasHiddenWedge
    ? {
        id: HIDDEN_WEDGE_ID,
        startAngle: cursor,
        endAngle: cursor + HIDDEN_WEDGE_WEIGHT * unit,
        presence: 1,
        sourceCount: hiddenSourceCount,
        eventCount: hiddenEventCount,
      }
    : null;

  // The focused source, or else the busiest one, sits centred at 12 o'clock.
  const anchor = sources.find((arc) => arc.id === focusSourceId) ?? sources[0];
  const rotation = anchor ? -(anchor.startAngle + anchor.endAngle) / 2 : 0;
  const rotateArc = <T extends RadialArc>(arc: T): T => ({
    ...arc,
    startAngle: arc.startAngle + rotation,
    endAngle: arc.endAngle + rotation,
  });
  const rotatedRoutes = routes.map((point) => ({ ...point, angle: point.angle + rotation }));

  const pulls = new Map<string, { angle: number; weight: number }[]>();
  for (const { route, angle } of rotatedRoutes) {
    if (route.action.kind === "reclassify_event") {
      continue;
    }
    const weight = targetPull(route.action);
    pulls.set(route.action.targetId, [
      ...(pulls.get(route.action.targetId) ?? []),
      { angle, weight },
    ]);
  }
  const reachedTargets = graph.targets.filter((target) => pulls.has(target.id));
  const targetAngles = spreadAround(
    reachedTargets.map((target) => circularMean(pulls.get(target.id) ?? [])),
    TARGET_MIN_GAP,
  );

  return {
    sources: sources.map(rotateArc),
    events: events.map(rotateArc),
    routes: rotatedRoutes,
    targets: reachedTargets.map((target, index) => ({
      id: target.id,
      angle: targetAngles[index],
      presence: 1,
      target,
    })),
    hidden: hidden ? rotateArc(hidden) : null,
  };
}

function shortestDelta(from: number, to: number): number {
  const delta = normalizeAngle(to - from);
  return delta > Math.PI ? delta - TAU : delta;
}

function interpolateArc<T extends RadialArc>(from: RadialArc | undefined, to: T, t: number): T {
  if (!from) {
    return { ...to, presence: t };
  }
  const startAngle = from.startAngle + shortestDelta(from.startAngle, to.startAngle) * t;
  const fromSpan = from.endAngle - from.startAngle;
  const toSpan = to.endAngle - to.startAngle;
  return { ...to, startAngle, endAngle: startAngle + fromSpan + (toSpan - fromSpan) * t };
}

function interpolatePoint<T extends RadialPoint>(
  from: RadialPoint | undefined,
  to: T,
  t: number,
): T {
  if (!from) {
    return { ...to, presence: t };
  }
  return { ...to, angle: from.angle + shortestDelta(from.angle, to.angle) * t };
}

/**
 * Moves every item that exists in both layouts along the shorter way round the circle. Items that
 * only exist in `to` fade in where they will settle; items only in `from` are already gone.
 */
export function interpolateOrchestrationLayouts(
  from: OrchestrationRadialLayout,
  to: OrchestrationRadialLayout,
  t: number,
): OrchestrationRadialLayout {
  const byId = <T extends { id: string }>(items: readonly T[]) =>
    new Map(items.map((item) => [item.id, item]));
  const fromSources = byId(from.sources);
  const fromEvents = byId(from.events);
  const fromRoutes = byId(from.routes);
  const fromTargets = byId(from.targets);
  return {
    sources: to.sources.map((arc) => interpolateArc(fromSources.get(arc.id), arc, t)),
    events: to.events.map((arc) => interpolateArc(fromEvents.get(arc.id), arc, t)),
    routes: to.routes.map((point) => interpolatePoint(fromRoutes.get(point.id), point, t)),
    targets: to.targets.map((point) => interpolatePoint(fromTargets.get(point.id), point, t)),
    hidden: to.hidden ? interpolateArc(from.hidden ?? undefined, to.hidden, t) : null,
  };
}
