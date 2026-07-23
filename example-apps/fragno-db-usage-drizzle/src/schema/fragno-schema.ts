import { pgTable, varchar, text, bigserial, integer, uniqueIndex, json, timestamp, index, pgSchema, bigint, foreignKey, boolean } from "drizzle-orm/pg-core"
import { createId } from "@fragno-dev/db/id"
import { relations } from "drizzle-orm"

// ============================================================================
// Fragment: (none)
// ============================================================================

export const fragno_db_settings = pgTable("fragno_db_settings", {
  id: varchar("id", { length: 128 }).notNull().unique().$defaultFn(() => createId()),
  key: varchar("key", { length: 191 }).notNull(),
  value: text("value").notNull(),
  _internalId: bigserial("_internalId", { mode: "number" }).primaryKey().notNull(),
  _version: integer("_version").notNull().default(0)
}, (table) => [
  uniqueIndex("unique_key").on(table.key)
])

export const fragno_hooks = pgTable("fragno_hooks", {
  id: varchar("id", { length: 128 }).notNull().unique().$defaultFn(() => createId()),
  namespace: varchar("namespace", { length: 191 }).notNull(),
  hookName: varchar("hookName", { length: 191 }).notNull(),
  payload: json("payload").notNull(),
  status: varchar("status", { length: 191 }).notNull(),
  attempts: integer("attempts").notNull().default(0),
  maxAttempts: integer("maxAttempts").notNull().default(5),
  lastAttemptAt: timestamp("lastAttemptAt"),
  nextRetryAt: timestamp("nextRetryAt"),
  error: text("error"),
  createdAt: timestamp("createdAt").notNull().defaultNow(),
  nonce: varchar("nonce", { length: 191 }).notNull(),
  _internalId: bigserial("_internalId", { mode: "number" }).primaryKey().notNull(),
  _version: integer("_version").notNull().default(0)
}, (table) => [
  index("idx_namespace_status_retry").on(table.namespace, table.status, table.nextRetryAt),
  index("idx_nonce").on(table.nonce),
  index("idx_namespace_status_last_attempt").on(table.namespace, table.status, table.lastAttemptAt),
  index("idx_namespace_created_at").on(table.namespace, table.createdAt, table.id)
])

export const fragno_db_outbox = pgTable("fragno_db_outbox", {
  id: varchar("id", { length: 128 }).notNull().unique().$defaultFn(() => createId()),
  versionstamp: varchar("versionstamp", { length: 191 }).notNull(),
  uowId: varchar("uowId", { length: 191 }).notNull(),
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
  id: varchar("id", { length: 128 }).notNull().unique().$defaultFn(() => createId()),
  entryVersionstamp: varchar("entryVersionstamp", { length: 191 }).notNull(),
  mutationVersionstamp: varchar("mutationVersionstamp", { length: 191 }).notNull(),
  uowId: varchar("uowId", { length: 191 }).notNull(),
  schema: varchar("schema", { length: 191 }).notNull(),
  table: varchar("table", { length: 191 }).notNull(),
  externalId: varchar("externalId", { length: 191 }).notNull(),
  op: varchar("op", { length: 191 }).notNull(),
  createdAt: timestamp("createdAt").notNull().defaultNow(),
  _internalId: bigserial("_internalId", { mode: "number" }).primaryKey().notNull(),
  _version: integer("_version").notNull().default(0)
}, (table) => [
  index("idx_outbox_mutations_entry").on(table.entryVersionstamp),
  index("idx_outbox_mutations_key").on(table.schema, table.table, table.externalId, table.entryVersionstamp),
  index("idx_outbox_mutations_uow").on(table.uowId)
])

