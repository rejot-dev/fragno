import { Popover } from "@base-ui/react/popover";
import {
  type CSSProperties,
  type PointerEvent,
  type ReactNode,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { cn } from "../cn";
import {
  CAUSAL_FLAME_AXIS_HEADROOM,
  type CausalFlameBar,
  type CausalFlameNode,
  type CausalFlameNodeKind,
  type CausalFlameStatus,
  causalFlameActiveNode,
  causalFlameBarAt,
  causalFlameIsLive,
  causalFlameNodeEnd,
  causalFlameNodeStart,
  causalFlamePath,
  causalFlamePosition,
  causalFlameScale,
  causalFlameShowsDetail,
  causalFlameTicks,
  causalFlameTimeAt,
  countCausalFlameNodes,
  layoutCausalFlame,
  newestCausalFlameMoment,
} from "./causal-flame-graph-model";
import { Icon } from "./icon";
import { TimelineReplayControls, useTimelineReplay } from "./timeline-replay";
import { formatWorkflowDuration, type WorkflowTimeScale } from "./workflow-run-timeline-model";

const ROW_HEIGHT = 30;
const LIVE_TICK_MS = 1_000;

const KIND_COLOR: Record<CausalFlameNodeKind, string> = {
  event: "var(--bo-blue-2)",
  route: "var(--bo-muted)",
  workflow: "var(--bo-accent)",
  step: "var(--bo-live)",
};

const KIND_LABEL: Record<CausalFlameNodeKind, string> = {
  event: "Event",
  route: "Route",
  workflow: "Workflow",
  step: "Step",
};

const STATUS_LABEL: Record<CausalFlameStatus, string> = {
  pending: "Pending",
  running: "Running",
  waiting: "Waiting",
  ok: "Ok",
  skipped: "Skipped",
  failed: "Failed",
};

/** Failures and stalls override the kind's color, so they stand out wherever they sit in a tree. */
function barColor(node: CausalFlameNode): string {
  switch (node.status) {
    case "failed":
      return "var(--bo-failed)";
    case "waiting":
      return "var(--bo-waiting)";
    case "pending":
    case "skipped":
      return "var(--bo-muted-2)";
    case "running":
    case "ok":
      return KIND_COLOR[node.kind];
  }
  throw new Error("Unsupported causal flame status.");
}

function percent(position: number): string {
  return `${position * 100}%`;
}

/**
 * A flame chart of everything one origin event set in motion: the events routes derived from it,
 * the workflows they started, the steps those ran, and the events the workflows fired in turn.
 * Time runs left to right and causation top to bottom.
 *
 * The replay cursor is owned by the caller, so views beside the chart, such as the steps of the
 * selected run, can follow the same playhead.
 *
 * While following, the chart selects whatever is in progress at the playhead, or now on a live
 * tree, so the view beside it shows what is happening. Selecting a node by hand stops following
 * until the reader follows again or plays the replay.
 */
export function CausalFlameGraph({
  title,
  root,
  selectedId,
  emphasizedId,
  onSelect,
  cursor,
  onCursorChange,
  surface,
}: {
  title: string;
  root: CausalFlameNode;
  selectedId: string | null;
  /** A node another view points at, such as the step row under the pointer in a step list. */
  emphasizedId: string | null;
  /** `null` when the reader clears the selection by selecting the selected node again. */
  onSelect: (nodeId: string | null) => void;
  /** The replayed moment, or `null` to show the tree as it is now. */
  cursor: number | null;
  onCursorChange: (cursor: number | null) => void;
  /** A standalone padded card, or flush against the edges of a surface that already frames it. */
  surface: "card" | "flush";
}) {
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [hovered, setHovered] = useState<Hover | null>(null);
  // Zooming into a node that has since left the tree falls back to the whole tree.
  const focusPath = focusedId === null ? [] : causalFlamePath(root, focusedId);
  const shown = focusPath.at(-1) ?? root;

  const now = useNow(root);
  const scale = useMemo(() => causalFlameScale(shown, now), [shown, now]);
  const layout = useMemo(() => layoutCausalFlame(shown, scale, now), [shown, scale, now]);
  const timelineReplay = useTimelineReplay({ scale, cursor, onCursorChange });
  const [following, setFollowing] = useState(true);
  const replay = {
    ...timelineReplay,
    play() {
      setFollowing(true);
      timelineReplay.play();
    },
  };
  useFollowActiveNode({
    root: shown,
    at: cursor ?? now,
    tracking: following && (cursor !== null || causalFlameIsLive(shown)),
    onSelect,
  });
  // Bars keep the rows they have at the end, so a replay fills the chart in without reflowing it.
  const drawn = useMemo(
    () =>
      layout.bars.map((bar) => {
        const atCursor = cursor === null ? bar : causalFlameBarAt(bar, scale, cursor);
        return { bar: atCursor ?? bar, happened: atCursor !== null };
      }),
    [layout.bars, scale, cursor],
  );
  const drawnNow = cursor ?? now;
  const counts = useMemo(() => countCausalFlameNodes(shown), [shown]);
  const barsById = useMemo(() => new Map(drawn.map(({ bar }) => [bar.node.id, bar])), [drawn]);
  const upcoming = useMemo(
    () => new Set(drawn.flatMap(({ bar, happened }) => (happened ? [] : [bar.node.id]))),
    [drawn],
  );
  // The cone of the tree's own root is the whole tree, so lighting it would only add noise.
  const highlighted = useMemo(
    () => (selectedId === shown.id ? null : causalCone(root, selectedId)),
    [root, shown.id, selectedId],
  );
  const hoveredBar = hovered === null ? null : (barsById.get(hovered.nodeId) ?? null);
  const playhead = cursor === null ? null : causalFlamePosition(scale, cursor);

  // The tooltip is fixed to where its anchor was, so it closes once anything scrolls under it.
  useEffect(() => {
    if (hovered === null) {
      return undefined;
    }
    const close = () => {
      setHovered(null);
    };
    window.addEventListener("scroll", close, { capture: true, passive: true });
    return () => {
      window.removeEventListener("scroll", close, { capture: true });
    };
  }, [hovered]);

  function focus(nodeId: string | null) {
    setFocusedId(nodeId === root.id ? null : nodeId);
    setHovered(null);
  }

  return (
    <section
      aria-label={`Causal flame graph ${title}`}
      className={
        surface === "card"
          ? "overflow-hidden rounded-[6px] border border-[color:var(--bo-border)] bg-[var(--bo-panel)] text-[var(--bo-fg)] shadow-[var(--bo-panel-shadow)]"
          : "min-w-0 text-[var(--bo-fg)]"
      }
    >
      <header
        className={cn(
          "flex items-center gap-x-4 text-xs",
          surface === "card"
            ? "flex-wrap gap-y-2 px-4 pt-3 pb-2"
            : "h-9 border-b border-[color:var(--bo-border)]",
        )}
      >
        <h3
          className={cn(
            "min-w-0 truncate font-semibold",
            surface === "card" ? "text-base tracking-tight" : "text-sm",
          )}
        >
          {title}
        </h3>
        <p className="flex shrink-0 items-center gap-3 text-[var(--bo-muted)]">
          <Fact noun="event" value={counts.event} />
          <Fact noun="route" value={counts.route} />
          <Fact noun="workflow" value={counts.workflow} />
          <Fact noun="step" value={counts.step} />
          {counts.failed === 0 ? null : (
            <span className="inline-flex items-center gap-1.5 font-medium text-[var(--bo-failed)]">
              <span className="size-1.5 rounded-full bg-current" aria-hidden="true" />
              {counts.failed} failed
            </span>
          )}
        </p>
        <div className="ml-auto flex shrink-0 items-center gap-1.5">
          <TimelineReplayControls
            replay={replay}
            scale={scale}
            horizon={cursor ?? scale.endedAt}
            subject="trace"
          />
          <button
            type="button"
            aria-pressed={following}
            title="Select whatever is in progress as the trace plays"
            onClick={() => {
              setFollowing((current) => !current);
            }}
            className={cn(
              "inline-flex h-7 items-center gap-1.5 rounded-[4px] px-2 text-xs transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-[color:var(--bo-accent)]/30 focus-visible:outline-none",
              following
                ? "bg-[color-mix(in_srgb,var(--bo-accent)_12%,transparent)] text-[var(--bo-accent-fg)]"
                : "text-[var(--bo-muted)] hover:bg-[var(--bo-panel-2)] hover:text-[var(--bo-fg)]",
            )}
          >
            <Icon name="crosshair" className="size-3.5" />
            Follow
          </button>
          <Key
            idle={scale.segments.some((segment) => segment.idle)}
            canZoom={layout.bars.some((bar) => bar.node.children.length > 0)}
          />
        </div>
      </header>

      {focusPath.length > 1 ? (
        <FocusTrail path={focusPath} onFocus={focus} inset={surface === "card"} />
      ) : null}

      {/* Instants are centered on their moment, so even flush the chart keeps half a mark of inset. */}
      <div className={cn("overflow-x-auto pb-1", surface === "card" ? "px-4" : "px-2")}>
        <div className="min-w-[40rem]">
          <Axis
            scale={scale}
            playhead={playhead}
            onScrub={(position) => {
              replay.seek(causalFlameTimeAt(scale, position));
            }}
          />
          <div
            role="list"
            aria-label="Causal chain"
            className="relative"
            style={{ height: layout.rowCount * ROW_HEIGHT + 8 }}
            onMouseLeave={() => {
              setHovered(null);
            }}
          >
            <Gridlines scale={scale} />
            <Connectors
              bars={drawn.map(({ bar }) => bar)}
              barsById={barsById}
              highlighted={highlighted}
              upcoming={upcoming}
            />
            {drawn.map(({ bar, happened }) => (
              <Bar
                key={bar.node.id}
                bar={bar}
                now={drawnNow}
                selected={bar.node.id === selectedId}
                zoomable={bar.node.id !== shown.id && bar.node.children.length > 0}
                emphasized={bar.node.id === emphasizedId}
                presence={
                  !happened
                    ? "upcoming"
                    : highlighted !== null && !highlighted.has(bar.node.id)
                      ? "dimmed"
                      : "shown"
                }
                onSelect={() => {
                  setFollowing(false);
                  onSelect(bar.node.id === selectedId ? null : bar.node.id);
                }}
                onZoom={() => {
                  focus(bar.node.id);
                }}
                onHover={(anchor) => {
                  setHovered(anchor === null ? null : { nodeId: bar.node.id, anchor });
                }}
              />
            ))}
            {playhead === null ? null : (
              <span
                aria-hidden="true"
                className="pointer-events-none absolute inset-y-0 w-px bg-[var(--bo-accent)]"
                style={{ left: percent(playhead) }}
              />
            )}
            {hovered === null || hoveredBar === null ? null : (
              <Tooltip
                bar={hoveredBar}
                zoomable={hoveredBar.node.id !== shown.id && hoveredBar.node.children.length > 0}
                anchor={hovered.anchor}
                now={drawnNow}
                origin={causalFlameNodeStart(shown)}
              />
            )}
          </div>
        </div>
      </div>
    </section>
  );
}

function Fact({ noun, value }: { noun: string; value: number }) {
  return (
    <span className="inline-flex items-baseline gap-1">
      <span className="font-medium text-[var(--bo-fg)] tabular-nums">{value}</span>
      {value === 1 ? noun : `${noun}s`}
    </span>
  );
}

/** Ancestors of the selection explain why it happened; descendants show what it caused. */
function causalCone(root: CausalFlameNode, selectedId: string | null): ReadonlySet<string> | null {
  if (selectedId === null) {
    return null;
  }
  const path = causalFlamePath(root, selectedId);
  const selected = path.at(-1);
  if (!selected) {
    return null;
  }
  const ids = new Set(path.map((node) => node.id));
  (function addDescendants(node: CausalFlameNode) {
    for (const child of node.children) {
      ids.add(child.id);
      addDescendants(child);
    }
  })(selected);
  return ids;
}

function FocusTrail({
  path,
  onFocus,
  inset,
}: {
  path: readonly CausalFlameNode[];
  onFocus: (nodeId: string) => void;
  inset: boolean;
}) {
  return (
    <nav
      aria-label="Zoomed into"
      className={cn(
        "flex items-center gap-1 border-y border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] py-1.5 text-xs",
        inset ? "px-4" : "px-1",
      )}
    >
      <button
        type="button"
        onClick={() => {
          onFocus(path[0]?.id ?? "");
        }}
        className="inline-flex items-center gap-1 rounded-[3px] px-1 py-0.5 text-[var(--bo-muted)] transition-colors duration-150 hover:text-[var(--bo-fg)] focus-visible:ring-2 focus-visible:ring-[color:var(--bo-accent)]/30 focus-visible:outline-none"
      >
        <Icon name="zoom-out" className="size-3" />
        Whole tree
      </button>
      {path.slice(1).map((node, index, rest) => (
        <span key={node.id} className="flex min-w-0 items-center gap-1">
          <Icon name="chevron-right" className="size-3 shrink-0 text-[var(--bo-muted-2)]" />
          {index === rest.length - 1 ? (
            <span aria-current="location" className="truncate font-medium">
              {node.label}
            </span>
          ) : (
            <button
              type="button"
              onClick={() => {
                onFocus(node.id);
              }}
              className="truncate rounded-[3px] px-1 py-0.5 text-[var(--bo-muted)] transition-colors duration-150 hover:text-[var(--bo-fg)] focus-visible:ring-2 focus-visible:ring-[color:var(--bo-accent)]/30 focus-visible:outline-none"
            >
              {node.label}
            </button>
          )}
        </span>
      ))}
    </nav>
  );
}

/**
 * Pressing or dragging along the axis moves the replay playhead there. It is hidden from assistive
 * technology because the replay slider offers the same control.
 */
function Axis({
  scale,
  playhead,
  onScrub,
}: {
  scale: WorkflowTimeScale;
  playhead: number | null;
  /** A position on the drawn axis, from 0 to 1. */
  onScrub: (position: number) => void;
}) {
  const ticks = useMemo(() => causalFlameTicks(scale), [scale]);
  function scrub(event: PointerEvent<HTMLDivElement>) {
    const box = event.currentTarget.getBoundingClientRect();
    onScrub(Math.min(Math.max((event.clientX - box.left) / box.width, 0), 1));
  }
  return (
    <div
      aria-hidden="true"
      title="Drag to replay from any moment"
      className="relative h-6 cursor-col-resize touch-none border-b border-[color:var(--bo-border)] text-[10px] text-[var(--bo-muted-2)] select-none"
      onPointerDown={(event) => {
        event.currentTarget.setPointerCapture(event.pointerId);
        scrub(event);
      }}
      onPointerMove={(event) => {
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
          scrub(event);
        }
      }}
    >
      {ticks.map((tick) => (
        <span
          key={tick.position}
          className="absolute top-1/2 -translate-x-1/2 -translate-y-1/2 whitespace-nowrap tabular-nums first:translate-x-0"
          style={{ left: percent(tick.position) }}
        >
          {tick.offset === 0 && !tick.afterIdle
            ? "0s"
            : // Rounding to tenths would label quarter-second ticks "+0.3s" and "+0.8s".
              tick.offset < 1_000
              ? `+${tick.offset}ms`
              : `+${formatWorkflowDuration(tick.offset, "fine")}`}
        </span>
      ))}
      {scale.segments.map((segment) =>
        segment.idle ? (
          <span
            key={segment.from}
            title={`Nothing happened for ${formatWorkflowDuration(segment.to - segment.from, "coarse")}`}
            className="absolute top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-[3px] bg-[var(--bo-panel)] px-1 whitespace-nowrap tabular-nums"
            style={{
              left: percent((segment.position + segment.width / 2) / CAUSAL_FLAME_AXIS_HEADROOM),
            }}
          >
            {formatWorkflowDuration(segment.to - segment.from, "coarse")} idle
          </span>
        ) : null,
      )}
      {playhead === null ? null : (
        <span
          className="absolute -bottom-[3px] h-[7px] w-[7px] -translate-x-1/2 rotate-45 rounded-[1.5px] bg-[var(--bo-accent)]"
          style={{ left: percent(playhead) }}
        />
      )}
    </div>
  );
}

