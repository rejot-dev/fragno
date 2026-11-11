import type { LofiSqliteClient } from "@fragno-dev/lofi/sqlite";
import { cn } from "@fragno-private/design-system/cn";
import { formatRelativeTime } from "@fragno-private/design-system/data/relative-time";
import { PaneSpinner } from "@fragno-private/design-system/feedback/pane-message";
import { BackofficeSystemState } from "@fragno-private/design-system/feedback/system-state";
import { Icon } from "@fragno-private/design-system/icon";
import {
  WorkflowHealth,
  WorkflowRunStatusLight,
  type WorkflowHealthFilter,
  type WorkflowHealthPaths,
} from "@fragno-private/design-system/workflow-runs/workflow-health";
import { useMemo } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";

import {
  backofficeRouteScopeFromResolvedScope,
  type BackofficeScopeSelection,
} from "@/backoffice-runtime/resolved-scope";
import type { BackofficeRouteScope } from "@/backoffice-runtime/route-scope";
import { backofficePageBodyClassName } from "@/components/backoffice/page-body";
import { useClock } from "@/components/backoffice/use-clock";
import { CODEMODE_WORKFLOW } from "@/fragno/automation/engine/codemode-invocation";
import { useAutomationRead } from "@/fragno/automation/lofi/replica";
import { requireScopeSelection } from "@/layouts/backoffice-shell-request.server";

import { loadPageSources } from "../pages/load.server";
import { shouldRevalidateWithinScope } from "../scope-revalidation";
import type { Route } from "./+types/workflows";
import { DashboardReplica } from "./dashboard-replica";
import { DashboardTabs } from "./dashboard-tabs";
import {
  dashboardWorkflowsPath,
  dashboardWorkflowsView,
  type DashboardWorkflowRun,
  type DashboardWorkflowsView,
} from "./path";
import {
  projectWorkflowHealthRuns,
  projectWorkflowList,
  type WorkflowListEntry,
} from "./workflow-health";
import { WorkflowRunDetail } from "./workflow-run-detail";

// Enough runs to see how a workflow on a five-minute schedule did over most of a day.
const RUN_LIMIT = 200;
const CLOCK_TICK_MS = 60_000;
const pageClassName = `${backofficePageBodyClassName} flex flex-col gap-4`;

/** Workflows come from the scope's Automations replica; the loader only selects scope. */
export async function loader({ context }: Route.LoaderArgs) {
  return {
    selectedScope: requireScopeSelection(context),
    pageSources: loadPageSources(context),
  };
}

/** Picking a workflow, filtering its runs, or opening one only changes the URL. */
export const shouldRevalidate = shouldRevalidateWithinScope;

export function meta({ loaderData }: Route.MetaArgs) {
  return [{ title: `Workflows · ${loaderData?.selectedScope.label ?? "scope"}` }];
}

export default function BackofficeDashboardWorkflows({ loaderData }: Route.ComponentProps) {
  const { selectedScope, pageSources } = loaderData;
  return (
    <>
      <DashboardTabs
        selectedScope={selectedScope}
        active={{ kind: "workflows" }}
        pageSources={pageSources}
      />
      <div className={pageClassName}>
        <h1 className="sr-only">Workflows in {selectedScope.label}</h1>
        <DashboardReplica>
          {(replica) => <WorkflowsWorkspace selectedScope={selectedScope} replica={replica} />}
        </DashboardReplica>
      </div>
    </>
  );
}

