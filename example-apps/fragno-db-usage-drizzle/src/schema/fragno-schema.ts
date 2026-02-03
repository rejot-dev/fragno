import { pgTable, varchar, text, bigserial, integer, uniqueIndex, json, timestamp, index, customType, pgSchema, bigint, foreignKey, boolean } from "drizzle-orm/pg-core"
import { createId } from "@fragno-dev/db/id"
import { relations } from "drizzle-orm"
const customBinary = customType<
  {
    data: Uint8Array;
    driverData: Buffer;
  }
>({
  dataType() {
    return "bytea";
  },
  fromDriver(value) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
  },
  toDriver(value) {
    return value instanceof Buffer? value : Buffer.from(value)
  }
});

// ============================================================================
// Fragment: (none)
// ============================================================================

export const fragno_db_settings = pgTable("fragno_db_settings", {
  id: varchar("id", { length: 30 }).notNull().unique().$defaultFn(() => createId()),
  key: text("key").notNull(),
  value: text("value").notNull(),
  _internalId: bigserial("_internalId", { mode: "number" }).primaryKey().notNull(),
  _version: integer("_version").notNull().default(0)
}, (table) => [
  uniqueIndex("unique_key").on(table.key)
])

export const fragno_hooks = pgTable("fragno_hooks", {
  id: varchar("id", { length: 30 }).notNull().unique().$defaultFn(() => createId()),
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
  _internalId: bigserial("_internalId", { mode: "number" }).primaryKey().notNull(),
  _version: integer("_version").notNull().default(0)
}, (table) => [
  index("idx_namespace_status_retry").on(table.namespace, table.status, table.nextRetryAt),
  index("idx_nonce").on(table.nonce)
])

export const fragno_db_outbox = pgTable("fragno_db_outbox", {
  id: varchar("id", { length: 30 }).notNull().unique().$defaultFn(() => createId()),
  versionstamp: customBinary("versionstamp").notNull(),
  uowId: text("uowId").notNull(),
  payload: json("payload").notNull(),
  refMap: json("refMap"),
  createdAt: timestamp("createdAt").notNull().defaultNow(),
  _internalId: bigserial("_internalId", { mode: "number" }).primaryKey().notNull(),
  _version: integer("_version").notNull().default(0)
}, (table) => [
  uniqueIndex("idx_outbox_versionstamp").on(table.versionstamp),
  index("idx_outbox_uow").on(table.uowId)
])

// ============================================================================
// Fragment: comment
// ============================================================================

const schema_comment = pgSchema("comment");

export const comment_comment = schema_comment.table("comment", {
  id: varchar("id", { length: 30 }).notNull().unique().$defaultFn(() => createId()),
  title: text("title").notNull(),
  content: text("content").notNull(),
  createdAt: timestamp("createdAt").notNull().defaultNow(),
  postReference: text("postReference").notNull(),
  userReference: text("userReference").notNull(),
  parentId: bigint("parentId", { mode: "number" }),
  _internalId: bigserial("_internalId", { mode: "number" }).primaryKey().notNull(),
  _version: integer("_version").notNull().default(0),
  rating: integer("rating").notNull().default(0)
}, (table) => [
  foreignKey({
    columns: [table.parentId],
    foreignColumns: [table._internalId],
    name: "fk_comment_comment_parent"
  }),
  index("idx_comment_post").on(table.postReference)
])

export const comment_commentRelations = relations(comment_comment, ({ one, many }) => ({
  parent: one(comment_comment, {
    relationName: "comment_comment",
    fields: [comment_comment.parentId],
    references: [comment_comment._internalId]
  }),
  commentList: many(comment_comment, {
    relationName: "comment_comment"
  })
}));

export const comment_schema = {
  comment_comment: comment_comment,
  comment_commentRelations: comment_commentRelations,
  comment: comment_comment,
  commentRelations: comment_commentRelations,
  schemaVersion: 3
}

// ============================================================================
// Fragment: upvote
// ============================================================================

const schema_upvote = pgSchema("upvote");

