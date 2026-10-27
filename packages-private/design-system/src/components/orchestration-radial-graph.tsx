import {
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";

import { cn } from "../cn";
import { Icon, type IconName } from "./icon";
import {
  itemKey,
  ORCHESTRATION_TARGET_KIND_LABEL,
  relatedOrchestrationItems,
  type OrchestrationGraph,
  type OrchestrationGraphItem,
  type OrchestrationGraphMode,
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
  HIDDEN_WEDGE_ID,
  interpolateOrchestrationLayouts,
  layoutOrchestrationGraph,
  type OrchestrationRadialLayout,
} from "./orchestration-radial-graph-model";

const SIZE = 1320;
const CENTER = SIZE / 2;
const HUB_RADIUS = 92;
const SOURCE_INNER = 104;
const SOURCE_OUTER = 162;
const EVENT_INNER = 166;
const EVENT_OUTER = 276;
const ACTIVITY_OUTER = 281;
const ROUTE_RADIUS = 340;
const ROUTE_PILL_HEIGHT = 24;
const ROUTE_PILL_MAX_WIDTH = 230;
const TARGET_RADIUS = 470;
const TARGET_NODE_RADIUS = 17;
const TARGET_LABEL_MAX_WIDTH = 160;
const TRANSITION_MS = 520;
// Rough glyph widths for the fonts used below; labels only need to avoid overflowing their slot.
const MONO_CHAR_WIDTH = 6.7;
const SANS_CHAR_WIDTH = 6.9;

function polar(angle: number, radius: number): [number, number] {
  return [CENTER + radius * Math.sin(angle), CENTER - radius * Math.cos(angle)];
}

function point(angle: number, radius: number): string {
  const [x, y] = polar(angle, radius);
  return `${x.toFixed(2)} ${y.toFixed(2)}`;
}

function degrees(angle: number): number {
  return (angle * 180) / Math.PI;
}

function isLowerHalf(angle: number): boolean {
  const normalized = ((angle % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
  return normalized > Math.PI / 2 && normalized < (Math.PI * 3) / 2;
}

function isLeftHalf(angle: number): boolean {
  const normalized = ((angle % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
  return normalized > Math.PI;
}

function annularSector(startAngle: number, endAngle: number, inner: number, outer: number): string {
  const largeArc = endAngle - startAngle > Math.PI ? 1 : 0;
  return [
    `M ${point(startAngle, outer)}`,
    `A ${outer} ${outer} 0 ${largeArc} 1 ${point(endAngle, outer)}`,
    `L ${point(endAngle, inner)}`,
    `A ${inner} ${inner} 0 ${largeArc} 0 ${point(startAngle, inner)}`,
    "Z",
  ].join(" ");
}

// Text on the lower half runs the other way round so it never reads upside down. Chrome does not
// re-lay out a textPath when its path changes, so each label is keyed on the path it follows.
function labelArc(startAngle: number, endAngle: number, radius: number): string {
  const largeArc = endAngle - startAngle > Math.PI ? 1 : 0;
  return isLowerHalf((startAngle + endAngle) / 2)
    ? `M ${point(endAngle, radius)} A ${radius} ${radius} 0 ${largeArc} 0 ${point(startAngle, radius)}`
    : `M ${point(startAngle, radius)} A ${radius} ${radius} 0 ${largeArc} 1 ${point(endAngle, radius)}`;
}

/**
 * A link drawn in polar space: it leaves and arrives along the radius and turns in between, so a
 * link between distant angles follows the ring instead of cutting a chord through the middle.
 * `bulge` pushes the turn outward, which lets a link return to a ring further in.
 */
function polarLink(
  fromAngle: number,
  fromRadius: number,
  toAngle: number,
  toRadius: number,
  bulge: number,
): string {
  const turn = shortestTurn(fromAngle, toAngle);
  const steps = 16 + Math.ceil(Math.abs(turn) * 24);
  const points: string[] = [];
  for (let step = 0; step <= steps; step += 1) {
    const t = step / steps;
    const eased = t * t * (3 - 2 * t);
    const radius = fromRadius + (toRadius - fromRadius) * t + bulge * Math.sin(Math.PI * t);
    points.push(point(fromAngle + turn * eased, radius));
  }
  return `M ${points.join(" L ")}`;
}

function shortestTurn(from: number, to: number): number {
  const delta = (((to - from) % (Math.PI * 2)) + Math.PI * 3) % (Math.PI * 2);
  return delta - Math.PI;
}

function fitLabel(text: string, available: number, charWidth: number): string | null {
  if (text.length * charWidth <= available) {
    return text;
  }
  const characters = Math.floor(available / charWidth) - 1;
  return characters < 4 ? null : `${text.slice(0, characters)}…`;
}

/**
 * Route pills stay horizontal so they read like the cards elsewhere in Backoffice. Their width is
 * whatever fits in their slot along the ring: at 12 o'clock that is width, at 3 o'clock height.
 * `reach` is how far the pill extends along the radius, where its edges attach.
 */
function routePill(route: OrchestrationRoute, angle: number, slot: number) {
  const priority = `P${route.priority}`;
  const priorityWidth = 18 + priority.length * 6.4;
  const tangentCos = Math.abs(Math.cos(angle));
  const tangentSin = Math.abs(Math.sin(angle));
  const widthForSlot =
    tangentCos < 0.05 ? ROUTE_PILL_MAX_WIDTH : (slot - ROUTE_PILL_HEIGHT * tangentSin) / tangentCos;
  const room = Math.min(ROUTE_PILL_MAX_WIDTH, widthForSlot);
  const label = fitLabel(route.label, room - priorityWidth - 6, SANS_CHAR_WIDTH * 0.92);
  const width = label ? priorityWidth + 6 + label.length * SANS_CHAR_WIDTH * 0.92 : priorityWidth;
  const reach = Math.min(
    tangentSin < 1e-3 ? Number.POSITIVE_INFINITY : width / 2 / tangentSin,
    tangentCos < 1e-3 ? Number.POSITIVE_INFINITY : ROUTE_PILL_HEIGHT / 2 / tangentCos,
  );
  return { priority, label, width, reach };
}

function useAnimatedLayout(target: OrchestrationRadialLayout): OrchestrationRadialLayout {
  const [shown, setShown] = useState(target);
  const shownRef = useRef(target);

  useEffect(() => {
    const from = shownRef.current;
    let frame = 0;
    const startedAt = performance.now();
    const tick = (now: number) => {
      const progress = Math.min(1, (now - startedAt) / TRANSITION_MS);
      const eased = 1 - (1 - progress) ** 3;
      const next = progress === 1 ? target : interpolateOrchestrationLayouts(from, target, eased);
      shownRef.current = next;
      setShown(next);
      if (progress < 1) {
        frame = requestAnimationFrame(tick);
      }
    };
    if (from !== target && window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      shownRef.current = target;
      setShown(target);
    } else if (from !== target) {
      frame = requestAnimationFrame(tick);
    }
    return () => {
      cancelAnimationFrame(frame);
    };
  }, [target]);

  return shown;
}

function SvgIcon({
  name,
  x,
  y,
  size,
  className,
}: {
  name: IconName;
  x: number;
  y: number;
  size: number;
  className: string;
}) {
  return (
    <g transform={`translate(${x - size / 2} ${y - size / 2}) scale(${size / 24})`}>
      <Icon name={name} className={className} strokeWidth={1.8} />
    </g>
  );
}

function HubDetail({
  eyebrow,
  title,
  detail,
}: {
  eyebrow: string;
  title: string;
  detail: ReactNode;
}) {
  return (
    <div className="flex h-full flex-col items-center justify-center px-3 text-center">
      <p className="text-[10px] font-semibold tracking-[0.22em] text-[var(--bo-muted-2)] uppercase">
        {eyebrow}
      </p>
      <p className="mt-1 line-clamp-2 text-[15px] leading-tight font-semibold break-words text-[var(--bo-fg)]">
        {title}
      </p>
      <div className="mt-1 line-clamp-2 text-[11px] leading-snug text-[var(--bo-muted)]">
        {detail}
      </div>
    </div>
  );
}

/**
 * Sources, their events, the routes that listen to them, and what those routes reach, drawn as
 * rings from the centre out. Hovering or selecting an item lights up everything upstream and
 * downstream of it; double-clicking a source turns it to the top and gives it more room.
 */
export function OrchestrationRadialGraph({
  graph,
  mode,
  focusSourceId,
  onFocusSource,
  selected,
  onSelect,
  pulses,
}: {
  graph: OrchestrationGraph;
  mode: OrchestrationGraphMode;
  focusSourceId: string | null;
  onFocusSource: (sourceId: string | null) => void;
  selected: OrchestrationGraphItem | null;
  onSelect: (item: OrchestrationGraphItem | null) => void;
  pulses: readonly OrchestrationPulse[];
}) {
  const markerIdPrefix = useId();
  const [hovered, setHovered] = useState<OrchestrationGraphItem | null>(null);
  const targetLayout = useMemo(
    () => layoutOrchestrationGraph(graph, { mode, focusSourceId }),
    [graph, mode, focusSourceId],
  );
  const layout = useAnimatedLayout(targetLayout);

  const active = hovered ?? selected;
  const related = useMemo(
    () => (active ? relatedOrchestrationItems(graph, active) : null),
    [graph, active],
  );
  const emphasis = (item: OrchestrationGraphItem) =>
    related === null || related.has(itemKey(item)) ? 1 : 0.16;
  const isSelected = (item: OrchestrationGraphItem) =>
    selected !== null && selected.kind === item.kind && selected.id === item.id;

  const eventArcs = new Map(layout.events.map((arc) => [arc.id, arc]));
  const routePoints = new Map(layout.routes.map((routePoint) => [routePoint.id, routePoint]));
  const targetPoints = new Map(layout.targets.map((targetPoint) => [targetPoint.id, targetPoint]));
  const sourcesById = new Map(graph.sources.map((source) => [source.id, source]));
  const routeCountByEvent = new Map<string, number>();
  for (const route of graph.routes) {
    routeCountByEvent.set(route.eventId, (routeCountByEvent.get(route.eventId) ?? 0) + 1);
  }
  const maxRecent = Math.max(1, ...graph.events.map((event) => event.recentCount));
  const hiddenLabelPath = layout.hidden
    ? labelArc(layout.hidden.startAngle, layout.hidden.endAngle, EVENT_INNER + 20)
    : "";
  const pills = new Map(
    layout.routes.map(({ route, angle }) => {
      const eventArc = eventArcs.get(route.eventId);
      const siblings = routeCountByEvent.get(route.eventId) ?? 1;
      const slot = eventArc
        ? ((eventArc.endAngle - eventArc.startAngle) / siblings) * ROUTE_RADIUS - 10
        : ROUTE_PILL_MAX_WIDTH;
      return [route.id, routePill(route, angle, slot)];
    }),
  );
  const pillReach = (routeId: string) => pills.get(routeId)?.reach ?? ROUTE_PILL_HEIGHT / 2;

  function interactions(item: OrchestrationGraphItem, label: string) {
    return {
      role: "button",
      tabIndex: 0,
      "aria-label": label,
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
        onSelect(isSelected(item) ? null : item);
      },
      onKeyDown: (event: KeyboardEvent<SVGGElement>) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onSelect(isSelected(item) ? null : item);
        }
      },
    } as const;
  }

  // The edge a route draws towards its target, or back to the event it re-emits.
  function routeEdgePath(route: OrchestrationRoute, angle: number): string | null {
    if (route.action.kind === "reclassify_event") {
      const emitted = eventArcs.get(route.action.eventId);
      if (!emitted) {
        return null;
      }
      const emittedAngle = (emitted.startAngle + emitted.endAngle) / 2;
      return polarLink(
        angle,
        ROUTE_RADIUS + pillReach(route.id),
        emittedAngle,
        ACTIVITY_OUTER + 4,
        110,
      );
    }
    const target = targetPoints.get(route.action.targetId);
    if (!target) {
      return null;
    }
    return polarLink(
      angle,
      ROUTE_RADIUS + pillReach(route.id),
      target.angle,
      TARGET_RADIUS - TARGET_NODE_RADIUS - 4,
      0,
    );
  }

  const hubContent = (() => {
    if (!active) {
      const sourceCount = new Set(graph.events.map((event) => event.sourceId)).size;
      return (
        <HubDetail
          eyebrow="Scope"
          title={graph.scopeLabel}
          detail={`${sourceCount} sources · ${graph.events.length} events · ${graph.routes.length} routes`}
        />
      );
    }
    switch (active.kind) {
      case "source": {
        const source = sourcesById.get(active.id);
        const events = graph.events.filter((event) => event.sourceId === active.id);
        const routeCount = graph.routes.filter((route) =>
          events.some((event) => event.id === route.eventId),
        ).length;
        return (
          <HubDetail
            eyebrow="Source"
            title={source?.label ?? active.id}
            detail={`${events.length} events · ${routeCount} routes`}
          />
        );
      }
      case "event": {
        const event = graph.events.find((candidate) => candidate.id === active.id);
        return event ? (
          <HubDetail
            eyebrow="Event"
            title={`${event.sourceId}.${event.eventType}`}
            detail={`${event.label} · ${event.recentCount} recent`}
          />
        ) : null;
      }
      case "route": {
        const route = graph.routes.find((candidate) => candidate.id === active.id);
        return route ? (
          <HubDetail
            eyebrow={`Route · P${route.priority}${route.enabled ? "" : " · Disabled"}`}
            title={route.label}
            detail={
              <>
                <span className="font-mono">{route.matcher ?? "every event"}</span>
                <br />
                {routeActionLabel(route.action)}
              </>
            }
          />
        ) : null;
      }
      case "target": {
        const target = graph.targets.find((candidate) => candidate.id === active.id);
        return target ? (
          <HubDetail
            eyebrow={ORCHESTRATION_TARGET_KIND_LABEL[target.kind]}
            title={target.label}
            detail={target.kind === "workflow" ? `${target.activeCount} running` : null}
          />
        ) : null;
      }
    }
    return null;
  })();

  return (
    <svg
      viewBox={`0 0 ${SIZE} ${SIZE}`}
      role="group"
      aria-label={`Automation orchestration for ${graph.scopeLabel}`}
      className="h-auto w-full touch-manipulation select-none"
      onClick={() => {
        onSelect(null);
      }}
    >
      <RouteMarkerDefs idPrefix={markerIdPrefix} />

      {/* Guide rings make the empty parts of the circle read as structure, not missing data. */}
      {[ROUTE_RADIUS, TARGET_RADIUS].map((radius) => (
        <circle
          key={radius}
          cx={CENTER}
          cy={CENTER}
          r={radius}
          className="fill-none stroke-[var(--bo-border)]"
          strokeDasharray="2 6"
        />
      ))}

      {/* Edges sit under every node so links never cover a label. */}
      <g className="pointer-events-none">
        {layout.routes.map(({ route, angle, presence }) => {
          const eventArc = eventArcs.get(route.eventId);
          const edgePath = routeEdgePath(route, angle);
          const routeItem = { kind: "route", id: route.id } as const;
          const opacity = presence * emphasis(routeItem) * (route.enabled ? 1 : 0.55);
          return (
            <g key={route.id} opacity={opacity} className="transition-opacity duration-200">
              {eventArc ? (
                <line
                  x1={polar(angle, ACTIVITY_OUTER)[0]}
                  y1={polar(angle, ACTIVITY_OUTER)[1]}
                  x2={polar(angle, ROUTE_RADIUS - pillReach(route.id))[0]}
                  y2={polar(angle, ROUTE_RADIUS - pillReach(route.id))[1]}
                  className="stroke-[var(--bo-fg)]/45"
                  strokeWidth={1.5}
                  strokeDasharray={route.enabled ? undefined : DISABLED_EDGE_DASH}
                />
              ) : null}
              {edgePath ? (
                <path
                  d={edgePath}
                  className={cn("fill-none", ROUTE_EDGE_CLASS_NAME)}
                  strokeWidth={isSelected(routeItem) ? 2.6 : 1.8}
                  strokeDasharray={
                    route.enabled ? ACTION_EDGE_DASH[route.action.kind] : DISABLED_EDGE_DASH
                  }
                  markerEnd={routeMarkerUrl(markerIdPrefix)}
                />
              ) : null}
            </g>
          );
        })}
      </g>

      {layout.sources.map(({ source, startAngle, endAngle, presence }) => {
        const item = { kind: "source", id: source.id } as const;
        const middle = (startAngle + endAngle) / 2;
        const labelRadius = SOURCE_INNER + 18;
        const label = fitLabel(
          source.label,
          (endAngle - startAngle) * labelRadius - 10,
          SANS_CHAR_WIDTH,
        );
        const labelPathId = `${markerIdPrefix}-source-${source.id}`;
        const labelPath = labelArc(startAngle, endAngle, labelRadius);
        const [iconX, iconY] = polar(middle, SOURCE_OUTER - 17);
        return (
          <g
            key={source.id}
            {...interactions(item, `${source.label} source`)}
            onDoubleClick={(event) => {
              event.stopPropagation();
              onFocusSource(focusSourceId === source.id ? null : source.id);
            }}
            opacity={presence * emphasis(item)}
            className="cursor-pointer transition-opacity duration-200 outline-none"
          >
            <path
              d={annularSector(startAngle, endAngle, SOURCE_INNER, SOURCE_OUTER)}
              className={cn(
                "fill-[color-mix(in_srgb,var(--bo-fg)_7%,transparent)] stroke-[var(--bo-bg)] transition-[fill] hover:fill-[color-mix(in_srgb,var(--bo-fg)_11%,transparent)]",
                isSelected(item) && "fill-[color-mix(in_srgb,var(--bo-fg)_16%,transparent)]",
              )}
              strokeWidth={2}
            />
            <SvgIcon
              name={source.icon}
              x={iconX}
              y={iconY}
              size={15}
              className="text-[var(--bo-muted)]"
            />
            {label ? (
              <>
                <path id={labelPathId} d={labelPath} fill="none" />
                <text
                  key={labelPath}
                  className="fill-[var(--bo-fg)] text-[12px] font-semibold"
                  dominantBaseline="central"
                >
                  <textPath href={`#${labelPathId}`} startOffset="50%" textAnchor="middle">
                    {label}
                  </textPath>
                </text>
              </>
            ) : null}
          </g>
        );
      })}

      {layout.hidden ? (
        <g opacity={layout.hidden.presence} className="pointer-events-none">
          <path
            d={annularSector(
              layout.hidden.startAngle,
              layout.hidden.endAngle,
              SOURCE_INNER,
              EVENT_OUTER,
            )}
            className="fill-[var(--bo-panel-2)] stroke-[var(--bo-border)]"
            strokeDasharray="3 4"
          />
          <path id={`${markerIdPrefix}-${HIDDEN_WEDGE_ID}`} d={hiddenLabelPath} fill="none" />
          <text
            key={hiddenLabelPath}
            className="fill-[var(--bo-muted-2)] text-[11px]"
            dominantBaseline="central"
          >
            <textPath
              href={`#${markerIdPrefix}-${HIDDEN_WEDGE_ID}`}
              startOffset="50%"
              textAnchor="middle"
            >
              {fitLabel(
                `+${layout.hidden.sourceCount} sources · ${layout.hidden.eventCount} events`,
                (layout.hidden.endAngle - layout.hidden.startAngle) * (EVENT_INNER + 20) - 8,
                SANS_CHAR_WIDTH * 0.92,
              ) ?? `+${layout.hidden.eventCount}`}
            </textPath>
          </text>
        </g>
      ) : null}

      {layout.events.map(({ event, startAngle, endAngle, presence }) => {
        const item = { kind: "event", id: event.id } as const;
        const routed = routeCountByEvent.has(event.id);
        const middle = (startAngle + endAngle) / 2;
        const tangentialRadius = (EVENT_INNER + EVENT_OUTER) / 2;
        const tangentialRoom = (endAngle - startAngle) * tangentialRadius - 14;
        const fitsAlongArc = event.eventType.length * MONO_CHAR_WIDTH <= tangentialRoom;
        const radialLabel = fitsAlongArc
          ? null
          : (endAngle - startAngle) * EVENT_INNER >= 13
            ? fitLabel(event.eventType, EVENT_OUTER - EVENT_INNER - 14, MONO_CHAR_WIDTH)
            : null;
        const labelPathId = `${markerIdPrefix}-event-${event.id}`;
        const labelPath = labelArc(startAngle, endAngle, tangentialRadius);
        const activityEnd =
          startAngle + (endAngle - startAngle) * Math.min(1, event.recentCount / maxRecent);
        const [labelX, labelY] = polar(middle, tangentialRadius);
        const flip = isLeftHalf(middle);
        return (
          <g
            key={event.id}
            {...interactions(item, `${event.sourceId}.${event.eventType} event`)}
            opacity={presence * emphasis(item)}
            className="cursor-pointer transition-opacity duration-200 outline-none"
          >
            <path
              d={annularSector(startAngle, endAngle, EVENT_INNER, EVENT_OUTER)}
              className={cn(
                "stroke-[var(--bo-bg)] transition-[fill]",
                routed
                  ? "fill-[color-mix(in_srgb,var(--bo-fg)_7%,transparent)] hover:fill-[color-mix(in_srgb,var(--bo-fg)_11%,transparent)]"
                  : "fill-[var(--bo-panel)] hover:fill-[color-mix(in_srgb,var(--bo-fg)_7%,transparent)]",
                isSelected(item) && "fill-[color-mix(in_srgb,var(--bo-fg)_16%,transparent)]",
              )}
              strokeWidth={2}
            />
            {event.recentCount > 0 ? (
              <path
                d={annularSector(startAngle, activityEnd, EVENT_OUTER + 1, ACTIVITY_OUTER)}
                className="fill-[var(--bo-fg)]"
                opacity={0.75}
              />
            ) : null}
            {fitsAlongArc ? (
              <>
                <path id={labelPathId} d={labelPath} fill="none" />
                <text
                  key={labelPath}
                  className={cn(
                    "font-mono text-[11px]",
                    routed ? "fill-[var(--bo-fg)]" : "fill-[var(--bo-muted-2)]",
                  )}
                  dominantBaseline="central"
                >
                  <textPath href={`#${labelPathId}`} startOffset="50%" textAnchor="middle">
                    {event.eventType}
                  </textPath>
                </text>
              </>
            ) : radialLabel ? (
              <text
                x={labelX}
                y={labelY}
                transform={`rotate(${degrees(middle) + (flip ? 90 : -90)} ${labelX} ${labelY})`}
                textAnchor="middle"
                dominantBaseline="central"
                className={cn(
                  "font-mono text-[10.5px]",
                  routed ? "fill-[var(--bo-fg)]" : "fill-[var(--bo-muted-2)]",
                )}
              >
                {radialLabel}
              </text>
            ) : null}
          </g>
        );
      })}

      {layout.routes.map(({ route, angle, presence }) => {
        const item = { kind: "route", id: route.id } as const;
        const pill = pills.get(route.id);
        if (!pill) {
          return null;
        }
        const [x, y] = polar(angle, ROUTE_RADIUS);
        return (
          <g
            key={route.id}
            {...interactions(item, `${route.label} route, priority ${route.priority}`)}
            opacity={presence * emphasis(item)}
            className="cursor-pointer transition-opacity duration-200 outline-none"
          >
            <rect
              x={x - pill.width / 2}
              y={y - ROUTE_PILL_HEIGHT / 2}
              width={pill.width}
              height={ROUTE_PILL_HEIGHT}
              rx={4}
              className={cn(
                "fill-[var(--bo-panel)] stroke-[var(--bo-border-strong)] transition-[stroke]",
                isSelected(item) ? "stroke-[var(--bo-fg)]" : "hover:stroke-[var(--bo-fg)]",
              )}
              strokeWidth={isSelected(item) ? 2 : 1}
              strokeDasharray={route.enabled ? undefined : "3 3"}
            />
            <text
              x={x - pill.width / 2 + 9}
              y={y}
              dominantBaseline="central"
              className={cn(
                "text-[11.5px]",
                route.enabled ? "fill-[var(--bo-fg)]" : "fill-[var(--bo-muted-2)]",
              )}
            >
              <tspan className="fill-[var(--bo-fg)] text-[9.5px] font-semibold tracking-[0.12em]">
                {pill.priority}
              </tspan>
              {pill.label ? <tspan dx={6}>{pill.label}</tspan> : null}
            </text>
          </g>
        );
      })}

      {layout.targets.map(({ target, angle, presence }) => {
        const item = { kind: "target", id: target.id } as const;
        const [x, y] = polar(angle, TARGET_RADIUS);
        const outwardX = Math.sin(angle);
        // Labels sit beside their node, pointing away from the vertical axis, so neighbours near
        // the top do not stack their labels on each other. Only a node right on the axis centres it.
        const beside = Math.abs(outwardX) >= 0.08;
        const above = Math.cos(angle) > 0;
        const offset = TARGET_NODE_RADIUS + 10;
        const labelX = beside ? x + Math.sign(outwardX) * offset : x;
        const labelRoom = beside
          ? (outwardX > 0 ? SIZE - labelX : labelX) - 12
          : TARGET_LABEL_MAX_WIDTH * 1.6;
        const nameY = beside
          ? y - (target.activeCount > 0 ? 7 : 0)
          : above
            ? y - offset - 18
            : y + offset + 6;
        const label =
          fitLabel(target.label, labelRoom, SANS_CHAR_WIDTH * 1.05) ?? target.label.slice(0, 4);
        return (
          <g
            key={target.id}
            {...interactions(item, `${target.label} ${target.kind}`)}
            opacity={presence * emphasis(item)}
            className="cursor-pointer transition-opacity duration-200 outline-none"
          >
            {target.activeCount > 0 ? (
              <circle
                cx={x}
                cy={y}
                r={TARGET_NODE_RADIUS + 5}
                className="fill-none stroke-[var(--bo-fg)]"
                strokeWidth={2}
                strokeDasharray="4 3"
              />
            ) : null}
            <circle
              cx={x}
              cy={y}
              r={TARGET_NODE_RADIUS}
              className={cn(
                "fill-[var(--bo-panel)] transition-[stroke-width]",
                TARGET_KIND_PRESENTATION[target.kind].strokeClassName,
              )}
              strokeWidth={isSelected(item) ? 3 : 1.5}
            />
            <SvgIcon
              name={TARGET_KIND_PRESENTATION[target.kind].icon}
              x={x}
              y={y}
              size={16}
              className={TARGET_KIND_PRESENTATION[target.kind].iconClassName}
            />
            <text
              x={labelX}
              y={nameY}
              textAnchor={beside ? (outwardX > 0 ? "start" : "end") : "middle"}
              dominantBaseline="central"
              className="fill-[var(--bo-fg)] text-[13px] font-semibold"
            >
              {label}
              {target.activeCount > 0 ? (
                <tspan
                  x={labelX}
                  dy={15}
                  className="fill-[var(--bo-fg)] text-[11px] font-medium tabular-nums"
                >
                  {target.activeCount} running
                </tspan>
              ) : null}
            </text>
          </g>
        );
      })}

      {pulses.map((pulse) => {
        const eventArc = eventArcs.get(pulse.eventId);
        if (!eventArc) {
          return null;
        }
        const paths = pulse.routeIds.flatMap((routeId) => {
          const routePoint = routePoints.get(routeId);
          if (!routePoint) {
            return [];
          }
          const onward = routeEdgePath(routePoint.route, routePoint.angle);
          const inbound = `M ${point(routePoint.angle, (EVENT_INNER + EVENT_OUTER) / 2)} L ${point(routePoint.angle, ROUTE_RADIUS + ROUTE_PILL_HEIGHT / 2)}`;
          // The onward edge starts where the inbound leg ends, so its move becomes a line.
          return [onward ? `${inbound} ${onward.replace(/^M /, "L ")}` : inbound];
        });
        return (
          <OrchestrationPulseAnimation
            key={pulse.id}
            flashPath={annularSector(
              eventArc.startAngle,
              eventArc.endAngle,
              EVENT_INNER,
              EVENT_OUTER,
            )}
            paths={paths}
          />
        );
      })}

      <circle
        cx={CENTER}
        cy={CENTER}
        r={HUB_RADIUS}
        className="fill-[var(--bo-panel)] stroke-[var(--bo-border)]"
      />
      <foreignObject
        x={CENTER - HUB_RADIUS}
        y={CENTER - HUB_RADIUS}
        width={HUB_RADIUS * 2}
        height={HUB_RADIUS * 2}
        className="pointer-events-none"
      >
        {hubContent}
      </foreignObject>
    </svg>
  );
}
