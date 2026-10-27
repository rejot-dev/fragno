import {
  type KeyboardEvent,
  useDeferredValue,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { cn } from "../cn";
import { Icon } from "./icon";
import { Input } from "./input";
import {
  itemKey,
  ORCHESTRATION_TARGET_KIND_LABEL,
  relatedOrchestrationItems,
  searchOrchestrationGraph,
  searchTerms,
  type OrchestrationGraph,
  type OrchestrationGraphItem,
  type OrchestrationRoute,
} from "./orchestration-graph-model";
import {
  ACTION_EDGE_DASH,
  ROUTE_EDGE_CLASS_NAME,
  RouteMarkerDefs,
  routeMarkerUrl,
  DISABLED_EDGE_DASH,
  OrchestrationPulseAnimation,
  routeActionLabel,
  TARGET_KIND_PRESENTATION,
  type OrchestrationPulse,
} from "./orchestration-graph-parts";
import {
  layoutLayeredOrchestration,
  type LayeredEventRow,
  type LayeredUnroutedEvents,
} from "./orchestration-layered-graph-model";

const SOURCE_WIDTH = 168;
const SOURCE_EVENT_GAP = 6;
const EVENT_WIDTH = 236;
const TARGET_WIDTH = 236;
const MIN_ROUTE_LANE = 150;
const MAX_ROUTE_LANE = 300;
const MIN_CURVE_RUN = 90;
// On wide screens workflows stay near their routes instead of drifting to the far edge.
const MAX_CURVE_RUN = 240;
const MIN_WIDTH =
  SOURCE_WIDTH + SOURCE_EVENT_GAP + EVENT_WIDTH + MIN_ROUTE_LANE + MIN_CURVE_RUN + TARGET_WIDTH;
const INITIAL_WIDTH = 1040;
const DIMMED_OPACITY = 0.18;
const RECLASSIFY_LOOP = 64;
const HEADER_HEIGHT = 34;
const FOLD_ROW_HEIGHT = 30;
const STICKY_HEADER_HEIGHT = HEADER_HEIGHT - 8;
const FOLD_ROW_CLASS_NAME =
  "flex items-center gap-1.5 rounded-[4px] border border-dashed border-[var(--bo-border-strong)] px-2.5 text-xs text-[var(--bo-muted-2)] transition-colors hover:bg-[var(--bo-panel)] hover:text-[var(--bo-fg)] focus-visible:ring-2 focus-visible:ring-[color:var(--bo-fg)]/25 focus-visible:outline-none";

function countLabel(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/**
 * Horizontal geometry for a given container width. Only the route lane and the curves stretch,
 * and both stop growing, so on wide screens the graph keeps its shape and leaves space on the right.
 */
function columnsFor(width: number) {
  const eventLeft = SOURCE_WIDTH + SOURCE_EVENT_GAP;
  const eventRight = eventLeft + EVENT_WIDTH;
  const routeLane = Math.max(
    MIN_ROUTE_LANE,
    Math.min(MAX_ROUTE_LANE, width * 0.22, width - TARGET_WIDTH - MIN_CURVE_RUN - eventRight),
  );
  const laneEnd = eventRight + routeLane;
  const targetLeft = Math.min(width - TARGET_WIDTH, laneEnd + MAX_CURVE_RUN);
  return { eventLeft, eventRight, laneEnd, targetLeft };
}

function useContainerWidth() {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(INITIAL_WIDTH);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) {
      return undefined;
    }
    const observer = new ResizeObserver(([entry]) => {
      setWidth(Math.max(MIN_WIDTH, entry.contentRect.width));
    });
    observer.observe(element);
    return () => {
      observer.disconnect();
    };
  }, []);
  return { ref, width };
}

