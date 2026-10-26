import type {
  AutomationEventMatcher,
  AutomationRouteAction,
  AutomationRouteDefinition,
} from "@fragno-dev/backoffice-api/v0/automation";
import type { IconName } from "@fragno-private/design-system/icon";
import type {
  OrchestrationEvent,
  OrchestrationGraph,
  OrchestrationRoute,
  OrchestrationSource,
  OrchestrationTarget,
} from "@fragno-private/design-system/orchestration-graph-model";
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

/** Routes that reach the same workflow or scope share one target node. */
export function routeTargetId(action: TargetedRouteAction): string {
  switch (action.kind) {
    case "start_workflow":
      return `workflow:${action.workflowScriptPath}`;
    case "send_workflow_event":
      return action.target.kind === "instance_id"
        ? `instance:${action.target.template}`
        : `stored-instance:${action.target.keyTemplate}`;
    case "forward_event":
      return `scope:${JSON.stringify(action.targetScope)}`;
    case "notify_agent":
      return `agent:${action.agentName}`;
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

function fallbackSourceLabel(source: string): string {
  return source
    .split(/[._-]/)
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

/**
 * The whole routing picture of a scope: every event a source can produce, whether or not anything
 * listens, every route on it, and the workflows and scopes those routes reach. Events that only
 * routes mention, such as schedules and reclassified events, are added so every route has both
 * ends, and so are events that arrived without being described anywhere.
 */
export function projectOrchestrationGraph({
  scopeLabel,
  sources,
  eventDefinitions,
  routes,
  activeWorkflows,
  recentEvents,
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
    sources: graphSources,
    events: [...events.values()],
    routes: graphRoutes,
    targets: [...targets.values()],
  };
}