export const fragno_db_sync_requests = pgTable("fragno_db_sync_requests", {
  id: varchar("id", { length: 128 }).notNull().unique().$defaultFn(() => createId()),
  requestId: varchar("requestId", { length: 191 }).notNull(),
  status: varchar("status", { length: 191 }).notNull(),
  confirmedCommandIds: json("confirmedCommandIds").notNull(),
  conflictCommandId: varchar("conflictCommandId", { length: 191 }),
  baseVersionstamp: varchar("baseVersionstamp", { length: 191 }),
  lastVersionstamp: varchar("lastVersionstamp", { length: 191 }),
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
  id: varchar("id", { length: 128 }).notNull().unique().$defaultFn(() => createId()),
  email: varchar("email", { length: 191 }).notNull(),
  passwordHash: text("passwordHash"),
  role: varchar("role", { length: 191 }).notNull().default("user"),
  createdAt: timestamp("createdAt").notNull().defaultNow(),
  _internalId: bigserial("_internalId", { mode: "number" }).primaryKey().notNull(),
  _version: integer("_version").notNull().default(0),
  bannedAt: timestamp("bannedAt"),
  emailVerifiedAt: timestamp("emailVerifiedAt"),
  emailVerificationRequestedAt: timestamp("emailVerificationRequestedAt")
}, (table) => [
  uniqueIndex("idx_user_email").on(table.email),
  uniqueIndex("idx_user_id").on(table.id),
  index("idx_user_createdAt").on(table.createdAt),
  index("idx_user_email_verification_request").on(table.email, table.emailVerificationRequestedAt),
  index("idx_user_id_email_verification_request").on(table.id, table.emailVerificationRequestedAt)
])

export const session_auth = schema_auth.table("session", {
  id: varchar("id", { length: 128 }).notNull().unique().$defaultFn(() => createId()),
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
    name: "fk_session_user_session_userId_fk"
  }),
  foreignKey({
    columns: [table.activeOrganizationId],
    foreignColumns: [organization_auth._internalId],
    name: "fk_session_organization_session_activeOrganizationId_fk"
  }),
  index("idx_session_user").on(table.userId),
  index("idx_session_id_expiresAt").on(table.id, table.expiresAt)
])

export const organization_auth = schema_auth.table("organization", {
  id: varchar("id", { length: 128 }).notNull().unique().$defaultFn(() => createId()),
  name: text("name").notNull(),
  slug: varchar("slug", { length: 191 }).notNull(),
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
    name: "fk_organization_user_organization_createdBy_fk"
  }),
  uniqueIndex("idx_organization_slug").on(table.slug),
  index("idx_organization_createdBy").on(table.createdBy)
])

export const organizationMember_auth = schema_auth.table("organizationMember", {
  id: varchar("id", { length: 128 }).notNull().unique().$defaultFn(() => createId()),
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
    name: "fk_organizationMember_organization_organizationMember_o606388be"
  }),
  foreignKey({
    columns: [table.userId],
    foreignColumns: [user_auth._internalId],
    name: "fk_organizationMember_user_organizationMember_userId_fk"
  }),
  uniqueIndex("idx_org_member_org_user").on(table.organizationId, table.userId),
  index("idx_org_member_user").on(table.userId),
  index("idx_org_member_org").on(table.organizationId)
])

export const organizationMemberRole_auth = schema_auth.table("organizationMemberRole", {
  id: varchar("id", { length: 128 }).notNull().unique().$defaultFn(() => createId()),
  memberId: bigint("memberId", { mode: "number" }).notNull(),
  role: varchar("role", { length: 191 }).notNull(),
  createdAt: timestamp("createdAt").notNull().defaultNow(),
  _internalId: bigserial("_internalId", { mode: "number" }).primaryKey().notNull(),
  _version: integer("_version").notNull().default(0)
}, (table) => [
  foreignKey({
    columns: [table.memberId],
    foreignColumns: [organizationMember_auth._internalId],
    name: "fk_organizationMemberRole_organizationMember_organizati180d7eb6"
  }),
  uniqueIndex("idx_org_member_role_member_role").on(table.memberId, table.role),
  index("idx_org_member_role_member").on(table.memberId),
  index("idx_org_member_role_role").on(table.role)
])

export const organizationInvitation_auth = schema_auth.table("organizationInvitation", {
  id: varchar("id", { length: 128 }).notNull().unique().$defaultFn(() => createId()),
  organizationId: bigint("organizationId", { mode: "number" }).notNull(),
  email: varchar("email", { length: 191 }).notNull(),
  roles: json("roles").notNull(),
  status: varchar("status", { length: 191 }).notNull(),
  token: varchar("token", { length: 191 }).notNull(),
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
    name: "fk_organizationInvitation_organization_organizationInvib469906c"
  }),
  foreignKey({
    columns: [table.inviterId],
    foreignColumns: [user_auth._internalId],
    name: "fk_organizationInvitation_user_organizationInvitation_i5d603a64"
  }),
  uniqueIndex("idx_org_invitation_token").on(table.token),
  index("idx_org_invitation_org_status").on(table.organizationId, table.status),
  index("idx_org_invitation_email").on(table.email),
  index("idx_org_invitation_email_status").on(table.email, table.status)
])

