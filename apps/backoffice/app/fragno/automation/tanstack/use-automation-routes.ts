import { eq, useLiveQuery } from "@tanstack/react-db";

import type { AutomationRouteDefinition } from "../routing";
import type { AutomationBrowserCollections } from "./browser-database";

type AutomationRoutesLiveState =
  | { status: "loading"; routes: [] }
  | { status: "ready"; routes: AutomationRouteDefinition[] }
  | { status: "error"; routes: AutomationRouteDefinition[]; message: string };

/** Reads automation routes from the scope's local-first synchronized TanStack collections. */
export function useAutomationRoutes(
  collections: AutomationBrowserCollections,
): AutomationRoutesLiveState {
  const routesQuery = useLiveQuery(
    (query) =>
      query
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
        })),
    [collections.routeScheduleStates, collections.routes],
  );
  const routes: AutomationRouteDefinition[] = (routesQuery.data ?? []).map((route) => ({
    ...route,
    nextOccurrenceAt: route.nextOccurrenceAt?.toISOString() ?? null,
  }));

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
