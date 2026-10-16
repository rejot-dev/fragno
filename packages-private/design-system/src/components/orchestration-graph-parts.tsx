import { useEffect, useRef } from "react";

import type { IconName } from "./icon";
import type { OrchestrationRouteAction, OrchestrationTarget } from "./orchestration-graph-model";

/** One observed event travelling through the routes it matched. */
export type OrchestrationPulse = { id: string; eventId: string; routeIds: readonly string[] };

export type ActionKind = OrchestrationRouteAction["kind"];

export const ACTION_EDGE_CLASS_NAME: Record<ActionKind, string> = {
  start_workflow: "stroke-rose-800/70 dark:stroke-rose-300/70",
  send_workflow_event: "stroke-sky-600/80 dark:stroke-sky-300/80",
  forward_event: "stroke-violet-600/75 dark:stroke-violet-300/75",
  notify_agent: "stroke-amber-600/80 dark:stroke-amber-300/80",
  reclassify_event: "stroke-lime-600/80 dark:stroke-lime-300/80",
};

const ACTION_MARKER_CLASS_NAME: Record<ActionKind, string> = {
  start_workflow: "fill-rose-800/80 dark:fill-rose-300/80",
  send_workflow_event: "fill-sky-600 dark:fill-sky-300",
  forward_event: "fill-violet-600 dark:fill-violet-300",
  notify_agent: "fill-amber-600 dark:fill-amber-300",
  reclassify_event: "fill-lime-600 dark:fill-lime-300",
};

// Messages to a running workflow are dashed: they do not create anything, they wake something up.
export const ACTION_EDGE_DASH: Record<ActionKind, string | undefined> = {
  start_workflow: undefined,
  send_workflow_event: "6 5",
  forward_event: "2 4",
  notify_agent: "6 5",
  reclassify_event: undefined,
};

const ACTION_LABEL: Record<ActionKind, string> = {
  start_workflow: "Start workflow",
  send_workflow_event: "Send workflow event",
  forward_event: "Forward event",
  notify_agent: "Notify agent",
  reclassify_event: "Emit event",
};

/** How each kind of route target is drawn in every orchestration graph. */
export const TARGET_KIND_PRESENTATION: Record<
  OrchestrationTarget["kind"],
  {
    icon: IconName;
    strokeClassName: string;
    iconClassName: string;
    badgeClassName: string;
    ringClassName: string;
  }
> = {
  workflow: {
    icon: "share-2",
    strokeClassName: "stroke-rose-800/60 dark:stroke-rose-300/60",
    iconClassName: "text-rose-900 dark:text-rose-200",
    badgeClassName: "bg-rose-950/8 text-rose-950 dark:bg-rose-300/10 dark:text-rose-200",
    ringClassName: "ring-2 ring-rose-900/25 dark:ring-rose-300/25",
  },
  scope: {
    icon: "globe",
    strokeClassName: "stroke-violet-600/70 dark:stroke-violet-300/70",
    iconClassName: "text-violet-700 dark:text-violet-200",
    badgeClassName: "bg-violet-500/10 text-violet-700 dark:text-violet-300",
    ringClassName: "ring-2 ring-violet-600/30",
  },
  agent: {
    icon: "message-square",
    strokeClassName: "stroke-amber-600/70 dark:stroke-amber-300/70",
    iconClassName: "text-amber-700 dark:text-amber-200",
    badgeClassName: "bg-amber-500/10 text-amber-700 dark:text-amber-300",
    ringClassName: "ring-2 ring-amber-600/30",
  },
};

export const DISABLED_EDGE_DASH = "3 4";

export function routeActionLabel(action: OrchestrationRouteAction): string {
  return action.kind === "send_workflow_event"
    ? `Send ${action.eventType}`
    : ACTION_LABEL[action.kind];
}

export function actionMarkerUrl(idPrefix: string, kind: ActionKind): string {
  return `url(#${idPrefix}-${kind})`;
}

/** Arrowheads coloured per action kind; markers cannot inherit the colour of the edge using them. */
export function ActionMarkerDefs({ idPrefix }: { idPrefix: string }) {
  return (
    <defs>
      {(Object.keys(ACTION_MARKER_CLASS_NAME) as ActionKind[]).map((kind) => (
        <marker
          key={kind}
          id={`${idPrefix}-${kind}`}
          viewBox="0 0 10 10"
          refX="8"
          refY="5"
          markerWidth="7"
          markerHeight="7"
          orient="auto-start-reverse"
        >
          <path d="M 0 1 L 9 5 L 0 9 z" className={ACTION_MARKER_CLASS_NAME[kind]} />
        </marker>
      ))}
    </defs>
  );
}

const PULSE_MS = 1700;

/**
 * Flashes the shape of the event that fired and sends a dot along each path it took. SMIL
 * animations added after load would start on the document clock, already finished, so each pulse
 * begins its own animations when it mounts.
 */
export function OrchestrationPulseAnimation({
  flashPath,
  paths,
}: {
  flashPath: string;
  paths: readonly string[];
}) {
  const groupRef = useRef<SVGGElement>(null);
  useEffect(() => {
    for (const animation of groupRef.current?.querySelectorAll("animate, animateMotion") ?? []) {
      (animation as SVGAnimationElement).beginElement();
    }
  }, []);
  const duration = `${PULSE_MS}ms`;

  return (
    <g ref={groupRef} className="pointer-events-none">
      <path d={flashPath} className="fill-[var(--bo-live)]" opacity={0}>
        <animate
          attributeName="opacity"
          values="0;0.45;0"
          dur="900ms"
          begin="indefinite"
          fill="freeze"
        />
      </path>
      {paths.map((path) => (
        <circle key={path} r={5.5} className="fill-[var(--bo-live)]" opacity={0}>
          <animateMotion path={path} dur={duration} begin="indefinite" fill="freeze" />
          <animate
            attributeName="opacity"
            values="0;1;1;0"
            keyTimes="0;0.1;0.85;1"
            dur={duration}
            begin="indefinite"
            fill="freeze"
          />
        </circle>
      ))}
    </g>
  );
}
