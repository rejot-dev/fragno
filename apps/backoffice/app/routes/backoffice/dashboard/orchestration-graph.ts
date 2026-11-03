import type {
  AutomationEventMatcher,
  AutomationForwardAccept,
  AutomationRouteAction,
  AutomationRouteDefinition,
} from "@fragno-dev/backoffice-api/v0/automation";
import {
  backofficeScopePathSegment,
  type BackofficeContextScope,
} from "@fragno-dev/backoffice-api/v0/shared/scope";
import type { IconName } from "@fragno-private/design-system/icon";
import type {
  OrchestrationEvent,
  OrchestrationGraph,
  OrchestrationInlet,
  OrchestrationRoute,
  OrchestrationSource,
  OrchestrationTarget,
} from "@fragno-private/design-system/orchestration/orchestration-graph-model";
import { z } from "zod";

import { formatTimestamp } from "../automations/formatting";
import {
  automationRouteMatchesWorkflowInstance,
  automationRouteWorkflowName,
} from "../automations/route-workflow";

export type OrchestrationCatalogSource = { id: string; label: string; description: string };

export type OrchestrationCatalogEvent = {
  source: string;
  eventType: string;
  label: string;
  payloadSchema: unknown;
};

/**
 * An event another scope forwarded into this one, and what lets it in: nothing for a sender that
 * needs no accept, otherwise the scope's accepts that let it through today.
 */
export type OrchestrationForward = {
  eventId: string;
  source: string;
  eventType: string;
  occurredAt: string;
  from: { scope: BackofficeContextScope; routeId: string; routeName: string };
  admittedBy: { kind: "trusted" } | { kind: "accepts"; acceptIds: readonly string[] };
};

const SCHEDULER_SOURCE_ID = "scheduler";
// Codemode workflow instances name the script they run in their params.
const codemodeWorkflowScriptReferenceSchema = z.object({
  program: z.object({ filename: z.string() }),
});

type ActiveWorkflow = {
  workflowName: string;
  remoteWorkflowName: string | null;
  workflowScriptPath: string | null;
};

const SOURCE_ICONS: Record<string, IconName> = {
  telegram: "send",
  otp: "key",
  auth: "key",
  github: "git-branch",
  upload: "upload",
  pi: "cpu",
  scheduler: "calendar",
  api: "code",
  resend: "mail",
  sandbox: "cloud",
  automations: "zap",
  mcp: "disc",
};

/** Event sources are matched case-insensitively, so every id in the graph uses the folded form. */
export function normalizedSourceId(source: string): string {
  return source.trim().toLowerCase();
}

export function orchestrationEventId(source: string, eventType: string): string {
  return `${normalizedSourceId(source)}:${eventType}`;
}

/** Schedules have no source event, so each scheduled route gets a scheduler event of its own. */
function scheduleEventType(route: AutomationRouteDefinition): string {
  return `schedule:${route.id}`;
}

export function routeTriggerEventId(route: AutomationRouteDefinition): string {
  return route.trigger.kind === "schedule"
    ? orchestrationEventId(SCHEDULER_SOURCE_ID, scheduleEventType(route))
    : orchestrationEventId(route.trigger.source, route.trigger.eventType);
}

/** Every action except reclassify ends at a target. */
type TargetedRouteAction = Exclude<AutomationRouteAction, { kind: "reclassify_event" }>;

/** The target node of the workflow a script defines. */
export function workflowTargetId(workflowScriptPath: string): string {
  return `workflow:${workflowScriptPath}`;
}

/** Routes that reach the same workflow or scope share one target node. */
export function routeTargetId(action: TargetedRouteAction): string {
  switch (action.kind) {
    case "start_workflow":
      return workflowTargetId(action.workflowScriptPath);
    case "send_workflow_event":
      return action.target.kind === "instance_id"
        ? `instance:${action.target.template}`
        : `stored-instance:${action.target.keyTemplate}`;
    case "forward_event":
      return `scope:${JSON.stringify(action.targetScope)}`;
    case "notify_agent":
      return `agent:${action.agentName}`;
    case "notify_app":
      return `app:${action.appId}`;
  }
  throw new Error("Unsupported automation route action kind.");
}

