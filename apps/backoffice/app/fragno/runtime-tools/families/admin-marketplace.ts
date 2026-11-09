import { marketplaceFeatureEntrySchema } from "@fragno-dev/backoffice-api/v0/marketplace";
import { BACKOFFICE_PERMISSION } from "@fragno-dev/backoffice-api/v0/shared/permissions";
import { z } from "zod";

import {
  marketplaceAppPackagePublishInputSchema,
  marketplaceAppPackagePublishResultSchema,
  marketplaceFeatureInputSchema,
  marketplaceStaticPublicationResultSchema,
  marketplaceUnfeatureInputSchema,
  marketplaceUnfeatureResultSchema,
  type MarketplaceStaticPublicationResult,
} from "@/fragno/marketplace/contracts";
import type {
  AutomationCommandExecutionResult,
  AutomationCommandOutputOptions,
} from "@/fragno/runtime-tools/automation-types";
import { defineCliArgsParser, readOutputOptions } from "@/fragno/runtime-tools/bash-cli";

import {
  defineBackofficeRuntimeTool,
  defineBackofficeRuntimeToolFamily,
  type BackofficeToolContext,
} from "../runtime-tools";
import { formatMarketplaceFeatureEntry, MARKETPLACE_CURATION_SCOPE_HELP } from "./marketplace";
import type { MarketplaceRuntime } from "./marketplace-runtime";

type AdminMarketplaceToolContext = BackofficeToolContext<{
  marketplace: MarketplaceRuntime | undefined;
}>;

function getMarketplaceRuntime(context: AdminMarketplaceToolContext): MarketplaceRuntime {
  if (!context.runtimes.marketplace) {
    throw new Error("Marketplace runtime is not available in this execution context.");
  }
  return context.runtimes.marketplace;
}

const featureTool = defineBackofficeRuntimeTool({
  id: "admin.marketplace.feature",
  namespace: "admin",
  name: "marketplaceFeature",
  description: `Feature a published Marketplace listing, optionally scheduled with startsAt and ending at until, ordered by priority (higher first) with an optional curator note. Featuring an already featured listing replaces its settings. Expired and unpublished entries are removed to make room. ${MARKETPLACE_CURATION_SCOPE_HELP}`,
  // Curation authority depends on the scope, so the runtime checks it beyond the read permission.
  requiredPermissions: [BACKOFFICE_PERMISSION.marketplace.read],
  inputSchema: marketplaceFeatureInputSchema,
  outputSchema: marketplaceFeatureEntrySchema,
  execute: async (input, context: AdminMarketplaceToolContext) =>
    await getMarketplaceRuntime(context).feature(input),
  adapters: {
    bash: {
      command: "admin.marketplace.feature",
      help: {
        summary: `Feature a published listing, or update its feature settings. ${MARKETPLACE_CURATION_SCOPE_HELP}`,
        options: [
          {
            name: "listing-id",
            required: true,
            valueRequired: true,
            description: "Owner-qualified Marketplace listing ID.",
          },
          {
            name: "starts-at",
            valueRequired: true,
            description: "ISO 8601 time the feature begins (default: now).",
          },
          {
            name: "until",
            valueRequired: true,
            description: "ISO 8601 time the feature ends (default: no end).",
          },
          {
            name: "priority",
            valueRequired: true,
            description: "Integer from -1000 to 1000; higher shows first (default 0).",
          },
          {
            name: "note",
            valueRequired: true,
            description: "Curator note shown with the listing (maximum 140 characters).",
          },
        ],
        examples: [
          "admin.marketplace.feature --listing-id 'system#telegram-test-command' --priority 10",
          "admin.marketplace.feature --listing-id 'org:org-123#invoice-digest' --until 2026-12-31T00:00:00Z --note 'Year-end reporting'",
        ],
      },
      parse: defineCliArgsParser<z.input<typeof marketplaceFeatureInputSchema>>(
        "admin.marketplace.feature",
        {
          listingId: { required: true },
          startsAt: {},
          until: {},
          priority: { kind: "integer" },
          note: {},
        },
      ),
      format: (result, options) =>
        options.format === "json" || options.print
          ? { data: result }
          : { stdout: formatMarketplaceFeatureEntry(result) },
    },
  },
});