/** Marks every stretch of `text` that a search term matched. */
function Highlighted({ text, terms }: { text: string; terms: readonly string[] }) {
  const lower = text.toLowerCase();
  const marked = Array.from({ length: text.length }, () => false);
  for (const term of terms) {
    for (let at = lower.indexOf(term); at !== -1; at = lower.indexOf(term, at + 1)) {
      marked.fill(true, at, at + term.length);
    }
  }
  const segments: { text: string; marked: boolean }[] = [];
  for (let index = 0; index < text.length; index += 1) {
    const last = segments.at(-1);
    if (last && last.marked === marked[index]) {
      last.text += text[index];
    } else {
      segments.push({ text: text[index], marked: marked[index] });
    }
  }
  return segments.map((segment, index) =>
    segment.marked ? (
      <mark key={index} className="rounded-[2px] bg-amber-300/50 text-inherit dark:bg-amber-300/30">
        {segment.text}
      </mark>
    ) : (
      segment.text
    ),
  );
}

function ColumnHeader({ left, width, title }: { left: number; width: number; title: string }) {
  return (
    <p
      className="absolute top-2 truncate text-[10px] font-semibold tracking-[0.22em] text-[var(--bo-muted-2)] uppercase"
      style={{ left, width }}
    >
      {title}
    </p>
  );
}

/**
 * Sources, their events, and the workflows they reach, read left to right. Each route is an edge
 * labelled with its priority and name; workflows appear once, however many routes reach them, so
 * flows that meet across sources are visible. Hovering or selecting anything lights up everything
 * upstream and downstream of it, and a search narrows the graph to the flows it matches.
 *
 * Fills its container's height and scrolls inside it under sticky column headers, so give it a
 * bounded parent when it shares the page.
 */
