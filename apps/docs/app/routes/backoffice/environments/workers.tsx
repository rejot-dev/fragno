import type {
  CloudflareAppState,
  CloudflareAppSummary,
  CloudflareDeploymentDetail,
  CloudflareDeploymentStatus,
  CloudflareDeploymentSummary,
} from "@fragno-dev/cloudflare-fragment";
import { useState, type FormEvent } from "react";
import { Form, Link, redirect, useActionData, useLoaderData, useNavigation } from "react-router";
import { BackofficePageHeader } from "@/components/backoffice";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  buildCloudflareWorkerDispatchPath,
  isCloudflareWorkerDispatchEnabled,
} from "@/cloudflare/worker-dispatch";
import { getAuthMe } from "@/fragno/auth-server";
import {
  fetchCloudflareAppState,
  fetchCloudflareApps,
  fetchCloudflareDeployment,
  queueCloudflareDeployment,
} from "./workers.data";
import {
  readWorkersSearchState,
  readWorkersRouteState,
  toWorkersPath,
  type WorkersView,
} from "./workers.route-state";
import type { Route } from "./+types/workers";

type WorkerDetailTab = "info" | "request" | "source";
type WorkerRequestMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD";
type WorkerStatus = CloudflareDeploymentStatus | "uninitialized";

type WorkersLoaderData = {
  organizationId: string | null;
  activeWorkers: CloudflareAppSummary[];
  selectedWorker: CloudflareAppState | null;
  selectedWorkerId: string | null;
  deployments: CloudflareDeploymentSummary[];
  latestDeploymentDetail: CloudflareDeploymentDetail | null;
  view: WorkersView;
  loadError: string | null;
  liveError: string | null;
  detailError: string | null;
  sourceError: string | null;
};

type WorkerFormValues = {
  appId: string;
  entrypoint: string;
  compatibilityDate: string;
  compatibilityFlags: string;
  sourceCode: string;
};

type DeployActionError = {
  intent: "deploy";
  ok: false;
  target: WorkersView;
  workerId: string;
  message: string;
  values: WorkerFormValues;
};

type WorkerResponseSnapshot = {
  status: number;
  statusText: string;
  durationMs: number;
  headers: Array<[string, string]>;
  body: string;
};

const DEFAULT_SOURCE_TEMPLATE = `export default {
  async fetch() {
    return new Response("Hello from Workers");
  },
};`;
const DEFAULT_DEPLOYMENT_ENTRYPOINT = "index.mjs";

const DEFAULT_NEW_WORKER_VALUES: WorkerFormValues = {
  appId: "",
  entrypoint: DEFAULT_DEPLOYMENT_ENTRYPOINT,
  compatibilityDate: "",
  compatibilityFlags: "",
  sourceCode: DEFAULT_SOURCE_TEMPLATE,
};

const DEFAULT_WORKER_REQUEST_METHOD: WorkerRequestMethod = "GET";
const DEFAULT_WORKER_REQUEST_PATH = "/";

const ORG_REQUIRED_MESSAGE =
  "No active organisation selected. Select an organisation in Backoffice and try again.";

const STATUS_LABELS: Record<WorkerStatus, string> = {
  queued: "Queued",
  deploying: "Deploying",
  succeeded: "Live",
  failed: "Failed",
  uninitialized: "Idle",
};

const STATUS_CLASSES: Record<WorkerStatus, string> = {
  queued:
    "border border-amber-300 bg-amber-100 text-amber-700 shadow-[0_0_0_1px_rgba(245,158,11,0.12)]",
  deploying:
    "border border-[color:var(--bo-accent)] bg-[var(--bo-accent-bg)] text-[var(--bo-accent-fg)] shadow-[0_0_0_1px_rgba(43,92,230,0.18)]",
  succeeded:
    "border border-emerald-300 bg-emerald-100 text-emerald-700 shadow-[0_0_0_1px_rgba(16,185,129,0.12)]",
  failed: "border border-red-300 bg-red-100 text-red-700 shadow-[0_0_0_1px_rgba(220,38,38,0.14)]",
  uninitialized:
    "border border-[color:var(--bo-border)] bg-[var(--bo-panel)] text-[var(--bo-muted-2)]",
};

const WORKER_DETAIL_TABS: Array<{ value: WorkerDetailTab; label: string }> = [
  { value: "info", label: "Info" },
  { value: "request", label: "Request" },
  { value: "source", label: "Source" },
];

export function meta() {
  return [
    { title: "Backoffice Workers" },
    { name: "description", content: "Manage Cloudflare Workers deployments." },
  ];
}

const withEmptyLiveDeployment = (worker: CloudflareAppSummary): CloudflareAppState => ({
  ...worker,
  liveDeployment: null,
  liveDeploymentError: null,
  deployments: [],
});

export async function loader({ request, context }: Route.LoaderArgs) {
  const organizationId = await resolveActiveOrganizationId(request, context);
  if (!organizationId) {
    return {
      organizationId: null,
      activeWorkers: [],
      selectedWorker: null,
      selectedWorkerId: null,
      deployments: [],
      latestDeploymentDetail: null,
      view: "new",
      loadError: ORG_REQUIRED_MESSAGE,
      liveError: null,
      detailError: null,
      sourceError: null,
    } satisfies WorkersLoaderData;
  }

  const { view: requestedView, workerId: requestedWorkerId } = readWorkersSearchState(
    new URL(request.url).search,
  );

  const workersResult = await fetchCloudflareApps(request, context, organizationId);
  if (workersResult.error) {
    return {
      organizationId,
      activeWorkers: [],
      selectedWorker: null,
      selectedWorkerId: null,
      deployments: [],
      latestDeploymentDetail: null,
      view: "new",
      loadError: workersResult.error,
      liveError: null,
      detailError: null,
      sourceError: null,
    } satisfies WorkersLoaderData;
  }

  if (requestedView === "new") {
    return {
      organizationId,
      activeWorkers: workersResult.apps,
      selectedWorker: null,
      selectedWorkerId: null,
      deployments: [],
      latestDeploymentDetail: null,
      view: "new",
      loadError: null,
      liveError: null,
      detailError: null,
      sourceError: null,
    } satisfies WorkersLoaderData;
  }

  const fallbackWorker = workersResult.apps[0] ?? null;
  const selectedWorkerSummary = requestedWorkerId
    ? (workersResult.apps.find((worker) => worker.id === requestedWorkerId) ?? null)
    : fallbackWorker;

  if (!selectedWorkerSummary) {
    return {
      organizationId,
      activeWorkers: workersResult.apps,
      selectedWorker: null,
      selectedWorkerId: requestedWorkerId || null,
      deployments: [],
      latestDeploymentDetail: null,
      view: workersResult.apps.length === 0 ? "new" : "detail",
      loadError: null,
      liveError: null,
      detailError: null,
      sourceError: null,
    } satisfies WorkersLoaderData;
  }

  const appStateResult = await fetchCloudflareAppState(
    request,
    context,
    organizationId,
    selectedWorkerSummary.id,
  );
  const selectedWorker = appStateResult.app ?? withEmptyLiveDeployment(selectedWorkerSummary);
  const latestDeploymentId =
    selectedWorker.latestDeployment?.id ?? selectedWorker.deployments[0]?.id ?? null;
  const latestDeploymentResult = latestDeploymentId
    ? await fetchCloudflareDeployment(request, context, organizationId, latestDeploymentId)
    : { deployment: null, error: null };

  return {
    organizationId,
    activeWorkers: workersResult.apps,
    selectedWorker,
    selectedWorkerId: selectedWorker.id,
    deployments: selectedWorker.deployments,
    latestDeploymentDetail: latestDeploymentResult.deployment,
    view: "detail",
    loadError: null,
    liveError: selectedWorker.liveDeploymentError,
    detailError: appStateResult.app ? null : appStateResult.error,
    sourceError: latestDeploymentResult.error,
  } satisfies WorkersLoaderData;
}