function routeTarget(
  route: AutomationRouteDefinition,
  action: TargetedRouteAction,
  activeWorkflows: readonly ActiveWorkflow[],
): OrchestrationTarget {
  const id = routeTargetId(action);
  switch (action.kind) {
    case "start_workflow":
      return {
        id,
        label: automationRouteWorkflowName(route) ?? action.workflowScriptPath,
        kind: "workflow",
        activeCount: activeWorkflows.filter((instance) =>
          automationRouteMatchesWorkflowInstance(route, instance),
        ).length,
      };
    case "send_workflow_event":
      // The instance is only known once an event fills in the template, so neither are its runs.
      return {
        id,
        label:
          action.target.kind === "instance_id"
            ? `Workflow · ${action.target.template}`
            : `Workflow from store · ${action.target.keyTemplate}`,
        kind: "workflow",
        activeCount: 0,
      };
    case "forward_event":
      return { id, label: forwardTargetLabel(action), kind: "scope", activeCount: 0 };
    case "notify_agent":
      return { id, label: action.agentName, kind: "agent", activeCount: 0 };
    case "notify_app":
      return { id, label: action.appId, kind: "app", activeCount: 0 };
  }
  throw new Error("Unsupported automation route action kind.");
}

function forwardTargetLabel(action: Extract<AutomationRouteAction, { kind: "forward_event" }>) {
  const scope = action.targetScope;
  switch (scope.kind) {
    case "system":
      return "System scope";
    case "subject":
      return "The event's subject";
    case "org":
      return `Organization · ${scope.orgIdTemplate}`;
    case "project":
      return `Project · ${scope.projectIdTemplate}`;
    case "user":
      return `User · ${scope.userIdTemplate}`;
    case "app":
      return `App · ${scope.appIdTemplate}`;
    default:
      throw new Error("Unsupported automation route target scope.", {
        cause: scope satisfies never,
      });
  }
}

function scheduleLabel(route: AutomationRouteDefinition): string {
  if (route.trigger.kind !== "schedule") {
    throw new Error("Only scheduled routes have a schedule label.");
  }
  const cadence = route.trigger.cadence;
  return cadence.kind === "once"
    ? `Once · ${formatTimestamp(cadence.at)}`
    : `${cadence.expression} · ${cadence.timeZone}`;
}

/** One line that states what a matcher lets through; the inspector shows the full tree. */
function matcherSummary(matcher: AutomationEventMatcher): string {
  if ("actor" in matcher) {
    return "actor matches";
  }
  if ("all" in matcher) {
    return matcher.all.map((part) => `(${matcherSummary(part)})`).join(" and ");
  }
  if ("any" in matcher) {
    return matcher.any.map((part) => `(${matcherSummary(part)})`).join(" or ");
  }
  if ("not" in matcher) {
    return `not (${matcherSummary(matcher.not)})`;
  }
  return matcher.op === "exists"
    ? `${matcher.path} exists`
    : `${matcher.path} ${matcher.op} ${JSON.stringify(matcher.value)}`;
}

const SCOPE_ICONS: Record<BackofficeContextScope["kind"], IconName> = {
  system: "shield",
  org: "briefcase",
  user: "user",
  project: "folder",
  app: "box",
};

function acceptInletId(acceptId: string): string {
  return `accept:${acceptId}`;
}

/** Senders that need no accept get one inlet each, holding what they forwarded. */
function trustedInletId(scope: BackofficeContextScope): string {
  return `trusted:${backofficeScopePathSegment(scope)}`;
}

function forwardInletIds(forward: OrchestrationForward): readonly string[] {
  return forward.admittedBy.kind === "trusted"
    ? [trustedInletId(forward.from.scope)]
    : forward.admittedBy.acceptIds.map(acceptInletId);
}

/** The accept an inlet shows, null for a trusted sender's, and the recent forwards through it. */
export function orchestrationInletDetail(
  inletId: string,
  {
    forwardAccepts,
    recentForwards,
  }: {
    forwardAccepts: readonly AutomationForwardAccept[];
    recentForwards: readonly OrchestrationForward[];
  },
): { accept: AutomationForwardAccept | null; forwards: OrchestrationForward[] } {
  return {
    accept: forwardAccepts.find((accept) => acceptInletId(accept.id) === inletId) ?? null,
    forwards: recentForwards.filter((forward) => forwardInletIds(forward).includes(inletId)),
  };
}

/**
 * The sources and types a matcher pins events to, as alternatives; null when it does not narrow
 * them, so any event could match. Only equality on `$.source` and `$.eventType` pins anything.
 */
