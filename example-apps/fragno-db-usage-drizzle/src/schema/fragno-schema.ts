import { pgTable, varchar, text, bigserial, integer, uniqueIndex, json, timestamp, index, pgSchema, bigint, foreignKey } from "drizzle-orm/pg-core"
import { createId } from "@fragno-dev/db/id"
import { relations } from "drizzle-orm"

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
  index("idx_nonce").on(table.nonce),
  index("idx_namespace_status_last_attempt").on(table.namespace, table.status, table.lastAttemptAt)
])

export const fragno_db_outbox = pgTable("fragno_db_outbox", {
  id: varchar("id", { length: 30 }).notNull().unique().$defaultFn(() => createId()),
  versionstamp: text("versionstamp").notNull(),
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

export const fragno_db_outbox_mutations = pgTable("fragno_db_outbox_mutations", {
  id: varchar("id", { length: 30 }).notNull().unique().$defaultFn(() => createId()),
  entryVersionstamp: text("entryVersionstamp").notNull(),
  mutationVersionstamp: text("mutationVersionstamp").notNull(),
  uowId: text("uowId").notNull(),
  schema: text("schema").notNull(),
  table: text("table").notNull(),
  externalId: text("externalId").notNull(),
  op: text("op").notNull(),
  createdAt: timestamp("createdAt").notNull().defaultNow(),
  _internalId: bigserial("_internalId", { mode: "number" }).primaryKey().notNull(),
  _version: integer("_version").notNull().default(0)
}, (table) => [
  index("idx_outbox_mutations_entry").on(table.entryVersionstamp),
  index("idx_outbox_mutations_key").on(table.schema, table.table, table.externalId, table.entryVersionstamp),
  index("idx_outbox_mutations_uow").on(table.uowId)
])

export const fragno_db_sync_requests = pgTable("fragno_db_sync_requests", {
  id: varchar("id", { length: 30 }).notNull().unique().$defaultFn(() => createId()),
  requestId: text("requestId").notNull(),
  status: text("status").notNull(),
  confirmedCommandIds: json("confirmedCommandIds").notNull(),
  conflictCommandId: text("conflictCommandId"),
  baseVersionstamp: text("baseVersionstamp"),
  lastVersionstamp: text("lastVersionstamp"),
  createdAt: timestamp("createdAt").notNull().defaultNow(),
  _internalId: bigserial("_internalId", { mode: "number" }).primaryKey().notNull(),
  _version: integer("_version").notNull().default(0)
}, (table) => [
  uniqueIndex("idx_sync_request_id").on(table.requestId)
])

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
  _version: integer("_version").notNull().default(0),
  bannedAt: timestamp("bannedAt")
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
  _version: integer("_version").notNull().default(0),
  activeOrganizationId: bigint("activeOrganizationId", { mode: "number" })
}, (table) => [
  foreignKey({
    columns: [table.userId],
    foreignColumns: [user_auth._internalId],
    name: "fk_session_user_sessionOwner"
  }),
  foreignKey({
    columns: [table.activeOrganizationId],
    foreignColumns: [organization_auth._internalId],
    name: "fk_session_organization_sessionActiveOrganization"
  }),
  index("idx_session_user").on(table.userId)
])

export const organization_auth = schema_auth.table("organization", {
  id: varchar("id", { length: 30 }).notNull().unique().$defaultFn(() => createId()),
  name: text("name").notNull(),
  slug: text("slug").notNull(),
  logoUrl: text("logoUrl"),
  metadata: json("metadata"),
  createdBy: bigint("createdBy", { mode: "number" }).notNull(),
  createdAt: timestamp("createdAt").notNull().defaultNow(),
  updatedAt: timestamp("updatedAt").notNull().defaultNow(),
  deletedAt: timestamp("deletedAt"),
  _internalId: bigserial("_internalId", { mode: "number" }).primaryKey().notNull(),
  _version: integer("_version").notNull().default(0)
}, (table) => [
  foreignKey({
    columns: [table.createdBy],
    foreignColumns: [user_auth._internalId],
    name: "fk_organization_user_organizationCreator"
  }),
  uniqueIndex("idx_organization_slug").on(table.slug),
  index("idx_organization_createdBy").on(table.createdBy)
])

