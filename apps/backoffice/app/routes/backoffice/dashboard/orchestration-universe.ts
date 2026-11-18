import type { AutomationRouteDefinition } from "@fragno-dev/backoffice-api/v0/automation";
import {
  backofficeScopePathSegment,
  type BackofficeContextScope,
} from "@fragno-dev/backoffice-api/v0/shared/scope";
import type {
  OrchestrationEvent,
  OrchestrationGraph,
  OrchestrationRoute,
  OrchestrationSource,
} from "@fragno-private/design-system/orchestration/orchestration-graph-model";
import type {
  OrchestrationForward as UniverseForward,
  OrchestrationUniverse,
  OrchestrationUniverseScopeStatus,
} from "@fragno-private/design-system/orchestration/orchestration-universe-model";

import { scopeIdentity } from "@/fragno/automation/forward-accepts";
import type { ProjectWiring } from "@/fragno/automation/project-wiring";

import {
  orchestrationEventId,
  projectOrchestrationGraph,
  type OrchestrationForward,
} from "./orchestration-graph";
import { grantedOutsideSystems, type ScopeConnections } from "./orchestration-outside-systems";
import { orchestrationCatalog } from "./scope-orchestration-graph";

/** Where a scope's routes forwarded to since the universe's window began. */
type UniverseDeliveries = readonly { routeId: string; scope: BackofficeContextScope }[];

/** What the universe reads of a scope: its graph, routes, deliveries, and connections. */
type UniverseScopeRecords = {
  graph: OrchestrationGraph;
  routes: readonly AutomationRouteDefinition[];
  deliveries: UniverseDeliveries;
  /** The connections it keeps, which name the connections routes grant in it. */
  connections: ScopeConnections;
};

/**
 * A scope the universe reads from its own replica, as it does the person looking: what it holds
 * once read, or null until then, with how far reading got.
 */
export type UniverseReadScope = {
  scope: BackofficeContextScope;
  label: string;
  read: UniverseScopeRecords | null;
  status?: OrchestrationUniverseScopeStatus;
};

/** A project as the organization knows it: how it last told it is wired, or null before it has. */
export type UniverseProject = {
  scope: BackofficeContextScope;
  label: string;
  wiring: ProjectWiring | null;
};

/**
 * A project's planet, drawn from how it is wired. Projects tell their organization how they are
 * wired, not what they did, so its planet shows no recent events, runs, or deliveries.
 */
function wiredProject({ scope, label, wiring }: UniverseProject): UniverseReadScope {
  if (wiring === null) {
    return { scope, label, read: null };
  }
  const catalog = orchestrationCatalog({
    eventSources: wiring.eventSources,
    // The universe shows no payloads, so wirings carry no schemas.
    eventDefinitions: wiring.eventDefinitions.map((definition) => ({
      ...definition,
      payloadSchema: null,
    })),
  });
  return {
    scope,
    label,
    read: {
      graph: projectOrchestrationGraph({
        scopeLabel: label,
        sources: catalog.sources,
        eventDefinitions: catalog.eventDefinitions,
        routes: wiring.routes,
        forwardAccepts: wiring.forwardAccepts,
        activeWorkflows: [],
        recentEvents: [],
        recentForwards: [],
      }),
      routes: wiring.routes,
      deliveries: [],
      connections: wiring.connections,
    },
  };
}

/**
 * A planet the universe has not read yet: only its name. What reaches it still lands on it, since
 * forwards are the sending scope's.
 */
function unreadGraph(scopeLabel: string): OrchestrationGraph {
  return { scopeLabel, inlets: [], sources: [], events: [], routes: [], targets: [] };
}

/** The scope a forward route's target names outright, or null when a template picks it per event. */
function namedTargetIdentity(route: AutomationRouteDefinition): string | null {
  if (route.action.kind !== "forward_event") {
    return null;
  }
  const target = route.action.targetScope;
  const literal = (template: string) => (template.includes("${") ? null : template);
  switch (target.kind) {
    case "org": {
      const orgId = literal(target.orgIdTemplate);
      return orgId && scopeIdentity({ kind: "org", orgId, jurisdiction: null });
    }
    case "user": {
      const userId = literal(target.userIdTemplate);
      return userId && scopeIdentity({ kind: "user", userId, jurisdiction: null });
    }
    case "project": {
      const orgId = target.owner.kind === "org" ? literal(target.owner.orgIdTemplate) : null;
      const projectId = literal(target.projectIdTemplate);
      return (
        orgId &&
        projectId &&
        scopeIdentity({
          kind: "project",
          owner: { kind: "org", orgId, jurisdiction: null },
          projectId,
        })
      );
    }
    // The event's subject picks its scope per event; System and app workspaces are never planets.
    case "subject":
    case "system":
    case "app":
      break;
  }
  return null;
}

