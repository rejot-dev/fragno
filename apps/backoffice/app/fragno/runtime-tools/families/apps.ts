import {
  appInstallationResourceScopeSchema,
  backofficeAppInstallationAccessInputSchema,
  backofficeAppInstallationMutationResultSchema,
  backofficeAppInstallationPageInputSchema,
  backofficeAppInstallationPageSchema,
  backofficeAppInstallationSchema,
  type BackofficeAppInstallation,
} from "@/fragno/app-installations/contracts";
import { backofficeAppLookupInputSchema, backofficeAppSchema } from "@/fragno/apps/contracts";
import { defineCliArgsParser } from "@/fragno/runtime-tools/bash-cli";

import {
  defineBackofficeRuntimeTool,
  defineBackofficeRuntimeToolFamily,
  type BackofficeToolContext,
} from "../runtime-tools";
import type { AppsRuntime } from "./apps-runtime";

type AppsToolContext = BackofficeToolContext<{ apps: AppsRuntime | undefined }>;

function requireAppsContext(context: AppsToolContext) {
  if (context.execution.scope.kind !== "org") {
    throw new Error("App installation management requires organization context.");
  }
  const principal = context.execution.actors.principal;
  if (
    principal?.scope !== "internal" ||
    principal.type !== "user" ||
    context.execution.actors.delegation.length !== 0
  ) {
    throw new Error("App installation management requires an undelegated user principal.");
  }
  const apps = context.runtimes.apps;
  if (!apps) {
    throw new Error("App installation runtime is not available in this execution context.");
  }
  return { apps, userId: principal.id };
}

const appIdOption = {
  name: "app-id",
  required: true,
  valueRequired: true,
  valueName: "id",
  description: "Registered Backoffice app ID (not an OAuth client ID)",
};
const grantsOption = {
  name: "granted-permissions-json",
  required: true,
  valueRequired: true,
  valueName: "json",
  description: "Explicitly approved subset of requested permissions; use [] for no grants",
};
const resourceScopeDescription =
  'Resources the grants apply to: {"kind":"organization"} or {"kind":"projects","projectIds":["..."]}';

const getAppTool = defineBackofficeRuntimeTool({
  id: "apps.get",
  namespace: "apps",
  name: "get",
  description: "Review a registered app's requested permissions before approving an installation.",
  requiredPermissions: ["read"],
  inputSchema: backofficeAppLookupInputSchema,
  outputSchema: backofficeAppSchema.nullable(),
  execute: async (input, context: AppsToolContext) =>
    await requireAppsContext(context).apps.getApp(input),
  adapters: {
    bash: {
      command: "apps.get",
      help: {
        summary: "apps.get reviews a global app declaration from organization context.",
        options: [appIdOption],
        examples: ["apps.get --app-id APP_ID"],
      },
      parse: defineCliArgsParser("apps.get", { appId: { kind: "string", required: true } }),
      format: (app, options) =>
        options.format === "json" || options.print
          ? { data: app }
          : {
              data: app,
              stdout: app
                ? [
                    `App ID: ${app.id}`,
                    `OAuth client ID: ${app.oauthClientId}`,
                    `Requested permissions: ${app.requestedPermissions.map(({ namespace, permission }) => `${namespace}.${permission}`).join(", ") || "none"}`,
                    `Created at: ${app.createdAt}`,
                    "",
                  ].join("\n")
                : "Backoffice app was not found.\n",
            },
    },
  },
});

