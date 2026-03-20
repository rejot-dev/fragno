import type { ReactNode } from "react";
import { Link, useLoaderData } from "react-router";

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

  return (
    <div className="space-y-3">
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
        <DetailItem label="Run number" value={detail.meta.runNumber} />
        <DetailItem label="Created" value={formatTimestamp(detail.meta.createdAt) || "Unknown"} />
        <DetailItem label="Updated" value={formatTimestamp(detail.meta.updatedAt) || "Unknown"} />
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
          <p className="mt-2 text-sm text-[var(--bo-muted)]">No active step for this instance.</p>
        ) : (
          <div className="mt-3 space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-semibold text-[var(--bo-fg)]">{currentStep.name}</span>
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

      <div className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)]">
        <div className="border-b border-[color:var(--bo-border)] px-3 py-2">
          <p className="text-[10px] tracking-[0.22em] text-[var(--bo-muted-2)] uppercase">Params</p>
        </div>
        <pre className="max-h-[220px] overflow-auto p-3 text-xs text-[var(--bo-fg)]">
          {paramsText || "No params recorded."}
        </pre>
      </div>

      <div className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)]">
        <div className="border-b border-[color:var(--bo-border)] px-3 py-2">
          <p className="text-[10px] tracking-[0.22em] text-[var(--bo-muted-2)] uppercase">Output</p>
        </div>
        <pre className="max-h-[220px] overflow-auto p-3 text-xs text-[var(--bo-fg)]">
          {outputText || "No output recorded."}
        </pre>
      </div>

      <section className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-[10px] tracking-[0.24em] text-[var(--bo-muted-2)] uppercase">
            Steps · Run {detail.history.runNumber}
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
          <div className="backoffice-scroll overflow-x-auto border border-[color:var(--bo-border)]">
            <table className="min-w-full divide-y divide-[color:var(--bo-border)] text-sm">
              <thead className="bg-[var(--bo-panel-2)] text-left">
                <tr className="text-[11px] tracking-[0.22em] text-[var(--bo-muted-2)] uppercase">
                  <th scope="col" className="px-3 py-2">
                    Step
                  </th>
                  <th scope="col" className="px-3 py-2">
                    Status
                  </th>
                  <th scope="col" className="px-3 py-2">
                    Attempts
                  </th>
                  <th scope="col" className="px-3 py-2">
                    Updated
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[color:var(--bo-border)] bg-[var(--bo-panel)]">
                {detail.history.steps.map((step) => (
                  <tr key={step.id} className="text-[var(--bo-muted)]">
                    <td className="px-3 py-2">
                      <p className="font-semibold text-[var(--bo-fg)]">{step.name}</p>
                      <p className="text-xs text-[var(--bo-muted-2)]">
                        {step.stepKey} · {step.type}
                      </p>
                    </td>
                    <td className="px-3 py-2">
                      <span
                        className={`border px-2 py-1 text-[10px] tracking-[0.22em] uppercase ${getStepStatusBadgeClasses(step.status)}`}
                      >
                        {step.status}
                      </span>
                    </td>
                    <td className="px-3 py-2">
                      {step.attempts} / {step.maxAttempts}
                    </td>
                    <td className="px-3 py-2">{formatTimestamp(step.updatedAt) || "Unknown"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-[10px] tracking-[0.24em] text-[var(--bo-muted-2)] uppercase">
            Events · Run {detail.history.runNumber}
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
          <div className="space-y-3">
            {detail.history.events.map((event) => (
              <div
                key={event.id}
                className="border border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-3"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <p className="text-sm font-semibold text-[var(--bo-fg)]">{event.type}</p>
                    <p className="text-xs text-[var(--bo-muted-2)]">Event ID: {event.id}</p>
                  </div>
                  <p className="text-xs text-[var(--bo-muted-2)]">
                    {formatTimestamp(event.createdAt) || "Unknown"}
                  </p>
                </div>
                <p className="mt-2 text-xs text-[var(--bo-muted-2)]">
                  Consumed by: {event.consumedByStepKey ?? "Not consumed yet"}
                </p>
                <pre className="mt-2 max-h-[180px] overflow-auto border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] p-2 text-xs text-[var(--bo-fg)]">
                  {formatJson(event.payload) || "No payload"}
                </pre>
              </div>
            ))}
          </div>
        )}
      </section>
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
