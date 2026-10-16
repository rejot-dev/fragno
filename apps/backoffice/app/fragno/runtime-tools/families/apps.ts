import type { BackofficeApp, BackofficeAppInstallation } from "@fragno-dev/backoffice-api/v0/apps";

import { defineCliArgsParser } from "@/fragno/runtime-tools/bash-cli";

import {
  backofficeApiOperationToolFields,
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
const actionsRevisionOption = {
  name: "actions-revision",
  required: true,
  valueRequired: true,
  valueName: "revision",
  description:
    "The app's actionsRevision reviewed with apps.get; fails if its actions changed since",
};
const resourceScopeDescription =
  'Resources the grants apply to: {"kind":"organization"} or {"kind":"projects","projectIds":["..."]}';

const getAppTool = defineBackofficeRuntimeTool({
  ...backofficeApiOperationToolFields("apps.get"),
  namespace: "apps",
  name: "get",
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
                    `Slug: ${app.slug} (integration connection app#${app.slug})`,
                    `OAuth client ID: ${app.oauthClientId}`,
                    `Requested permissions: ${app.requestedPermissions.map(({ namespace, permission }) => `${namespace}.${permission}`).join(", ") || "none"}`,
                    ...renderAppActions(app),
                    `Created at: ${app.createdAt}`,
                    "",
                  ].join("\n")
                : "Backoffice app was not found.\n",
            },
    },
  },
});

function renderAppActions(app: BackofficeApp) {
  if (app.actions.kind === "none") {
    return [`Actions revision: ${app.actionsRevision}`, "Actions: none"];
  }
  return [
    `Actions revision: ${app.actionsRevision}`,
    `Action endpoint: ${app.actions.endpointUrl}`,
    `Action changes: ${app.actions.changeApproval === "automatic" ? "apply automatically" : "need installation approval"}`,
    `Actions (${app.actions.actions.length}):`,
    ...app.actions.actions.map(({ id, label, description }) => `  ${id}: ${label}. ${description}`),
  ];
}

const installAppTool = defineBackofficeRuntimeTool({
  ...backofficeApiOperationToolFields("apps.install"),
  namespace: "apps",
  name: "install",
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
          actionsRevisionOption,
          {
            name: "resource-scope-json",
            valueRequired: true,
            valueName: "json",
            description: `${resourceScopeDescription} (default: whole organization)`,
          },
        ],
        examples: [
          "apps.install --app-id APP_ID --granted-permissions-json '[]' --actions-revision 1",
          'apps.install --app-id APP_ID --granted-permissions-json \'[{"namespace":"events","permission":"emit"}]\' --actions-revision 1 --resource-scope-json \'{"kind":"projects","projectIds":["PROJECT_ID"]}\'',
        ],
      },
      parse: defineCliArgsParser("apps.install", {
        appId: { kind: "string", required: true },
        grantedPermissions: { kind: "json", option: "granted-permissions-json", required: true },
        actionsRevision: { kind: "positiveInteger", required: true },
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
  ...backofficeApiOperationToolFields("apps.installations.get"),
  namespace: "apps",
  name: "getInstallation",
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
    `  Approved actions revision: ${installation.approvedActionsRevision}`,
    `  Granted permissions: ${installation.grantedPermissions.map(({ namespace, permission }) => `${namespace}.${permission}`).join(", ") || "none"}`,
    `  Resources: ${installation.resourceScope.kind === "organization" ? "whole organization" : `projects ${installation.resourceScope.projectIds.join(", ")}`}`,
    `  Linked account: ${installation.externalAccount ? `${installation.externalAccount.label} (${installation.externalAccount.id})` : "none"}`,
    `  Installed by user ID: ${installation.installedByUserId}`,
    `  Created at: ${installation.createdAt}`,
    `  Updated at: ${installation.updatedAt}`,
  ].join("\n");
}

const listInstallationsTool = defineBackofficeRuntimeTool({
  ...backofficeApiOperationToolFields("apps.installations.list"),
  namespace: "apps",
  name: "listInstallations",
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
  ...backofficeApiOperationToolFields("apps.installations.update"),
  namespace: "apps",
  name: "updateInstallation",
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

const approveActionsTool = defineBackofficeRuntimeTool({
  ...backofficeApiOperationToolFields("apps.installations.approveActions"),
  namespace: "apps",
  name: "approveInstallationActions",
  execute: async (input, context: AppsToolContext) =>
    await requireAppsContext(context).apps.approveActions(input),
  adapters: {
    bash: {
      command: "apps.installations.approve-actions",
      help: {
        summary:
          "apps.installations.approve-actions approves the app's current action declaration for this organization (organization owners/admins only). Review it with apps.get first.",
        options: [appIdOption, actionsRevisionOption],
        examples: ["apps.installations.approve-actions --app-id APP_ID --actions-revision 2"],
      },
      parse: defineCliArgsParser("apps.installations.approve-actions", {
        appId: { kind: "string", required: true },
        actionsRevision: { kind: "positiveInteger", required: true },
      }),
      format: (result, options) =>
        options.format === "json" || options.print
          ? { data: result }
          : {
              data: result,
              stdout: `${result.changed ? "Approved app actions." : "App actions already approved."}\nInstallation ID: ${result.installationId}\n`,
            },
    },
  },
});

const uninstallAppTool = defineBackofficeRuntimeTool({
  ...backofficeApiOperationToolFields("apps.uninstall"),
  namespace: "apps",
  name: "uninstall",
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
  tools: [
    getAppTool,
    installAppTool,
    getInstallationTool,
    listInstallationsTool,
    updateInstallationTool,
    approveActionsTool,
    uninstallAppTool,
  ],
  isAvailable: (context: AppsToolContext) =>
    context.execution.scope.kind === "org" && !!context.runtimes.apps,
});
