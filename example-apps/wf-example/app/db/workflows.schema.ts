import {
  pgTable,
  varchar,
  text,
  bigserial,
  integer,
  uniqueIndex,
  index,
  json,
  timestamp,
  pgSchema,
  bigint,
  foreignKey,
} from "drizzle-orm/pg-core";
import { createId } from "@fragno-dev/db/id";
import { relations } from "drizzle-orm";

// ============================================================================
// Fragment: (none)
// ============================================================================

export const fragno_db_settings = pgTable(
  "fragno_db_settings",
  {
    id: varchar("id", { length: 128 })
      .notNull()
      .unique()
      .$defaultFn(() => createId()),
    key: text("key").notNull(),
    value: text("value").notNull(),
    _internalId: bigserial("_internalId", { mode: "number" }).primaryKey().notNull(),
    _version: integer("_version").notNull().default(0),
    _shard: varchar("_shard", { length: 128 }).notNull().default("__fragno_global__"),
  },
  (table) => [
    uniqueIndex("unique_key").on(table.key),
    index("idx_fragno_db_settings_shard").on(table._shard),
  ],
);

export const fragno_hooks = pgTable(
  "fragno_hooks",
  {
    id: varchar("id", { length: 128 })
      .notNull()
      .unique()
      .$defaultFn(() => createId()),
    namespace: text("namespace").notNull(),
    hookName: text("hookName").notNull(),
    payload: json("payload").notNull(),
    status: text("status").notNull(),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("maxAttempts").notNull().default(5),
    lastAttemptAt: timestamp("lastAttemptAt"),
    nextRetryAt: timestamp("nextRetryAt"),
    error: text("error"),
    createdAt: timestamp("createdAt").notNull().defaultNow(),
    nonce: text("nonce").notNull(),
    _shard: varchar("_shard", { length: 128 }).notNull().default("__fragno_global__"),
    _internalId: bigserial("_internalId", { mode: "number" }).primaryKey().notNull(),
    _version: integer("_version").notNull().default(0),
  },
  (table) => [
    index("idx_namespace_status_retry").on(table.namespace, table.status, table.nextRetryAt),
    index("idx_hooks_shard_status_retry").on(table._shard, table.status, table.nextRetryAt),
    index("idx_nonce").on(table.nonce),
    index("idx_fragno_hooks_shard").on(table._shard),
    index("idx_namespace_status_last_attempt").on(
      table.namespace,
      table.status,
      table.lastAttemptAt,
    ),
  ],
);

export const fragno_db_outbox = pgTable(
  "fragno_db_outbox",
  {
    id: varchar("id", { length: 128 })
      .notNull()
      .unique()
      .$defaultFn(() => createId()),
    versionstamp: text("versionstamp").notNull(),
    uowId: text("uowId").notNull(),
    payload: json("payload").notNull(),
    refMap: json("refMap"),
    createdAt: timestamp("createdAt").notNull().defaultNow(),
    _shard: varchar("_shard", { length: 128 }).notNull().default("__fragno_global__"),
    _internalId: bigserial("_internalId", { mode: "number" }).primaryKey().notNull(),
    _version: integer("_version").notNull().default(0),
  },
  (table) => [
    uniqueIndex("idx_outbox_versionstamp").on(table.versionstamp),
    index("idx_outbox_shard_versionstamp").on(table._shard, table.versionstamp),
    index("idx_outbox_uow").on(table.uowId),
    index("idx_fragno_db_outbox_shard").on(table._shard),
  ],
);

