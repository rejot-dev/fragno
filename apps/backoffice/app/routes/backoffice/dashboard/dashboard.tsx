import { ClientOnly } from "@fragno-private/design-system/client-only";
import { BackofficeSystemState } from "@fragno-private/design-system/system-state";
import { Suspense, use, useEffect, useMemo, useState } from "react";
import { redirect } from "react-router";

import { useLiveQuery } from "@tanstack/react-db";

import { useCurrentBackofficeContext } from "@/components/backoffice/current-context";
import { findBackofficeMe } from "@/fragno/auth/auth-server";
import {
  describeAutomationCollectionSource,
  getAutomationBrowserDatabase,
  type AutomationBrowserCollections,
} from "@/fragno/automation/tanstack/browser-database";
import { useAutomationRoutes } from "@/fragno/automation/tanstack/use-automation-routes";

import { buildBackofficeLoginPath } from "../auth-navigation";
import { lookupAutomationProject } from "../automations/data.server";
import {
  automationRuntimeScopeFromRouteParams,
  resolveAutomationScopeSelection,
} from "../automations/scope";
import {
  automationWorkflowRunsFromRecords,
  workflowRunRecordsQuery,
} from "../automations/script-view/use-script-workflow-runs";
import { listIntegrationConnections } from "../integrations/connections.server";
import { fetchPiManagerSessions, type PiManagerSessionsResult } from "../sessions/data";
import type { Route } from "./+types/dashboard";
import { DashboardSections, type DashboardLoaderData } from "./dashboard-sections";
import {
  dashboardBucketStarts,
  dashboardConnectionEventsQuery,
  dashboardEventsQuery,
  dashboardRunsQuery,
  projectBackofficeDashboard,
} from "./overview";

const RECENT_SESSION_COUNT = 5;
const CLOCK_TICK_MS = 60_000;

export async function loader({ request, params, context, url }: Route.LoaderArgs) {
  const me = await findBackofficeMe(request, context);
  if (!me?.user) {
    throw redirect(buildBackofficeLoginPath(`${url.pathname}${url.search}`));
  }

  const organizations = me.organizations.map((entry) => entry.organization);
  const runtimeScope = automationRuntimeScopeFromRouteParams(params, organizations);
  const projectLookup =
    runtimeScope.kind === "project"
      ? await lookupAutomationProject(context, runtimeScope.orgId, runtimeScope.projectId)
      : null;
  if (projectLookup?.status === "error") {
    throw new Response(projectLookup.message, { status: 502 });
  }
  if (projectLookup?.status === "not-found") {
    throw new Response("Not Found", { status: 404 });
  }

  const [connectionNames, sessions] = await Promise.all([
    listIntegrationConnections(request, context, params),
    fetchRecentPiSessions(request, context, runtimeScope),
  ]);
  return {
    selectedScope: resolveAutomationScopeSelection({
      params,
      organizations,
      project: projectLookup?.status === "found" ? projectLookup.project : null,
      user: me.user,
    }),
    connectionNames,
    sessions,
  } satisfies DashboardLoaderData;
}

/** Sessions are one panel of the dashboard, so an unavailable Pi manager does not fail the page. */
async function fetchRecentPiSessions(
  request: Request,
  context: Route.LoaderArgs["context"],
  scope: Parameters<typeof fetchPiManagerSessions>[2],
): Promise<PiManagerSessionsResult> {
  try {
    const { sessions, sessionsError } = await fetchPiManagerSessions(request, context, scope);
    return {
      sessions: [...sessions]
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
        .slice(0, RECENT_SESSION_COUNT),
      sessionsError,
    };
  } catch (error) {
    if (error instanceof Response) {
      return { sessions: [], sessionsError: `Sessions are unavailable (${error.status}).` };
    }
    throw error;
  }
}

export function meta({ loaderData }: Route.MetaArgs) {
  return [{ title: `Dashboard · ${loaderData?.selectedScope.label ?? "scope"}` }];
}

