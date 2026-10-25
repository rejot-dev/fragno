import { Tabs } from "@base-ui/react/tabs";
import { ButtonLink } from "@fragno-private/design-system/button";
import { CodeBlock } from "@fragno-private/design-system/code-block";
import { DetailList } from "@fragno-private/design-system/detail-list";
import { InlineAlert } from "@fragno-private/design-system/inline-alert";
import { BackofficeStatusLight } from "@fragno-private/design-system/status-light";
import {
  SurfaceFacts,
  SurfacePanel,
  SurfacePanelBody,
  SurfaceTable,
  SurfaceTableRow,
  type SurfaceTableColumn,
} from "@fragno-private/design-system/surface-panel";
import { BackofficeSystemState } from "@fragno-private/design-system/system-state";
import { UnderlineTab, UnderlineTabList } from "@fragno-private/design-system/underline-tabs";
import { useLoaderData, useSearchParams } from "react-router";

import { backofficeRouteScopeFromResolvedScope } from "@/backoffice-runtime/resolved-scope";
import { backofficeRouteScopePath } from "@/backoffice-runtime/route-scope";
import { requireRouteScope } from "@/layouts/backoffice-shell-request.server";

import type { Route } from "./+types/workflows-organization-detail";
import { loadWorkflowInstanceDetail, WorkflowApiError } from "./workflows-data";
import {
  formatJson,
  formatTimestamp,
  stepStatusTone,
  workflowStatusTone,
} from "./workflows-shared";

const WORKFLOW_DETAIL_TABS = [
  { id: "overview", label: "Overview" },
  { id: "steps", label: "Steps" },
  { id: "events", label: "Events" },
  { id: "emissions", label: "Emissions" },
] as const;

type WorkflowDetailTab = (typeof WORKFLOW_DETAIL_TABS)[number]["id"];

const STEP_COLUMNS: SurfaceTableColumn[] = [
  { label: "Step", align: "start" },
  { label: "Status", align: "start" },
  { label: "Attempts", align: "end" },
  { label: "Updated", align: "start" },
  { label: "Result", align: "start" },
];

const EVENT_COLUMNS: SurfaceTableColumn[] = [
  { label: "Event", align: "start" },
  { label: "Created", align: "start" },
  { label: "Consumed by", align: "start" },
  { label: "Payload", align: "start" },
];

const EMISSION_COLUMNS: SurfaceTableColumn[] = [
  { label: "Step", align: "start" },
  { label: "Direction", align: "start" },
  { label: "Created", align: "start" },
  { label: "Payload", align: "start" },
];

const resolveDetailTab = (value: string | null): WorkflowDetailTab => {
  return WORKFLOW_DETAIL_TABS.some((tab) => tab.id === value)
    ? (value as WorkflowDetailTab)
    : "overview";
};

type WorkflowDetailLoaderData = Awaited<ReturnType<typeof loadWorkflowInstanceDetail>> & {
  scopePath: string;
};

export async function loader({ request, params, context }: Route.LoaderArgs) {
  if (!params.workflowName || !params.instanceId) {
    throw new Response("Not Found", { status: 404 });
  }
  const { resolvedScope, execution } = requireRouteScope(context);
  const routeScope = backofficeRouteScopeFromResolvedScope(resolvedScope);
  const { scope } = execution;
  try {
    const detail = await loadWorkflowInstanceDetail({
      request,
      context,
      scope,
      workflowName: params.workflowName,
      instanceId: params.instanceId,
    });
    return {
      ...detail,
      scopePath: backofficeRouteScopePath(routeScope),
    } satisfies WorkflowDetailLoaderData;
  } catch (error) {
    if (error instanceof WorkflowApiError) {
      throw new Response(error.message, { status: error.status });
    }
    throw error;
  }
}