export function OrchestrationLayeredGraph({
  graph,
  selected,
  onSelect,
  pulses,
}: {
  graph: OrchestrationGraph;
  selected: OrchestrationGraphItem | null;
  onSelect: (item: OrchestrationGraphItem | null) => void;
  pulses: readonly OrchestrationPulse[];
}) {
  const markerIdPrefix = useId();
  const { ref, width } = useContainerWidth();
  const [hovered, setHovered] = useState<OrchestrationGraphItem | null>(null);
  const [query, setQuery] = useState("");
  const [showUnrouted, setShowUnrouted] = useState(false);
  const [expandedSourceIds, setExpandedSourceIds] = useState<ReadonlySet<string>>(new Set());
  // Laying out a large scope on every keystroke would make typing lag behind.
  const deferredQuery = useDeferredValue(query);
  const terms = useMemo(() => searchTerms(deferredQuery), [deferredQuery]);
  const shownGraph = useMemo(
    () => (terms.length > 0 ? searchOrchestrationGraph(graph, terms) : graph),
    [graph, terms],
  );
  // Search results show every match in place; folding them away again would hide what was found.
  const unrouted: LayeredUnroutedEvents =
    terms.length > 0 ? "inline" : showUnrouted ? "expanded" : "folded";
  const layout = useMemo(
    () => layoutLayeredOrchestration(shownGraph, { unrouted, expandedSourceIds }),
    [shownGraph, unrouted, expandedSourceIds],
  );
  // Counted on the whole graph: a source card states what the source has, not what matched.
  const sourceTotals = useMemo(() => {
    const totals = new Map(graph.sources.map((source) => [source.id, { events: 0, routes: 0 }]));
    const eventSourceIds = new Map(graph.events.map((event) => [event.id, event.sourceId]));
    for (const event of graph.events) {
      const total = totals.get(event.sourceId);
      if (total) {
        total.events += 1;
      }
    }
    for (const route of graph.routes) {
      const total = totals.get(eventSourceIds.get(route.eventId) ?? "");
      if (total) {
        total.routes += 1;
      }
    }
    return totals;
  }, [graph]);
  const { eventLeft, eventRight, laneEnd, targetLeft } = columnsFor(width);

  const active = hovered ?? selected;
  const related = useMemo(
    () => (active ? relatedOrchestrationItems(graph, active) : null),
    [graph, active],
  );
  const opacityOf = (item: OrchestrationGraphItem) =>
    related === null || related.has(itemKey(item)) ? 1 : DIMMED_OPACITY;
  const isSelected = (item: OrchestrationGraphItem) =>
    selected !== null && selected.kind === item.kind && selected.id === item.id;

  const eventRows = new Map<string, LayeredEventRow>();
  for (const block of layout.sources) {
    for (const row of block.rows) {
      if (row.kind === "event") {
        eventRows.set(row.event.id, row);
      }
    }
  }
  const lanes = [...eventRows.values()].flatMap((row) => row.lanes);
  const laneYByRoute = new Map(lanes.map((lane) => [lane.route.id, lane.y]));

  // Incoming edges spread over the target's height in the order they arrive, so they never cross
  // on the last stretch.
  const portYByRoute = new Map<string, number>();
  for (const node of layout.targets) {
    const incoming = lanes
      .filter(
        ({ route }) =>
          route.action.kind !== "reclassify_event" && route.action.targetId === node.target.id,
      )
      .sort((left, right) => left.y - right.y);
    incoming.forEach(({ route }, index) => {
      portYByRoute.set(route.id, node.top + ((index + 1) * node.height) / (incoming.length + 1));
    });
  }

  function onwardPath(route: OrchestrationRoute, y: number): string | null {
    if (route.action.kind === "reclassify_event") {
      const emitted = eventRows.get(route.action.eventId);
      if (!emitted) {
        return null;
      }
      // Route labels sit above their lanes, so the loop comes in under the emitted event's lanes.
      const arrival = emitted.top + emitted.height - 7;
      return `M ${laneEnd} ${y} C ${laneEnd + RECLASSIFY_LOOP} ${y} ${eventRight + RECLASSIFY_LOOP} ${arrival} ${eventRight + 4} ${arrival}`;
    }
    const portY = portYByRoute.get(route.id);
    if (portY === undefined) {
      return null;
    }
    const run = (targetLeft - laneEnd) / 2;
    return `M ${laneEnd} ${y} C ${laneEnd + run} ${y} ${targetLeft - run} ${portY} ${targetLeft - 5} ${portY}`;
  }

  function interactions(item: OrchestrationGraphItem) {
    const toggle = () => {
      onSelect(isSelected(item) ? null : item);
    };
    return {
      "aria-pressed": isSelected(item),
      onMouseEnter: () => {
        setHovered(item);
      },
      onMouseLeave: () => {
        setHovered(null);
      },
      onFocus: () => {
        setHovered(item);
      },
      onBlur: () => {
        setHovered(null);
      },
      onClick: (event: { stopPropagation: () => void }) => {
        event.stopPropagation();
        toggle();
      },
      onKeyDown: (event: KeyboardEvent) => {
        if (event.key === "Escape") {
          onSelect(null);
        }
      },
    };
  }

  function toggleExpanded(sourceId: string) {
    setExpandedSourceIds((current) => {
      const next = new Set(current);
      if (!next.delete(sourceId)) {
        next.add(sourceId);
      }
      return next;
    });
  }

  const fold = layout.unroutedFold;
  const totalHeight = HEADER_HEIGHT + layout.height + 16;

  return (
    <div className="flex h-full min-h-0 w-full flex-col gap-3">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <label className="relative w-full max-w-[340px]">
          <span className="sr-only">Search sources, events, routes, and workflows</span>
          <Icon
            name="search"
            className="pointer-events-none absolute top-1/2 left-2.5 h-3.5 w-3.5 -translate-y-1/2 text-[var(--bo-muted-2)]"
          />
          <Input
            type="search"
            value={query}
            placeholder="Search sources, events, routes, workflows"
            className="min-h-9 w-full py-1.5 pr-8 pl-8 text-[13px] [&::-webkit-search-cancel-button]:appearance-none"
            onChange={(event) => {
              setQuery(event.target.value);
            }}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                setQuery("");
              }
            }}
          />
          {query ? (
            <button
              type="button"
              aria-label="Clear search"
              onClick={() => {
                setQuery("");
              }}
              className="absolute top-1/2 right-1.5 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-[3px] text-[var(--bo-muted-2)] hover:bg-[var(--bo-panel)] hover:text-[var(--bo-fg)]"
            >
              <Icon name="x" className="h-3.5 w-3.5" />
            </button>
          ) : null}
        </label>
        {terms.length > 0 ? (
          <p className="text-xs text-[var(--bo-muted)] tabular-nums" aria-live="polite">
            {shownGraph.routes.length} of {countLabel(graph.routes.length, "route")} ·{" "}
            {shownGraph.events.length} of {countLabel(graph.events.length, "event")} ·{" "}
            {shownGraph.targets.length} of {countLabel(graph.targets.length, "target")}
          </p>
        ) : null}
      </div>

      <div className="min-h-0 flex-1 overflow-auto bg-[var(--bo-bg)]">
        {layout.sources.length === 0 ? (
          <div className="flex h-full min-h-32 flex-col items-center justify-center gap-2 text-sm text-[var(--bo-muted)]">
            {terms.length > 0 ? (
              <>
                <p>Nothing matches “{deferredQuery.trim()}”.</p>
                <button
                  type="button"
                  onClick={() => {
                    setQuery("");
                  }}
                  className="text-xs font-semibold text-[var(--bo-accent-strong)] hover:underline"
                >
                  Clear search
                </button>
              </>
            ) : (
              <p>Nothing is routed yet.</p>
            )}
          </div>
        ) : null}
        <div
          ref={ref}
          role="group"
          aria-label={`Automation orchestration for ${graph.scopeLabel}`}
          className={cn("relative w-full select-none", layout.sources.length === 0 && "hidden")}
          style={{ minWidth: MIN_WIDTH, height: totalHeight }}
          onClick={() => {
            onSelect(null);
          }}
        >
          {/* In flow so it can stick; everything below is placed absolutely underneath it. */}
          <div
            className="sticky top-0 z-10 bg-[var(--bo-bg)] shadow-[inset_0_-1px_0_var(--bo-border)]"
            style={{ height: STICKY_HEADER_HEIGHT }}
          >
            <ColumnHeader left={0} width={SOURCE_WIDTH} title="Sources" />
            <ColumnHeader left={eventLeft} width={EVENT_WIDTH} title="Events" />
            <ColumnHeader left={eventRight + 12} width={laneEnd - eventRight} title="Routes" />
            <ColumnHeader left={targetLeft} width={TARGET_WIDTH} title="Workflows" />
          </div>

          <svg
            className="pointer-events-none absolute left-0"
            style={{ top: HEADER_HEIGHT }}
            width={width}
            height={layout.height + 8}
            aria-hidden="true"
          >
            <RouteMarkerDefs idPrefix={markerIdPrefix} />
            {lanes.map(({ route, y }) => {
              const onward = onwardPath(route, y);
              const dash = route.enabled ? ACTION_EDGE_DASH[route.action.kind] : DISABLED_EDGE_DASH;
              const strokeWidth = isSelected({ kind: "route", id: route.id }) ? 2.6 : 1.7;
              return (
                <g
                  key={route.id}
                  opacity={opacityOf({ kind: "route", id: route.id }) * (route.enabled ? 1 : 0.6)}
                  className="transition-opacity duration-200"
                >
                  <circle cx={eventRight} cy={y} r={3} className="fill-[var(--bo-fg)]" />
                  <line
                    x1={eventRight}
                    y1={y}
                    x2={laneEnd}
                    y2={y}
                    className={ROUTE_EDGE_CLASS_NAME}
                    strokeWidth={strokeWidth}
                    strokeDasharray={dash}
                  />
                  {onward ? (
                    <path
                      d={onward}
                      className={cn("fill-none", ROUTE_EDGE_CLASS_NAME)}
                      strokeWidth={strokeWidth}
                      strokeDasharray={dash}
                      markerEnd={routeMarkerUrl(markerIdPrefix)}
                    />
                  ) : null}
                </g>
              );
            })}
            {pulses.map((pulse) => {
              const row = eventRows.get(pulse.eventId);
              if (!row) {
                return null;
              }
              const rowCentre = row.top + row.height / 2;
              const paths = pulse.routeIds.flatMap((routeId) => {
                const y = laneYByRoute.get(routeId);
                const lane = row.lanes.find((candidate) => candidate.route.id === routeId);
                if (y === undefined || !lane) {
                  return [];
                }
                const onward = onwardPath(lane.route, y);
                const inbound = `M ${eventLeft + EVENT_WIDTH / 2} ${rowCentre} L ${eventRight} ${y} L ${laneEnd} ${y}`;
                // The onward edge starts where the lane ends, so its move becomes a line.
                return [onward ? `${inbound} ${onward.replace(/^M /, "L ")}` : inbound];
              });
              return (
                <OrchestrationPulseAnimation
                  key={pulse.id}
                  flashPath={`M ${eventLeft} ${row.top} h ${EVENT_WIDTH} v ${row.height} h ${-EVENT_WIDTH} Z`}
                  paths={paths}
                />
              );
            })}
          </svg>

          <div className="absolute inset-x-0" style={{ top: HEADER_HEIGHT }}>
            {layout.sources.map((block) => {
              const sourceItem = { kind: "source", id: block.source.id } as const;
              return (
                <div key={block.source.id}>
                  <button
                    type="button"
                    {...interactions(sourceItem)}
                    aria-label={`${block.source.label} source`}
                    className={cn(
                      "absolute flex flex-col items-start rounded-[4px] bg-[color-mix(in_srgb,var(--bo-fg)_7%,transparent)] p-2.5 text-left transition-[opacity,background-color] duration-200 hover:bg-[color-mix(in_srgb,var(--bo-fg)_11%,transparent)] focus-visible:ring-2 focus-visible:ring-[color:var(--bo-fg)]/25 focus-visible:outline-none",
                      isSelected(sourceItem) && "ring-2 ring-[color:var(--bo-fg)]/25",
                    )}
                    style={{
                      left: 0,
                      top: block.top,
                      width: SOURCE_WIDTH,
                      height: block.height,
                      opacity: opacityOf(sourceItem),
                    }}
                  >
                    {/* Sticks under the column headers while a tall source's events scroll by. */}
                    <span
                      className="sticky flex max-w-full min-w-0 flex-col gap-1"
                      style={{ top: STICKY_HEADER_HEIGHT + 10 }}
                    >
                      <span className="flex min-w-0 items-center gap-2">
                        <Icon
                          name={block.source.icon}
                          className="h-3.5 w-3.5 shrink-0 text-[var(--bo-muted)]"
                          strokeWidth={1.8}
                        />
                        <span className="truncate text-sm font-semibold text-[var(--bo-fg)]">
                          <Highlighted text={block.source.label} terms={terms} />
                        </span>
                      </span>
                      <span className="text-[11px] text-[var(--bo-muted-2)] tabular-nums">
                        {countLabel(sourceTotals.get(block.source.id)?.events ?? 0, "event")} ·{" "}
                        {countLabel(sourceTotals.get(block.source.id)?.routes ?? 0, "route")}
                      </span>
                    </span>
                  </button>

                  {block.rows.map((row) => {
                    if (row.kind === "fold") {
                      return (
                        <button
                          key={`fold:${row.sourceId}`}
                          type="button"
                          aria-expanded={row.expanded}
                          onClick={(event) => {
                            event.stopPropagation();
                            toggleExpanded(row.sourceId);
                          }}
                          className={cn("absolute", FOLD_ROW_CLASS_NAME)}
                          style={{
                            left: eventLeft,
                            top: row.top,
                            width: EVENT_WIDTH,
                            height: row.height,
                            opacity: related === null ? 1 : DIMMED_OPACITY,
                          }}
                        >
                          <Icon
                            name={row.expanded ? "chevron-up" : "chevron-down"}
                            className="h-3 w-3"
                          />
                          {row.expanded
                            ? `Hide ${countLabel(row.unroutedCount, "unrouted event")}`
                            : countLabel(row.unroutedCount, "unrouted event")}
                        </button>
                      );
                    }
                    const eventItem = { kind: "event", id: row.event.id } as const;
                    return (
                      <button
                        key={row.event.id}
                        type="button"
                        {...interactions(eventItem)}
                        aria-label={`${row.event.sourceId}.${row.event.eventType} event`}
                        title={row.event.label}
                        className={cn(
                          "absolute flex min-w-0 flex-col justify-center rounded-[4px] border px-2.5 text-left transition-[opacity,background-color] duration-200 focus-visible:ring-2 focus-visible:ring-[color:var(--bo-fg)]/25 focus-visible:outline-none",
                          row.routed
                            ? "border-transparent bg-[color-mix(in_srgb,var(--bo-fg)_7%,transparent)] hover:bg-[color-mix(in_srgb,var(--bo-fg)_11%,transparent)]"
                            : "border-[var(--bo-border)] bg-[var(--bo-panel)] hover:bg-[color-mix(in_srgb,var(--bo-fg)_11%,transparent)]",
                          isSelected(eventItem) && "ring-2 ring-[color:var(--bo-fg)]/25",
                        )}
                        style={{
                          left: eventLeft,
                          top: row.top,
                          width: EVENT_WIDTH,
                          height: row.height,
                          opacity: opacityOf(eventItem),
                        }}
                      >
                        <span className="flex min-w-0 items-center gap-2">
                          <span
                            className={cn(
                              "min-w-0 flex-1 truncate font-mono text-[12px]",
                              row.routed
                                ? "font-semibold text-[var(--bo-fg)]"
                                : "text-[var(--bo-muted)]",
                            )}
                          >
                            <Highlighted text={row.event.eventType} terms={terms} />
                          </span>
                          {row.event.recentCount > 0 ? (
                            <span className="flex shrink-0 items-center gap-1 text-[10px] text-[var(--bo-fg)] tabular-nums">
                              <span className="h-1.5 w-1.5 rounded-full bg-[var(--bo-fg)]" />
                              {row.event.recentCount} recent
                            </span>
                          ) : null}
                        </span>
                        {row.routed ? (
                          <span className="truncate text-[11px] text-[var(--bo-muted)]">
                            <Highlighted text={row.event.label} terms={terms} />
                          </span>
                        ) : null}
                      </button>
                    );
                  })}
                </div>
              );
            })}

            {lanes.map(({ route, y }) => {
              const routeItem = { kind: "route", id: route.id } as const;
              return (
                <button
                  key={route.id}
                  type="button"
                  {...interactions(routeItem)}
                  aria-label={`${route.label} route, priority ${route.priority}, ${routeActionLabel(route.action)}`}
                  title={route.matcher ? `${route.label} · ${route.matcher}` : route.label}
                  className={cn(
                    "absolute flex items-center gap-1.5 rounded-[3px] px-1 text-left text-[11.5px] leading-none transition-opacity duration-200 focus-visible:ring-2 focus-visible:ring-[color:var(--bo-fg)]/25 focus-visible:outline-none",
                    route.enabled ? "text-[var(--bo-fg)]" : "text-[var(--bo-muted-2)]",
                    isSelected(routeItem) && "bg-[color-mix(in_srgb,var(--bo-fg)_7%,transparent)]",
                  )}
                  style={{
                    left: eventRight + 8,
                    top: y - 19,
                    maxWidth: laneEnd - eventRight - 16,
                    height: 16,
                    opacity: opacityOf(routeItem),
                  }}
                >
                  <span className="shrink-0 text-[9.5px] font-semibold tracking-[0.12em] text-[var(--bo-fg)]">
                    P{route.priority}
                  </span>
                  <span className={cn("truncate", !route.enabled && "line-through")}>
                    <Highlighted text={route.label} terms={terms} />
                  </span>
                  {route.matcher ? (
                    <Icon
                      name="filter"
                      className="h-3 w-3 shrink-0 text-[var(--bo-muted-2)]"
                      strokeWidth={2}
                    />
                  ) : null}
                </button>
              );
            })}

            {layout.targets.map((node) => {
              const targetItem = { kind: "target", id: node.target.id } as const;
              const presentation = TARGET_KIND_PRESENTATION[node.target.kind];
              return (
                <button
                  key={node.target.id}
                  type="button"
                  {...interactions(targetItem)}
                  aria-label={`${node.target.label} ${node.target.kind}`}
                  className={cn(
                    "absolute flex items-center gap-2.5 rounded-[4px] border border-[var(--bo-border)] bg-[var(--bo-panel)] px-2.5 text-left shadow-[0_1px_2px_rgb(0_0_0/0.04)] transition-[opacity,box-shadow] duration-200 hover:shadow-[0_4px_14px_rgb(0_0_0/0.06)] focus-visible:ring-2 focus-visible:ring-[color:var(--bo-fg)]/25 focus-visible:outline-none",
                    isSelected(targetItem) && presentation.ringClassName,
                  )}
                  style={{
                    left: targetLeft,
                    top: node.top,
                    width: TARGET_WIDTH,
                    height: node.height,
                    opacity: opacityOf(targetItem),
                  }}
                >
                  <span
                    className={cn(
                      "flex h-7 w-7 shrink-0 items-center justify-center rounded-[3px]",
                      presentation.badgeClassName,
                    )}
                  >
                    <Icon name={presentation.icon} className="h-3.5 w-3.5" strokeWidth={1.8} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-semibold text-[var(--bo-fg)]">
                      <Highlighted text={node.target.label} terms={terms} />
                    </span>
                    <span
                      className={cn(
                        "block truncate text-[11px] tabular-nums",
                        node.target.activeCount > 0
                          ? "text-[var(--bo-fg)]"
                          : "text-[var(--bo-muted-2)]",
                      )}
                    >
                      {node.target.activeCount > 0
                        ? `${node.target.activeCount} running`
                        : ORCHESTRATION_TARGET_KIND_LABEL[node.target.kind]}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      </div>
      {/* Outside the scrolling graph, so it stays in view however long the graph gets. */}
      {fold ? (
        <button
          type="button"
          aria-expanded={fold.expanded}
          title={
            !fold.expanded && fold.hiddenSources.length > 0
              ? `Without routes: ${fold.hiddenSources.map((source) => source.label).join(", ")}`
              : undefined
          }
          onClick={() => {
            setShowUnrouted((current) => !current);
          }}
          className={cn(FOLD_ROW_CLASS_NAME, "max-w-full shrink-0")}
          style={{
            width: eventRight,
            minHeight: FOLD_ROW_HEIGHT,
            opacity: related === null ? 1 : DIMMED_OPACITY,
          }}
        >
          <Icon name={fold.expanded ? "chevron-up" : "chevron-down"} className="h-3 w-3" />
          {fold.expanded
            ? `Hide all ${countLabel(fold.unroutedEventCount, "unrouted event")}`
            : `All ${countLabel(fold.unroutedEventCount, "unrouted event")}`}
          {!fold.expanded && fold.hiddenSources.length > 0 ? (
            <span className="truncate opacity-75">
              · {countLabel(fold.hiddenSources.length, "source")} without routes
            </span>
          ) : null}
        </button>
      ) : null}
    </div>
  );
}
