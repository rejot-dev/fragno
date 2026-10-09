import { BACKOFFICE_PERMISSION } from "@fragno-dev/backoffice-api/v0/shared/permissions";

import {
  backofficeAppPageInputSchema,
  backofficeAppPageSchema,
  backofficeAppRegistrationInputSchema,
  backofficeAppRegistrationResultSchema,
} from "@/fragno/apps/contracts";
import { defineCliArgsParser } from "@/fragno/runtime-tools/bash-cli";

import { defineBackofficeRuntimeTool, type BackofficeToolContext } from "../runtime-tools";
import type { AdminRuntime } from "./admin";

type AdminAppsToolContext = BackofficeToolContext<Partial<{ admin: AdminRuntime }>>;

const listAppsInputSchema = backofficeAppPageInputSchema.extend({
  pageSize: backofficeAppPageInputSchema.shape.pageSize.default(25),
  cursor: backofficeAppPageInputSchema.shape.cursor.default(null),
});

function requireAdminAppsRuntime(context: AdminAppsToolContext): AdminRuntime {
  if (context.execution.scope.kind !== "system") {
    throw new Error("Admin app management requires System context.");
  }
  const admin = context.runtimes.admin;
  if (!admin) {
    throw new Error("Admin app runtime is not available in this execution context.");
  }
  return admin;
}

const createAppTool = defineBackofficeRuntimeTool({
  id: "admin.apps.create",
  namespace: "admin",
  name: "appsCreate",
  description:
    "Register a Backoffice app for an existing Better Auth OAuth client. Does not provision OAuth credentials or install the app.",
  requiredPermissions: [BACKOFFICE_PERMISSION.admin.appsManage.permission],
  inputSchema: backofficeAppRegistrationInputSchema,
  outputSchema: backofficeAppRegistrationResultSchema,
  execute: async (input, context: AdminAppsToolContext) =>
    await requireAdminAppsRuntime(context).createApp(input),
  adapters: {
    bash: {
      command: "admin.apps.create",
      help: {
        summary:
          "admin.apps.create registers an existing OAuth client as a Backoffice app (System administrators only).",
        options: [
          {
            name: "oauth-client-id",
            valueRequired: true,
            valueName: "id",
            description: "Existing Better Auth OAuth client ID",
          },
          {
            name: "requested-permissions-json",
            valueRequired: true,
            valueName: "json",
            description:
              "JSON array of canonical namespace/permission requirements; use [] for no capabilities",
          },
        ],
        examples: [
          "admin.apps.create --oauth-client-id accounting-client --requested-permissions-json '[]'",
          'admin.apps.create --oauth-client-id accounting-client --requested-permissions-json \'[{"namespace":"events","permission":"emit"}]\' --format json',
        ],
      },
      parse: defineCliArgsParser("admin.apps.create", {
        oauthClientId: { kind: "string", required: true },
        requestedPermissions: {
          kind: "json",
          option: "requested-permissions-json",
          required: true,
        },
      }),
      format: (result, options) =>
        options.format === "json" || options.print
          ? { data: result }
          : {
              data: result,
              stdout: `${result.created ? "Registered Backoffice app." : "Backoffice app already registered."}\nApp ID: ${result.appId}\n`,
            },
    },
  },
});

const listAppsTool = defineBackofficeRuntimeTool({
  id: "admin.apps.list",
  namespace: "admin",
  name: "appsList",
  description:
    "List global Backoffice app registrations using cursor pagination. Does not expose OAuth credentials or organization installations.",
  requiredPermissions: [BACKOFFICE_PERMISSION.admin.appsRead.permission],
  inputSchema: listAppsInputSchema,
  outputSchema: backofficeAppPageSchema,
  execute: async (input, context: AdminAppsToolContext) =>
    await requireAdminAppsRuntime(context).listApps(input),
  adapters: {
    bash: {
      command: "admin.apps.list",
      help: {
        summary: "admin.apps.list lists app registrations (System administrators only).",
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
        examples: [
          "admin.apps.list",
          "admin.apps.list --format json",
          "admin.apps.list --page-size 10 --cursor CURSOR --format json",
        ],
      },
      parse: defineCliArgsParser("admin.apps.list", {
        pageSize: { kind: "positiveInteger" },
        cursor: { kind: "string" },
      }),
      format: (result, options) => {
        if (options.format === "json" || options.print) {
          return { data: result };
        }
        const entries = result.apps.map((app) =>
          [
            `App ID: ${app.id}`,
            `  OAuth client ID: ${app.oauthClientId}`,
            `  Requested permissions: ${app.requestedPermissions.map(({ namespace, permission }) => `${namespace}.${permission}`).join(", ") || "none"}`,
            `  Created at: ${app.createdAt}`,
          ].join("\n"),
        );
        return {
          data: result,
          stdout: [
            result.apps.length
              ? `Backoffice apps (${result.apps.length}):`
              : "No Backoffice apps found.",
            ...entries,
            `More results: ${result.hasNextPage ? "yes" : "no"}`,
            `Next cursor: ${result.nextCursor ?? "none"}`,
            "",
          ].join("\n"),
        };
      },
    },
  },
});

/** App management tools inherit admin kernel authorization and additionally require System scope. */
export const adminAppsRuntimeTools = [createAppTool, listAppsTool] as const;
