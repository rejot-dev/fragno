import { packagesInstallInputSchema } from "@fragno-dev/backoffice-api/v0/marketplace";
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
          "Start the existing installation flow in the selected workspace. A created or restarted workflow is not a completed installation.",
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
        ],
        examples: [
          "packages.install --listing-id 'system#telegram-test-command' --version 1.2.1 --installation-root /workspace/telegram --format json",
        ],
      },
      parse: defineCliArgsParser<z.input<typeof packagesInstallInputSchema>>("packages.install", {
        listingId: { required: true },
        version: {},
        installationRoot: { required: true },
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
              stdout: result.entries
                .map((entry) => `${entry.listingId}@${entry.version}\t${entry.installationRoot}\n`)
                .join(""),
            },
    },
  },
});

/** Workspace package tools do not introduce upgrade or reinstall policy. */
export const packagesToolFamily = defineBackofficeRuntimeToolFamily({
  namespace: "packages",
  tools: [packagesInstallTool, packagesListTool],
  isAvailable: (context: PackagesToolContext) => !!context.runtimes.packages,
});
