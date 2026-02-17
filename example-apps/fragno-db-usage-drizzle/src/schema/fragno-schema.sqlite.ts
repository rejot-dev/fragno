import { sqliteTable, text, integer, uniqueIndex, index, foreignKey } from "drizzle-orm/sqlite-core"
import { createId } from "@fragno-dev/db/id"
import { relations } from "drizzle-orm"

// ============================================================================
// Fragment: (none)
// ============================================================================

export const fragno_db_settings = sqliteTable("fragno_db_settings", {
  id: text("id").notNull().unique().$defaultFn(() => createId()),
  key: text("key").notNull(),
  value: text("value").notNull(),
  _internalId: integer("_internalId").primaryKey({ autoIncrement: true }).notNull(),
  _version: integer("_version").notNull().default(0)
}, (table) => [
  uniqueIndex("uidx_fragno_db_settings_unique_key_09269db3").on(table.key),
  uniqueIndex("uidx_fragno_db_settings_idx_fragno_db_settings_externalf7a8084e").on(table.id)
])

export const fragno_hooks = sqliteTable("fragno_hooks", {
  id: text("id").notNull().unique().$defaultFn(() => createId()),
  namespace: text("namespace").notNull(),
  hookName: text("hookName").notNull(),
  payload: text("payload", { mode: "json" }).notNull(),
  status: text("status").notNull(),
  attempts: integer("attempts").notNull().default(0),
  maxAttempts: integer("maxAttempts").notNull().default(5),
  lastAttemptAt: integer("lastAttemptAt", { mode: "timestamp" }),
  nextRetryAt: integer("nextRetryAt", { mode: "timestamp" }),
  error: text("error"),
  createdAt: integer("createdAt", { mode: "timestamp" }).notNull().defaultNow(),
  nonce: text("nonce").notNull(),
  _internalId: integer("_internalId").primaryKey({ autoIncrement: true }).notNull(),
  _version: integer("_version").notNull().default(0)
}, (table) => [
  index("idx_fragno_hooks_idx_namespace_status_retry_b66b1168").on(table.namespace, table.status, table.nextRetryAt),
  index("idx_fragno_hooks_idx_nonce_90c97cf1").on(table.nonce),
  uniqueIndex("uidx_fragno_hooks_idx_fragno_hooks_external_id_d04b86f6").on(table.id)
])

export const fragno_db_outbox = sqliteTable("fragno_db_outbox", {
  id: text("id").notNull().unique().$defaultFn(() => createId()),
  versionstamp: text("versionstamp").notNull(),
  uowId: text("uowId").notNull(),
  payload: text("payload", { mode: "json" }).notNull(),
  refMap: text("refMap", { mode: "json" }),
  createdAt: integer("createdAt", { mode: "timestamp" }).notNull().defaultNow(),
  _internalId: integer("_internalId").primaryKey({ autoIncrement: true }).notNull(),
  _version: integer("_version").notNull().default(0)
}, (table) => [
  uniqueIndex("uidx_fragno_db_outbox_idx_outbox_versionstamp_37972a68").on(table.versionstamp),
  index("idx_fragno_db_outbox_idx_outbox_uow_733c7f90").on(table.uowId),
  uniqueIndex("uidx_fragno_db_outbox_idx_fragno_db_outbox_external_id_7462d1e7").on(table.id)
])

export const fragno_db_outbox_mutations = sqliteTable("fragno_db_outbox_mutations", {
  id: text("id").notNull().unique().$defaultFn(() => createId()),
  entryVersionstamp: text("entryVersionstamp").notNull(),
  mutationVersionstamp: text("mutationVersionstamp").notNull(),
  uowId: text("uowId").notNull(),
  schema: text("schema").notNull(),
  table: text("table").notNull(),
  externalId: text("externalId").notNull(),
  op: text("op").notNull(),
  createdAt: integer("createdAt", { mode: "timestamp" }).notNull().defaultNow(),
  _internalId: integer("_internalId").primaryKey({ autoIncrement: true }).notNull(),
  _version: integer("_version").notNull().default(0)
}, (table) => [
  index("idx_fragno_db_outbox_mutations_idx_outbox_mutations_entf896150d").on(table.entryVersionstamp),
  index("idx_fragno_db_outbox_mutations_idx_outbox_mutations_key16922fb2").on(table.schema, table.table, table.externalId, table.entryVersionstamp),
  index("idx_fragno_db_outbox_mutations_idx_outbox_mutations_uowa7a0749c").on(table.uowId),
  uniqueIndex("uidx_fragno_db_outbox_mutations_idx_fragno_db_outbox_mu54df4b80").on(table.id)
])

