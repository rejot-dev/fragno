import {
  organizationRoleSchema,
  type OrganizationRole,
  organizationMemberPageSchema,
  organizationRecordSchema,
  type OrganizationMemberPage,
} from "@fragno-dev/backoffice-api/v0/organization";
import {
  directoryPageInputSchema,
  type DirectoryPageInput,
} from "@fragno-dev/backoffice-api/v0/shared/pagination";
import { BACKOFFICE_PERMISSION } from "@fragno-dev/backoffice-api/v0/shared/permissions";
import { z } from "zod";

import type {
  AdminOrganizationMemberRecord,
  AdminOrganizationRecord,
  AdminUserEmailVerificationRecord,
  OrganizationManagerRecord,
} from "@/backoffice-runtime/object-registry";
import type {
  AccessCodeRecord,
  AccessCodeRedemptionPage,
  CreateAccessCodeInput,
  RevokeAccessCodeInput,
} from "@/fragno/access-codes/contracts";
import type {
  BackofficeAppPage,
  BackofficeAppPageInput,
  BackofficeAppActionsUpdateInput,
  BackofficeAppActionsUpdateResult,
  BackofficeAppPermissionsUpdateInput,
  BackofficeAppPermissionsUpdateResult,
  BackofficeAppTrustUpdateInput,
  BackofficeAppTrustUpdateResult,
  BackofficeAppRegistrationInput,
  BackofficeAppRegistrationResult,
} from "@/fragno/apps/contracts";
import { organizationPageSchema, type OrganizationPage } from "@/fragno/auth/directory-records";
import type {
  BackofficeOAuthClientCreateInput,
  BackofficeOAuthClientCreateResult,
  BackofficeOAuthClientListInput,
  BackofficeOAuthClientPage,
  BackofficeOAuthClientRotateSecretInput,
  BackofficeOAuthClientRotateSecretResult,
  BackofficeOAuthClientUpdateInput,
  BackofficeOAuthClientUpdateResult,
} from "@/fragno/auth/oauth-client";
import type { EventDeletionPass } from "@/fragno/automation/events-storage-runtime";
import { defineCliArgsParser } from "@/fragno/runtime-tools/bash-cli";

import {
  defineBackofficeRuntimeTool,
  defineBackofficeRuntimeToolFamily,
  type BackofficeToolContext,
} from "../runtime-tools";
import { adminAccessCodesRuntimeTools } from "./admin-access-codes";
import { adminAppsRuntimeTools } from "./admin-apps";
import { adminOAuthClientsRuntimeTools } from "./admin-oauth-clients";
import {
  formatOrganizationMemberPageText,
  formatOrganizationPageText,
  formatOrganizationText,
} from "./organization";

/** An access code with the sign-up link that carries it. */
export type AdminAccessCode = AccessCodeRecord & { url: string };

export type AdminAccessCodePage = {
  accessCodes: AdminAccessCode[];
  cursor: string | null;
  hasNextPage: boolean;
};

export type AdminAccessCodeRedemptions = AccessCodeRedemptionPage & {
  accessCode: AdminAccessCode;
};

