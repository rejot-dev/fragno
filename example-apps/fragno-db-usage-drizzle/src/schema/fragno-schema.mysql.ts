import { mysqlTable, varchar, text, bigint, int, uniqueIndex, index, json, datetime, foreignKey } from "drizzle-orm/mysql-core"
import { createId } from "@fragno-dev/db/id"
import { sql, relations } from "drizzle-orm"

// ============================================================================
// Fragment: (none)
// ============================================================================

export const fragno_db_settings = mysqlTable("fragno_db_settings", {
  id: varchar("id", { length: 128 }).notNull().unique().$defaultFn(() => createId()),
  key: text("key").notNull(),
  value: text("value").notNull(),
  _internalId: bigint("_internalId", { mode: "number" }).primaryKey().autoincrement().notNull(),
  _version: int("_version").notNull().default(0),
  _shard: varchar("_shard", { length: 128 }).notNull().default("__fragno_global__")
}, (table) => [
  uniqueIndex("uidx_fragno_db_settings_unique_key_09269db3").on(table.key),
  index("idx_fragno_db_settings_idx_fragno_db_settings_shard_371d1d84").on(table._shard)
])

export const fragno_hooks = mysqlTable("fragno_hooks", {
  id: varchar("id", { length: 128 }).notNull().unique().$defaultFn(() => createId()),
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
  _shard: varchar("_shard", { length: 128 }).notNull().default("__fragno_global__"),
  _internalId: bigint("_internalId", { mode: "number" }).primaryKey().autoincrement().notNull(),
  _version: int("_version").notNull().default(0)
}, (table) => [
  index("idx_fragno_hooks_idx_namespace_status_retry_b66b1168").on(table.namespace, table.status, table.nextRetryAt),
  index("idx_fragno_hooks_idx_hooks_shard_status_retry_1c3479a0").on(table._shard, table.status, table.nextRetryAt),
  index("idx_fragno_hooks_idx_nonce_90c97cf1").on(table.nonce),
  index("idx_fragno_hooks_idx_fragno_hooks_shard_bbecb878").on(table._shard),
  index("idx_fragno_hooks_idx_namespace_status_last_attempt_f6aacab3").on(table.namespace, table.status, table.lastAttemptAt)
])

export const fragno_db_outbox = mysqlTable("fragno_db_outbox", {
  id: varchar("id", { length: 128 }).notNull().unique().$defaultFn(() => createId()),
  versionstamp: text("versionstamp").notNull(),
  uowId: text("uowId").notNull(),
  payload: json("payload").notNull(),
  refMap: json("refMap"),
  createdAt: datetime("createdAt").notNull().default(sql`(now())`),
  _shard: varchar("_shard", { length: 128 }).notNull().default("__fragno_global__"),
  _internalId: bigint("_internalId", { mode: "number" }).primaryKey().autoincrement().notNull(),
  _version: int("_version").notNull().default(0)
}, (table) => [
  uniqueIndex("uidx_fragno_db_outbox_idx_outbox_versionstamp_37972a68").on(table.versionstamp),
  index("idx_fragno_db_outbox_idx_outbox_shard_versionstamp_37351b94").on(table._shard, table.versionstamp),
  index("idx_fragno_db_outbox_idx_outbox_uow_733c7f90").on(table.uowId),
  index("idx_fragno_db_outbox_idx_fragno_db_outbox_shard_34a60945").on(table._shard)
])

export const fragno_db_outbox_mutations = mysqlTable("fragno_db_outbox_mutations", {
  id: varchar("id", { length: 128 }).notNull().unique().$defaultFn(() => createId()),
  entryVersionstamp: text("entryVersionstamp").notNull(),
  mutationVersionstamp: text("mutationVersionstamp").notNull(),
  uowId: text("uowId").notNull(),
  schema: text("schema").notNull(),
  table: text("table").notNull(),
  externalId: text("externalId").notNull(),
  op: text("op").notNull(),
  createdAt: datetime("createdAt").notNull().default(sql`(now())`),
  _shard: varchar("_shard", { length: 128 }).notNull().default("__fragno_global__"),
  _internalId: bigint("_internalId", { mode: "number" }).primaryKey().autoincrement().notNull(),
  _version: int("_version").notNull().default(0)
}, (table) => [
  index("idx_fragno_db_outbox_mutations_idx_outbox_mutations_entf896150d").on(table.entryVersionstamp),
  index("idx_fragno_db_outbox_mutations_idx_outbox_mutations_sha907bae61").on(table._shard, table.entryVersionstamp),
  index("idx_fragno_db_outbox_mutations_idx_outbox_mutations_key16922fb2").on(table.schema, table.table, table.externalId, table.entryVersionstamp),
  index("idx_fragno_db_outbox_mutations_idx_outbox_mutations_uowa7a0749c").on(table.uowId),
  index("idx_fragno_db_outbox_mutations_idx_fragno_db_outbox_mut00539742").on(table._shard)
])