export async function action({ request, context }: Route.ActionArgs) {
  const formData = await request.formData();
  const intent = readText(formData.get("intent"));
  const target = readWorkersTarget(formData.get("target"));
  const values = readWorkerFormValues(formData);
  const workerId = normalizeWorkerId(values.appId);
  const normalizedValues: WorkerFormValues = {
    ...values,
    appId: workerId,
    entrypoint: values.entrypoint || DEFAULT_DEPLOYMENT_ENTRYPOINT,
  };

  const organizationId = await resolveActiveOrganizationId(request, context);
  if (!organizationId) {
    return {
      intent: "deploy",
      ok: false,
      target,
      workerId,
      message: ORG_REQUIRED_MESSAGE,
      values: normalizedValues,
    } satisfies DeployActionError;
  }

  if (intent !== "deploy") {
    throw new Response("Unsupported workers action", { status: 400 });
  }

  if (!workerId) {
    return {
      intent: "deploy",
      ok: false,
      target,
      workerId: "",
      message: "Worker id is required.",
      values: normalizedValues,
    } satisfies DeployActionError;
  }

  if (!normalizedValues.entrypoint.trim()) {
    return {
      intent: "deploy",
      ok: false,
      target,
      workerId,
      message: "Entrypoint is required.",
      values: normalizedValues,
    } satisfies DeployActionError;
  }

  if (!normalizedValues.sourceCode.trim()) {
    return {
      intent: "deploy",
      ok: false,
      target,
      workerId,
      message: "Worker source code is required.",
      values: normalizedValues,
    } satisfies DeployActionError;
  }

  if (
    normalizedValues.compatibilityDate &&
    !/^\d{4}-\d{2}-\d{2}$/.test(normalizedValues.compatibilityDate)
  ) {
    return {
      intent: "deploy",
      ok: false,
      target,
      workerId,
      message: "Compatibility date must use YYYY-MM-DD.",
      values: normalizedValues,
    } satisfies DeployActionError;
  }

  const deploymentResult = await queueCloudflareDeployment(
    request,
    context,
    organizationId,
    workerId,
    {
      script: {
        type: "esmodule",
        entrypoint: normalizedValues.entrypoint,
        content: normalizedValues.sourceCode,
      },
      compatibilityDate: normalizedValues.compatibilityDate || undefined,
      compatibilityFlags: parseCompatibilityFlags(normalizedValues.compatibilityFlags),
    },
  );

  if (deploymentResult.error) {
    return {
      intent: "deploy",
      ok: false,
      target,
      workerId,
      message: deploymentResult.error,
      values: normalizedValues,
    } satisfies DeployActionError;
  }

  return redirect(toWorkersPath({ workerId }));
}