export type AdminRuntime = {
  createOAuthClient(
    input: BackofficeOAuthClientCreateInput,
    administratorUserId: string,
  ): Promise<BackofficeOAuthClientCreateResult>;
  listOAuthClients(
    input: BackofficeOAuthClientListInput,
    administratorUserId: string,
  ): Promise<BackofficeOAuthClientPage>;
  updateOAuthClient(
    input: BackofficeOAuthClientUpdateInput,
    administratorUserId: string,
  ): Promise<BackofficeOAuthClientUpdateResult>;
  rotateOAuthClientSecret(
    input: BackofficeOAuthClientRotateSecretInput,
    administratorUserId: string,
  ): Promise<BackofficeOAuthClientRotateSecretResult>;
  createApp(input: BackofficeAppRegistrationInput): Promise<BackofficeAppRegistrationResult>;
  updateAppActions(
    input: BackofficeAppActionsUpdateInput,
  ): Promise<BackofficeAppActionsUpdateResult>;
  updateAppPermissions(
    input: BackofficeAppPermissionsUpdateInput,
  ): Promise<BackofficeAppPermissionsUpdateResult>;
  updateAppTrust(input: BackofficeAppTrustUpdateInput): Promise<BackofficeAppTrustUpdateResult>;
  listApps(input: BackofficeAppPageInput): Promise<BackofficeAppPage>;
  createAccessCode(input: CreateAccessCodeInput): Promise<AdminAccessCode>;
  listAccessCodes(input: { pageSize: number; cursor: string | null }): Promise<AdminAccessCodePage>;
  listAccessCodeRedemptions(input: {
    code: string;
    pageSize: number;
    cursor: string | null;
  }): Promise<AdminAccessCodeRedemptions>;
  revokeAccessCode(input: RevokeAccessCodeInput): Promise<AccessCodeRecord>;
  verifyUserEmail(input: { email: string }): Promise<AdminUserEmailVerificationRecord>;
  createOrganization(input: {
    name: string;
    slug: string;
    ownerEmail: string;
  }): Promise<AdminOrganizationRecord>;
  listOrganizations(input: DirectoryPageInput): Promise<OrganizationPage>;
  getOrganization(input: { organizationSlug: string }): Promise<AdminOrganizationDetails>;
  listOrganizationMembers(
    input: { organizationSlug: string } & DirectoryPageInput,
  ): Promise<OrganizationMemberPage>;
  addOrganizationMember(input: {
    organizationSlug: string;
    userEmail: string;
    roles: readonly OrganizationRole[];
  }): Promise<AdminOrganizationMemberRecord>;
  removeOrganizationMember(input: {
    organizationSlug: string;
    userEmail: string;
  }): Promise<AdminOrganizationMemberRecord>;
  setOrganizationManager(input: {
    organizationSlug: string;
    managingOrganizationSlug: string | null;
  }): Promise<OrganizationManagerRecord>;
  deleteOrganizationEventsOfType(
    input: { organizationSlug: string } & EventDeletionPass,
  ): Promise<{ scanned: number; deleted: number; cursor: string | null }>;
};

type AdminToolContext = BackofficeToolContext<{ admin?: AdminRuntime }>;

const organizationCreatedRecordSchema = z.strictObject({
  organizationId: z.string().trim().min(1),
  name: z.string().trim().min(1),
  slug: z.string().trim().min(1),
  ownerUserId: z.string().trim().min(1),
});

const organizationMemberChangeRecordSchema = z.strictObject({
  organizationId: z.string().trim().min(1),
  userId: z.string().trim().min(1),
  roles: z.array(z.string().trim().min(1)).min(1),
});

/** An organization as administrators read it: with the organization managing it, if any. */
const adminOrganizationDetailsSchema = z.lazy(() =>
  organizationRecordSchema._zod.innerType.extend({
    managingOrganization: z
      .strictObject({
        organizationId: z.string().min(1),
        name: z.string().min(1),
        slug: z.string().min(1),
      })
      .nullable(),
  }),
);
export type AdminOrganizationDetails = z.output<typeof adminOrganizationDetailsSchema>;

function formatAdminOrganizationText(organization: AdminOrganizationDetails): string {
  return [
    formatOrganizationText(organization),
    `  Managed by: ${
      organization.managingOrganization
        ? `${organization.managingOrganization.name} (${organization.managingOrganization.slug})`
        : "none"
    }`,
  ].join("\n");
}

const organizationManagerRecordSchema = z.strictObject({
  organizationId: z.string().trim().min(1),
  managingOrganizationId: z.string().trim().min(1).nullable(),
}) satisfies z.ZodType<OrganizationManagerRecord>;

const createOrganizationInputSchema = z.strictObject({
  name: z.string().trim().min(1),
  slug: z.string().trim().min(1),
  ownerEmail: z.string().trim().toLowerCase().pipe(z.email()),
});

const addOrganizationMemberInputSchema = z.strictObject({
  organizationSlug: z.string().trim().min(1),
  userEmail: z.string().trim().toLowerCase().pipe(z.email()),
  roles: z.array(organizationRoleSchema).min(1),
});

const removeOrganizationMemberInputSchema = z.strictObject({
  organizationSlug: z.string().trim().min(1),
  userEmail: z.string().trim().toLowerCase().pipe(z.email()),
});

function getAdminRuntime(runtime: AdminToolContext["runtimes"]["admin"]): AdminRuntime {
  if (!runtime) {
    throw new Error("Admin runtime is not available in this execution context.");
  }
  return runtime;
}