export const fragno_db_sync_requests = mysqlTable("fragno_db_sync_requests", {
  id: varchar("id", { length: 128 }).notNull().unique().$defaultFn(() => createId()),
  requestId: text("requestId").notNull(),
  status: text("status").notNull(),
  confirmedCommandIds: json("confirmedCommandIds").notNull(),
  conflictCommandId: text("conflictCommandId"),
  baseVersionstamp: text("baseVersionstamp"),
  lastVersionstamp: text("lastVersionstamp"),
  createdAt: datetime("createdAt").notNull().default(sql`(now())`),
  _shard: varchar("_shard", { length: 128 }).notNull().default("__fragno_global__"),
  _internalId: bigint("_internalId", { mode: "number" }).primaryKey().autoincrement().notNull(),
  _version: int("_version").notNull().default(0)
}, (table) => [
  uniqueIndex("uidx_fragno_db_sync_requests_idx_sync_request_id_a352b2bb").on(table.requestId),
  index("idx_fragno_db_sync_requests_idx_sync_requests_shard_reqf51b10f2").on(table._shard, table.requestId),
  index("idx_fragno_db_sync_requests_idx_fragno_db_sync_requests0a0340ad").on(table._shard)
])

// ============================================================================
// Fragment: auth
// ============================================================================

export const user_auth = mysqlTable("user_auth", {
  id: varchar("id", { length: 128 }).notNull().unique().$defaultFn(() => createId()),
  email: text("email").notNull(),
  passwordHash: text("passwordHash").notNull(),
  role: text("role").notNull().default("user"),
  createdAt: datetime("createdAt").notNull().default(sql`(now())`),
  _internalId: bigint("_internalId", { mode: "number" }).primaryKey().autoincrement().notNull(),
  _version: int("_version").notNull().default(0),
  _shard: varchar("_shard", { length: 128 }).notNull().default("__fragno_global__"),
  bannedAt: datetime("bannedAt")
}, (table) => [
  index("idx_user_idx_user_email_auth_47062eb8").on(table.email),
  uniqueIndex("uidx_user_idx_user_id_auth_1370c3c6").on(table.id),
  index("idx_user_idx_user_shard_auth_8d9c7da6").on(table._shard),
  index("idx_user_idx_user_createdAt_auth_3290a418").on(table.createdAt)
])

export const session_auth = mysqlTable("session_auth", {
  id: varchar("id", { length: 128 }).notNull().unique().$defaultFn(() => createId()),
  userId: bigint("userId", { mode: "number" }).notNull(),
  expiresAt: datetime("expiresAt").notNull(),
  createdAt: datetime("createdAt").notNull().default(sql`(now())`),
  _internalId: bigint("_internalId", { mode: "number" }).primaryKey().autoincrement().notNull(),
  _version: int("_version").notNull().default(0),
  _shard: varchar("_shard", { length: 128 }).notNull().default("__fragno_global__"),
  activeOrganizationId: bigint("activeOrganizationId", { mode: "number" })
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
  index("idx_session_idx_session_shard_auth_99c8a8f6").on(table._shard)
])

export const organization_auth = mysqlTable("organization_auth", {
  id: varchar("id", { length: 128 }).notNull().unique().$defaultFn(() => createId()),
  name: text("name").notNull(),
  slug: text("slug").notNull(),
  logoUrl: text("logoUrl"),
  metadata: json("metadata"),
  createdBy: bigint("createdBy", { mode: "number" }).notNull(),
  createdAt: datetime("createdAt").notNull().default(sql`(now())`),
  updatedAt: datetime("updatedAt").notNull().default(sql`(now())`),
  deletedAt: datetime("deletedAt"),
  _internalId: bigint("_internalId", { mode: "number" }).primaryKey().autoincrement().notNull(),
  _version: int("_version").notNull().default(0),
  _shard: varchar("_shard", { length: 128 }).notNull().default("__fragno_global__")
}, (table) => [
  foreignKey({
    columns: [table.createdBy],
    foreignColumns: [user_auth._internalId],
    name: "fk_organization_user_organizationCreator_auth_c99fc140"
  }),
  uniqueIndex("uidx_organization_idx_organization_slug_auth_9b82968a").on(table.slug),
  index("idx_organization_idx_organization_createdBy_auth_e893279c").on(table.createdBy),
  index("idx_organization_idx_organization_shard_auth_fec76d75").on(table._shard)
])

