import { z } from "zod";

import { BACKOFFICE_PERMISSION } from "@/backoffice-runtime/permissions";
import { organizationRoleSchema, type OrganizationRole } from "@/fragno/auth/contracts";
import {
  directoryPageInputSchema,
  organizationInvitationRecordSchema,
  organizationMemberPageSchema,
  organizationMembershipRecordSchema,
  organizationRecordSchema,
  type DirectoryPageInput,
  type OrganizationMemberPage,
  type OrganizationMembershipRecord,
  type OrganizationPage,
  type OrganizationRecord,
} from "@/fragno/auth/directory-records";
import { defineCliArgsParser, defineNoInputArgsParser } from "@/fragno/runtime-tools/bash-cli";

import {
  defineBackofficeRuntimeTool,
  defineBackofficeRuntimeToolFamily,
  type BackofficeToolContext,
} from "../runtime-tools";

const organizationInvitationLinkSchema = organizationInvitationRecordSchema
  .extend({ url: z.url() })
  .meta({ id: "OrganizationInvitationLink" });
type OrganizationInvitationLink = z.output<typeof organizationInvitationLinkSchema>;

const organizationInvitationLinkPageSchema = z
  .strictObject({
    invitations: z.array(organizationInvitationLinkSchema),
    nextCursor: z.string().nullable(),
    hasNextPage: z.boolean(),
  })
  .meta({ id: "OrganizationInvitationLinkPage" });
type OrganizationInvitationLinkPage = z.output<typeof organizationInvitationLinkPageSchema>;

/** Acts on the scoped organization as the current user principal; neither is caller input. */
export type OrganizationRuntime = {
  get(): Promise<OrganizationMembershipRecord>;
  update(input: { name: string }): Promise<OrganizationRecord>;
  listMembers(input: DirectoryPageInput): Promise<OrganizationMemberPage>;
  listInvitations(input: DirectoryPageInput): Promise<OrganizationInvitationLinkPage>;
  createInvitation(input: {
    email: string;
    roles: OrganizationRole[];
  }): Promise<OrganizationInvitationLink>;
};

type OrganizationToolContext = BackofficeToolContext<{ org?: OrganizationRuntime }>;

function getOrganizationRuntime(runtime: OrganizationRuntime | undefined): OrganizationRuntime {
  if (!runtime) {
    throw new Error("Organization commands require organization context and a user principal.");
  }
  return runtime;
}

const pageOptions = [
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
];

const pageFields = {
  pageSize: { kind: "positiveInteger" },
  cursor: { kind: "string" },
} as const;

function formatPageFooter(page: { hasNextPage: boolean; nextCursor: string | null }): string[] {
  return [
    `More results: ${page.hasNextPage ? "yes" : "no"}`,
    `Next cursor: ${page.nextCursor ?? "none"}`,
  ];
}

export function formatOrganizationText(organization: OrganizationRecord): string {
  return [
    `Organization: ${organization.name}`,
    `  Slug: ${organization.slug}`,
    `  ID: ${organization.organizationId}`,
    `  Created at: ${organization.createdAt}`,
  ].join("\n");
}

export function formatOrganizationPageText(page: OrganizationPage): string {
  return [
    page.organizations.length
      ? `Organizations (${page.organizations.length}):`
      : "No organizations found.",
    ...page.organizations.map(formatOrganizationText),
    ...formatPageFooter(page),
    "",
  ].join("\n");
}

export function formatOrganizationMemberPageText(page: OrganizationMemberPage): string {
  return [
    page.members.length ? `Members (${page.members.length}):` : "No members found.",
    ...page.members.map((member) =>
      [
        `${member.email} (${member.roles.join(", ")})`,
        `  Name: ${member.name}`,
        `  User ID: ${member.userId}`,
        `  Joined at: ${member.joinedAt}`,
      ].join("\n"),
    ),
    ...formatPageFooter(page),
    "",
  ].join("\n");
}

function formatInvitationText(invitation: OrganizationInvitationLink): string {
  return [
    `${invitation.email} (${invitation.roles.join(", ")})`,
    `  Invitation ID: ${invitation.invitationId}`,
    `  Link: ${invitation.url}`,
    `  Expires at: ${invitation.expiresAt}`,
  ].join("\n");
}

const getOrganizationTool = defineBackofficeRuntimeTool({
  id: "org.get",
  namespace: "org",
  name: "get",
  description: "Read the current organization and your roles in it.",
  requiredPermissions: [BACKOFFICE_PERMISSION.org.read.permission],
  inputSchema: z.void(),
  outputSchema: organizationMembershipRecordSchema,
  execute: async (_input, context: OrganizationToolContext) =>
    await getOrganizationRuntime(context.runtimes.org).get(),
  adapters: {
    bash: {
      command: "org.get",
      help: {
        summary: "org.get prints the current organization and your roles in it.",
        options: [],
        examples: ["org.get", "org.get --format json", "org.get --print organization.slug"],
      },
      parse: defineNoInputArgsParser("org.get"),
      format: (result, options) =>
        options.format === "json" || options.print
          ? { data: result }
          : {
              data: result,
              stdout: `${formatOrganizationText(result.organization)}\n  Your roles: ${result.roles.join(", ")}\n`,
            },
    },
  },
});

