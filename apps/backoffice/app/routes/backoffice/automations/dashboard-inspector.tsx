import { Braces, ChevronRight, X } from "lucide-react";
import { useMemo } from "react";

import { visualizeWorkflowSource } from "@fragno-dev/workflow-visualizer-tokens";

import { eq, useLiveQuery } from "@tanstack/react-db";

import {
  backofficeRuntimeScopeFromResolvedScope,
  type BackofficeResolvedScope,
} from "@/backoffice-runtime/resolved-scope";
import { sendBackofficeWorkflowEvent } from "@/backoffice-ui/workflow-events.client";
import type { AutomationRouteDefinition } from "@/fragno/automation/routing";
import type { AutomationBrowserCollections as AutomationCollections } from "@/fragno/automation/tanstack/browser-database";
import type { RuntimeToolWorkflowDescriptor } from "@/fragno/runtime-tools/workflow-catalog";
import { resolveWorkflowRuntimeToolCalls } from "@/fragno/runtime-tools/workflow-catalog";
import { jsonSchemaToTypeScript } from "@/lib/zod/zod-formatter";

import type { AutomationScriptSourceRecord } from "./data";
import { AutomationDetailRows } from "./detail-rows";
import { formatTimestamp } from "./formatting";
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
  description: string;
};

export type DashboardEventDefinition = {
  source: string;
  eventType: string;
  label: string;
  payloadSchema: unknown;
};

export type DashboardInspectorSelection =
  | {
      kind: "source";
      source: DashboardSource;
      eventDefinitions: readonly DashboardEventDefinition[];
    }
  | { kind: "event"; eventDefinition: DashboardEventDefinition }
  | { kind: "trigger"; route: AutomationRouteDefinition }
  | { kind: "action"; route: AutomationRouteDefinition };

