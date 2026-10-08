import { z } from "zod";

import { BACKOFFICE_PERMISSION } from "@/backoffice-runtime/permissions";
import {
  accountInvitationRecordSchema,
  accountProfileSchema,
  directoryPageInputSchema,
  organizationMembershipRecordSchema,
  type AccountInvitationRecord,
  type AccountProfile,
  type DirectoryPageInput,
  type OrganizationMembershipRecord,
} from "@/fragno/auth/directory-records";
import {
  backofficeOAuthConsentPageSchema,
  type BackofficeOAuthConsentPage,
} from "@/fragno/auth/oauth-consent";
import { defineCliArgsParser, defineNoInputArgsParser } from "@/fragno/runtime-tools/bash-cli";

import {
  defineBackofficeRuntimeTool,
  defineBackofficeRuntimeToolFamily,
  type BackofficeToolContext,
} from "../runtime-tools";

/** Acts on the execution's user principal only; no command can target another account. */
export type AccountRuntime = {
  getProfile(): Promise<AccountProfile>;
  updateProfile(input: { name: string }): Promise<AccountProfile>;
  listOrganizations(): Promise<OrganizationMembershipRecord[]>;
  listInvitations(): Promise<AccountInvitationRecord[]>;
  acceptInvitation(input: { invitationId: string }): Promise<OrganizationMembershipRecord>;
  listApplications(input: DirectoryPageInput): Promise<BackofficeOAuthConsentPage>;
};

type AccountToolContext = BackofficeToolContext<{ account?: AccountRuntime }>;

function getAccountRuntime(runtime: AccountRuntime | undefined): AccountRuntime {
  if (!runtime) {
    throw new Error("Account commands require a signed-in user principal.");
  }
  return runtime;
}

function formatProfileText(profile: AccountProfile): string {
  return [
    `Name: ${profile.name}`,
    `Email: ${profile.email}${profile.emailVerified ? "" : " (unverified)"}`,
    `User ID: ${profile.userId}`,
    `System role: ${profile.systemRole}`,
    "",
  ].join("\n");
}

function formatMembershipText({ organization, roles }: OrganizationMembershipRecord): string {
  return `${organization.name} (${organization.slug}): ${roles.join(", ")}`;
}

const getProfileTool = defineBackofficeRuntimeTool({
  id: "account.me",
  namespace: "account",
  name: "me",
  description: "Read your own Backoffice account profile.",
  requiredPermissions: [BACKOFFICE_PERMISSION.account.read.permission],
  inputSchema: z.void(),
  outputSchema: accountProfileSchema,
  execute: async (_input, context: AccountToolContext) =>
    await getAccountRuntime(context.runtimes.account).getProfile(),
  adapters: {
    bash: {
      command: "account.me",
      help: {
        summary: "account.me prints your own account profile.",
        options: [],
        examples: ["account.me", "account.me --format json", "account.me --print email"],
      },
      parse: defineNoInputArgsParser("account.me"),
      format: (result, options) =>
        options.format === "json" || options.print
          ? { data: result }
          : { data: result, stdout: formatProfileText(result) },
    },
  },
});

const updateProfileTool = defineBackofficeRuntimeTool({
  id: "account.profile.update",
  namespace: "account",
  name: "profileUpdate",
  description: "Change the display name on your own Backoffice account.",
  requiredPermissions: [BACKOFFICE_PERMISSION.account.manage.permission],
  inputSchema: z.strictObject({ name: z.string().trim().min(1) }),
  outputSchema: accountProfileSchema,
  execute: async (input, context: AccountToolContext) =>
    await getAccountRuntime(context.runtimes.account).updateProfile(input),
  adapters: {
    bash: {
      command: "account.profile.update",
      help: {
        summary: "account.profile.update changes your display name.",
        options: [
          {
            name: "name",
            valueRequired: true,
            valueName: "name",
            description: "New display name",
          },
        ],
        examples: ['account.profile.update --name "Ada Lovelace"'],
      },
      parse: defineCliArgsParser("account.profile.update", {
        name: { kind: "string", required: true },
      }),
      format: (result, options) =>
        options.format === "json" || options.print
          ? { data: result }
          : { data: result, stdout: formatProfileText(result) },
    },
  },
});

const listOrganizationsTool = defineBackofficeRuntimeTool({
  id: "account.orgs.list",
  namespace: "account",
  name: "orgsList",
  description: "List the organizations you belong to and your roles in each.",
  requiredPermissions: [BACKOFFICE_PERMISSION.account.read.permission],
  inputSchema: z.void(),
  outputSchema: z.strictObject({ organizations: z.array(organizationMembershipRecordSchema) }),
  execute: async (_input, context: AccountToolContext) => {
    const organizations = await getAccountRuntime(context.runtimes.account).listOrganizations();
    return { organizations };
  },
  adapters: {
    bash: {
      command: "account.orgs.list",
      help: {
        summary: "account.orgs.list lists your organizations and roles.",
        options: [],
        examples: ["account.orgs.list", "account.orgs.list --format json"],
      },
      parse: defineNoInputArgsParser("account.orgs.list"),
      format: (result, options) =>
        options.format === "json" || options.print
          ? { data: result }
          : {
              data: result,
              stdout: [
                result.organizations.length
                  ? `Organizations (${result.organizations.length}):`
                  : "You do not belong to any organization.",
                ...result.organizations.map(formatMembershipText),
                "",
              ].join("\n"),
            },
    },
  },
});

