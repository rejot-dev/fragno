import type {
  AutomationActor,
  AutomationAuthorityMode,
} from "@fragno-dev/backoffice-api/v0/automation";
import {
  type AutomationActorIdentityMatcher,
  type AutomationActorMatcher,
  type AutomationEventMatcher,
  type AutomationEventPayloadProjection,
  type AutomationRouteAction,
  automationRouteActionAuthority,
  type AutomationRouteScopeTemplate,
  type AutomationRouteTrigger,
  type AutomationSendWorkflowEventAction,
  isAutomationActorProvenancePath,
} from "@fragno-dev/backoffice-api/v0/automation";
import type { AutomationEvent } from "@fragno-dev/backoffice-api/v0/events";
import type {
  BackofficeContextScope,
  BackofficeProjectOwner,
  BackofficeRootOwner,
  BackofficeScopeIdNames,
} from "@fragno-dev/backoffice-api/v0/shared/scope";

export class AutomationRouteAuthorityError extends Error {
  constructor() {
    super(
      "Scheduled workflows and agent notifications require organization-automation authority, or delegated-user authority with explicit grants in a personal scope. Linked-user authority requires an external sender.",
    );
    this.name = "AutomationRouteAuthorityError";
  }
}

/**
 * The user a scheduled route's own action acts for: a personal scope's owner, for delegated-user
 * routes whose explicit grants were checked against the route's author when it was saved. Inherited
 * grants were not checked, so they would let an author restricted by a delegate schedule anything
 * the owner may do. Schedule events name no user, so nothing derived from them acts for the owner.
 */
export function scheduledRouteUserId({
  ownerScope,
  trigger,
  authority,
}: {
  ownerScope: BackofficeContextScope;
  trigger: AutomationRouteTrigger;
  authority: AutomationAuthorityMode;
}): string | null {
  return trigger.kind === "schedule" &&
    ownerScope.kind === "user" &&
    authority.kind === "delegated-user" &&
    authority.grants !== "inherit"
    ? ownerScope.userId
    : null;
}

/** Rejects scheduled authority modes that have no user to act for in the route's scope. */
export function assertAutomationRouteAuthorityMatchesScope({
  ownerScope,
  trigger,
  action,
}: {
  ownerScope: BackofficeContextScope;
  trigger: AutomationRouteTrigger;
  action: AutomationRouteAction;
}): void {
  const authority = automationRouteActionAuthority(action);
  if (
    trigger.kind === "schedule" &&
    authority &&
    authority.kind !== "organization-automation" &&
    scheduledRouteUserId({ ownerScope, trigger, authority }) === null
  ) {
    throw new AutomationRouteAuthorityError();
  }
}

/** Rejects a reclassification route whose derived event would activate the same route again. */
export function assertAutomationRouteDoesNotReclassifyItself({
  routeId,
  trigger,
  action,
}: {
  routeId: string;
  trigger: AutomationRouteTrigger;
  action: AutomationRouteAction;
}): void {
  if (trigger.kind !== "event" || action.kind !== "reclassify_event") {
    return;
  }

  const sourceMatches = trigger.source === "*" || trigger.source === action.source;
  const eventTypeMatches = trigger.eventType === "*" || trigger.eventType === action.eventType;
  if (sourceMatches && eventTypeMatches) {
    throw new Error(`Automation route ${routeId} cannot reclassify an event to its own trigger.`);
  }
}

export type StarterAutomationRoutesSeedResult = {
  created: string[];
  removed: string[];
  skipped: string[];
};

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

/** Builds a new top-level payload from explicitly named event paths. */
export function projectAutomationEventPayload(
  event: AutomationEvent,
  projection: AutomationEventPayloadProjection,
): Record<string, EventPathValue> {
  return Object.fromEntries(
    Object.entries(projection.fields).map(([field, path]) => {
      const value = readAutomationEventPath(event, path);
      if (value === undefined) {
        throw new Error(`Automation event payload projection field ${field} resolved no value.`);
      }
      return [field, value];
    }),
  );
}

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
 * required. An id that renders empty names no scope, so rendering fails.
 */
export const renderAutomationScopeTemplate = (
  template: AutomationRouteScopeTemplate,
  event: AutomationEvent,
  routeId: string,
  routingKey: string,
): BackofficeContextScope => {
  const renderId = (idTemplate: string, label: string) => {
    const id = renderAutomationRawTemplateValue(idTemplate, event, routeId, routingKey);
    if (!id) {
      throw new Error(`Automation route ${routeId} resolved an empty target ${label}.`);
    }
    return id;
  };
  const renderRootOwner = (
    owner: Extract<AutomationRouteScopeTemplate, { kind: "org" | "user" }>,
  ): BackofficeRootOwner<BackofficeScopeIdNames> =>
    owner.kind === "org"
      ? { kind: "org", orgId: renderId(owner.orgIdTemplate, "org id") }
      : { kind: "user", userId: renderId(owner.userIdTemplate, "user id") };
  const renderOwner = (
    owner: Extract<AutomationRouteScopeTemplate, { kind: "project" }>["owner"],
  ): BackofficeProjectOwner<BackofficeScopeIdNames> =>
    owner.kind === "app"
      ? {
          kind: "app",
          owner: renderRootOwner(owner.owner),
          appId: renderId(owner.appIdTemplate, "app id"),
        }
      : renderRootOwner(owner);

  switch (template.kind) {
    case "system":
      return { kind: "system" };
    case "org":
    case "user":
    case "app":
      return renderOwner(template);
    case "project":
      return {
        kind: "project",
        owner: renderOwner(template.owner),
        projectId: renderId(template.projectIdTemplate, "project id"),
      };
    default:
      throw new Error("Unsupported automation route scope template kind.", {
        cause: template satisfies never,
      });
  }
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