export const upvote_upvote = schema_upvote.table("upvote", {
  id: varchar("id", { length: 30 }).notNull().unique().$defaultFn(() => createId()),
  reference: text("reference").notNull(),
  ownerReference: text("ownerReference"),
  rating: integer("rating").notNull(),
  createdAt: timestamp("createdAt").notNull().defaultNow(),
  note: text("note"),
  _internalId: bigserial("_internalId", { mode: "number" }).primaryKey().notNull(),
  _version: integer("_version").notNull().default(0)
}, (table) => [
  index("idx_upvote_reference").on(table.reference, table.ownerReference)
])

export const upvote_total_upvote = schema_upvote.table("upvote_total", {
  id: varchar("id", { length: 30 }).notNull().unique().$defaultFn(() => createId()),
  reference: text("reference").notNull(),
  total: integer("total").notNull().default(0),
  _internalId: bigserial("_internalId", { mode: "number" }).primaryKey().notNull(),
  _version: integer("_version").notNull().default(0)
}, (table) => [
  uniqueIndex("idx_upvote_total_reference").on(table.reference)
])

export const upvote_schema = {
  upvote_upvote: upvote_upvote,
  upvote: upvote_upvote,
  upvote_total_upvote: upvote_total_upvote,
  upvote_total: upvote_total_upvote,
  schemaVersion: 2
}

// ============================================================================
// Fragment: auth
// ============================================================================

const schema_auth = pgSchema("auth");

export const user_auth = schema_auth.table("user", {
  id: varchar("id", { length: 30 }).notNull().unique().$defaultFn(() => createId()),
  email: text("email").notNull(),
  passwordHash: text("passwordHash").notNull(),
  role: text("role").notNull().default("user"),
  createdAt: timestamp("createdAt").notNull().defaultNow(),
  _internalId: bigserial("_internalId", { mode: "number" }).primaryKey().notNull(),
  _version: integer("_version").notNull().default(0)
}, (table) => [
  index("idx_user_email").on(table.email),
  uniqueIndex("idx_user_id").on(table.id),
  index("idx_user_createdAt").on(table.createdAt)
])

export const session_auth = schema_auth.table("session", {
  id: varchar("id", { length: 30 }).notNull().unique().$defaultFn(() => createId()),
  userId: bigint("userId", { mode: "number" }).notNull(),
  expiresAt: timestamp("expiresAt").notNull(),
  createdAt: timestamp("createdAt").notNull().defaultNow(),
  _internalId: bigserial("_internalId", { mode: "number" }).primaryKey().notNull(),
  _version: integer("_version").notNull().default(0)
}, (table) => [
  foreignKey({
    columns: [table.userId],
    foreignColumns: [user_auth._internalId],
    name: "fk_session_user_sessionOwner"
  }),
  index("idx_session_user").on(table.userId)
])

export const user_authRelations = relations(user_auth, ({ many }) => ({
  sessionList: many(session_auth, {
    relationName: "session_user"
  })
}));

export const session_authRelations = relations(session_auth, ({ one }) => ({
  sessionOwner: one(user_auth, {
    relationName: "session_user",
    fields: [session_auth.userId],
    references: [user_auth._internalId]
  })
}));

export const auth_schema = {
  user_auth: user_auth,
  user_authRelations: user_authRelations,
  user: user_auth,
  userRelations: user_authRelations,
  session_auth: session_auth,
  session_authRelations: session_authRelations,
  session: session_auth,
  sessionRelations: session_authRelations,
  schemaVersion: 4
}

// ============================================================================
// Fragment: workflows
// ============================================================================

const schema_workflows = pgSchema("workflows");

export const workflow_instance_workflows = schema_workflows.table("workflow_instance", {
  id: varchar("id", { length: 30 }).notNull().unique().$defaultFn(() => createId()),
  instanceId: text("instanceId").notNull(),
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
  pauseRequested: boolean("pauseRequested").notNull().default(false),
  retentionUntil: timestamp("retentionUntil"),
  runNumber: integer("runNumber").notNull().default(0),
  _internalId: bigserial("_internalId", { mode: "number" }).primaryKey().notNull(),
  _version: integer("_version").notNull().default(0)
}, (table) => [
  uniqueIndex("idx_workflow_instance_workflowName_instanceId").on(table.workflowName, table.instanceId),
  index("idx_workflow_instance_status_updatedAt").on(table.workflowName, table.status, table.updatedAt)
])

