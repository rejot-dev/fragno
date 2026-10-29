import { BACKOFFICE_PERMISSION } from "@fragno-dev/backoffice-api/v0/shared/permissions";
import { z } from "zod";

import {
  ACCESS_CODE_MAX_PAGE_SIZE,
  accessCodeRecordSchema,
  accessCodeRedemptionSchema,
  createAccessCodeInputSchema,
  revokeAccessCodeInputSchema,
  type AccessCodeRecord,
} from "@/fragno/access-codes/contracts";
import { defineCliArgsParser } from "@/fragno/runtime-tools/bash-cli";

import { defineBackofficeRuntimeTool } from "../runtime-tools";
import type { AdminAccessCode } from "./admin";
import { requireSystemAdminRuntime, type AdminSystemToolContext } from "./admin-system-runtime";

const adminAccessCodeSchema = accessCodeRecordSchema.extend({ url: z.url() });

function formatAccessCodeText(accessCode: AccessCodeRecord): string {
  return [
    `Access code ID: ${accessCode.id}`,
    `  Code: ${accessCode.code}`,
    `  Label: ${accessCode.label}`,
    `  Status: ${accessCode.status}`,
    `  Accounts: ${accessCode.redemptionCount}`,
    `  Expires at: ${accessCode.expiresAt ?? "never"}`,
    `  Created at: ${accessCode.createdAt}`,
  ].join("\n");
}

function formatAdminAccessCodeText(accessCode: AdminAccessCode): string {
  return `${formatAccessCodeText(accessCode)}\n  Sign-up link: ${accessCode.url}`;
}

const createAccessCodeTool = defineBackofficeRuntimeTool({
  id: "admin.access-codes.create",
  namespace: "admin",
  name: "accessCodesCreate",
  description:
    "Create an access code that lets people create their own Backoffice accounts, with GitHub or a password, and return its sign-up link. The code is random, or made from the label with codeSource 'label'.",
  requiredPermissions: [BACKOFFICE_PERMISSION.admin.accessCodesManage],
  inputSchema: createAccessCodeInputSchema.extend({
    codeSource: createAccessCodeInputSchema.shape.codeSource.default("random"),
    expiresInDays: createAccessCodeInputSchema.shape.expiresInDays.default(null),
  }),
  outputSchema: adminAccessCodeSchema,
  execute: async (input, context: AdminSystemToolContext) =>
    await requireSystemAdminRuntime(context, "access code management").createAccessCode(input),
  adapters: {
    bash: {
      command: "admin.access-codes.create",
      help: {
        summary:
          "admin.access-codes.create creates an access code for signing up and prints its sign-up link.",
        options: [
          {
            name: "label",
            required: true,
            valueRequired: true,
            valueName: "label",
            description: "What the code is for, such as who it was given to",
          },
          {
            name: "code-source",
            valueRequired: true,
            valueName: "random|label",
            description:
              "random (default), or label to make the code from the label, such as LAUNCH-2026",
          },
          {
            name: "expires-in-days",
            valueRequired: true,
            valueName: "days",
            description: "Days until the code expires (default: never)",
          },
        ],
        examples: [
          'admin.access-codes.create --label "Design partners"',
          'admin.access-codes.create --label "Ana" --expires-in-days 7',
          'admin.access-codes.create --label "Launch 2026" --code-source label',
          'admin.access-codes.create --label "Launch" --format json',
        ],
      },
      parse: defineCliArgsParser("admin.access-codes.create", {
        label: { kind: "string", required: true },
        codeSource: { kind: "string" },
        expiresInDays: { kind: "positiveInteger" },
      }),
      format: (result, options) =>
        options.format === "json" || options.print
          ? { data: result }
          : { data: result, stdout: `${result.url}\n` },
    },
  },
});

const listAccessCodesTool = defineBackofficeRuntimeTool({
  id: "admin.access-codes.list",
  namespace: "admin",
  name: "accessCodesList",
  description:
    "List access codes for signing up, newest first, with their codes and sign-up links, using cursor pagination.",
  requiredPermissions: [BACKOFFICE_PERMISSION.admin.accessCodesManage],
  inputSchema: z.strictObject({
    pageSize: z.number().int().min(1).max(ACCESS_CODE_MAX_PAGE_SIZE).default(25),
    cursor: z.string().min(1).nullable().default(null),
  }),
  outputSchema: z.strictObject({
    accessCodes: z.array(adminAccessCodeSchema),
    cursor: z.string().nullable(),
    hasNextPage: z.boolean(),
  }),
  execute: async (input, context: AdminSystemToolContext) =>
    await requireSystemAdminRuntime(context, "access code management").listAccessCodes(input),
  adapters: {
    bash: {
      command: "admin.access-codes.list",
      help: {
        summary: "admin.access-codes.list lists access codes for signing up, newest first.",
        options: [
          {
            name: "page-size",
            valueRequired: true,
            valueName: "count",
            description: `Page size, 1–${ACCESS_CODE_MAX_PAGE_SIZE} (default 25)`,
          },
          {
            name: "cursor",
            valueRequired: true,
            valueName: "cursor",
            description: "Cursor from the previous page",
          },
        ],
        examples: [
          "admin.access-codes.list",
          "admin.access-codes.list --format json",
          "admin.access-codes.list --cursor CURSOR --format json",
        ],
      },
      parse: defineCliArgsParser("admin.access-codes.list", {
        pageSize: { kind: "positiveInteger" },
        cursor: { kind: "string" },
      }),
      format: (result, options) => {
        if (options.format === "json" || options.print) {
          return { data: result };
        }
        return {
          data: result,
          stdout: [
            result.accessCodes.length
              ? `Access codes (${result.accessCodes.length}):`
              : "No access codes found.",
            ...result.accessCodes.map(formatAdminAccessCodeText),
            ...(result.hasNextPage && result.cursor ? [`Next cursor: ${result.cursor}`] : []),
            "",
          ].join("\n"),
        };
      },
    },
  },
});