/**
 * A read scope's forwards: to every scope a route names outright, even before it forwarded, and to
 * every scope a route delivered to since the window began.
 */
function scopeForwards(
  fromScopeId: string,
  routes: readonly AutomationRouteDefinition[],
  deliveries: UniverseDeliveries,
): UniverseForward[] {
  return [
    ...routes.flatMap((route) => {
      const toScopeId = namedTargetIdentity(route);
      return toScopeId ? [{ routeId: route.id, fromScopeId, toScopeId }] : [];
    }),
    ...deliveries.map(({ routeId, scope }) => ({
      routeId,
      fromScopeId,
      toScopeId: scopeIdentity(scope),
    })),
  ];
}

/** A read scope's planet; until read, what else is known of it, or only its name. */
function readScopePlanet(
  { scope, label, read, status }: UniverseReadScope,
  known: OrchestrationGraph | null = null,
) {
  return {
    id: scopeIdentity(scope),
    graph: read?.graph ?? known ?? unreadGraph(label),
    ...(status ? { status } : {}),
  };
}

/** The target every member's forward route reaches on its planet: the organization. */
const ORGANIZATION_TARGET_ID = "organization";

/**
 * A member's route as the organization saw it carry one event. A route matching several types,
 * such as `bank:*`, is seen once per type it forwarded, since a drawn route carries one event.
 */
function memberRouteId(forward: OrchestrationForward): string {
  return `${forward.from.routeId}|${orchestrationEventId(forward.source, forward.eventType)}`;
}

/**
 * A member's planet, as the organization knows it from what the member forwarded into it: the
 * events, and the routes that forwarded them, once per event each forwarded. The member's other
 * routes stay private.
 */
function memberGraph(
  scope: BackofficeContextScope,
  scopeLabel: string,
  forwards: readonly OrchestrationForward[],
  organization: OrchestrationGraph,
): OrchestrationGraph {
  const organizationSources = new Map(organization.sources.map((source) => [source.id, source]));
  const organizationEvents = new Map(organization.events.map((event) => [event.id, event]));
  const events = new Map<string, OrchestrationEvent>();
  const routes = new Map<string, OrchestrationRoute>();
  for (const forward of forwards) {
    const eventId = orchestrationEventId(forward.source, forward.eventType);
    const event = events.get(eventId);
    events.set(eventId, {
      ...(organizationEvents.get(eventId) ?? {
        id: eventId,
        sourceId: eventId.slice(0, eventId.indexOf(":")),
        eventType: forward.eventType,
        label: forward.eventType,
      }),
      recentCount: (event?.recentCount ?? 0) + 1,
    });
    routes.set(memberRouteId(forward), {
      id: memberRouteId(forward),
      eventId,
      label: forward.from.routeName,
      // The organization does not see the member's priorities or matchers.
      priority: 0,
      enabled: true,
      matcher: null,
      action: { kind: "forward_event", targetId: ORGANIZATION_TARGET_ID },
    });
  }
  const sources = [...new Set([...events.values()].map((event) => event.sourceId))].map(
    (id): OrchestrationSource => organizationSources.get(id) ?? { id, label: id, icon: "shield" },
  );
  return {
    scopeLabel,
    inlets: [],
    sources,
    events: [...events.values()],
    routes: [...routes.values()],
    targets: [
      { id: ORGANIZATION_TARGET_ID, label: organization.scopeLabel, kind: "scope", activeCount: 0 },
    ],
  };
}

/**
 * The organization, its projects, the members who forwarded into it, and the person looking, with
 * the forwards between them. The organization and the person looking are read from their own
 * replicas: each shows its own graph once read, and only its name before, and adds the forwards
 * its routes name or delivered. Projects are drawn from how they told the organization they are
 * wired, with the forwards their routes name. Other members' planets come from what the
 * organization recorded, so a member shows once they forward something. The person looking shows when their
 * scope and the organization's forward to each other. System, which forwards into every
 * organization, stays out. Workflows on read planets reach out to what their routes grant them.
 */