const verifyUserEmailTool = defineBackofficeRuntimeTool({
  id: "admin.users.verify-email",
  namespace: "admin",
  name: "usersVerifyEmail",
  description:
    "Mark a user's email address as verified without sending a verification email, for example on a deployment without email delivery.",
  requiredPermissions: [BACKOFFICE_PERMISSION.admin.usersManage],
  inputSchema: z.strictObject({ email: z.string().trim().toLowerCase().pipe(z.email()) }),
  outputSchema: z.strictObject({
    userId: z.string().trim().min(1),
    email: z.email(),
    status: z.enum(["verified", "already_verified"]),
  }),
  execute: async (input, context: AdminToolContext) =>
    await getAdminRuntime(context.runtimes.admin).verifyUserEmail(input),
  adapters: {
    bash: {
      command: "admin.users.verify-email",
      help: {
        summary:
          "admin.users.verify-email marks a user's email address as verified without sending an email.",
        options: [
          {
            name: "email",
            valueRequired: true,
            valueName: "email",
            description: "Email address of the existing user",
          },
        ],
        examples: [
          "admin.users.verify-email --email person@example.com",
          "admin.users.verify-email --email person@example.com --format json",
        ],
      },
      parse: defineCliArgsParser("admin.users.verify-email", {
        email: { kind: "string", required: true },
      }),
      format: (result, options) =>
        options.format === "json" || options.print
          ? { data: result }
          : {
              data: result,
              stdout:
                result.status === "verified"
                  ? `Verified ${result.email}.\n`
                  : `${result.email} was already verified.\n`,
            },
    },
  },
});

const organizationSlugOption = {
  name: "org",
  valueRequired: true,
  valueName: "slug",
  description: "Organization slug",
};

const createOrganizationTool = defineBackofficeRuntimeTool({
  id: "admin.org.create",
  namespace: "admin",
  name: "orgCreate",
  description: "Create an organization and assign its owner.",
  requiredPermissions: [BACKOFFICE_PERMISSION.admin.organizationsManage],
  inputSchema: createOrganizationInputSchema,
  outputSchema: organizationCreatedRecordSchema,
  execute: async (input, context: AdminToolContext) =>
    await getAdminRuntime(context.runtimes.admin).createOrganization(input),
  adapters: {
    bash: {
      command: "admin.org.create",
      help: {
        summary: "admin.org.create creates an organization and assigns its owner.",
        options: [
          {
            name: "name",
            valueRequired: true,
            valueName: "name",
            description: "Organization name",
          },
          {
            name: "slug",
            valueRequired: true,
            valueName: "slug",
            description: "Organization slug",
          },
          {
            name: "owner-email",
            valueRequired: true,
            valueName: "email",
            description: "Email address of the existing owner user",
          },
        ],
        examples: [
          'admin.org.create --name "Acme" --slug acme --owner-email owner@example.com --format json',
        ],
      },
      parse: defineCliArgsParser("admin.org.create", {
        name: { kind: "string", required: true },
        slug: { kind: "string", required: true },
        ownerEmail: { kind: "string", required: true },
      }),
      format: (result) => ({ data: result }),
    },
  },
});

const listOrganizationsTool = defineBackofficeRuntimeTool({
  id: "admin.org.list",
  namespace: "admin",
  name: "orgList",
  description: "List every organization, using cursor pagination.",
  requiredPermissions: [BACKOFFICE_PERMISSION.admin.organizationsManage],
  inputSchema: directoryPageInputSchema,
  outputSchema: organizationPageSchema,
  execute: async (input, context: AdminToolContext) =>
    await getAdminRuntime(context.runtimes.admin).listOrganizations(input),
  adapters: {
    bash: {
      command: "admin.org.list",
      help: {
        summary: "admin.org.list lists every organization.",
        options: [
          {
            name: "page-size",
            valueRequired: true,
            valueName: "count",
            description: "Page size, 1–100 (default 25)",
          },
          {
            name: "cursor",
            valueRequired: true,
            valueName: "cursor",
            description: "Cursor from the previous page; keep the same page size",
          },
        ],
        examples: ["admin.org.list", "admin.org.list --page-size 10 --cursor CURSOR --format json"],
      },
      parse: defineCliArgsParser("admin.org.list", {
        pageSize: { kind: "positiveInteger" },
        cursor: { kind: "string" },
      }),
      format: (result, options) =>
        options.format === "json" || options.print
          ? { data: result }
          : { data: result, stdout: formatOrganizationPageText(result) },
    },
  },
});