function Gridlines({ scale }: { scale: WorkflowTimeScale }) {
  const ticks = useMemo(() => causalFlameTicks(scale), [scale]);
  return (
    <div aria-hidden="true" className="pointer-events-none absolute inset-0">
      {ticks.map((tick) => (
        <span
          key={tick.position}
          className="absolute inset-y-0 w-px bg-[var(--bo-border)] opacity-70"
          style={{ left: percent(tick.position) }}
        />
      ))}
      {scale.segments.map((segment) =>
        segment.idle ? (
          <span
            key={segment.from}
            className="absolute inset-y-0 bg-[repeating-linear-gradient(135deg,var(--bo-border)_0_1px,transparent_1px_6px)] opacity-80"
            style={{
              left: percent(segment.position / CAUSAL_FLAME_AXIS_HEADROOM),
              width: percent(segment.width / CAUSAL_FLAME_AXIS_HEADROOM),
            }}
          />
        ) : null,
      )}
    </div>
  );
}

function rowCenter(row: number): number {
  return row * ROW_HEIGHT + ROW_HEIGHT / 2 + 4;
}

const BAR_HALF_HEIGHT: Record<CausalFlameNodeKind, number> = {
  event: 5,
  route: 4,
  workflow: 10,
  step: 7,
};

/**
 * Each child hangs from the moment on its parent when it was caused: the event's instant, or the
 * point in a workflow's run when it fired the event.
 */
