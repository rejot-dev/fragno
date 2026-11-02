import type {
  AutomationForwardAccept,
  AutomationRouteDefinition,
} from "@fragno-dev/backoffice-api/v0/automation";
import type { LofiSqliteClient } from "@fragno-dev/lofi/sqlite";
import { PaneSpinner } from "@fragno-private/design-system/feedback/pane-message";
import { BackofficeSystemState } from "@fragno-private/design-system/feedback/system-state";
import type {
  OrchestrationGraph,
  OrchestrationGraphItem,
} from "@fragno-private/design-system/orchestration/orchestration-graph-model";
import { OrchestrationLayeredGraph } from "@fragno-private/design-system/orchestration/orchestration-layered-graph";
import { useEffect } from "react";
import { useSearchParams } from "react-router";

import {
  backofficeRuntimeScopeFromResolvedScope,
  type BackofficeScopeSelection,
} from "@/backoffice-runtime/resolved-scope";
import { useClock } from "@/components/backoffice/use-clock";
import type { RuntimeToolWorkflowDescriptor } from "@/fragno/runtime-tools/workflow-catalog";

import type { AutomationScriptSourceRecord } from "../automations/data";
import { toAutomationScriptIdFromAbsolutePath } from "../automations/script-records";
import { filesScopeBasePath } from "../files/scope";
import {
  normalizedSourceId,
  orchestrationEventId,
  orchestrationInletDetail,
  routeTargetId,
  routeTriggerEventId,
  type OrchestrationForward,
} from "./orchestration-graph";
import {
  OrchestrationInspector,
  type OrchestrationInspectorSelection,
} from "./orchestration-inspector";
import type { OrchestrationUniverseScopes } from "./orchestration-universe-panel";
import { dashboardBucketStarts } from "./overview";
import {
  WORKFLOW_SCRIPT_PARAM,
  dashboardSelection,
  dashboardSelectionPath,
  withDashboardSelection,
} from "./path";
import { useScopeOrchestrationGraph, type OrchestrationCatalog } from "./scope-orchestration-graph";

const SELECTION_NAVIGATION = { replace: true, preventScrollReset: true } as const;
const CLOCK_TICK_MS = 60_000;

/** What the orchestration panel reads from its route's loader. */
export type OrchestrationLoaderData = {
  selectedScope: BackofficeScopeSelection;
  workflowSource: AutomationScriptSourceRecord;
  runtimeToolCatalog: readonly RuntimeToolWorkflowDescriptor[];
  /** Null unless an organization's Map shows its universe. */
  universe: OrchestrationUniverseScopes | null;
};

/**
 * Every source, event, route, and workflow of the scope as one graph, with the selected item's
 * details beside it. The selection lives in the URL so other panels can link to a route or event.
 */