const installAppTool = defineBackofficeRuntimeTool({
  id: "apps.install",
  namespace: "apps",
  name: "install",
  description:
    "Approve an app installation in the selected organization, limited to explicit permissions and resources. Installer identity comes from the authenticated user.",
  requiredPermissions: ["manage"],
  inputSchema: backofficeAppInstallationAccessInputSchema.extend({
    resourceScope: appInstallationResourceScopeSchema.default({ kind: "organization" }),
  }),
  outputSchema: backofficeAppInstallationMutationResultSchema,
  execute: async (input, context: AppsToolContext) => {
    const { apps, userId } = requireAppsContext(context);
    return await apps.installApp(input, userId);
  },
  adapters: {
    bash: {
      command: "apps.install",
      help: {
        summary:
          "apps.install approves an organization-owned installation (organization owners/admins only). The app can then act only within these grants and resources; OAuth user consent is separate.",
        options: [
          appIdOption,
          grantsOption,
          {
            name: "resource-scope-json",
            valueRequired: true,
            valueName: "json",
            description: `${resourceScopeDescription} (default: whole organization)`,
          },
        ],
        examples: [
          "apps.install --app-id APP_ID --granted-permissions-json '[]'",
          'apps.install --app-id APP_ID --granted-permissions-json \'[{"namespace":"events","permission":"emit"}]\' --resource-scope-json \'{"kind":"projects","projectIds":["PROJECT_ID"]}\'',
        ],
      },
      parse: defineCliArgsParser("apps.install", {
        appId: { kind: "string", required: true },
        grantedPermissions: { kind: "json", option: "granted-permissions-json", required: true },
        resourceScope: { kind: "json", option: "resource-scope-json" },
      }),
      format: (result, options) =>
        options.format === "json" || options.print
          ? { data: result }
          : {
              data: result,
              stdout: `${result.changed ? "Installed Backoffice app." : "Backoffice app already installed."}\nInstallation ID: ${result.installationId}\n`,
            },
    },
  },
});

const getInstallationTool = defineBackofficeRuntimeTool({
  id: "apps.installations.get",
  namespace: "apps",
  name: "getInstallation",
  description:
    "Inspect one app installation in the selected organization, including approved grants.",
  requiredPermissions: ["read"],
  inputSchema: backofficeAppLookupInputSchema,
  outputSchema: backofficeAppInstallationSchema.nullable(),
  execute: async (input, context: AppsToolContext) =>
    await requireAppsContext(context).apps.getInstallation(input),
  adapters: {
    bash: {
      command: "apps.installations.get",
      help: {
        summary: "apps.installations.get inspects an organization's installation by app ID.",
        options: [appIdOption],
        examples: ["apps.installations.get --app-id APP_ID --format json"],
      },
      parse: defineCliArgsParser("apps.installations.get", {
        appId: { kind: "string", required: true },
      }),
      format: (installation, options) =>
        options.format === "json" || options.print
          ? { data: installation }
          : {
              data: installation,
              stdout: installation
                ? `${renderInstallation(installation)}\n`
                : "Backoffice app installation was not found.\n",
            },
    },
  },
});

function renderInstallation(installation: BackofficeAppInstallation) {
  return [
    `Installation ID: ${installation.id}`,
    `  App ID: ${installation.appId}`,
    `  Organization ID: ${installation.organizationId}`,
    `  Status: ${installation.status}`,
    `  Activation: ${installation.activation}`,
    `  Granted permissions: ${installation.grantedPermissions.map(({ namespace, permission }) => `${namespace}.${permission}`).join(", ") || "none"}`,
    `  Resources: ${installation.resourceScope.kind === "organization" ? "whole organization" : `projects ${installation.resourceScope.projectIds.join(", ")}`}`,
    `  Linked account: ${installation.externalAccount ? `${installation.externalAccount.label} (${installation.externalAccount.id})` : "none"}`,
    `  Installed by user ID: ${installation.installedByUserId}`,
    `  Created at: ${installation.createdAt}`,
    `  Updated at: ${installation.updatedAt}`,
  ].join("\n");
}

const listInstallationsTool = defineBackofficeRuntimeTool({
  id: "apps.installations.list",
  namespace: "apps",
  name: "listInstallations",
  description:
    "List the selected organization's active and uninstalled apps using cursor pagination. Does not expose other organizations or OAuth credentials.",
  requiredPermissions: ["read"],
  inputSchema: backofficeAppInstallationPageInputSchema.extend({
    pageSize: backofficeAppInstallationPageInputSchema.shape.pageSize.default(25),
    cursor: backofficeAppInstallationPageInputSchema.shape.cursor.default(null),
  }),
  outputSchema: backofficeAppInstallationPageSchema,
  execute: async (input, context: AppsToolContext) =>
    await requireAppsContext(context).apps.listInstallations(input),
  adapters: {
    bash: {
      command: "apps.installations.list",
      help: {
        summary: "apps.installations.list lists installation history in organization context.",
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
            description: "Cursor from the previous page; keep the same page size and organization",
          },
        ],
        examples: [
          "apps.installations.list",
          "apps.installations.list --page-size 10 --format json",
        ],
      },
      parse: defineCliArgsParser("apps.installations.list", {
        pageSize: { kind: "positiveInteger" },
        cursor: { kind: "string" },
      }),
      format: (result, options) =>
        options.format === "json" || options.print
          ? { data: result }
          : {
              data: result,
              stdout: [
                result.installations.length
                  ? `Backoffice app installations (${result.installations.length}):`
                  : "No Backoffice app installations found.",
                ...result.installations.map(renderInstallation),
                `More results: ${result.hasNextPage ? "yes" : "no"}`,
                `Next cursor: ${result.nextCursor ?? "none"}`,
                "",
              ].join("\n"),
            },
    },
  },
});

