import { getTableForeignKey, type AnyColumn, type AnyTable } from "@fragno-dev/db/schema";
import {
  createLofiSqliteTableStatements,
  lofiSqliteTableName,
  quoteSqliteIdentifier,
  type SqliteValue,
} from "@fragno-dev/lofi/sqlite";
import type { LofiSqliteDerivedRelation } from "@fragno-dev/lofi/sqlite/worker";
import { workflowsSchema } from "@fragno-dev/workflows/schema";

import { automationFragmentSchema } from "../schema";
import { currentWorkflowWaits } from "../workflow-waits";
import { readWorkflowRuns } from "./reads";
import { AUTOMATION_REPLICA_SCHEMAS } from "./replica-schemas";
import { automationViews, automationViewsSchema, readPiAgents } from "./views";

/** How a relation's column reads in SQL. */
export type PageRelationColumnType =
  | "text"
  | "integer"
  | "number"
  | "boolean"
  | "time"
  | "json"
  | "blob";

export type PageRelationColumn = {
  name: string;
  type: PageRelationColumnType;
  nullable: boolean;
  /** Strings the column holds, when its writer stores only these. */
  values?: readonly string[];
};

/** A relation pages read, with what page-schema.d.ts tells authors about it. */
export type PageRelation = {
  name: string;
  description: string;
  columns: PageRelationColumn[];
};

const RUN_STATUSES = ["active", "paused", "waiting", "complete", "errored", "terminated"] as const;

type TableRelation = {
  name: string;
  description: string;
  schema: typeof automationFragmentSchema | typeof workflowsSchema;
  table: string;
  /** Reference columns, by the name the relation gives the referenced row's id. */
  references?: Record<string, string>;
  values?: Record<string, readonly string[]>;
};

/**
 * The synchronized tables pages read, each as a view of its columns: `id` is the row's id, a
 * reference holds the referenced row's id, and `position` orders rows as the backend created them.
 * The replica's other bookkeeping columns are left out.
 */
const TABLE_RELATIONS: TableRelation[] = [
  {
    name: "runs",
    description:
      "Workflow runs. workflowName is the runner's internal name, and remoteWorkflowName the workflow's own name, or null.",
    schema: workflowsSchema,
    table: "workflow_instance",
    values: { status: RUN_STATUSES },
  },
  {
    name: "steps",
    description: "Steps of workflow runs; runId is the run's id.",
    schema: workflowsSchema,
    table: "workflow_step",
    references: { instanceRef: "runId" },
  },
  {
    name: "workflow_events",
    description: "Events delivered to workflow runs; runId is the run's id.",
    schema: workflowsSchema,
    table: "workflow_event",
    references: { instanceRef: "runId" },
  },
  {
    name: "events",
    description:
      "Automation events. payload, actors, and subject are JSON; read fields with ->> such as payload ->> '$.action'.",
    schema: automationFragmentSchema,
    table: "automation_event",
  },
  {
    name: "event_sources",
    description: "The sources events come from.",
    schema: automationFragmentSchema,
    table: "automation_event_source",
  },
  {
    name: "event_definitions",
    description: "The event types sources define.",
    schema: automationFragmentSchema,
    table: "automation_event_definition",
  },
  {
    name: "routes",
    description:
      "Automation routes. trigger and action are JSON, such as trigger ->> '$.kind'; route_schedules holds a scheduled route's next occurrence by the same id.",
    schema: automationFragmentSchema,
    table: "automation_route",
  },
  {
    name: "route_schedules",
    description: "When each scheduled route next fires, by the route's id.",
    schema: automationFragmentSchema,
    table: "automation_route_schedule_state",
  },
  {
    name: "route_dispatches",
    description: "Each time a route led an event to its action.",
    schema: automationFragmentSchema,
    table: "automation_route_dispatch",
  },
  {
    name: "projects",
    description: "The scope's projects.",
    schema: automationFragmentSchema,
    table: "project",
  },
  {
    name: "kv_store",
    description: "Values stored with the store provider.",
    schema: automationFragmentSchema,
    table: "kv_store",
  },
];

function columnType(column: AnyColumn): PageRelationColumnType {
  if (column.role === "reference" || column.role === "external-id") {
    return "text";
  }
  if (column.type.startsWith("varchar(")) {
    return "text";
  }
  switch (column.type) {
    case "string":
    case "text":
      return "text";
    case "integer":
    case "bigint":
      return "integer";
    case "decimal":
      return "number";
    case "bool":
      return "boolean";
    case "date":
    case "timestamp":
      return "time";
    case "json":
      return "json";
    case "binary":
      return "blob";
    default:
      throw new Error(`Unknown column type ${column.type}.`);
  }
}