export const fragno_db_outbox_mutations = pgTable(
  "fragno_db_outbox_mutations",
  {
    id: varchar("id", { length: 128 })
      .notNull()
      .unique()
      .$defaultFn(() => createId()),
    entryVersionstamp: text("entryVersionstamp").notNull(),
    mutationVersionstamp: text("mutationVersionstamp").notNull(),
    uowId: text("uowId").notNull(),
    schema: text("schema").notNull(),
    table: text("table").notNull(),
    externalId: text("externalId").notNull(),
    op: text("op").notNull(),
    createdAt: timestamp("createdAt").notNull().defaultNow(),
    _shard: varchar("_shard", { length: 128 }).notNull().default("__fragno_global__"),
    _internalId: bigserial("_internalId", { mode: "number" }).primaryKey().notNull(),
    _version: integer("_version").notNull().default(0),
  },
  (table) => [
    index("idx_outbox_mutations_entry").on(table.entryVersionstamp),
    index("idx_outbox_mutations_shard_entry").on(table._shard, table.entryVersionstamp),
    index("idx_outbox_mutations_key").on(
      table.schema,
      table.table,
      table.externalId,
      table.entryVersionstamp,
    ),
    index("idx_outbox_mutations_uow").on(table.uowId),
    index("idx_fragno_db_outbox_mutations_shard").on(table._shard),
  ],
);

export const fragno_db_sync_requests = pgTable(
  "fragno_db_sync_requests",
  {
    id: varchar("id", { length: 128 })
      .notNull()
      .unique()
      .$defaultFn(() => createId()),
    requestId: text("requestId").notNull(),
    status: text("status").notNull(),
    confirmedCommandIds: json("confirmedCommandIds").notNull(),
    conflictCommandId: text("conflictCommandId"),
    baseVersionstamp: text("baseVersionstamp"),
    lastVersionstamp: text("lastVersionstamp"),
    createdAt: timestamp("createdAt").notNull().defaultNow(),
    _shard: varchar("_shard", { length: 128 }).notNull().default("__fragno_global__"),
    _internalId: bigserial("_internalId", { mode: "number" }).primaryKey().notNull(),
    _version: integer("_version").notNull().default(0),
  },
  (table) => [
    uniqueIndex("idx_sync_request_id").on(table.requestId),
    index("idx_sync_requests_shard_request").on(table._shard, table.requestId),
    index("idx_fragno_db_sync_requests_shard").on(table._shard),
  ],
);

// ============================================================================
// Fragment: workflows
// ============================================================================

const schema_workflows = pgSchema("workflows");

export const workflow_instance_workflows = schema_workflows.table(
  "workflow_instance",
  {
    id: varchar("id", { length: 128 })
      .notNull()
      .unique()
      .$defaultFn(() => createId()),
    workflowName: text("workflowName").notNull(),
    status: text("status").notNull(),
    createdAt: timestamp("createdAt").notNull().defaultNow(),
    updatedAt: timestamp("updatedAt").notNull().defaultNow(),
    startedAt: timestamp("startedAt"),
    completedAt: timestamp("completedAt"),
    params: json("params").notNull(),
    output: json("output"),
    errorName: text("errorName"),
    errorMessage: text("errorMessage"),
    runNumber: integer("runNumber").notNull().default(0),
    _internalId: bigserial("_internalId", { mode: "number" }).primaryKey().notNull(),
    _version: integer("_version").notNull().default(0),
    _shard: varchar("_shard", { length: 128 }).notNull().default("__fragno_global__"),
  },
  (table) => [
    uniqueIndex("idx_workflow_instance_workflowName_id").on(table.workflowName, table.id),
    index("idx_workflow_instance_workflowName_status_updatedAt").on(
      table.workflowName,
      table.status,
      table.updatedAt,
    ),
    index("idx_workflow_instance_shard").on(table._shard),
  ],
);