function OrchestrationPanel({
  replica,
  graph,
  routes,
  forwardAccepts,
  recentForwards,
  catalog,
  errors,
  selectedScope,
  workflowSource,
  runtimeToolCatalog,
}: {
  replica: LofiSqliteClient;
  graph: OrchestrationGraph;
  routes: readonly AutomationRouteDefinition[];
  forwardAccepts: readonly AutomationForwardAccept[];
  recentForwards: readonly OrchestrationForward[];
  catalog: OrchestrationCatalog;
  /** The records that could not be read, which the graph is drawn without. */
  errors: readonly string[];
  selectedScope: BackofficeScopeSelection;
  workflowSource: AutomationScriptSourceRecord;
  runtimeToolCatalog: readonly RuntimeToolWorkflowDescriptor[];
}) {
  const [searchParams, setSearchParams] = useSearchParams();
  const requested = dashboardSelection(searchParams);
  const inspected = requested
    ? inspectorSelection(requested, { graph, routes, catalog, forwardAccepts, recentForwards })
    : null;
  const selected = inspected ? requested : null;

  const workflowScriptPath = inspected ? selectionWorkflowScriptPath(inspected) : null;
  const workflowScriptId = workflowScriptPath
    ? toAutomationScriptIdFromAbsolutePath(workflowScriptPath)
    : null;
  // Links name only what to select, so the workflow source the loader reads follows from it.
  useEffect(() => {
    if (searchParams.get(WORKFLOW_SCRIPT_PARAM) === workflowScriptId) {
      return;
    }
    const next = new URLSearchParams(searchParams);
    if (workflowScriptId) {
      next.set(WORKFLOW_SCRIPT_PARAM, workflowScriptId);
    } else {
      next.delete(WORKFLOW_SCRIPT_PARAM);
    }
    setSearchParams(next, SELECTION_NAVIGATION);
  }, [searchParams, setSearchParams, workflowScriptId]);

  function select(item: OrchestrationGraphItem | null) {
    setSearchParams((current) => withDashboardSelection(current, item), SELECTION_NAVIGATION);
  }

  return (
    <div className="flex flex-col gap-3 pt-3">
      {errors.length > 0 ? (
        <p className="text-xs text-[var(--bo-failed)]">
          {errors.join(", ")} could not be read, so the graph may be incomplete.
        </p>
      ) : null}
      {/* The graph is as tall as its content, so the page only scrolls when it needs to. Beside
          it, the inspector keeps a fixed height and stays in view while the page scrolls. */}
      <div
        className={
          inspected ? "grid items-start gap-3 2xl:grid-cols-[minmax(0,1fr)_28rem]" : "grid"
        }
      >
        <div className="flex min-w-0 flex-col">
          <OrchestrationLayeredGraph
            graph={graph}
            selected={selected}
            onSelect={select}
            pulses={[]}
          />
        </div>
        {inspected ? (
          <div className="flex h-[min(72vh,760px)] min-h-0 2xl:sticky 2xl:top-4">
            <OrchestrationInspector
              selection={inspected}
              workflowSource={workflowSource}
              runtimeToolCatalog={runtimeToolCatalog}
              replica={replica}
              filesScopePath={filesScopeBasePath(selectedScope)}
              eventPath={(source, eventType) =>
                dashboardSelectionPath(selectedScope, {
                  kind: "event",
                  id: orchestrationEventId(source, eventType),
                })
              }
              scope={selectedScope}
              onSelectRoute={(routeId) => {
                select({ kind: "route", id: routeId });
              }}
              onClear={() => {
                select(null);
              }}
            />
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** The orchestration panel over the routes and the last day's events it reads from the replica. */
export function ScopeOrchestration({
  replica,
  loaderData,
}: {
  replica: LofiSqliteClient;
  loaderData: OrchestrationLoaderData;
}) {
  const now = useClock(CLOCK_TICK_MS);
  // The window start only moves when a new bucket begins, so the event read restarts rarely.
  const since = dashboardBucketStarts(now)[0] ?? now;
  const read = useScopeOrchestrationGraph(replica, {
    scope: backofficeRuntimeScopeFromResolvedScope(loaderData.selectedScope),
    scopeLabel: loaderData.selectedScope.label,
    since,
  });
  if (read.status === "error") {
    return (
      <BackofficeSystemState
        tone="error"
        title="The orchestration graph could not be read."
        description={read.message}
      />
    );
  }
  if (read.status === "loading") {
    return <PaneSpinner label="Reading routes and events" />;
  }
  return (
    <OrchestrationPanel
      replica={replica}
      graph={read.graph}
      routes={read.inputs.routes}
      forwardAccepts={read.inputs.forwardAccepts}
      recentForwards={read.inputs.recentForwards}
      catalog={read.catalog}
      errors={read.recordErrors}
      selectedScope={loaderData.selectedScope}
      workflowSource={loaderData.workflowSource}
      runtimeToolCatalog={loaderData.runtimeToolCatalog}
    />
  );
}

/** What the inspector shows for a graph item; null when the item no longer exists. */
function inspectorSelection(
  item: OrchestrationGraphItem,
  {
    graph,
    routes,
    catalog,
    forwardAccepts,
    recentForwards,
  }: {
    graph: OrchestrationGraph;
    routes: readonly AutomationRouteDefinition[];
    catalog: OrchestrationCatalog;
    forwardAccepts: readonly AutomationForwardAccept[];
    recentForwards: readonly OrchestrationForward[];
  },
): OrchestrationInspectorSelection | null {
  switch (item.kind) {
    case "inlet": {
      const inlet = graph.inlets.find((candidate) => candidate.id === item.id);
      return inlet
        ? {
            kind: "inlet",
            inlet,
            ...orchestrationInletDetail(inlet.id, { forwardAccepts, recentForwards }),
          }
        : null;
    }
    case "source": {
      const source = graph.sources.find((candidate) => candidate.id === item.id);
      if (!source) {
        return null;
      }
      return {
        kind: "source",
        source: catalog.sources.find((candidate) => candidate.id === source.id) ?? {
          id: source.id,
          label: source.label,
          description: "",
        },
        eventDefinitions: catalog.eventDefinitions.filter(
          (definition) => normalizedSourceId(definition.source) === source.id,
        ),
      };
    }
    case "event": {
      // A schedule's event is the route itself; it has no payload or history of its own.
      const scheduledRoute = routes.find(
        (route) => route.trigger.kind === "schedule" && routeTriggerEventId(route) === item.id,
      );
      if (scheduledRoute) {
        return { kind: "route", route: scheduledRoute };
      }
      const event = graph.events.find((candidate) => candidate.id === item.id);
      if (!event) {
        return null;
      }
      return {
        kind: "event",
        eventDefinition: catalog.eventDefinitions.find(
          (definition) =>
            orchestrationEventId(definition.source, definition.eventType) === event.id,
        ) ?? {
          source: event.sourceId,
          eventType: event.eventType,
          label: event.label,
          payloadSchema: null,
        },
      };
    }
    case "route": {
      const route = routes.find((candidate) => candidate.id === item.id);
      return route ? { kind: "route", route } : null;
    }
    case "target": {
      const target = graph.targets.find((candidate) => candidate.id === item.id);
      if (!target) {
        return null;
      }
      const targetRoutes = routes.filter(
        (route) =>
          route.action.kind !== "reclassify_event" && routeTargetId(route.action) === target.id,
      );
      const startingRoute = targetRoutes.find((route) => route.action.kind === "start_workflow");
      return {
        kind: "target",
        label: target.label,
        targetKind: target.kind,
        routes: targetRoutes,
        workflowScriptPath:
          startingRoute?.action.kind === "start_workflow"
            ? startingRoute.action.workflowScriptPath
            : null,
      };
    }
  }
  throw new Error("Unsupported orchestration selection.");
}

function selectionWorkflowScriptPath(selection: OrchestrationInspectorSelection): string | null {
  switch (selection.kind) {
    case "route":
      return selection.route.action.kind === "start_workflow"
        ? selection.route.action.workflowScriptPath
        : null;
    case "target":
      return selection.workflowScriptPath;
    case "inlet":
    case "source":
    case "event":
      return null;
  }
  throw new Error("Unsupported orchestration selection.");
}
