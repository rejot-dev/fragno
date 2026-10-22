import type { AnyColumn, AnyTable } from "@fragno-dev/db/schema";
import { workflowsSchema } from "@fragno-dev/workflows/schema";
import type { PageField, PageFieldType } from "@fragno-private/backoffice-ui/pages/definition";

import { automationFragmentSchema } from "@/fragno/automation/schema";
import type {
  AutomationDerivedRows,
  AutomationTableCollections,
} from "@/fragno/automation/tanstack/collections";

/** The synchronized tables a page query can read from, by the collection that mirrors each. */
const PAGE_TABLES = {
  projects: automationFragmentSchema.tables.project,
  routes: automationFragmentSchema.tables.automation_route,
  routeScheduleStates: automationFragmentSchema.tables.automation_route_schedule_state,
  routeDispatches: automationFragmentSchema.tables.automation_route_dispatch,
  events: automationFragmentSchema.tables.automation_event,
  eventSources: automationFragmentSchema.tables.automation_event_source,
  eventDefinitions: automationFragmentSchema.tables.automation_event_definition,
  kvStore: automationFragmentSchema.tables.kv_store,
  workflowInstances: workflowsSchema.tables.workflow_instance,
  workflowSteps: workflowsSchema.tables.workflow_step,
  workflowEvents: workflowsSchema.tables.workflow_event,
} satisfies Partial<Record<keyof AutomationTableCollections, AnyTable>>;

type PageFieldTypeOf<TValue> = [TValue] extends [Date]
  ? "time"
  : [TValue] extends [string]
    ? "string"
    : [TValue] extends [number]
      ? "number"
      : [TValue] extends [boolean]
        ? "boolean"
        : [TValue] extends [bigint]
          ? "bigint"
          : "json";

/** A derived row's fields as pages read them; the compiler checks each against the row type. */
type DerivedPageFields<TRow> = {
  [TField in keyof TRow]-?: {
    type: PageFieldTypeOf<NonNullable<TRow[TField]>>;
    nullable: null extends TRow[TField] ? true : false;
  };
};

const PAGE_DERIVED_COLLECTIONS: {
  [TCollection in keyof AutomationDerivedRows]: DerivedPageFields<
    AutomationDerivedRows[TCollection]
  >;
} = {
  connections: {
    connectionId: { type: "string", nullable: false },
    service: { type: "string", nullable: false },
    kind: { type: "string", nullable: false },
    state: { type: "string", nullable: false },
    name: { type: "string", nullable: true },
    authMethod: { type: "string", nullable: true },
    eventId: { type: "string", nullable: false },
    changedAt: { type: "time", nullable: false },
  },
  agents: {
    agentName: { type: "string", nullable: false },
    definition: { type: "json", nullable: false },
    builtIn: { type: "boolean", nullable: false },
    latestKind: { type: "string", nullable: true },
    latestAt: { type: "time", nullable: true },
    answering: { type: "boolean", nullable: false },
    queued: { type: "number", nullable: false },
    steering: { type: "number", nullable: false },
    paused: { type: "boolean", nullable: false },
  },
  agentTurns: {
    id: { type: "string", nullable: false },
    agentName: { type: "string", nullable: false },
    outcome: { type: "string", nullable: false },
    endedAt: { type: "time", nullable: false },
  },
  workflowWaits: {
    id: { type: "string", nullable: false },
    runId: { type: "string", nullable: false },
    eventType: { type: "string", nullable: false },
    interfaceStepKey: { type: "string", nullable: true },
  },
};

export type PageCollection = keyof typeof PAGE_TABLES | keyof AutomationDerivedRows;

/**
 * The fields of every collection a page query can read: the synchronized tables, whose underscore
 * columns are the database's bookkeeping, and what Backoffice derives from them.
 */
export const PAGE_COLLECTIONS = Object.fromEntries([
  ...Object.entries(PAGE_TABLES).map(([collection, table]) => [
    collection,
    Object.entries(table.columns as Record<string, AnyColumn>)
      .filter(([name]) => !name.startsWith("_"))
      .map(([name, column]) => ({ name, type: fieldType(column), nullable: column.isNullable })),
  ]),
  ...Object.entries(PAGE_DERIVED_COLLECTIONS).map(([collection, fields]) => [
    collection,
    Object.entries(fields as Record<string, Omit<PageField, "name">>).map(([name, field]) => ({
      name,
      ...field,
    })),
  ]),
]) as Record<PageCollection, PageField[]>;

function fieldType(column: AnyColumn): PageFieldType {
  if (column.role === "reference" || column.type.startsWith("varchar(")) {
    return "string";
  }
  switch (column.type) {
    case "string":
    case "text":
      return "string";
    case "integer":
    case "decimal":
      return "number";
    case "bigint":
      return "bigint";
    case "bool":
      return "boolean";
    case "date":
    case "timestamp":
      return "time";
    case "json":
      return "json";
    case "binary":
      return "binary";
    default:
      throw new Error(`Unknown column type ${column.type}.`);
  }
}