function Connectors({
  bars,
  barsById,
  highlighted,
  upcoming,
}: {
  bars: readonly CausalFlameBar[];
  barsById: ReadonlyMap<string, CausalFlameBar>;
  highlighted: ReadonlySet<string> | null;
  /** Nodes a replay has not reached yet. */
  upcoming: ReadonlySet<string>;
}) {
  return (
    <svg
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 h-full w-full overflow-visible"
    >
      {bars.map((bar) => {
        const parent = bar.parentId === null ? null : barsById.get(bar.parentId);
        // A lane right under its run already shows whose steps it holds.
        if (!parent || (bar.labelSide === "inside" && bar.row === parent.row + 1)) {
          return null;
        }
        const anchor = Math.min(Math.max(bar.queuedFrom, parent.queuedFrom), parent.to);
        const top = rowCenter(parent.row) + BAR_HALF_HEIGHT[parent.node.kind];
        const bottom = rowCenter(bar.row);
        const lit =
          highlighted !== null && highlighted.has(bar.node.id) && highlighted.has(parent.node.id);
        const stroke = lit ? "var(--bo-accent)" : "var(--bo-muted-2)";
        const opacity = upcoming.has(bar.node.id)
          ? 0.1
          : lit
            ? 0.9
            : highlighted === null
              ? 0.45
              : 0.18;
        // A label before its bar sits between the anchor and the bar, so the line reaches the bar
        // through the gap above the label instead of striking through it.
        const turn = bar.labelSide === "start" ? rowCenter(bar.row) - ROW_HEIGHT / 2 + 2 : bottom;
        return (
          <g key={bar.node.id} stroke={stroke} strokeOpacity={opacity} strokeWidth={lit ? 1.5 : 1}>
            <line x1={percent(anchor)} y1={top} x2={percent(anchor)} y2={turn} />
            {bar.queuedFrom > anchor ? (
              <>
                <line x1={percent(anchor)} y1={turn} x2={percent(bar.queuedFrom)} y2={turn} />
                {turn === bottom ? null : (
                  <line
                    x1={percent(bar.queuedFrom)}
                    y1={turn}
                    x2={percent(bar.queuedFrom)}
                    y2={bottom - BAR_HALF_HEIGHT[bar.node.kind]}
                  />
                )}
              </>
            ) : null}
            <circle
              cx={percent(anchor)}
              cy={top}
              r={lit ? 2.25 : 1.75}
              fill={stroke}
              fillOpacity={opacity}
              stroke="none"
            />
          </g>
        );
      })}
    </svg>
  );
}

