import { mysqlTable, varchar, text, bigint, int, uniqueIndex, json, datetime, index, customType, foreignKey, boolean } from "drizzle-orm/mysql-core"
import { createId } from "@fragno-dev/db/id"
import { sql, relations } from "drizzle-orm"
const customBinary = customType<
  {
    data: Uint8Array;
    driverData: Buffer;
  }
>({
  dataType() {
    return "longblob";
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

export const fragno_db_settings = mysqlTable("fragno_db_settings", {
  id: varchar("id", { length: 30 }).notNull().unique().$defaultFn(() => createId()),
  key: text("key").notNull(),
  value: text("value").notNull(),
  _internalId: bigint("_internalId", { mode: "number" }).primaryKey().autoincrement().notNull(),
  _version: int("_version").notNull().default(0)
}, (table) => [
  uniqueIndex("uidx_fragno_db_settings_unique_key_09269db3").on(table.key)
])

export const fragno_hooks = mysqlTable("fragno_hooks", {
  id: varchar("id", { length: 30 }).notNull().unique().$defaultFn(() => createId()),
  namespace: text("namespace").notNull(),
  hookName: text("hookName").notNull(),
  payload: json("payload").notNull(),
  status: text("status").notNull(),
  attempts: int("attempts").notNull().default(0),
  maxAttempts: int("maxAttempts").notNull().default(5),
  lastAttemptAt: datetime("lastAttemptAt"),
  nextRetryAt: datetime("nextRetryAt"),
  error: text("error"),
  createdAt: datetime("createdAt").notNull().default(sql`(now())`),
  nonce: text("nonce").notNull(),
  _internalId: bigint("_internalId", { mode: "number" }).primaryKey().autoincrement().notNull(),
  _version: int("_version").notNull().default(0)
}, (table) => [
  index("idx_fragno_hooks_idx_namespace_status_retry_b66b1168").on(table.namespace, table.status, table.nextRetryAt),
  index("idx_fragno_hooks_idx_nonce_90c97cf1").on(table.nonce)
])

export const fragno_db_outbox = mysqlTable("fragno_db_outbox", {
  id: varchar("id", { length: 30 }).notNull().unique().$defaultFn(() => createId()),
  versionstamp: customBinary("versionstamp").notNull(),
  uowId: text("uowId").notNull(),
  payload: json("payload").notNull(),
  refMap: json("refMap"),
  createdAt: datetime("createdAt").notNull().default(sql`(now())`),
  _internalId: bigint("_internalId", { mode: "number" }).primaryKey().autoincrement().notNull(),
  _version: int("_version").notNull().default(0)
}, (table) => [
  uniqueIndex("uidx_fragno_db_outbox_idx_outbox_versionstamp_37972a68").on(table.versionstamp),
  index("idx_fragno_db_outbox_idx_outbox_uow_733c7f90").on(table.uowId)
])

// ============================================================================
// Fragment: auth
// ============================================================================

export const user_auth = mysqlTable("user_auth", {
  id: varchar("id", { length: 30 }).notNull().unique().$defaultFn(() => createId()),
  email: text("email").notNull(),
  passwordHash: text("passwordHash").notNull(),
  role: text("role").notNull().default("user"),
  createdAt: datetime("createdAt").notNull().default(sql`(now())`),
  _internalId: bigint("_internalId", { mode: "number" }).primaryKey().autoincrement().notNull(),
  _version: int("_version").notNull().default(0)
}, (table) => [
  index("idx_user_idx_user_email_auth_47062eb8").on(table.email),
  uniqueIndex("uidx_user_idx_user_id_auth_1370c3c6").on(table.id),
  index("idx_user_idx_user_createdAt_auth_3290a418").on(table.createdAt)
])

export const session_auth = mysqlTable("session_auth", {
  id: varchar("id", { length: 30 }).notNull().unique().$defaultFn(() => createId()),
  userId: bigint("userId", { mode: "number" }).notNull(),
  expiresAt: datetime("expiresAt").notNull(),
  createdAt: datetime("createdAt").notNull().default(sql`(now())`),
  _internalId: bigint("_internalId", { mode: "number" }).primaryKey().autoincrement().notNull(),
  _version: int("_version").notNull().default(0)
}, (table) => [
  foreignKey({
    columns: [table.userId],
    foreignColumns: [user_auth._internalId],
    name: "fk_session_user_sessionOwner_auth_7854da47"
  }),
  index("idx_session_idx_session_user_auth_0748231c").on(table.userId)
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
// Fragment: comment
// ============================================================================

export const comment_comment = mysqlTable("comment_comment", {
  id: varchar("id", { length: 30 }).notNull().unique().$defaultFn(() => createId()),
  title: text("title").notNull(),
  content: text("content").notNull(),
  createdAt: datetime("createdAt").notNull().default(sql`(now())`),
  postReference: text("postReference").notNull(),
  userReference: text("userReference").notNull(),
  parentId: bigint("parentId", { mode: "number" }),
  _internalId: bigint("_internalId", { mode: "number" }).primaryKey().autoincrement().notNull(),
  _version: int("_version").notNull().default(0),
  rating: int("rating").notNull().default(0)
}, (table) => [
  foreignKey({
    columns: [table.parentId],
    foreignColumns: [table._internalId],
    name: "fk_comment_comment_parent_comment_e6560345"
  }),
  index("idx_comment_idx_comment_post_comment_c75acad5").on(table.postReference)
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

export const upvote_upvote = mysqlTable("upvote_upvote", {
  id: varchar("id", { length: 30 }).notNull().unique().$defaultFn(() => createId()),
  reference: text("reference").notNull(),
  ownerReference: text("ownerReference"),
  rating: int("rating").notNull(),
  createdAt: datetime("createdAt").notNull().default(sql`(now())`),
  note: text("note"),
  _internalId: bigint("_internalId", { mode: "number" }).primaryKey().autoincrement().notNull(),
  _version: int("_version").notNull().default(0)
}, (table) => [
  index("idx_upvote_idx_upvote_reference_upvote_94fd688f").on(table.reference, table.ownerReference)
])

export const upvote_total_upvote = mysqlTable("upvote_total_upvote", {
  id: varchar("id", { length: 30 }).notNull().unique().$defaultFn(() => createId()),
  reference: text("reference").notNull(),
  total: int("total").notNull().default(0),
  _internalId: bigint("_internalId", { mode: "number" }).primaryKey().autoincrement().notNull(),
  _version: int("_version").notNull().default(0)
}, (table) => [
  uniqueIndex("uidx_upvote_total_idx_upvote_total_reference_upvote_b702eb9a").on(table.reference)
])

export const upvote_schema = {
  upvote_upvote: upvote_upvote,
  upvote: upvote_upvote,
  upvote_total_upvote: upvote_total_upvote,
  upvote_total: upvote_total_upvote,
  schemaVersion: 2
}

// ============================================================================
// Fragment: workflows
// ============================================================================

export const workflow_instance_workflows = mysqlTable("workflow_instance_workflows", {
  id: varchar("id", { length: 30 }).notNull().unique().$defaultFn(() => createId()),
  instanceId: text("instanceId").notNull(),
  workflowName: text("workflowName").notNull(),
  status: text("status").notNull(),
  createdAt: datetime("createdAt").notNull().default(sql`(now())`),
  updatedAt: datetime("updatedAt").notNull().default(sql`(now())`),
  startedAt: datetime("startedAt"),
  completedAt: datetime("completedAt"),
  params: json("params").notNull(),
  output: json("output"),
  errorName: text("errorName"),
  errorMessage: text("errorMessage"),
  pauseRequested: boolean("pauseRequested").notNull().default(false),
  retentionUntil: datetime("retentionUntil"),
  runNumber: int("runNumber").notNull().default(0),
  _internalId: bigint("_internalId", { mode: "number" }).primaryKey().autoincrement().notNull(),
  _version: int("_version").notNull().default(0)
}, (table) => [
  uniqueIndex("uidx_workflow_instance_idx_workflow_instance_workflowNa12b3a436").on(table.workflowName, table.instanceId),
  index("idx_workflow_instance_idx_workflow_instance_status_upda83267b95").on(table.workflowName, table.status, table.updatedAt)
])

export const workflow_step_workflows = mysqlTable("workflow_step_workflows", {
  id: varchar("id", { length: 30 }).notNull().unique().$defaultFn(() => createId()),
  instanceRef: bigint("instanceRef", { mode: "number" }).notNull(),
  workflowName: text("workflowName").notNull(),
  instanceId: text("instanceId").notNull(),
  runNumber: int("runNumber").notNull(),
  stepKey: text("stepKey").notNull(),
  name: text("name").notNull(),
  type: text("type").notNull(),
  status: text("status").notNull(),
  attempts: int("attempts").notNull().default(0),
  maxAttempts: int("maxAttempts").notNull(),
  timeoutMs: int("timeoutMs"),
  nextRetryAt: datetime("nextRetryAt"),
  wakeAt: datetime("wakeAt"),
  waitEventType: text("waitEventType"),
  result: json("result"),
  errorName: text("errorName"),
  errorMessage: text("errorMessage"),
  createdAt: datetime("createdAt").notNull().default(sql`(now())`),
  updatedAt: datetime("updatedAt").notNull().default(sql`(now())`),
  _internalId: bigint("_internalId", { mode: "number" }).primaryKey().autoincrement().notNull(),
  _version: int("_version").notNull().default(0)
}, (table) => [
  foreignKey({
    columns: [table.instanceRef],
    foreignColumns: [workflow_instance_workflows._internalId],
    name: "fk_workflow_step_workflow_instance_stepInstance_workflo01bdff32"
  }),
  uniqueIndex("uidx_workflow_step_idx_workflow_step_workflowName_instabbcccb8d").on(table.workflowName, table.instanceId, table.runNumber, table.stepKey),
  index("idx_workflow_step_idx_workflow_step_instanceRef_runNumb111fe377").on(table.instanceRef, table.runNumber),
  index("idx_workflow_step_idx_workflow_step_history_createdAt_w1fb9e39a").on(table.workflowName, table.instanceId, table.runNumber, table.createdAt),
  index("idx_workflow_step_idx_workflow_step_status_wakeAt_workf12ffa25b").on(table.workflowName, table.instanceId, table.runNumber, table.status, table.wakeAt),
  index("idx_workflow_step_idx_workflow_step_workflowName_instan0910de5c").on(table.workflowName, table.instanceId, table.status),
  index("idx_workflow_step_idx_workflow_step_status_nextRetryAt_d5657dc4").on(table.status, table.nextRetryAt)
])

export const workflow_event_workflows = mysqlTable("workflow_event_workflows", {
  id: varchar("id", { length: 30 }).notNull().unique().$defaultFn(() => createId()),
  instanceRef: bigint("instanceRef", { mode: "number" }).notNull(),
  workflowName: text("workflowName").notNull(),
  instanceId: text("instanceId").notNull(),
  runNumber: int("runNumber").notNull(),
  type: text("type").notNull(),
  payload: json("payload"),
  createdAt: datetime("createdAt").notNull().default(sql`(now())`),
  deliveredAt: datetime("deliveredAt"),
  consumedByStepKey: text("consumedByStepKey"),
  _internalId: bigint("_internalId", { mode: "number" }).primaryKey().autoincrement().notNull(),
  _version: int("_version").notNull().default(0)
}, (table) => [
  foreignKey({
    columns: [table.instanceRef],
    foreignColumns: [workflow_instance_workflows._internalId],
    name: "fk_workflow_event_workflow_instance_eventInstance_workf9b5621c6"
  }),
  index("idx_workflow_event_idx_workflow_event_type_deliveredAt_704adbee").on(table.workflowName, table.instanceId, table.runNumber, table.type, table.deliveredAt),
  index("idx_workflow_event_idx_workflow_event_instanceRef_runNu9d715b8f").on(table.instanceRef, table.runNumber, table.createdAt),
  index("idx_workflow_event_idx_workflow_event_history_createdAt62c7042e").on(table.workflowName, table.instanceId, table.runNumber, table.createdAt)
])

export const workflow_task_workflows = mysqlTable("workflow_task_workflows", {
  id: varchar("id", { length: 30 }).notNull().unique().$defaultFn(() => createId()),
  instanceRef: bigint("instanceRef", { mode: "number" }).notNull(),
  workflowName: text("workflowName").notNull(),
  instanceId: text("instanceId").notNull(),
  runNumber: int("runNumber").notNull(),
  kind: text("kind").notNull(),
  runAt: datetime("runAt").notNull(),
  status: text("status").notNull(),
  attempts: int("attempts").notNull().default(0),
  maxAttempts: int("maxAttempts").notNull(),
  lastError: text("lastError"),
  lockedUntil: datetime("lockedUntil"),
  lockOwner: text("lockOwner"),
  createdAt: datetime("createdAt").notNull().default(sql`(now())`),
  updatedAt: datetime("updatedAt").notNull().default(sql`(now())`),
  _internalId: bigint("_internalId", { mode: "number" }).primaryKey().autoincrement().notNull(),
  _version: int("_version").notNull().default(0)
}, (table) => [
  foreignKey({
    columns: [table.instanceRef],
    foreignColumns: [workflow_instance_workflows._internalId],
    name: "fk_workflow_task_workflow_instance_taskInstance_workfloc70ca854"
  }),
  index("idx_workflow_task_idx_workflow_task_status_runAt_workfl9555454f").on(table.status, table.runAt),
  index("idx_workflow_task_idx_workflow_task_status_lockedUntil_d7c21c4e").on(table.status, table.lockedUntil),
  uniqueIndex("uidx_workflow_task_idx_workflow_task_workflowName_instad0a3dfbc").on(table.workflowName, table.instanceId, table.runNumber)
])

export const workflow_log_workflows = mysqlTable("workflow_log_workflows", {
  id: varchar("id", { length: 30 }).notNull().unique().$defaultFn(() => createId()),
  instanceRef: bigint("instanceRef", { mode: "number" }).notNull(),
  workflowName: text("workflowName").notNull(),
  instanceId: text("instanceId").notNull(),
  runNumber: int("runNumber").notNull(),
  stepKey: text("stepKey"),
  attempt: int("attempt"),
  level: text("level").notNull(),
  category: text("category").notNull(),
  message: text("message").notNull(),
  data: json("data"),
  createdAt: datetime("createdAt").notNull().default(sql`(now())`),
  _internalId: bigint("_internalId", { mode: "number" }).primaryKey().autoincrement().notNull(),
  _version: int("_version").notNull().default(0)
}, (table) => [
  foreignKey({
    columns: [table.instanceRef],
    foreignColumns: [workflow_instance_workflows._internalId],
    name: "fk_workflow_log_workflow_instance_logInstance_workflowsb79df5f6"
  }),
  index("idx_workflow_log_idx_workflow_log_history_createdAt_woracbe60e0").on(table.workflowName, table.instanceId, table.runNumber, table.createdAt),
  index("idx_workflow_log_idx_workflow_log_level_createdAt_workf5249eadc").on(table.workflowName, table.instanceId, table.runNumber, table.level, table.createdAt),
  index("idx_workflow_log_idx_workflow_log_category_createdAt_wo557f68d7").on(table.workflowName, table.instanceId, table.runNumber, table.category, table.createdAt),
  index("idx_workflow_log_idx_workflow_log_instanceRef_runNumber7006b0b7").on(table.instanceRef, table.runNumber, table.createdAt)
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