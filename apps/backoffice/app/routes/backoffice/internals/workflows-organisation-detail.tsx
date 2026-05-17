import type { ReactNode } from "react";
import { Link, useLoaderData, useSearchParams } from "react-router";

import { getAuthMe } from "@/fragno/auth/auth-server";

import type { Route } from "./+types/workflows-organisation-detail";
import {
  loadWorkflowInstanceDetail,
  resolveWorkflowFragment,
  WorkflowApiError,
  type WorkflowOrgFragment,
} from "./workflows-data";
import {
  formatJson,
  formatTimestamp,
  getStepStatusBadgeClasses,
  getWorkflowStatusBadgeClasses,
} from "./workflows-shared";

const WORKFLOW_DETAIL_TABS = [
  { id: "overview", label: "Overview" },
  { id: "steps", label: "Steps" },
  { id: "events", label: "Events" },
  { id: "emissions", label: "Emissions" },
] as const;

type WorkflowDetailTab = (typeof WORKFLOW_DETAIL_TABS)[number]["id"];

const resolveDetailTab = (value: string | null): WorkflowDetailTab => {
  return WORKFLOW_DETAIL_TABS.some((tab) => tab.id === value)
    ? (value as WorkflowDetailTab)
    : "overview";
};

type WorkflowDetailLoaderData = Awaited<ReturnType<typeof loadWorkflowInstanceDetail>> & {
  orgId: string;
  fragment: WorkflowOrgFragment;
};

export async function loader({ request, params, context }: Route.LoaderArgs) {
  if (!params.orgId || !params.fragment || !params.workflowName || !params.instanceId) {
    throw new Response("Not Found", { status: 404 });
  }

  const fragment = resolveWorkflowFragment(params.fragment);
  if (!fragment) {
    throw new Response("Not Found", { status: 404 });
  }

  const me = await getAuthMe(request, context);
  if (!me?.user) {
    throw Response.redirect(new URL("/backoffice/login", request.url), 302);
  }

  const organisation =
    me.organizations.find((entry) => entry.organization.id === params.orgId)?.organization ?? null;
  if (!organisation) {
    throw new Response("Not Found", { status: 404 });
  }

  try {
    const detail = await loadWorkflowInstanceDetail({
      request,
      context,
      orgId: params.orgId,
      fragment,
      workflowName: params.workflowName,
      instanceId: params.instanceId,
    });

    return {
      ...detail,
      orgId: params.orgId,
      fragment,
    } satisfies WorkflowDetailLoaderData;
  } catch (error) {
    if (error instanceof WorkflowApiError) {
      throw new Response(error.message, { status: error.status });
    }
    throw error;
  }
}

