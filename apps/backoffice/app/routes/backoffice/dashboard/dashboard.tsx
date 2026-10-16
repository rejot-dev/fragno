import { backofficeScopeProjectOwner } from "@fragno-dev/backoffice-api/v0/shared/scope";
import { Button, ButtonLink } from "@fragno-private/design-system/button";
import { ClientOnly } from "@fragno-private/design-system/client-only";
import { Field } from "@fragno-private/design-system/field";
import { Input } from "@fragno-private/design-system/input";
import { BackofficeSystemState } from "@fragno-private/design-system/system-state";
import { BackofficeTabHeader } from "@fragno-private/design-system/tab-header";
import { TextArea } from "@fragno-private/design-system/text-area";
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

import { isBackofficeObjectAvailableInContext } from "@/backoffice-runtime/object-registry";
import {
  backofficeRouteScopeFromResolvedScope,
  backofficeRuntimeScopeFromResolvedScope,
} from "@/backoffice-runtime/resolved-scope";
import { useCurrentBackofficeContext } from "@/components/backoffice/current-context";
import { backofficePageBodyClassName } from "@/components/backoffice/page-body";
import {
  describeAutomationCollectionSource,
  getAutomationBrowserDatabase,
  type AutomationBrowserCollections,
} from "@/fragno/automation/tanstack/browser-database";
import { useAutomationRoutes } from "@/fragno/automation/tanstack/use-automation-routes";
import { runtimeToolWorkflowCatalog } from "@/fragno/runtime-tools/workflow-catalog.server";
import {
  getBackofficeShellRequest,
  requireRouteScope,
  requireScopeSelection,
} from "@/layouts/backoffice-shell-request.server";

import { fetchPiManagerAgents, type PiManagerAgentsResult } from "../agents/data";
import { createAutomationProject, loadAutomationScriptSource } from "../automations/data.server";
import {
  automationWorkflowRunsFromRecords,
  workflowRunRecordsQuery,
} from "../automations/script-view/use-script-workflow-runs";
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

const CLOCK_TICK_MS = 60_000;
const CREATE_PROJECT_PARAM = "createProject";
const EMPTY_WORKFLOW_SOURCE = { script: null, scriptError: null };
const pageClassName = `${backofficePageBodyClassName} flex flex-col gap-4`;

type ProjectActionData = { ok: false; message: string };

export async function loader({ request, context, url }: Route.LoaderArgs) {
  const selectedScope = requireScopeSelection(context);
  const workflowScriptId = url.searchParams.get(WORKFLOW_SCRIPT_PARAM)?.trim() ?? "";
  const [agents, workflowSource] = await Promise.all([
    fetchDashboardPiAgents(
      request,
      context,
      backofficeRuntimeScopeFromResolvedScope(selectedScope),
    ),
    workflowScriptId
      ? loadAutomationScriptSource({
          context,
          execution: requireRouteScope(context).execution,
          scriptId: workflowScriptId,
        })
      : EMPTY_WORKFLOW_SOURCE,
  ]);
  return {
    selectedScope,
    agents,
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

export async function action({ request, context }: Route.ActionArgs) {
  const formData = await request.formData();
  if (formData.get("intent") !== "create-project") {
    return { ok: false, message: "Unknown dashboard action." } satisfies ProjectActionData;
  }

  const { me } = getBackofficeShellRequest(context);
  // A new project sits beside the current workspace.
  const owner = backofficeScopeProjectOwner(requireRouteScope(context).resolvedScope);
  if (!owner) {
    throw new Response("Not Found", { status: 404 });
  }

  const name = String(formData.get("name") ?? "").trim();
  if (!name) {
    return { ok: false, message: "Project name is required." } satisfies ProjectActionData;
  }
  const description = String(formData.get("description") ?? "").trim();

  const result = await createAutomationProject(
    context,
    backofficeRuntimeScopeFromResolvedScope(owner),
    {
      name,
      description: description || null,
      createdByUserId: me.user.id,
    },
  );
  const projectSlug = result.project?.slug;
  if (result.error || !projectSlug) {
    return {
      ok: false,
      message: result.error ?? "Unable to create project.",
    } satisfies ProjectActionData;
  }

  return redirect(
    dashboardPath({
      kind: "project",
      owner: backofficeRouteScopeFromResolvedScope(owner),
      projectSlug,
    }),
  );
}

/** Agents are one panel of the dashboard, so an unavailable Pi manager does not fail the page. */
async function fetchDashboardPiAgents(
  request: Request,
  context: Route.LoaderArgs["context"],
  scope: Parameters<typeof fetchPiManagerAgents>[2],
): Promise<PiManagerAgentsResult> {
  // Some workspaces, such as an installed app's, have no agents.
  if (!isBackofficeObjectAvailableInContext("PI_MANAGER", scope)) {
    return { agents: [], agentsError: null };
  }
  try {
    return await fetchPiManagerAgents(request, context, scope);
  } catch (error) {
    if (error instanceof Response) {
      return { agents: [], agentsError: `Agents are unavailable (${error.status}).` };
    }
    throw error;
  }
}

export function meta({ loaderData }: Route.MetaArgs) {
  return [{ title: `Dashboard · ${loaderData?.selectedScope.label ?? "scope"}` }];
}

export default function BackofficeDashboard({ loaderData }: Route.ComponentProps) {
  const [searchParams] = useSearchParams();
  const overviewPath = dashboardPath(
    backofficeRouteScopeFromResolvedScope(loaderData.selectedScope),
  );
  const header = (
    <BackofficeTabHeader
      items={[{ id: "overview", label: "Overview", to: overviewPath, active: true }]}
      ariaLabel="Dashboard"
      options={null}
    />
  );
  if (searchParams.get(CREATE_PROJECT_PARAM) === "1") {
    return (
      <>
        {header}
        <div className={pageClassName}>
          <CreateProjectPanel cancelPath={overviewPath} />
        </div>
      </>
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
    <>
      {header}
      <div className={pageClassName}>
        <h1 className="sr-only">Dashboard for {loaderData.selectedScope.label}</h1>
        <ClientOnly fallback={loading}>
          <Suspense fallback={loading}>
            <DashboardClient loaderData={loaderData} />
          </Suspense>
        </ClientOnly>
      </div>
    </>
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
        <Field label="Name">
          <Input
            name="name"
            required
            maxLength={160}
            placeholder="Launch Plan"
            className="w-full"
          />
        </Field>
        <Field label="Description">
          <TextArea
            name="description"
            maxLength={1000}
            rows={4}
            placeholder="What this project owns."
          />
        </Field>
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
