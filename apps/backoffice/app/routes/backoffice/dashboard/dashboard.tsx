import { backofficeScopeProjectOwner } from "@fragno-dev/backoffice-api/v0/shared/scope";
import type { LofiSqliteClient } from "@fragno-dev/lofi/sqlite";
import { Button, ButtonLink } from "@fragno-private/design-system/button";
import { Field } from "@fragno-private/design-system/field";
import { Input } from "@fragno-private/design-system/input";
import { PaneSpinner } from "@fragno-private/design-system/pane-message";
import { BackofficeSystemState } from "@fragno-private/design-system/system-state";
import { TextArea } from "@fragno-private/design-system/text-area";
import { useMemo } from "react";
import { Form, redirect, useActionData, useNavigation, useSearchParams } from "react-router";

import { isBackofficeObjectAvailableInContext } from "@/backoffice-runtime/object-registry";
import {
  backofficeRouteScopeFromResolvedScope,
  backofficeRuntimeScopeFromResolvedScope,
} from "@/backoffice-runtime/resolved-scope";
import { backofficePageBodyClassName } from "@/components/backoffice/page-body";
import { useClock } from "@/components/backoffice/use-clock";
import { useAutomationRead } from "@/fragno/automation/lofi/replica";
import {
  getBackofficeShellRequest,
  requireRouteScope,
  requireScopeSelection,
} from "@/layouts/backoffice-shell-request.server";

import { piAgentListings } from "../agents/agent-activity";
import { createAutomationProject } from "../automations/data.server";
import { loadPageSources, type PageSources } from "../pages/load.server";
import { shouldRevalidateWithinScope } from "../scope-revalidation";
import type { Route } from "./+types/dashboard";
import { DashboardReplica } from "./dashboard-replica";
import { DashboardSections, type DashboardLoaderData } from "./dashboard-sections";
import { DashboardTabs } from "./dashboard-tabs";
import { projectEventTraceList } from "./event-traces";
import { dashboardBucketStarts, projectBackofficeDashboard } from "./overview";
import { dashboardPath } from "./path";

const CLOCK_TICK_MS = 60_000;
// Enough traces that, with repeats folded into one row, recent activity still fills its rows.
const RECENT_TRACE_LIMIT = 50;
const CREATE_PROJECT_PARAM = "createProject";
const pageClassName = `${backofficePageBodyClassName} flex flex-col gap-4`;

type ProjectActionData = { ok: false; message: string };

export async function loader({ context }: Route.LoaderArgs) {
  const selectedScope = requireScopeSelection(context);
  return {
    selectedScope,
    // Some workspaces, such as an installed app's, have no agents.
    hasAgents: isBackofficeObjectAvailableInContext(
      "PI_MANAGER",
      backofficeRuntimeScopeFromResolvedScope(selectedScope),
    ),
    pageSources: loadPageSources(context),
  } satisfies DashboardLoaderData & { pageSources: Promise<PageSources> };
}

/** Opening a run only changes the URL; everything the page shows comes from the replica. */
export const shouldRevalidate = shouldRevalidateWithinScope;

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
  const header = (
    <DashboardTabs
      selectedScope={loaderData.selectedScope}
      active={{ kind: "overview" }}
      pageSources={loaderData.pageSources}
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

  return (
    <>
      {header}
      <div className={pageClassName}>
        <h1 className="sr-only">Dashboard for {loaderData.selectedScope.label}</h1>
        <DashboardReplica>
          {(replica) => <DashboardWorkspace loaderData={loaderData} replica={replica} />}
        </DashboardReplica>
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

function DashboardWorkspace({
  loaderData,
  replica,
}: {
  loaderData: DashboardLoaderData;
  replica: LofiSqliteClient;
}) {
  const now = useClock(CLOCK_TICK_MS);
  // The window start only moves when a new bucket begins, so the view opens again rarely.
  const windowStart = dashboardBucketStarts(now)[0] ?? now;
  const reading = useAutomationRead(replica, "dashboardOverview", { since: windowStart });
  const tracesRead = useAutomationRead(replica, "eventTraceSummaries", {
    limit: RECENT_TRACE_LIMIT,
    origins: "acted-on",
  });
  const overview = reading.status === "ready" ? reading.data : null;
  const traces = tracesRead.status === "ready" ? tracesRead.data : null;
  const dashboard = useMemo(
    () =>
      overview &&
      projectBackofficeDashboard({
        now,
        runs: overview.runs,
        waitingRuns: overview.waitingRuns,
        waits: overview.waits,
        connections: overview.connections,
        routes: overview.routes,
      }),
    [now, overview],
  );
  const agents = useMemo(
    () =>
      overview && dashboard
        ? piAgentListings(overview.agents, overview.agentTurns, dashboard.bucketStarts)
        : [],
    [overview, dashboard],
  );
  const recentActivity = useMemo(() => (traces ? projectEventTraceList(traces) : null), [traces]);

  const readError =
    reading.status === "error"
      ? reading.message
      : tracesRead.status === "error"
        ? tracesRead.message
        : null;
  if (readError !== null) {
    return (
      <BackofficeSystemState
        tone="error"
        title="Automation activity could not be read."
        description={readError}
      />
    );
  }
  if (!overview || !dashboard || !recentActivity) {
    return <PaneSpinner label="Reading automation activity" />;
  }

  return (
    <DashboardSections
      dashboard={dashboard}
      now={now}
      loaderData={loaderData}
      replica={replica}
      recentActivity={recentActivity}
      agents={agents}
    />
  );
}
