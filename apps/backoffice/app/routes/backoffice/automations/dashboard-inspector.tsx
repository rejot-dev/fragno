import { Braces, CalendarClock, CircleDot, X } from "lucide-react";
import { useMemo } from "react";

import { visualizeWorkflowSource } from "@fragno-dev/workflow-visualizer-tokens";

import type { AutomationRouteDefinition } from "@/fragno/automation/routing";
import type { AutomationCollections } from "@/fragno/automation/tanstack/collections";
import type { BackofficeCapabilityKind } from "@/fragno/backoffice-capabilities/backoffice-capabilities";
import type { RuntimeToolWorkflowDescriptor } from "@/fragno/runtime-tools/workflow-catalog";
import { resolveWorkflowRuntimeToolCalls } from "@/fragno/runtime-tools/workflow-catalog";

import type { AutomationScriptSourceRecord } from "./data";
import { AutomationDetailRows } from "./detail-rows";
import { automationRouteActionDetailRows, automationRouteActionLabel } from "./route-action";
import { AutomationEventMatcherDetail, AutomationRouteTargetDetail } from "./route-configuration";
import { AutomationRouteDetail } from "./route-detail";
import { automationRouteScriptLink } from "./route-links";
import { useLinkedScrollViewports } from "./script-view/linked-scroll";
import { useScriptWorkflowRuns } from "./script-view/use-script-workflow-runs";
import { ScriptWorkflowGraph } from "./script-view/workflow-graph";

export type DashboardSource = {
  id: string;
  label: string;
  kind: BackofficeCapabilityKind;
  description: string;
};

export type DashboardInspectorSelection =
  | {
      kind: "source";
      source: DashboardSource;
      routes: readonly AutomationRouteDefinition[];
    }
  | { kind: "trigger"; route: AutomationRouteDefinition }
  | { kind: "action"; route: AutomationRouteDefinition }
  | null;

export function DashboardInspector({
  selection,
  workflowSource,
  runtimeToolCatalog,
  collections,
  scriptsPath,
  eventsCatalogPath,
  onClear,
}: {
  selection: DashboardInspectorSelection;
  workflowSource: AutomationScriptSourceRecord;
  runtimeToolCatalog: readonly RuntimeToolWorkflowDescriptor[];
  collections: Pick<
    AutomationCollections,
    "workflowInstances" | "workflowSteps" | "workflowStepEmissions"
  >;
  scriptsPath: string;
  eventsCatalogPath: string;
  onClear: () => void;
}) {
  return (
    <aside className="min-w-0 border border-[color:var(--bo-border)] bg-[var(--bo-panel)] xl:sticky xl:top-3 xl:max-h-[calc(100vh-7rem)] xl:overflow-hidden">
      <div className="flex min-h-11 items-center justify-between gap-3 border-b border-[color:var(--bo-border)] px-3">
        <p className="text-[9px] font-semibold tracking-[0.2em] text-[var(--bo-muted-2)] uppercase">
          Inspector
        </p>
        {selection ? (
          <button
            type="button"
            aria-label="Clear dashboard selection"
            onClick={onClear}
            className="flex h-10 w-10 items-center justify-center text-[var(--bo-muted-2)] transition-[color,transform] hover:text-[var(--bo-fg)] active:scale-[0.96]"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        ) : null}
      </div>

      <div className="backoffice-scroll xl:max-h-[calc(100vh-9.75rem)] xl:overflow-y-auto">
        {selection?.kind === "source" ? <SourceInspector selection={selection} /> : null}
        {selection?.kind === "trigger" ? (
          <div className="p-3">
            <AutomationRouteDetail
              route={selection.route}
              scriptsPath={scriptsPath}
              eventsCatalogPath={eventsCatalogPath}
              compact
            />
          </div>
        ) : null}
        {selection?.kind === "action" ? (
          <ActionInspector
            route={selection.route}
            source={workflowSource}
            runtimeToolCatalog={runtimeToolCatalog}
            collections={collections}
            scriptsPath={scriptsPath}
          />
        ) : null}
        {!selection ? (
          <div
            role="status"
            aria-label="No item selected"
            className="flex min-h-48 items-center justify-center"
          >
            <CircleDot aria-hidden="true" className="h-5 w-5 text-[var(--bo-muted-2)] opacity-40" />
          </div>
        ) : null}
      </div>
    </aside>
  );
}