/** `upcoming` bars belong to nodes a replay has not reached yet. */
type BarPresence = "shown" | "dimmed" | "upcoming";

const PRESENCE_CLASS: Record<BarPresence, string> = {
  shown: "opacity-100",
  dimmed: "opacity-35 has-[:hover]:opacity-80",
  upcoming: "opacity-15 has-[:hover]:opacity-50",
};

function Bar({
  bar,
  now,
  selected,
  zoomable,
  emphasized,
  presence,
  onSelect,
  onZoom,
  onHover,
}: {
  bar: CausalFlameBar;
  now: number;
  selected: boolean;
  /** Whether the bar caused anything to zoom into, other than the view already shown. */
  zoomable: boolean;
  emphasized: boolean;
  presence: BarPresence;
  onSelect: () => void;
  onZoom: () => void;
  /** The hovered or focused element's box, or `null` when the pointer or focus leaves. */
  onHover: (anchor: DOMRect | null) => void;
}) {
  const { node, labelSide } = bar;
  const instant = node.timing.kind === "instant";
  const inlineDetail = causalFlameShowsDetail(node) ? node.detail : null;

  return (
    <div
      role="listitem"
      className={cn(
        // The row spans the whole axis, so only the bar's own parts take the pointer.
        "group pointer-events-none absolute inset-x-0 transition-opacity duration-200 ease-out",
        emphasized ? "opacity-100" : PRESENCE_CLASS[presence],
      )}
      style={
        {
          "--flame-color": barColor(node),
          top: rowCenter(bar.row) - ROW_HEIGHT / 2,
          height: ROW_HEIGHT,
        } as CSSProperties
      }
    >
      {bar.from > bar.queuedFrom ? (
        <span
          aria-hidden="true"
          className="absolute top-1/2 border-t border-dashed border-[color:var(--flame-color)] opacity-60"
          style={{ left: percent(bar.queuedFrom), width: percent(bar.from - bar.queuedFrom) }}
        />
      ) : null}
      {instant ? null : <SpanFill bar={bar} selected={selected} emphasized={emphasized} />}
      {/* Clicks anywhere on the bar or its label land here; the button inside is for keyboards. */}
      <div
        className={cn(
          "pointer-events-auto absolute inset-y-0 flex cursor-pointer items-center",
          labelSide === "start" && "flex-row-reverse",
          labelSide === "inside" && "@container overflow-hidden",
        )}
        style={hitAreaStyle(bar)}
        onClick={onSelect}
        onDoubleClick={zoomable ? onZoom : undefined}
        onMouseEnter={(event) => {
          onHover(event.currentTarget.getBoundingClientRect());
        }}
      >
        <button
          type="button"
          aria-pressed={selected}
          aria-label={`${KIND_LABEL[node.kind]} ${node.label}, ${STATUS_LABEL[node.status]}`}
          onFocus={(event) => {
            // A click also focuses the button; only keyboard focus should open a tooltip that stays.
            if (event.currentTarget.matches(":focus-visible")) {
              onHover(event.currentTarget.parentElement?.getBoundingClientRect() ?? null);
            }
          }}
          onBlur={() => {
            onHover(null);
          }}
          className={cn(
            "flex h-full min-w-0 flex-1 cursor-pointer items-center rounded-[4px] text-left focus-visible:ring-2 focus-visible:ring-[color:var(--flame-color)]/40 focus-visible:outline-none",
            labelSide === "start" && "flex-row-reverse",
          )}
        >
          {instant ? <InstantMark kind={node.kind} selected={selected} /> : null}
          <span
            className={cn(
              "flex min-w-0 items-baseline gap-1.5 text-xs whitespace-nowrap",
              instant ? "px-1.5" : labelSide === "start" ? "pr-1.5" : "pr-2 pl-2.5",
              // Segments too narrow to name are named by their tooltip instead.
              labelSide === "inside" && "@max-[3.5rem]:invisible",
            )}
          >
            <span
              className={cn(
                "truncate decoration-[color:var(--flame-color)] underline-offset-2 group-hover:underline",
                emphasized && "underline",
                node.kind === "step" && !selected ? "text-[var(--bo-muted)]" : "font-medium",
              )}
            >
              {node.label}
            </span>
            {instant ? null : (
              <span
                className={cn(
                  "shrink-0 text-[10px] text-[var(--bo-muted-2)] tabular-nums",
                  labelSide === "inside" && "@max-[9rem]:hidden",
                )}
              >
                {formatWorkflowDuration(
                  causalFlameNodeEnd(node, now) - causalFlameNodeStart(node),
                  "fine",
                )}
              </span>
            )}
            {inlineDetail === null ? null : (
              // Gives way long before the name does when room runs out.
              <span
                className={cn(
                  "min-w-0 shrink-[100] truncate text-[11px]",
                  node.status === "failed" ? "text-[var(--bo-failed)]" : "text-[var(--bo-muted)]",
                )}
              >
                {inlineDetail}
              </span>
            )}
          </span>
        </button>
        {zoomable && selected ? (
          <button
            type="button"
            aria-label={`Zoom into what ${node.label} caused`}
            title="Zoom into what this caused"
            onClick={(event) => {
              event.stopPropagation();
              onZoom();
            }}
            className="relative inline-flex size-5 shrink-0 items-center justify-center rounded-[3px] text-[var(--bo-muted)] transition-[color,background-color,scale] duration-150 ease-out after:absolute after:-inset-2.5 hover:bg-[var(--bo-panel-2)] hover:text-[var(--bo-fg)] focus-visible:ring-2 focus-visible:ring-[color:var(--bo-accent)]/30 focus-visible:outline-none active:scale-[0.96]"
          >
            <Icon name="zoom-in" className="size-3.5" strokeWidth={1.75} />
          </button>
        ) : null}
      </div>
    </div>
  );
}