export default function BackofficeDashboard({ loaderData }: Route.ComponentProps) {
  const loading = (
    <BackofficeSystemState
      tone="loading"
      label="Synchronizing"
      title="Synchronizing automation activity…"
    />
  );

  return (
    <div className="flex flex-col gap-4 p-4 sm:p-6">
      <header className="min-w-0">
        <p className="text-[10px] tracking-[0.24em] text-[var(--bo-muted-2)] uppercase">
          Dashboard
        </p>
        <h1 className="mt-1 truncate text-2xl font-semibold tracking-[-0.02em] text-[var(--bo-fg)]">
          {loaderData.selectedScope.label}
        </h1>
      </header>
      <ClientOnly fallback={loading}>
        <Suspense fallback={loading}>
          <DashboardClient loaderData={loaderData} />
        </Suspense>
      </ClientOnly>
    </div>
  );
}

function DashboardClient({ loaderData }: { loaderData: DashboardLoaderData }) {
  const { automationCollectionSource } = useCurrentBackofficeContext();
  if (automationCollectionSource.status === "unavailable") {
    return (
      <BackofficeSystemState
        tone="error"
        label="Unavailable"
        title="Automation activity could not be synchronized."
        description={automationCollectionSource.message}
      />
    );
  }
  const source = automationCollectionSource.source;
  return (
    <DashboardWorkspace
      key={describeAutomationCollectionSource(source).resourceKey}
      loaderData={loaderData}
      collections={use(getAutomationBrowserDatabase(source)).collections}
    />
  );
}

function DashboardWorkspace({
  loaderData,
  collections,
}: {
  loaderData: DashboardLoaderData;
  collections: AutomationBrowserCollections;
}) {
  const now = useClock(CLOCK_TICK_MS);
  // The window start only moves when a new bucket begins, so the event query restarts rarely.
  const windowStart = dashboardBucketStarts(now)[0] ?? now;
  const runsQuery = useLiveQuery(
    (query) => dashboardRunsQuery(query, collections),
    [collections.workflowInstances],
  );
  const waitingRunsQuery = useLiveQuery(
    (query) => workflowRunRecordsQuery(query, collections, { type: "waiting" }),
    [
      collections.workflowEvents,
      collections.workflowInstances,
      collections.workflowStepEmissions,
      collections.workflowSteps,
    ],
  );
  const eventsQuery = useLiveQuery(
    (query) => dashboardEventsQuery(query, collections, new Date(windowStart)),
    [collections.events, windowStart],
  );
  const connectionEventsQuery = useLiveQuery(
    (query) => dashboardConnectionEventsQuery(query, collections),
    [collections.events],
  );
  const routesState = useAutomationRoutes(collections);
  const waitingRuns = useMemo(
    () => automationWorkflowRunsFromRecords(waitingRunsQuery.data ?? []),
    [waitingRunsQuery.data],
  );
  const dashboard = useMemo(
    () =>
      projectBackofficeDashboard({
        now,
        runs: runsQuery.data ?? [],
        waitingRuns,
        events: eventsQuery.data ?? [],
        connectionEvents: connectionEventsQuery.data ?? [],
        routes: routesState.routes,
      }),
    [
      now,
      runsQuery.data,
      waitingRuns,
      eventsQuery.data,
      connectionEventsQuery.data,
      routesState.routes,
    ],
  );

  const queries = [runsQuery, waitingRunsQuery, eventsQuery, connectionEventsQuery];
  if (queries.some((query) => query.isError) || routesState.status === "error") {
    return (
      <BackofficeSystemState
        tone="error"
        title="Automation activity could not be read."
        description="Some synchronized collections failed to load. Reload to try again."
      />
    );
  }
  if (queries.some((query) => !query.isReady) || routesState.status === "loading") {
    return (
      <BackofficeSystemState
        tone="loading"
        label="Synchronizing"
        title="Synchronizing automation activity…"
      />
    );
  }

  return (
    <DashboardSections
      dashboard={dashboard}
      now={now}
      loaderData={loaderData}
      collections={collections}
    />
  );
}

/** Relative times and the window both move with the wall clock. */
function useClock(tickMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => {
      setNow(Date.now());
    }, tickMs);
    return () => {
      window.clearInterval(timer);
    };
  }, [tickMs]);
  return now;
}