const listInvitationsTool = defineBackofficeRuntimeTool({
  id: "account.invitations.list",
  namespace: "account",
  name: "invitationsList",
  description: "List pending, unexpired organization invitations addressed to your email.",
  requiredPermissions: [BACKOFFICE_PERMISSION.account.read.permission],
  inputSchema: z.void(),
  outputSchema: z.strictObject({ invitations: z.array(accountInvitationRecordSchema) }),
  execute: async (_input, context: AccountToolContext) => {
    const invitations = await getAccountRuntime(context.runtimes.account).listInvitations();
    return { invitations };
  },
  adapters: {
    bash: {
      command: "account.invitations.list",
      help: {
        summary: "account.invitations.list lists pending invitations addressed to you.",
        options: [],
        examples: ["account.invitations.list", "account.invitations.list --format json"],
      },
      parse: defineNoInputArgsParser("account.invitations.list"),
      format: (result, options) =>
        options.format === "json" || options.print
          ? { data: result }
          : {
              data: result,
              stdout: [
                result.invitations.length
                  ? `Pending invitations (${result.invitations.length}):`
                  : "No pending invitations.",
                ...result.invitations.map((invitation) =>
                  [
                    `${invitation.organization.name} (${invitation.organization.slug}): ${invitation.roles.join(", ")}`,
                    `  Invitation ID: ${invitation.invitationId}`,
                    `  Expires at: ${invitation.expiresAt}`,
                  ].join("\n"),
                ),
                "",
              ].join("\n"),
            },
    },
  },
});

const acceptInvitationTool = defineBackofficeRuntimeTool({
  id: "account.invitations.accept",
  namespace: "account",
  name: "invitationsAccept",
  description: "Accept a pending organization invitation addressed to your email.",
  requiredPermissions: [BACKOFFICE_PERMISSION.account.manage.permission],
  inputSchema: z.strictObject({ invitationId: z.string().trim().min(1) }),
  outputSchema: organizationMembershipRecordSchema,
  execute: async (input, context: AccountToolContext) =>
    await getAccountRuntime(context.runtimes.account).acceptInvitation(input),
  adapters: {
    bash: {
      command: "account.invitations.accept",
      help: {
        summary: "account.invitations.accept joins the organization that invited you.",
        options: [
          {
            name: "invitation",
            valueRequired: true,
            valueName: "invitation-id",
            description: "Invitation ID from account.invitations.list",
          },
        ],
        examples: ["account.invitations.accept --invitation INVITATION_ID"],
      },
      parse: defineCliArgsParser("account.invitations.accept", {
        invitationId: { kind: "string", required: true, option: "invitation" },
      }),
      format: (result, options) =>
        options.format === "json" || options.print
          ? { data: result }
          : { data: result, stdout: `Joined ${formatMembershipText(result)}\n` },
    },
  },
});

const listApplicationsTool = defineBackofficeRuntimeTool({
  id: "account.applications.list",
  namespace: "account",
  name: "applicationsList",
  description:
    "List OAuth applications you have authorized and their granted scopes, using cursor pagination. Never exposes tokens.",
  requiredPermissions: [BACKOFFICE_PERMISSION.account.read.permission],
  inputSchema: directoryPageInputSchema,
  outputSchema: backofficeOAuthConsentPageSchema,
  execute: async (input, context: AccountToolContext) =>
    await getAccountRuntime(context.runtimes.account).listApplications(input),
  adapters: {
    bash: {
      command: "account.applications.list",
      help: {
        summary: "account.applications.list lists OAuth applications you have authorized.",
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
        examples: ["account.applications.list", "account.applications.list --format json"],
      },
      parse: defineCliArgsParser("account.applications.list", {
        pageSize: { kind: "positiveInteger" },
        cursor: { kind: "string" },
      }),
      format: (result, options) =>
        options.format === "json" || options.print
          ? { data: result }
          : {
              data: result,
              stdout: [
                result.consents.length
                  ? `Authorized applications (${result.consents.length}):`
                  : "No authorized applications.",
                ...result.consents.map((consent) =>
                  [
                    consent.clientName,
                    `  Client ID: ${consent.clientId}`,
                    `  Scopes: ${consent.scopes.join(" ") || "none"}`,
                    `  Authorized at: ${consent.createdAt}`,
                  ].join("\n"),
                ),
                `More results: ${result.hasNextPage ? "yes" : "no"}`,
                `Next cursor: ${result.nextCursor ?? "none"}`,
                "",
              ].join("\n"),
            },
    },
  },
});

export const accountRuntimeTools = [
  getProfileTool,
  updateProfileTool,
  listOrganizationsTool,
  listInvitationsTool,
  acceptInvitationTool,
  listApplicationsTool,
] as const;

export const accountToolFamily = defineBackofficeRuntimeToolFamily({
  namespace: "account",
  permissions: {
    read: "Read your own profile, organizations, invitations, and authorized applications.",
    manage: "Change your display name and accept invitations addressed to you.",
  },
  tools: accountRuntimeTools,
  isAvailable: (context: AccountToolContext) => !!context.runtimes.account,
});
