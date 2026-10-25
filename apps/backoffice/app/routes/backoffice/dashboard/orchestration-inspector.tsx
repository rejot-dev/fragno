import type { AutomationRouteDefinition } from "@fragno-dev/backoffice-api/v0/automation";
import { IconButton } from "@fragno-private/design-system/button";
import { Icon } from "@fragno-private/design-system/icon";
import {
  ORCHESTRATION_TARGET_KIND_LABEL,
  type OrchestrationTarget,
} from "@fragno-private/design-system/orchestration-graph-model";
import { useMemo, type ReactNode } from "react";

import { visualizeWorkflowSource } from "@fragno-dev/workflow-visualizer-tokens";

import { eq, useLiveQuery } from "@tanstack/react-db";

import {
  backofficeRuntimeScopeFromResolvedScope,
  type BackofficeResolvedScope,
} from "@/backoffice-runtime/resolved-scope";
import { sendBackofficeWorkflowEvent } from "@/backoffice-ui/workflow-events.client";
import { readLatestEventsOfType } from "@/fragno/automation/lofi/reads";
import {
  automationReadCollections,
  automationReadReplica,
  type AutomationReadSource,
} from "@/fragno/automation/read-source";
import type { AutomationCollections } from "@/fragno/automation/tanstack/collections";
import { useLofiSqliteRead } from "@/fragno/lofi/use-lofi-sqlite-read";
import type { RuntimeToolWorkflowDescriptor } from "@/fragno/runtime-tools/workflow-catalog";
import { resolveWorkflowRuntimeToolCalls } from "@/fragno/runtime-tools/workflow-catalog";
import { jsonSchemaToTypeScript } from "@/lib/zod/zod-formatter";

import type { AutomationScriptSourceRecord } from "../automations/data";
import { formatTimestamp } from "../automations/formatting";
import { AutomationRouteDetail } from "../automations/route-detail";
import { useLinkedScrollViewports } from "../automations/script-view/linked-scroll";
import {
  useScriptWorkflowRuns,
  type WorkflowRunCollections,
} from "../automations/script-view/use-script-workflow-runs";
import { ScriptWorkflowGraph } from "../automations/script-view/workflow-graph";
import type { OrchestrationCatalogEvent, OrchestrationCatalogSource } from "./orchestration-graph";

export type OrchestrationInspectorSelection =
  | {
      kind: "source";
      source: OrchestrationCatalogSource;
      eventDefinitions: readonly OrchestrationCatalogEvent[];
    }
  | { kind: "event"; eventDefinition: OrchestrationCatalogEvent }
  | { kind: "route"; route: AutomationRouteDefinition }
  | {
      kind: "target";
      label: string;
      targetKind: OrchestrationTarget["kind"];
      routes: readonly AutomationRouteDefinition[];
      workflowScriptPath: string | null;
    };

/** Fills its parent's height and scrolls inside it, so the graph beside it stays in view. */
export function OrchestrationInspector({
  selection,
  workflowSource,
  runtimeToolCatalog,
  readSource,
  filesScopePath,
  eventPath,
  scope,
  onSelectRoute,
  onClear,
}: {
  selection: OrchestrationInspectorSelection;
  workflowSource: AutomationScriptSourceRecord;
  runtimeToolCatalog: readonly RuntimeToolWorkflowDescriptor[];
  readSource: AutomationReadSource<RecentEventCollections & WorkflowRunCollections>;
  filesScopePath: string;
  eventPath: (source: string, eventType: string) => string;
  scope: BackofficeResolvedScope;
  onSelectRoute: (routeId: string) => void;
  onClear: () => void;
}) {
  const workflowGraph = (absolutePath: string) => (
    <WorkflowGraph
      absolutePath={absolutePath}
      source={workflowSource}
      runtimeToolCatalog={runtimeToolCatalog}
      readSource={readSource}
      scope={scope}
    />
  );

  return (
    <aside className="flex min-h-0 min-w-0 flex-1 flex-col border border-[color:var(--bo-border)] bg-[var(--bo-panel)]">
      <div className="flex min-h-11 shrink-0 items-center justify-between gap-3 border-b border-[color:var(--bo-border)] px-3">
        <p className="text-[10px] font-semibold tracking-[0.22em] text-[var(--bo-muted-2)] uppercase">
          Inspector
        </p>
        <IconButton label="Clear orchestration selection" onClick={onClear}>
          <Icon name="x" className="h-3.5 w-3.5" />
        </IconButton>
      </div>

      <div className="backoffice-scroll min-h-0 flex-1 overflow-y-auto">
        {selection.kind === "source" ? <SourceInspector selection={selection} /> : null}
        {selection.kind === "event" ? (
          <RecentEventInspector
            eventDefinition={selection.eventDefinition}
            readSource={readSource}
          />
        ) : null}
        {selection.kind === "route" ? (
          <div className="space-y-3 p-3">
            <AutomationRouteDetail
              route={selection.route}
              filesScopePath={filesScopePath}
              eventPath={eventPath}
              compact
            />
            {selection.route.action.kind === "send_workflow_event" ? (
              <ActionPayloadDetail payload={selection.route.action.payload} />
            ) : null}
            {selection.route.action.kind === "start_workflow"
              ? workflowGraph(selection.route.action.workflowScriptPath)
              : null}
          </div>
        ) : null}
        {selection.kind === "target" ? (
          <TargetInspector
            selection={selection}
            onSelectRoute={onSelectRoute}
            workflowGraph={
              selection.workflowScriptPath ? workflowGraph(selection.workflowScriptPath) : null
            }
          />
        ) : null}
      </div>
    </aside>
  );
}