export const workflow_step_workflows = schema_workflows.table("workflow_step", {
  id: varchar("id", { length: 30 }).notNull().unique().$defaultFn(() => createId()),
  instanceRef: bigint("instanceRef", { mode: "number" }).notNull(),
  workflowName: text("workflowName").notNull(),
  instanceId: text("instanceId").notNull(),
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
  _version: integer("_version").notNull().default(0)
}, (table) => [
  foreignKey({
    columns: [table.instanceRef],
    foreignColumns: [workflow_instance_workflows._internalId],
    name: "fk_workflow_step_workflow_instance_stepInstance"
  }),
  uniqueIndex("idx_workflow_step_workflowName_instanceId_runNumber_stepKey").on(table.workflowName, table.instanceId, table.runNumber, table.stepKey),
  index("idx_workflow_step_instanceRef_runNumber").on(table.instanceRef, table.runNumber),
  index("idx_workflow_step_history_createdAt").on(table.workflowName, table.instanceId, table.runNumber, table.createdAt),
  index("idx_workflow_step_status_wakeAt").on(table.workflowName, table.instanceId, table.runNumber, table.status, table.wakeAt),
  index("idx_workflow_step_workflowName_instanceId_status").on(table.workflowName, table.instanceId, table.status),
  index("idx_workflow_step_status_nextRetryAt").on(table.status, table.nextRetryAt)
])

export const workflow_event_workflows = schema_workflows.table("workflow_event", {
  id: varchar("id", { length: 30 }).notNull().unique().$defaultFn(() => createId()),
  instanceRef: bigint("instanceRef", { mode: "number" }).notNull(),
  workflowName: text("workflowName").notNull(),
  instanceId: text("instanceId").notNull(),
  runNumber: integer("runNumber").notNull(),
  type: text("type").notNull(),
  payload: json("payload"),
  createdAt: timestamp("createdAt").notNull().defaultNow(),
  deliveredAt: timestamp("deliveredAt"),
  consumedByStepKey: text("consumedByStepKey"),
  _internalId: bigserial("_internalId", { mode: "number" }).primaryKey().notNull(),
  _version: integer("_version").notNull().default(0)
}, (table) => [
  foreignKey({
    columns: [table.instanceRef],
    foreignColumns: [workflow_instance_workflows._internalId],
    name: "fk_workflow_event_workflow_instance_eventInstance"
  }),
  index("idx_workflow_event_type_deliveredAt").on(table.workflowName, table.instanceId, table.runNumber, table.type, table.deliveredAt),
  index("idx_workflow_event_instanceRef_runNumber_createdAt").on(table.instanceRef, table.runNumber, table.createdAt),
  index("idx_workflow_event_history_createdAt").on(table.workflowName, table.instanceId, table.runNumber, table.createdAt)
])

export const workflow_task_workflows = schema_workflows.table("workflow_task", {
  id: varchar("id", { length: 30 }).notNull().unique().$defaultFn(() => createId()),
  instanceRef: bigint("instanceRef", { mode: "number" }).notNull(),
  workflowName: text("workflowName").notNull(),
  instanceId: text("instanceId").notNull(),
  runNumber: integer("runNumber").notNull(),
  kind: text("kind").notNull(),
  runAt: timestamp("runAt").notNull(),
  status: text("status").notNull(),
  attempts: integer("attempts").notNull().default(0),
  maxAttempts: integer("maxAttempts").notNull(),
  lastError: text("lastError"),
  lockedUntil: timestamp("lockedUntil"),
  lockOwner: text("lockOwner"),
  createdAt: timestamp("createdAt").notNull().defaultNow(),
  updatedAt: timestamp("updatedAt").notNull().defaultNow(),
  _internalId: bigserial("_internalId", { mode: "number" }).primaryKey().notNull(),
  _version: integer("_version").notNull().default(0)
}, (table) => [
  foreignKey({
    columns: [table.instanceRef],
    foreignColumns: [workflow_instance_workflows._internalId],
    name: "fk_workflow_task_workflow_instance_taskInstance"
  }),
  index("idx_workflow_task_status_runAt").on(table.status, table.runAt),
  index("idx_workflow_task_status_lockedUntil").on(table.status, table.lockedUntil),
  uniqueIndex("idx_workflow_task_workflowName_instanceId_runNumber").on(table.workflowName, table.instanceId, table.runNumber)
])

