import { CalendarClock, CircleDot, Workflow as WorkflowIcon, X } from "lucide-react";
import { useMemo } from "react";
import { Link } from "react-router";

import { visualizeWorkflowSource } from "@fragno-dev/workflow-visualizer-tokens";

import type { AutomationRouteDefinition } from "@/fragno/automation/routing";
import type { BackofficeCapabilityKind } from "@/fragno/backoffice-capabilities/backoffice-capabilities";
import type { RuntimeToolWorkflowDescriptor } from "@/fragno/runtime-tools/workflow-catalog";
import { resolveWorkflowRuntimeToolCalls } from "@/fragno/runtime-tools/workflow-catalog";

import type { AutomationScriptSourceRecord } from "./data";
import { AutomationRouteDetail } from "./route-detail";
import { automationRouteWorkflowLink, automationRouteWorkflowName } from "./route-workflow";
import { useLinkedScrollViewports } from "./script-view/linked-scroll";
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
  | { kind: "workflow"; route: AutomationRouteDefinition }
  | null;

export function DashboardInspector({
  selection,
  workflowSource,
  runtimeToolCatalog,
  onClear,
}: {
  selection: DashboardInspectorSelection;
  workflowSource: AutomationScriptSourceRecord;
  runtimeToolCatalog: readonly RuntimeToolWorkflowDescriptor[];
  onClear: () => void;
}) {
  return (
    <aside className="min-w-0 border border-[color:var(--bo-border)] bg-[var(--bo-panel)] xl:sticky xl:top-3 xl:max-h-[calc(100vh-7rem)] xl:overflow-hidden">
      <div className="flex min-h-11 items-center justify-between gap-3 border-b border-[color:var(--bo-border)] px-3">
        <div>
          <p className="text-[9px] font-semibold tracking-[0.2em] text-[var(--bo-muted-2)] uppercase">
            Inspector
          </p>
          <p className="mt-0.5 text-[10px] text-[var(--bo-muted)]">
            {selection ? selection.kind : "Nothing selected"}
          </p>
        </div>
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
            <AutomationRouteDetail route={selection.route} compact />
          </div>
        ) : null}
        {selection?.kind === "workflow" ? (
          <WorkflowInspector
            route={selection.route}
            source={workflowSource}
            runtimeToolCatalog={runtimeToolCatalog}
          />
        ) : null}
        {!selection ? (
          <div className="m-3 border border-dashed border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] p-4">
            <CircleDot className="h-4 w-4 text-[var(--bo-muted-2)]" />
            <p className="mt-3 text-sm font-semibold text-[var(--bo-fg)]">Select an item</p>
            <p className="mt-1 text-xs leading-5 text-[var(--bo-muted)]">
              Choose a capability, trigger, or workflow to inspect it without leaving the system
              map.
            </p>
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
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded bg-lime-500/10 text-lime-700 dark:text-lime-300">
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

function WorkflowInspector({
  route,
  source,
  runtimeToolCatalog,
}: {
  route: AutomationRouteDefinition;
  source: AutomationScriptSourceRecord;
  runtimeToolCatalog: readonly RuntimeToolWorkflowDescriptor[];
}) {
  const workflowLink = automationRouteWorkflowLink(route);
  const workflowName = automationRouteWorkflowName(route) ?? "Forwarded event";
  const scriptPath =
    route.action.kind === "start_workflow" ? route.action.workflowScriptPath : null;

  return (
    <div className="p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[8px] font-semibold tracking-[0.18em] text-rose-800 uppercase dark:text-rose-200">
            Workflow
          </p>
          <h2 className="mt-1 truncate text-lg font-semibold text-[var(--bo-fg)]">
            {workflowName}
          </h2>
          <p className="mt-1 font-mono text-[10px] break-all text-[var(--bo-muted-2)]">
            {scriptPath ?? route.action.kind}
          </p>
        </div>
        {workflowLink ? (
          <Link
            to={workflowLink}
            className="inline-flex min-h-10 shrink-0 items-center border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-2.5 text-[8px] font-semibold tracking-[0.14em] text-[var(--bo-muted)] uppercase transition-[border-color,color,transform] hover:border-[color:var(--bo-border-strong)] hover:text-[var(--bo-fg)] active:scale-[0.96]"
          >
            Open ↗
          </Link>
        ) : null}
      </div>

      {scriptPath ? (
        <WorkflowGraph
          absolutePath={scriptPath}
          source={source}
          runtimeToolCatalog={runtimeToolCatalog}
        />
      ) : (
        <div className="mt-3 border border-dashed border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] p-4">
          <WorkflowIcon className="h-4 w-4 text-[var(--bo-muted-2)]" />
          <p className="mt-2 text-xs font-semibold text-[var(--bo-fg)]">
            No script graph available
          </p>
          <p className="mt-1 text-[11px] leading-5 text-[var(--bo-muted)]">
            This route sends or forwards an event rather than starting a workflow script directly.
          </p>
        </div>
      )}
    </div>
  );
}

function WorkflowGraph({
  absolutePath,
  source,
  runtimeToolCatalog,
}: {
  absolutePath: string;
  source: AutomationScriptSourceRecord;
  runtimeToolCatalog: readonly RuntimeToolWorkflowDescriptor[];
}) {
  const visualization = useMemo(
    () => visualizeWorkflowSource(absolutePath, source.script ?? ""),
    [absolutePath, source.script],
  );
  const runtimeToolCallsByStepId = useMemo(
    () => resolveWorkflowRuntimeToolCalls({ visualization, catalog: runtimeToolCatalog }),
    [runtimeToolCatalog, visualization],
  );
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
      <ScriptWorkflowGraph
        visualization={visualization}
        detailMode="simple"
        runtimeToolCallsByStepId={runtimeToolCallsByStepId}
        selectedRun={null}
        scrollViewport={graphViewport}
      />
    </div>
  );
}