export function DashboardInspector({
  selection,
  workflowSource,
  runtimeToolCatalog,
  collections,
  scriptsPath,
  eventsCatalogPath,
  scope,
  onClear,
}: {
  selection: DashboardInspectorSelection | null;
  workflowSource: AutomationScriptSourceRecord;
  runtimeToolCatalog: readonly RuntimeToolWorkflowDescriptor[];
  collections: Pick<
    AutomationCollections,
    "events" | "workflowInstances" | "workflowSteps" | "workflowEvents" | "workflowStepEmissions"
  >;
  scriptsPath: string;
  eventsCatalogPath: string;
  scope: BackofficeResolvedScope;
  onClear: () => void;
}) {
  return (
    <aside className="min-w-0 border border-[color:var(--bo-border)] bg-[var(--bo-panel)] xl:sticky xl:top-3 xl:max-h-[calc(100vh-7.5rem)] xl:overflow-hidden">
      <div className="flex min-h-11 items-center justify-between gap-3 border-b border-[color:var(--bo-border)] px-3">
        <p className="text-[11px] font-semibold tracking-[0.2em] text-[var(--bo-muted-2)] uppercase">
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

      <div className="backoffice-scroll xl:max-h-[calc(100vh-10.25rem)] xl:overflow-y-auto">
        {selection?.kind === "source" ? <SourceInspector selection={selection} /> : null}
        {selection?.kind === "event" ? (
          <RecentEventInspector
            eventDefinition={selection.eventDefinition}
            collections={collections}
          />
        ) : null}
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
            scope={scope}
          />
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
  const { source, eventDefinitions } = selection;

  return (
    <div className="p-3">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-sm font-semibold text-[var(--bo-fg)]">{source.label}</h2>
        <span className="text-xs text-[var(--bo-muted-2)] tabular-nums">
          {eventDefinitions.length} {eventDefinitions.length === 1 ? "event" : "events"}
        </span>
      </div>

      {eventDefinitions.length > 0 ? (
        <div className="mt-3 divide-y divide-[color:var(--bo-border)] border-y border-[color:var(--bo-border)]">
          {eventDefinitions.map((eventDefinition) => (
            <EventDefinitionDisclosure
              key={`${eventDefinition.source}:${eventDefinition.eventType}`}
              eventDefinition={eventDefinition}
            />
          ))}
        </div>
      ) : (
        <p className="mt-3 py-6 text-center text-sm text-[var(--bo-muted)]">
          No registered events.
        </p>
      )}
    </div>
  );
}

function RecentEventInspector({
  eventDefinition,
  collections,
}: {
  eventDefinition: DashboardEventDefinition;
  collections: Pick<AutomationCollections, "events">;
}) {
  const recentEventsQuery = useLiveQuery(
    (query) =>
      query
        .from({ event: collections.events })
        .where(({ event }) => eq(event.source, eventDefinition.source))
        .where(({ event }) => eq(event.eventType, eventDefinition.eventType))
        .orderBy(({ event }) => event.occurredAt, "desc")
        .orderBy(({ event }) => event.id, "desc")
        .limit(10)
        .select(({ event }) => ({
          id: event.id,
          occurredAt: event.occurredAt,
          payload: event.payload,
        })),
    [collections.events, eventDefinition.eventType, eventDefinition.source],
  );
  const recentEvents = recentEventsQuery.data ?? [];

  return (
    <div className="p-3">
      <p className="text-[10px] font-semibold tracking-[0.18em] text-orange-700 uppercase dark:text-orange-300">
        Event
      </p>
      <h2 className="mt-1 font-mono text-sm font-semibold break-all text-[var(--bo-fg)]">
        {eventDefinition.source}.{eventDefinition.eventType}
      </h2>
      <p className="mt-1 text-xs text-[var(--bo-muted)]">{eventDefinition.label}</p>

      <div className="mt-4 flex items-center justify-between border-b border-[color:var(--bo-border)] pb-2">
        <p className="text-[10px] font-semibold tracking-[0.18em] text-[var(--bo-muted-2)] uppercase">
          Recent events
        </p>
        <span className="text-xs text-[var(--bo-muted-2)] tabular-nums">{recentEvents.length}</span>
      </div>
      {recentEvents.length > 0 ? (
        <div className="divide-y divide-[color:var(--bo-border)]">
          {recentEvents.map((event) => (
            <details key={event.id} className="group py-2">
              <summary className="cursor-pointer list-none marker:content-none">
                <p className="font-mono text-[11px] break-all text-[var(--bo-fg)]">{event.id}</p>
                <p className="mt-1 text-[10px] text-[var(--bo-muted-2)] tabular-nums">
                  {formatTimestamp(event.occurredAt)}
                </p>
              </summary>
              <pre className="backoffice-scroll mt-2 max-h-64 overflow-auto bg-[var(--bo-panel-2)] p-3 font-mono text-[11px] whitespace-pre-wrap text-[var(--bo-fg)]">
                {JSON.stringify(event.payload, null, 2)}
              </pre>
            </details>
          ))}
        </div>
      ) : (
        <p className="py-8 text-center text-sm text-[var(--bo-muted)]">
          {recentEventsQuery.isLoading ? "Loading recent events…" : "No recent events recorded."}
        </p>
      )}
    </div>
  );
}

function EventDefinitionDisclosure({
  eventDefinition,
}: {
  eventDefinition: DashboardEventDefinition;
}) {
  const payloadType = jsonSchemaToTypeScript(
    eventDefinition.payloadSchema as Parameters<typeof jsonSchemaToTypeScript>[0],
  );

  return (
    <details className="group">
      <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 py-2.5 text-left marker:content-none">
        <ChevronRight
          className="h-3.5 w-3.5 shrink-0 text-[var(--bo-muted-2)] transition-transform group-open:rotate-90"
          strokeWidth={1.8}
        />
        <span className="min-w-0 flex-1">
          <span className="block truncate font-mono text-xs text-[var(--bo-fg)]">
            {eventDefinition.eventType}
          </span>
          <span className="mt-0.5 block truncate text-xs text-[var(--bo-muted)]">
            {eventDefinition.label}
          </span>
        </span>
      </summary>
      <div className="pb-3 pl-5">
        <pre className="backoffice-scroll max-h-96 overflow-auto bg-[var(--bo-panel-2)] p-3 font-mono text-[11px] leading-5 whitespace-pre text-[var(--bo-fg)]">
          <code>{payloadType}</code>
        </pre>
      </div>
    </details>
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
          <p className="text-[11px] tracking-[0.18em] text-[var(--bo-muted-2)] uppercase">
            Payload
          </p>
          <p className="mt-1 text-sm font-medium text-[var(--bo-fg)]">
            {forwardsTriggerEvent ? "Original triggering event" : "Static event payload"}
          </p>
        </div>
      </div>
      {forwardsTriggerEvent ? (
        <p className="px-3 py-3 text-[13px] leading-5 text-[var(--bo-muted)]">
          The complete event that activated this route is sent to the workflow instance.
        </p>
      ) : (
        <pre className="backoffice-scroll max-h-48 overflow-auto bg-[var(--bo-panel-2)] px-3 py-3 font-mono text-xs leading-5 break-words whitespace-pre-wrap text-[var(--bo-fg)]">
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
  scope,
}: {
  route: AutomationRouteDefinition;
  source: AutomationScriptSourceRecord;
  runtimeToolCatalog: readonly RuntimeToolWorkflowDescriptor[];
  collections: Pick<
    AutomationCollections,
    "workflowInstances" | "workflowSteps" | "workflowEvents" | "workflowStepEmissions"
  >;
  scriptsPath: string;
  scope: BackofficeResolvedScope;
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
        <p className="text-[10px] font-semibold tracking-[0.18em] text-violet-700 uppercase dark:text-violet-300">
          Action · {route.action.kind}
        </p>
        <h2 className="mt-1 truncate text-lg font-semibold text-[var(--bo-fg)]">
          {automationRouteActionLabel(route)}
        </h2>
        <p className="mt-1 font-mono text-xs break-all text-[var(--bo-muted-2)]">{route.name}</p>
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
          scope={scope}
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
  scope,
}: {
  absolutePath: string;
  source: AutomationScriptSourceRecord;
  runtimeToolCatalog: readonly RuntimeToolWorkflowDescriptor[];
  collections: Pick<
    AutomationCollections,
    "workflowInstances" | "workflowSteps" | "workflowEvents" | "workflowStepEmissions"
  >;
  scope: BackofficeResolvedScope;
}) {
  const runtimeScope = backofficeRuntimeScopeFromResolvedScope(scope);
  const currentScope = scope.kind === "system" ? undefined : scope;
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
      <div className="mt-3 border border-red-500/35 bg-red-500/8 p-3 text-sm leading-5 text-red-800 dark:text-red-200">
        {source.scriptError}
      </div>
    );
  }

  if (source.script === null) {
    return (
      <div className="mt-3 border border-dashed border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] p-3 text-sm text-[var(--bo-muted)]">
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
          <p className="text-[10px] font-semibold tracking-[0.16em] text-[var(--bo-muted-2)] uppercase">
            Live execution
          </p>
        </div>
        <p className="truncate font-mono text-[11px] text-[var(--bo-muted)]">
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
        <div className="border-b border-red-500/25 bg-red-500/8 px-3 py-2 text-xs leading-4 text-red-800 dark:text-red-200">
          {workflowRuns.error}
        </div>
      ) : null}
      <ScriptWorkflowGraph
        visualization={visualization}
        detailMode="simple"
        runtimeToolCallsByStepId={runtimeToolCallsByStepId}
        selectedRun={workflowRuns.selectedRun}
        scrollViewport={graphViewport}
        currentScope={currentScope}
        workflowEventSender={async ({ eventId, workflowName, instanceId, eventType, payload }) => {
          await sendBackofficeWorkflowEvent({
            eventId,
            reference: { scope: runtimeScope, workflowName, instanceId },
            eventType,
            payload,
          });
        }}
      />
    </div>
  );
}