function SourceInspector({
  selection,
}: {
  selection: Extract<DashboardInspectorSelection, { kind: "source" }>;
}) {
  const { source, routes } = selection;
  const enabledRoutes = routes.filter((route) => route.enabled).length;
  const Icon = source.id === "scheduler" ? CalendarClock : CircleDot;

  return (
    <div className="p-3">
      <div className="flex items-start gap-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center bg-lime-500/10 text-lime-700 dark:text-lime-300">
          <Icon className="h-4 w-4" strokeWidth={1.8} />
        </span>
        <div className="min-w-0">
          <p className="text-[8px] font-semibold tracking-[0.18em] text-lime-700 uppercase dark:text-lime-300">
            {source.kind} capability
          </p>
          <h2 className="mt-1 text-lg font-semibold text-[var(--bo-fg)]">{source.label}</h2>
        </div>
      </div>

      <p className="mt-3 text-xs leading-5 text-[var(--bo-muted)]">{source.description}</p>

      <dl className="mt-3 divide-y divide-[color:var(--bo-border)] border border-[color:var(--bo-border)]">
        <div className="grid grid-cols-[7rem_1fr] gap-2 px-3 py-2.5">
          <dt className="text-[9px] tracking-[0.18em] text-[var(--bo-muted-2)] uppercase">
            Triggers
          </dt>
          <dd className="text-xs font-semibold text-[var(--bo-fg)] tabular-nums">
            {routes.length}
          </dd>
        </div>
        <div className="grid grid-cols-[7rem_1fr] gap-2 px-3 py-2.5">
          <dt className="text-[9px] tracking-[0.18em] text-[var(--bo-muted-2)] uppercase">
            Enabled
          </dt>
          <dd className="text-xs font-semibold text-[var(--bo-fg)] tabular-nums">
            {enabledRoutes}
          </dd>
        </div>
      </dl>

      {routes.length === 0 ? (
        <p className="mt-3 border border-dashed border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] p-3 text-xs leading-5 text-[var(--bo-muted)]">
          This capability is available, but no triggers currently use it.
        </p>
      ) : null}
    </div>
  );
}

function ActionPayloadDetail({ payload }: { payload: unknown }) {
  const forwardsTriggerEvent = typeof payload === "undefined" || payload === "$event";

  return (
    <section className="overflow-hidden border border-[color:var(--bo-border)] bg-[var(--bo-panel)]">
      <div className="flex items-start gap-2.5 border-b border-[color:var(--bo-border)] px-3 py-2.5">
        <span className="flex h-7 w-7 shrink-0 items-center justify-center bg-sky-500/10 text-sky-700 dark:text-sky-300">
          <Braces className="h-3.5 w-3.5" strokeWidth={1.8} />
        </span>
        <div>
          <p className="text-[9px] tracking-[0.18em] text-[var(--bo-muted-2)] uppercase">Payload</p>
          <p className="mt-1 text-xs font-medium text-[var(--bo-fg)]">
            {forwardsTriggerEvent ? "Original triggering event" : "Static event payload"}
          </p>
        </div>
      </div>
      {forwardsTriggerEvent ? (
        <p className="px-3 py-3 text-[11px] leading-5 text-[var(--bo-muted)]">
          The complete event that activated this route is sent to the workflow instance.
        </p>
      ) : (
        <pre className="backoffice-scroll max-h-48 overflow-auto bg-[var(--bo-panel-2)] px-3 py-3 font-mono text-[10px] leading-5 break-words whitespace-pre-wrap text-[var(--bo-fg)]">
          {JSON.stringify(payload, null, 2)}
        </pre>
      )}
    </section>
  );
}