export const fragno_db_sync_requests = sqliteTable("fragno_db_sync_requests", {
  id: text("id").notNull().unique().$defaultFn(() => createId()),
  requestId: text("requestId").notNull(),
  status: text("status").notNull(),
  confirmedCommandIds: text("confirmedCommandIds", { mode: "json" }).notNull(),
  conflictCommandId: text("conflictCommandId"),
  baseVersionstamp: text("baseVersionstamp"),
  lastVersionstamp: text("lastVersionstamp"),
  createdAt: integer("createdAt", { mode: "timestamp" }).notNull().defaultNow(),
  _internalId: integer("_internalId").primaryKey({ autoIncrement: true }).notNull(),
  _version: integer("_version").notNull().default(0)
}, (table) => [
  uniqueIndex("uidx_fragno_db_sync_requests_idx_sync_request_id_a352b2bb").on(table.requestId),
  uniqueIndex("uidx_fragno_db_sync_requests_idx_fragno_db_sync_requeste905fedf").on(table.id)
])

// ============================================================================
// Fragment: auth
// ============================================================================

export const user_auth = sqliteTable("user_auth", {
  id: text("id").notNull().unique().$defaultFn(() => createId()),
  email: text("email").notNull(),
  passwordHash: text("passwordHash").notNull(),
  role: text("role").notNull().default("user"),
  createdAt: integer("createdAt", { mode: "timestamp" }).notNull().defaultNow(),
  _internalId: integer("_internalId").primaryKey({ autoIncrement: true }).notNull(),
  _version: integer("_version").notNull().default(0),
  bannedAt: integer("bannedAt", { mode: "timestamp" })
}, (table) => [
  index("idx_user_idx_user_email_auth_47062eb8").on(table.email),
  uniqueIndex("uidx_user_idx_user_id_auth_1370c3c6").on(table.id),
  index("idx_user_idx_user_createdAt_auth_3290a418").on(table.createdAt),
  uniqueIndex("uidx_user_idx_user_external_id_auth_8fbfd81b").on(table.id)
])

export const session_auth = sqliteTable("session_auth", {
  id: text("id").notNull().unique().$defaultFn(() => createId()),
  userId: integer("userId").notNull(),
  expiresAt: integer("expiresAt", { mode: "timestamp" }).notNull(),
  createdAt: integer("createdAt", { mode: "timestamp" }).notNull().defaultNow(),
  _internalId: integer("_internalId").primaryKey({ autoIncrement: true }).notNull(),
  _version: integer("_version").notNull().default(0),
  activeOrganizationId: integer("activeOrganizationId")
}, (table) => [
  foreignKey({
    columns: [table.userId],
    foreignColumns: [user_auth._internalId],
    name: "fk_session_user_sessionOwner_auth_7854da47"
  }),
  foreignKey({
    columns: [table.activeOrganizationId],
    foreignColumns: [organization_auth._internalId],
    name: "fk_session_organization_sessionActiveOrganization_auth_c1d88689"
  }),
  index("idx_session_idx_session_user_auth_0748231c").on(table.userId),
  uniqueIndex("uidx_session_idx_session_external_id_auth_79bf465d").on(table.id)
])