export default function BackofficeWorkflowsOrganizationDetail() {
  const detail = useLoaderData<typeof loader>();
  const basePath = `/backoffice/internals/${detail.scopePath}/workflows`;
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
    <SurfacePanel
      caption="Workflow instance"
      actions={
        <>
          <BackofficeStatusLight tone={workflowStatusTone(detail.details.status)}>
            {detail.details.status}
          </BackofficeStatusLight>
          <ButtonLink to={basePath} variant="secondary" className="lg:hidden">
            Back to list
          </ButtonLink>
        </>
      }
    >
      <SurfaceFacts
        items={[
          { key: "workflow", label: "Workflow", value: detail.meta.workflowName },
          {
            key: "id",
            label: "Instance ID",
            value: <span className="font-mono text-xs font-normal break-all">{detail.id}</span>,
          },
        ]}
      />
      <Tabs.Root
        value={activeTab}
        onValueChange={(value: WorkflowDetailTab) => {
          setActiveTab(value);
        }}
        className="border-t border-[color:var(--bo-border)]"
      >
        <UnderlineTabList aria-label="Workflow instance detail tabs" className="px-2">
          {WORKFLOW_DETAIL_TABS.map((tab) => (
            <UnderlineTab key={tab.id} value={tab.id}>
              {tab.label}
            </UnderlineTab>
          ))}
        </UnderlineTabList>
        <Tabs.Panel value="overview">
          <WorkflowOverviewTab detail={detail} />
        </Tabs.Panel>
        <Tabs.Panel value="steps">
          <WorkflowStepsTab detail={detail} />
        </Tabs.Panel>
        <Tabs.Panel value="events">
          <WorkflowEventsTab detail={detail} />
        </Tabs.Panel>
        <Tabs.Panel value="emissions">
          <WorkflowEmissionsTab detail={detail} />
        </Tabs.Panel>
      </Tabs.Root>
    </SurfacePanel>
  );
}

function WorkflowOverviewTab({ detail }: { detail: WorkflowDetailLoaderData }) {
  const currentStep = detail.meta.currentStep;
  const outputText = formatJson(detail.details.output);
  const paramsText = formatJson(detail.meta.params);

  return (
    <>
      <SurfaceFacts
        items={[
          {
            key: "remote",
            label: "Remote workflow",
            value: detail.meta.remoteWorkflowName ?? "Not remote",
          },
          {
            key: "created",
            label: "Created",
            value: formatTimestamp(detail.meta.createdAt) || "Unknown",
          },
          {
            key: "updated",
            label: "Updated",
            value: formatTimestamp(detail.meta.updatedAt) || "Unknown",
          },
          {
            key: "started",
            label: "Started",
            value: formatTimestamp(detail.meta.startedAt) || "Not started yet",
          },
          {
            key: "completed",
            label: "Completed",
            value: formatTimestamp(detail.meta.completedAt) || "Not completed",
          },
        ]}
      />
      <SurfacePanelBody>
        <div className="flex min-w-0 flex-col gap-4">
          {detail.details.error ? (
            <InlineAlert>
              {detail.details.error.name}: {detail.details.error.message}
            </InlineAlert>
          ) : null}

          <section aria-label="Current step" className="flex flex-col gap-2">
            <h3 className="text-sm font-semibold text-[var(--bo-fg)]">Current step</h3>
            {!currentStep ? (
              <p className="text-sm text-[var(--bo-muted)]">No active step for this instance.</p>
            ) : (
              <>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-semibold text-[var(--bo-fg)]">
                    {currentStep.name}
                  </span>
                  <span className="text-xs text-[var(--bo-muted-2)]">{currentStep.type}</span>
                  <BackofficeStatusLight tone={stepStatusTone(currentStep.status)}>
                    {currentStep.status}
                  </BackofficeStatusLight>
                </div>
                <DetailList
                  items={[
                    {
                      key: "attempts",
                      label: "Attempts",
                      value: `${currentStep.attempts} / ${currentStep.maxAttempts}`,
                    },
                    {
                      key: "event",
                      label: "Waiting event",
                      value: currentStep.waitEventType ?? "Not waiting for event",
                    },
                    {
                      key: "retry",
                      label: "Next retry",
                      value: formatTimestamp(currentStep.nextRetryAt) || "Not scheduled",
                    },
                    {
                      key: "wake",
                      label: "Wake at",
                      value: formatTimestamp(currentStep.wakeAt) || "Not scheduled",
                    },
                  ]}
                />
                {currentStep.error ? (
                  <InlineAlert>
                    {currentStep.error.name}: {currentStep.error.message}
                  </InlineAlert>
                ) : null}
              </>
            )}
          </section>

          <CodeBlock label="Params" code={paramsText || "No params recorded."} />
          <CodeBlock label="Output" code={outputText || "No output recorded."} />
        </div>
      </SurfacePanelBody>
    </>
  );
}