export const oauthAccount_auth = schema_auth.table("oauthAccount", {
  id: varchar("id", { length: 128 }).notNull().unique().$defaultFn(() => createId()),
  userId: bigint("userId", { mode: "number" }).notNull(),
  provider: varchar("provider", { length: 191 }).notNull(),
  providerAccountId: varchar("providerAccountId", { length: 191 }).notNull(),
  email: text("email"),
  emailVerified: boolean("emailVerified").notNull().default(false),
  image: text("image"),
  accessToken: text("accessToken"),
  refreshToken: text("refreshToken"),
  idToken: text("idToken"),
  tokenType: varchar("tokenType", { length: 191 }),
  tokenExpiresAt: timestamp("tokenExpiresAt"),
  scopes: json("scopes"),
  rawProfile: json("rawProfile"),
  createdAt: timestamp("createdAt").notNull().defaultNow(),
  updatedAt: timestamp("updatedAt").notNull().defaultNow(),
  _internalId: bigserial("_internalId", { mode: "number" }).primaryKey().notNull(),
  _version: integer("_version").notNull().default(0)
}, (table) => [
  foreignKey({
    columns: [table.userId],
    foreignColumns: [user_auth._internalId],
    name: "fk_oauthAccount_user_oauthAccount_userId_fk"
  }),
  uniqueIndex("idx_oauth_account_provider_account").on(table.provider, table.providerAccountId),
  index("idx_oauth_account_user").on(table.userId),
  index("idx_oauth_account_provider").on(table.provider)
])

export const oauthState_auth = schema_auth.table("oauthState", {
  id: varchar("id", { length: 128 }).notNull().unique().$defaultFn(() => createId()),
  provider: varchar("provider", { length: 191 }).notNull(),
  state: varchar("state", { length: 191 }).notNull(),
  codeVerifier: varchar("codeVerifier", { length: 191 }),
  redirectUri: text("redirectUri"),
  returnTo: text("returnTo"),
  linkUserId: bigint("linkUserId", { mode: "number" }),
  createdAt: timestamp("createdAt").notNull().defaultNow(),
  expiresAt: timestamp("expiresAt").notNull(),
  _internalId: bigserial("_internalId", { mode: "number" }).primaryKey().notNull(),
  _version: integer("_version").notNull().default(0),
  sessionSeed: json("sessionSeed")
}, (table) => [
  foreignKey({
    columns: [table.linkUserId],
    foreignColumns: [user_auth._internalId],
    name: "fk_oauthState_user_oauthState_linkUserId_fk"
  }),
  uniqueIndex("idx_oauth_state_state").on(table.state),
  index("idx_oauth_state_provider").on(table.provider),
  index("idx_oauth_state_expiresAt").on(table.expiresAt),
  index("idx_oauth_state_state_expires_at").on(table.state, table.expiresAt)
])

export const user_authRelations = relations(user_auth, ({ many }) => ({
  sessionList: many(session_auth, {
    relationName: "session_userId"
  }),
  organizationList: many(organization_auth, {
    relationName: "organization_createdBy"
  }),
  organizationMemberList: many(organizationMember_auth, {
    relationName: "organizationMember_userId"
  }),
  organizationInvitationList: many(organizationInvitation_auth, {
    relationName: "organizationInvitation_inviterId"
  }),
  oauthAccountList: many(oauthAccount_auth, {
    relationName: "oauthAccount_userId"
  }),
  oauthStateList: many(oauthState_auth, {
    relationName: "oauthState_linkUserId"
  })
}));

export const session_authRelations = relations(session_auth, ({ one }) => ({
  user: one(user_auth, {
    relationName: "session_userId",
    fields: [session_auth.userId],
    references: [user_auth._internalId]
  }),
  activeOrganization: one(organization_auth, {
    relationName: "session_activeOrganizationId",
    fields: [session_auth.activeOrganizationId],
    references: [organization_auth._internalId]
  })
}));