/**
 * The hit area covers the bar and its label, and stays within the bar's free room in its row, so
 * long labels truncate instead of covering neighbours or widening the chart. Percentages are of
 * the row, which is the whole axis.
 */
function hitAreaStyle(bar: CausalFlameBar): CSSProperties {
  const half = INSTANT_MARK_SIZE / 2;
  const { room } = bar;
  if (bar.node.timing.kind === "instant") {
    return bar.labelSide === "start"
      ? {
          right: `calc(${percent(1 - bar.queuedFrom)} - ${half}px)`,
          maxWidth: `calc(${percent(bar.queuedFrom - room.from)} + ${half}px)`,
        }
      : {
          left: `calc(${percent(bar.queuedFrom)} - ${half}px)`,
          maxWidth: `calc(${percent(room.to - bar.queuedFrom)} + ${half}px)`,
        };
  }
  switch (bar.labelSide) {
    case "inside":
      return { left: percent(bar.from), width: percent(bar.to - bar.from), minWidth: 3 };
    case "start":
      // Padding, like width, resolves against the row, so it reserves the bar after the label.
      return {
        right: percent(1 - bar.to),
        paddingRight: percent(bar.to - bar.from),
        maxWidth: percent(bar.to - room.from),
      };
    case "end":
      return {
        left: percent(bar.from),
        minWidth: percent(bar.to - bar.from),
        maxWidth: percent(room.to - bar.from),
      };
  }
  throw new Error("Unsupported causal flame label side.");
}

