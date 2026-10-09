import {
  organizationRoleSchema,
  type OrganizationRole,
  organizationMemberPageSchema,
  organizationRecordSchema,
  type OrganizationMemberPage,
  type OrganizationRecord,
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
} from "@/backoffice-runtime/object-registry";
import type {
  BackofficeAppPage,
  BackofficeAppPageInput,
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
import { defineCliArgsParser } from "@/fragno/runtime-tools/bash-cli";

import {
  defineBackofficeRuntimeTool,
  defineBackofficeRuntimeToolFamily,
  type BackofficeToolContext,
} from "../runtime-tools";
import { adminAppsRuntimeTools } from "./admin-apps";
import { adminOAuthClientsRuntimeTools } from "./admin-oauth-clients";
import {
  formatOrganizationMemberPageText,
  formatOrganizationPageText,
  formatOrganizationText,
} from "./organization";

export type AdminSignUpInvitationRecord = {
  invitationId: string;
  email: string;
  url: string;
  ttlDays: number;
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
  listApps(input: BackofficeAppPageInput): Promise<BackofficeAppPage>;
  createSignUpInvitation(input: {
    email: string;
    ttlDays?: number;
  }): Promise<AdminSignUpInvitationRecord>;
  createOrganization(input: {
    name: string;
    slug: string;
    ownerEmail: string;
  }): Promise<AdminOrganizationRecord>;
  listOrganizations(input: DirectoryPageInput): Promise<OrganizationPage>;
  getOrganization(input: { organizationSlug: string }): Promise<OrganizationRecord>;
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
};

type AdminToolContext = BackofficeToolContext<{ admin?: AdminRuntime }>;

const signUpInvitationRecordSchema = z.strictObject({
  invitationId: z.string().trim().min(1),
  email: z.email(),
  url: z.url(),
  ttlDays: z.number().int().positive(),
});

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

const createSignUpInvitationInputSchema = z.strictObject({
  email: z.string().trim().toLowerCase().pipe(z.email()),
  ttlDays: z.number().int().positive().optional(),
});

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

const createSignUpInvitationTool = defineBackofficeRuntimeTool({
  id: "admin.signup-invitations.create",
  namespace: "admin",
  name: "signupInvitationsCreate",
  description: "Create an email-bound link that authorizes one Backoffice account sign-up.",
  requiredPermissions: [BACKOFFICE_PERMISSION.admin.signUpInvitationsManage],
  inputSchema: createSignUpInvitationInputSchema,
  outputSchema: signUpInvitationRecordSchema,
  execute: async (input, context: AdminToolContext) =>
    await getAdminRuntime(context.runtimes.admin).createSignUpInvitation(input),
  adapters: {
    bash: {
      command: "admin.signup-invitations.create",
      help: {
        summary: "admin.signup-invitations.create creates an email-bound sign-up link.",
        options: [
          {
            name: "email",
            valueRequired: true,
            valueName: "email",
            description: "Email address authorized to create the account",
          },
          {
            name: "ttl-days",
            valueRequired: true,
            valueName: "days",
            description: "Optional invitation lifetime, in days",
          },
        ],
        examples: [
          "admin.signup-invitations.create --email person@example.com --ttl-days 7",
          "admin.signup-invitations.create --email person@example.com --format json",
        ],
      },
      parse: defineCliArgsParser<{ email: string; ttlDays?: number }>(
        "admin.signup-invitations.create",
        {
          email: { kind: "string", required: true },
          ttlDays: { kind: "positiveInteger" },
        },
      ),
      format: (result, options) =>
        options.format === "json" || options.print
          ? { data: result }
          : { data: result, stdout: `${result.url}\n` },
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
  description: "Read one organization by slug.",
  requiredPermissions: [BACKOFFICE_PERMISSION.admin.organizationsManage],
  inputSchema: z.strictObject({ organizationSlug: z.string().trim().min(1) }),
  outputSchema: organizationRecordSchema,
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
          : { data: result, stdout: `${formatOrganizationText(result)}\n` },
    },
  },
});

const listOrganizationMembersTool = defineBackofficeRuntimeTool({
  id: "admin.org.members.list",
  namespace: "admin",
  name: "orgMembersList",
  description: "List members of any organization with their roles, using cursor pagination.",
  requiredPermissions: [BACKOFFICE_PERMISSION.admin.organizationsManage],
  inputSchema: directoryPageInputSchema.extend({
    organizationSlug: z.string().trim().min(1),
  }),
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

export const adminRuntimeTools = [
  createSignUpInvitationTool,
  createOrganizationTool,
  addOrganizationMemberTool,
  removeOrganizationMemberTool,
  listOrganizationsTool,
  getOrganizationTool,
  listOrganizationMembersTool,
  ...adminAppsRuntimeTools,
  ...adminOAuthClientsRuntimeTools,
] as const;

export const adminToolFamily = defineBackofficeRuntimeToolFamily({
  namespace: "admin",
  tools: adminRuntimeTools,
  isAvailable: (context: AdminToolContext) => !!context.runtimes.admin,
});