export const organization_authRelations = relations(organization_auth, ({ one, many }) => ({
  createdBy: one(user_auth, {
    relationName: "organization_createdBy",
    fields: [organization_auth.createdBy],
    references: [user_auth._internalId]
  }),
  sessionList: many(session_auth, {
    relationName: "session_activeOrganizationId"
  }),
  organizationMemberList: many(organizationMember_auth, {
    relationName: "organizationMember_organizationId"
  }),
  organizationInvitationList: many(organizationInvitation_auth, {
    relationName: "organizationInvitation_organizationId"
  })
}));

export const organizationMember_authRelations = relations(organizationMember_auth, ({ one, many }) => ({
  organization: one(organization_auth, {
    relationName: "organizationMember_organizationId",
    fields: [organizationMember_auth.organizationId],
    references: [organization_auth._internalId]
  }),
  user: one(user_auth, {
    relationName: "organizationMember_userId",
    fields: [organizationMember_auth.userId],
    references: [user_auth._internalId]
  }),
  organizationMemberRoleList: many(organizationMemberRole_auth, {
    relationName: "organizationMemberRole_memberId"
  })
}));

export const organizationMemberRole_authRelations = relations(organizationMemberRole_auth, ({ one }) => ({
  member: one(organizationMember_auth, {
    relationName: "organizationMemberRole_memberId",
    fields: [organizationMemberRole_auth.memberId],
    references: [organizationMember_auth._internalId]
  })
}));

export const organizationInvitation_authRelations = relations(organizationInvitation_auth, ({ one }) => ({
  organization: one(organization_auth, {
    relationName: "organizationInvitation_organizationId",
    fields: [organizationInvitation_auth.organizationId],
    references: [organization_auth._internalId]
  }),
  inviter: one(user_auth, {
    relationName: "organizationInvitation_inviterId",
    fields: [organizationInvitation_auth.inviterId],
    references: [user_auth._internalId]
  })
}));

export const oauthAccount_authRelations = relations(oauthAccount_auth, ({ one }) => ({
  user: one(user_auth, {
    relationName: "oauthAccount_userId",
    fields: [oauthAccount_auth.userId],
    references: [user_auth._internalId]
  })
}));