function TargetInspector({
  selection,
  onSelectRoute,
  workflowGraph,
}: {
  selection: Extract<OrchestrationInspectorSelection, { kind: "target" }>;
  onSelectRoute: (routeId: string) => void;
  workflowGraph: ReactNode;
}) {
  return (
    <div className="space-y-3 p-3">
      <div className="min-w-0">
        <p className="text-[10px] font-semibold tracking-[0.22em] text-violet-700 uppercase dark:text-violet-300">
          {ORCHESTRATION_TARGET_KIND_LABEL[selection.targetKind]}
        </p>
        <h2 className="mt-1 text-sm font-semibold break-all text-[var(--bo-fg)]">
          {selection.label}
        </h2>
      </div>

      <section>
        <div className="flex items-center justify-between border-b border-[color:var(--bo-border)] pb-2">
          <p className="text-[10px] font-semibold tracking-[0.22em] text-[var(--bo-muted-2)] uppercase">
            Reached by
          </p>
          <span className="text-xs text-[var(--bo-muted-2)] tabular-nums">
            {selection.routes.length}
          </span>
        </div>
        <ul className="divide-y divide-[color:var(--bo-border)]">
          {selection.routes.map((route) => (
            <li key={route.id}>
              <button
                type="button"
                onClick={() => {
                  onSelectRoute(route.id);
                }}
                className="group flex w-full min-w-0 flex-col py-2 text-left"
              >
                <span className="truncate text-sm font-semibold text-[var(--bo-fg)] group-hover:underline">
                  {route.name}
                </span>
                <span className="truncate font-mono text-[11px] text-[var(--bo-muted)]">
                  P{route.priority} ·{" "}
                  {route.trigger.kind === "event"
                    ? `${route.trigger.source}.${route.trigger.eventType}`
                    : "schedule"}
                  {route.enabled ? "" : " · disabled"}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </section>

      {workflowGraph}
    </div>
  );
}

function SourceInspector({
  selection,
}: {
  selection: Extract<OrchestrationInspectorSelection, { kind: "source" }>;
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

type RecentEventCollections = Pick<AutomationCollections, "events">;

const RECENT_EVENT_LIMIT = 10;

function RecentEventInspector({
  eventDefinition,
  readSource,
}: {
  eventDefinition: OrchestrationCatalogEvent;
  readSource: AutomationReadSource<RecentEventCollections>;
}) {
  const { source, eventType } = eventDefinition;
  const collections = automationReadCollections(readSource);
  const recentEventsQuery = useLiveQuery({
    query: (query) =>
      collections
        ? query
            .from({ event: collections.events })
            .where(({ event }) => eq(event.source, source))
            .where(({ event }) => eq(event.eventType, eventType))
            .orderBy(({ event }) => event.occurredAt, "desc")
            .orderBy(({ event }) => event.id, "desc")
            .limit(RECENT_EVENT_LIMIT)
            .select(({ event }) => ({
              id: event.id,
              occurredAt: event.occurredAt,
              subject: event.subject,
              payload: event.payload,
            }))
        : undefined,
  });
  const eventKey = JSON.stringify([source, eventType]);
  const replicaRead = useLofiSqliteRead(
    automationReadReplica(readSource),
    eventKey,
    async (replica) => ({
      eventKey,
      events: await readLatestEventsOfType(replica, {
        source,
        eventType,
        limit: RECENT_EVENT_LIMIT,
      }),
    }),
  );
  // A read for the previously selected event can still land after the selection changes.
  const replicaEvents =
    replicaRead.status === "ready" && replicaRead.data.eventKey === eventKey
      ? replicaRead.data.events
      : null;
  const recentEvents =
    readSource.kind === "replica" ? (replicaEvents ?? []) : (recentEventsQuery.data ?? []);
  const isLoading =
    readSource.kind === "replica"
      ? replicaEvents === null && replicaRead.status !== "error"
      : recentEventsQuery.isLoading;
  const readFailed =
    readSource.kind === "replica" ? replicaRead.status === "error" : recentEventsQuery.isError;

  return (
    <div className="p-3">
      <p className="text-[10px] font-semibold tracking-[0.22em] text-[var(--bo-accent-strong)] uppercase">
        Event
      </p>
      <h2 className="mt-1 font-mono text-sm font-semibold break-all text-[var(--bo-fg)]">
        {eventDefinition.source}.{eventDefinition.eventType}
      </h2>
      <p className="mt-1 text-xs text-[var(--bo-muted)]">{eventDefinition.label}</p>

      <div className="mt-4 flex items-center justify-between border-b border-[color:var(--bo-border)] pb-2">
        <p className="text-[10px] font-semibold tracking-[0.22em] text-[var(--bo-muted-2)] uppercase">
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
                <p className="mt-1 text-xs text-[var(--bo-muted-2)] tabular-nums">
                  {formatTimestamp(event.occurredAt)}
                </p>
              </summary>
              <EventJson label="Payload" value={event.payload} />
              {/* Some events, such as connection state changes, carry everything in the subject. */}
              {event.subject === null ? null : <EventJson label="Subject" value={event.subject} />}
            </details>
          ))}
        </div>
      ) : (
        <p className="py-8 text-center text-sm text-[var(--bo-muted)]">
          {isLoading
            ? "Loading recent events…"
            : readFailed
              ? "Recent events could not be read."
              : "No recent events recorded."}
        </p>
      )}
    </div>
  );
}