function WorkflowsWorkspace({
  selectedScope,
  replica,
}: {
  selectedScope: BackofficeScopeSelection;
  replica: LofiSqliteClient;
}) {
  const [searchParams] = useSearchParams();
  const view = dashboardWorkflowsView(searchParams);
  const scope = backofficeRouteScopeFromResolvedScope(selectedScope);
  const now = useClock(CLOCK_TICK_MS);
  const listRead = useAutomationRead(replica, "workflowList", undefined);
  const workflows = useMemo(
    () => (listRead.status === "ready" ? projectWorkflowList(listRead.data) : null),
    [listRead],
  );
  // Links from elsewhere, such as the overview, name only the run. A Codemode run may have run a
  // saved workflow, which the tab shows it among.
  const linkedRun = view.scriptPath === null ? view.run : null;
  const codemodeRun = linkedRun?.workflowName === CODEMODE_WORKFLOW ? linkedRun : null;
  const runScriptRead = useAutomationRead(
    codemodeRun === null ? null : replica,
    "workflowRunScript",
    { instanceId: codemodeRun?.instanceId ?? "" },
  );

  const readError =
    listRead.status === "error"
      ? listRead.message
      : codemodeRun !== null && runScriptRead.status === "error"
        ? runScriptRead.message
        : null;
  if (readError !== null) {
    return (
      <BackofficeSystemState
        tone="error"
        title="Workflows could not be read."
        description={readError}
      />
    );
  }
  if (workflows === null || (codemodeRun !== null && runScriptRead.status !== "ready")) {
    return <PaneSpinner label="Reading workflows" />;
  }
  const runScript =
    codemodeRun !== null && runScriptRead.status === "ready" ? runScriptRead.data : null;
  // A run of no saved workflow, such as an agent's inline workflow or a system workflow, has no
  // other runs to show it among.
  const ownRun = linkedRun !== null && runScript === null ? linkedRun : null;
  // A workflow someone picked, as opposed to the one the page shows by default.
  const chosen = view.scriptPath ?? runScript;
  if (chosen === null && ownRun === null && workflows.length === 0) {
    return (
      <BackofficeSystemState
        tone="empty"
        title="No workflows yet"
        description="Saved workflows appear here once they run or a route starts them, with how each of their runs went."
      />
    );
  }
  const shown: ShownWorkflow | undefined =
    ownRun !== null
      ? undefined
      : chosen === null
        ? workflows[0]
        : (workflows.find((workflow) => workflow.scriptPath === chosen) ?? {
            // A linked script that has neither run nor a route to start it.
            scriptPath: chosen,
            name: chosen,
            startedBy: [],
          });
  const picked = chosen !== null || ownRun !== null;
  // Side by side on wide screens. On narrower ones the list and a picked workflow take turns.
  return (
    <div className="grid items-start gap-x-10 gap-y-8 xl:grid-cols-[16rem_minmax(0,1fr)]">
      <div className={cn("min-w-0", picked && "hidden xl:block")}>
        <WorkflowList
          workflows={workflows}
          shown={shown?.scriptPath ?? null}
          scope={scope}
          now={now}
        />
      </div>
      <div className={cn("flex min-w-0 flex-col gap-4", !picked && "hidden xl:flex")}>
        <Link
          to={dashboardWorkflowsPath(scope, {
            scriptPath: null,
            filter: { kind: "all" },
            run: null,
          })}
          className="inline-flex w-fit items-center gap-1.5 text-sm font-semibold text-[var(--bo-accent-fg)] hover:underline xl:hidden"
        >
          <Icon name="arrow-left" aria-hidden="true" className="size-4" />
          All workflows
        </Link>
        {ownRun !== null ? (
          <OwnRun run={ownRun} filter={view.filter} scope={scope} replica={replica} />
        ) : shown === undefined ? null : (
          <WorkflowView
            // Another workflow starts the view over, with its runs folded again.
            key={shown.scriptPath}
            workflow={shown}
            view={view}
            scope={scope}
            replica={replica}
            now={now}
          />
        )}
      </div>
    </div>
  );
}

/** A run of no saved workflow, which shows on its own. */
function OwnRun({
  run,
  filter,
  scope,
  replica,
}: {
  run: DashboardWorkflowRun;
  filter: WorkflowHealthFilter;
  scope: BackofficeRouteScope;
  replica: LofiSqliteClient;
}) {
  const navigate = useNavigate();
  return (
    <section aria-label="Workflow run" className="flex min-w-0 flex-col gap-2">
      <p className="text-sm text-[var(--bo-muted)]">
        This run belongs to no saved workflow, so it shows on its own.
      </p>
      <WorkflowRunDetail
        key={`${run.workflowName}/${run.instanceId}`}
        replica={replica}
        reference={{ workflowName: run.workflowName, instanceId: run.instanceId }}
        selectedStepRecordId={run.stepRecordId}
        // Selecting a step inside the run keeps the run's place in history.
        onSelectStepRecord={(stepRecordId) => {
          void navigate(
            dashboardWorkflowsPath(scope, {
              scriptPath: null,
              filter,
              run: { ...run, stepRecordId },
            }),
            { replace: true, preventScrollReset: true },
          );
        }}
        presentation={{ kind: "standalone" }}
      />
    </section>
  );
}

/** What heads the workflow the tab shows. */
type ShownWorkflow = Pick<WorkflowListEntry, "scriptPath" | "name" | "startedBy">;