export const organizationMember_auth = schema_auth.table("organizationMember", {
  id: varchar("id", { length: 30 }).notNull().unique().$defaultFn(() => createId()),
  organizationId: bigint("organizationId", { mode: "number" }).notNull(),
  userId: bigint("userId", { mode: "number" }).notNull(),
  createdAt: timestamp("createdAt").notNull().defaultNow(),
  updatedAt: timestamp("updatedAt").notNull().defaultNow(),
  _internalId: bigserial("_internalId", { mode: "number" }).primaryKey().notNull(),
  _version: integer("_version").notNull().default(0)
}, (table) => [
  foreignKey({
    columns: [table.organizationId],
    foreignColumns: [organization_auth._internalId],
    name: "fk_organizationMember_organization_organizationMemberOrb0ebc659"
  }),
  foreignKey({
    columns: [table.userId],
    foreignColumns: [user_auth._internalId],
    name: "fk_organizationMember_user_organizationMemberUser"
  }),
  uniqueIndex("idx_org_member_org_user").on(table.organizationId, table.userId),
  index("idx_org_member_user").on(table.userId),
  index("idx_org_member_org").on(table.organizationId)
])

export const organizationMemberRole_auth = schema_auth.table("organizationMemberRole", {
  id: varchar("id", { length: 30 }).notNull().unique().$defaultFn(() => createId()),
  memberId: bigint("memberId", { mode: "number" }).notNull(),
  role: text("role").notNull(),
  createdAt: timestamp("createdAt").notNull().defaultNow(),
  _internalId: bigserial("_internalId", { mode: "number" }).primaryKey().notNull(),
  _version: integer("_version").notNull().default(0)
}, (table) => [
  foreignKey({
    columns: [table.memberId],
    foreignColumns: [organizationMember_auth._internalId],
    name: "fk_organizationMemberRole_organizationMember_organizati1834c67a"
  }),
  uniqueIndex("idx_org_member_role_member_role").on(table.memberId, table.role),
  index("idx_org_member_role_member").on(table.memberId),
  index("idx_org_member_role_role").on(table.role)
])

export const organizationInvitation_auth = schema_auth.table("organizationInvitation", {
  id: varchar("id", { length: 30 }).notNull().unique().$defaultFn(() => createId()),
  organizationId: bigint("organizationId", { mode: "number" }).notNull(),
  email: text("email").notNull(),
  roles: json("roles").notNull(),
  status: text("status").notNull(),
  token: text("token").notNull(),
  inviterId: bigint("inviterId", { mode: "number" }).notNull(),
  expiresAt: timestamp("expiresAt").notNull(),
  createdAt: timestamp("createdAt").notNull().defaultNow(),
  respondedAt: timestamp("respondedAt"),
  _internalId: bigserial("_internalId", { mode: "number" }).primaryKey().notNull(),
  _version: integer("_version").notNull().default(0)
}, (table) => [
  foreignKey({
    columns: [table.organizationId],
    foreignColumns: [organization_auth._internalId],
    name: "fk_organizationInvitation_organization_organizationInvi7f8b4d7d"
  }),
  foreignKey({
    columns: [table.inviterId],
    foreignColumns: [user_auth._internalId],
    name: "fk_organizationInvitation_user_organizationInvitationInviter"
  }),
  uniqueIndex("idx_org_invitation_token").on(table.token),
  index("idx_org_invitation_org_status").on(table.organizationId, table.status),
  index("idx_org_invitation_email").on(table.email),
  index("idx_org_invitation_email_status").on(table.email, table.status)
])

export const user_authRelations = relations(user_auth, ({ many }) => ({
  sessionList: many(session_auth, {
    relationName: "session_user"
  }),
  organizationList: many(organization_auth, {
    relationName: "organization_user"
  }),
  organizationMemberList: many(organizationMember_auth, {
    relationName: "organizationMember_user"
  }),
  organizationInvitationList: many(organizationInvitation_auth, {
    relationName: "organizationInvitation_user"
  })
}));

export const session_authRelations = relations(session_auth, ({ one }) => ({
  sessionOwner: one(user_auth, {
    relationName: "session_user",
    fields: [session_auth.userId],
    references: [user_auth._internalId]
  }),
  sessionActiveOrganization: one(organization_auth, {
    relationName: "session_organization",
    fields: [session_auth.activeOrganizationId],
    references: [organization_auth._internalId]
  })
}));

export const organization_authRelations = relations(organization_auth, ({ one, many }) => ({
  organizationCreator: one(user_auth, {
    relationName: "organization_user",
    fields: [organization_auth.createdBy],
    references: [user_auth._internalId]
  }),
  sessionList: many(session_auth, {
    relationName: "session_organization"
  }),
  organizationMemberList: many(organizationMember_auth, {
    relationName: "organizationMember_organization"
  }),
  organizationInvitationList: many(organizationInvitation_auth, {
    relationName: "organizationInvitation_organization"
  })
}));