const POSITION_COLUMN = "position";

function tableView(relation: TableRelation): { sql: string; columns: PageRelationColumn[] } {
  const registration = { schema: relation.schema };
  const table = relation.schema.tables[relation.table as never] as AnyTable;
  const selected: string[] = [];
  const joins: string[] = [];
  const columns: PageRelationColumn[] = [];
  for (const column of Object.values(table.columns)) {
    if (column.role === "internal-id" || column.role === "version") {
      continue;
    }
    const name = relation.references?.[column.name] ?? column.name;
    if (column.role === "reference") {
      // Joined on the referenced row's internal id, so filtering by the id it reads can use the
      // referencing table's index.
      const alias = quoteSqliteIdentifier(`ref_${column.name}`);
      const referenced = getTableForeignKey(table, column.name)!.referencedTable;
      joins.push(
        `LEFT JOIN ${quoteSqliteIdentifier(lofiSqliteTableName(registration, referenced.name))} AS ${alias} ON ${alias}.${quoteSqliteIdentifier(referenced.getInternalIdColumn().name)} = "row".${quoteSqliteIdentifier(column.name)}`,
      );
      selected.push(
        `${alias}.${quoteSqliteIdentifier(referenced.getIdColumn().name)} AS ${quoteSqliteIdentifier(name)}`,
      );
    } else {
      selected.push(
        `"row".${quoteSqliteIdentifier(column.name)} AS ${quoteSqliteIdentifier(name)}`,
      );
    }
    columns.push({
      name,
      type: columnType(column),
      nullable: column.isNullable,
      ...(relation.values?.[name] ? { values: relation.values[name] } : {}),
    });
  }
  // The replica's internal id follows outbox order. Rows one transaction creates share their
  // `createdAt`, and their ids are random, so only this orders them.
  selected.push(
    `"row".${quoteSqliteIdentifier(table.getInternalIdColumn().name)} AS ${quoteSqliteIdentifier(POSITION_COLUMN)}`,
  );
  columns.push({ name: POSITION_COLUMN, type: "integer", nullable: false });
  return {
    sql: `SELECT ${selected.join(", ")} FROM ${quoteSqliteIdentifier(lofiSqliteTableName(registration, relation.table))} AS "row" ${joins.join(" ")}`.trim(),
    columns,
  };
}

const viewTable = (name: keyof typeof automationViewsSchema.tables) =>
  quoteSqliteIdentifier(lofiSqliteTableName({ schema: automationViewsSchema }, name));

/** What the scope's projections keep, as views. */
const PROJECTION_RELATIONS: (PageRelation & { sql: string })[] = [
  {
    name: "connections",
    description:
      "Integration connections as their latest state change reports them, disconnected ones included; name and authMethod are null until a change carries a label. displayName is what people call the connection and kindLabel its kind, such as MCP.",
    sql: `SELECT "id" AS "connectionId", "service", "kind", "state", "name", "authMethod", "eventId", "changedAt", "displayName", "kindLabel" FROM ${viewTable("integration_connection")}`,
    columns: [
      { name: "connectionId", type: "text", nullable: false },
      { name: "service", type: "text", nullable: false },
      { name: "kind", type: "text", nullable: false },
      {
        name: "state",
        type: "text",
        nullable: false,
        values: ["ready", "unavailable", "disconnected"],
      },
      { name: "name", type: "text", nullable: true },
      { name: "authMethod", type: "text", nullable: true },
      { name: "eventId", type: "text", nullable: false },
      { name: "changedAt", type: "time", nullable: false },
      { name: "displayName", type: "text", nullable: false },
      { name: "kindLabel", type: "text", nullable: false },
    ],
  },
  {
    name: "agent_turns",
    description: "Turns agents ended, one row each.",
    sql: `SELECT "id", "agentName", "outcome", "endedAt" FROM ${viewTable("pi_agent_turn")}`,
    columns: [
      { name: "id", type: "text", nullable: false },
      { name: "agentName", type: "text", nullable: false },
      {
        name: "outcome",
        type: "text",
        nullable: false,
        values: ["answered", "cut-off", "failed"],
      },
      { name: "endedAt", type: "time", nullable: false },
    ],
  },
];

/** Encodes a value as the replica stores it: times as milliseconds, booleans as 0 or 1, JSON as text. */
function storedValue(value: unknown): SqliteValue {
  if (value === null || value === undefined) {
    return null;
  }
  if (value instanceof Date) {
    return value.getTime();
  }
  if (typeof value === "boolean") {
    return value ? 1 : 0;
  }
  if (typeof value === "string" || typeof value === "number") {
    return value;
  }
  return JSON.stringify(value);
}