const getOrganizationTool = defineBackofficeRuntimeTool({
  id: "admin.org.get",
  namespace: "admin",
  name: "orgGet",
  description: "Read one organization by slug, with the organization managing it, if any.",
  requiredPermissions: [BACKOFFICE_PERMISSION.admin.organizationsManage],
  inputSchema: z.strictObject({ organizationSlug: z.string().trim().min(1) }),
  outputSchema: adminOrganizationDetailsSchema,
  execute: async (input, context: AdminToolContext) =>
    await getAdminRuntime(context.runtimes.admin).getOrganization(input),
  adapters: {
    bash: {
      command: "admin.org.get",
      help: {
        summary: "admin.org.get prints one organization.",
        options: [organizationSlugOption],
        examples: ["admin.org.get --org acme", "admin.org.get --org acme --print organizationId"],
      },
      parse: defineCliArgsParser("admin.org.get", {
        organizationSlug: { kind: "string", required: true, option: "org" },
      }),
      format: (result, options) =>
        options.format === "json" || options.print
          ? { data: result }
          : { data: result, stdout: `${formatAdminOrganizationText(result)}\n` },
    },
  },
});

const listOrganizationMembersTool = defineBackofficeRuntimeTool({
  id: "admin.org.members.list",
  namespace: "admin",
  name: "orgMembersList",
  description: "List members of any organization with their roles, using cursor pagination.",
  requiredPermissions: [BACKOFFICE_PERMISSION.admin.organizationsManage],
  inputSchema: z.lazy(() =>
    directoryPageInputSchema._zod.innerType.extend({ organizationSlug: z.string().trim().min(1) }),
  ),
  outputSchema: organizationMemberPageSchema,
  execute: async (input, context: AdminToolContext) =>
    await getAdminRuntime(context.runtimes.admin).listOrganizationMembers(input),
  adapters: {
    bash: {
      command: "admin.org.members.list",
      help: {
        summary: "admin.org.members.list lists members of an organization.",
        options: [
          organizationSlugOption,
          {
            name: "page-size",
            valueRequired: true,
            valueName: "count",
            description: "Page size, 1–100 (default 25)",
          },
          {
            name: "cursor",
            valueRequired: true,
            valueName: "cursor",
            description: "Cursor from the previous page; keep the same page size",
          },
        ],
        examples: [
          "admin.org.members.list --org acme",
          "admin.org.members.list --org acme --page-size 10 --cursor CURSOR --format json",
        ],
      },
      parse: defineCliArgsParser("admin.org.members.list", {
        organizationSlug: { kind: "string", required: true, option: "org" },
        pageSize: { kind: "positiveInteger" },
        cursor: { kind: "string" },
      }),
      format: (result, options) =>
        options.format === "json" || options.print
          ? { data: result }
          : { data: result, stdout: formatOrganizationMemberPageText(result) },
    },
  },
});

const addOrganizationMemberTool = defineBackofficeRuntimeTool({
  id: "admin.org.members.add",
  namespace: "admin",
  name: "orgMembersAdd",
  description: "Add a user to an organization with explicit roles.",
  requiredPermissions: [BACKOFFICE_PERMISSION.admin.organizationsManage],
  inputSchema: addOrganizationMemberInputSchema,
  outputSchema: organizationMemberChangeRecordSchema,
  execute: async (input, context: AdminToolContext) =>
    await getAdminRuntime(context.runtimes.admin).addOrganizationMember(input),
  adapters: {
    bash: {
      command: "admin.org.members.add",
      help: {
        summary: "admin.org.members.add adds a user to an organization.",
        options: [
          organizationSlugOption,
          {
            name: "email",
            valueRequired: true,
            valueName: "email",
            description: "Email address of the existing user",
          },
          {
            name: "role",
            valueRequired: true,
            valueName: "role",
            description: "owner, admin, or member; repeat for multiple roles",
          },
        ],
        examples: [
          "admin.org.members.add --org acme --email member@example.com --role member --format json",
        ],
      },
      parse: defineCliArgsParser("admin.org.members.add", {
        organizationSlug: { kind: "string", required: true, option: "org" },
        userEmail: { kind: "string", required: true, option: "email" },
        roles: { kind: "stringArray", required: true, option: "role" },
      }),
      format: (result) => ({ data: result }),
    },
  },
});