const unfeatureTool = defineBackofficeRuntimeTool({
  id: "admin.marketplace.unfeature",
  namespace: "admin",
  name: "marketplaceUnfeature",
  description: `Remove a Marketplace listing's feature entry. Removing an entry that does not exist succeeds with removed false. ${MARKETPLACE_CURATION_SCOPE_HELP}`,
  // Curation authority depends on the scope, so the runtime checks it beyond the read permission.
  requiredPermissions: [BACKOFFICE_PERMISSION.marketplace.read],
  inputSchema: marketplaceUnfeatureInputSchema,
  outputSchema: marketplaceUnfeatureResultSchema,
  execute: async (input, context: AdminMarketplaceToolContext) =>
    await getMarketplaceRuntime(context).unfeature(input),
  adapters: {
    bash: {
      command: "admin.marketplace.unfeature",
      help: {
        summary: `Remove a listing from the featured set. ${MARKETPLACE_CURATION_SCOPE_HELP}`,
        options: [
          {
            name: "listing-id",
            required: true,
            valueRequired: true,
            description: "Owner-qualified Marketplace listing ID.",
          },
        ],
        examples: ["admin.marketplace.unfeature --listing-id 'system#telegram-test-command'"],
      },
      parse: defineCliArgsParser<z.input<typeof marketplaceUnfeatureInputSchema>>(
        "admin.marketplace.unfeature",
        { listingId: { required: true } },
      ),
      format: (result, options) =>
        options.format === "json" || options.print
          ? { data: result }
          : {
              stdout: `${result.removed ? "removed" : "not featured"}\t${result.listingId}\n`,
            },
    },
  },
});

export function formatMarketplacePushOutput(
  output: MarketplaceStaticPublicationResult,
  options: AutomationCommandOutputOptions,
): AutomationCommandExecutionResult<MarketplaceStaticPublicationResult> {
  const failures = output.publications.filter((publication) => publication.state === "failed");
  if (options.format === "json" || options.print) {
    return {
      data: output,
      ...(failures.length > 0 ? { exitCode: 1 } : {}),
    };
  }

  const stdout = `${output.publications
    .map(
      (publication) =>
        `${publication.state}\t${publication.listingId}@${publication.version}\t${publication.state === "published" ? "" : publication.workflowInstanceId}`,
    )
    .join("\n")}\n`;
  if (failures.length === 0) {
    return { stdout };
  }

  return {
    stdout,
    stderr: `${failures
      .map(
        (publication) =>
          `${publication.listingId}@${publication.version}: ${publication.error.name}: ${publication.error.message}`,
      )
      .join("\n")}\n`,
    exitCode: 1,
  };
}

const pushStaticTool = defineBackofficeRuntimeTool({
  id: "admin.marketplace.push-static",
  namespace: "admin",
  name: "marketplacePushStatic",
  description: "Publish the bundled static marketplace entries from System context.",
  requiredPermissions: [BACKOFFICE_PERMISSION.internal.manage],
  inputSchema: z.object({ force: z.boolean().optional() }).optional().default({}),
  outputSchema: marketplaceStaticPublicationResultSchema,
  execute: async (input, context: AdminMarketplaceToolContext) => {
    if (context.execution.scope.kind !== "system") {
      throw new Error("Static marketplace publication requires System context.");
    }
    return await getMarketplaceRuntime(context).pushStaticEntries(input);
  },
  adapters: {
    bash: {
      command: "admin.marketplace.push-static",
      help: {
        summary:
          "admin.marketplace.push-static publishes the bundled static marketplace entries from System context.",
        options: [
          {
            name: "force",
            description: "Publish with fresh workflow IDs and overwrite existing package files.",
          },
        ],
        examples: [
          "admin.marketplace.push-static --format json",
          "admin.marketplace.push-static --force",
        ],
      },
      parse: defineCliArgsParser<{ force?: boolean }>("admin.marketplace.push-static", {
        force: { kind: "boolean" },
      }),
      outputOptions: (_args, parsed) => readOutputOptions(parsed),
      format: formatMarketplacePushOutput,
    },
  },
});