type DerivedRelation = PageRelation & {
  /** The columns' values of each record. */
  rows: (reader: Parameters<LofiSqliteDerivedRelation["compute"]>[0]) => Record<string, unknown>[];
};

/** What Backoffice derives in JavaScript, with the functions its other views use. */
const DERIVED_RELATIONS: DerivedRelation[] = [
  {
    name: "agents",
    description:
      "Pi agents, built-in ones included, as their events record them now; latestKind and latestAt are null for an agent with no recorded activity. displayName is the name people read and activity what the agent does or did last, such as Answered. definition is JSON holding description, permissions, and steward.",
    columns: [
      { name: "agentName", type: "text", nullable: false },
      { name: "definition", type: "json", nullable: false },
      { name: "builtIn", type: "boolean", nullable: false },
      { name: "latestKind", type: "text", nullable: true },
      { name: "latestAt", type: "time", nullable: true },
      { name: "answering", type: "boolean", nullable: false },
      { name: "queued", type: "integer", nullable: false },
      { name: "steering", type: "integer", nullable: false },
      { name: "paused", type: "boolean", nullable: false },
      { name: "displayName", type: "text", nullable: false },
      { name: "activity", type: "text", nullable: false },
    ],
    rows: (reader) => readPiAgents(reader),
  },
  {
    name: "workflow_waits",
    description:
      "Event types waiting runs wait for, one row each; runId is the run's id. interfaceStepKey names the completed step whose interface asks a person to answer, or is null.",
    columns: [
      { name: "id", type: "text", nullable: false },
      { name: "runId", type: "text", nullable: false },
      { name: "eventType", type: "text", nullable: false },
      { name: "interfaceStepKey", type: "text", nullable: true },
    ],
    rows: (reader) =>
      currentWorkflowWaits(
        readWorkflowRuns(reader, { type: "waiting" }).map((run) => ({
          id: run.id,
          output: run.output,
          steps: run.workflowSteps,
          events: run.workflowEvents,
        })),
      ),
  },
];

const tableViews = TABLE_RELATIONS.map((relation) => ({ relation, ...tableView(relation) }));

/** Every relation pages read, as page-schema.d.ts describes them. */
export const AUTOMATION_PAGE_RELATIONS: PageRelation[] = [
  ...tableViews.map(({ relation, columns }) => ({
    name: relation.name,
    description: relation.description,
    columns,
  })),
  ...PROJECTION_RELATIONS.map(({ name, description, columns }) => ({ name, description, columns })),
  ...DERIVED_RELATIONS.map(({ name, description, columns }) => ({ name, description, columns })),
];

/** Each relation computed from tables, as the SELECT that reads it from the replica's tables. */
export const AUTOMATION_PAGE_VIEWS_SQL: Readonly<Record<string, string>> = Object.fromEntries([
  ...tableViews.map(({ relation, sql }) => [relation.name, sql]),
  ...PROJECTION_RELATIONS.map(({ name, sql }) => [name, sql]),
]);

/** The relations Backoffice derives in JavaScript, as the replica worker computes them. */
export const AUTOMATION_PAGE_DERIVED_RELATIONS: Readonly<
  Record<string, LofiSqliteDerivedRelation>
> = Object.fromEntries(
  DERIVED_RELATIONS.map(({ name, columns, rows }): [string, LofiSqliteDerivedRelation] => [
    name,
    {
      columns: columns.map((column) => column.name),
      compute: (reader) =>
        rows(reader).map((row) => columns.map((column) => storedValue(row[column.name]))),
    },
  ]),
);

/**
 * Creates an empty database that page queries read as they read the replica: the replica's
 * tables, the relations computed from them as views, and the derived relations as tables.
 */
export const AUTOMATION_PAGE_DATABASE_SCHEMA: readonly string[] = [
  ...createLofiSqliteTableStatements([
    ...AUTOMATION_REPLICA_SCHEMAS,
    ...automationViews.localSchemas,
  ]),
  ...Object.entries(AUTOMATION_PAGE_VIEWS_SQL).map(
    ([name, sql]) => `CREATE VIEW ${quoteSqliteIdentifier(name)} AS ${sql}`,
  ),
  ...DERIVED_RELATIONS.map(
    ({ name, columns }) =>
      `CREATE TABLE ${quoteSqliteIdentifier(name)} (${columns.map((column) => quoteSqliteIdentifier(column.name)).join(", ")})`,
  ),
];