const updateOrganizationTool = defineBackofficeRuntimeTool({
  id: "org.update",
  namespace: "org",
  name: "update",
  description: "Rename the current organization. Requires the owner or admin role.",
  requiredPermissions: [BACKOFFICE_PERMISSION.org.manage.permission],
  inputSchema: z.strictObject({ name: z.string().trim().min(1) }),
  outputSchema: organizationRecordSchema,
  execute: async (input, context: OrganizationToolContext) =>
    await getOrganizationRuntime(context.runtimes.org).update(input),
  adapters: {
    bash: {
      command: "org.update",
      help: {
        summary: "org.update renames the current organization (owners and admins).",
        options: [
          {
            name: "name",
            valueRequired: true,
            valueName: "name",
            description: "New organization name",
          },
        ],
        examples: ['org.update --name "Acme Inc."'],
      },
      parse: defineCliArgsParser("org.update", { name: { kind: "string", required: true } }),
      format: (result, options) =>
        options.format === "json" || options.print
          ? { data: result }
          : { data: result, stdout: `${formatOrganizationText(result)}\n` },
    },
  },
});

const listMembersTool = defineBackofficeRuntimeTool({
  id: "org.members.list",
  namespace: "org",
  name: "membersList",
  description:
    "List members of the current organization with their roles, using cursor pagination.",
  requiredPermissions: [BACKOFFICE_PERMISSION.org.read.permission],
  inputSchema: directoryPageInputSchema,
  outputSchema: organizationMemberPageSchema,
  execute: async (input, context: OrganizationToolContext) =>
    await getOrganizationRuntime(context.runtimes.org).listMembers(input),
  adapters: {
    bash: {
      command: "org.members.list",
      help: {
        summary: "org.members.list lists members of the current organization.",
        options: pageOptions,
        examples: [
          "org.members.list",
          "org.members.list --format json",
          "org.members.list --page-size 10 --cursor CURSOR",
        ],
      },
      parse: defineCliArgsParser("org.members.list", pageFields),
      format: (result, options) =>
        options.format === "json" || options.print
          ? { data: result }
          : { data: result, stdout: formatOrganizationMemberPageText(result) },
    },
  },
});

const listInvitationsTool = defineBackofficeRuntimeTool({
  id: "org.invitations.list",
  namespace: "org",
  name: "invitationsList",
  description:
    "List pending, unexpired invitations to the current organization with their shareable links, using cursor pagination.",
  requiredPermissions: [BACKOFFICE_PERMISSION.org.read.permission],
  inputSchema: directoryPageInputSchema,
  outputSchema: organizationInvitationLinkPageSchema,
  execute: async (input, context: OrganizationToolContext) =>
    await getOrganizationRuntime(context.runtimes.org).listInvitations(input),
  adapters: {
    bash: {
      command: "org.invitations.list",
      help: {
        summary: "org.invitations.list lists pending invitations to the current organization.",
        options: pageOptions,
        examples: [
          "org.invitations.list",
          "org.invitations.list --format json",
          "org.invitations.list --page-size 10 --cursor CURSOR",
        ],
      },
      parse: defineCliArgsParser("org.invitations.list", pageFields),
      format: (result, options) =>
        options.format === "json" || options.print
          ? { data: result }
          : {
              data: result,
              stdout: [
                result.invitations.length
                  ? `Pending invitations (${result.invitations.length}):`
                  : "No pending invitations.",
                ...result.invitations.map(formatInvitationText),
                ...formatPageFooter(result),
                "",
              ].join("\n"),
            },
    },
  },
});

const createInvitationTool = defineBackofficeRuntimeTool({
  id: "org.invitations.create",
  namespace: "org",
  name: "invitationsCreate",
  description:
    "Invite an email address to the current organization and return a shareable link. Invitations are not emailed. Requires the owner or admin role; only owners may invite owners.",
  requiredPermissions: [BACKOFFICE_PERMISSION.org.manage.permission],
  inputSchema: z.strictObject({
    email: z.string().trim().toLowerCase().pipe(z.email()),
    roles: z.array(organizationRoleSchema).min(1),
  }),
  outputSchema: organizationInvitationLinkSchema,
  execute: async (input, context: OrganizationToolContext) =>
    await getOrganizationRuntime(context.runtimes.org).createInvitation(input),
  adapters: {
    bash: {
      command: "org.invitations.create",
      help: {
        summary:
          "org.invitations.create invites an email to the current organization and prints the invitation link. Invitations are not emailed.",
        options: [
          {
            name: "email",
            valueRequired: true,
            valueName: "email",
            description: "Email address to invite",
          },
          {
            name: "role",
            valueRequired: true,
            valueName: "role",
            description: "owner, admin, or member; repeat for multiple roles",
          },
        ],
        examples: [
          "org.invitations.create --email person@example.com --role member",
          "org.invitations.create --email person@example.com --role admin --format json",
        ],
      },
      parse: defineCliArgsParser("org.invitations.create", {
        email: { kind: "string", required: true },
        roles: { kind: "stringArray", required: true, option: "role" },
      }),
      format: (result, options) =>
        options.format === "json" || options.print
          ? { data: result }
          : { data: result, stdout: `${result.url}\n` },
    },
  },
});

export const organizationRuntimeTools = [
  getOrganizationTool,
  updateOrganizationTool,
  listMembersTool,
  listInvitationsTool,
  createInvitationTool,
] as const;

export const organizationToolFamily = defineBackofficeRuntimeToolFamily({
  namespace: "org",
  permissions: {
    read: "Read the current organization, its members, and pending invitations.",
    manage: "Rename the current organization and invite members (owners and admins only).",
  },
  tools: organizationRuntimeTools,
  isAvailable: (context: OrganizationToolContext) => !!context.runtimes.org,
});