const publishAppPackageTool = defineBackofficeRuntimeTool({
  id: "admin.marketplace.publish-app-package",
  namespace: "admin",
  name: "marketplacePublishAppPackage",
  description:
    "Publish a release into a registered app's Marketplace, which only the app's installations install from (packages.install with app visibility). The app owns the listing, app:<slug>#<package slug>. Versions are immutable: publishing a published version again with the same files changes nothing, and with other files fails. Publishing is durable; installs of a requested release fail until it is published.",
  requiredPermissions: [BACKOFFICE_PERMISSION.admin.appsManage],
  inputSchema: marketplaceAppPackagePublishInputSchema,
  outputSchema: marketplaceAppPackagePublishResultSchema,
  execute: async (input, context: AdminMarketplaceToolContext) =>
    await getMarketplaceRuntime(context).publishAppPackage(input),
  adapters: {
    bash: {
      command: "admin.marketplace.publish-app-package",
      help: {
        summary:
          "admin.marketplace.publish-app-package publishes a release into an app's Marketplace (System administrators only).",
        options: [
          {
            name: "app-id",
            required: true,
            valueRequired: true,
            valueName: "id",
            description: "Registered Backoffice app ID",
          },
          {
            name: "slug",
            required: true,
            valueRequired: true,
            description: "Package slug; the listing ID is app:<app slug>#SLUG",
          },
          { name: "version", required: true, valueRequired: true, description: "Release version" },
          {
            name: "metadata-json",
            required: true,
            valueRequired: true,
            valueName: "json",
            description: "Listing metadata: name, summary, description, category, and tags",
          },
          {
            name: "files-json",
            required: true,
            valueRequired: true,
            valueName: "json",
            description: "File contents by package-relative path",
          },
        ],
        examples: [
          'admin.marketplace.publish-app-package --app-id APP_ID --slug books-agent --version 1.0.0 --metadata-json \'{"name":"Books agent","summary":"Answers questions about the books.","description":"Defines the agent that answers questions about the books.","category":"operations","tags":[]}\' --files-json \'{".marketplace/installation.json":"{\\"agents\\":[]}"}\'',
        ],
      },
      parse: defineCliArgsParser("admin.marketplace.publish-app-package", {
        appId: { kind: "string", required: true },
        slug: { kind: "string", required: true },
        version: { kind: "string", required: true },
        metadata: { kind: "json", option: "metadata-json", required: true },
        files: { kind: "json", option: "files-json", required: true },
      }),
      format: (result, options) =>
        options.format === "json" || options.print
          ? { data: result }
          : {
              data: result,
              stdout: `${result.listingId}@${result.version}\t${result.state}\t${result.workflowInstanceId}\n`,
            },
    },
  },
});

/** Organization owners and admins curate their own Marketplace, so curation is not System-only. */
export const adminMarketplaceCurationToolFamily = defineBackofficeRuntimeToolFamily({
  namespace: "admin",
  tools: [featureTool, unfeatureTool],
  isAvailable: (context: AdminMarketplaceToolContext) =>
    (context.execution.scope.kind === "system" || context.execution.scope.kind === "org") &&
    !!context.runtimes.marketplace,
});

export const adminMarketplacePublicationToolFamily = defineBackofficeRuntimeToolFamily({
  namespace: "admin",
  tools: [pushStaticTool, publishAppPackageTool],
  isAvailable: (context: AdminMarketplaceToolContext) =>
    context.execution.scope.kind === "system" && !!context.runtimes.marketplace,
});
