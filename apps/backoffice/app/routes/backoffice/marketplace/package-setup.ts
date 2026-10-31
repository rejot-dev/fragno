import type {
  AutomationActorMatcher,
  AutomationEventMatcher,
  AutomationRouteAction,
  AutomationRouteScopeTemplate,
} from "@fragno-dev/backoffice-api/v0/automation";
import type { MarketplacePackageDeclaration } from "@fragno-dev/backoffice-api/v0/marketplace";
import type { PackageSetup, PackageSetupRoute } from "@fragno-private/design-system/package-setup";
import type { ComponentProps } from "react";

import { formatTimestamp } from "../automations/formatting";
import { automationAuthorityActorLabel } from "../automations/route-action";
import { matcherOperatorLabel, matcherValueLabel } from "../automations/route-configuration";

export type MarketplacePackageSetup = ComponentProps<typeof PackageSetup>;

/** What installing a release sets up, in the words the installation tab shows. */
export function describeMarketplacePackageSetup(
  declaration: MarketplacePackageDeclaration,
): MarketplacePackageSetup {
  return {
    permissions: declaration.permissions.map(
      ({ namespace, permission }) => `${namespace}.${permission}`,
    ),
    agents: declaration.agents.map((agent) => ({
      name: agent.agentName,
      description: agent.description,
      model: agent.model,
      permissions: agent.permissions,
      instructions: agent.instructions,
    })),
    routes: declaration.routes.map(describeRoute),
    eventTypes: declaration.eventDefinitions.map((definition) => ({
      source: definition.source,
      eventType: definition.eventType,
      label: definition.label,
      description: definition.description ?? null,
      payloadFields: schemaPropertyNames(definition.payloadSchema ?? null),
    })),
  };
}

function describeRoute(route: MarketplacePackageDeclaration["routes"][number]): PackageSetupRoute {
  const { trigger, action } = route;
  return {
    id: route.id,
    name: route.name,
    enabled: route.enabled,
    trigger:
      trigger.kind === "event"
        ? {
            kind: "event",
            source: trigger.source,
            eventType: trigger.eventType,
            condition: trigger.matcher ? describeMatcher(trigger.matcher, false) : null,
          }
        : {
            kind: "schedule",
            cadence:
              trigger.cadence.kind === "once"
                ? `Once, at ${formatTimestamp(trigger.cadence.at)}`
                : `On cron ${trigger.cadence.expression}, ${trigger.cadence.timeZone}`,
          },
    action: describeAction(action),
    runsAs:
      action.kind === "start_workflow" || action.kind === "notify_agent"
        ? {
            actor: automationAuthorityActorLabel(action.authority.kind),
            grants:
              action.authority.grants === "inherit"
                ? "inherit"
                : action.authority.grants.map(
                    ({ namespace, permission }) => `${namespace}.${permission}`,
                  ),
          }
        : null,
  };
}

function describeAction(action: AutomationRouteAction): PackageSetupRoute["action"] {
  switch (action.kind) {
    case "start_workflow":
      return { label: "Start workflow", target: action.workflowScriptPath };
    case "send_workflow_event":
      return action.target.kind === "instance_id"
        ? { label: `Send ${action.eventType} to workflow`, target: action.target.template }
        : {
            label: `Send ${action.eventType} to the workflow stored at`,
            target: action.target.keyTemplate,
          };
    case "forward_event":
      return { label: "Forward the event to", target: describeScopeTemplate(action.targetScope) };
    case "notify_agent":
      return { label: "Prompt agent", target: action.agentName };
    case "reclassify_event":
      return { label: "Reclassify as", target: `${action.source} · ${action.eventType}` };
  }

  throw new Error("Unsupported automation route action kind.");
}

function describeScopeTemplate(scope: AutomationRouteScopeTemplate): string {
  switch (scope.kind) {
    case "system":
      return "system";
    case "subject":
      return "the event's subject";
    case "org":
      return `org ${scope.orgIdTemplate}`;
    case "user":
      return `user ${scope.userIdTemplate}`;
    case "app":
      return `${describeScopeTemplate(scope.owner)} app ${scope.appIdTemplate}`;
    case "project":
      return `${describeScopeTemplate(scope.owner)} project ${scope.projectIdTemplate}`;
  }

  throw new Error("Unsupported automation route scope kind.");
}

/** A matcher as one sentence; nested groups get parentheses so `and` and `or` stay unambiguous. */
function describeMatcher(matcher: AutomationEventMatcher, nested: boolean): string {
  if ("all" in matcher || "any" in matcher) {
    const [matchers, joiner] = "all" in matcher ? [matcher.all, " and "] : [matcher.any, " or "];
    if (!matchers.length) {
      return "all" in matcher ? "always" : "never";
    }
    const sentence = matchers.map((child) => describeMatcher(child, true)).join(joiner);
    return nested && matchers.length > 1 ? `(${sentence})` : sentence;
  }
  if ("not" in matcher) {
    return `not ${describeMatcher(matcher.not, true)}`;
  }
  if ("actor" in matcher) {
    return describeActorMatcher(matcher.actor);
  }
  const path = matcher.path.replace(/^\$\./, "");
  return matcher.op === "exists"
    ? `${path} exists`
    : `${path} ${matcherOperatorLabel(matcher.op)} ${matcherValueLabel(matcher.value)}`;
}

function describeActorMatcher(matcher: AutomationActorMatcher): string {
  const role =
    matcher.participation === "delegation" ? (matcher.role ?? "delegate") : matcher.participation;
  const origin =
    matcher.scope === "external" ? `an external ${matcher.source ?? ""}` : "an internal";
  const kind = matcher.type ? ` ${matcher.type}` : " actor";
  const id = matcher.id ? ` ${matcher.id}` : "";
  return `the ${role} is ${origin.trimEnd()}${kind}${id}`;
}

function schemaPropertyNames(schema: Record<string, unknown> | null): string[] {
  const properties = schema?.properties;
  return typeof properties === "object" && properties !== null ? Object.keys(properties) : [];
}