export const workflow_step_workflows = schema_workflows.table(
  "workflow_step",
  {
    id: varchar("id", { length: 128 })
      .notNull()
      .unique()
      .$defaultFn(() => createId()),
    instanceRef: bigint("instanceRef", { mode: "number" }).notNull(),
    runNumber: integer("runNumber").notNull(),
    stepKey: text("stepKey").notNull(),
    name: text("name").notNull(),
    type: text("type").notNull(),
    status: text("status").notNull(),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("maxAttempts").notNull(),
    timeoutMs: integer("timeoutMs"),
    nextRetryAt: timestamp("nextRetryAt"),
    wakeAt: timestamp("wakeAt"),
    waitEventType: text("waitEventType"),
    result: json("result"),
    errorName: text("errorName"),
    errorMessage: text("errorMessage"),
    createdAt: timestamp("createdAt").notNull().defaultNow(),
    updatedAt: timestamp("updatedAt").notNull().defaultNow(),
    _internalId: bigserial("_internalId", { mode: "number" }).primaryKey().notNull(),
    _version: integer("_version").notNull().default(0),
    _shard: varchar("_shard", { length: 128 }).notNull().default("__fragno_global__"),
  },
  (table) => [
    foreignKey({
      columns: [table.instanceRef],
      foreignColumns: [workflow_instance_workflows._internalId],
      name: "fk_workflow_step_workflow_instance_stepInstance",
    }),
    uniqueIndex("idx_workflow_step_instanceRef_runNumber_stepKey").on(
      table.instanceRef,
      table.runNumber,
      table.stepKey,
    ),
    index("idx_workflow_step_instanceRef_runNumber_createdAt").on(
      table.instanceRef,
      table.runNumber,
      table.createdAt,
    ),
    index("idx_workflow_step_instanceRef_status_wakeAt").on(
      table.instanceRef,
      table.status,
      table.wakeAt,
    ),
    index("idx_workflow_step_shard").on(table._shard),
  ],
);

export const workflow_event_workflows = schema_workflows.table(
  "workflow_event",
  {
    id: varchar("id", { length: 128 })
      .notNull()
      .unique()
      .$defaultFn(() => createId()),
    instanceRef: bigint("instanceRef", { mode: "number" }).notNull(),
    runNumber: integer("runNumber").notNull(),
    actor: text("actor").notNull().default("user"),
    type: text("type").notNull(),
    payload: json("payload"),
    createdAt: timestamp("createdAt").notNull().defaultNow(),
    deliveredAt: timestamp("deliveredAt"),
    consumedByStepKey: text("consumedByStepKey"),
    _internalId: bigserial("_internalId", { mode: "number" }).primaryKey().notNull(),
    _version: integer("_version").notNull().default(0),
    _shard: varchar("_shard", { length: 128 }).notNull().default("__fragno_global__"),
  },
  (table) => [
    foreignKey({
      columns: [table.instanceRef],
      foreignColumns: [workflow_instance_workflows._internalId],
      name: "fk_workflow_event_workflow_instance_eventInstance",
    }),
    index("idx_workflow_event_instanceRef_runNumber_createdAt").on(
      table.instanceRef,
      table.runNumber,
      table.createdAt,
    ),
    index("idx_workflow_event_shard").on(table._shard),
  ],
);

export const workflow_instance_workflowsRelations = relations(
  workflow_instance_workflows,
  ({ many }) => ({
    workflow_stepList: many(workflow_step_workflows, {
      relationName: "workflow_step_workflow_instance",
    }),
    workflow_eventList: many(workflow_event_workflows, {
      relationName: "workflow_event_workflow_instance",
    }),
  }),
);

export const workflow_step_workflowsRelations = relations(workflow_step_workflows, ({ one }) => ({
  stepInstance: one(workflow_instance_workflows, {
    relationName: "workflow_step_workflow_instance",
    fields: [workflow_step_workflows.instanceRef],
    references: [workflow_instance_workflows._internalId],
  }),
}));

export const workflow_event_workflowsRelations = relations(workflow_event_workflows, ({ one }) => ({
  eventInstance: one(workflow_instance_workflows, {
    relationName: "workflow_event_workflow_instance",
    fields: [workflow_event_workflows.instanceRef],
    references: [workflow_instance_workflows._internalId],
  }),
}));

export const workflows_schema = {
  workflow_instance_workflows: workflow_instance_workflows,
  workflow_instance_workflowsRelations: workflow_instance_workflowsRelations,
  workflow_instance: workflow_instance_workflows,
  workflow_instanceRelations: workflow_instance_workflowsRelations,
  workflow_step_workflows: workflow_step_workflows,
  workflow_step_workflowsRelations: workflow_step_workflowsRelations,
  workflow_step: workflow_step_workflows,
  workflow_stepRelations: workflow_step_workflowsRelations,
  workflow_event_workflows: workflow_event_workflows,
  workflow_event_workflowsRelations: workflow_event_workflowsRelations,
  workflow_event: workflow_event_workflows,
  workflow_eventRelations: workflow_event_workflowsRelations,
  schemaVersion: 5,
};
