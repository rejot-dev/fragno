import type { AutomationActor, AutomationActorRole } from "./actors";
import type { AutomationEvent } from "./contracts";
import type { AutomationScheduleCadence } from "./route-triggers";

type AutomationActorIdentityMatcher =
  | {
      scope: "internal";
      source?: never;
      type?: string;
      id?: string;
    }
  | {
      scope: "external";
      source?: string;
      type?: string;
      id?: string;
    };

export type AutomationActorMatcher =
  | (AutomationActorIdentityMatcher & { participation: "initiator" })
  | (AutomationActorIdentityMatcher & { participation: "principal" })
  | (AutomationActorIdentityMatcher & {
      participation: "delegation";
      role?: Extract<AutomationActorRole, "delegate" | "assistant">;
    });

export type AutomationEventMatcher =
  | { actor: AutomationActorMatcher }
  | { path: string; op: "exists" }
  | { path: string; op: "eq" | "neq" | "startsWith" | "includes"; value: unknown }
  | { all: AutomationEventMatcher[] }
  | { any: AutomationEventMatcher[] }
  | { not: AutomationEventMatcher };

export type AutomationRouteScopeTemplate =
  | { kind: "system" }
  | { kind: "org"; orgIdTemplate: string }
  | { kind: "project"; orgIdTemplate: string; projectIdTemplate: string }
  | { kind: "user"; userIdTemplate: string };

type AutomationRouteScope =
  | { kind: "system" }
  | { kind: "org"; orgId: string }
  | { kind: "project"; orgId: string; projectId: string }
  | { kind: "user"; userId: string };

export type AutomationStartWorkflowAction = {
  kind: "start_workflow";
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
  remoteWorkflowName: string;
  target: AutomationWorkflowEventTarget;
  eventType: string;
  payload?: unknown;
};

export type AutomationForwardEventAction = {
  kind: "forward_event";
  targetScope: AutomationRouteScopeTemplate;
  idTemplate?: string;
};

export type AutomationRouteAction =
  | AutomationStartWorkflowAction
  | AutomationSendWorkflowEventAction
  | AutomationForwardEventAction;

type AutomationRouteEventTrigger = {
  kind: "event";
  source: string;
  eventType: string;
  matcher: AutomationEventMatcher | null;
};

type AutomationRouteScheduleTrigger = {
  kind: "schedule";
  cadence: AutomationScheduleCadence;
};

export type AutomationRouteTrigger = AutomationRouteEventTrigger | AutomationRouteScheduleTrigger;

export type AutomationRouteDefinition = {
  id: string;
  name: string;
  enabled: boolean;
  priority: number;
  trigger: AutomationRouteTrigger;
  action: AutomationRouteAction;
  description?: string | null;
  nextOccurrenceAt: string | null;
};

export type StarterAutomationRoutesSeedResult = {
  created: string[];
  skipped: string[];
};

export const isAutomationActorProvenancePath = (path: string) =>
  path === "$.actor" ||
  path.startsWith("$.actor.") ||
  path.startsWith("$.actor[") ||
  path === "$.actors" ||
  path.startsWith("$.actors.") ||
  path.startsWith("$.actors[");

/**
 * Makes a rendered template segment safe for workflow instance ids.
 *
 * Event ids often contain colons, slashes, or provider-specific punctuation. Workflow instance ids
 * are easier to inspect and route when those characters are normalized to dashes.
 */
const sanitizeWorkflowIdentifierSegment = (value: unknown) =>
  String(value).replace(/[^a-zA-Z0-9-_]/g, "-");

type EventPathRecord = { [key: string]: EventPathValue };
type EventPathValue =
  | EventPathRecord
  | readonly EventPathValue[]
  | string
  | number
  | boolean
  | null
  | undefined;

/**
 * Reads a small JSONPath-like path from an automation event.
 *
 * Supported syntax is deliberately tiny: `$`, `$.field.nested`, and array indexes like
 * `$.payload.items[0]`. Unknown paths return `undefined` instead of throwing so route matchers can
 * treat missing data as a normal non-match.
 */
