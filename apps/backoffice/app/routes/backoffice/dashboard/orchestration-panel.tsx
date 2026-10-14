import type { AutomationRouteDefinition } from "@fragno-dev/backoffice-api/v0/automation";
import type {
  OrchestrationGraph,
  OrchestrationGraphItem,
} from "@fragno-private/design-system/orchestration-graph-model";
import { OrchestrationLayeredGraph } from "@fragno-private/design-system/orchestration-layered-graph";
import { useEffect, useMemo } from "react";
import { useSearchParams } from "react-router";

import { useLiveQuery } from "@tanstack/react-db";

import type { BackofficeScopeSelection } from "@/backoffice-runtime/resolved-scope";
import type { AutomationBrowserCollections } from "@/fragno/automation/tanstack/browser-database";
import {
  listAutomationEventDescriptors,
  listCapabilityEventSources,
} from "@/fragno/backoffice-capabilities/backoffice-capabilities";
import type { RuntimeToolWorkflowDescriptor } from "@/fragno/runtime-tools/workflow-catalog";

import type { AutomationScriptSourceRecord } from "../automations/data";
import { toAutomationScriptIdFromAbsolutePath } from "../automations/script-records";
import { filesScopeBasePath } from "../files/scope";
import {
  normalizedSourceId,
  orchestrationActiveWorkflowsQuery,
  orchestrationEventId,
  projectOrchestrationGraph,
  routeTargetId,
  routeTriggerEventId,
  type OrchestrationCatalogEvent,
  type OrchestrationCatalogSource,
} from "./orchestration-graph";
import {
  OrchestrationInspector,
  type OrchestrationInspectorSelection,
} from "./orchestration-inspector";
import {
  WORKFLOW_SCRIPT_PARAM,
  dashboardSelection,
  dashboardSelectionPath,
  withDashboardSelection,
} from "./path";

const SELECTION_NAVIGATION = { replace: true, preventScrollReset: true } as const;

type OrchestrationCatalog = {
  sources: readonly OrchestrationCatalogSource[];
  eventDefinitions: readonly OrchestrationCatalogEvent[];
};

/**
 * Every source, event, route, and workflow of the scope as one graph, with the selected item's
 * details beside it. The selection lives in the URL so other panels can link to a route or event.
 */
export function OrchestrationPanel({
  collections,
  routes,
  recentEvents,
  selectedScope,
  workflowSource,
  runtimeToolCatalog,
}: {
  collections: AutomationBrowserCollections;
  routes: readonly AutomationRouteDefinition[];
  recentEvents: readonly { source: string; eventType: string }[];
  selectedScope: BackofficeScopeSelection;
  workflowSource: AutomationScriptSourceRecord;
  runtimeToolCatalog: readonly RuntimeToolWorkflowDescriptor[];
}) {
  const eventSourcesQuery = useLiveQuery(
    (query) =>
      query.from({ source: collections.eventSources }).select(({ source }) => ({
        id: source.source,
        label: source.label,
        description: source.description,
      })),
    [collections.eventSources],
  );
  const eventDefinitionsQuery = useLiveQuery(
    (query) =>
      query.from({ definition: collections.eventDefinitions }).select(({ definition }) => ({
        source: definition.source,
        eventType: definition.eventType,
        label: definition.label,
        payloadSchema: definition.payloadSchema,
      })),
    [collections.eventDefinitions],
  );
  const activeWorkflowsQuery = useLiveQuery(
    (query) => orchestrationActiveWorkflowsQuery(query, collections),
    [collections.workflowInstances],
  );

  // Registered capabilities describe what every scope can receive; a scope's own definitions add
  // to them and take precedence.
  const catalog = useMemo((): OrchestrationCatalog => {
    const sources = new Map<string, OrchestrationCatalogSource>();
    for (const source of listCapabilityEventSources()) {
      sources.set(normalizedSourceId(source.source), {
        id: normalizedSourceId(source.source),
        label: source.label,
        description: source.description,
      });
    }
    for (const source of eventSourcesQuery.data ?? []) {
      sources.set(normalizedSourceId(source.id), { ...source, id: normalizedSourceId(source.id) });
    }
    const eventDefinitions = new Map<string, OrchestrationCatalogEvent>();
    for (const definition of [
      ...listAutomationEventDescriptors(),
      ...(eventDefinitionsQuery.data ?? []),
    ]) {
      eventDefinitions.set(orchestrationEventId(definition.source, definition.eventType), {
        source: definition.source,
        eventType: definition.eventType,
        label: definition.label,
        payloadSchema: definition.payloadSchema ?? null,
      });
    }
    return { sources: [...sources.values()], eventDefinitions: [...eventDefinitions.values()] };
  }, [eventSourcesQuery.data, eventDefinitionsQuery.data]);

  const graph = useMemo(
    () =>
      projectOrchestrationGraph({
        scopeLabel: selectedScope.label,
        sources: catalog.sources,
        eventDefinitions: catalog.eventDefinitions,
        routes,
        activeWorkflows: activeWorkflowsQuery.data ?? [],
        recentEvents,
      }),
    [selectedScope.label, catalog, routes, activeWorkflowsQuery.data, recentEvents],
  );

  const [searchParams, setSearchParams] = useSearchParams();
  const requested = dashboardSelection(searchParams);
  const inspected = requested ? inspectorSelection(requested, { graph, routes, catalog }) : null;
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

  const errors = [
    eventSourcesQuery.isError ? "Event sources" : null,
    eventDefinitionsQuery.isError ? "Event definitions" : null,
    activeWorkflowsQuery.isError ? "Running workflows" : null,
  ].filter((label) => label !== null);

  return (
    <div className="flex flex-col gap-3 pt-3">
      {errors.length > 0 ? (
        <p className="text-xs text-[var(--bo-failed)]">
          {errors.join(", ")} could not be synchronized, so the graph may be incomplete.
        </p>
      ) : null}
      {/* Side by side the row takes a fixed height; stacked, each box takes its own. */}
      <div
        className={
          inspected
            ? "grid gap-3 2xl:h-[min(72vh,760px)] 2xl:grid-cols-[minmax(0,1fr)_28rem]"
            : "grid"
        }
      >
        <div className="flex max-h-[min(72vh,760px)] min-h-0 min-w-0 flex-col">
          <OrchestrationLayeredGraph
            graph={graph}
            selected={selected}
            onSelect={select}
            pulses={[]}
          />
        </div>
        {inspected ? (
          <div className="flex h-[min(72vh,760px)] min-h-0 2xl:h-auto">
            <OrchestrationInspector
              selection={inspected}
              workflowSource={workflowSource}
              runtimeToolCatalog={runtimeToolCatalog}
              collections={collections}
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

/** What the inspector shows for a graph item; null when the item no longer exists. */
function inspectorSelection(
  item: OrchestrationGraphItem,
  {
    graph,
    routes,
    catalog,
  }: {
    graph: OrchestrationGraph;
    routes: readonly AutomationRouteDefinition[];
    catalog: OrchestrationCatalog;
  },
): OrchestrationInspectorSelection | null {
  switch (item.kind) {
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
    case "source":
    case "event":
      return null;
  }
  throw new Error("Unsupported orchestration selection.");
}
