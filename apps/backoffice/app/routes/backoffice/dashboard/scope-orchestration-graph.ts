import type { BackofficeContextScope } from "@fragno-dev/backoffice-api/v0/shared/scope";
import type { LofiSqliteClient } from "@fragno-dev/lofi/sqlite";
import type { OrchestrationGraph } from "@fragno-private/design-system/orchestration/orchestration-graph-model";
import { useMemo } from "react";

import { useAutomationRead, type AutomationReadData } from "@/fragno/automation/lofi/replica";
import {
  listAutomationEventDescriptors,
  listCapabilityEventSources,
} from "@/fragno/backoffice-capabilities/backoffice-capabilities";

import {
  normalizedSourceId,
  orchestrationEventId,
  projectOrchestrationGraph,
  type OrchestrationCatalogEvent,
  type OrchestrationCatalogSource,
} from "./orchestration-graph";

export type OrchestrationCatalog = {
  sources: readonly OrchestrationCatalogSource[];
  eventDefinitions: readonly OrchestrationCatalogEvent[];
};

type OrchestrationRecords = AutomationReadData<"orchestrationRecords">;

const NO_ORCHESTRATION_RECORDS: OrchestrationRecords = {
  eventSources: [],
  eventDefinitions: [],
  activeWorkflows: [],
};

/**
 * One scope's orchestration graph, as the Map draws it from the scope's replica, with what it was
 * projected from. Until the replica opens it is loading. `recordErrors` names the records that
 * could not be read, which the graph is drawn without.
 */
export function useScopeOrchestrationGraph(
  replica: LofiSqliteClient | null,
  {
    scope,
    scopeLabel,
    since,
  }: { scope: BackofficeContextScope; scopeLabel: string; since: number },
):
  | { status: "loading" }
  | { status: "error"; message: string }
  | {
      status: "ready";
      graph: OrchestrationGraph;
      inputs: AutomationReadData<"orchestrationGraphInputs">;
      catalog: OrchestrationCatalog;
      recordErrors: string[];
    } {
  const inputs = useAutomationRead(replica, "orchestrationGraphInputs", {
    since,
    ownerScope: scope,
  });
  const recordsRead = useAutomationRead(replica, "orchestrationRecords", undefined);
  const records = recordsRead.status === "ready" ? recordsRead.data : NO_ORCHESTRATION_RECORDS;

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
    for (const source of records.eventSources) {
      sources.set(normalizedSourceId(source.id), { ...source, id: normalizedSourceId(source.id) });
    }
    const eventDefinitions = new Map<string, OrchestrationCatalogEvent>();
    for (const definition of [...listAutomationEventDescriptors(), ...records.eventDefinitions]) {
      eventDefinitions.set(orchestrationEventId(definition.source, definition.eventType), {
        source: definition.source,
        eventType: definition.eventType,
        label: definition.label,
        payloadSchema: definition.payloadSchema ?? null,
      });
    }
    return { sources: [...sources.values()], eventDefinitions: [...eventDefinitions.values()] };
  }, [records.eventSources, records.eventDefinitions]);

  const inputsData = inputs.status === "ready" ? inputs.data : null;
  const graph = useMemo(
    () =>
      inputsData
        ? projectOrchestrationGraph({
            scopeLabel,
            sources: catalog.sources,
            eventDefinitions: catalog.eventDefinitions,
            activeWorkflows: records.activeWorkflows,
            ...inputsData,
          })
        : null,
    [scopeLabel, catalog, records.activeWorkflows, inputsData],
  );

  if (inputs.status === "error") {
    return { status: "error", message: inputs.message };
  }
  if (inputsData === null || graph === null) {
    return { status: "loading" };
  }
  return {
    status: "ready",
    graph,
    inputs: inputsData,
    catalog,
    recordErrors:
      recordsRead.status === "error"
        ? ["Event sources", "event definitions", "running workflows"]
        : [],
  };
}