export function projectOrchestrationUniverse({
  organization,
  projects: wiredProjects,
  viewer,
  recentForwards,
  memberNames,
}: {
  /** The organization, which is always read: the universe opens with it. */
  organization: UniverseScopeRecords & { scope: BackofficeContextScope };
  projects: readonly UniverseProject[];
  /** The person looking, whose personal scope they can read, unlike other members'. */
  viewer: UniverseReadScope | null;
  /** What was forwarded into the organization. */
  recentForwards: readonly OrchestrationForward[];
  /** The names of the organization's members, by user ID, which their planets go by. */
  memberNames: Readonly<Record<string, string>>;
}): OrchestrationUniverse {
  // A member the organization has no name for, such as one who left, goes by their scope.
  const memberLabel = (scope: BackofficeContextScope) =>
    (scope.kind === "user" ? memberNames[scope.userId] : undefined) ??
    backofficeScopePathSegment(scope);
  const projects = wiredProjects.map(wiredProject);
  const organizationId = scopeIdentity(organization.scope);
  const viewerId = viewer ? scopeIdentity(viewer.scope) : null;
  const readScopes = [...projects, ...(viewer ? [viewer] : [])];
  const scopeLabels = new Map([
    [organizationId, organization.graph.scopeLabel],
    ...readScopes.map(({ scope, label }) => [scopeIdentity(scope), label] as const),
  ]);
  const forwards: UniverseForward[] = [
    ...scopeForwards(organizationId, organization.routes, organization.deliveries),
    ...projects.flatMap(({ scope, read }) =>
      read ? scopeForwards(scopeIdentity(scope), read.routes, read.deliveries) : [],
    ),
  ];

  const memberForwards = new Map<
    string,
    { scope: BackofficeContextScope; forwards: OrchestrationForward[] }
  >();
  for (const forward of recentForwards) {
    if (forward.from.scope.kind !== "user") {
      continue;
    }
    const id = scopeIdentity(forward.from.scope);
    const member = memberForwards.get(id) ?? { scope: forward.from.scope, forwards: [] };
    member.forwards.push(forward);
    memberForwards.set(id, member);
  }
  for (const [id, member] of memberForwards) {
    // Read, the person looking draws their own routes, and what they delivered names them.
    if (id === viewerId && viewer?.read) {
      continue;
    }
    for (const routeId of new Set(member.forwards.map(memberRouteId))) {
      forwards.push({ routeId, fromScopeId: id, toScopeId: organizationId });
    }
  }

  // The person looking is part of this universe when either side forwards to the other.
  const organizationScopeIds = new Set([
    organizationId,
    ...projects.map(({ scope }) => scopeIdentity(scope)),
  ]);
  const viewerForwards =
    viewer?.read && viewerId
      ? scopeForwards(viewerId, viewer.read.routes, viewer.read.deliveries).filter(
          ({ toScopeId }) => organizationScopeIds.has(toScopeId),
        )
      : [];
  forwards.push(...viewerForwards);
  const showsViewer =
    viewerId !== null &&
    (memberForwards.has(viewerId) ||
      viewerForwards.length > 0 ||
      forwards.some(({ toScopeId }) => toScopeId === viewerId));

  return {
    scopes: [
      { id: organizationId, graph: organization.graph },
      ...projects.map((project) => readScopePlanet(project)),
      ...[...memberForwards]
        .filter(([id]) => !(showsViewer && id === viewerId))
        .map(([id, member]) => ({
          id,
          graph: memberGraph(
            member.scope,
            memberLabel(member.scope),
            member.forwards,
            organization.graph,
          ),
        })),
      // Until their scope is read, the person looking shows as the organization knows them.
      ...(showsViewer && viewer && viewerId
        ? [
            readScopePlanet(
              viewer,
              memberForwards.has(viewerId)
                ? {
                    ...memberGraph(
                      viewer.scope,
                      viewer.label,
                      memberForwards.get(viewerId)!.forwards,
                      organization.graph,
                    ),
                  }
                : null,
            ),
          ]
        : []),
    ],
    // A route can name a scope and have delivered there too.
    forwards: [
      ...new Map(
        forwards.map((forward) => [
          `${forward.routeId}|${forward.fromScopeId}|${forward.toScopeId}`,
          forward,
        ]),
      ).values(),
    ],
    ...grantedOutsideSystems({
      organizationId,
      scopes: [
        organization,
        ...readScopes.flatMap(({ scope, read }) => (read ? [{ scope, ...read }] : [])),
      ],
      scopeLabel: (scope) => scopeLabels.get(scopeIdentity(scope)) ?? memberLabel(scope),
    }),
  };
}