export const organizationMember_auth = mysqlTable("organizationMember_auth", {
  id: varchar("id", { length: 128 }).notNull().unique().$defaultFn(() => createId()),
  organizationId: bigint("organizationId", { mode: "number" }).notNull(),
  userId: bigint("userId", { mode: "number" }).notNull(),
  createdAt: datetime("createdAt").notNull().default(sql`(now())`),
  updatedAt: datetime("updatedAt").notNull().default(sql`(now())`),
  _internalId: bigint("_internalId", { mode: "number" }).primaryKey().autoincrement().notNull(),
  _version: int("_version").notNull().default(0),
  _shard: varchar("_shard", { length: 128 }).notNull().default("__fragno_global__")
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
  index("idx_organizationMember_idx_organizationMember_shard_aut9c2fa48f").on(table._shard)
])

export const organizationMemberRole_auth = mysqlTable("organizationMemberRole_auth", {
  id: varchar("id", { length: 128 }).notNull().unique().$defaultFn(() => createId()),
  memberId: bigint("memberId", { mode: "number" }).notNull(),
  role: text("role").notNull(),
  createdAt: datetime("createdAt").notNull().default(sql`(now())`),
  _internalId: bigint("_internalId", { mode: "number" }).primaryKey().autoincrement().notNull(),
  _version: int("_version").notNull().default(0),
  _shard: varchar("_shard", { length: 128 }).notNull().default("__fragno_global__")
}, (table) => [
  foreignKey({
    columns: [table.memberId],
    foreignColumns: [organizationMember_auth._internalId],
    name: "fk_organizationMemberRole_organizationMember_organizati5029ddce"
  }),
  uniqueIndex("uidx_organizationMemberRole_idx_org_member_role_member_e45d22f1").on(table.memberId, table.role),
  index("idx_organizationMemberRole_idx_org_member_role_member_a2a65acd6").on(table.memberId),
  index("idx_organizationMemberRole_idx_org_member_role_role_autd88fe146").on(table.role),
  index("idx_organizationMemberRole_idx_organizationMemberRole_s4eb7df82").on(table._shard)
])