function ActionInspector({
  route,
  source,
  runtimeToolCatalog,
  collections,
  scriptsPath,
}: {
  route: AutomationRouteDefinition;
  source: AutomationScriptSourceRecord;
  runtimeToolCatalog: readonly RuntimeToolWorkflowDescriptor[];
  collections: Pick<
    AutomationCollections,
    "workflowInstances" | "workflowSteps" | "workflowStepEmissions"
  >;
  scriptsPath: string;
}) {
  const scriptLink = automationRouteScriptLink(route, scriptsPath);
  const scriptPath =
    route.action.kind === "start_workflow" ? route.action.workflowScriptPath : null;
  const detailRows = automationRouteActionDetailRows(route, {
    scriptLink,
    labelSet: "inspector",
    missingForwardEventId: "Preserve the incoming event ID",
  });

  return (
    <div className="space-y-3 p-3">
      <div className="min-w-0">
        <p className="text-[8px] font-semibold tracking-[0.18em] text-violet-700 uppercase dark:text-violet-300">
          Action · {route.action.kind}
        </p>
        <h2 className="mt-1 truncate text-lg font-semibold text-[var(--bo-fg)]">
          {automationRouteActionLabel(route)}
        </h2>
        <p className="mt-1 font-mono text-[10px] break-all text-[var(--bo-muted-2)]">
          {route.name}
        </p>
      </div>

      <section className="overflow-hidden border border-[color:var(--bo-border)] bg-[var(--bo-panel)]">
        <AutomationDetailRows layout="inspector" rows={detailRows} />
      </section>

      {route.action.kind === "send_workflow_event" ? (
        <>
          <AutomationRouteTargetDetail target={route.action.target} />
          <ActionPayloadDetail payload={route.action.payload} />
        </>
      ) : null}

      {route.action.kind === "forward_event" ? (
        <>
          <AutomationRouteTargetDetail target={route.action.targetScope} />
          {route.trigger.kind === "event" ? (
            <AutomationEventMatcherDetail matcher={route.trigger.matcher} />
          ) : null}
        </>
      ) : null}

      {scriptPath ? (
        <WorkflowGraph
          absolutePath={scriptPath}
          source={source}
          runtimeToolCatalog={runtimeToolCatalog}
          collections={collections}
        />
      ) : null}
    </div>
  );
}

function WorkflowGraph({
  absolutePath,
  source,
  runtimeToolCatalog,
  collections,
}: {
  absolutePath: string;
  source: AutomationScriptSourceRecord;
  runtimeToolCatalog: readonly RuntimeToolWorkflowDescriptor[];
  collections: Pick<
    AutomationCollections,
    "workflowInstances" | "workflowSteps" | "workflowStepEmissions"
  >;
}) {
  const visualization = useMemo(
    () => visualizeWorkflowSource(absolutePath, source.script ?? ""),
    [absolutePath, source.script],
  );
  const runtimeToolCallsByStepId = useMemo(
    () => resolveWorkflowRuntimeToolCalls({ visualization, catalog: runtimeToolCatalog }),
    [runtimeToolCatalog, visualization],
  );
  const workflowRuns = useScriptWorkflowRuns({
    absolutePath,
    collections,
    selectedInstanceId: null,
    visualization,
  });
  const { graphViewport } = useLinkedScrollViewports(false);

  if (source.scriptError) {
    return (
      <div className="mt-3 border border-red-500/35 bg-red-500/8 p-3 text-xs leading-5 text-red-800 dark:text-red-200">
        {source.scriptError}
      </div>
    );
  }

  if (source.script === null) {
    return (
      <div className="mt-3 border border-dashed border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] p-3 text-xs text-[var(--bo-muted)]">
        Loading workflow graph…
      </div>
    );
  }

  return (
    <div className="mt-3 overflow-hidden border border-[color:var(--bo-border)]">
      <div className="flex min-h-9 items-center justify-between gap-3 border-b border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <span
            className={`h-1.5 w-1.5 shrink-0 rounded-full ${workflowRuns.selectedRun ? "bg-emerald-500" : "bg-[var(--bo-muted-2)]"}`}
            aria-hidden="true"
          />
          <p className="text-[8px] font-semibold tracking-[0.16em] text-[var(--bo-muted-2)] uppercase">
            Live execution
          </p>
        </div>
        <p className="truncate font-mono text-[9px] text-[var(--bo-muted)]">
          {workflowRuns.error
            ? "Run synchronization failed"
            : workflowRuns.isLoading
              ? "Synchronizing runs…"
              : workflowRuns.selectedRun
                ? `${workflowRuns.selectedRun.instanceId} · ${workflowRuns.selectedRun.status}`
                : "No active run"}
        </p>
      </div>
      {workflowRuns.error ? (
        <div className="border-b border-red-500/25 bg-red-500/8 px-3 py-2 text-[10px] leading-4 text-red-800 dark:text-red-200">
          {workflowRuns.error}
        </div>
      ) : null}
      <ScriptWorkflowGraph
        visualization={visualization}
        detailMode="simple"
        runtimeToolCallsByStepId={runtimeToolCallsByStepId}
        selectedRun={workflowRuns.selectedRun}
        scrollViewport={graphViewport}
      />
    </div>
  );
}
