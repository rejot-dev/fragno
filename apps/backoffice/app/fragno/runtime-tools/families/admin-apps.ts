import { appActionsDeclarationSchema } from "@fragno-dev/backoffice-api/v0/apps";
import { BACKOFFICE_PERMISSION } from "@fragno-dev/backoffice-api/v0/shared/permissions";

import {
  backofficeAppActionsUpdateInputSchema,
  backofficeAppActionsUpdateResultSchema,
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

const actionsOption = {
  name: "actions-json",
  valueRequired: true,
  valueName: "json",
  description:
    'Action declaration: {"kind":"none"}, or {"kind":"endpoint","endpointUrl":"https://...","changeApproval":"installation"|"automatic","actions":[{"id","label","description","inputSchema","outputSchema"}]}',
};

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
  requiredPermissions: [BACKOFFICE_PERMISSION.admin.appsManage],
  inputSchema: backofficeAppRegistrationInputSchema.extend({
    actions: appActionsDeclarationSchema.default({ kind: "none" }),
  }),
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
            name: "slug",
            required: true,
            valueRequired: true,
            valueName: "slug",
            description:
              "Unique, permanent app name, e.g. bookkeeping; its integration connection is app#<slug>",
          },
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
          { ...actionsOption, description: `${actionsOption.description} (default: none)` },
        ],
        examples: [
          "admin.apps.create --slug accounting --oauth-client-id accounting-client --requested-permissions-json '[]'",
          'admin.apps.create --slug accounting --oauth-client-id accounting-client --requested-permissions-json \'[{"namespace":"events","permission":"emit"}]\' --format json',
        ],
      },
      parse: defineCliArgsParser("admin.apps.create", {
        slug: { kind: "string", required: true },
        oauthClientId: { kind: "string", required: true },
        requestedPermissions: {
          kind: "json",
          option: "requested-permissions-json",
          required: true,
        },
        actions: { kind: "json", option: "actions-json" },
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

const updateAppActionsTool = defineBackofficeRuntimeTool({
  id: "admin.apps.update-actions",
  namespace: "admin",
  name: "appsUpdateActions",
  description:
    "Replace a registered app's action declaration. A changed declaration gets a new revision; installations approve it before new or changed actions run, unless its changeApproval is automatic.",
  requiredPermissions: [BACKOFFICE_PERMISSION.admin.appsManage],
  inputSchema: backofficeAppActionsUpdateInputSchema,
  outputSchema: backofficeAppActionsUpdateResultSchema,
  execute: async (input, context: AdminAppsToolContext) =>
    await requireAdminAppsRuntime(context).updateAppActions(input),
  adapters: {
    bash: {
      command: "admin.apps.update-actions",
      help: {
        summary:
          "admin.apps.update-actions replaces an app's action declaration (System administrators only).",
        options: [
          {
            name: "app-id",
            required: true,
            valueRequired: true,
            valueName: "id",
            description: "Registered Backoffice app ID",
          },
          { ...actionsOption, required: true },
        ],
        examples: ['admin.apps.update-actions --app-id APP_ID --actions-json \'{"kind":"none"}\''],
      },
      parse: defineCliArgsParser("admin.apps.update-actions", {
        appId: { kind: "string", required: true },
        actions: { kind: "json", option: "actions-json", required: true },
      }),
      format: (result, options) =>
        options.format === "json" || options.print
          ? { data: result }
          : {
              data: result,
              stdout: `${result.changed ? "Updated app actions." : "App actions unchanged."}\nActions revision: ${result.actionsRevision}\n`,
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
  requiredPermissions: [BACKOFFICE_PERMISSION.admin.appsRead],
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
            `  Slug: ${app.slug}`,
            `  OAuth client ID: ${app.oauthClientId}`,
            `  Requested permissions: ${app.requestedPermissions.map(({ namespace, permission }) => `${namespace}.${permission}`).join(", ") || "none"}`,
            `  Actions: ${app.actions.kind === "none" ? "none" : `${app.actions.actions.map(({ id }) => id).join(", ")} at ${app.actions.endpointUrl}`} (revision ${app.actionsRevision})`,
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
export const adminAppsRuntimeTools = [createAppTool, listAppsTool, updateAppActionsTool] as const;