export const oauthState_authRelations = relations(oauthState_auth, ({ one }) => ({
  linkUser: one(user_auth, {
    relationName: "oauthState_linkUserId",
    fields: [oauthState_auth.linkUserId],
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
  oauthAccount_auth: oauthAccount_auth,
  oauthAccount_authRelations: oauthAccount_authRelations,
  oauthAccount: oauthAccount_auth,
  oauthAccountRelations: oauthAccount_authRelations,
  oauthState_auth: oauthState_auth,
  oauthState_authRelations: oauthState_authRelations,
  oauthState: oauthState_auth,
  oauthStateRelations: oauthState_authRelations,
  schemaVersion: 34
}

// ============================================================================
// Fragment: comment
// ============================================================================

const schema_comment = pgSchema("comment");

export const comment_comment = schema_comment.table("comment", {
  id: varchar("id", { length: 128 }).notNull().unique().$defaultFn(() => createId()),
  title: varchar("title", { length: 191 }).notNull(),
  content: varchar("content", { length: 191 }).notNull(),
  createdAt: timestamp("createdAt").notNull().defaultNow(),
  postReference: varchar("postReference", { length: 191 }).notNull(),
  userReference: varchar("userReference", { length: 191 }).notNull(),
  parentId: bigint("parentId", { mode: "number" }),
  _internalId: bigserial("_internalId", { mode: "number" }).primaryKey().notNull(),
  _version: integer("_version").notNull().default(0),
  rating: integer("rating").notNull().default(0)
}, (table) => [
  foreignKey({
    columns: [table.parentId],
    foreignColumns: [table._internalId],
    name: "fk_comment_comment_comment_parentId_fk"
  }),
  index("idx_comment_post").on(table.postReference)
])

export const comment_commentRelations = relations(comment_comment, ({ one, many }) => ({
  parent: one(comment_comment, {
    relationName: "comment_parentId",
    fields: [comment_comment.parentId],
    references: [comment_comment._internalId]
  }),
  commentList: many(comment_comment, {
    relationName: "comment_parentId"
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
  id: varchar("id", { length: 128 }).notNull().unique().$defaultFn(() => createId()),
  reference: varchar("reference", { length: 191 }).notNull(),
  ownerReference: varchar("ownerReference", { length: 191 }),
  rating: integer("rating").notNull(),
  createdAt: timestamp("createdAt").notNull().defaultNow(),
  note: varchar("note", { length: 191 }),
  _internalId: bigserial("_internalId", { mode: "number" }).primaryKey().notNull(),
  _version: integer("_version").notNull().default(0)
}, (table) => [
  index("idx_upvote_reference").on(table.reference, table.ownerReference)
])

export const upvote_total_upvote = schema_upvote.table("upvote_total", {
  id: varchar("id", { length: 128 }).notNull().unique().$defaultFn(() => createId()),
  reference: varchar("reference", { length: 191 }).notNull(),
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
  id: varchar("id", { length: 128 }).notNull().unique().$defaultFn(() => createId()),
  workflowName: varchar("workflowName", { length: 191 }).notNull(),
  remoteWorkflowName: varchar("remoteWorkflowName", { length: 191 }),
  instanceId: varchar("instanceId", { length: 191 }).notNull(),
  status: varchar("status", { length: 191 }).notNull(),
  createdAt: timestamp("createdAt").notNull().defaultNow(),
  updatedAt: timestamp("updatedAt").notNull().defaultNow(),
  startedAt: timestamp("startedAt"),
  completedAt: timestamp("completedAt"),
  params: json("params").notNull(),
  output: json("output"),
  errorName: varchar("errorName", { length: 191 }),
  errorMessage: varchar("errorMessage", { length: 191 }),
  _internalId: bigserial("_internalId", { mode: "number" }).primaryKey().notNull(),
  _version: integer("_version").notNull().default(0)
}, (table) => [
  uniqueIndex("idx_workflow_instance_workflowName_instanceId").on(table.workflowName, table.instanceId),
  index("idx_workflow_instance_workflowName_status_instanceId").on(table.workflowName, table.status, table.instanceId),
  index("idx_workflow_instance_workflowName_remoteWorkflowName_i236860b6").on(table.workflowName, table.remoteWorkflowName, table.instanceId),
  index("idx_workflow_instance_workflowName_remoteWorkflowName_sb0276b96").on(table.workflowName, table.remoteWorkflowName, table.status, table.instanceId)
])

export const workflow_step_workflows = schema_workflows.table("workflow_step", {
  id: varchar("id", { length: 128 }).notNull().unique().$defaultFn(() => createId()),
  instanceRef: bigint("instanceRef", { mode: "number" }).notNull(),
  stepKey: varchar("stepKey", { length: 191 }).notNull(),
  parentStepKey: varchar("parentStepKey", { length: 191 }),
  depth: integer("depth").notNull().default(0),
  name: varchar("name", { length: 191 }).notNull(),
  type: varchar("type", { length: 191 }).notNull(),
  status: varchar("status", { length: 191 }).notNull(),
  attempts: integer("attempts").notNull().default(0),
  maxAttempts: integer("maxAttempts").notNull(),
  timeoutMs: integer("timeoutMs"),
  nextRetryAt: timestamp("nextRetryAt"),
  wakeAt: timestamp("wakeAt"),
  waitEventType: varchar("waitEventType", { length: 191 }),
  result: json("result"),
  errorName: varchar("errorName", { length: 191 }),
  errorMessage: varchar("errorMessage", { length: 191 }),
  createdAt: timestamp("createdAt").notNull().defaultNow(),
  updatedAt: timestamp("updatedAt").notNull().defaultNow(),
  _internalId: bigserial("_internalId", { mode: "number" }).primaryKey().notNull(),
  _version: integer("_version").notNull().default(0)
}, (table) => [
  foreignKey({
    columns: [table.instanceRef],
    foreignColumns: [workflow_instance_workflows._internalId],
    name: "fk_workflow_step_workflow_instance_workflow_step_instanceRef_fk"
  }),
  uniqueIndex("idx_workflow_step_instanceRef_stepKey").on(table.instanceRef, table.stepKey),
  index("idx_workflow_step_instanceRef_createdAt").on(table.instanceRef, table.createdAt),
  index("idx_workflow_step_instanceRef_status_wakeAt").on(table.instanceRef, table.status, table.wakeAt)
])

export const workflow_event_workflows = schema_workflows.table("workflow_event", {
  id: varchar("id", { length: 128 }).notNull().unique().$defaultFn(() => createId()),
  instanceRef: bigint("instanceRef", { mode: "number" }).notNull(),
  actor: varchar("actor", { length: 191 }).notNull().default("user"),
  type: varchar("type", { length: 191 }).notNull(),
  payload: json("payload"),
  createdAt: timestamp("createdAt").notNull().defaultNow(),
  deliveredAt: timestamp("deliveredAt"),
  consumedByStepKey: varchar("consumedByStepKey", { length: 191 }),
  _internalId: bigserial("_internalId", { mode: "number" }).primaryKey().notNull(),
  _version: integer("_version").notNull().default(0)
}, (table) => [
  foreignKey({
    columns: [table.instanceRef],
    foreignColumns: [workflow_instance_workflows._internalId],
    name: "fk_workflow_event_workflow_instance_workflow_event_inst7a7e6da9"
  }),
  index("idx_workflow_event_instanceRef_createdAt").on(table.instanceRef, table.createdAt)
])

export const workflow_step_emission_workflows = schema_workflows.table("workflow_step_emission", {
  id: varchar("id", { length: 128 }).notNull().unique().$defaultFn(() => createId()),
  instanceRef: bigint("instanceRef", { mode: "number" }).notNull(),
  stepKey: varchar("stepKey", { length: 191 }).notNull(),
  epoch: varchar("epoch", { length: 191 }).notNull(),
  sequence: integer("sequence").notNull(),
  actor: varchar("actor", { length: 191 }).notNull().default("user"),
  payload: json("payload"),
  createdAt: timestamp("createdAt").notNull().defaultNow(),
  _internalId: bigserial("_internalId", { mode: "number" }).primaryKey().notNull(),
  _version: integer("_version").notNull().default(0)
}, (table) => [
  foreignKey({
    columns: [table.instanceRef],
    foreignColumns: [workflow_instance_workflows._internalId],
    name: "fk_workflow_step_emission_workflow_instance_workflow_st2cce7185"
  }),
  index("idx_workflow_step_emission_instance_createdAt_sequence_id").on(table.instanceRef, table.createdAt, table.sequence, table.id),
  index("idx_workflow_step_emission_instance_step_epoch_createdAda0a838d").on(table.instanceRef, table.stepKey, table.epoch, table.createdAt, table.sequence, table.id),
  index("idx_workflow_step_emission_instance_actor_createdAt_sequence_id").on(table.instanceRef, table.actor, table.createdAt, table.sequence, table.id)
])

export const workflow_instance_workflowsRelations = relations(workflow_instance_workflows, ({ many }) => ({
  workflow_stepList: many(workflow_step_workflows, {
    relationName: "workflow_step_instanceRef"
  }),
  workflow_eventList: many(workflow_event_workflows, {
    relationName: "workflow_event_instanceRef"
  }),
  workflow_step_emissionList: many(workflow_step_emission_workflows, {
    relationName: "workflow_step_emission_instanceRef"
  })
}));

export const workflow_step_workflowsRelations = relations(workflow_step_workflows, ({ one }) => ({
  instanceRef: one(workflow_instance_workflows, {
    relationName: "workflow_step_instanceRef",
    fields: [workflow_step_workflows.instanceRef],
    references: [workflow_instance_workflows._internalId]
  })
}));

export const workflow_event_workflowsRelations = relations(workflow_event_workflows, ({ one }) => ({
  instanceRef: one(workflow_instance_workflows, {
    relationName: "workflow_event_instanceRef",
    fields: [workflow_event_workflows.instanceRef],
    references: [workflow_instance_workflows._internalId]
  })
}));

export const workflow_step_emission_workflowsRelations = relations(workflow_step_emission_workflows, ({ one }) => ({
  instanceRef: one(workflow_instance_workflows, {
    relationName: "workflow_step_emission_instanceRef",
    fields: [workflow_step_emission_workflows.instanceRef],
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
  workflow_step_emission_workflows: workflow_step_emission_workflows,
  workflow_step_emission_workflowsRelations: workflow_step_emission_workflowsRelations,
  workflow_step_emission: workflow_step_emission_workflows,
  workflow_step_emissionRelations: workflow_step_emission_workflowsRelations,
  schemaVersion: 6
}