export default function BackofficeEnvironmentWorkers() {
  const {
    organizationId,
    activeWorkers,
    selectedWorker,
    selectedWorkerId,
    deployments,
    latestDeploymentDetail,
    view,
    loadError,
    liveError,
    detailError,
    sourceError,
  } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const activeIntent = navigation.formData?.get("intent");
  const activeTarget = navigation.formData?.get("target");
  const pendingRouteState =
    navigation.state === "loading" && !navigation.formData
      ? readWorkersRouteState(navigation.location)
      : null;
  const displayView = pendingRouteState?.view ?? view;
  const pendingWorkerId = pendingRouteState?.workerId ?? null;
  const displaySelectedWorkerId =
    displayView === "detail" ? (pendingWorkerId ?? selectedWorkerId) : null;
  const isWorkerSelectionPending =
    pendingRouteState?.view === "detail" &&
    pendingWorkerId !== null &&
    pendingWorkerId !== selectedWorkerId;
  const isDeployingNew =
    navigation.state === "submitting" && activeIntent === "deploy" && activeTarget === "new";
  const isDeployingDetail =
    navigation.state === "submitting" && activeIntent === "deploy" && activeTarget === "detail";

  const newError =
    actionData?.intent === "deploy" && actionData.ok === false && actionData.target === "new"
      ? actionData.message
      : null;
  const newValues =
    actionData?.intent === "deploy" && actionData.ok === false && actionData.target === "new"
      ? actionData.values
      : DEFAULT_NEW_WORKER_VALUES;

  const detailActionError =
    actionData?.intent === "deploy" &&
    actionData.ok === false &&
    actionData.target === "detail" &&
    selectedWorkerId &&
    actionData.workerId === selectedWorkerId
      ? actionData.message
      : null;
  const detailValues =
    actionData?.intent === "deploy" &&
    actionData.ok === false &&
    actionData.target === "detail" &&
    selectedWorkerId &&
    actionData.workerId === selectedWorkerId
      ? actionData.values
      : createDetailWorkerFormValues(selectedWorker?.id ?? "", latestDeploymentDetail);

  return (
    <div className="space-y-4">
      <BackofficePageHeader
        breadcrumbs={[
          { label: "Backoffice", to: "/backoffice" },
          { label: "Environments", to: "/backoffice/environments" },
          { label: "Workers" },
        ]}
        eyebrow="Environment"
        title="Workers deployment control plane."
        description="Queue Cloudflare Workers deployments, inspect the latest state, and review recent rollout attempts."
        actions={
          <Link
            to="/backoffice/environments"
            className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.22em] text-[var(--bo-muted)] transition-colors hover:border-[color:var(--bo-border-strong)] hover:text-[var(--bo-fg)]"
          >
            Back to environments
          </Link>
        }
      />

      <section className="grid gap-4 xl:grid-cols-[20rem_minmax(0,1fr)]">
        <aside className="border border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-4 shadow-[0_1px_0_rgba(var(--bo-grid),0.2)]">
          <div className="flex items-center justify-between gap-2">
            <p className="text-[10px] uppercase tracking-[0.22em] text-[var(--bo-muted-2)]">
              Active workers
            </p>
            <span className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-2 py-1 text-[9px] font-semibold uppercase tracking-[0.16em] text-[var(--bo-muted)]">
              {activeWorkers.length}
            </span>
          </div>

          <div className="mt-3 space-y-2">
            <Link
              to={toWorkersPath({ view: "new" })}
              prefetch="intent"
              aria-current={displayView === "new" ? "page" : undefined}
              className={
                displayView === "new"
                  ? "block border border-[color:var(--bo-accent)] bg-[var(--bo-accent-bg)] px-3 py-3 text-[var(--bo-accent-fg)] shadow-[0_0_0_1px_rgba(43,92,230,0.14)]"
                  : "block border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 py-3 text-[var(--bo-muted)] transition-colors hover:border-[color:var(--bo-border-strong)] hover:bg-[var(--bo-panel)] hover:text-[var(--bo-fg)]"
              }
            >
              <p className="text-[10px] uppercase tracking-[0.24em]">New worker</p>
              <p className="mt-2 text-sm font-semibold">Queue a fresh deployment</p>
            </Link>

            {activeWorkers.length === 0 ? (
              <div className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 py-3 text-xs text-[var(--bo-muted)]">
                No workers have been queued yet.
              </div>
            ) : (
              activeWorkers.map((worker) => {
                const isSelected =
                  displayView === "detail" && displaySelectedWorkerId === worker.id;
                const isPendingSelection =
                  isWorkerSelectionPending && pendingWorkerId === worker.id;
                const status = getWorkerStatus(worker);
                const statusLabel = isPendingSelection ? "Loading" : STATUS_LABELS[status];
                const statusClass = isPendingSelection
                  ? "border border-[color:var(--bo-border-strong)] bg-[var(--bo-panel)] text-[var(--bo-fg)] animate-pulse"
                  : STATUS_CLASSES[status];

                return (
                  <Link
                    key={worker.id}
                    to={toWorkersPath({ workerId: worker.id })}
                    prefetch="intent"
                    aria-current={isSelected ? "page" : undefined}
                    className={
                      isSelected
                        ? "block border border-[color:var(--bo-accent)] bg-[var(--bo-accent-bg)] px-3 py-3 text-[var(--bo-accent-fg)] shadow-[0_0_0_1px_rgba(43,92,230,0.14)]"
                        : "block border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 py-3 text-[var(--bo-muted)] transition-colors hover:border-[color:var(--bo-border-strong)] hover:bg-[var(--bo-panel)] hover:text-[var(--bo-fg)]"
                    }
                  >
                    <div className="flex items-center justify-between gap-3">
                      <p className="truncate text-sm font-semibold">{worker.id}</p>
                      <span
                        className={`whitespace-nowrap rounded-full px-2.5 py-1 text-[9px] font-semibold uppercase tracking-[0.16em] ${statusClass}`}
                      >
                        {statusLabel}
                      </span>
                    </div>
                    <p className="mt-2 truncate text-xs text-[var(--bo-muted-2)]">
                      {worker.scriptName}
                    </p>
                  </Link>
                );
              })
            )}
          </div>
        </aside>

        <section
          aria-busy={isWorkerSelectionPending ? "true" : undefined}
          className="border border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-4 shadow-[0_1px_0_rgba(var(--bo-grid),0.2)]"
        >
          {loadError ? (
            <div className="border border-red-300 bg-red-100 p-3 text-sm text-red-700">
              Failed loading workers: {loadError}
            </div>
          ) : displayView === "new" ? (
            <NewWorkerView values={newValues} error={newError} isDeploying={isDeployingNew} />
          ) : isWorkerSelectionPending ? (
            <WorkerDetailLoadingView workerId={pendingWorkerId} />
          ) : selectedWorker ? (
            <WorkerDetailView
              key={selectedWorker.id}
              organizationId={organizationId}
              worker={selectedWorker}
              deployments={deployments}
              latestDeploymentDetail={latestDeploymentDetail}
              liveError={liveError}
              detailError={detailError}
              sourceError={sourceError}
              deployError={detailActionError}
              values={detailValues}
              isDeploying={isDeployingDetail}
            />
          ) : (
            <div className="space-y-4">
              <p className="text-[10px] uppercase tracking-[0.24em] text-[var(--bo-muted-2)]">
                Worker not found
              </p>
              <p className="text-sm text-[var(--bo-muted)]">
                The selected worker is no longer available in this workspace.
              </p>
              <Link
                to={toWorkersPath({ view: "new" })}
                className="inline-flex border border-[color:var(--bo-accent)] bg-[var(--bo-accent-bg)] px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.22em] text-[var(--bo-accent-fg)] transition-colors hover:border-[color:var(--bo-accent-strong)]"
              >
                Create new worker
              </Link>
            </div>
          )}
        </section>
      </section>
    </div>
  );
}

function WorkerDetailLoadingView({ workerId }: { workerId: string | null }) {
  return (
    <div aria-live="polite" className="space-y-5">
      <div className="overflow-hidden border border-[color:var(--bo-border-strong)] bg-[var(--bo-panel-2)] p-5">
        <span className="inline-flex border border-[color:var(--bo-border)] bg-[var(--bo-panel)] px-2 py-1 text-[10px] uppercase tracking-[0.22em] text-[var(--bo-muted)]">
          Switching workers
        </span>
        <h2 className="mt-3 truncate font-mono text-2xl font-semibold text-[var(--bo-fg)] md:text-3xl">
          {workerId ?? "Loading selection"}
        </h2>
        <p className="mt-3 max-w-2xl text-sm text-[var(--bo-muted)]">
          Refreshing live status, deployment history, and the latest source snapshot.
        </p>
      </div>

      <div className="grid gap-3 lg:grid-cols-3">
        {["Worker state", "Deployment history", "Latest source"].map((label) => (
          <div
            key={label}
            className="space-y-3 border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] p-4"
          >
            <p className="text-[10px] uppercase tracking-[0.22em] text-[var(--bo-muted-2)]">
              {label}
            </p>
            <div className="h-3 w-2/3 animate-pulse bg-[rgba(var(--bo-grid),0.22)]" />
            <div className="h-3 w-full animate-pulse bg-[rgba(var(--bo-grid),0.16)]" />
            <div className="h-3 w-5/6 animate-pulse bg-[rgba(var(--bo-grid),0.16)]" />
          </div>
        ))}
      </div>
    </div>
  );
}