export const organizationInvitation_auth = mysqlTable("organizationInvitation_auth", {
  id: varchar("id", { length: 128 }).notNull().unique().$defaultFn(() => createId()),
  organizationId: bigint("organizationId", { mode: "number" }).notNull(),
  email: text("email").notNull(),
  roles: json("roles").notNull(),
  status: text("status").notNull(),
  token: text("token").notNull(),
  inviterId: bigint("inviterId", { mode: "number" }).notNull(),
  expiresAt: datetime("expiresAt").notNull(),
  createdAt: datetime("createdAt").notNull().default(sql`(now())`),
  respondedAt: datetime("respondedAt"),
  _internalId: bigint("_internalId", { mode: "number" }).primaryKey().autoincrement().notNull(),
  _version: int("_version").notNull().default(0),
  _shard: varchar("_shard", { length: 128 }).notNull().default("__fragno_global__")
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
  index("idx_organizationInvitation_idx_organizationInvitation_s1e904ac6").on(table._shard)
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

export const comment_comment = mysqlTable("comment_comment", {
  id: varchar("id", { length: 128 }).notNull().unique().$defaultFn(() => createId()),
  title: text("title").notNull(),
  content: text("content").notNull(),
  createdAt: datetime("createdAt").notNull().default(sql`(now())`),
  postReference: text("postReference").notNull(),
  userReference: text("userReference").notNull(),
  parentId: bigint("parentId", { mode: "number" }),
  _internalId: bigint("_internalId", { mode: "number" }).primaryKey().autoincrement().notNull(),
  _version: int("_version").notNull().default(0),
  _shard: varchar("_shard", { length: 128 }).notNull().default("__fragno_global__"),
  rating: int("rating").notNull().default(0)
}, (table) => [
  foreignKey({
    columns: [table.parentId],
    foreignColumns: [table._internalId],
    name: "fk_comment_comment_parent_comment_e6560345"
  }),
  index("idx_comment_idx_comment_post_comment_c75acad5").on(table.postReference),
  index("idx_comment_idx_comment_shard_comment_b03b6ce4").on(table._shard)
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
  id: varchar("id", { length: 128 }).notNull().unique().$defaultFn(() => createId()),
  reference: text("reference").notNull(),
  ownerReference: text("ownerReference"),
  rating: int("rating").notNull(),
  createdAt: datetime("createdAt").notNull().default(sql`(now())`),
  note: text("note"),
  _internalId: bigint("_internalId", { mode: "number" }).primaryKey().autoincrement().notNull(),
  _version: int("_version").notNull().default(0),
  _shard: varchar("_shard", { length: 128 }).notNull().default("__fragno_global__")
}, (table) => [
  index("idx_upvote_idx_upvote_reference_upvote_94fd688f").on(table.reference, table.ownerReference),
  index("idx_upvote_idx_upvote_shard_upvote_1a79a11f").on(table._shard)
])

export const upvote_total_upvote = mysqlTable("upvote_total_upvote", {
  id: varchar("id", { length: 128 }).notNull().unique().$defaultFn(() => createId()),
  reference: text("reference").notNull(),
  total: int("total").notNull().default(0),
  _internalId: bigint("_internalId", { mode: "number" }).primaryKey().autoincrement().notNull(),
  _version: int("_version").notNull().default(0),
  _shard: varchar("_shard", { length: 128 }).notNull().default("__fragno_global__")
}, (table) => [
  uniqueIndex("uidx_upvote_total_idx_upvote_total_reference_upvote_b702eb9a").on(table.reference),
  index("idx_upvote_total_idx_upvote_total_shard_upvote_2933f337").on(table._shard)
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
  id: varchar("id", { length: 128 }).notNull().unique().$defaultFn(() => createId()),
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
  runNumber: int("runNumber").notNull().default(0),
  _internalId: bigint("_internalId", { mode: "number" }).primaryKey().autoincrement().notNull(),
  _version: int("_version").notNull().default(0),
  _shard: varchar("_shard", { length: 128 }).notNull().default("__fragno_global__")
}, (table) => [
  uniqueIndex("uidx_workflow_instance_idx_workflow_instance_workflowNa203e01f5").on(table.workflowName, table.id),
  index("idx_workflow_instance_idx_workflow_instance_workflowNamdd6fe562").on(table.workflowName, table.status, table.updatedAt),
  index("idx_workflow_instance_idx_workflow_instance_shard_workf42bb60e9").on(table._shard)
])

export const workflow_step_workflows = mysqlTable("workflow_step_workflows", {
  id: varchar("id", { length: 128 }).notNull().unique().$defaultFn(() => createId()),
  instanceRef: bigint("instanceRef", { mode: "number" }).notNull(),
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
  _version: int("_version").notNull().default(0),
  _shard: varchar("_shard", { length: 128 }).notNull().default("__fragno_global__")
}, (table) => [
  foreignKey({
    columns: [table.instanceRef],
    foreignColumns: [workflow_instance_workflows._internalId],
    name: "fk_workflow_step_workflow_instance_stepInstance_workflo01bdff32"
  }),
  uniqueIndex("uidx_workflow_step_idx_workflow_step_instanceRef_runNum2a6b0b25").on(table.instanceRef, table.runNumber, table.stepKey),
  index("idx_workflow_step_idx_workflow_step_instanceRef_runNumbe91f4dec").on(table.instanceRef, table.runNumber, table.createdAt),
  index("idx_workflow_step_idx_workflow_step_instanceRef_status_8e044a37").on(table.instanceRef, table.status, table.wakeAt),
  index("idx_workflow_step_idx_workflow_step_shard_workflows_35617304").on(table._shard)
])

export const workflow_event_workflows = mysqlTable("workflow_event_workflows", {
  id: varchar("id", { length: 128 }).notNull().unique().$defaultFn(() => createId()),
  instanceRef: bigint("instanceRef", { mode: "number" }).notNull(),
  runNumber: int("runNumber").notNull(),
  actor: text("actor").notNull().default("user"),
  type: text("type").notNull(),
  payload: json("payload"),
  createdAt: datetime("createdAt").notNull().default(sql`(now())`),
  deliveredAt: datetime("deliveredAt"),
  consumedByStepKey: text("consumedByStepKey"),
  _internalId: bigint("_internalId", { mode: "number" }).primaryKey().autoincrement().notNull(),
  _version: int("_version").notNull().default(0),
  _shard: varchar("_shard", { length: 128 }).notNull().default("__fragno_global__")
}, (table) => [
  foreignKey({
    columns: [table.instanceRef],
    foreignColumns: [workflow_instance_workflows._internalId],
    name: "fk_workflow_event_workflow_instance_eventInstance_workf9b5621c6"
  }),
  index("idx_workflow_event_idx_workflow_event_instanceRef_runNu9d715b8f").on(table.instanceRef, table.runNumber, table.createdAt),
  index("idx_workflow_event_idx_workflow_event_shard_workflows_6fe6f981").on(table._shard)
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