import { backofficeScopeProjectOwner } from "@fragno-dev/backoffice-api/v0/shared/scope";
import { Button, ButtonLink } from "@fragno-private/design-system/button";
import { ClientOnly } from "@fragno-private/design-system/client-only";
import { Field } from "@fragno-private/design-system/field";
import { Input } from "@fragno-private/design-system/input";
import { BackofficeSystemState } from "@fragno-private/design-system/system-state";
import { TextArea } from "@fragno-private/design-system/text-area";
import { Suspense, use, useMemo, useSyncExternalStore } from "react";
import {
  Form,
  redirect,
  useActionData,
  useNavigation,
  useSearchParams,
  type ShouldRevalidateFunctionArgs,
} from "react-router";

import { eq, not, useLiveQuery } from "@tanstack/react-db";

import { isBackofficeObjectAvailableInContext } from "@/backoffice-runtime/object-registry";
import {
  backofficeRouteScopeFromResolvedScope,
  backofficeRuntimeScopeFromResolvedScope,
} from "@/backoffice-runtime/resolved-scope";
import { useCurrentBackofficeContext } from "@/components/backoffice/current-context";
import { backofficePageBodyClassName } from "@/components/backoffice/page-body";
import { useClock } from "@/components/backoffice/use-clock";
import {
  describeAutomationCollectionSource,
  getAutomationBrowserDatabase,
  getAutomationCatchUpProgress,
  subscribeAutomationCatchUpProgress,
  type AutomationBrowserCollections,
} from "@/fragno/automation/tanstack/browser-database";
import { useAutomationRoutes } from "@/fragno/automation/tanstack/use-automation-routes";
import { runtimeToolWorkflowCatalog } from "@/fragno/runtime-tools/workflow-catalog.server";
import {
  getBackofficeShellRequest,
  requireRouteScope,
  requireScopeSelection,
} from "@/layouts/backoffice-shell-request.server";

import { piAgentListings, piAgentTurnsQuery } from "../agents/agent-activity";
import { createAutomationProject, loadAutomationScriptSource } from "../automations/data.server";
import {
  automationWorkflowRunsFromRecords,
  workflowRunRecordsQuery,
} from "../automations/script-view/use-script-workflow-runs";
import type { Route } from "./+types/dashboard";
import { AutomationBrowserPersistenceDiagnosticPanel } from "./browser-persistence-diagnostics";
import { DashboardSections, type DashboardLoaderData } from "./dashboard-sections";
import { DashboardTabs } from "./dashboard-tabs";
import {
  dashboardBucketStarts,
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

export async function loader({ context, url }: Route.LoaderArgs) {
  const selectedScope = requireScopeSelection(context);
  const workflowScriptId = url.searchParams.get(WORKFLOW_SCRIPT_PARAM)?.trim() ?? "";
  const workflowSource = workflowScriptId
    ? await loadAutomationScriptSource({
        context,
        execution: requireRouteScope(context).execution,
        scriptId: workflowScriptId,
      })
    : EMPTY_WORKFLOW_SOURCE;
  return {
    selectedScope,
    // Some workspaces, such as an installed app's, have no agents.
    hasAgents: isBackofficeObjectAvailableInContext(
      "PI_MANAGER",
      backofficeRuntimeScopeFromResolvedScope(selectedScope),
    ),
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

export function meta({ loaderData }: Route.MetaArgs) {
  return [{ title: `Dashboard · ${loaderData?.selectedScope.label ?? "scope"}` }];
}

export default function BackofficeDashboard({ loaderData }: Route.ComponentProps) {
  const [searchParams] = useSearchParams();
  const overviewPath = dashboardPath(
    backofficeRouteScopeFromResolvedScope(loaderData.selectedScope),
  );
  const header = <DashboardTabs selectedScope={loaderData.selectedScope} active="overview" />;
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

  const loading = <DashboardSynchronizationLoading />;

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

function DashboardSynchronizationLoading() {
  const { automationCollectionSource } = useCurrentBackofficeContext();
  const resourceKey =
    automationCollectionSource.status === "ready"
      ? describeAutomationCollectionSource(automationCollectionSource.source).resourceKey
      : null;
  const progress = useSyncExternalStore(
    (listener) =>
      resourceKey ? subscribeAutomationCatchUpProgress(resourceKey, listener) : () => {},
    () => (resourceKey ? getAutomationCatchUpProgress(resourceKey) : null),
    () => null,
  );

  return (
    <BackofficeSystemState
      tone="loading"
      label="Synchronizing"
      title="Synchronizing automation activity…"
      description={
        progress
          ? `${progress.percent}%`
          : "Connecting routes, workflows, scripts, and runtime state for this scope."
      }
    >
      {import.meta.env.DEV && resourceKey ? (
        <AutomationBrowserPersistenceDiagnosticPanel resourceKey={resourceKey} />
      ) : null}
    </BackofficeSystemState>
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
  const runsQuery = useLiveQuery({ query: (query) => dashboardRunsQuery(query, collections) });
  const waitingRunsQuery = useLiveQuery({
    query: (query) => workflowRunRecordsQuery(query, collections, { type: "waiting" }),
  });
  const waitsQuery = useLiveQuery({
    query: (query) => query.from({ wait: collections.workflowWaits }),
  });
  const eventsQuery = useLiveQuery({
    query: (query) => dashboardEventsQuery(query, collections, new Date(windowStart)),
  });
  const connectionsQuery = useLiveQuery({
    query: (query) =>
      query
        .from({ connection: collections.connections })
        .where(({ connection }) => not(eq(connection.state, "disconnected")))
        .orderBy(({ connection }) => connection.service, "asc")
        .orderBy(({ connection }) => connection.connectionId, "asc"),
  });
  // The most recently active agents come first; agents without activity keep directory order.
  const agentsQuery = useLiveQuery({
    query: (query) =>
      query
        .from({ agent: collections.agents })
        .orderBy(({ agent }) => agent.latestAt, { direction: "desc", nulls: "last" })
        .orderBy(({ agent }) => agent.builtIn, "desc")
        .orderBy(({ agent }) => agent.agentName, "asc"),
  });
  const agentTurnsQuery = useLiveQuery({
    query: (query) => piAgentTurnsQuery(query, collections, new Date(windowStart)),
  });
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
        waits: waitsQuery.data ?? [],
        events: eventsQuery.data ?? [],
        connections: connectionsQuery.data ?? [],
        routes: routesState.routes,
      }),
    [
      now,
      runsQuery.data,
      waitingRuns,
      waitsQuery.data,
      eventsQuery.data,
      connectionsQuery.data,
      routesState.routes,
    ],
  );

  const agents = useMemo(
    () =>
      piAgentListings(
        agentsQuery.data ?? [],
        agentTurnsQuery.data ?? [],
        dashboard.eventVolume.bucketStarts,
      ),
    [agentsQuery.data, agentTurnsQuery.data, dashboard.eventVolume.bucketStarts],
  );

  const queries = [
    runsQuery,
    waitingRunsQuery,
    waitsQuery,
    eventsQuery,
    connectionsQuery,
    agentsQuery,
    agentTurnsQuery,
  ];
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
      agents={agents}
    />
  );
}