function NewWorkerView({
  values,
  error,
  isDeploying,
}: {
  values: WorkerFormValues;
  error: string | null;
  isDeploying: boolean;
}) {
  return (
    <div className="space-y-5">
      <div className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] p-4">
        <p className="text-[10px] uppercase tracking-[0.24em] text-[var(--bo-muted-2)]">
          New worker
        </p>
        <h2 className="mt-2 text-2xl font-semibold tracking-tight text-[var(--bo-fg)]">
          Queue deployment
        </h2>
        <p className="mt-2 max-w-2xl text-sm text-[var(--bo-muted)]">
          Define a worker id and module source, then queue the deployment into the configured
          dispatch namespace.
        </p>
      </div>

      <WorkerDeploymentForm
        target="new"
        values={values}
        error={error}
        isDeploying={isDeploying}
        submitLabel="Queue worker"
        submitNote="The durable hook processor uploads the worker after the request commits."
      />
    </div>
  );
}

function WorkerDetailView({
  organizationId,
  worker,
  deployments,
  latestDeploymentDetail,
  liveError,
  detailError,
  sourceError,
  deployError,
  values,
  isDeploying,
}: {
  organizationId: string | null;
  worker: CloudflareAppState;
  deployments: CloudflareDeploymentSummary[];
  latestDeploymentDetail: CloudflareDeploymentDetail | null;
  liveError: string | null;
  detailError: string | null;
  sourceError: string | null;
  deployError: string | null;
  values: WorkerFormValues;
  isDeploying: boolean;
}) {
  const latestDeployment = worker.latestDeployment;
  const liveDeployment = worker.liveDeployment;
  const status = getWorkerStatus(worker);
  const [activeTab, setActiveTab] = useState<WorkerDetailTab>("info");

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3 border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] p-4">
        <div className="min-w-0">
          <p className="text-[10px] uppercase tracking-[0.22em] text-[var(--bo-muted-2)]">
            Worker details
          </p>
          <h2 className="mt-2 truncate font-mono text-xl font-semibold text-[var(--bo-fg)] md:text-2xl">
            {worker.id}
          </h2>
          <p className="mt-2 text-xs text-[var(--bo-muted)]">
            Inspect the latest rollout state and queue a new deployment for this worker.
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <span className="text-[10px] uppercase tracking-[0.2em] text-[var(--bo-muted-2)]">
              Live deployment
            </span>
            {liveDeployment ? (
              <span className="border border-[color:var(--bo-border)] bg-[var(--bo-panel)] px-2 py-1 font-mono text-xs text-[var(--bo-fg)]">
                {liveDeployment.id}
              </span>
            ) : liveError ? (
              <span className="text-xs text-amber-800">Unavailable</span>
            ) : (
              <span className="text-xs text-[var(--bo-muted)]">Not verified</span>
            )}
          </div>
        </div>
        <span
          className={`rounded-full px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.16em] ${STATUS_CLASSES[status]}`}
        >
          {STATUS_LABELS[status]}
        </span>
      </div>

      {latestDeployment?.status === "failed" && latestDeployment.errorMessage ? (
        <div className="border border-red-300 bg-red-100 p-3 text-sm text-red-700">
          Latest deployment failed: {latestDeployment.errorMessage}
        </div>
      ) : null}

      {liveError ? (
        <div className="border border-amber-300 bg-amber-100 p-3 text-sm text-amber-800">
          Could not verify the currently live deployment from Cloudflare: {liveError}
        </div>
      ) : null}

      {liveDeployment && latestDeployment && liveDeployment.id !== latestDeployment.id ? (
        <div className="border border-amber-300 bg-amber-100 p-3 text-sm text-amber-800">
          Currently live deployment is{" "}
          <span className="font-mono font-semibold text-amber-950">{liveDeployment.id}</span>. The
          latest recorded deployment is{" "}
          <span className="font-mono font-semibold text-amber-950">{latestDeployment.id}</span> (
          {STATUS_LABELS[latestDeployment.status]}).
        </div>
      ) : null}

      <Tabs
        value={activeTab}
        onValueChange={(value) => setActiveTab((value as WorkerDetailTab) || "info")}
        className="gap-4"
      >
        <TabsList className="h-auto w-full flex-wrap items-center justify-start gap-2 rounded-none border border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-2">
          {WORKER_DETAIL_TABS.map((tab) => (
            <TabsTrigger
              key={tab.value}
              value={tab.value}
              className="h-auto flex-none rounded-none border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.22em] text-[var(--bo-muted)] shadow-none transition-colors hover:border-[color:var(--bo-border-strong)] hover:text-[var(--bo-fg)] data-[state=active]:border-[color:var(--bo-accent)] data-[state=active]:bg-[var(--bo-accent-bg)] data-[state=active]:text-[var(--bo-accent-fg)] data-[state=active]:shadow-none"
            >
              {tab.label}
            </TabsTrigger>
          ))}
        </TabsList>

        <TabsContent value="info" className="space-y-4">
          <WorkerInfoTab
            worker={worker}
            deployments={deployments}
            liveDeployment={liveDeployment}
            detailError={detailError}
            latestDeployment={latestDeployment}
          />
        </TabsContent>

        <TabsContent value="request" className="space-y-4">
          <WorkerRequestView
            organizationId={organizationId}
            worker={worker}
            liveDeployment={liveDeployment}
            liveError={liveError}
            latestDeployment={latestDeployment}
          />
        </TabsContent>

        <TabsContent value="source" className="space-y-4">
          <WorkerSourceView
            worker={worker}
            latestDeploymentDetail={latestDeploymentDetail}
            sourceError={sourceError}
            deployError={deployError}
            values={values}
            isDeploying={isDeploying}
          />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function WorkerInfoTab({
  worker,
  deployments,
  liveDeployment,
  detailError,
  latestDeployment,
}: {
  worker: CloudflareAppState;
  deployments: CloudflareDeploymentSummary[];
  liveDeployment: CloudflareAppState["liveDeployment"];
  detailError: string | null;
  latestDeployment: CloudflareAppState["latestDeployment"];
}) {
  return (
    <>
      {detailError ? (
        <div className="border border-red-300 bg-red-100 p-3 text-sm text-red-700">
          Failed loading deployment history: {detailError}
        </div>
      ) : null}

      <div className="grid gap-3 lg:grid-cols-2 2xl:grid-cols-4">
        <DetailItem
          label="Script name"
          value={worker.scriptName}
          description="Deterministic script name stored by the fragment."
        />
        <DetailItem
          label="Latest deployment"
          value={latestDeployment?.id ?? "—"}
          description="Most recent deployment id recorded for this worker."
        />
        <DetailItem
          label="Runtime compatibility"
          value={
            liveDeployment?.compatibilityDate ?? latestDeployment?.compatibilityDate ?? "Default"
          }
          description="Compatibility date of the live deployment when available."
        />
        <DetailItem
          label="Last activity"
          value={
            formatDateTime(
              latestDeployment?.completedAt ??
                latestDeployment?.startedAt ??
                latestDeployment?.queuedAt ??
                worker.updatedAt,
            ) ?? "—"
          }
          description="Last state transition recorded by the fragment."
        />
      </div>

      <div className="space-y-3 border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] p-4">
        <div>
          <p className="text-[10px] uppercase tracking-[0.22em] text-[var(--bo-muted-2)]">
            Recent deployments
          </p>
          <p className="mt-1 text-xs text-[var(--bo-muted)]">
            Ordered from newest to oldest for the selected worker.
          </p>
        </div>

        {deployments.length === 0 ? (
          <p className="text-sm text-[var(--bo-muted)]">No deployments recorded yet.</p>
        ) : (
          <RecentDeploymentsTable
            deployments={deployments}
            latestDeploymentId={latestDeployment?.id ?? null}
            liveDeploymentId={liveDeployment?.id ?? null}
          />
        )}
      </div>
    </>
  );
}