export default function BackofficeWorkflowsOrganisationDetail() {
  const detail = useLoaderData<typeof loader>();
  const basePath = `/backoffice/internals/workflows/${detail.orgId}/${detail.fragment}`;
  const currentStep = detail.meta.currentStep;
  const outputText = formatJson(detail.details.output);
  const paramsText = formatJson(detail.meta.params);
  const [searchParams, setSearchParams] = useSearchParams();
  const activeTab = resolveDetailTab(searchParams.get("tab"));
  const setActiveTab = (tab: WorkflowDetailTab) => {
    const nextParams = new URLSearchParams(searchParams);
    if (tab === "overview") {
      nextParams.delete("tab");
    } else {
      nextParams.set("tab", tab);
    }
    setSearchParams(nextParams, { preventScrollReset: true });
  };

  return (
    <div className="min-w-0 space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-[10px] tracking-[0.24em] text-[var(--bo-muted-2)] uppercase">
            Workflow instance
          </p>
          <h3 className="mt-2 text-xl font-semibold text-[var(--bo-fg)]">
            {detail.meta.workflowName}
          </h3>
          <p className="text-xs text-[var(--bo-muted-2)]">Instance ID: {detail.id}</p>
        </div>
        <Link
          to={basePath}
          className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 py-2 text-[10px] font-semibold tracking-[0.22em] text-[var(--bo-muted)] uppercase transition-colors hover:border-[color:var(--bo-border-strong)] hover:text-[var(--bo-fg)] lg:hidden"
        >
          Back to list
        </Link>
      </div>

      <div
        role="tablist"
        aria-label="Workflow instance detail tabs"
        className="flex flex-wrap items-center gap-2 border border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-2"
      >
        {WORKFLOW_DETAIL_TABS.map((tab) => {
          const isActive = activeTab === tab.id;

          return (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={isActive}
              onClick={() => setActiveTab(tab.id)}
              className={
                isActive
                  ? "border border-[color:var(--bo-accent)] bg-[var(--bo-accent-bg)] px-3 py-2 text-[10px] font-semibold tracking-[0.22em] text-[var(--bo-accent-fg)] uppercase"
                  : "border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 py-2 text-[10px] font-semibold tracking-[0.22em] text-[var(--bo-muted)] uppercase transition-colors hover:border-[color:var(--bo-border-strong)] hover:text-[var(--bo-fg)]"
              }
            >
              {tab.label}
            </button>
          );
        })}
      </div>

      {activeTab === "overview" ? (
        <>
          <div className="grid gap-3 md:grid-cols-2">
            <DetailItem
              label="State"
              value={
                <span
                  className={`inline-flex border px-2 py-1 text-[10px] tracking-[0.22em] uppercase ${getWorkflowStatusBadgeClasses(detail.details.status)}`}
                >
                  {detail.details.status}
                </span>
              }
            />
            <DetailItem
              label="Created"
              value={formatTimestamp(detail.meta.createdAt) || "Unknown"}
            />
            <DetailItem
              label="Updated"
              value={formatTimestamp(detail.meta.updatedAt) || "Unknown"}
            />
            <DetailItem
              label="Started"
              value={formatTimestamp(detail.meta.startedAt) || "Not started yet"}
            />
            <DetailItem
              label="Completed"
              value={formatTimestamp(detail.meta.completedAt) || "Not completed"}
            />
          </div>

          <div className="border border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-3">
            <p className="text-[10px] tracking-[0.22em] text-[var(--bo-muted-2)] uppercase">
              Current step
            </p>
            {!currentStep ? (
              <p className="mt-2 text-sm text-[var(--bo-muted)]">
                No active step for this instance.
              </p>
            ) : (
              <div className="mt-3 space-y-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-semibold text-[var(--bo-fg)]">
                    {currentStep.name}
                  </span>
                  <span className="text-xs text-[var(--bo-muted-2)]">{currentStep.type}</span>
                  <span
                    className={`inline-flex border px-2 py-1 text-[10px] tracking-[0.22em] uppercase ${getStepStatusBadgeClasses(currentStep.status)}`}
                  >
                    {currentStep.status}
                  </span>
                </div>
                <div className="grid gap-3 md:grid-cols-2">
                  <DetailItem
                    label="Attempts"
                    value={`${currentStep.attempts} / ${currentStep.maxAttempts}`}
                  />
                  <DetailItem
                    label="Waiting event"
                    value={currentStep.waitEventType ?? "Not waiting for event"}
                  />
                  <DetailItem
                    label="Next retry"
                    value={formatTimestamp(currentStep.nextRetryAt) || "Not scheduled"}
                  />
                  <DetailItem
                    label="Wake at"
                    value={formatTimestamp(currentStep.wakeAt) || "Not scheduled"}
                  />
                </div>
                {currentStep.error ? (
                  <div className="border border-red-200 bg-red-50 p-3 text-sm text-red-600">
                    {currentStep.error.name}: {currentStep.error.message}
                  </div>
                ) : null}
              </div>
            )}
          </div>

          {detail.details.error ? (
            <div className="border border-red-200 bg-red-50 p-3 text-sm text-red-600">
              {detail.details.error.name}: {detail.details.error.message}
            </div>
          ) : null}

          <div className="max-w-full min-w-0 overflow-hidden border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)]">
            <div className="border-b border-[color:var(--bo-border)] px-3 py-2">
              <p className="text-[10px] tracking-[0.22em] text-[var(--bo-muted-2)] uppercase">
                Params
              </p>
            </div>
            <pre className="backoffice-scroll max-h-[220px] w-full max-w-full min-w-0 overflow-auto p-3 text-xs whitespace-pre text-[var(--bo-fg)]">
              {paramsText || "No params recorded."}
            </pre>
          </div>

          <div className="max-w-full min-w-0 overflow-hidden border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)]">
            <div className="border-b border-[color:var(--bo-border)] px-3 py-2">
              <p className="text-[10px] tracking-[0.22em] text-[var(--bo-muted-2)] uppercase">
                Output
              </p>
            </div>
            <pre className="backoffice-scroll max-h-[220px] w-full max-w-full min-w-0 overflow-auto p-3 text-xs whitespace-pre text-[var(--bo-fg)]">
              {outputText || "No output recorded."}
            </pre>
          </div>
        </>
      ) : null}

      {activeTab === "steps" ? (
        <section className="min-w-0 space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-[10px] tracking-[0.24em] text-[var(--bo-muted-2)] uppercase">
              Steps
            </p>
            <span className="text-xs text-[var(--bo-muted-2)]">
              {detail.history.steps.length} step{detail.history.steps.length === 1 ? "" : "s"}
            </span>
          </div>
          {detail.history.steps.length === 0 ? (
            <div className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] p-3 text-sm text-[var(--bo-muted)]">
              No recorded steps for this run yet.
            </div>
          ) : (
            <div className="backoffice-scroll max-w-full overflow-x-auto border border-[color:var(--bo-border)]">
              <table className="w-full table-fixed divide-y divide-[color:var(--bo-border)] text-sm">
                <thead className="bg-[var(--bo-panel-2)] text-left">
                  <tr className="text-[11px] tracking-[0.22em] text-[var(--bo-muted-2)] uppercase">
                    <th scope="col" className="w-72 px-4 py-2">
                      Step
                    </th>
                    <th scope="col" className="w-40 px-4 py-2">
                      Status
                    </th>
                    <th scope="col" className="w-28 px-4 py-2">
                      Attempts
                    </th>
                    <th scope="col" className="w-48 px-4 py-2">
                      Updated
                    </th>
                    <th scope="col" className="px-3 py-2">
                      Result
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[color:var(--bo-border)] bg-[var(--bo-panel)]">
                  {detail.history.steps.map((step) => (
                    <tr key={step.id} className="text-[var(--bo-muted)]">
                      <td className="px-4 py-2 align-top">
                        <p className="truncate font-semibold text-[var(--bo-fg)]" title={step.name}>
                          {step.name}
                        </p>
                        <p
                          className="truncate text-xs text-[var(--bo-muted-2)]"
                          title={`${step.stepKey} · ${step.type}`}
                        >
                          {step.stepKey} · {step.type}
                        </p>
                      </td>
                      <td className="px-4 py-2 align-top">
                        <span
                          className={`border px-2 py-1 text-[10px] tracking-[0.22em] uppercase ${getStepStatusBadgeClasses(step.status)}`}
                        >
                          {step.status}
                        </span>
                      </td>
                      <td className="px-4 py-2 align-top text-xs">
                        {step.attempts} / {step.maxAttempts}
                      </td>
                      <td className="px-4 py-2 align-top text-xs">
                        {formatTimestamp(step.updatedAt) || "Unknown"}
                      </td>
                      <td className="min-w-0 px-3 py-2 align-top">
                        <pre className="backoffice-scroll max-h-80 w-full min-w-0 overflow-auto border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] p-3 font-mono text-xs whitespace-pre text-[var(--bo-fg)]">
                          {formatJson(step.result) || "No result recorded."}
                        </pre>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      ) : null}

      {activeTab === "events" ? (
        <section className="min-w-0 space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-[10px] tracking-[0.24em] text-[var(--bo-muted-2)] uppercase">
              Events
            </p>
            <span className="text-xs text-[var(--bo-muted-2)]">
              {detail.history.events.length} event{detail.history.events.length === 1 ? "" : "s"}
            </span>
          </div>
          {detail.history.events.length === 0 ? (
            <div className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] p-3 text-sm text-[var(--bo-muted)]">
              No events have been delivered for this run.
            </div>
          ) : (
            <div className="backoffice-scroll max-w-full overflow-x-auto border border-[color:var(--bo-border)]">
              <table className="w-full table-fixed divide-y divide-[color:var(--bo-border)] text-sm">
                <thead className="bg-[var(--bo-panel-2)] text-left">
                  <tr className="text-[11px] tracking-[0.22em] text-[var(--bo-muted-2)] uppercase">
                    <th scope="col" className="w-44 px-3 py-2">
                      Event
                    </th>
                    <th scope="col" className="w-44 px-3 py-2">
                      Created
                    </th>
                    <th scope="col" className="w-52 px-3 py-2">
                      Consumed by
                    </th>
                    <th scope="col" className="px-3 py-2">
                      Payload
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[color:var(--bo-border)] bg-[var(--bo-panel)]">
                  {detail.history.events.map((event) => (
                    <tr key={event.id} className="text-[var(--bo-muted)]">
                      <td className="px-3 py-2 align-top">
                        <p
                          className="truncate font-semibold text-[var(--bo-fg)]"
                          title={event.type}
                        >
                          {event.type}
                        </p>
                        <p
                          className="truncate font-mono text-xs text-[var(--bo-muted-2)]"
                          title={event.id}
                        >
                          {event.id}
                        </p>
                      </td>
                      <td className="px-3 py-2 align-top text-xs">
                        {formatTimestamp(event.createdAt) || "Unknown"}
                      </td>
                      <td className="px-3 py-2 align-top text-xs">
                        <span
                          className="block truncate"
                          title={event.consumedByStepKey ?? undefined}
                        >
                          {event.consumedByStepKey ?? "Not consumed yet"}
                        </span>
                      </td>
                      <td className="min-w-0 px-3 py-2 align-top">
                        <pre className="backoffice-scroll max-h-80 w-full min-w-0 overflow-auto border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] p-3 font-mono text-xs whitespace-pre text-[var(--bo-fg)]">
                          {formatJson(event.payload) || "No payload"}
                        </pre>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      ) : null}

      {activeTab === "emissions" ? (
        <section className="min-w-0 space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-[10px] tracking-[0.24em] text-[var(--bo-muted-2)] uppercase">
              Step emissions
            </p>
            <span className="text-xs text-[var(--bo-muted-2)]">
              {detail.history.emissions.length} emission
              {detail.history.emissions.length === 1 ? "" : "s"}
            </span>
          </div>
          {detail.history.emissions.length === 0 ? (
            <div className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] p-3 text-sm text-[var(--bo-muted)]">
              No step emissions are currently recorded for this run.
            </div>
          ) : (
            <div className="backoffice-scroll max-w-full overflow-x-auto border border-[color:var(--bo-border)]">
              <table className="w-full table-fixed divide-y divide-[color:var(--bo-border)] text-sm">
                <thead className="bg-[var(--bo-panel-2)] text-left">
                  <tr className="text-[11px] tracking-[0.22em] text-[var(--bo-muted-2)] uppercase">
                    <th scope="col" className="w-72 px-3 py-2">
                      Step
                    </th>
                    <th scope="col" className="w-32 px-3 py-2">
                      Direction
                    </th>
                    <th scope="col" className="w-44 px-3 py-2">
                      Created
                    </th>
                    <th scope="col" className="px-3 py-2">
                      Payload
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[color:var(--bo-border)] bg-[var(--bo-panel)]">
                  {detail.history.emissions.map((emission) => (
                    <tr key={emission.id} className="text-[var(--bo-muted)]">
                      <td className="px-3 py-2 align-top">
                        <p
                          className="truncate font-semibold text-[var(--bo-fg)]"
                          title={emission.stepKey}
                        >
                          {emission.stepKey}
                        </p>
                        <p
                          className="truncate font-mono text-xs text-[var(--bo-muted-2)]"
                          title={`${emission.epoch} · #${emission.sequence} · ${emission.id}`}
                        >
                          {emission.epoch} · #{emission.sequence}
                        </p>
                      </td>
                      <td className="px-3 py-2 align-top text-xs">
                        <span className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-2 py-1 font-mono text-[10px] tracking-[0.18em] text-[var(--bo-fg)] uppercase">
                          {emission.actor}
                        </span>
                      </td>
                      <td className="px-3 py-2 align-top text-xs">
                        {formatTimestamp(emission.createdAt) || "Unknown"}
                      </td>
                      <td className="min-w-0 px-3 py-2 align-top">
                        <pre className="backoffice-scroll max-h-80 w-full min-w-0 overflow-auto border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] p-3 font-mono text-xs whitespace-pre text-[var(--bo-fg)]">
                          {formatJson(emission.payload) || "No payload"}
                        </pre>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      ) : null}
    </div>
  );
}

function DetailItem({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="border border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-3">
      <p className="text-[10px] tracking-[0.22em] text-[var(--bo-muted-2)] uppercase">{label}</p>
      <div className="mt-2 text-sm text-[var(--bo-fg)]">{value}</div>
    </div>
  );
}
