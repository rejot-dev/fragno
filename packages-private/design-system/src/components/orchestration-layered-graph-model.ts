import {
  routedEventIds,
  routesByEventId,
  targetPull,
  type OrchestrationEvent,
  type OrchestrationGraph,
  type OrchestrationRoute,
  type OrchestrationSource,
  type OrchestrationTarget,
} from "./orchestration-graph-model";

/** Where a route leaves its event row; routes on one event stack in priority order. */
export type LayeredRouteLane = { route: OrchestrationRoute; y: number };

export type LayeredEventRow = {
  kind: "event";
  event: OrchestrationEvent;
  routed: boolean;
  top: number;
  height: number;
  lanes: readonly LayeredRouteLane[];
};

/** Stands in for a source's unrouted events, or offers to fold them away again. */
export type LayeredFoldRow = {
  kind: "fold";
  sourceId: string;
  unroutedCount: number;
  expanded: boolean;
  top: number;
  height: number;
};

export type LayeredRow = LayeredEventRow | LayeredFoldRow;

export type LayeredSourceBlock = {
  source: OrchestrationSource;
  top: number;
  height: number;
  rows: readonly LayeredRow[];
};

export type LayeredTargetNode = { target: OrchestrationTarget; top: number; height: number };

/**
 * Shows or folds every unrouted event at once, under the last source. `hiddenSources` are the
 * sources that only appear once it is expanded, because nothing listens to them.
 */
export type LayeredUnroutedFold = {
  expanded: boolean;
  unroutedEventCount: number;
  hiddenSources: readonly OrchestrationSource[];
  top: number;
  height: number;
};

/**
 * How unrouted events show. `folded` keeps to what is wired, with per-source and overall rows to
 * unfold the rest; `expanded` shows everything with a row to fold it again; `inline` shows
 * everything without fold rows, for a graph a search has already narrowed.
 */
export type LayeredUnroutedEvents = "folded" | "expanded" | "inline";

/** Vertical positions only: columns stretch with the container, so x belongs to the renderer. */
export type OrchestrationLayeredLayout = {
  sources: readonly LayeredSourceBlock[];
  targets: readonly LayeredTargetNode[];
  unroutedFold: LayeredUnroutedFold | null;
  height: number;
};

const ROUTED_ROW_MIN_HEIGHT = 52;
const LANE_HEIGHT = 30;
const LANE_PADDING = 11;
const UNROUTED_ROW_HEIGHT = 34;
const FOLD_ROW_HEIGHT = 30;
const ROW_GAP = 6;
const SOURCE_GAP = 18;
// Room for a source's name and counts, even when it has a single compact event row.
const SOURCE_MIN_HEIGHT = 54;
const TARGET_HEIGHT = 56;
const TARGET_GAP = 14;
// Each pass moves sources, events, and targets towards what they connect to; a few are enough for
// the dozens of routes a scope has.
const ORDERING_PASSES = 4;

type Section = {
  source: OrchestrationSource;
  events: OrchestrationEvent[];
  unroutedCount: number;
  showsUnrouted: boolean;
  // Only offered while unrouted events are folded overall; showing them all leaves nothing to fold.
  foldable: boolean;
  routeCount: number;
};

function placeSections(
  sections: readonly Section[],
  eventRoutes: ReadonlyMap<string, readonly OrchestrationRoute[]>,
): { blocks: LayeredSourceBlock[]; height: number } {
  const blocks: LayeredSourceBlock[] = [];
  let cursor = 0;
  for (const section of sections) {
    const sourceTop = cursor;
    const rows: LayeredRow[] = [];
    for (const event of section.events) {
      const routes = eventRoutes.get(event.id) ?? [];
      const routed = routes.length > 0;
      const height = routed
        ? Math.max(ROUTED_ROW_MIN_HEIGHT, routes.length * LANE_HEIGHT + LANE_PADDING * 2)
        : UNROUTED_ROW_HEIGHT;
      const firstLane = cursor + height / 2 - ((routes.length - 1) * LANE_HEIGHT) / 2;
      rows.push({
        kind: "event",
        event,
        routed,
        top: cursor,
        height,
        lanes: routes.map((route, index) => ({ route, y: firstLane + index * LANE_HEIGHT })),
      });
      cursor += height + ROW_GAP;
    }
    if (section.foldable) {
      rows.push({
        kind: "fold",
        sourceId: section.source.id,
        unroutedCount: section.unroutedCount,
        expanded: section.showsUnrouted,
        top: cursor,
        height: FOLD_ROW_HEIGHT,
      });
      cursor += FOLD_ROW_HEIGHT + ROW_GAP;
    }
    const height = Math.max(SOURCE_MIN_HEIGHT, cursor - ROW_GAP - sourceTop);
    blocks.push({
      source: section.source,
      top: sourceTop,
      height,
      rows,
    });
    cursor = sourceTop + height + SOURCE_GAP;
  }
  return { blocks, height: Math.max(0, cursor - SOURCE_GAP) };
}

/** Each target asks to sit level with the routes that reach it, starters pulling hardest. */
function desiredTargetCentres(blocks: readonly LayeredSourceBlock[]): Map<string, number> {
  const sums = new Map<string, { total: number; weight: number }>();
  for (const block of blocks) {
    for (const row of block.rows) {
      if (row.kind !== "event") {
        continue;
      }
      for (const { route, y } of row.lanes) {
        if (route.action.kind === "reclassify_event") {
          continue;
        }
        const weight = targetPull(route.action);
        const sum = sums.get(route.action.targetId) ?? { total: 0, weight: 0 };
        sums.set(route.action.targetId, {
          total: sum.total + y * weight,
          weight: sum.weight + weight,
        });
      }
    }
  }
  return new Map([...sums].map(([id, { total, weight }]) => [id, total / weight]));
}