function WorkflowList({
  workflows,
  shown,
  scope,
  now,
}: {
  workflows: readonly WorkflowListEntry[];
  shown: string | null;
  scope: BackofficeRouteScope;
  now: number;
}) {
  return (
    <nav aria-label="Workflows" className="flex min-w-0 flex-col">
      <h2 className="px-3 pb-2 text-xs font-medium text-[var(--bo-muted-2)]">Workflows</h2>
      <ul className="flex flex-col">
        {workflows.map((workflow) => {
          const current = workflow.scriptPath === shown;
          const latest = workflow.latestRun;
          return (
            <li key={workflow.scriptPath}>
              <Link
                to={dashboardWorkflowsPath(scope, {
                  scriptPath: workflow.scriptPath,
                  filter: { kind: "all" },
                  run: null,
                })}
                preventScrollReset
                aria-current={current ? "page" : undefined}
                title={workflow.scriptPath}
                className={cn(
                  "flex flex-col gap-1 rounded-[4px] px-3 py-2.5 transition-colors duration-150",
                  current
                    ? "bg-[var(--bo-accent-bg)]"
                    : "hover:bg-[color-mix(in_srgb,var(--bo-accent-bg)_50%,transparent)]",
                )}
              >
                <span className="flex min-h-6 items-center gap-2">
                  <span className="min-w-0 flex-1 truncate text-sm font-semibold text-[var(--bo-fg)]">
                    {workflow.name}
                  </span>
                  {latest === null ? null : <WorkflowRunStatusLight status={latest.status} />}
                </span>
                <span className="flex items-center gap-2 text-xs text-[var(--bo-muted)]">
                  <span className="min-w-0 flex-1 truncate tabular-nums">
                    {latest === null
                      ? "Has not run yet"
                      : `${workflow.runCount} ${workflow.runCount === 1 ? "run" : "runs"}`}
                    {workflow.erroredCount === 0 ? null : (
                      <span className="text-[var(--bo-failed)]">
                        {" "}
                        · {workflow.erroredCount} failed
                      </span>
                    )}
                  </span>
                  {latest === null ? null : (
                    <span className="shrink-0 text-[var(--bo-muted-2)] tabular-nums">
                      {formatRelativeTime(latest.at, now)}
                    </span>
                  )}
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

/** One workflow's runs, with the opened run beside or above them. */
function WorkflowView({
  workflow,
  view,
  scope,
  replica,
  now,
}: {
  workflow: ShownWorkflow;
  view: DashboardWorkflowsView;
  scope: BackofficeRouteScope;
  replica: LofiSqliteClient;
  now: number;
}) {
  const navigate = useNavigate();
  const runsRead = useAutomationRead(replica, "workflowScriptRuns", {
    scriptPath: workflow.scriptPath,
    limit: RUN_LIMIT,
  });
  const runs = useMemo(
    () => (runsRead.status === "ready" ? projectWorkflowHealthRuns(runsRead.data) : null),
    [runsRead],
  );

  if (runsRead.status === "error") {
    return (
      <BackofficeSystemState
        tone="error"
        title={`The runs of ${workflow.name} could not be read.`}
        description={runsRead.message}
      />
    );
  }
  if (runs === null) {
    return <PaneSpinner label={`Reading the runs of ${workflow.name}`} />;
  }

  // Links pin the workflow, because without it the page shows its first workflow.
  const at = (next: Pick<DashboardWorkflowsView, "filter" | "run">) =>
    dashboardWorkflowsPath(scope, { scriptPath: workflow.scriptPath, ...next });
  const paths: WorkflowHealthPaths = {
    filter: (filter) => at({ filter, run: view.run }),
    run: (instanceId, stepRecordId) =>
      at({
        filter: view.filter,
        run: { workflowName: CODEMODE_WORKFLOW, instanceId, stepRecordId },
      }),
    close: at({ filter: view.filter, run: null }),
  };
  const opened = view.run;
  return (
    <WorkflowHealth
      name={workflow.name}
      description={[...workflow.startedBy, workflow.scriptPath].join(" · ")}
      runs={runs}
      filter={view.filter}
      openedRun={
        opened === null
          ? null
          : {
              id: opened.instanceId,
              view: (
                <WorkflowRunDetail
                  key={opened.instanceId}
                  replica={replica}
                  reference={{ workflowName: opened.workflowName, instanceId: opened.instanceId }}
                  selectedStepRecordId={opened.stepRecordId}
                  // Selecting a step inside the run keeps the run's place in history.
                  onSelectStepRecord={(stepRecordId) => {
                    void navigate(
                      at({
                        filter: view.filter,
                        run: { ...opened, stepRecordId },
                      }),
                      { replace: true, preventScrollReset: true },
                    );
                  }}
                  presentation={{ kind: "standalone" }}
                />
              ),
            }
      }
      paths={paths}
      now={now}
    />
  );
}