const INSTANT_MARK_SIZE = 16;

const INSTANT_MARK_SHAPE: Record<CausalFlameNodeKind, string> = {
  event: "rotate-45 rounded-[2px]",
  // Routes only pass events along, so their mark is hollow.
  route: "rounded-[2px] border-[1.5px] border-[color:var(--flame-color)] bg-[var(--bo-panel)]",
  workflow: "rounded-full",
  step: "rounded-full",
};

function InstantMark({ kind, selected }: { kind: CausalFlameNodeKind; selected: boolean }) {
  const size = kind === "event" ? 9 : 7;
  return (
    <span
      aria-hidden="true"
      className="relative flex shrink-0 items-center justify-center"
      style={{ width: INSTANT_MARK_SIZE, height: INSTANT_MARK_SIZE }}
    >
      {selected ? (
        <span
          className={cn(
            "absolute size-[15px] border-[1.5px] border-[color:var(--flame-color)]",
            kind === "event"
              ? "rotate-45 rounded-[3px]"
              : kind === "route"
                ? "rounded-[3px]"
                : "rounded-full",
          )}
        />
      ) : null}
      <span
        className={cn(
          "bg-[var(--flame-color)] shadow-[0_0_0_2px_var(--bo-panel)] transition-transform duration-150 ease-out group-hover:scale-110",
          INSTANT_MARK_SHAPE[kind],
        )}
        style={{ width: size, height: size }}
      />
    </span>
  );
}