export const organization_auth = sqliteTable("organization_auth", {
  id: text("id").notNull().unique().$defaultFn(() => createId()),
  name: text("name").notNull(),
  slug: text("slug").notNull(),
  logoUrl: text("logoUrl"),
  metadata: text("metadata", { mode: "json" }),
  createdBy: integer("createdBy").notNull(),
  createdAt: integer("createdAt", { mode: "timestamp" }).notNull().defaultNow(),
  updatedAt: integer("updatedAt", { mode: "timestamp" }).notNull().defaultNow(),
  deletedAt: integer("deletedAt", { mode: "timestamp" }),
  _internalId: integer("_internalId").primaryKey({ autoIncrement: true }).notNull(),
  _version: integer("_version").notNull().default(0)
}, (table) => [
  foreignKey({
    columns: [table.createdBy],
    foreignColumns: [user_auth._internalId],
    name: "fk_organization_user_organizationCreator_auth_c99fc140"
  }),
  uniqueIndex("uidx_organization_idx_organization_slug_auth_9b82968a").on(table.slug),
  index("idx_organization_idx_organization_createdBy_auth_e893279c").on(table.createdBy),
  uniqueIndex("uidx_organization_idx_organization_external_id_auth_362f7c8c").on(table.id)
])

export const organizationMember_auth = sqliteTable("organizationMember_auth", {
  id: text("id").notNull().unique().$defaultFn(() => createId()),
  organizationId: integer("organizationId").notNull(),
  userId: integer("userId").notNull(),
  createdAt: integer("createdAt", { mode: "timestamp" }).notNull().defaultNow(),
  updatedAt: integer("updatedAt", { mode: "timestamp" }).notNull().defaultNow(),
  _internalId: integer("_internalId").primaryKey({ autoIncrement: true }).notNull(),
  _version: integer("_version").notNull().default(0)
}, (table) => [
  foreignKey({
    columns: [table.organizationId],
    foreignColumns: [organization_auth._internalId],
    name: "fk_organizationMember_organization_organizationMemberOr038a36fb"
  }),
  foreignKey({
    columns: [table.userId],
    foreignColumns: [user_auth._internalId],
    name: "fk_organizationMember_user_organizationMemberUser_auth_a00a7460"
  }),
  uniqueIndex("uidx_organizationMember_idx_org_member_org_user_auth_abbf915f").on(table.organizationId, table.userId),
  index("idx_organizationMember_idx_org_member_user_auth_1cd12c0f").on(table.userId),
  index("idx_organizationMember_idx_org_member_org_auth_42b9e50d").on(table.organizationId),
  uniqueIndex("uidx_organizationMember_idx_organizationMember_external4c1e7db6").on(table.id)
])

export const organizationMemberRole_auth = sqliteTable("organizationMemberRole_auth", {
  id: text("id").notNull().unique().$defaultFn(() => createId()),
  memberId: integer("memberId").notNull(),
  role: text("role").notNull(),
  createdAt: integer("createdAt", { mode: "timestamp" }).notNull().defaultNow(),
  _internalId: integer("_internalId").primaryKey({ autoIncrement: true }).notNull(),
  _version: integer("_version").notNull().default(0)
}, (table) => [
  foreignKey({
    columns: [table.memberId],
    foreignColumns: [organizationMember_auth._internalId],
    name: "fk_organizationMemberRole_organizationMember_organizati5029ddce"
  }),
  uniqueIndex("uidx_organizationMemberRole_idx_org_member_role_member_e45d22f1").on(table.memberId, table.role),
  index("idx_organizationMemberRole_idx_org_member_role_member_a2a65acd6").on(table.memberId),
  index("idx_organizationMemberRole_idx_org_member_role_role_autd88fe146").on(table.role),
  uniqueIndex("uidx_organizationMemberRole_idx_organizationMemberRole_08ff774f").on(table.id)
])