function WorkerRequestView({
  organizationId,
  worker,
  liveDeployment,
  liveError,
  latestDeployment,
}: {
  organizationId: string | null;
  worker: CloudflareAppState;
  liveDeployment: CloudflareAppState["liveDeployment"];
  liveError: string | null;
  latestDeployment: CloudflareAppState["latestDeployment"];
}) {
  const dispatchEnabled = isCloudflareWorkerDispatchEnabled(import.meta.env.MODE);
  const [method, setMethod] = useState<WorkerRequestMethod>(DEFAULT_WORKER_REQUEST_METHOD);
  const [path, setPath] = useState(DEFAULT_WORKER_REQUEST_PATH);
  const [headerInput, setHeaderInput] = useState("");
  const [body, setBody] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [response, setResponse] = useState<WorkerResponseSnapshot | null>(null);
  const [isSending, setIsSending] = useState(false);
  const canSendBody = method !== "GET" && method !== "HEAD";
  const basePath = organizationId
    ? buildCloudflareWorkerDispatchPath(organizationId, worker.id)
    : "";
  const resolvedPath = resolveWorkerRequestPath(path);
  const requestTarget = `${basePath}${resolvedPath}`;

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    if (!dispatchEnabled) {
      setError(
        "Worker request dispatch is only available in development. Production traffic is intentionally not proxied through Backoffice.",
      );
      return;
    }

    if (!organizationId) {
      setError(ORG_REQUIRED_MESSAGE);
      return;
    }

    const parsedHeaders = parseWorkerRequestHeaders(headerInput);
    if (!parsedHeaders.ok) {
      setError(parsedHeaders.message);
      return;
    }

    setIsSending(true);
    setError(null);

    try {
      const startedAt = globalThis.performance?.now?.() ?? Date.now();
      const response = await fetch(requestTarget, {
        method,
        headers: parsedHeaders.headers,
        body: canSendBody && body.length > 0 ? body : undefined,
      });
      const endedAt = globalThis.performance?.now?.() ?? Date.now();
      const responseBody = await response.text();

      setResponse({
        status: response.status,
        statusText: response.statusText,
        durationMs: Math.max(0, Math.round(endedAt - startedAt)),
        headers: Array.from(response.headers.entries()).sort(([left], [right]) =>
          left.localeCompare(right),
        ),
        body: formatWorkerResponseBody(responseBody, response.headers.get("content-type")),
      });
    } catch (error) {
      setResponse(null);
      setError(error instanceof Error ? error.message : "Failed to send request to worker.");
    } finally {
      setIsSending(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] p-4">
        <p className="text-[10px] uppercase tracking-[0.22em] text-[var(--bo-muted-2)]">
          Request playground
        </p>
        <p className="mt-2 text-sm text-[var(--bo-muted)]">
          Send a request through the local development proxy to the deployed worker runtime.
        </p>
        <p className="mt-2 text-xs text-[var(--bo-muted-2)]">
          Target route: <span className="font-mono text-[var(--bo-fg)]">{requestTarget}</span>
        </p>
      </div>

      {!dispatchEnabled ? (
        <div className="border border-amber-300 bg-amber-100 p-3 text-sm text-amber-800">
          This tab is only active in development. Backoffice does not proxy worker traffic on the
          production docs domain.
        </div>
      ) : null}

      {liveError ? (
        <div className="border border-amber-300 bg-amber-100 p-3 text-sm text-amber-800">
          Cloudflare live deployment lookup failed, so this request may not match the runtime state
          shown elsewhere in Backoffice.
        </div>
      ) : null}

      {liveDeployment && latestDeployment && latestDeployment.id !== liveDeployment.id ? (
        <div className="border border-amber-300 bg-amber-100 p-3 text-sm text-amber-800">
          Requests are currently hitting deployment{" "}
          <strong className="font-mono">{liveDeployment.id}</strong>, while the latest recorded
          deployment is <strong className="font-mono">{latestDeployment.id}</strong> (
          {STATUS_LABELS[latestDeployment.status]}).
        </div>
      ) : null}

      {!liveDeployment && latestDeployment && latestDeployment.status !== "succeeded" ? (
        <div className="border border-amber-300 bg-amber-100 p-3 text-sm text-amber-800">
          No live deployment is currently verified. The latest recorded deployment is{" "}
          <strong>{STATUS_LABELS[latestDeployment.status]}</strong>.
        </div>
      ) : null}

      <form
        onSubmit={handleSubmit}
        className="space-y-4 border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] p-4"
      >
        {error ? (
          <div className="border border-red-300 bg-red-100 p-3 text-sm text-red-700">{error}</div>
        ) : null}

        <div className="grid gap-3 md:grid-cols-[9rem_minmax(0,1fr)]">
          <label className="block space-y-2 border border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-3">
            <span className="text-[10px] uppercase tracking-[0.2em] text-[var(--bo-muted-2)]">
              Method
            </span>
            <select
              value={method}
              onChange={(event) => setMethod(event.currentTarget.value as WorkerRequestMethod)}
              className="w-full border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 py-2 font-mono text-sm text-[var(--bo-fg)] focus:border-[color:var(--bo-accent)] focus:outline-none"
            >
              {["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"].map((entry) => (
                <option key={entry} value={entry}>
                  {entry}
                </option>
              ))}
            </select>
          </label>

          <label className="block space-y-2 border border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-3">
            <span className="text-[10px] uppercase tracking-[0.2em] text-[var(--bo-muted-2)]">
              Path
            </span>
            <input
              value={path}
              onChange={(event) => setPath(event.currentTarget.value)}
              placeholder="/"
              autoComplete="off"
              className="w-full border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 py-2 font-mono text-sm tracking-normal text-[var(--bo-fg)] placeholder:text-[var(--bo-muted-2)] focus:border-[color:var(--bo-accent)] focus:outline-none"
            />
            <span className="block text-[11px] normal-case tracking-normal text-[var(--bo-muted)]">
              Include query strings directly, for example <code>/api/hello?name=wilco</code>.
            </span>
          </label>
        </div>

        <label className="block space-y-2 border border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-3">
          <span className="text-[10px] uppercase tracking-[0.2em] text-[var(--bo-muted-2)]">
            Headers
          </span>
          <textarea
            rows={5}
            value={headerInput}
            onChange={(event) => setHeaderInput(event.currentTarget.value)}
            placeholder={"content-type: application/json\nx-example: demo"}
            className="backoffice-scroll min-h-28 w-full overflow-auto border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 py-2 font-mono text-sm text-[var(--bo-fg)] placeholder:text-[var(--bo-muted-2)] focus:border-[color:var(--bo-accent)] focus:outline-none"
          />
          <span className="block text-[11px] normal-case tracking-normal text-[var(--bo-muted)]">
            One header per line using <code>name: value</code>.
          </span>
        </label>

        <label className="block space-y-2 border border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-3">
          <span className="text-[10px] uppercase tracking-[0.2em] text-[var(--bo-muted-2)]">
            Body
          </span>
          <textarea
            rows={10}
            value={body}
            onChange={(event) => setBody(event.currentTarget.value)}
            placeholder='{"message":"hello"}'
            disabled={!canSendBody}
            className="backoffice-scroll min-h-44 w-full overflow-auto border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 py-2 font-mono text-sm text-[var(--bo-fg)] placeholder:text-[var(--bo-muted-2)] focus:border-[color:var(--bo-accent)] focus:outline-none disabled:cursor-not-allowed disabled:opacity-60"
          />
          <span className="block text-[11px] normal-case tracking-normal text-[var(--bo-muted)]">
            {canSendBody
              ? "Raw request body sent as-is."
              : "GET and HEAD requests do not send a request body."}
          </span>
        </label>

        <div className="space-y-2 border border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-3">
          <button
            type="submit"
            disabled={isSending || !dispatchEnabled}
            className="inline-flex border border-[color:var(--bo-accent)] bg-[var(--bo-accent-bg)] px-4 py-2 text-[10px] font-semibold uppercase tracking-[0.22em] text-[var(--bo-accent-fg)] transition-colors hover:border-[color:var(--bo-accent-strong)] disabled:cursor-not-allowed disabled:opacity-70"
          >
            {isSending ? "Sending..." : "Send request"}
          </button>
        </div>
      </form>

      <div className="space-y-3 border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-[10px] uppercase tracking-[0.22em] text-[var(--bo-muted-2)]">
              Response
            </p>
            <p className="mt-1 text-xs text-[var(--bo-muted)]">
              Status, headers, and body from the proxied worker response.
            </p>
          </div>
          {response ? (
            <span className="border border-[color:var(--bo-border)] bg-[var(--bo-panel)] px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.18em] text-[var(--bo-muted)]">
              {response.status} {response.statusText} · {response.durationMs} ms
            </span>
          ) : null}
        </div>

        {!response ? (
          <p className="text-sm text-[var(--bo-muted)]">No request sent yet.</p>
        ) : (
          <div className="space-y-3">
            <div className="border border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-3">
              <p className="text-[10px] uppercase tracking-[0.18em] text-[var(--bo-muted-2)]">
                Headers
              </p>
              <pre className="backoffice-scroll mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-all font-mono text-xs text-[var(--bo-fg)]">
                {response.headers.length > 0
                  ? response.headers.map(([name, value]) => `${name}: ${value}`).join("\n")
                  : "No response headers."}
              </pre>
            </div>

            <div className="border border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-3">
              <p className="text-[10px] uppercase tracking-[0.18em] text-[var(--bo-muted-2)]">
                Body
              </p>
              <pre className="backoffice-scroll mt-2 max-h-[28rem] overflow-auto whitespace-pre-wrap break-words font-mono text-xs text-[var(--bo-fg)]">
                {response.body || "Response body is empty."}
              </pre>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function WorkerSourceView({
  worker,
  latestDeploymentDetail,
  sourceError,
  deployError,
  values,
  isDeploying,
}: {
  worker: CloudflareAppSummary;
  latestDeploymentDetail: CloudflareDeploymentDetail | null;
  sourceError: string | null;
  deployError: string | null;
  values: WorkerFormValues;
  isDeploying: boolean;
}) {
  return (
    <div className="space-y-4">
      <div className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] p-4">
        <p className="text-[10px] uppercase tracking-[0.22em] text-[var(--bo-muted-2)]">Source</p>
        <p className="mt-2 text-sm text-[var(--bo-muted)]">
          View the latest stored deployment source, edit it, and queue a new rollout for this
          worker.
        </p>
        {latestDeploymentDetail ? (
          <p className="mt-2 text-xs text-[var(--bo-muted-2)]">
            Loaded from deployment{" "}
            <span className="font-mono text-[var(--bo-fg)]">{latestDeploymentDetail.id}</span> with
            entrypoint{" "}
            <span className="font-mono text-[var(--bo-fg)]">
              {latestDeploymentDetail.entrypoint}
            </span>
            .
          </p>
        ) : (
          <p className="mt-2 text-xs text-[var(--bo-muted-2)]">
            No stored source snapshot is available yet. Queueing from this tab will create the next
            deployment.
          </p>
        )}
      </div>

      {sourceError ? (
        <div className="border border-red-300 bg-red-100 p-3 text-sm text-red-700">
          Failed loading stored source: {sourceError}
        </div>
      ) : null}

      <WorkerDeploymentForm
        target="detail"
        lockedWorkerId={worker.id}
        values={values}
        error={deployError}
        isDeploying={isDeploying}
        submitLabel="Queue deployment"
        submitNote="Editing the source here creates a fresh deployment row and schedules the durable upload hook."
      />
    </div>
  );
}

function WorkerDeploymentForm({
  target,
  lockedWorkerId,
  values,
  error,
  isDeploying,
  submitLabel,
  submitNote,
}: {
  target: WorkersView;
  lockedWorkerId?: string;
  values: WorkerFormValues;
  error: string | null;
  isDeploying: boolean;
  submitLabel: string;
  submitNote: string;
}) {
  const formKey = buildWorkerDeploymentFormKey(target, lockedWorkerId, values);

  return (
    <Form key={formKey} method="post" className="space-y-5">
      <input type="hidden" name="intent" value="deploy" />
      <input type="hidden" name="target" value={target} />

      {error ? (
        <div className="border border-red-300 bg-red-100 p-3 text-sm text-red-700">{error}</div>
      ) : null}

      {lockedWorkerId ? (
        <div className="border border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-3">
          <input type="hidden" name="appId" value={lockedWorkerId} />
          <p className="text-[10px] uppercase tracking-[0.2em] text-[var(--bo-muted-2)]">
            Worker id
          </p>
          <p className="mt-2 font-mono text-sm text-[var(--bo-fg)]">{lockedWorkerId}</p>
          <p className="mt-1 text-[11px] text-[var(--bo-muted)]">
            Existing worker id reused for the next deployment.
          </p>
        </div>
      ) : (
        <label className="block space-y-2 border border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-3">
          <span className="text-[10px] uppercase tracking-[0.2em] text-[var(--bo-muted-2)]">
            Worker id
          </span>
          <input
            name="appId"
            defaultValue={values.appId}
            placeholder="docs-runtime"
            autoComplete="off"
            className="w-full border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 py-2 font-mono text-sm tracking-normal text-[var(--bo-fg)] placeholder:text-[var(--bo-muted-2)] focus:border-[color:var(--bo-accent)] focus:outline-none"
          />
          <span className="block text-[11px] normal-case tracking-normal text-[var(--bo-muted)]">
            Worker ids are normalized to lowercase slug format before deployment.
          </span>
        </label>
      )}

      <div className="grid gap-3 md:grid-cols-3">
        <label className="block space-y-2 border border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-3">
          <span className="text-[10px] uppercase tracking-[0.2em] text-[var(--bo-muted-2)]">
            Entrypoint
          </span>
          <input
            name="entrypoint"
            defaultValue={values.entrypoint}
            className="w-full border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 py-2 font-mono text-sm tracking-normal text-[var(--bo-fg)] focus:border-[color:var(--bo-accent)] focus:outline-none"
          />
          <span className="block text-[11px] normal-case tracking-normal text-[var(--bo-muted)]">
            Module file name used as the worker entrypoint.
          </span>
        </label>

        <label className="block space-y-2 border border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-3">
          <span className="text-[10px] uppercase tracking-[0.2em] text-[var(--bo-muted-2)]">
            Compatibility date
          </span>
          <input
            name="compatibilityDate"
            type="text"
            defaultValue={values.compatibilityDate}
            placeholder="YYYY-MM-DD"
            autoComplete="off"
            className="w-full border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 py-2 font-mono text-sm tracking-normal text-[var(--bo-fg)] placeholder:text-[var(--bo-muted-2)] focus:border-[color:var(--bo-accent)] focus:outline-none"
          />
          <span className="block text-[11px] normal-case tracking-normal text-[var(--bo-muted)]">
            Optional override. Leave blank to use the runtime default.
          </span>
        </label>

        <label className="block space-y-2 border border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-3">
          <span className="text-[10px] uppercase tracking-[0.2em] text-[var(--bo-muted-2)]">
            Compatibility flags
          </span>
          <input
            name="compatibilityFlags"
            defaultValue={values.compatibilityFlags}
            placeholder="nodejs_compat, no_global_navigator"
            className="w-full border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 py-2 font-mono text-sm tracking-normal text-[var(--bo-fg)] placeholder:text-[var(--bo-muted-2)] focus:border-[color:var(--bo-accent)] focus:outline-none"
          />
          <span className="block text-[11px] normal-case tracking-normal text-[var(--bo-muted)]">
            Comma or newline separated.
          </span>
        </label>
      </div>

      <div className="space-y-2 border border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-3">
        <p className="text-[10px] uppercase tracking-[0.2em] text-[var(--bo-muted-2)]">
          Module source
        </p>
        <textarea
          name="sourceCode"
          rows={18}
          defaultValue={values.sourceCode}
          placeholder={DEFAULT_SOURCE_TEMPLATE}
          className="backoffice-scroll min-h-72 w-full overflow-auto border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 py-2 font-mono text-sm text-[var(--bo-fg)] placeholder:text-[var(--bo-muted-2)] focus:border-[color:var(--bo-accent)] focus:outline-none"
        />
        <p className="text-xs text-[var(--bo-muted)]">
          Provide the full ES module source for this deployment.
        </p>
      </div>

      <div className="space-y-2 border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] p-3">
        <button
          type="submit"
          disabled={isDeploying}
          className="inline-flex border border-[color:var(--bo-accent)] bg-[var(--bo-accent-bg)] px-4 py-2 text-[10px] font-semibold uppercase tracking-[0.22em] text-[var(--bo-accent-fg)] transition-colors hover:border-[color:var(--bo-accent-strong)] disabled:cursor-not-allowed disabled:opacity-70"
        >
          {isDeploying ? "Queueing..." : submitLabel}
        </button>
        <p className="text-xs text-[var(--bo-muted)]">{submitNote}</p>
      </div>
    </Form>
  );
}

function RecentDeploymentsTable({
  deployments,
  latestDeploymentId,
  liveDeploymentId,
}: {
  deployments: CloudflareDeploymentSummary[];
  latestDeploymentId: string | null;
  liveDeploymentId: string | null;
}) {
  return (
    <div className="backoffice-scroll overflow-x-auto border border-[color:var(--bo-border)]">
      <table className="min-w-full divide-y divide-[color:var(--bo-border)] text-sm">
        <thead className="bg-[var(--bo-panel-2)] text-left">
          <tr className="text-[11px] uppercase tracking-[0.22em] text-[var(--bo-muted-2)]">
            <th scope="col" className="px-3 py-2">
              Deployment
            </th>
            <th scope="col" className="px-3 py-2">
              Status
            </th>
            <th scope="col" className="px-3 py-2">
              Entrypoint
            </th>
            <th scope="col" className="px-3 py-2">
              Date
            </th>
            <th scope="col" className="px-3 py-2">
              Source size
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-[color:var(--bo-border)] bg-[var(--bo-panel)]">
          {deployments.map((deployment) => {
            const status = deployment.status;
            const isLive = liveDeploymentId === deployment.id;
            const isLatest = latestDeploymentId === deployment.id;
            const deploymentDate = getDeploymentStatusDate(deployment);

            return (
              <tr
                key={deployment.id}
                className={
                  isLive
                    ? "bg-[var(--bo-accent-bg)]/45 align-top text-[var(--bo-muted)] shadow-[inset_3px_0_0_0_var(--bo-accent)]"
                    : "align-top text-[var(--bo-muted)]"
                }
              >
                <td className="px-3 py-2">
                  <div className="min-w-0">
                    <div className="flex min-w-0 flex-wrap items-center gap-2">
                      <p className="font-mono text-xs font-semibold text-[var(--bo-fg)]">
                        {deployment.id}
                      </p>
                      {isLatest ? (
                        <span className="inline-flex border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-2 py-1 text-[9px] font-semibold uppercase tracking-[0.16em] text-[var(--bo-muted)]">
                          Latest
                        </span>
                      ) : null}
                    </div>
                    {deployment.errorMessage ? (
                      <p className="mt-1 max-w-[22rem] text-xs text-red-600">
                        {deployment.errorCode ?? "Error"}: {deployment.errorMessage}
                      </p>
                    ) : null}
                  </div>
                </td>
                <td className="px-3 py-2">
                  <span
                    className={`inline-flex rounded-full px-2.5 py-1 text-[9px] font-semibold uppercase tracking-[0.16em] ${STATUS_CLASSES[status]}`}
                  >
                    {STATUS_LABELS[status]}
                  </span>
                </td>
                <td className="px-3 py-2 font-mono text-xs text-[var(--bo-fg)]">
                  {deployment.entrypoint}
                </td>
                <td className="whitespace-nowrap px-3 py-2">
                  <div className="space-y-1">
                    <p className="text-[10px] uppercase tracking-[0.18em] text-[var(--bo-muted-2)]">
                      {deploymentDate.label}
                    </p>
                    <p className="text-xs text-[var(--bo-fg)]">{deploymentDate.value}</p>
                  </div>
                </td>
                <td className="whitespace-nowrap px-3 py-2 text-[var(--bo-fg)]">
                  {deployment.sourceByteLength} B
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function DetailItem({
  label,
  value,
  description,
}: {
  label: string;
  value: string;
  description: string;
}) {
  return (
    <div className="border border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-3">
      <p className="text-[10px] uppercase tracking-[0.18em] text-[var(--bo-muted-2)]">{label}</p>
      <p className="mt-2 text-sm font-medium text-[var(--bo-fg)]">{value || "—"}</p>
      <p className="mt-1 text-xs text-[var(--bo-muted)]">{description}</p>
    </div>
  );
}

function getWorkerStatus(worker: CloudflareAppSummary | CloudflareAppState): WorkerStatus {
  if ("liveDeployment" in worker && worker.liveDeployment) {
    return worker.liveDeployment.status;
  }

  return worker.latestDeployment?.status ?? "uninitialized";
}

function createDetailWorkerFormValues(
  workerId: string,
  latestDeploymentDetail?: CloudflareDeploymentDetail | null,
): WorkerFormValues {
  return {
    appId: workerId,
    entrypoint: latestDeploymentDetail?.entrypoint ?? DEFAULT_DEPLOYMENT_ENTRYPOINT,
    compatibilityDate: latestDeploymentDetail?.compatibilityDate ?? "",
    compatibilityFlags: latestDeploymentDetail?.compatibilityFlags.join(", ") ?? "",
    sourceCode: latestDeploymentDetail?.sourceCode || DEFAULT_SOURCE_TEMPLATE,
  };
}

function buildWorkerDeploymentFormKey(
  target: WorkersView,
  lockedWorkerId: string | undefined,
  values: WorkerFormValues,
) {
  return JSON.stringify([
    target,
    lockedWorkerId ?? "",
    values.appId,
    values.entrypoint,
    values.compatibilityDate,
    values.compatibilityFlags,
    values.sourceCode,
  ]);
}

function readWorkerFormValues(formData: FormData): WorkerFormValues {
  return {
    appId: readText(formData.get("appId")),
    entrypoint: readText(formData.get("entrypoint")) || DEFAULT_DEPLOYMENT_ENTRYPOINT,
    compatibilityDate: readText(formData.get("compatibilityDate")),
    compatibilityFlags: readText(formData.get("compatibilityFlags")),
    sourceCode: readText(formData.get("sourceCode"), false),
  };
}

function readWorkersTarget(value: FormDataEntryValue | null): WorkersView {
  return value === "detail" ? "detail" : "new";
}

function parseCompatibilityFlags(value: string): string[] | undefined {
  const flags = value
    .split(/[\n,]/)
    .map((entry) => entry.trim())
    .filter(Boolean);

  return flags.length > 0 ? flags : undefined;
}

function resolveWorkerRequestPath(value: string) {
  const normalizedValue = value.trim();

  if (!normalizedValue) {
    return "/";
  }

  if (normalizedValue.startsWith("?")) {
    return `/${normalizedValue}`;
  }

  return normalizedValue.startsWith("/") ? normalizedValue : `/${normalizedValue}`;
}

function parseWorkerRequestHeaders(
  value: string,
): { ok: true; headers: Headers } | { ok: false; message: string } {
  const headers = new Headers();
  const lines = value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  for (const line of lines) {
    const separatorIndex = line.indexOf(":");

    if (separatorIndex <= 0) {
      return {
        ok: false,
        message: `Invalid header '${line}'. Use the format 'name: value'.`,
      };
    }

    const name = line.slice(0, separatorIndex).trim();
    const headerValue = line.slice(separatorIndex + 1).trim();

    if (!name) {
      return {
        ok: false,
        message: `Invalid header '${line}'. Header names cannot be empty.`,
      };
    }

    try {
      headers.append(name, headerValue);
    } catch (error) {
      return {
        ok: false,
        message: error instanceof Error ? error.message : `Invalid header '${line}'.`,
      };
    }
  }

  return { ok: true, headers };
}

function formatWorkerResponseBody(body: string, contentType: string | null) {
  if (!body) {
    return "";
  }

  if (contentType?.includes("application/json")) {
    try {
      return JSON.stringify(JSON.parse(body), null, 2);
    } catch {
      return body;
    }
  }

  return body;
}

function normalizeWorkerId(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "")
    .replace(/-{2,}/g, "-");
}

function formatDateTime(value: string | Date | null | undefined) {
  if (!value) {
    return null;
  }

  const date = typeof value === "string" ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) {
    return null;
  }

  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

function getDeploymentStatusDate(deployment: CloudflareDeploymentSummary) {
  if (deployment.status === "succeeded" || deployment.status === "failed") {
    return {
      label: "Completed",
      value:
        formatDateTime(deployment.completedAt ?? deployment.startedAt ?? deployment.queuedAt) ??
        "—",
    };
  }

  return {
    label: "Queued",
    value: formatDateTime(deployment.queuedAt) ?? "—",
  };
}

function readText(value: FormDataEntryValue | string | null, trim = true) {
  if (typeof value !== "string") {
    return "";
  }

  return trim ? value.trim() : value;
}

async function resolveActiveOrganizationId(
  request: Request,
  context: Route.LoaderArgs["context"] | Route.ActionArgs["context"],
): Promise<string | null> {
  const me = await getAuthMe(request, context);
  return me?.activeOrganization?.organization.id ?? null;
}