function SpanFill({
  bar,
  selected,
  emphasized,
}: {
  bar: CausalFlameBar;
  selected: boolean;
  emphasized: boolean;
}) {
  const { node } = bar;
  const waits = node.timing.kind === "span" && node.timing.activity === "wait";
  // A run that has not started yet is only an outline of the time it has spent queued.
  const queued = node.timing.kind === "queued";
  const height = BAR_HALF_HEIGHT[node.kind] * 2;
  return (
    <span
      aria-hidden="true"
      className={cn(
        "absolute top-1/2 min-w-[3px] -translate-y-1/2 overflow-hidden rounded-[4px] transition-shadow duration-150",
        queued && "border border-dashed border-[color:var(--flame-color)]",
        selected
          ? "shadow-[0_0_0_1.5px_var(--flame-color),0_0_0_4px_color-mix(in_srgb,var(--flame-color)_18%,transparent)]"
          : !queued &&
              (emphasized
                ? "shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--flame-color)_70%,transparent)]"
                : "shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--flame-color)_38%,transparent)] group-hover:shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--flame-color)_70%,transparent)]"),
      )}
      style={{
        left: percent(bar.from),
        width: percent(bar.to - bar.from),
        height,
        background: queued
          ? "transparent"
          : waits
            ? "repeating-linear-gradient(135deg, color-mix(in srgb, var(--flame-color) 22%, transparent) 0 2px, transparent 2px 6px)"
            : "color-mix(in srgb, var(--flame-color) 14%, var(--bo-panel))",
      }}
    >
      {queued ? null : (
        <span
          className="absolute inset-y-0 left-0 w-[3px]"
          style={{ background: "var(--flame-color)" }}
        />
      )}
      {bar.open ? (
        <>
          <span className="absolute inset-y-0 right-0 w-8 bg-gradient-to-r from-transparent to-[color-mix(in_srgb,var(--flame-color)_30%,transparent)]" />
          {/* A selected bar ends in its zoom button instead. */}
          {selected ? null : (
            <span
              className="absolute top-1/2 right-1 size-1.5 -translate-y-1/2 animate-pulse rounded-full motion-reduce:animate-none"
              style={{ background: "var(--flame-color)" }}
            />
          )}
        </>
      ) : null}
    </span>
  );
}

type Hover = { nodeId: string; anchor: DOMRect };

const TOOLTIP_WIDTH = 256;
const TOOLTIP_GAP = 6;

/**
 * Fixed to the viewport, because the chart scrolls horizontally and would clip anything that
 * overflows it. It opens below its anchor unless that would run past the bottom of the viewport.
 */
function Tooltip({
  bar,
  zoomable,
  anchor,
  now,
  origin,
}: {
  bar: CausalFlameBar;
  zoomable: boolean;
  anchor: DOMRect;
  now: number;
  origin: number;
}) {
  const { node } = bar;
  const color = barColor(node);
  const timing = node.timing;
  const below = anchor.bottom < window.innerHeight * 0.6;
  const left = Math.min(Math.max(anchor.left - 8, 8), window.innerWidth - TOOLTIP_WIDTH - 8);

  return (
    <div
      role="tooltip"
      className="pointer-events-none fixed z-50 rounded-[6px] bg-[var(--bo-panel)] p-3 text-xs shadow-[var(--bo-popover-shadow)]"
      style={{
        width: TOOLTIP_WIDTH,
        left,
        top: below ? anchor.bottom + TOOLTIP_GAP : undefined,
        bottom: below ? undefined : window.innerHeight - anchor.top + TOOLTIP_GAP,
      }}
    >
      <div className="flex items-center gap-2">
        <span className="size-2 shrink-0 rounded-full" style={{ background: color }} />
        <span className="text-[10px] font-medium tracking-wide text-[var(--bo-muted-2)] uppercase">
          {KIND_LABEL[node.kind]}
        </span>
        <span className="ml-auto font-medium" style={{ color }}>
          {STATUS_LABEL[node.status]}
        </span>
      </div>
      <p className="mt-1.5 font-medium [overflow-wrap:anywhere] text-[var(--bo-fg)]">
        {node.label}
      </p>
      {node.detail === null ? null : (
        <p className="mt-0.5 [overflow-wrap:anywhere] text-[var(--bo-muted)]">{node.detail}</p>
      )}
      <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-[var(--bo-muted)] tabular-nums">
        <dt className="text-[var(--bo-muted-2)]">At</dt>
        <dd>+{formatWorkflowDuration(causalFlameNodeStart(node) - origin, "fine")}</dd>
        {timing.kind === "span" && timing.startedAt > timing.queuedAt ? (
          <>
            <dt className="text-[var(--bo-muted-2)]">Queued</dt>
            <dd>{formatWorkflowDuration(timing.startedAt - timing.queuedAt, "fine")}</dd>
          </>
        ) : null}
        {timing.kind === "instant" ? null : (
          <>
            <dt className="text-[var(--bo-muted-2)]">
              {timing.kind === "queued"
                ? "Queued for"
                : timing.activity === "wait"
                  ? "Waited"
                  : "Ran"}
            </dt>
            <dd>
              {formatWorkflowDuration(
                causalFlameNodeEnd(node, now) -
                  (timing.kind === "span" ? timing.startedAt : timing.queuedAt),
                "fine",
              )}
              {bar.open ? " so far" : ""}
            </dd>
          </>
        )}
        {node.children.length === 0 ? null : (
          <>
            <dt className="text-[var(--bo-muted-2)]">Caused</dt>
            <dd>
              {node.children.length} {node.children.length === 1 ? "node" : "nodes"}
            </dd>
          </>
        )}
      </dl>
      {!zoomable ? null : (
        <p className="mt-2 border-t border-[color:var(--bo-border)] pt-1.5 text-[var(--bo-muted-2)]">
          Double-click to zoom into what it caused
        </p>
      )}
    </div>
  );
}

