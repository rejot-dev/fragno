import { Button, ButtonLink } from "@fragno-private/design-system/button";
import { ClientOnly } from "@fragno-private/design-system/client-only";
import { Input } from "@fragno-private/design-system/input";
import { BackofficeSystemState } from "@fragno-private/design-system/system-state";
import { Suspense, use, useEffect, useMemo, useState } from "react";
import {
  Form,
  redirect,
  useActionData,
  useNavigation,
  useSearchParams,
  type ShouldRevalidateFunctionArgs,
} from "react-router";

import { useLiveQuery } from "@tanstack/react-db";

import { backofficeRouteScopeFromResolvedScope } from "@/backoffice-runtime/resolved-scope";
import { useCurrentBackofficeContext } from "@/components/backoffice/current-context";
import { findBackofficeMe } from "@/fragno/auth/auth-server";
import {
  describeAutomationCollectionSource,
  getAutomationBrowserDatabase,
  type AutomationBrowserCollections,
} from "@/fragno/automation/tanstack/browser-database";
import { useAutomationRoutes } from "@/fragno/automation/tanstack/use-automation-routes";
import { runtimeToolWorkflowCatalog } from "@/fragno/runtime-tools/workflow-catalog.server";

import { buildBackofficeLoginPath } from "../auth-navigation";
import {
  createAutomationProject,
  loadAutomationScriptSource,
  lookupAutomationProject,
  toExternalId,
} from "../automations/data.server";
import {
  automationRuntimeScopeFromRouteParams,
  resolveAutomationScopeSelection,
} from "../automations/scope";
import { requireAutomationRouteExecution } from "../automations/scope.server";
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
import { WORKFLOW_SCRIPT_PARAM, dashboardPath } from "./path";

const RECENT_SESSION_COUNT = 5;
const CLOCK_TICK_MS = 60_000;
const CREATE_PROJECT_PARAM = "createProject";
const EMPTY_WORKFLOW_SOURCE = { script: null, scriptError: null };

type ProjectActionData = { ok: false; message: string };

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

  const workflowScriptId = url.searchParams.get(WORKFLOW_SCRIPT_PARAM)?.trim() ?? "";
  const [connectionNames, sessions, workflowSource] = await Promise.all([
    listIntegrationConnections(request, context, params),
    fetchRecentPiSessions(request, context, runtimeScope),
    workflowScriptId
      ? requireAutomationRouteExecution(request, context, params).then((execution) =>
          loadAutomationScriptSource({ context, execution, scriptId: workflowScriptId }),
        )
      : EMPTY_WORKFLOW_SOURCE,
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
    workflowSource,
    runtimeToolCatalog: runtimeToolWorkflowCatalog,
  } satisfies DashboardLoaderData;
}

/** Selecting in the graph only changes the URL; the loader matters once a workflow's source does. */
export function shouldRevalidate({
  currentUrl,
  nextUrl,
  formMethod,
  defaultShouldRevalidate,
}: ShouldRevalidateFunctionArgs): boolean {
  if (formMethod || currentUrl.pathname !== nextUrl.pathname) {
    return defaultShouldRevalidate;
  }
  return (
    currentUrl.searchParams.get(WORKFLOW_SCRIPT_PARAM) !==
    nextUrl.searchParams.get(WORKFLOW_SCRIPT_PARAM)
  );
}

export async function action({ request, params, context, url }: Route.ActionArgs) {
  const formData = await request.formData();
  if (formData.get("intent") !== "create-project") {
    return { ok: false, message: "Unknown dashboard action." } satisfies ProjectActionData;
  }

  const me = await findBackofficeMe(request, context);
  if (!me?.user) {
    throw redirect(buildBackofficeLoginPath(`${url.pathname}${url.search}`));
  }

  const organizations = me.organizations.map((entry) => entry.organization);
  const scope = automationRuntimeScopeFromRouteParams(params, organizations);
  const organization =
    scope.kind === "org" || scope.kind === "project"
      ? organizations.find(({ id }) => id === scope.orgId)
      : me.activeOrganization?.organization;
  if (!organization) {
    throw new Response("Not Found", { status: 404 });
  }

  const name = String(formData.get("name") ?? "").trim();
  if (!name) {
    return { ok: false, message: "Project name is required." } satisfies ProjectActionData;
  }
  const description = String(formData.get("description") ?? "").trim();

  const result = await createAutomationProject(context, organization.id, {
    name,
    description: description || null,
    createdByUserId: me.user.id,
  });
  const projectId = result.project ? toExternalId(result.project.id) : null;
  if (result.error || !projectId) {
    return {
      ok: false,
      message: result.error ?? "Unable to create project.",
    } satisfies ProjectActionData;
  }

  return redirect(dashboardPath({ kind: "project", orgSlug: organization.slug, projectId }));
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
  const [searchParams] = useSearchParams();
  if (searchParams.get(CREATE_PROJECT_PARAM) === "1") {
    return (
      <div className="flex flex-col gap-4 p-4 sm:p-6">
        <CreateProjectPanel
          cancelPath={dashboardPath(
            backofficeRouteScopeFromResolvedScope(loaderData.selectedScope),
          )}
        />
      </div>
    );
  }

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

function CreateProjectPanel({ cancelPath }: { cancelPath: string }) {
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const isSubmitting =
    navigation.state === "submitting" && navigation.formData?.get("intent") === "create-project";

  return (
    <section className="border border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-[10px] tracking-[0.24em] text-[var(--bo-muted-2)] uppercase">
            New project
          </p>
          <h1 className="mt-2 text-2xl font-semibold text-[var(--bo-fg)]">Create project</h1>
          <p className="mt-1 text-sm text-[var(--bo-muted)]">
            The project slug is generated automatically from the name.
          </p>
        </div>
        <ButtonLink variant="secondary" to={cancelPath} preventScrollReset>
          Cancel
        </ButtonLink>
      </div>

      {actionData?.message ? (
        <div className="mt-4 border border-red-400/40 bg-red-500/8 p-3 text-sm text-red-700 dark:text-red-200">
          <p className="text-[10px] tracking-[0.22em] uppercase">Project action failed</p>
          <p className="mt-2">{actionData.message}</p>
        </div>
      ) : null}

      <Form method="post" className="mt-4 max-w-2xl space-y-4">
        <input type="hidden" name="intent" value="create-project" />
        <label className="flex flex-col gap-1 text-xs text-[var(--bo-muted)]">
          <span className="text-[10px] tracking-[0.22em] text-[var(--bo-muted-2)] uppercase">
            Name
          </span>
          <Input name="name" required maxLength={160} placeholder="Launch Plan" />
        </label>
        <label className="flex flex-col gap-1 text-xs text-[var(--bo-muted)]">
          <span className="text-[10px] tracking-[0.22em] text-[var(--bo-muted-2)] uppercase">
            Description
          </span>
          <textarea
            name="description"
            maxLength={1000}
            rows={4}
            placeholder="What this project owns."
            className="bo-input resize-y px-3 py-2 text-sm"
          />
        </label>
        <Button variant="secondary" type="submit" disabled={isSubmitting}>
          {isSubmitting ? "Creating…" : "Create project"}
        </Button>
      </Form>
    </section>
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
      routes={routesState.routes}
      recentEvents={eventsQuery.data ?? []}
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
