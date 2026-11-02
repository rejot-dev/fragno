import type { KeyboardEvent } from "react";

import { cn } from "../../cn";
import {
  ACTION_EDGE_CLASS_NAME,
  actionMarkerUrl,
  countLabel,
  eventsStartWorkflows,
  TARGET_KIND_PRESENTATION,
} from "./orchestration-graph-parts";
import { HubDetail, SvgIcon } from "./orchestration-radial-parts";
import {
  annularSector,
  degrees,
  fitLabel,
  isLeftHalf,
  labelArc,
  MONO_CHAR_WIDTH,
  polar,
  polarLink,
  SANS_CHAR_WIDTH,
} from "./radial-geometry";
import type { WorkflowTriggerItem, WorkflowTriggerLayout } from "./workflow-trigger-graph-model";

/** The frame one planet fits in with its labels, for a graph that shows it alone. */
export const PLANET_EXTENT = { width: 1200, height: 960 };
const HUB_RADIUS = 92;
const SOURCE_INNER = 104;
const SOURCE_OUTER = 162;
const EVENT_INNER = 166;
const EVENT_OUTER = 276;
/** Where edges leave and reach events, just outside their activity bars. */
export const PLANET_EVENT_EDGE_RADIUS = 283;
const ACTIVITY_OUTER = 281;
/** The orbit workflows sit on. */
export const PLANET_ORBIT_RADIUS = 400;
const WORKFLOW_RADIUS = PLANET_ORBIT_RADIUS;
// Workflows are what a planet is for, so they read at least as large as its rings.
export const PLANET_WORKFLOW_NODE_RADIUS = 24;
const WORKFLOW_NODE_RADIUS = PLANET_WORKFLOW_NODE_RADIUS;
const WORKFLOW_LABEL_MAX_WIDTH = 190;
/** The size workflow names are drawn at, before `workflowScale`. */
export const PLANET_WORKFLOW_LABEL_FONT = 16;
const WORKFLOW_LABEL_FONT = PLANET_WORKFLOW_LABEL_FONT;
const WORKFLOW_RUNNING_FONT = 12.5;
const WORKFLOW_EDGE = "start_workflow";

function scopeSummary(
  layout: WorkflowTriggerLayout,
  forwardCounts: ReadonlyMap<string, number>,
): string {
  const startingEvents = new Set(layout.triggers.map((trigger) => trigger.eventId)).size;
  const forwardedEvents = layout.events.filter(({ event }) => forwardCounts.has(event.id)).length;
  const parts = [
    ...(startingEvents > 0 ? [eventsStartWorkflows(startingEvents, layout.workflows.length)] : []),
    ...(forwardedEvents > 0 ? [`forwards ${countLabel(forwardedEvents, "event")}`] : []),
  ];
  return parts.length === 0 ? "Nothing starts a workflow yet" : parts.join(" · ");
}

/**
 * How a planet's items answer the pointer: each on its own in a single-scope graph, or not at all
 * where the whole planet is what the pointer picks.
 */
export type PlanetItemInteraction =
  | {
      kind: "items";
      /** The item the hub describes. */
      active: WorkflowTriggerItem | null;
      isPinned: (item: WorkflowTriggerItem) => boolean;
      onHover: (item: WorkflowTriggerItem | null) => void;
      onToggle: (item: WorkflowTriggerItem) => void;
    }
  | { kind: "none" };

/**
 * One scope drawn as rings from the centre out: sources, the events of theirs that start a
 * workflow or leave the scope, and the workflows on the orbit around them. It draws in its own
 * coordinates around the origin and leaves hover and selection state to whoever places it.
 */
// Workflows nearer than this around the orbit would run their labels into each other.
const LABEL_NEIGHBOUR_GAP = 0.6;

/**
 * Which way a workflow's label runs from its node: 1 right, -1 left, 0 centred above or below.
 * Labels point away from the vertical axis, so neighbours near the top do not stack them on each
 * other, unless a close neighbour near the top or bottom sits on that side: then the label points
 * away from the neighbour, so two neighbours on one side of the axis split their labels.
 */
