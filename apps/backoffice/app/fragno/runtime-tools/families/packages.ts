import {
  MARKETPLACE_LOCK_PATH,
  packagesImportLegacyInputSchema,
  packagesInstallInputSchema,
  packagesStatusInputSchema,
} from "@fragno-dev/backoffice-api/v0/marketplace";
import { z } from "zod";

import { defineCliArgsParser } from "@/fragno/runtime-tools/bash-cli";

import {
  backofficeApiOperationToolFields,
  defineBackofficeRuntimeTool,
  defineBackofficeRuntimeToolFamily,
  type BackofficeToolContext,
} from "../runtime-tools";
import { type PackagesRuntime } from "./packages-runtime";

type PackagesToolContext = BackofficeToolContext<{ packages: PackagesRuntime | undefined }>;

function getPackagesRuntime(context: PackagesToolContext): PackagesRuntime {
  if (!context.runtimes.packages) {
    throw new Error("Packages runtime is not available in this execution context.");
  }
  return context.runtimes.packages;
}

const packagesInstallTool = defineBackofficeRuntimeTool({
  ...backofficeApiOperationToolFields("packages.install"),
  namespace: "packages",
  name: "install",
  getResource: (input) => ({
    listingId: input.listingId,
    installationRoot: input.installationRoot,
  }),
  execute: async (input, context: PackagesToolContext) =>
    await getPackagesRuntime(context).install(input),
  adapters: {
    bash: {
      command: "packages.install",
      help: {
        summary:
          "Start the existing installation flow in the selected workspace. A created or restarted workflow is not a completed installation; follow it with packages.status.",
        options: [
          {
            name: "listing-id",
            required: true,
            valueRequired: true,
            description: "Owner-qualified Marketplace listing ID.",
          },
          {
            name: "version",
            valueRequired: true,
            description: "Exact release; defaults to the existing latest-release resolution.",
          },
          {
            name: "installation-root",
            required: true,
            valueRequired: true,
            description:
              "Destination folder under /workspace. Differing files are not overwritten.",
          },
          {
            name: "visibility",
            valueRequired: true,
            description:
              "public (default) installs from the public Marketplace; organization installs from the installing organization's Marketplace.",
          },
          {
            name: "permission",
            valueRequired: true,
            description:
              "Approve one permission the release declares, as namespace.permission. Repeat it for each declared permission.",
          },
        ],
        examples: [
          "packages.install --listing-id 'system#telegram-test-command' --version 2.0.0 --installation-root /workspace/telegram --permission integrations.execute --permission packages.read --format json",
        ],
      },
      parse: defineCliArgsParser<z.input<typeof packagesInstallInputSchema>>("packages.install", {
        listingId: { required: true },
        version: {},
        installationRoot: { required: true },
        visibility: {},
        permissions: {
          kind: "stringArray",
          option: "permission",
          // `admin.apps.manage` names namespace `admin` and permission `apps.manage`.
          transform: (keys) =>
            (keys as unknown as string[]).map((key) => {
              const separator = key.indexOf(".");
              return separator === -1
                ? { namespace: key, permission: "" }
                : { namespace: key.slice(0, separator), permission: key.slice(separator + 1) };
            }) as z.input<typeof packagesInstallInputSchema>["permissions"],
        },
      }),
      format: (result, options) =>
        options.format === "json" || options.print
          ? { data: result }
          : {
              stdout: `${result.action}\t${result.listingId}@${result.version}\t${result.installationRoot}\t${result.workflowStatus}\t${result.workflowInstanceId}\torg:${result.workflowScope.orgId}\n`,
            },
    },
  },
});

const packagesStatusTool = defineBackofficeRuntimeTool({
  ...backofficeApiOperationToolFields("packages.status"),
  namespace: "packages",
  name: "status",
  execute: async (input, context: PackagesToolContext) =>
    await getPackagesRuntime(context).status(input),
  adapters: {
    bash: {
      command: "packages.status",
      help: {
        summary: "Show where an installation packages.install started stands.",
        options: [
          {
            name: "workflow-instance-id",
            required: true,
            valueRequired: true,
            description: "The workflowInstanceId packages.install returned.",
          },
          {
            name: "workflow-scope",
            required: true,
            valueRequired: true,
            description: "The workflowScope packages.install returned, as JSON.",
          },
        ],
        examples: [
          `packages.status --workflow-instance-id marketplace-package-install-<id> --workflow-scope '{"kind":"org","orgId":"<org-id>","jurisdiction":null}' --format json`,
        ],
      },
      parse: defineCliArgsParser<z.input<typeof packagesStatusInputSchema>>("packages.status", {
        workflowInstanceId: { required: true },
        workflowScope: { required: true, kind: "json" },
      }),
      format: (result) => ({ data: result }),
    },
  },
});

const packagesListTool = defineBackofficeRuntimeTool({
  ...backofficeApiOperationToolFields("packages.ls"),
  namespace: "packages",
  name: "ls",
  execute: async (_input, context: PackagesToolContext) => await getPackagesRuntime(context).ls(),
  adapters: {
    bash: {
      command: "packages.ls",
      help: {
        summary: "List the selected workspace's recorded package installations.",
        options: [],
        examples: ["packages.ls --format json"],
      },
      parse: defineCliArgsParser<Record<string, never>>("packages.ls", {}),
      format: (result, options) =>
        options.format === "json" || options.print
          ? { data: result }
          : {
              stdout: result.installations
                .map(
                  (installation) =>
                    `${installation.listingId}@${installation.version}\t${installation.installationRoot}\t${installation.marketplace.kind === "org" ? "organization" : "public"}\n`,
                )
                .join(""),
            },
    },
  },
});