/** Stacks targets in order of where they want to be, pushing each down just enough to fit. */
function placeTargets(
  targets: readonly OrchestrationTarget[],
  desired: ReadonlyMap<string, number>,
): LayeredTargetNode[] {
  const ordered = targets
    .filter((target) => desired.has(target.id))
    .sort(
      (left, right) =>
        (desired.get(left.id) ?? 0) - (desired.get(right.id) ?? 0) ||
        left.id.localeCompare(right.id),
    );
  const nodes: LayeredTargetNode[] = [];
  let floor = 0;
  for (const target of ordered) {
    const top = Math.max(floor, (desired.get(target.id) ?? 0) - TARGET_HEIGHT / 2);
    nodes.push({ target, top, height: TARGET_HEIGHT });
    floor = top + TARGET_HEIGHT + TARGET_GAP;
  }
  return nodes;
}

function mean(values: readonly number[]): number | null {
  return values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function layoutLayeredOrchestration(
  graph: OrchestrationGraph,
  {
    unrouted,
    expandedSourceIds,
  }: { unrouted: LayeredUnroutedEvents; expandedSourceIds: ReadonlySet<string> },
): OrchestrationLayeredLayout {
  const showUnrouted = unrouted !== "folded";
  const eventRoutes = routesByEventId(graph.routes);
  const routed = routedEventIds(graph.routes);
  const routeCountOf = (event: OrchestrationEvent) => eventRoutes.get(event.id)?.length ?? 0;

  const allSections: Section[] = graph.sources.map((source) => {
    const events = graph.events.filter((event) => event.sourceId === source.id);
    const routedEvents = events.filter((event) => routed.has(event.id));
    const showsUnrouted = showUnrouted || expandedSourceIds.has(source.id);
    return {
      source,
      events: (showsUnrouted ? events : routedEvents).sort(
        (left, right) =>
          routeCountOf(right) - routeCountOf(left) || left.eventType.localeCompare(right.eventType),
      ),
      unroutedCount: events.length - routedEvents.length,
      showsUnrouted,
      foldable: !showUnrouted && events.length > routedEvents.length,
      routeCount: routedEvents.reduce((count, event) => count + routeCountOf(event), 0),
    };
  });
  const isShown = (section: Section) =>
    showUnrouted || section.events.some((event) => routed.has(event.id));
  let sections = allSections
    .filter(isShown)
    .sort(
      (left, right) =>
        right.routeCount - left.routeCount || left.source.label.localeCompare(right.source.label),
    );
  const hiddenSources = allSections
    .filter((section) => !isShown(section))
    .map((section) => section.source);

  // Barycentric ordering: targets settle level with their routes, then events and sources move
  // towards the targets they reach. Sources without routes keep their place at the end.
  for (let pass = 0; pass < ORDERING_PASSES; pass += 1) {
    const { blocks } = placeSections(sections, eventRoutes);
    const targetCentres = new Map(
      placeTargets(graph.targets, desiredTargetCentres(blocks)).map((node) => [
        node.target.id,
        node.top + node.height / 2,
      ]),
    );
    const eventCentre = (event: OrchestrationEvent) =>
      mean(
        (eventRoutes.get(event.id) ?? []).flatMap((route) =>
          route.action.kind === "reclassify_event"
            ? []
            : [targetCentres.get(route.action.targetId) ?? 0],
        ),
      );
    sections = sections.map((section) => ({
      ...section,
      events: [...section.events].sort((left, right) => {
        const leftCentre = eventCentre(left);
        const rightCentre = eventCentre(right);
        if (leftCentre === null || rightCentre === null) {
          return (
            Number(leftCentre === null) - Number(rightCentre === null) ||
            left.eventType.localeCompare(right.eventType)
          );
        }
        return leftCentre - rightCentre || left.eventType.localeCompare(right.eventType);
      }),
    }));
    const sectionCentre = (section: Section) =>
      mean(section.events.flatMap((event) => eventCentre(event) ?? []));
    sections = [...sections].sort((left, right) => {
      const leftCentre = sectionCentre(left);
      const rightCentre = sectionCentre(right);
      if (leftCentre === null || rightCentre === null) {
        return (
          Number(leftCentre === null) - Number(rightCentre === null) ||
          left.source.label.localeCompare(right.source.label)
        );
      }
      return leftCentre - rightCentre || left.source.label.localeCompare(right.source.label);
    });
  }

  const { blocks, height: sourcesHeight } = placeSections(sections, eventRoutes);
  const targets = placeTargets(graph.targets, desiredTargetCentres(blocks));
  const targetsHeight = targets.reduce(
    (bottom, node) => Math.max(bottom, node.top + node.height),
    0,
  );
  const unroutedEventCount = graph.events.filter((event) => !routed.has(event.id)).length;
  const unroutedFold =
    unrouted === "inline" || unroutedEventCount === 0
      ? null
      : {
          expanded: unrouted === "expanded",
          unroutedEventCount,
          hiddenSources,
          top: blocks.length > 0 ? sourcesHeight + SOURCE_GAP : 0,
          height: FOLD_ROW_HEIGHT,
        };
  return {
    sources: blocks,
    targets,
    unroutedFold,
    height: Math.max(
      unroutedFold ? unroutedFold.top + unroutedFold.height : sourcesHeight,
      targetsHeight,
    ),
  };
}