export const workflow_log_workflows = schema_workflows.table("workflow_log", {
  id: varchar("id", { length: 30 }).notNull().unique().$defaultFn(() => createId()),
  instanceRef: bigint("instanceRef", { mode: "number" }).notNull(),
  workflowName: text("workflowName").notNull(),
  instanceId: text("instanceId").notNull(),
  runNumber: integer("runNumber").notNull(),
  stepKey: text("stepKey"),
  attempt: integer("attempt"),
  level: text("level").notNull(),
  category: text("category").notNull(),
  message: text("message").notNull(),
  data: json("data"),
  createdAt: timestamp("createdAt").notNull().defaultNow(),
  _internalId: bigserial("_internalId", { mode: "number" }).primaryKey().notNull(),
  _version: integer("_version").notNull().default(0)
}, (table) => [
  foreignKey({
    columns: [table.instanceRef],
    foreignColumns: [workflow_instance_workflows._internalId],
    name: "fk_workflow_log_workflow_instance_logInstance"
  }),
  index("idx_workflow_log_history_createdAt").on(table.workflowName, table.instanceId, table.runNumber, table.createdAt),
  index("idx_workflow_log_level_createdAt").on(table.workflowName, table.instanceId, table.runNumber, table.level, table.createdAt),
  index("idx_workflow_log_category_createdAt").on(table.workflowName, table.instanceId, table.runNumber, table.category, table.createdAt),
  index("idx_workflow_log_instanceRef_runNumber_createdAt").on(table.instanceRef, table.runNumber, table.createdAt)
])

export const workflow_instance_workflowsRelations = relations(workflow_instance_workflows, ({ many }) => ({
  workflow_stepList: many(workflow_step_workflows, {
    relationName: "workflow_step_workflow_instance"
  }),
  workflow_eventList: many(workflow_event_workflows, {
    relationName: "workflow_event_workflow_instance"
  }),
  workflow_taskList: many(workflow_task_workflows, {
    relationName: "workflow_task_workflow_instance"
  }),
  workflow_logList: many(workflow_log_workflows, {
    relationName: "workflow_log_workflow_instance"
  })
}));

export const workflow_step_workflowsRelations = relations(workflow_step_workflows, ({ one }) => ({
  stepInstance: one(workflow_instance_workflows, {
    relationName: "workflow_step_workflow_instance",
    fields: [workflow_step_workflows.instanceRef],
    references: [workflow_instance_workflows._internalId]
  })
}));

export const workflow_event_workflowsRelations = relations(workflow_event_workflows, ({ one }) => ({
  eventInstance: one(workflow_instance_workflows, {
    relationName: "workflow_event_workflow_instance",
    fields: [workflow_event_workflows.instanceRef],
    references: [workflow_instance_workflows._internalId]
  })
}));

export const workflow_task_workflowsRelations = relations(workflow_task_workflows, ({ one }) => ({
  taskInstance: one(workflow_instance_workflows, {
    relationName: "workflow_task_workflow_instance",
    fields: [workflow_task_workflows.instanceRef],
    references: [workflow_instance_workflows._internalId]
  })
}));

export const workflow_log_workflowsRelations = relations(workflow_log_workflows, ({ one }) => ({
  logInstance: one(workflow_instance_workflows, {
    relationName: "workflow_log_workflow_instance",
    fields: [workflow_log_workflows.instanceRef],
    references: [workflow_instance_workflows._internalId]
  })
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
  workflow_task_workflows: workflow_task_workflows,
  workflow_task_workflowsRelations: workflow_task_workflowsRelations,
  workflow_task: workflow_task_workflows,
  workflow_taskRelations: workflow_task_workflowsRelations,
  workflow_log_workflows: workflow_log_workflows,
  workflow_log_workflowsRelations: workflow_log_workflowsRelations,
  workflow_log: workflow_log_workflows,
  workflow_logRelations: workflow_log_workflowsRelations,
  schemaVersion: 9
}