const packagesGetTool = defineBackofficeRuntimeTool({
  ...backofficeApiOperationToolFields("packages.get"),
  namespace: "packages",
  name: "get",
  execute: async (input, context: PackagesToolContext) =>
    await getPackagesRuntime(context).get(input),
  adapters: {
    bash: {
      command: "packages.get",
      help: {
        summary: "Show one package installation in the selected workspace, with its settings.",
        options: [
          {
            name: "listing-id",
            required: true,
            valueRequired: true,
            description: "Owner-qualified Marketplace listing ID.",
          },
        ],
        examples: ["packages.get --listing-id 'system#telegram-test-command' --format json"],
      },
      parse: defineCliArgsParser<{ listingId: string }>("packages.get", {
        listingId: { required: true },
      }),
      format: (result) => ({ data: result }),
    },
  },
});

const packagesUninstallTool = defineBackofficeRuntimeTool({
  ...backofficeApiOperationToolFields("packages.uninstall"),
  namespace: "packages",
  name: "uninstall",
  getResource: (input) => ({ listingId: input.listingId }),
  execute: async (input, context: PackagesToolContext) =>
    await getPackagesRuntime(context).uninstall(input),
  adapters: {
    bash: {
      command: "packages.uninstall",
      help: {
        summary:
          "Uninstall a package from the selected workspace, deleting the routes and event definitions it manages. Its files stay.",
        options: [
          {
            name: "listing-id",
            required: true,
            valueRequired: true,
            description: "Owner-qualified Marketplace listing ID.",
          },
        ],
        examples: ["packages.uninstall --listing-id 'system#telegram-test-command' --format json"],
      },
      parse: defineCliArgsParser<{ listingId: string }>("packages.uninstall", {
        listingId: { required: true },
      }),
      format: (result, options) =>
        options.format === "json" || options.print
          ? { data: result }
          : {
              stdout: result
                ? `uninstalled\t${result.installation.listingId}\t${result.installation.installationRoot}\troutes:${result.removedRouteIds.join(",")}\tevents:${result.removedEventDefinitions.map(({ source, eventType }) => `${source}/${eventType}`).join(",")}\tagents:${result.removedAgents.join(",")}\n`
                : "not installed\n",
            },
    },
  },
});

const packagesImportLegacyTool = defineBackofficeRuntimeTool({
  ...backofficeApiOperationToolFields("packages.importLegacy"),
  namespace: "packages",
  name: "importLegacy",
  execute: async (input, context: PackagesToolContext) =>
    await getPackagesRuntime(context).importLegacy(input),
  adapters: {
    bash: {
      command: "packages.importLegacy",
      help: {
        summary: `Import the installations recorded in ${MARKETPLACE_LOCK_PATH} into the selected workspace, then delete the file.`,
        options: [
          {
            name: "keep",
            valueRequired: true,
            description:
              "For a listing recorded in several folders, the folder to import, as <listing-id>=<folder>. Repeat it for each such listing.",
          },
        ],
        examples: [
          "packages.importLegacy --format json",
          "packages.importLegacy --keep 'system#jira-setup=/workspace/jira-setup'",
        ],
      },
      parse: defineCliArgsParser<z.input<typeof packagesImportLegacyInputSchema>>(
        "packages.importLegacy",
        {
          keep: {
            kind: "stringArray",
            option: "keep",
            // Listing ids never contain `=`, so the first one ends the id.
            transform: (values) =>
              (values as unknown as string[]).map((value) => {
                const separator = value.indexOf("=");
                return separator === -1
                  ? { listingId: value, installationRoot: "" }
                  : {
                      listingId: value.slice(0, separator),
                      installationRoot: value.slice(separator + 1),
                    };
              }) as z.input<typeof packagesImportLegacyInputSchema>["keep"],
          },
        },
      ),
      format: (result, options) =>
        options.format === "json" || options.print
          ? { data: result }
          : {
              stdout: [
                ...result.imported.map(
                  (installation) =>
                    `imported\t${installation.listingId}@${installation.version}\t${installation.installationRoot}\n`,
                ),
                ...result.alreadyInstalled.map(
                  (entry) => `already installed\t${entry.listingId}\t${entry.installationRoot}\n`,
                ),
                ...result.conflicts.map(
                  (conflict) =>
                    `conflict\t${conflict.listingId}\t${conflict.installationRoots.join(",")}\n`,
                ),
                `lock\t${result.lock}\n`,
              ].join(""),
            },
    },
  },
});

/** Install, inspect, and uninstall packages in the selected workspace. */
export const packagesToolFamily = defineBackofficeRuntimeToolFamily({
  namespace: "packages",
  tools: [
    packagesInstallTool,
    packagesStatusTool,
    packagesListTool,
    packagesGetTool,
    packagesUninstallTool,
    packagesImportLegacyTool,
  ],
  isAvailable: (context: PackagesToolContext) => !!context.runtimes.packages,
});