const removeOrganizationMemberTool = defineBackofficeRuntimeTool({
  id: "admin.org.members.remove",
  namespace: "admin",
  name: "orgMembersRemove",
  description: "Remove a user from an organization.",
  requiredPermissions: [BACKOFFICE_PERMISSION.admin.organizationsManage],
  inputSchema: removeOrganizationMemberInputSchema,
  outputSchema: organizationMemberChangeRecordSchema,
  execute: async (input, context: AdminToolContext) =>
    await getAdminRuntime(context.runtimes.admin).removeOrganizationMember(input),
  adapters: {
    bash: {
      command: "admin.org.members.remove",
      help: {
        summary: "admin.org.members.remove removes a user from an organization.",
        options: [
          organizationSlugOption,
          {
            name: "email",
            valueRequired: true,
            valueName: "email",
            description: "Email address of the existing user",
          },
        ],
        examples: ["admin.org.members.remove --org acme --email member@example.com --format json"],
      },
      parse: defineCliArgsParser("admin.org.members.remove", {
        organizationSlug: { kind: "string", required: true, option: "org" },
        userEmail: { kind: "string", required: true, option: "email" },
      }),
      format: (result) => ({ data: result }),
    },
  },
});

const setOrganizationManagerTool = defineBackofficeRuntimeTool({
  id: "admin.org.manager.set",
  namespace: "admin",
  name: "orgManagerSet",
  description:
    "Let the members of a managing organization, such as an agency, act in an organization: in its workspace, its projects, and, as its owners and admins, its members' personal workspaces. They act with their role in the managing organization, owners as admins, without becoming members. It replaces any previous managing organization and does not chain.",
  requiredPermissions: [BACKOFFICE_PERMISSION.admin.organizationsManage],
  inputSchema: z.strictObject({
    organizationSlug: z.string().trim().min(1),
    managingOrganizationSlug: z.string().trim().min(1),
  }),
  outputSchema: organizationManagerRecordSchema,
  execute: async (input, context: AdminToolContext) =>
    await getAdminRuntime(context.runtimes.admin).setOrganizationManager(input),
  adapters: {
    bash: {
      command: "admin.org.manager.set",
      help: {
        summary:
          "admin.org.manager.set lets a managing organization's members act in an organization.",
        options: [
          organizationSlugOption,
          {
            name: "manager",
            valueRequired: true,
            valueName: "slug",
            description: "Slug of the managing organization",
          },
        ],
        examples: ["admin.org.manager.set --org client --manager agency --format json"],
      },
      parse: defineCliArgsParser("admin.org.manager.set", {
        organizationSlug: { kind: "string", required: true, option: "org" },
        managingOrganizationSlug: { kind: "string", required: true, option: "manager" },
      }),
      format: (result) => ({ data: result }),
    },
  },
});

const clearOrganizationManagerTool = defineBackofficeRuntimeTool({
  id: "admin.org.manager.clear",
  namespace: "admin",
  name: "orgManagerClear",
  description:
    "End an organization's management: only its own members act in it again, effective for new credentials and deferred work at once.",
  requiredPermissions: [BACKOFFICE_PERMISSION.admin.organizationsManage],
  inputSchema: z.strictObject({ organizationSlug: z.string().trim().min(1) }),
  outputSchema: organizationManagerRecordSchema,
  execute: async (input, context: AdminToolContext) =>
    await getAdminRuntime(context.runtimes.admin).setOrganizationManager({
      ...input,
      managingOrganizationSlug: null,
    }),
  adapters: {
    bash: {
      command: "admin.org.manager.clear",
      help: {
        summary: "admin.org.manager.clear ends an organization's management.",
        options: [organizationSlugOption],
        examples: ["admin.org.manager.clear --org client --format json"],
      },
      parse: defineCliArgsParser("admin.org.manager.clear", {
        organizationSlug: { kind: "string", required: true, option: "org" },
      }),
      format: (result) => ({ data: result }),
    },
  },
});

export const adminRuntimeTools = [
  createOrganizationTool,
  addOrganizationMemberTool,
  removeOrganizationMemberTool,
  setOrganizationManagerTool,
  clearOrganizationManagerTool,
  listOrganizationsTool,
  getOrganizationTool,
  listOrganizationMembersTool,
  verifyUserEmailTool,
  ...adminAccessCodesRuntimeTools,
  ...adminAppsRuntimeTools,
  ...adminOAuthClientsRuntimeTools,
] as const;

export const adminToolFamily = defineBackofficeRuntimeToolFamily({
  namespace: "admin",
  tools: adminRuntimeTools,
  isAvailable: (context: AdminToolContext) => !!context.runtimes.admin,
});
