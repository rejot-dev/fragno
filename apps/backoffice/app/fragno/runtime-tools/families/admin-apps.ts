import { appActionsDeclarationSchema, appTrustSchema } from "@fragno-dev/backoffice-api/v0/apps";
import { BACKOFFICE_PERMISSION } from "@fragno-dev/backoffice-api/v0/shared/permissions";

import {
  backofficeAppActionsUpdateInputSchema,
  backofficeAppActionsUpdateResultSchema,
  backofficeAppPageInputSchema,
  backofficeAppPageSchema,
  backofficeAppPermissionsUpdateInputSchema,
  backofficeAppPermissionsUpdateResultSchema,
  backofficeAppRegistrationInputSchema,
  backofficeAppRegistrationResultSchema,
  backofficeAppTrustUpdateInputSchema,
  backofficeAppTrustUpdateResultSchema,
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

const trustOption = {
  name: "trust-json",
  valueRequired: true,
  valueName: "json",
  description:
    'Trust: {"kind":"third-party"}, or {"kind":"first-party","provisioningPermissions":["organizations.provision","projects.provision","invitations.send","invitations.accept"],"branding":{"displayName","logoUrl","accentColor":"#rrggbb","homeUrl","supportUrl"}} for an app Backoffice operates',
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
    trust: appTrustSchema.default({ kind: "third-party" }),
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
          { ...trustOption, description: `${trustOption.description} (default: third-party)` },
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
        trust: { kind: "json", option: "trust-json" },
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

const updateAppPermissionsTool = defineBackofficeRuntimeTool({
  id: "admin.apps.update-permissions",
  namespace: "admin",
  name: "appsUpdatePermissions",
  description:
    "Replace the permissions a registered app requests. A first-party app's installations follow the new request within a minute. A third-party app's installations keep the grants their owner approved: an added permission applies once an owner grants it (apps.installations.update or the install page), and a removed one stays granted until an owner changes the installation's access.",
  requiredPermissions: [BACKOFFICE_PERMISSION.admin.appsManage],
  inputSchema: backofficeAppPermissionsUpdateInputSchema,
  outputSchema: backofficeAppPermissionsUpdateResultSchema,
  execute: async (input, context: AdminAppsToolContext) =>
    await requireAdminAppsRuntime(context).updateAppPermissions(input),
  adapters: {
    bash: {
      command: "admin.apps.update-permissions",
      help: {
        summary:
          "admin.apps.update-permissions replaces the permissions an app requests (System administrators only).",
        options: [
          {
            name: "app-id",
            required: true,
            valueRequired: true,
            valueName: "id",
            description: "Registered Backoffice app ID",
          },
          {
            name: "requested-permissions-json",
            required: true,
            valueRequired: true,
            valueName: "json",
            description:
              "JSON array of canonical namespace/permission requirements; use [] for no capabilities",
          },
        ],
        examples: [
          'admin.apps.update-permissions --app-id APP_ID --requested-permissions-json \'[{"namespace":"org","permission":"read"}]\'',
        ],
      },
      parse: defineCliArgsParser("admin.apps.update-permissions", {
        appId: { kind: "string", required: true },
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
              stdout: result.changed
                ? "Updated app permissions.\n"
                : "App permissions unchanged.\n",
            },
    },
  },
});

const updateAppTrustTool = defineBackofficeRuntimeTool({
  id: "admin.apps.update-trust",
  namespace: "admin",
  name: "appsUpdateTrust",
  description:
    "Set whether Backoffice operates a registered app. A first-party app is authorized without a consent screen and cannot be revoked by users, is linked to organizations without a permission review, lets anyone sign up through it, has Backoffice's sign-in speak in its name (its branding), and may call the provisioning operations it is granted.",
  requiredPermissions: [BACKOFFICE_PERMISSION.admin.appsManage],
  inputSchema: backofficeAppTrustUpdateInputSchema,
  outputSchema: backofficeAppTrustUpdateResultSchema,
  execute: async (input, context: AdminAppsToolContext) =>
    await requireAdminAppsRuntime(context).updateAppTrust(input),
  adapters: {
    bash: {
      command: "admin.apps.update-trust",
      help: {
        summary:
          "admin.apps.update-trust sets whether Backoffice operates an app (System administrators only).",
        options: [
          {
            name: "app-id",
            required: true,
            valueRequired: true,
            valueName: "id",
            description: "Registered Backoffice app ID",
          },
          { ...trustOption, required: true },
        ],
        examples: [
          'admin.apps.update-trust --app-id APP_ID --trust-json \'{"kind":"first-party","provisioningPermissions":["organizations.provision"],"branding":{"displayName":"Bookkeeping","logoUrl":"https://bookkeeping.example/logo.svg","accentColor":"#2f6f4e","homeUrl":"https://bookkeeping.example","supportUrl":"https://bookkeeping.example/help"}}\'',
        ],
      },
      parse: defineCliArgsParser("admin.apps.update-trust", {
        appId: { kind: "string", required: true },
        trust: { kind: "json", option: "trust-json", required: true },
      }),
      format: (result, options) =>
        options.format === "json" || options.print
          ? { data: result }
          : {
              data: result,
              stdout: result.changed ? "Updated app trust.\n" : "App trust unchanged.\n",
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
            `  Trust: ${app.trust.kind === "third-party" ? "third-party" : `first-party as ${app.trust.branding.displayName}, provisioning ${app.trust.provisioningPermissions.join(", ") || "none"}`}`,
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
export const adminAppsRuntimeTools = [
  createAppTool,
  listAppsTool,
  updateAppActionsTool,
  updateAppPermissionsTool,
  updateAppTrustTool,
] as const;