function EventJson({ label, value }: { label: string; value: unknown }) {
  return (
    <div className="mt-2">
      <p className="text-[10px] font-semibold tracking-[0.22em] text-[var(--bo-muted-2)] uppercase">
        {label}
      </p>
      <pre className="backoffice-scroll mt-1 max-h-64 overflow-auto bg-[var(--bo-panel-2)] p-3 font-mono text-[11px] whitespace-pre-wrap text-[var(--bo-fg)]">
        {JSON.stringify(value, null, 2)}
      </pre>
    </div>
  );
}

function EventDefinitionDisclosure({
  eventDefinition,
}: {
  eventDefinition: OrchestrationCatalogEvent;
}) {
  const payloadType = jsonSchemaToTypeScript(
    eventDefinition.payloadSchema as Parameters<typeof jsonSchemaToTypeScript>[0],
  );

  return (
    <details className="group">
      <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 py-2.5 text-left marker:content-none">
        <Icon
          name="chevron-right"
          className="h-3.5 w-3.5 shrink-0 text-[var(--bo-muted-2)] transition-transform group-open:rotate-90"
          strokeWidth={1.8}
        />
        <span className="min-w-0 flex-1">
          <span className="block truncate font-mono text-[11px] text-[var(--bo-fg)]">
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
          <Icon name="code" className="h-3.5 w-3.5" strokeWidth={1.8} />
        </span>
        <div>
          <p className="text-[10px] font-semibold tracking-[0.22em] text-[var(--bo-muted-2)] uppercase">
            Payload
          </p>
          <p className="mt-1 text-sm font-medium text-[var(--bo-fg)]">
            {forwardsTriggerEvent ? "Original triggering event" : "Static event payload"}
          </p>
        </div>
      </div>
      {forwardsTriggerEvent ? (
        <p className="px-3 py-3 text-sm text-[var(--bo-muted)]">
          The complete event that activated this route is sent to the workflow instance.
        </p>
      ) : (
        <pre className="backoffice-scroll max-h-48 overflow-auto bg-[var(--bo-panel-2)] px-3 py-3 font-mono text-[11px] leading-5 break-words whitespace-pre-wrap text-[var(--bo-fg)]">
          {JSON.stringify(payload, null, 2)}
        </pre>
      )}
    </section>
  );
}

function WorkflowGraph({
  absolutePath,
  source,
  runtimeToolCatalog,
  readSource,
  scope,
}: {
  absolutePath: string;
  source: AutomationScriptSourceRecord;
  runtimeToolCatalog: readonly RuntimeToolWorkflowDescriptor[];
  readSource: AutomationReadSource<WorkflowRunCollections>;
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
    source: readSource,
    selectedInstanceId: null,
    visualization,
  });
  const { graphViewport } = useLinkedScrollViewports(false);

  if (source.scriptError) {
    return (
      <div className="mt-3 border border-[color:var(--bo-failed)]/40 bg-[var(--bo-failed-bg)] p-3 text-sm text-[var(--bo-failed)]">
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
            className={`h-1.5 w-1.5 shrink-0 rounded-full ${workflowRuns.selectedRun ? "bg-[var(--bo-live)]" : "bg-[var(--bo-muted-2)]"}`}
            aria-hidden="true"
          />
          <p className="text-[10px] font-semibold tracking-[0.22em] text-[var(--bo-muted-2)] uppercase">
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
        <div className="border-b border-[color:var(--bo-failed)]/40 bg-[var(--bo-failed-bg)] px-3 py-2 text-xs text-[var(--bo-failed)]">
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