function Key({ idle, canZoom }: { idle: boolean; canZoom: boolean }) {
  return (
    <Popover.Root>
      <Popover.Trigger className="inline-flex h-7 items-center gap-1.5 rounded-[4px] px-2 text-xs text-[var(--bo-muted)] transition-colors duration-150 hover:bg-[var(--bo-panel-2)] hover:text-[var(--bo-fg)] focus-visible:ring-2 focus-visible:ring-[color:var(--bo-accent)]/30 focus-visible:outline-none data-[popup-open]:bg-[var(--bo-panel-2)] data-[popup-open]:text-[var(--bo-fg)]">
        <Icon name="info" className="size-3.5" />
        Key
      </Popover.Trigger>
      <Popover.Portal style={{ position: "relative", zIndex: 2147483647 }}>
        <Popover.Positioner side="bottom" align="end" sideOffset={4} style={{ zIndex: 2147483647 }}>
          <Popover.Popup
            data-backoffice-root
            className="bo-popover-surface w-64 origin-top-right rounded-[6px] border border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-3 text-[11px] text-[var(--bo-muted)] transition-[opacity,scale] duration-150 ease-out outline-none data-[ending-style]:scale-[0.98] data-[ending-style]:opacity-0 data-[starting-style]:scale-[0.98] data-[starting-style]:opacity-0"
          >
            <div className="grid grid-cols-2 gap-x-4 gap-y-2">
              <LegendItem label="Event">
                <span
                  className="size-2 rotate-45 rounded-[1.5px]"
                  style={{ background: KIND_COLOR.event }}
                />
              </LegendItem>
              <LegendItem label="Route">
                <span
                  className="size-2 rounded-[1.5px] border-[1.5px]"
                  style={{ borderColor: KIND_COLOR.route }}
                />
              </LegendItem>
              <LegendItem label="Workflow">
                <LegendSwatch color={KIND_COLOR.workflow} />
              </LegendItem>
              <LegendItem label="Step">
                <LegendSwatch color={KIND_COLOR.step} />
              </LegendItem>
              <LegendItem label="Wait">
                <span
                  className="h-2.5 w-4 rounded-[2px] shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--bo-waiting)_45%,transparent)]"
                  style={{
                    background:
                      "repeating-linear-gradient(135deg, color-mix(in srgb, var(--bo-waiting) 35%, transparent) 0 2px, transparent 2px 5px)",
                  }}
                />
              </LegendItem>
              <LegendItem label="Queued">
                <span className="h-2.5 w-4 rounded-[2px] border border-dashed border-[color:var(--bo-muted-2)]" />
              </LegendItem>
              <LegendItem label="Failed">
                <LegendSwatch color="var(--bo-failed)" />
              </LegendItem>
            </div>
            <ul className="mt-3 space-y-1 border-t border-[color:var(--bo-border)] pt-2 text-[var(--bo-muted-2)]">
              <li>Drag along the time axis to replay from any moment.</li>
              {canZoom ? <li>Double-click a node to zoom into what it caused.</li> : null}
              {idle ? <li>Hatched gaps are compressed idle time.</li> : null}
            </ul>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

function LegendItem({ label, children }: { label: string; children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span aria-hidden="true" className="flex w-4 items-center justify-center">
        {children}
      </span>
      {label}
    </span>
  );
}

function LegendSwatch({ color }: { color: string }) {
  return (
    <span
      className="h-2.5 w-4 overflow-hidden rounded-[2px]"
      style={{
        background: `color-mix(in srgb, ${color} 14%, var(--bo-panel))`,
        boxShadow: `inset 3px 0 0 ${color}, inset 0 0 0 1px color-mix(in srgb, ${color} 38%, transparent)`,
      }}
    />
  );
}

/**
 * Server and client agree on the first render by starting from the newest recorded timestamp;
 * the wall clock only takes over after mount, and only ticks while something is still open.
 */
function useNow(root: CausalFlameNode): number {
  const recorded = useMemo(() => newestCausalFlameMoment(root), [root]);
  const live = useMemo(() => causalFlameIsLive(root), [root]);
  const [now, setNow] = useState<number | null>(null);

  useEffect(() => {
    setNow(Date.now());
    if (!live) {
      return undefined;
    }
    const interval = setInterval(() => {
      setNow(Date.now());
    }, LIVE_TICK_MS);
    return () => {
      clearInterval(interval);
    };
  }, [live]);

  return live && now !== null ? Math.max(now, recorded) : recorded;
}

/**
 * Selects the node in progress at `at` whenever it changes. Moments where nothing is in progress,
 * such as the gap between two steps, keep the last selection.
 */
function useFollowActiveNode({
  root,
  at,
  tracking,
  onSelect,
}: {
  root: CausalFlameNode;
  at: number;
  tracking: boolean;
  onSelect: (nodeId: string) => void;
}) {
  const followedIdRef = useRef<string | null>(null);
  const onSelectRef = useRef(onSelect);
  useEffect(() => {
    onSelectRef.current = onSelect;
  });

  useEffect(() => {
    if (!tracking) {
      followedIdRef.current = null;
      return;
    }
    const active = causalFlameActiveNode(root, at);
    if (active === null || active.id === followedIdRef.current) {
      return;
    }
    followedIdRef.current = active.id;
    onSelectRef.current(active.id);
  }, [root, at, tracking]);
}