function matcherPins(
  matcher: AutomationEventMatcher,
): { source: string | null; eventType: string | null }[] | null {
  if ("all" in matcher) {
    let pins: { source: string | null; eventType: string | null }[] | null = null;
    for (const partPins of matcher.all.map(matcherPins)) {
      if (partPins === null) {
        continue;
      }
      pins =
        pins === null
          ? partPins
          : pins.flatMap((left) =>
              partPins.flatMap((right) => {
                const source = left.source ?? right.source;
                const eventType = left.eventType ?? right.eventType;
                // Two different values for one field cannot both hold.
                return (left.source && right.source && left.source !== right.source) ||
                  (left.eventType && right.eventType && left.eventType !== right.eventType)
                  ? []
                  : [{ source, eventType }];
              }),
            );
    }
    return pins;
  }
  if ("any" in matcher) {
    const parts = matcher.any.map(matcherPins);
    return parts.some((part) => part === null) ? null : parts.flatMap((part) => part ?? []);
  }
  if ("path" in matcher && matcher.op === "eq" && typeof matcher.value === "string") {
    if (matcher.path === "$.source") {
      return [{ source: matcher.value, eventType: null }];
    }
    if (matcher.path === "$.eventType") {
      return [{ source: null, eventType: matcher.value }];
    }
  }
  return null;
}

/** The events an accept's matcher names in full, by source and type. */
function acceptNamedEvents(
  matcher: AutomationEventMatcher | null,
): { source: string; eventType: string }[] {
  return (
    (matcher === null ? null : matcherPins(matcher))?.flatMap(({ source, eventType }) =>
      source !== null && eventType !== null ? [{ source, eventType }] : [],
    ) ?? []
  );
}

/**
 * The events of `events` an accept's matcher lets in; null when the matcher does not say. A pin on
 * only a source or a type reaches the events the graph knows, those every accept names included.
 */
function acceptEventIds(
  matcher: AutomationEventMatcher | null,
  events: ReadonlyMap<string, OrchestrationEvent>,
): string[] | null {
  const pins = matcher === null ? null : matcherPins(matcher);
  if (pins === null || pins.some((pin) => pin.source === null && pin.eventType === null)) {
    return null;
  }
  const ids = pins.flatMap(({ source, eventType }) => {
    if (source !== null && eventType !== null) {
      return [orchestrationEventId(source, eventType)];
    }
    return [...events.values()]
      .filter((event) =>
        source !== null
          ? event.sourceId === normalizedSourceId(source)
          : event.eventType === eventType,
      )
      .map((event) => event.id);
  });
  return [...new Set(ids)];
}

/** One inlet per accept, then one per trusted sender that forwarded something recently. */
function projectInlets(
  forwardAccepts: readonly AutomationForwardAccept[],
  recentForwards: readonly OrchestrationForward[],
  events: ReadonlyMap<string, OrchestrationEvent>,
  addEvent: (source: string, eventType: string, label: string) => void,
): OrchestrationInlet[] {
  const forwardsByInlet = new Map<string, OrchestrationForward[]>();
  for (const forward of recentForwards) {
    for (const inletId of forwardInletIds(forward)) {
      forwardsByInlet.set(inletId, [...(forwardsByInlet.get(inletId) ?? []), forward]);
    }
  }
  // Every accept's named events come first, so a partial pin reaches them whatever the accepts'
  // order.
  for (const { source, eventType } of forwardAccepts.flatMap((accept) =>
    acceptNamedEvents(accept.matcher),
  )) {
    addEvent(source, eventType, eventType);
  }
  const acceptInlets = forwardAccepts.map((accept): OrchestrationInlet => {
    const id = acceptInletId(accept.id);
    return {
      id,
      label: accept.name,
      senders:
        accept.from.kind === "members"
          ? { label: "Members", icon: "users" }
          : {
              label: backofficeScopePathSegment(accept.from.scope),
              icon: SCOPE_ICONS[accept.from.scope.kind],
            },
      status: accept.enabled ? "accepting" : "disabled",
      eventIds: acceptEventIds(accept.matcher, events),
      matcher: accept.matcher ? matcherSummary(accept.matcher) : null,
      recentCount: forwardsByInlet.get(id)?.length ?? 0,
    };
  });
  const trustedSenders = new Map(
    recentForwards
      .filter((forward) => forward.admittedBy.kind === "trusted")
      .map((forward) => [trustedInletId(forward.from.scope), forward.from.scope]),
  );
  const trustedInlets = [...trustedSenders].map(([id, scope]): OrchestrationInlet => {
    const forwards = forwardsByInlet.get(id) ?? [];
    const label = scope.kind === "system" ? "System" : backofficeScopePathSegment(scope);
    return {
      id,
      label: `From ${label}`,
      senders: { label, icon: SCOPE_ICONS[scope.kind] },
      status: "trusted",
      eventIds: [
        ...new Set(
          forwards.map((forward) => orchestrationEventId(forward.source, forward.eventType)),
        ),
      ],
      matcher: null,
      recentCount: forwards.length,
    };
  });
  return [...acceptInlets, ...trustedInlets];
}