const updateInstallationTool = defineBackofficeRuntimeTool({
  id: "apps.installations.update",
  namespace: "apps",
  name: "updateInstallation",
  description:
    "Replace an active installation's approved permissions and resources. Takes effect immediately, including for issued app credentials. Does not change installer attribution.",
  requiredPermissions: ["manage"],
  inputSchema: backofficeAppInstallationAccessInputSchema,
  outputSchema: backofficeAppInstallationMutationResultSchema,
  execute: async (input, context: AppsToolContext) =>
    await requireAppsContext(context).apps.updateInstallationAccess(input),
  adapters: {
    bash: {
      command: "apps.installations.update",
      help: {
        summary:
          "apps.installations.update replaces approved permissions and resources (organization owners/admins only). Both are required so access is never widened implicitly.",
        options: [
          appIdOption,
          grantsOption,
          {
            name: "resource-scope-json",
            required: true,
            valueRequired: true,
            valueName: "json",
            description: resourceScopeDescription,
          },
        ],
        examples: [
          "apps.installations.update --app-id APP_ID --granted-permissions-json '[]' --resource-scope-json '{\"kind\":\"organization\"}'",
        ],
      },
      parse: defineCliArgsParser("apps.installations.update", {
        appId: { kind: "string", required: true },
        grantedPermissions: { kind: "json", option: "granted-permissions-json", required: true },
        resourceScope: { kind: "json", option: "resource-scope-json", required: true },
      }),
      format: (result, options) =>
        options.format === "json" || options.print
          ? { data: result }
          : {
              data: result,
              stdout: `${result.changed ? "Updated installation access." : "Installation access unchanged."}\nInstallation ID: ${result.installationId}\n`,
            },
    },
  },
});

const uninstallAppTool = defineBackofficeRuntimeTool({
  id: "apps.uninstall",
  namespace: "apps",
  name: "uninstall",
  description:
    "Uninstall an app in the selected organization, clearing approved grants and its linked account while retaining installation identity. Immediately invalidates app credentials. Does not revoke personal OAuth consent.",
  requiredPermissions: ["manage"],
  inputSchema: backofficeAppLookupInputSchema,
  outputSchema: backofficeAppInstallationMutationResultSchema,
  execute: async (input, context: AppsToolContext) =>
    await requireAppsContext(context).apps.uninstallApp(input),
  adapters: {
    bash: {
      command: "apps.uninstall",
      help: {
        summary:
          "apps.uninstall clears organization installation grants (organization owners/admins only).",
        options: [appIdOption],
        examples: ["apps.uninstall --app-id APP_ID"],
      },
      parse: defineCliArgsParser("apps.uninstall", { appId: { kind: "string", required: true } }),
      format: (result, options) =>
        options.format === "json" || options.print
          ? { data: result }
          : {
              data: result,
              stdout: `${result.changed ? "Uninstalled Backoffice app." : "Backoffice app already uninstalled."}\nInstallation ID: ${result.installationId}\n`,
            },
    },
  },
});

export const appsToolFamily = defineBackofficeRuntimeToolFamily({
  namespace: "apps",
  permissions: {
    read: "Review app declarations and the selected organization's installations.",
    manage:
      "Approve installations, replace permissions and resources, and uninstall apps as an organization owner/admin.",
  },
  tools: [
    getAppTool,
    installAppTool,
    getInstallationTool,
    listInstallationsTool,
    updateInstallationTool,
    uninstallAppTool,
  ],
  isAvailable: (context: AppsToolContext) =>
    context.execution.scope.kind === "org" && !!context.runtimes.apps,
});
