import { z } from "zod";

import type {
  AdminOrganizationMemberRecord,
  AdminOrganizationRecord,
} from "@/backoffice-runtime/object-registry";
import { defineCliArgsParser } from "@/fragno/runtime-tools/bash-cli";

import {
  defineBackofficeRuntimeTool,
  defineBackofficeRuntimeToolFamily,
  type BackofficeToolContext,
} from "../runtime-tools";

export type AdminRuntime = {
  createOrganization(input: {
    name: string;
    slug: string;
    ownerEmail: string;
  }): Promise<AdminOrganizationRecord>;
  addOrganizationMember(input: {
    organizationSlug: string;
    userEmail: string;
    roles: readonly string[];
  }): Promise<AdminOrganizationMemberRecord>;
  removeOrganizationMember(input: {
    organizationSlug: string;
    userEmail: string;
  }): Promise<AdminOrganizationMemberRecord>;
};

type AdminToolContext = BackofficeToolContext<{ admin?: AdminRuntime }>;

const organizationRecordSchema = z.strictObject({
  organizationId: z.string().trim().min(1),
  name: z.string().trim().min(1),
  slug: z.string().trim().min(1),
  ownerUserId: z.string().trim().min(1),
});

const organizationMemberRecordSchema = z.strictObject({
  organizationId: z.string().trim().min(1),
  userId: z.string().trim().min(1),
  roles: z.array(z.string().trim().min(1)).min(1),
});

const createOrganizationInputSchema = z.strictObject({
  name: z.string().trim().min(1),
  slug: z.string().trim().min(1),
  ownerEmail: z.string().trim().toLowerCase().pipe(z.email()),
});

const addOrganizationMemberInputSchema = z.strictObject({
  organizationSlug: z.string().trim().min(1),
  userEmail: z.string().trim().toLowerCase().pipe(z.email()),
  roles: z.array(z.string().trim().min(1)).min(1),
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

const createOrganizationTool = defineBackofficeRuntimeTool({
  id: "admin.organisation.create",
  namespace: "admin",
  name: "organisationCreate",
  description: "Create an organization and assign its owner.",
  requiredPermissions: ["organizations.manage"],
  inputSchema: createOrganizationInputSchema,
  outputSchema: organizationRecordSchema,
  execute: async (input, context: AdminToolContext) =>
    await getAdminRuntime(context.runtimes.admin).createOrganization(input),
  adapters: {
    bash: {
      command: "admin.organisation.create",
      help: {
        summary: "admin.organisation.create creates an organization and assigns its owner.",
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
          'admin.organisation.create --name "Acme" --slug acme --owner-email owner@example.com --format json',
        ],
      },
      parse: defineCliArgsParser("admin.organisation.create", {
        name: { kind: "string", required: true },
        slug: { kind: "string", required: true },
        ownerEmail: { kind: "string", required: true },
      }),
      format: (result) => ({ data: result }),
    },
  },
});

const addOrganizationMemberTool = defineBackofficeRuntimeTool({
  id: "admin.organisation.members.add",
  namespace: "admin",
  name: "organisationMembersAdd",
  description: "Add a user to an organization with explicit roles.",
  requiredPermissions: ["organizations.manage"],
  inputSchema: addOrganizationMemberInputSchema,
  outputSchema: organizationMemberRecordSchema,
  execute: async (input, context: AdminToolContext) =>
    await getAdminRuntime(context.runtimes.admin).addOrganizationMember(input),
  adapters: {
    bash: {
      command: "admin.organisation.members.add",
      help: {
        summary: "admin.organisation.members.add adds a user to an organization.",
        options: [
          {
            name: "organization-slug",
            valueRequired: true,
            valueName: "organization-slug",
            description: "Organization slug",
          },
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
            description: "Organization role; repeat for multiple roles",
          },
        ],
        examples: [
          "admin.organisation.members.add --organization-slug acme --email member@example.com --role member --format json",
        ],
      },
      parse: defineCliArgsParser("admin.organisation.members.add", {
        organizationSlug: { kind: "string", required: true },
        userEmail: { kind: "string", required: true, option: "email" },
        roles: { kind: "stringArray", required: true, option: "role" },
      }),
      format: (result) => ({ data: result }),
    },
  },
});

const removeOrganizationMemberTool = defineBackofficeRuntimeTool({
  id: "admin.organisation.members.remove",
  namespace: "admin",
  name: "organisationMembersRemove",
  description: "Remove a user from an organization.",
  requiredPermissions: ["organizations.manage"],
  inputSchema: removeOrganizationMemberInputSchema,
  outputSchema: organizationMemberRecordSchema,
  execute: async (input, context: AdminToolContext) =>
    await getAdminRuntime(context.runtimes.admin).removeOrganizationMember(input),
  adapters: {
    bash: {
      command: "admin.organisation.members.remove",
      help: {
        summary: "admin.organisation.members.remove removes a user from an organization.",
        options: [
          {
            name: "organization-slug",
            valueRequired: true,
            valueName: "organization-slug",
            description: "Organization slug",
          },
          {
            name: "email",
            valueRequired: true,
            valueName: "email",
            description: "Email address of the existing user",
          },
        ],
        examples: [
          "admin.organisation.members.remove --organization-slug acme --email member@example.com --format json",
        ],
      },
      parse: defineCliArgsParser("admin.organisation.members.remove", {
        organizationSlug: { kind: "string", required: true },
        userEmail: { kind: "string", required: true, option: "email" },
      }),
      format: (result) => ({ data: result }),
    },
  },
});

export const adminRuntimeTools = [
  createOrganizationTool,
  addOrganizationMemberTool,
  removeOrganizationMemberTool,
] as const;

export const adminToolFamily = defineBackofficeRuntimeToolFamily({
  namespace: "admin",
  permissions: {
    "organizations.manage": "Create organizations and manage organization membership.",
  },
  tools: adminRuntimeTools,
  isAvailable: (context: AdminToolContext) => !!context.runtimes.admin,
});