export const organizationMember_authRelations = relations(organizationMember_auth, ({ one, many }) => ({
  organizationMemberOrganization: one(organization_auth, {
    relationName: "organizationMember_organization",
    fields: [organizationMember_auth.organizationId],
    references: [organization_auth._internalId]
  }),
  organizationMemberUser: one(user_auth, {
    relationName: "organizationMember_user",
    fields: [organizationMember_auth.userId],
    references: [user_auth._internalId]
  }),
  organizationMemberRoleList: many(organizationMemberRole_auth, {
    relationName: "organizationMemberRole_organizationMember"
  })
}));

export const organizationMemberRole_authRelations = relations(organizationMemberRole_auth, ({ one }) => ({
  organizationMemberRoleMember: one(organizationMember_auth, {
    relationName: "organizationMemberRole_organizationMember",
    fields: [organizationMemberRole_auth.memberId],
    references: [organizationMember_auth._internalId]
  })
}));

export const organizationInvitation_authRelations = relations(organizationInvitation_auth, ({ one }) => ({
  organizationInvitationOrganization: one(organization_auth, {
    relationName: "organizationInvitation_organization",
    fields: [organizationInvitation_auth.organizationId],
    references: [organization_auth._internalId]
  }),
  organizationInvitationInviter: one(user_auth, {
    relationName: "organizationInvitation_user",
    fields: [organizationInvitation_auth.inviterId],
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
  organization_auth: organization_auth,
  organization_authRelations: organization_authRelations,
  organization: organization_auth,
  organizationRelations: organization_authRelations,
  organizationMember_auth: organizationMember_auth,
  organizationMember_authRelations: organizationMember_authRelations,
  organizationMember: organizationMember_auth,
  organizationMemberRelations: organizationMember_authRelations,
  organizationMemberRole_auth: organizationMemberRole_auth,
  organizationMemberRole_authRelations: organizationMemberRole_authRelations,
  organizationMemberRole: organizationMemberRole_auth,
  organizationMemberRoleRelations: organizationMemberRole_authRelations,
  organizationInvitation_auth: organizationInvitation_auth,
  organizationInvitation_authRelations: organizationInvitation_authRelations,
  organizationInvitation: organizationInvitation_auth,
  organizationInvitationRelations: organizationInvitation_authRelations,
  schemaVersion: 16
}

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
// Fragment: workflows
// ============================================================================

const schema_workflows = pgSchema("workflows");

export const workflow_instance_workflows = schema_workflows.table("workflow_instance", {
  id: varchar("id", { length: 30 }).notNull().unique().$defaultFn(() => createId()),
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
  _version: integer("_version").notNull().default(0)
}, (table) => [
  uniqueIndex("idx_workflow_instance_workflowName_id").on(table.workflowName, table.id),
  index("idx_workflow_instance_workflowName_status_updatedAt").on(table.workflowName, table.status, table.updatedAt)
])

export const workflow_step_workflows = schema_workflows.table("workflow_step", {
  id: varchar("id", { length: 30 }).notNull().unique().$defaultFn(() => createId()),
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
  _version: integer("_version").notNull().default(0)
}, (table) => [
  foreignKey({
    columns: [table.instanceRef],
    foreignColumns: [workflow_instance_workflows._internalId],
    name: "fk_workflow_step_workflow_instance_stepInstance"
  }),
  uniqueIndex("idx_workflow_step_instanceRef_runNumber_stepKey").on(table.instanceRef, table.runNumber, table.stepKey),
  index("idx_workflow_step_instanceRef_runNumber_createdAt").on(table.instanceRef, table.runNumber, table.createdAt),
  index("idx_workflow_step_instanceRef_status_wakeAt").on(table.instanceRef, table.status, table.wakeAt)
])

export const workflow_event_workflows = schema_workflows.table("workflow_event", {
  id: varchar("id", { length: 30 }).notNull().unique().$defaultFn(() => createId()),
  instanceRef: bigint("instanceRef", { mode: "number" }).notNull(),
  runNumber: integer("runNumber").notNull(),
  actor: text("actor").notNull().default("user"),
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
  index("idx_workflow_event_instanceRef_runNumber_createdAt").on(table.instanceRef, table.runNumber, table.createdAt)
])

export const workflow_instance_workflowsRelations = relations(workflow_instance_workflows, ({ many }) => ({
  workflow_stepList: many(workflow_step_workflows, {
    relationName: "workflow_step_workflow_instance"
  }),
  workflow_eventList: many(workflow_event_workflows, {
    relationName: "workflow_event_workflow_instance"
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
  schemaVersion: 5
}