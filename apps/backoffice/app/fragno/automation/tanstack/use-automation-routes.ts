import type { AutomationRouteDefinition } from "@fragno-dev/backoffice-api/v0/automation";

import { eq, useLiveQuery, type InitialQueryBuilder } from "@tanstack/react-db";

import type { AutomationBrowserCollections } from "./browser-database";

type AutomationRoutesLiveState =
  | { status: "loading"; routes: [] }
  | { status: "ready"; routes: AutomationRouteDefinition[] }
  | { status: "error"; routes: AutomationRouteDefinition[]; message: string };

/** The live query behind every route view; `queryOnce` accepts it as well. */
export function automationRoutesQuery(
  query: InitialQueryBuilder,
  collections: Pick<AutomationBrowserCollections, "routes" | "routeScheduleStates">,
) {
  return query
    .from({ route: collections.routes })
    .leftJoin({ schedule: collections.routeScheduleStates }, ({ route, schedule }) =>
      eq(route.id, schedule.id),
    )
    .orderBy(({ route }) => route.priority, "asc")
    .orderBy(({ route }) => route.id, "asc")
    .select(({ route, schedule }) => ({
      id: route.id,
      name: route.name,
      enabled: route.enabled,
      priority: route.priority,
      trigger: route.trigger,
      action: route.action,
      description: route.description,
      nextOccurrenceAt: schedule?.nextOccurrenceAt,
    }));
}

type AutomationRouteRecord = Omit<AutomationRouteDefinition, "nextOccurrenceAt"> & {
  nextOccurrenceAt: Date | null | undefined;
};

export function automationRoutesFromRecords(
  records: readonly AutomationRouteRecord[],
): AutomationRouteDefinition[] {
  return records.map((route) => ({
    ...route,
    nextOccurrenceAt: route.nextOccurrenceAt?.toISOString() ?? null,
  }));
}

/** Reads automation routes from the scope's local-first synchronized TanStack collections. */
export function useAutomationRoutes(
  collections: AutomationBrowserCollections,
): AutomationRoutesLiveState {
  const routesQuery = useLiveQuery({ query: (query) => automationRoutesQuery(query, collections) });
  const routes = automationRoutesFromRecords(routesQuery.data ?? []);

  if (routesQuery.isError) {
    return {
      status: "error",
      routes,
      message: "Automation route synchronization failed.",
    };
  }
  if (routesQuery.isLoading && routes.length === 0) {
    return { status: "loading", routes: [] };
  }
  return { status: "ready", routes };
}