function fallbackSourceLabel(source: string): string {
  return source
    .split(/[._-]/)
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

/**
 * The whole routing picture of a scope: every event a source can produce, whether or not anything
 * listens, every route on it, the workflows and scopes those routes reach, and the inlets other
 * scopes forward through. Events that only routes or accepts mention, such as schedules and
 * reclassified events, are added so every edge has both ends, and so are events that arrived
 * without being described anywhere.
 */
export function projectOrchestrationGraph({
  scopeLabel,
  sources,
  eventDefinitions,
  routes,
  activeWorkflows,
  recentEvents,
  forwardAccepts,
  recentForwards,
}: {
  scopeLabel: string;
  sources: readonly OrchestrationCatalogSource[];
  eventDefinitions: readonly OrchestrationCatalogEvent[];
  routes: readonly AutomationRouteDefinition[];
  activeWorkflows: readonly {
    workflowName: string;
    remoteWorkflowName: string | null;
    params: unknown;
  }[];
  recentEvents: readonly { source: string; eventType: string }[];
  forwardAccepts: readonly AutomationForwardAccept[];
  recentForwards: readonly OrchestrationForward[];
}): OrchestrationGraph {
  const activeWorkflowScripts = activeWorkflows.map(({ params, ...instance }) => {
    const reference = codemodeWorkflowScriptReferenceSchema.safeParse(params);
    return {
      ...instance,
      workflowScriptPath: reference.success ? reference.data.program.filename : null,
    };
  });

  const recentCounts = new Map<string, number>();
  for (const event of recentEvents) {
    const id = orchestrationEventId(event.source, event.eventType);
    recentCounts.set(id, (recentCounts.get(id) ?? 0) + 1);
  }

  const events = new Map<string, OrchestrationEvent>();
  function addEvent(source: string, eventType: string, label: string) {
    const id = orchestrationEventId(source, eventType);
    if (!events.has(id)) {
      events.set(id, {
        id,
        sourceId: normalizedSourceId(source),
        eventType,
        label,
        recentCount: recentCounts.get(id) ?? 0,
      });
    }
  }
  for (const definition of eventDefinitions) {
    addEvent(definition.source, definition.eventType, definition.label);
  }
  for (const route of routes) {
    if (route.trigger.kind === "schedule") {
      addEvent(SCHEDULER_SOURCE_ID, scheduleEventType(route), scheduleLabel(route));
    } else {
      addEvent(route.trigger.source, route.trigger.eventType, route.trigger.eventType);
    }
    if (route.action.kind === "reclassify_event") {
      addEvent(route.action.source, route.action.eventType, route.action.eventType);
    }
  }
  for (const event of recentEvents) {
    addEvent(event.source, event.eventType, event.eventType);
  }
  const inlets = projectInlets(forwardAccepts, recentForwards, events, addEvent);

  const sourceLabels = new Map(
    sources.map((source) => [normalizedSourceId(source.id), source.label]),
  );
  const graphSources = [...new Set([...events.values()].map((event) => event.sourceId))]
    .map(
      (id): OrchestrationSource => ({
        id,
        label: sourceLabels.get(id) ?? fallbackSourceLabel(id),
        icon: SOURCE_ICONS[id] ?? "shield",
      }),
    )
    .sort((left, right) => left.label.localeCompare(right.label));

  const targets = new Map<string, OrchestrationTarget>();
  const graphRoutes = routes.map((route): OrchestrationRoute => {
    const action = route.action;
    let graphAction: OrchestrationRoute["action"];
    if (action.kind === "reclassify_event") {
      graphAction = {
        kind: "reclassify_event",
        eventId: orchestrationEventId(action.source, action.eventType),
      };
    } else {
      const target =
        targets.get(routeTargetId(action)) ?? routeTarget(route, action, activeWorkflowScripts);
      targets.set(target.id, target);
      graphAction =
        action.kind === "send_workflow_event"
          ? { kind: action.kind, targetId: target.id, eventType: action.eventType }
          : { kind: action.kind, targetId: target.id };
    }
    return {
      id: route.id,
      eventId: routeTriggerEventId(route),
      label: route.name,
      priority: route.priority,
      enabled: route.enabled,
      matcher:
        route.trigger.kind === "event" && route.trigger.matcher
          ? matcherSummary(route.trigger.matcher)
          : null,
      action: graphAction,
    };
  });

  return {
    scopeLabel,
    inlets,
    sources: graphSources,
    events: [...events.values()],
    routes: graphRoutes,
    targets: [...targets.values()],
  };
}