export const organizationInvitation_auth = sqliteTable("organizationInvitation_auth", {
  id: text("id").notNull().unique().$defaultFn(() => createId()),
  organizationId: integer("organizationId").notNull(),
  email: text("email").notNull(),
  roles: text("roles", { mode: "json" }).notNull(),
  status: text("status").notNull(),
  token: text("token").notNull(),
  inviterId: integer("inviterId").notNull(),
  expiresAt: integer("expiresAt", { mode: "timestamp" }).notNull(),
  createdAt: integer("createdAt", { mode: "timestamp" }).notNull().defaultNow(),
  respondedAt: integer("respondedAt", { mode: "timestamp" }),
  _internalId: integer("_internalId").primaryKey({ autoIncrement: true }).notNull(),
  _version: integer("_version").notNull().default(0)
}, (table) => [
  foreignKey({
    columns: [table.organizationId],
    foreignColumns: [organization_auth._internalId],
    name: "fk_organizationInvitation_organization_organizationInvida3865a6"
  }),
  foreignKey({
    columns: [table.inviterId],
    foreignColumns: [user_auth._internalId],
    name: "fk_organizationInvitation_user_organizationInvitationIn47cda46d"
  }),
  uniqueIndex("uidx_organizationInvitation_idx_org_invitation_token_au93b35818").on(table.token),
  index("idx_organizationInvitation_idx_org_invitation_org_statu68f8a9be").on(table.organizationId, table.status),
  index("idx_organizationInvitation_idx_org_invitation_email_autbd56612d").on(table.email),
  index("idx_organizationInvitation_idx_org_invitation_email_sta22e04868").on(table.email, table.status),
  uniqueIndex("uidx_organizationInvitation_idx_organizationInvitation_df000ec5").on(table.id)
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

export const comment_comment = sqliteTable("comment_comment", {
  id: text("id").notNull().unique().$defaultFn(() => createId()),
  title: text("title").notNull(),
  content: text("content").notNull(),
  createdAt: integer("createdAt", { mode: "timestamp" }).notNull().defaultNow(),
  postReference: text("postReference").notNull(),
  userReference: text("userReference").notNull(),
  parentId: integer("parentId"),
  _internalId: integer("_internalId").primaryKey({ autoIncrement: true }).notNull(),
  _version: integer("_version").notNull().default(0),
  rating: integer("rating").notNull().default(0)
}, (table) => [
  foreignKey({
    columns: [table.parentId],
    foreignColumns: [table._internalId],
    name: "fk_comment_comment_parent_comment_e6560345"
  }),
  index("idx_comment_idx_comment_post_comment_c75acad5").on(table.postReference),
  uniqueIndex("uidx_comment_idx_comment_external_id_comment_1579b6d0").on(table.id)
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

export const upvote_upvote = sqliteTable("upvote_upvote", {
  id: text("id").notNull().unique().$defaultFn(() => createId()),
  reference: text("reference").notNull(),
  ownerReference: text("ownerReference"),
  rating: integer("rating").notNull(),
  createdAt: integer("createdAt", { mode: "timestamp" }).notNull().defaultNow(),
  note: text("note"),
  _internalId: integer("_internalId").primaryKey({ autoIncrement: true }).notNull(),
  _version: integer("_version").notNull().default(0)
}, (table) => [
  index("idx_upvote_idx_upvote_reference_upvote_94fd688f").on(table.reference, table.ownerReference),
  uniqueIndex("uidx_upvote_idx_upvote_external_id_upvote_d0c89cc9").on(table.id)
])

export const upvote_total_upvote = sqliteTable("upvote_total_upvote", {
  id: text("id").notNull().unique().$defaultFn(() => createId()),
  reference: text("reference").notNull(),
  total: integer("total").notNull().default(0),
  _internalId: integer("_internalId").primaryKey({ autoIncrement: true }).notNull(),
  _version: integer("_version").notNull().default(0)
}, (table) => [
  uniqueIndex("uidx_upvote_total_idx_upvote_total_reference_upvote_b702eb9a").on(table.reference),
  uniqueIndex("uidx_upvote_total_idx_upvote_total_external_id_upvote_2b3ef1a0").on(table.id)
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

export const workflow_instance_workflows = sqliteTable("workflow_instance_workflows", {
  id: text("id").notNull().unique().$defaultFn(() => createId()),
  instanceId: text("instanceId").notNull(),
  workflowName: text("workflowName").notNull(),
  status: text("status").notNull(),
  createdAt: integer("createdAt", { mode: "timestamp" }).notNull().defaultNow(),
  updatedAt: integer("updatedAt", { mode: "timestamp" }).notNull().defaultNow(),
  startedAt: integer("startedAt", { mode: "timestamp" }),
  completedAt: integer("completedAt", { mode: "timestamp" }),
  params: text("params", { mode: "json" }).notNull(),
  output: text("output", { mode: "json" }),
  errorName: text("errorName"),
  errorMessage: text("errorMessage"),
  pauseRequested: integer("pauseRequested", { mode: "boolean" }).notNull().default(false),
  retentionUntil: integer("retentionUntil", { mode: "timestamp" }),
  runNumber: integer("runNumber").notNull().default(0),
  _internalId: integer("_internalId").primaryKey({ autoIncrement: true }).notNull(),
  _version: integer("_version").notNull().default(0)
}, (table) => [
  uniqueIndex("uidx_workflow_instance_idx_workflow_instance_workflowNa12b3a436").on(table.workflowName, table.instanceId),
  index("idx_workflow_instance_idx_workflow_instance_status_upda83267b95").on(table.workflowName, table.status, table.updatedAt),
  uniqueIndex("uidx_workflow_instance_idx_workflow_instance_external_i88920a7e").on(table.id)
])

export const workflow_step_workflows = sqliteTable("workflow_step_workflows", {
  id: text("id").notNull().unique().$defaultFn(() => createId()),
  instanceRef: integer("instanceRef").notNull(),
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
  nextRetryAt: integer("nextRetryAt", { mode: "timestamp" }),
  wakeAt: integer("wakeAt", { mode: "timestamp" }),
  waitEventType: text("waitEventType"),
  result: text("result", { mode: "json" }),
  errorName: text("errorName"),
  errorMessage: text("errorMessage"),
  createdAt: integer("createdAt", { mode: "timestamp" }).notNull().defaultNow(),
  updatedAt: integer("updatedAt", { mode: "timestamp" }).notNull().defaultNow(),
  _internalId: integer("_internalId").primaryKey({ autoIncrement: true }).notNull(),
  _version: integer("_version").notNull().default(0)
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
  index("idx_workflow_step_idx_workflow_step_status_nextRetryAt_d5657dc4").on(table.status, table.nextRetryAt),
  uniqueIndex("uidx_workflow_step_idx_workflow_step_external_id_workfl2105beea").on(table.id)
])

export const workflow_event_workflows = sqliteTable("workflow_event_workflows", {
  id: text("id").notNull().unique().$defaultFn(() => createId()),
  instanceRef: integer("instanceRef").notNull(),
  workflowName: text("workflowName").notNull(),
  instanceId: text("instanceId").notNull(),
  runNumber: integer("runNumber").notNull(),
  type: text("type").notNull(),
  payload: text("payload", { mode: "json" }),
  createdAt: integer("createdAt", { mode: "timestamp" }).notNull().defaultNow(),
  deliveredAt: integer("deliveredAt", { mode: "timestamp" }),
  consumedByStepKey: text("consumedByStepKey"),
  _internalId: integer("_internalId").primaryKey({ autoIncrement: true }).notNull(),
  _version: integer("_version").notNull().default(0)
}, (table) => [
  foreignKey({
    columns: [table.instanceRef],
    foreignColumns: [workflow_instance_workflows._internalId],
    name: "fk_workflow_event_workflow_instance_eventInstance_workf9b5621c6"
  }),
  index("idx_workflow_event_idx_workflow_event_type_deliveredAt_704adbee").on(table.workflowName, table.instanceId, table.runNumber, table.type, table.deliveredAt),
  index("idx_workflow_event_idx_workflow_event_instanceRef_runNu9d715b8f").on(table.instanceRef, table.runNumber, table.createdAt),
  index("idx_workflow_event_idx_workflow_event_history_createdAt62c7042e").on(table.workflowName, table.instanceId, table.runNumber, table.createdAt),
  uniqueIndex("uidx_workflow_event_idx_workflow_event_external_id_workd61ca377").on(table.id)
])

export const workflow_task_workflows = sqliteTable("workflow_task_workflows", {
  id: text("id").notNull().unique().$defaultFn(() => createId()),
  instanceRef: integer("instanceRef").notNull(),
  workflowName: text("workflowName").notNull(),
  instanceId: text("instanceId").notNull(),
  runNumber: integer("runNumber").notNull(),
  kind: text("kind").notNull(),
  runAt: integer("runAt", { mode: "timestamp" }).notNull(),
  status: text("status").notNull(),
  attempts: integer("attempts").notNull().default(0),
  maxAttempts: integer("maxAttempts").notNull(),
  lastError: text("lastError"),
  lockedUntil: integer("lockedUntil", { mode: "timestamp" }),
  lockOwner: text("lockOwner"),
  createdAt: integer("createdAt", { mode: "timestamp" }).notNull().defaultNow(),
  updatedAt: integer("updatedAt", { mode: "timestamp" }).notNull().defaultNow(),
  _internalId: integer("_internalId").primaryKey({ autoIncrement: true }).notNull(),
  _version: integer("_version").notNull().default(0)
}, (table) => [
  foreignKey({
    columns: [table.instanceRef],
    foreignColumns: [workflow_instance_workflows._internalId],
    name: "fk_workflow_task_workflow_instance_taskInstance_workfloc70ca854"
  }),
  index("idx_workflow_task_idx_workflow_task_status_runAt_workfl9555454f").on(table.status, table.runAt),
  index("idx_workflow_task_idx_workflow_task_status_lockedUntil_d7c21c4e").on(table.status, table.lockedUntil),
  uniqueIndex("uidx_workflow_task_idx_workflow_task_workflowName_instad0a3dfbc").on(table.workflowName, table.instanceId, table.runNumber),
  uniqueIndex("uidx_workflow_task_idx_workflow_task_external_id_workfl38de22c2").on(table.id)
])

export const workflow_log_workflows = sqliteTable("workflow_log_workflows", {
  id: text("id").notNull().unique().$defaultFn(() => createId()),
  instanceRef: integer("instanceRef").notNull(),
  workflowName: text("workflowName").notNull(),
  instanceId: text("instanceId").notNull(),
  runNumber: integer("runNumber").notNull(),
  stepKey: text("stepKey"),
  attempt: integer("attempt"),
  level: text("level").notNull(),
  category: text("category").notNull(),
  message: text("message").notNull(),
  data: text("data", { mode: "json" }),
  createdAt: integer("createdAt", { mode: "timestamp" }).notNull().defaultNow(),
  _internalId: integer("_internalId").primaryKey({ autoIncrement: true }).notNull(),
  _version: integer("_version").notNull().default(0)
}, (table) => [
  foreignKey({
    columns: [table.instanceRef],
    foreignColumns: [workflow_instance_workflows._internalId],
    name: "fk_workflow_log_workflow_instance_logInstance_workflowsb79df5f6"
  }),
  index("idx_workflow_log_idx_workflow_log_history_createdAt_woracbe60e0").on(table.workflowName, table.instanceId, table.runNumber, table.createdAt),
  index("idx_workflow_log_idx_workflow_log_level_createdAt_workf5249eadc").on(table.workflowName, table.instanceId, table.runNumber, table.level, table.createdAt),
  index("idx_workflow_log_idx_workflow_log_category_createdAt_wo557f68d7").on(table.workflowName, table.instanceId, table.runNumber, table.category, table.createdAt),
  index("idx_workflow_log_idx_workflow_log_instanceRef_runNumber7006b0b7").on(table.instanceRef, table.runNumber, table.createdAt),
  uniqueIndex("uidx_workflow_log_idx_workflow_log_external_id_workflow4fb96252").on(table.id)
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