const readAutomationEventPath = (event: AutomationEvent, path: string): EventPathValue => {
  if (path === "$") {
    return event as EventPathValue;
  }
  if (!path.startsWith("$.")) {
    return undefined;
  }

  let current = event as EventPathValue;
  for (const segment of path.slice(2).split(".")) {
    if (!segment) {
      return undefined;
    }

    const record =
      current && typeof current === "object" && !Array.isArray(current)
        ? (current as EventPathRecord)
        : undefined;
    const arrayMatch = /^(?<key>[^[]+)\[(?<index>\d+)\]$/u.exec(segment);
    if (arrayMatch?.groups) {
      const value = record?.[arrayMatch.groups.key];
      current = Array.isArray(value)
        ? (value[Number(arrayMatch.groups.index)] as EventPathValue)
        : undefined;
      continue;
    }

    current = record?.[segment];
  }

  return current;
};

const automationActorMatches = (
  actor: AutomationActor,
  matcher: AutomationActorIdentityMatcher & { role?: "delegate" | "assistant" },
) =>
  actor.scope === matcher.scope &&
  (matcher.source === undefined ||
    (actor.scope === "external" && actor.source === matcher.source)) &&
  (matcher.type === undefined || actor.type === matcher.type) &&
  (matcher.id === undefined || actor.id === matcher.id) &&
  (matcher.role === undefined || actor.role === matcher.role);

const automationEventActorMatches = (
  event: AutomationEvent,
  matcher: AutomationActorMatcher,
): boolean => {
  switch (matcher.participation) {
    case "initiator":
      return automationActorMatches(event.actors.initiator, matcher);
    case "principal":
      return event.actors.principal
        ? automationActorMatches(event.actors.principal, matcher)
        : false;
    case "delegation":
      return event.actors.delegation.some((actor) => automationActorMatches(actor, matcher));
  }

  throw new Error("Unsupported automation actor participation.");
};

/**
 * Evaluates a route matcher against one event.
 *
 * `null` means "match everything". Composite matchers (`all`, `any`, `not`) recurse into the same
 * evaluator. Actor matchers read the structural participation slots directly, while path matchers
 * remain available for event payload and subject fields.
 */
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
  if ("actor" in matcher) {
    return automationEventActorMatches(event, matcher.actor);
  }
  if (isAutomationActorProvenancePath(matcher.path)) {
    return false;
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

/**
 * Resolves one `${...}` expression used by route action templates.
 *
 * Templates can reference the route id, the stable routing key, the event id, or event fields via
 * `event.*`. Unknown expressions intentionally render as an empty string to keep route execution
 * deterministic and non-interactive.
 */
const resolveAutomationTemplateExpression = (
  expression: string,
  event: AutomationEvent,
  routeId: string,
  routingKey: string,
) => {
  const trimmed = expression.trim();
  if (trimmed === "route.id") {
    return routeId;
  }
  if (trimmed === "routing.key") {
    return routingKey;
  }
  if (trimmed === "event") {
    return event.id;
  }
  if (trimmed.startsWith("event.")) {
    return readAutomationEventPath(event, `$.${trimmed.slice("event.".length)}`) ?? "";
  }
  return "";
};

/**
 * Renders a route template without sanitizing the result.
 *
 * Use this for values that must preserve exact ids, such as forwarded event ids and target org/user
 * ids. Do not use it for workflow instance ids.
 */
export const renderAutomationRawTemplateValue = (
  template: string,
  event: AutomationEvent,
  routeId: string,
  routingKey: string,
) =>
  template.replace(/\$\{([^}]+)\}/gu, (_match, expression: string) =>
    String(resolveAutomationTemplateExpression(expression, event, routeId, routingKey)),
  );

/**
 * Renders a route template for workflow instance identifiers.
 *
 * Each expression result is sanitized before being inserted so instance ids are stable and safe,
 * while literal text in the template is left as-is.
 */
export const renderAutomationTemplateValue = (
  template: string,
  event: AutomationEvent,
  routeId: string,
  routingKey: string,
) =>
  template.replace(/\$\{([^}]+)\}/gu, (_match, expression: string) =>
    sanitizeWorkflowIdentifierSegment(
      resolveAutomationTemplateExpression(expression, event, routeId, routingKey),
    ),
  );

/**
 * Renders a scope template for event forwarding.
 *
 * `start_workflow` no longer has scope overrides: workflows always run in the current event scope.
 * Scope templates remain only for `forward_event`, where preserving raw org/user/project ids is
 * required.
 */
export const renderAutomationScopeTemplate = (
  template: AutomationRouteScopeTemplate,
  event: AutomationEvent,
  routeId: string,
  routingKey: string,
): AutomationRouteScope => {
  switch (template.kind) {
    case "system":
      return { kind: "system" };
    case "org":
      return {
        kind: "org",
        orgId: renderAutomationRawTemplateValue(template.orgIdTemplate, event, routeId, routingKey),
      };
    case "project":
      return {
        kind: "project",
        orgId: renderAutomationRawTemplateValue(template.orgIdTemplate, event, routeId, routingKey),
        projectId: renderAutomationRawTemplateValue(
          template.projectIdTemplate,
          event,
          routeId,
          routingKey,
        ),
      };
    case "user":
      return {
        kind: "user",
        userId: renderAutomationRawTemplateValue(
          template.userIdTemplate,
          event,
          routeId,
          routingKey,
        ),
      };
  }

  throw new Error("Unsupported automation route scope template kind.");
};

/**
 * Chooses the payload sent by a `send_workflow_event` route.
 *
 * Omitting `payload`, or explicitly using the `$event` sentinel, forwards the triggering automation
 * event. Any other value is sent verbatim.
 */
export const buildWorkflowEventPayload = ({
  action,
  event,
}: {
  action: AutomationSendWorkflowEventAction;
  event: AutomationEvent;
}) => (action.payload === undefined || action.payload === "$event" ? event : action.payload);