const listAccessCodeRedemptionsTool = defineBackofficeRuntimeTool({
  id: "admin.access-codes.redemptions",
  namespace: "admin",
  name: "accessCodesRedemptions",
  description:
    "List the accounts an access code admitted, by email, newest first, using cursor pagination.",
  requiredPermissions: [BACKOFFICE_PERMISSION.admin.accessCodesManage],
  inputSchema: z.strictObject({
    code: z.string().min(1),
    pageSize: z.number().int().min(1).max(ACCESS_CODE_MAX_PAGE_SIZE).default(25),
    cursor: z.string().min(1).nullable().default(null),
  }),
  outputSchema: z.strictObject({
    accessCode: adminAccessCodeSchema,
    redemptions: z.array(accessCodeRedemptionSchema),
    cursor: z.string().nullable(),
    hasNextPage: z.boolean(),
  }),
  execute: async (input, context: AdminSystemToolContext) =>
    await requireSystemAdminRuntime(context, "access code management").listAccessCodeRedemptions(
      input,
    ),
  adapters: {
    bash: {
      command: "admin.access-codes.redemptions",
      help: {
        summary:
          "admin.access-codes.redemptions lists the accounts an access code admitted, newest first.",
        options: [
          {
            name: "code",
            required: true,
            valueRequired: true,
            valueName: "code",
            description: "The access code, from admin.access-codes.list",
          },
          {
            name: "page-size",
            valueRequired: true,
            valueName: "count",
            description: `Page size, 1–${ACCESS_CODE_MAX_PAGE_SIZE} (default 25)`,
          },
          {
            name: "cursor",
            valueRequired: true,
            valueName: "cursor",
            description: "Cursor from the previous page",
          },
        ],
        examples: [
          "admin.access-codes.redemptions --code LAUNCH-2026",
          "admin.access-codes.redemptions --code LAUNCH-2026 --format json",
        ],
      },
      parse: defineCliArgsParser("admin.access-codes.redemptions", {
        code: { kind: "string", required: true },
        pageSize: { kind: "positiveInteger" },
        cursor: { kind: "string" },
      }),
      format: (result, options) => {
        if (options.format === "json" || options.print) {
          return { data: result };
        }
        return {
          data: result,
          stdout: [
            `${result.accessCode.label} (${result.accessCode.code}) admitted ${result.accessCode.redemptionCount} ${result.accessCode.redemptionCount === 1 ? "account" : "accounts"}.`,
            ...result.redemptions.map(({ email, redeemedAt }) => `  ${email}  ${redeemedAt}`),
            ...(result.hasNextPage && result.cursor ? [`Next cursor: ${result.cursor}`] : []),
            "",
          ].join("\n"),
        };
      },
    },
  },
});

const revokeAccessCodeTool = defineBackofficeRuntimeTool({
  id: "admin.access-codes.revoke",
  namespace: "admin",
  name: "accessCodesRevoke",
  description:
    "Revoke an access code so it creates no more accounts. Accounts it already created stay.",
  requiredPermissions: [BACKOFFICE_PERMISSION.admin.accessCodesManage],
  inputSchema: revokeAccessCodeInputSchema,
  outputSchema: accessCodeRecordSchema,
  execute: async (input, context: AdminSystemToolContext) =>
    await requireSystemAdminRuntime(context, "access code management").revokeAccessCode(input),
  adapters: {
    bash: {
      command: "admin.access-codes.revoke",
      help: {
        summary: "admin.access-codes.revoke revokes an access code.",
        options: [
          {
            name: "id",
            required: true,
            valueRequired: true,
            valueName: "id",
            description: "Access code ID, from admin.access-codes.list",
          },
        ],
        examples: ["admin.access-codes.revoke --id ACCESS_CODE_ID"],
      },
      parse: defineCliArgsParser("admin.access-codes.revoke", {
        accessCodeId: { kind: "string", required: true, option: "id" },
      }),
      format: (result, options) =>
        options.format === "json" || options.print
          ? { data: result }
          : { data: result, stdout: `${formatAccessCodeText(result)}\n` },
    },
  },
});

export const adminAccessCodesRuntimeTools = [
  createAccessCodeTool,
  listAccessCodesTool,
  listAccessCodeRedemptionsTool,
  revokeAccessCodeTool,
] as const;