function labelSide(angle: number, workflows: WorkflowTriggerLayout["workflows"]): -1 | 0 | 1 {
  const outwardX = Math.sin(angle);
  const nearest = workflows
    .map((other) => Math.atan2(Math.sin(other.angle - angle), Math.cos(other.angle - angle)))
    .filter((delta) => delta !== 0)
    .sort((a, b) => Math.abs(a) - Math.abs(b))[0];
  if (
    nearest !== undefined &&
    Math.abs(nearest) < LABEL_NEIGHBOUR_GAP &&
    Math.abs(Math.cos(angle)) > 0.5
  ) {
    // Clockwise runs rightwards across the top and leftwards across the bottom.
    return Math.sign(Math.cos(angle)) * Math.sign(nearest) > 0 ? -1 : 1;
  }
  return Math.abs(outwardX) < 0.08 ? 0 : outwardX > 0 ? 1 : -1;
}

export function WorkflowTriggerPlanet({
  scopeLabel,
  layout,
  forwardCounts,
  idPrefix,
  markerIdPrefix,
  emphasis,
  interaction,
  workflowScale,
  workflowLabelReach,
}: {
  scopeLabel: string;
  layout: WorkflowTriggerLayout;
  forwardCounts: ReadonlyMap<string, number>;
  /** Unique within the page, for the paths labels follow. */
  idPrefix: string;
  /** The prefix the arrowheads were defined with in the enclosing SVG. */
  markerIdPrefix: string;
  emphasis: (item: WorkflowTriggerItem) => number;
  interaction: PlanetItemInteraction;
  /** How much workflows grow around their place on the orbit, so a zoomed-out view can read them. */
  workflowScale: number;
  /** How far from the centre workflow names may reach before they are cut short. */
  workflowLabelReach: number;
}) {
  const itemsRespond = interaction.kind === "items";
  const active = interaction.kind === "items" ? interaction.active : null;
  const isPinned = (item: WorkflowTriggerItem) =>
    interaction.kind === "items" && interaction.isPinned(item);
  const workflowAngles = new Map(
    layout.workflows.map(({ workflow, angle }) => [workflow.id, angle]),
  );
  const maxRecent = Math.max(1, ...layout.events.map(({ event }) => event.recentCount));

  function interactions(item: WorkflowTriggerItem, label: string) {
    if (interaction.kind === "none") {
      return { className: "transition-opacity duration-200" } as const;
    }
    const toggle = () => {
      interaction.onToggle(item);
    };
    return {
      role: "button",
      tabIndex: 0,
      "aria-label": label,
      "aria-pressed": isPinned(item),
      className: "cursor-pointer transition-opacity duration-200 outline-none",
      onMouseEnter: () => {
        interaction.onHover(item);
      },
      onMouseLeave: () => {
        interaction.onHover(null);
      },
      onFocus: () => {
        interaction.onHover(item);
      },
      onBlur: () => {
        interaction.onHover(null);
      },
      onClick: (event: { stopPropagation: () => void }) => {
        event.stopPropagation();
        toggle();
      },
      onKeyDown: (event: KeyboardEvent<SVGGElement>) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          toggle();
        }
      },
    } as const;
  }

  const hubContent = (() => {
    const triggersOf = (matches: (trigger: (typeof layout.triggers)[number]) => boolean) =>
      layout.triggers.filter(matches);
    if (!active) {
      return (
        <HubDetail
          eyebrow="Scope"
          title={scopeLabel}
          detail={scopeSummary(layout, forwardCounts)}
        />
      );
    }
    switch (active.kind) {
      case "source": {
        const source = layout.sources.find((arc) => arc.source.id === active.id)?.source;
        const triggers = triggersOf((trigger) => trigger.sourceId === active.id);
        return (
          <HubDetail
            eyebrow="Source"
            title={source?.label ?? active.id}
            detail={eventsStartWorkflows(
              new Set(triggers.map((trigger) => trigger.eventId)).size,
              new Set(triggers.map((trigger) => trigger.workflowId)).size,
            )}
          />
        );
      }
      case "event": {
        const event = layout.events.find((arc) => arc.event.id === active.id)?.event;
        const startCount = triggersOf((trigger) => trigger.eventId === active.id).length;
        return event ? (
          <HubDetail
            eyebrow="Event"
            title={`${event.sourceId}.${event.eventType}`}
            detail={[
              ...(startCount > 0 ? [`Starts ${countLabel(startCount, "workflow")}`] : []),
              ...(forwardCounts.has(event.id)
                ? [`forwarded to ${countLabel(forwardCounts.get(event.id) ?? 0, "scope")}`]
                : []),
              `${event.recentCount} recent`,
            ].join(" · ")}
          />
        ) : null;
      }
      case "target": {
        const workflow = layout.workflows.find((node) => node.workflow.id === active.id)?.workflow;
        return workflow ? (
          <HubDetail
            eyebrow="Workflow"
            title={workflow.label}
            detail={`Started by ${countLabel(triggersOf((trigger) => trigger.workflowId === workflow.id).length, "event")} · ${workflow.activeCount} running`}
          />
        ) : null;
      }
    }
    return null;
  })();

  return (
    <g role="group" aria-label={`Workflow triggers for ${scopeLabel}`}>
      <circle
        cx={0}
        cy={0}
        r={WORKFLOW_RADIUS}
        className="fill-none stroke-[var(--bo-border)]"
        strokeDasharray="2 6"
      />

      {/* Edges sit under every node so links never cover a label. */}
      <g className="pointer-events-none">
        {layout.triggers.map(({ eventId, workflowId, angle }) => {
          const targetAngle = workflowAngles.get(workflowId) ?? angle;
          const edgeEmphasis = Math.min(
            emphasis({ kind: "event", id: eventId }),
            emphasis({ kind: "target", id: workflowId }),
          );
          return (
            <path
              key={`${eventId}→${workflowId}`}
              d={polarLink(
                angle,
                ACTIVITY_OUTER + 2,
                targetAngle,
                WORKFLOW_RADIUS - WORKFLOW_NODE_RADIUS * workflowScale - 4,
                0,
              )}
              opacity={edgeEmphasis}
              className={cn(
                "fill-none transition-opacity duration-200",
                ACTION_EDGE_CLASS_NAME[WORKFLOW_EDGE],
              )}
              strokeWidth={1.8}
              markerEnd={actionMarkerUrl(markerIdPrefix, WORKFLOW_EDGE)}
            />
          );
        })}
      </g>

      {layout.sources.map(({ source, startAngle, endAngle }) => {
        const item = { kind: "source", id: source.id } as const;
        const labelRadius = SOURCE_INNER + 18;
        const label = fitLabel(
          source.label,
          (endAngle - startAngle) * labelRadius - 10,
          SANS_CHAR_WIDTH,
        );
        const labelPathId = `${idPrefix}-source-${source.id}`;
        const labelPath = labelArc(startAngle, endAngle, labelRadius);
        const [iconX, iconY] = polar((startAngle + endAngle) / 2, SOURCE_OUTER - 17);
        return (
          <g
            key={source.id}
            {...interactions(item, `${source.label} source`)}
            opacity={emphasis(item)}
          >
            <path
              d={annularSector(startAngle, endAngle, SOURCE_INNER, SOURCE_OUTER)}
              className={cn(
                "fill-lime-500/14 stroke-[var(--bo-bg)] transition-[fill] dark:fill-lime-300/12",
                itemsRespond && "hover:fill-lime-500/24",
                isPinned(item) && "fill-lime-500/30 dark:fill-lime-300/25",
              )}
              strokeWidth={2}
            />
            <SvgIcon
              name={source.icon}
              x={iconX}
              y={iconY}
              size={15}
              className="text-lime-800 dark:text-lime-200"
            />
            {label ? (
              <>
                <path id={labelPathId} d={labelPath} fill="none" />
                <text
                  className="fill-lime-900 text-[12px] font-semibold dark:fill-lime-100"
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

      {layout.events.map(({ event, startAngle, endAngle }) => {
        const item = { kind: "event", id: event.id } as const;
        const middle = (startAngle + endAngle) / 2;
        const tangentialRadius = (EVENT_INNER + EVENT_OUTER) / 2;
        const fitsAlongArc =
          event.eventType.length * MONO_CHAR_WIDTH <=
          (endAngle - startAngle) * tangentialRadius - 14;
        // Narrow events read along the radius instead; the narrowest go unlabelled.
        const radialLabel =
          fitsAlongArc || (endAngle - startAngle) * EVENT_INNER < 13
            ? null
            : fitLabel(event.eventType, EVENT_OUTER - EVENT_INNER - 14, MONO_CHAR_WIDTH);
        const labelPathId = `${idPrefix}-event-${event.id}`;
        const labelPath = labelArc(startAngle, endAngle, tangentialRadius);
        const activityEnd =
          startAngle + (endAngle - startAngle) * Math.min(1, event.recentCount / maxRecent);
        const [labelX, labelY] = polar(middle, tangentialRadius);
        return (
          <g
            key={event.id}
            {...interactions(item, `${event.sourceId}.${event.eventType} event`)}
            opacity={emphasis(item)}
          >
            <path
              d={annularSector(startAngle, endAngle, EVENT_INNER, EVENT_OUTER)}
              className={cn(
                "fill-[var(--bo-accent-bg)] stroke-[var(--bo-bg)] transition-[fill]",
                itemsRespond &&
                  "hover:fill-[color-mix(in_srgb,var(--bo-accent-bg)_80%,var(--bo-accent))]",
                isPinned(item) &&
                  "fill-[color-mix(in_srgb,var(--bo-accent-bg)_65%,var(--bo-accent))]",
              )}
              strokeWidth={2}
            />
            {event.recentCount > 0 ? (
              <path
                d={annularSector(startAngle, activityEnd, EVENT_OUTER + 1, ACTIVITY_OUTER)}
                className="fill-[var(--bo-live)]"
                opacity={0.75}
              />
            ) : null}
            {fitsAlongArc ? (
              <>
                <path id={labelPathId} d={labelPath} fill="none" />
                <text
                  className="fill-[var(--bo-accent-strong)] font-mono text-[11px]"
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
                transform={`rotate(${degrees(middle) + (isLeftHalf(middle) ? 90 : -90)} ${labelX} ${labelY})`}
                textAnchor="middle"
                dominantBaseline="central"
                className="fill-[var(--bo-accent-strong)] font-mono text-[10.5px]"
              >
                {radialLabel}
              </text>
            ) : null}
          </g>
        );
      })}

      {layout.workflows.map(({ workflow, angle }) => {
        const item = { kind: "target", id: workflow.id } as const;
        const presentation = TARGET_KIND_PRESENTATION.workflow;
        const [x, y] = polar(angle, WORKFLOW_RADIUS);
        const side = labelSide(angle, layout.workflows);
        const beside = side !== 0;
        const offset = WORKFLOW_NODE_RADIUS + 10;
        const labelX = x + side * offset;
        const labelRoom = beside
          ? (workflowLabelReach - side * x) / workflowScale - offset - 12
          : WORKFLOW_LABEL_MAX_WIDTH * 1.6;
        const nameY = beside
          ? y - (workflow.activeCount > 0 ? WORKFLOW_RUNNING_FONT * 0.7 : 0)
          : Math.cos(angle) > 0
            ? y - offset - WORKFLOW_LABEL_FONT * 1.4
            : y + offset + 6;
        const label =
          fitLabel(workflow.label, labelRoom, (SANS_CHAR_WIDTH * WORKFLOW_LABEL_FONT) / 12.5) ??
          workflow.label.slice(0, 4);
        return (
          <g
            key={workflow.id}
            {...interactions(item, `${workflow.label} workflow`)}
            opacity={emphasis(item)}
            transform={`translate(${x} ${y}) scale(${workflowScale}) translate(${-x} ${-y})`}
          >
            {workflow.activeCount > 0 ? (
              <circle
                cx={x}
                cy={y}
                r={WORKFLOW_NODE_RADIUS + 5}
                className="fill-none stroke-[var(--bo-live)]"
                strokeWidth={2}
                strokeDasharray="4 3"
              />
            ) : null}
            <circle
              cx={x}
              cy={y}
              r={WORKFLOW_NODE_RADIUS}
              className={cn(
                "fill-[var(--bo-panel)] transition-[stroke-width]",
                presentation.strokeClassName,
              )}
              strokeWidth={isPinned(item) ? 3 : 1.5}
            />
            <SvgIcon
              name={presentation.icon}
              x={x}
              y={y}
              size={WORKFLOW_NODE_RADIUS}
              className={presentation.iconClassName}
            />
            <text
              x={labelX}
              y={nameY}
              textAnchor={side > 0 ? "start" : side < 0 ? "end" : "middle"}
              dominantBaseline="central"
              fontSize={WORKFLOW_LABEL_FONT}
              className="fill-[var(--bo-fg)] font-semibold"
            >
              {label}
              {workflow.activeCount > 0 ? (
                <tspan
                  x={labelX}
                  dy={WORKFLOW_RUNNING_FONT * 1.4}
                  fontSize={WORKFLOW_RUNNING_FONT}
                  className="fill-[var(--bo-live)] font-medium tabular-nums"
                >
                  {workflow.activeCount} running
                </tspan>
              ) : null}
            </text>
          </g>
        );
      })}

      <circle
        cx={0}
        cy={0}
        r={HUB_RADIUS}
        className="fill-[var(--bo-panel)] stroke-[var(--bo-border)]"
      />
      <foreignObject
        x={-HUB_RADIUS}
        y={-HUB_RADIUS}
        width={HUB_RADIUS * 2}
        height={HUB_RADIUS * 2}
        className="pointer-events-none"
      >
        {hubContent}
      </foreignObject>
    </g>
  );
}
