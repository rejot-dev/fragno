import {
  type KeyboardEvent,
  memo,
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { IconButton } from "../controls/button";
import { Icon, type IconName } from "../icon";
import {
  ACTION_EDGE_CLASS_NAME,
  ACTION_EDGE_DASH,
  ActionMarkerDefs,
  actionMarkerUrl,
  countLabel,
  eventsStartWorkflows,
  TARGET_KIND_PRESENTATION,
} from "./orchestration-graph-parts";
import { SvgIcon } from "./orchestration-radial-parts";
import { fitCamera, zoomAt, type Camera, type Size } from "./orchestration-universe-camera";
import {
  FRAME_INSET,
  FRAME_PADDING,
  TILE_FONT,
  TILE_ICON,
  TILE_THICKNESS,
  type ExternalTile,
} from "./orchestration-universe-frame";
import { arrangeAtRest } from "./orchestration-universe-layout";
import {
  callKey,
  externalKey,
  forwardKey,
  layoutUniverse,
  universeHighlights,
  universeItemKey,
  workflowFocusId,
  type OrchestrationExternal,
  type OrchestrationUniverse,
  type OrchestrationUniverseScope,
  type OrchestrationUniverseScopeStatus,
  type UniverseCall,
  type UniverseForward,
  type UniversePlanet,
} from "./orchestration-universe-model";
import {
  callRouter,
  orbitLandings,
  routeForwards,
  universeField,
  workflowGrowth,
} from "./orchestration-universe-routes";
import { useUniverseSimulation } from "./orchestration-universe-simulation";
import { polar, SANS_CHAR_WIDTH, type Point } from "./radial-geometry";
import {
  PLANET_EVENT_EDGE_RADIUS,
  PLANET_ORBIT_RADIUS,
  PLANET_STATUS_RING_RADIUS,
  PLANET_STATUS_RING_WIDTH,
  PLANET_WORKFLOW_NODE_RADIUS,
  WorkflowTriggerPlanet,
  type PlanetItemInteraction,
} from "./workflow-trigger-planet";

/**
 * What someone points at or pins: a planet, one workflow on a planet, by its `workflowFocusId`,
 * or an outside system on the frame.
 */
type UniverseFocus =
  | { kind: "scope"; id: string }
  | { kind: "workflow"; id: string; scopeId: string; workflowId: string }
  | { kind: "external"; id: string };

// A press only becomes a drag once it moves this far, so a click on a planet still pins it.
type Gesture = {
  pointerId: number;
  startX: number;
  startY: number;
  moved: boolean;
} & (
  | { kind: "pan"; origin: Camera }
  | { kind: "planet"; scopeId: string; origin: Point; camera: Camera }
);

const DRAG_THRESHOLD = 4;
const ZOOM_STEP = 1.4;
const DIMMED = 0.16;
const FORWARD_EDGE = "forward_event";
// Forward labels read like the route pills of the radial graph, at the planets' own scale.
const FORWARD_LABEL_HEIGHT = 24;
const FORWARD_LABEL_CHAR_WIDTH = SANS_CHAR_WIDTH * 0.92;
const FORWARD_LABEL_FONT = 11.5;
const FORWARD_TAG = "FWD";
const FORWARD_TAG_WIDTH = 30;
// Below this zoom the hubs are too small to read, so each planet gets a name tag that keeps its
// size on screen. Forwards keep a readable size on screen at every zoom.
const OVERVIEW_SCALE = 0.4;
const MIN_FORWARD_FONT = 6;
const MIN_TAG_FONT = 8;
// Between planets there is room for whole workflow names.
const WORKFLOW_LABEL_REACH = PLANET_ORBIT_RADIUS + 600;
const MIN_SCREEN_STROKE = 0.9;
// The whole planet answers the pointer, out to just past the workflows on its orbit.
const PLANET_HIT_RADIUS = PLANET_ORBIT_RADIUS + 28;
// Each workflow answers the pointer within a small orbit of its own, wider than its node, which
// shows while it is focused.
const WORKFLOW_HIT_RADIUS = PLANET_WORKFLOW_NODE_RADIUS + 16;
const NO_ITEM_INTERACTION: PlanetItemInteraction = { kind: "none" };
// The layout follows the view's shape in steps, so resizing does not stir it every pixel.
const ASPECT_STEP = 0.1;
const DEFAULT_ASPECT = 1.5;
const DIMMED_TILE = 0.35;
// A planet still being read says how far it got under its hub.
const STATUS_LABEL_Y = 140;
// How long a planet that finished loading fades from its ring to its graph, as .bo-planet-reveal
// and .bo-planet-status-leave animate it, with time to spare.
const REVEAL_MS = 900;
const NO_STATUSES: ReadonlyMap<string, OrchestrationUniverseScopeStatus> = new Map();
// The share of the ring the arc turning round a planet still being read covers.
const LOADING_ARC = 0.2;
const NO_TILES: readonly ExternalTile[] = [];
const NO_CALLS: readonly UniverseCall[] = [];
const NOTHING_LIT: ReadonlySet<string> = new Set();

function sameFocus(current: UniverseFocus | null, target: UniverseFocus): boolean {
  return current?.kind === target.kind && current.id === target.id;
}

/**
 * A planet's drawing, which only changes with what is lit, so the simulation can move planets
 * every frame without drawing them again.
 */
const PlanetBody = memo(function PlanetBody({
  planet,
  idPrefix,
  lit,
  workflowScale,
  finishedLoading,
  focusRingWidth,
}: {
  planet: UniversePlanet;
  idPrefix: string;
  lit: ReadonlySet<string> | null;
  workflowScale: number;
  /** The status a planet that just finished loading last showed, while its graph fades in. */
  finishedLoading: OrchestrationUniverseScopeStatus | null;
  /** How wide the focused planet's orbit is drawn; null on every other planet. */
  focusRingWidth: number | null;
}) {
  const scopeId = planet.scope.id;
  return (
    <>
      <circle r={PLANET_HIT_RADIUS} className="fill-transparent" />
      {/* Solid behind the rings and workflows, so lines passing under a faded planet stay hidden. */}
      <circle r={PLANET_EVENT_EDGE_RADIUS + 2} className="fill-[var(--bo-bg)]" />
      {/* Under the workflows' backdrops, so the orbit passes behind each workflow. */}
      {focusRingWidth !== null ? (
        <circle
          r={PLANET_ORBIT_RADIUS}
          className="pointer-events-none fill-none stroke-[var(--bo-accent)]/40"
          strokeWidth={focusRingWidth}
          strokeDasharray="10 8"
        />
      ) : null}
      {planet.layout.workflows.map(({ workflow, angle }) => {
        const [x, y] = polar(angle, PLANET_ORBIT_RADIUS);
        return (
          <circle
            key={workflow.id}
            cx={x}
            cy={y}
            r={(PLANET_WORKFLOW_NODE_RADIUS + 5) * workflowScale}
            className="fill-[var(--bo-bg)]"
          />
        );
      })}
      <WorkflowTriggerPlanet
        scopeLabel={planet.scope.graph.scopeLabel}
        layout={planet.layout}
        forwardCounts={planet.forwardCounts}
        idPrefix={`${idPrefix}-${scopeId}`}
        markerIdPrefix={idPrefix}
        emphasis={(item) =>
          lit === null || lit.has(universeItemKey({ scopeId, item })) ? 1 : DIMMED
        }
        interaction={NO_ITEM_INTERACTION}
        workflowScale={workflowScale}
        workflowLabelReach={WORKFLOW_LABEL_REACH}
        revealing={finishedLoading !== null}
      />
      {planet.scope.status ? (
        <PlanetStatus status={planet.scope.status} />
      ) : finishedLoading ? (
        <g className="bo-planet-status-leave">
          <PlanetStatus status={finishedLoading} />
        </g>
      ) : null}
    </>
  );
});

/**
 * The planets that finished loading in the last moments, with the status each last showed, so its
 * ring can fade away as its graph fades in. Measured before paint, so a planet that just finished
 * never shows its graph whole for a frame first.
 */
function useFinishedLoading(scopes: readonly OrchestrationUniverseScope[]) {
  // Each reveal with when it ends, so other planets' progress, which changes the scopes many times
  // a reveal, never restarts it.
  const [revealing, setRevealing] = useState<
    ReadonlyMap<string, { status: OrchestrationUniverseScopeStatus; until: number }>
  >(new Map());
  const loading = useRef(new Map<string, OrchestrationUniverseScopeStatus>());
  useLayoutEffect(() => {
    const until = performance.now() + REVEAL_MS;
    const done = new Map<string, { status: OrchestrationUniverseScopeStatus; until: number }>();
    for (const scope of scopes) {
      const was = loading.current.get(scope.id);
      if (was && !scope.status) {
        done.set(scope.id, { status: was, until });
      }
    }
    loading.current = new Map(
      scopes.flatMap((scope) => (scope.status ? [[scope.id, scope.status] as const] : [])),
    );
    if (done.size > 0) {
      setRevealing((current) => new Map([...current, ...done]));
    }
  }, [scopes]);
  // One timer, for the reveal that ends first; ending it sets the next.
  useEffect(() => {
    if (revealing.size === 0) {
      return undefined;
    }
    const next = Math.min(...[...revealing.values()].map(({ until }) => until));
    const timer = setTimeout(
      () => {
        const now = performance.now();
        setRevealing((current) => new Map([...current].filter(([, { until }]) => until > now)));
      },
      Math.max(0, next - performance.now()),
    );
    return () => {
      clearTimeout(timer);
    };
  }, [revealing]);
  return useMemo(
    () =>
      revealing.size === 0
        ? NO_STATUSES
        : new Map([...revealing].map(([id, { status }]) => [id, status] as const)),
    [revealing],
  );
}

/**
 * A ring around a planet still being read, with an arc turning round it while the label says how
 * far it got; red with the reason once reading failed.
 */
function PlanetStatus({ status }: { status: OrchestrationUniverseScopeStatus }) {
  const failed = status.kind === "failed";
  const fraction = status.kind === "loading" ? status.fraction : null;
  const label = failed
    ? "Could not be read"
    : fraction === null
      ? "Loading…"
      : `Loading ${Math.round(fraction * 100)}%`;
  return (
    <g className="pointer-events-none">
      <title>{failed ? status.message : label}</title>
      <circle
        r={PLANET_STATUS_RING_RADIUS}
        className={`fill-none ${failed ? "stroke-[var(--bo-failed)]" : "stroke-[var(--bo-border)]"}`}
        strokeWidth={PLANET_STATUS_RING_WIDTH}
        strokeDasharray={failed ? "14 10" : undefined}
      />
      {failed ? null : (
        <circle
          r={PLANET_STATUS_RING_RADIUS}
          pathLength={1}
          // CSS turns an SVG element about its viewport's corner unless told to use its own box.
          // Without motion a still arc would read as progress, so only the track stays.
          className="origin-center fill-none stroke-[var(--bo-accent)] [transform-box:fill-box] motion-safe:animate-spin motion-reduce:hidden"
          strokeWidth={PLANET_STATUS_RING_WIDTH}
          strokeLinecap="round"
          strokeDasharray={`${LOADING_ARC} 1`}
        />
      )}
      <text
        y={STATUS_LABEL_Y}
        textAnchor="middle"
        className={`text-[22px] ${failed ? "fill-[var(--bo-failed)]" : "fill-[var(--bo-muted)]"}`}
      >
        {label}
      </text>
    </g>
  );
}

const TILE_ROTATION: Record<ExternalTile["side"], number> = {
  top: 0,
  bottom: 0,
  left: -90,
  right: 90,
};

/** An outside system as a slim tile on the frame; tiles on the sides read along the side. */
function ExternalTileShape({
  tile,
  focused,
  opacity,
}: {
  tile: ExternalTile;
  focused: boolean;
  opacity: number;
}) {
  const left = -tile.length / 2;
  return (
    <g
      transform={`translate(${tile.center.x} ${tile.center.y}) rotate(${TILE_ROTATION[tile.side]})`}
      opacity={opacity}
      className="transition-opacity duration-200"
    >
      <rect
        x={left}
        y={-TILE_THICKNESS / 2}
        width={tile.length}
        height={TILE_THICKNESS}
        rx={5}
        className={
          focused
            ? "fill-[var(--bo-panel)] stroke-[var(--bo-accent)]"
            : "fill-[var(--bo-panel)] stroke-[var(--bo-border-strong)]"
        }
        strokeWidth={focused ? 1.5 : 1}
      />
      <SvgIcon
        name={tile.external.icon}
        x={left + 10 + TILE_ICON / 2}
        y={0}
        size={TILE_ICON}
        className="text-[var(--bo-muted)]"
      />
      <text
        x={left + 10 + TILE_ICON + 6}
        dominantBaseline="central"
        fontSize={TILE_FONT}
        className="fill-[var(--bo-fg)] font-medium"
      >
        {tile.external.label}
      </text>
    </g>
  );
}

function listed(names: readonly string[]): string {
  return names.length <= 1
    ? names.join("")
    : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/** What the corner card says about the focused planet or outside system. */
function describeFocus(
  focus: UniverseFocus,
  planets: readonly UniversePlanet[],
  forwards: readonly UniverseForward[],
  externals: readonly OrchestrationExternal[],
  calls: readonly UniverseCall[],
): { kind: string; icon: IconName; name: string; lines: string[] } {
  const scopeLabel = (scopeId: string) =>
    planets.find(({ scope }) => scope.id === scopeId)?.scope.graph.scopeLabel ?? scopeId;
  const workflowOf = (scopeId: string, workflowId: string) =>
    planets
      .find(({ scope }) => scope.id === scopeId)
      ?.layout.workflows.find(({ workflow }) => workflow.id === workflowId)?.workflow;
  const workflowLabel = (scopeId: string, workflowId: string) =>
    workflowOf(scopeId, workflowId)?.label ?? workflowId;
  const externalLabel = (externalId: string) =>
    externals.find(({ id }) => id === externalId)?.label ?? externalId;
  if (focus.kind === "workflow") {
    const planet = planets.find(({ scope }) => scope.id === focus.scopeId);
    const startedBy = [
      ...new Set(
        planet?.layout.triggers
          .filter(({ workflowId }) => workflowId === focus.workflowId)
          .map(({ eventId }) => eventId),
      ),
    ].map(
      (eventId) =>
        planet?.layout.events.find(({ event }) => event.id === eventId)?.event.label ?? eventId,
    );
    const called = calls
      .filter((call) => call.scopeId === focus.scopeId && call.workflowId === focus.workflowId)
      .map((call) => externalLabel(call.externalId));
    return {
      kind: "Workflow",
      icon: TARGET_KIND_PRESENTATION.workflow.icon,
      name: workflowLabel(focus.scopeId, focus.workflowId),
      lines: [
        `In ${scopeLabel(focus.scopeId)}`,
        ...(startedBy.length > 0 ? [`Started by ${listed(startedBy)}`] : []),
        called.length > 0 ? `Calls ${listed(called)}` : "Calls no outside system",
      ],
    };
  }
  if (focus.kind === "external") {
    const external = externals.find(({ id }) => id === focus.id);
    const callers = calls.filter((call) => call.externalId === focus.id);
    const scopeIds = [...new Set(callers.map((call) => call.scopeId))];
    return {
      kind: "Outside system",
      icon: external?.icon ?? "link",
      name: external?.label ?? focus.id,
      lines: [
        `Called by ${countLabel(callers.length, "workflow")} in ${countLabel(scopeIds.length, "scope")}`,
        ...scopeIds.map(
          (scopeId) =>
            `${scopeLabel(scopeId)}: ${listed(callers.filter((call) => call.scopeId === scopeId).map((call) => workflowLabel(scopeId, call.workflowId)))}`,
        ),
      ],
    };
  }
  const planet = planets.find(({ scope }) => scope.id === focus.id);
  const startingEvents = new Set(planet?.layout.triggers.map(({ eventId }) => eventId));
  const destinations = [
    ...new Set(
      forwards
        .filter((forward) => forward.fromScopeId === focus.id)
        .map((forward) => forward.toScopeId),
    ),
  ];
  const called = [
    ...new Set(calls.filter((call) => call.scopeId === focus.id).map((call) => call.externalId)),
  ].map(externalLabel);
  return {
    kind: "Scope",
    icon: "globe",
    name: scopeLabel(focus.id),
    lines: [
      eventsStartWorkflows(startingEvents.size, planet?.layout.workflows.length ?? 0),
      ...(destinations.length > 0 ? [`Forwards to ${listed(destinations.map(scopeLabel))}`] : []),
      ...(called.length > 0 ? [`Calls ${listed(called)}`] : []),
    ],
  };
}

/** The scope's name over its hub, for when the hub itself is too small to read. */
function ScopeNameTag({ label, grow }: { label: string; grow: number }) {
  const fontSize = 24;
  const width = label.length * fontSize * 0.6 + 32;
  const height = fontSize + 18;
  return (
    <g transform={`scale(${grow})`} className="pointer-events-none">
      <rect
        x={-width / 2}
        y={-height / 2}
        width={width}
        height={height}
        rx={height / 2}
        className="fill-[var(--bo-fg)]"
      />
      <text
        textAnchor="middle"
        dominantBaseline="central"
        fontSize={fontSize}
        className="fill-[var(--bo-bg)] font-semibold"
      >
        {label}
      </text>
    </g>
  );
}

/** Names what is focused in the corner, since the focused planet drops its name tag. */
function FocusCard({
  kind,
  icon,
  name,
  lines,
  pinned,
  onClear,
}: {
  kind: string;
  icon: IconName;
  name: string;
  lines: readonly string[];
  pinned: boolean;
  onClear: () => void;
}) {
  return (
    <div
      role="status"
      style={{ bottom: FRAME_PADDING - 6, left: FRAME_PADDING - 6 }}
      className="absolute flex max-w-sm items-start gap-2.5 rounded-[6px] border border-[var(--bo-border)] bg-[var(--bo-panel)] py-2 pr-2 pl-3 shadow-sm"
    >
      <Icon name={icon} className="mt-0.5 size-4 shrink-0 text-[var(--bo-muted)]" />
      <div className="min-w-0 flex-1">
        <p className="text-[10px] font-medium tracking-[0.12em] text-[var(--bo-muted)] uppercase">
          {kind}
          {pinned ? " · pinned" : ""}
        </p>
        <p className="truncate text-sm font-semibold text-[var(--bo-fg)]">{name}</p>
        {lines.map((line) => (
          <p key={line} className="text-xs text-[var(--bo-muted)]">
            {line}
          </p>
        ))}
      </div>
      {pinned ? (
        <IconButton label="Clear selection" onClick={onClear}>
          <Icon name="x" className="size-4" />
        </IconButton>
      ) : null}
    </div>
  );
}

/**
 * Every scope as a planet of what starts its workflows, with the events one scope forwards to
 * another drawn between them, inside a frame of the outside systems those workflows call. Planets
 * push each other apart and the ones that forward to each other pull together, so dragging one
 * moves its neighbours and letting go lets it drift into place. Drag the background to pan, and
 * pinch or hold ⌘/Ctrl while scrolling to zoom; the frame stays put. Hovering a planet lights up
 * what leaves it: the forwards, what they reach, and the systems its workflows call. Hovering a
 * workflow, within the small orbit round it, lights up what starts it and draws its calls out to
 * the systems it reaches. Hovering a system draws the calls to it and lights up what ends up
 * calling it, back through the forwards. Clicking pins any of them. A forward that nothing on the
 * planet it reaches listens to lands on a stretch of that planet's orbit.
 */
export function OrchestrationUniverseGraph({ universe }: { universe: OrchestrationUniverse }) {
  const idPrefix = useId();
  const containerRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const [size, setSize] = useState<Size | null>(null);
  // Null follows the fit, so the view keeps fitting until someone pans or zooms.
  const [camera, setCamera] = useState<Camera | null>(null);
  const [hovered, setHovered] = useState<UniverseFocus | null>(null);
  const [pinned, setPinned] = useState<UniverseFocus | null>(null);
  const [draggedScope, setDraggedScope] = useState<string | null>(null);
  const [rearranged, setRearranged] = useState(false);
  const gesture = useRef<Gesture | null>(null);
  const swallowClick = useRef(false);

  const layout = useMemo(() => layoutUniverse(universe), [universe]);
  const finishedLoading = useFinishedLoading(universe.scopes);
  const { forwards, externals, calls } = layout;
  const highlights = useMemo(
    () => universeHighlights(layout.planets, layout.forwards, layout.externals, layout.calls),
    [layout],
  );
  const callCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const { externalId } of calls) {
      counts.set(externalId, (counts.get(externalId) ?? 0) + 1);
    }
    return counts;
  }, [calls]);
  const aspect = size
    ? Math.round(
        Math.max(1, size.width - FRAME_PADDING * 2) /
          Math.max(1, size.height - FRAME_PADDING * 2) /
          ASPECT_STEP,
      ) * ASPECT_STEP
    : DEFAULT_ASPECT;
  const simulation = useUniverseSimulation(universe.scopes, forwards, aspect);
  const { bodies, resting } = simulation;
  const positionOf = (scopeId: string): Point => bodies.get(scopeId) ?? { x: 0, y: 0 };

  // Tiles and the workflows facing them follow where planets rest, seen in the fitted view, so
  // they hold still while planets move and through panning and zooming.
  const atRest = useMemo(
    () => (size && layout.planets.length > 0 ? arrangeAtRest(layout, resting, size) : null),
    [layout, resting, size],
  );
  const planets = atRest?.planets ?? layout.planets;
  const tiles = atRest?.tiles ?? NO_TILES;
  const positions = useMemo(
    () => planets.map(({ scope }) => bodies.get(scope.id) ?? { x: 0, y: 0 }),
    [planets, bodies],
  );
  const fitted = useMemo(
    () => (size && positions.length > 0 ? fitCamera(positions, size) : null),
    [positions, size],
  );
  const shownCamera = camera ?? fitted;
  // The wheel listener reads the camera of the last committed render.
  const shownCameraRef = useRef(shownCamera);
  useLayoutEffect(() => {
    shownCameraRef.current = shownCamera;
  }, [shownCamera]);

  const focus: UniverseFocus | null = draggedScope
    ? { kind: "scope", id: draggedScope }
    : (hovered ?? pinned);
  const focusedScope = focus?.kind === "scope" ? focus.id : null;
  const lit =
    focus === null
      ? null
      : ({
          scope: highlights.scopes,
          workflow: highlights.workflows,
          external: highlights.externals,
        }[focus.kind].get(focus.id) ?? NOTHING_LIT);

  function togglePin(target: UniverseFocus) {
    setPinned((current) => (sameFocus(current, target) ? null : target));
  }

  /** Planets and tiles answer hovering, focus, clicks and Enter or Space the same way. */
  function focusHandlers(target: UniverseFocus) {
    return {
      role: "button",
      tabIndex: 0,
      "aria-pressed": sameFocus(pinned, target),
      onPointerEnter: () => {
        setHovered(target);
      },
      onPointerLeave: () => {
        setHovered(null);
      },
      onFocus: () => {
        setHovered(target);
      },
      onBlur: () => {
        setHovered(null);
      },
      onClick: (event: { stopPropagation: () => void }) => {
        event.stopPropagation();
        togglePin(target);
      },
      onKeyDown: (event: KeyboardEvent<SVGGElement>) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          togglePin(target);
        }
      },
    } as const;
  }

  // Measured before the first paint, so the planets do not wait for the observer's first report.
  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return undefined;
    }
    const bounds = container.getBoundingClientRect();
    setSize({ width: bounds.width, height: bounds.height });
    const observer = new ResizeObserver(([entry]) => {
      setSize({ width: entry.contentRect.width, height: entry.contentRect.height });
    });
    observer.observe(container);
    return () => {
      observer.disconnect();
    };
  }, []);

  // React registers wheel listeners as passive, and only an active one can keep the page still.
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) {
      return undefined;
    }
    const onWheel = (event: WheelEvent) => {
      const current = shownCameraRef.current;
      if (!current) {
        return;
      }
      event.preventDefault();
      if (event.ctrlKey || event.metaKey) {
        const bounds = svg.getBoundingClientRect();
        setCamera(
          zoomAt(
            current,
            event.clientX - bounds.left,
            event.clientY - bounds.top,
            Math.exp(-event.deltaY * 0.01),
          ),
        );
      } else {
        setCamera({ ...current, x: current.x - event.deltaX, y: current.y - event.deltaY });
      }
    };
    svg.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      svg.removeEventListener("wheel", onWheel);
    };
  }, []);

  function onPointerDown(event: ReactPointerEvent<SVGSVGElement>) {
    // A second pointer leaves a drag alone, or the drag could never end and a held planet would keep
    // the simulation running. A press that is not a drag yet has not captured its pointer, so its
    // end may never arrive; a new press replaces it.
    if (gesture.current?.moved) {
      return;
    }
    swallowClick.current = false;
    if (event.button !== 0 || !shownCamera) {
      return;
    }
    const planet =
      event.target instanceof Element ? event.target.closest<SVGElement>("[data-planet]") : null;
    const scopeId = planet?.dataset.planet;
    const press = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      moved: false,
    };
    gesture.current = scopeId
      ? { ...press, kind: "planet", scopeId, origin: positionOf(scopeId), camera: shownCamera }
      : { ...press, kind: "pan", origin: shownCamera };
  }

  function onPointerMove(event: ReactPointerEvent<SVGSVGElement>) {
    const current = gesture.current;
    if (!current || current.pointerId !== event.pointerId) {
      return;
    }
    const dx = event.clientX - current.startX;
    const dy = event.clientY - current.startY;
    if (!current.moved) {
      if (Math.hypot(dx, dy) < DRAG_THRESHOLD) {
        return;
      }
      // Capturing only once the press is a drag, so a plain click still reaches the planet.
      current.moved = true;
      event.currentTarget.setPointerCapture(event.pointerId);
      if (current.kind === "planet") {
        // The view holds still while planets move, or it would refit under the pointer.
        setCamera(current.camera);
        setDraggedScope(current.scopeId);
        setRearranged(true);
      }
    }
    if (current.kind === "pan") {
      setCamera({ ...current.origin, x: current.origin.x + dx, y: current.origin.y + dy });
    } else {
      simulation.hold({
        scopeId: current.scopeId,
        at: {
          x: current.origin.x + dx / current.camera.scale,
          y: current.origin.y + dy / current.camera.scale,
        },
      });
    }
  }

  function onPointerEnd(event: ReactPointerEvent<SVGSVGElement>) {
    if (gesture.current?.pointerId !== event.pointerId) {
      return;
    }
    // The click that ends a drag is not a selection.
    swallowClick.current = gesture.current.moved;
    if (gesture.current.kind === "planet") {
      simulation.release();
      setDraggedScope(null);
    }
    gesture.current = null;
  }

  function zoomBy(factor: number) {
    if (shownCamera && size) {
      setCamera(zoomAt(shownCamera, size.width / 2, size.height / 2, factor));
    }
  }

  const scale = shownCamera?.scale ?? 1;
  // How much world-sized text grows so that it is at least `minimum` pixels tall on screen.
  const readable = (fontSize: number, minimum: number) => Math.max(1, minimum / (fontSize * scale));
  const workflowScale = workflowGrowth(scale);
  const forwardEmphasis = (forward: UniverseForward) =>
    lit === null || lit.has(forwardKey(forward)) ? 1 : DIMMED;
  // Forwards and calls share one field of ways around the planets, worked out once per frame.
  const field = useMemo(() => universeField(positions, scale), [positions, scale]);
  const drawnForwards = useMemo(
    () => routeForwards(field, planets, forwards),
    [field, planets, forwards],
  );
  const landedOrbits = useMemo(
    () => orbitLandings(field, planets, drawnForwards),
    [field, planets, drawnForwards],
  );
  const routeCalls = useMemo(
    () => (shownCamera ? callRouter(field, planets, tiles, shownCamera) : null),
    [field, planets, tiles, shownCamera],
  );
  // Calls only show for a focused workflow or outside system; at rest, or for a whole planet, they
  // would cross every planet.
  const litCalls = useMemo(
    () => (lit ? calls.filter((call) => lit.has(callKey(call))) : NO_CALLS),
    [lit, calls],
  );
  const drawnCalls = useMemo(
    () => (routeCalls ? routeCalls(litCalls) : []),
    [routeCalls, litCalls],
  );
  const frame = size
    ? {
        x: FRAME_INSET,
        y: FRAME_INSET,
        width: size.width - FRAME_INSET * 2,
        height: size.height - FRAME_INSET * 2,
      }
    : null;

  return (
    <div
      ref={containerRef}
      className="relative h-full min-h-[420px] w-full overflow-hidden rounded-[6px] border border-[var(--bo-border)] bg-[var(--bo-bg)]"
    >
      <svg
        ref={svgRef}
        role="group"
        aria-label="Automation across scopes"
        className="absolute inset-0 size-full cursor-grab touch-none select-none active:cursor-grabbing"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerEnd}
        onPointerCancel={onPointerEnd}
        onClickCapture={(event) => {
          if (swallowClick.current) {
            swallowClick.current = false;
            event.stopPropagation();
          }
        }}
        onClick={() => {
          setPinned(null);
        }}
        // Escape unpins from the keyboard, as clicking the background does with a pointer.
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            setPinned(null);
          }
        }}
      >
        <ActionMarkerDefs idPrefix={idPrefix} />
        <defs>
          <pattern
            id={`${idPrefix}-grid`}
            width={24}
            height={24}
            patternUnits="userSpaceOnUse"
            patternTransform={shownCamera ? `translate(${shownCamera.x} ${shownCamera.y})` : ""}
          >
            <circle cx={1} cy={1} r={1} className="fill-[var(--bo-border)]" />
          </pattern>
        </defs>
        {/* Outside the frame lies the rest of the world; the planets only show within it. */}
        <rect width="100%" height="100%" className="fill-[var(--bo-panel)]" />
        {frame ? (
          <>
            <clipPath id={`${idPrefix}-inside`}>
              <rect {...frame} rx={10} />
            </clipPath>
            <rect {...frame} rx={10} className="fill-[var(--bo-bg)]" />
            <rect {...frame} rx={10} fill={`url(#${idPrefix}-grid)`} />
          </>
        ) : null}

        {shownCamera ? (
          <>
            {/* Calls run under the planets and out across the frame to the outside systems. */}
            <g
              transform={`translate(${shownCamera.x} ${shownCamera.y}) scale(${shownCamera.scale})`}
              className="pointer-events-none"
            >
              {drawnCalls.map(({ call, path }) => (
                <path
                  key={call.id}
                  d={path}
                  className={`fill-none ${ACTION_EDGE_CLASS_NAME.start_workflow}`}
                  strokeWidth={1 / scale}
                  strokeLinecap="round"
                  markerEnd={actionMarkerUrl(idPrefix, "start_workflow")}
                />
              ))}
            </g>
            <g clipPath={`url(#${idPrefix}-inside)`}>
              <g
                transform={`translate(${shownCamera.x} ${shownCamera.y}) scale(${shownCamera.scale})`}
              >
                {/* Forwards run under the planets; only their labels sit on top. */}
                <g className="pointer-events-none">
                  {/* Under the forwards that land on it, which nothing on the planet listens to. */}
                  {landedOrbits.map(({ scopeId, forwards: landed, path }) => (
                    <path
                      key={`${scopeId}|${landed.map(({ id }) => id).join("|")}`}
                      d={path}
                      opacity={Math.max(...landed.map(forwardEmphasis))}
                      className={`fill-none stroke-[var(--bo-border-strong)] transition-opacity duration-200 ${finishedLoading.has(scopeId) ? "bo-planet-reveal" : ""}`}
                      strokeWidth={Math.max(3, 2 / scale)}
                      strokeLinecap="round"
                    />
                  ))}
                  {drawnForwards.map(({ forward, path }) => (
                    // A forward into a planet that just finished loading moves from its ring to its
                    // event, so it fades in there instead of jumping.
                    <g
                      key={forward.id}
                      opacity={forwardEmphasis(forward)}
                      className={`transition-opacity duration-200 ${finishedLoading.has(forward.toScopeId) ? "bo-planet-reveal" : ""}`}
                    >
                      <path
                        d={path}
                        className={`fill-none ${ACTION_EDGE_CLASS_NAME[FORWARD_EDGE]}`}
                        strokeWidth={Math.max(1.8, MIN_SCREEN_STROKE / scale)}
                        strokeDasharray={ACTION_EDGE_DASH[FORWARD_EDGE]}
                        strokeLinecap="round"
                        markerEnd={actionMarkerUrl(idPrefix, FORWARD_EDGE)}
                      />
                    </g>
                  ))}
                </g>

                {planets.map((planet) => {
                  const { scope } = planet;
                  const position = positionOf(scope.id);
                  const label = scope.graph.scopeLabel;
                  return (
                    <g
                      key={scope.id}
                      data-planet={scope.id}
                      transform={`translate(${position.x} ${position.y})`}
                      aria-label={`${label} scope`}
                      className="cursor-grab outline-none"
                      {...focusHandlers({ kind: "scope", id: scope.id })}
                    >
                      {/* The focused planet stays readable; only what it sends elsewhere is lit. */}
                      <PlanetBody
                        planet={planet}
                        idPrefix={idPrefix}
                        lit={focusedScope === scope.id ? null : lit}
                        workflowScale={workflowScale}
                        finishedLoading={finishedLoading.get(scope.id) ?? null}
                        focusRingWidth={focusedScope === scope.id ? Math.max(2, 1.2 / scale) : null}
                      />
                      {/* The focused planet shows whole; the corner card names it instead. */}
                      {scale < OVERVIEW_SCALE && focusedScope !== scope.id ? (
                        <ScopeNameTag label={label} grow={readable(24, MIN_TAG_FONT)} />
                      ) : null}
                    </g>
                  );
                })}

                {/* Over the planets, so each workflow answers the pointer within its own orbit. */}
                {planets.map((planet) => {
                  const { scope } = planet;
                  const position = positionOf(scope.id);
                  return (
                    <g
                      key={scope.id}
                      data-planet={scope.id}
                      transform={`translate(${position.x} ${position.y})`}
                    >
                      {planet.layout.workflows.map(({ workflow, angle }) => {
                        const target = {
                          kind: "workflow",
                          id: workflowFocusId(scope.id, workflow.id),
                          scopeId: scope.id,
                          workflowId: workflow.id,
                        } as const;
                        const [x, y] = polar(angle, PLANET_ORBIT_RADIUS);
                        return (
                          <g
                            key={workflow.id}
                            transform={`translate(${x} ${y}) scale(${workflowScale})`}
                            aria-label={`${workflow.label} workflow`}
                            className="cursor-pointer outline-none"
                            {...focusHandlers(target)}
                          >
                            <circle r={WORKFLOW_HIT_RADIUS} className="fill-transparent" />
                            {sameFocus(focus, target) ? (
                              <circle
                                r={WORKFLOW_HIT_RADIUS}
                                className="pointer-events-none fill-none stroke-[var(--bo-accent)]/60"
                                strokeWidth={Math.max(1.5, 1.2 / (scale * workflowScale))}
                                strokeDasharray="5 4"
                              />
                            ) : null}
                          </g>
                        );
                      })}
                    </g>
                  );
                })}

                {/* Labels of forwards outside the focus would only crowd it. */}
                <g className="pointer-events-none">
                  {drawnForwards.map(({ forward, middle }) => {
                    if (lit && !lit.has(forwardKey(forward))) {
                      return null;
                    }
                    const width =
                      FORWARD_TAG_WIDTH + forward.label.length * FORWARD_LABEL_CHAR_WIDTH + 18;
                    const left = middle.x - width / 2;
                    const grow = readable(FORWARD_LABEL_FONT, MIN_FORWARD_FONT);
                    return (
                      <g
                        key={forward.id}
                        transform={`translate(${middle.x} ${middle.y}) scale(${grow}) translate(${-middle.x} ${-middle.y})`}
                        className={
                          finishedLoading.has(forward.toScopeId) ? "bo-planet-reveal" : undefined
                        }
                      >
                        <rect
                          x={left}
                          y={middle.y - FORWARD_LABEL_HEIGHT / 2}
                          width={width}
                          height={FORWARD_LABEL_HEIGHT}
                          rx={4}
                          className="fill-[var(--bo-panel)] stroke-[var(--bo-border-strong)]"
                          strokeWidth={1}
                        />
                        <text
                          x={left + 9}
                          y={middle.y}
                          dominantBaseline="central"
                          fontSize={FORWARD_LABEL_FONT}
                          className="fill-[var(--bo-fg)]"
                        >
                          <tspan
                            fontSize={9.5}
                            className="fill-violet-700 font-semibold tracking-[0.12em] dark:fill-violet-300"
                          >
                            {FORWARD_TAG}
                          </tspan>
                          <tspan dx={6}>{forward.label}</tspan>
                        </text>
                      </g>
                    );
                  })}
                </g>
              </g>
            </g>
          </>
        ) : null}

        {frame ? (
          <rect
            {...frame}
            rx={10}
            className="pointer-events-none fill-none stroke-[var(--bo-border-strong)]"
            strokeWidth={1}
          />
        ) : null}
        {tiles.map((tile) => {
          const target = { kind: "external", id: tile.external.id } as const;
          const count = callCounts.get(tile.external.id) ?? 0;
          return (
            <g
              key={tile.external.id}
              data-external={tile.external.id}
              aria-label={`${tile.external.label}, called by ${count} ${count === 1 ? "workflow" : "workflows"}`}
              className="cursor-pointer outline-none"
              {...focusHandlers(target)}
            >
              <ExternalTileShape
                tile={tile}
                focused={sameFocus(focus, target)}
                opacity={lit === null || lit.has(externalKey(tile.external.id)) ? 1 : DIMMED_TILE}
              />
            </g>
          );
        })}
      </svg>

      {focus ? (
        <FocusCard
          {...describeFocus(focus, planets, forwards, externals, calls)}
          pinned={sameFocus(pinned, focus)}
          onClear={() => {
            setPinned(null);
          }}
        />
      ) : null}

      <div
        style={{ top: FRAME_PADDING - 6, right: FRAME_PADDING - 6 }}
        className="absolute flex items-center gap-0.5 rounded-[6px] border border-[var(--bo-border)] bg-[var(--bo-panel)] p-0.5 shadow-sm"
      >
        <IconButton
          label="Zoom in"
          onClick={() => {
            zoomBy(ZOOM_STEP);
          }}
        >
          <Icon name="plus" className="size-4" />
        </IconButton>
        <IconButton
          label="Zoom out"
          onClick={() => {
            zoomBy(1 / ZOOM_STEP);
          }}
        >
          <Icon name="minus" className="size-4" />
        </IconButton>
        <IconButton
          label="Fit to view"
          onClick={() => {
            setCamera(fitted);
          }}
        >
          <Icon name="maximize" className="size-4" />
        </IconButton>
        <IconButton
          label="Reset layout"
          disabled={!rearranged}
          onClick={() => {
            simulation.rearrange();
            setRearranged(false);
            setCamera(null);
          }}
        >
          <Icon name="rotate-ccw" className="size-4" />
        </IconButton>
      </div>
    </div>
  );
}
