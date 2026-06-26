import type { AutomationEvent } from "./contracts";

export type AutomationEventMatcher =
  | { path: string; op: "exists" }
  | { path: string; op: "eq" | "neq" | "startsWith" | "includes"; value: unknown }
  | { all: AutomationEventMatcher[] }
  | { any: AutomationEventMatcher[] }
  | { not: AutomationEventMatcher };

export type AutomationStartWorkflowAction = {
  kind: "start_workflow";
  workflowName: string;
  remoteWorkflowName?: string;
  workflowScriptPath: string;
  instanceIdTemplate: string;
};

export type AutomationWorkflowEventTarget =
  | { kind: "instance_id"; template: string }
  | { kind: "stored_instance_id"; keyTemplate: string };

export type AutomationSendWorkflowEventAction = {
  kind: "send_workflow_event";
  workflowName: string;
  target: AutomationWorkflowEventTarget;
  eventType: string;
  payload?: unknown;
};

export type AutomationRouteAction =
  | AutomationStartWorkflowAction
  | AutomationSendWorkflowEventAction;

export type AutomationRouteDefinition = {
  id: string;
  name: string;
  enabled: boolean;
  source: string;
  eventType: string;
  matcher: AutomationEventMatcher | null;
  action: AutomationRouteAction;
  priority: number;
  description?: string | null;
};

export type StarterAutomationRoutesSeedResult = {
  created: string[];
  skipped: string[];
};

type AutomationRouteRow = Omit<AutomationRouteDefinition, "id" | "description"> & {
  id: { externalId: string };
  description: string | null;
};

export const automationRouteFromRow = (route: AutomationRouteRow): AutomationRouteDefinition => ({
  id: route.id.externalId,
  name: route.name,
  enabled: route.enabled,
  source: route.source,
  eventType: route.eventType,
  matcher: route.matcher,
  action: route.action,
  priority: route.priority,
  description: route.description,
});

const sanitizeWorkflowIdentifierSegment = (value: unknown) =>
  String(value).replace(/[^a-zA-Z0-9-_]/g, "-");

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

export const readAutomationEventPath = (event: AutomationEvent, path: string): unknown => {
  if (path === "$") {
    return event;
  }
  if (!path.startsWith("$.")) {
    return undefined;
  }

  let current: unknown = event;
  for (const segment of path.slice(2).split(".")) {
    if (!segment) {
      return undefined;
    }

    const arrayMatch = /^(?<key>[^[]+)\[(?<index>\d+)\]$/u.exec(segment);
    if (arrayMatch?.groups) {
      const value = isRecord(current) ? current[arrayMatch.groups.key!] : undefined;
      current = Array.isArray(value) ? value[Number(arrayMatch.groups.index)] : undefined;
      continue;
    }

    current = isRecord(current) ? current[segment] : undefined;
  }

  return current;
};

export const evaluateAutomationEventMatcher = (
  matcher: AutomationEventMatcher | null | undefined,
  event: AutomationEvent,
): boolean => {
  if (!matcher) {
    return true;
  }

  if ("all" in matcher) {
    return matcher.all.every((child) => evaluateAutomationEventMatcher(child, event));
  }
  if ("any" in matcher) {
    return matcher.any.some((child) => evaluateAutomationEventMatcher(child, event));
  }
  if ("not" in matcher) {
    return !evaluateAutomationEventMatcher(matcher.not, event);
  }

  const value = readAutomationEventPath(event, matcher.path);
  if (matcher.op === "exists") {
    return typeof value !== "undefined";
  }
  if (matcher.op === "eq") {
    return value === matcher.value;
  }
  if (matcher.op === "neq") {
    return value !== matcher.value;
  }
  if (matcher.op === "startsWith") {
    return (
      typeof value === "string" &&
      typeof matcher.value === "string" &&
      value.startsWith(matcher.value)
    );
  }
  if (matcher.op === "includes") {
    return (
      typeof value === "string" &&
      typeof matcher.value === "string" &&
      value.includes(matcher.value)
    );
  }

  return false;
};

export const renderAutomationTemplateValue = (
  template: string,
  event: AutomationEvent,
  routeId: string,
  routingKey: string,
) =>
  template.replace(/\$\{([^}]+)\}/gu, (_match, expression: string) => {
    const trimmed = expression.trim();
    if (trimmed === "route.id") {
      return sanitizeWorkflowIdentifierSegment(routeId);
    }
    if (trimmed === "routing.key") {
      return sanitizeWorkflowIdentifierSegment(routingKey);
    }
    if (trimmed === "event") {
      return sanitizeWorkflowIdentifierSegment(event.id);
    }
    if (trimmed.startsWith("event.")) {
      return sanitizeWorkflowIdentifierSegment(
        readAutomationEventPath(event, `$.${trimmed.slice("event.".length)}`) ?? "",
      );
    }
    return "";
  });

export const buildStartWorkflowParams = ({
  action,
  event,
  instanceId,
}: {
  action: AutomationStartWorkflowAction;
  event: AutomationEvent;
  instanceId: string;
}) => ({
  automationEvent: event,
  workflowScriptPath: action.workflowScriptPath,
  workflowInstanceId: instanceId,
});

export const buildWorkflowEventPayload = ({
  action,
  event,
}: {
  action: AutomationSendWorkflowEventAction;
  event: AutomationEvent;
}) => (action.payload === undefined || action.payload === "$event" ? event : action.payload);