function WorkflowStepsTab({ detail }: { detail: WorkflowDetailLoaderData }) {
  if (detail.history.steps.length === 0) {
    return <BackofficeSystemState tone="empty" title="No recorded steps for this run yet." flush />;
  }
  return (
    <SurfaceTable columns={STEP_COLUMNS}>
      {detail.history.steps.map((step) => (
        <SurfaceTableRow
          key={step.id}
          columns={STEP_COLUMNS}
          cells={[
            <div key="step" className="max-w-64 min-w-0">
              <p className="truncate font-semibold text-[var(--bo-fg)]" title={step.name}>
                {step.name}
              </p>
              <p
                className="truncate text-xs text-[var(--bo-muted-2)]"
                title={`${step.stepKey} · ${step.type}`}
              >
                {step.stepKey} · {step.type}
              </p>
            </div>,
            <BackofficeStatusLight key="status" tone={stepStatusTone(step.status)}>
              {step.status}
            </BackofficeStatusLight>,
            `${step.attempts} / ${step.maxAttempts}`,
            <span key="updated" className="text-xs whitespace-nowrap">
              {formatTimestamp(step.updatedAt) || "Unknown"}
            </span>,
            <JsonCell key="result" json={formatJson(step.result)} empty="No result recorded." />,
          ]}
        />
      ))}
    </SurfaceTable>
  );
}

function WorkflowEventsTab({ detail }: { detail: WorkflowDetailLoaderData }) {
  if (detail.history.events.length === 0) {
    return (
      <BackofficeSystemState
        tone="empty"
        title="No events have been delivered for this run."
        flush
      />
    );
  }
  return (
    <SurfaceTable columns={EVENT_COLUMNS}>
      {detail.history.events.map((event) => (
        <SurfaceTableRow
          key={event.id}
          columns={EVENT_COLUMNS}
          cells={[
            <div key="event" className="max-w-56 min-w-0">
              <p className="truncate font-semibold text-[var(--bo-fg)]" title={event.type}>
                {event.type}
              </p>
              <p className="truncate font-mono text-xs text-[var(--bo-muted-2)]" title={event.id}>
                {event.id}
              </p>
            </div>,
            <span key="created" className="text-xs whitespace-nowrap">
              {formatTimestamp(event.createdAt) || "Unknown"}
            </span>,
            <span key="consumed" className="text-xs">
              {event.consumedByStepKey ?? "Not consumed yet"}
            </span>,
            <JsonCell key="payload" json={formatJson(event.payload)} empty="No payload" />,
          ]}
        />
      ))}
    </SurfaceTable>
  );
}

function WorkflowEmissionsTab({ detail }: { detail: WorkflowDetailLoaderData }) {
  if (detail.history.emissions.length === 0) {
    return (
      <BackofficeSystemState
        tone="empty"
        title="No step emissions are recorded for this run."
        flush
      />
    );
  }
  return (
    <SurfaceTable columns={EMISSION_COLUMNS}>
      {detail.history.emissions.map((emission) => (
        <SurfaceTableRow
          key={emission.id}
          columns={EMISSION_COLUMNS}
          cells={[
            <div key="step" className="max-w-64 min-w-0">
              <p className="truncate font-semibold text-[var(--bo-fg)]" title={emission.stepKey}>
                {emission.stepKey}
              </p>
              <p
                className="truncate font-mono text-xs text-[var(--bo-muted-2)]"
                title={`${emission.epoch} · #${emission.sequence} · ${emission.id}`}
              >
                {emission.epoch} · #{emission.sequence}
              </p>
            </div>,
            <BackofficeStatusLight key="direction" tone="muted" dot={false}>
              {emission.actor}
            </BackofficeStatusLight>,
            <span key="created" className="text-xs whitespace-nowrap">
              {formatTimestamp(emission.createdAt) || "Unknown"}
            </span>,
            <JsonCell key="payload" json={formatJson(emission.payload)} empty="No payload" />,
          ]}
        />
      ))}
    </SurfaceTable>
  );
}

/** JSON in a table cell scrolls within a capped box, so one large payload cannot widen the table. */
function JsonCell({ json, empty }: { json: string; empty: string }) {
  return (
    <pre className="backoffice-scroll max-h-80 max-w-[32rem] min-w-48 overflow-auto bg-[var(--bo-panel-2)] p-2 font-mono text-[11px] leading-5 whitespace-pre text-[var(--bo-fg)] shadow-[inset_0_0_0_1px_var(--bo-border)]">
      {json || empty}
    </pre>
  );
}
