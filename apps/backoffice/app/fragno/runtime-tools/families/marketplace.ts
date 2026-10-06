import type { z } from "zod";

import {
  marketplaceListingDetailSchema,
  marketplacePublishedListingInputSchema,
} from "@/fragno/marketplace/contracts";
import {
  marketplacePublishInputSchema,
  marketplacePublishResultSchema,
} from "@/fragno/marketplace/package-publishing";
import { defineCliArgsParser } from "@/fragno/runtime-tools/bash-cli";

import {
  defineBackofficeRuntimeTool,
  defineBackofficeRuntimeToolFamily,
  type BackofficeToolContext,
} from "../runtime-tools";
import {
  marketplaceSearchInputSchema,
  marketplaceSearchResultSchema,
  type MarketplaceRuntime,
} from "./marketplace-runtime";

type MarketplaceToolContext = BackofficeToolContext<{
  marketplace: MarketplaceRuntime | undefined;
}>;

function getMarketplaceRuntime(context: MarketplaceToolContext): MarketplaceRuntime {
  if (!context.runtimes.marketplace) {
    throw new Error("Marketplace runtime is not available in this execution context.");
  }
  return context.runtimes.marketplace;
}

const marketplaceSearchTool = defineBackofficeRuntimeTool({
  id: "marketplace.search",
  namespace: "marketplace",
  name: "search",
  description:
    "Search published package metadata. Follow nextCursor while hasNextPage is true, even when a candidate page has no matches.",
  requiredPermissions: ["read"],
  inputSchema: marketplaceSearchInputSchema,
  outputSchema: marketplaceSearchResultSchema,
  execute: async (input, context: MarketplaceToolContext) =>
    await getMarketplaceRuntime(context).search(input),
  adapters: {
    bash: {
      command: "marketplace.search",
      help: {
        summary:
          "Search published packages. Follow the candidate cursor even when a page has no matches.",
        options: [
          {
            name: "query",
            required: true,
            valueRequired: true,
            description: "Words to match in package metadata (case-insensitive).",
          },
          { name: "category", valueRequired: true, description: "Filter by Marketplace category." },
          {
            name: "page-size",
            valueRequired: true,
            description: "Number of registry candidates to examine (maximum 60).",
          },
          {
            name: "cursor",
            valueRequired: true,
            description: "Next candidate cursor from a previous search.",
          },
        ],
        examples: ["marketplace.search --query telegram --format json"],
      },
      parse: defineCliArgsParser<z.input<typeof marketplaceSearchInputSchema>>(
        "marketplace.search",
        {
          query: { required: true },
          category: {},
          pageSize: { kind: "positiveInteger" },
          cursor: {},
        },
      ),
      format: (result, options) =>
        options.format === "json" || options.print
          ? { data: result }
          : {
              stdout:
                result.listings
                  .map(
                    (listing) =>
                      `${listing.listingId}@${listing.latestVersion}\t${listing.name}\t${listing.summary}\n`,
                  )
                  .join("") + (result.nextCursor ? `Next cursor: ${result.nextCursor}\n` : ""),
            },
    },
  },
});

const marketplaceViewTool = defineBackofficeRuntimeTool({
  id: "marketplace.view",
  namespace: "marketplace",
  name: "view",
  description: "Inspect published package metadata and cursor-paginated releases.",
  requiredPermissions: ["read"],
  inputSchema: marketplacePublishedListingInputSchema,
  outputSchema: marketplaceListingDetailSchema,
  execute: async (input, context: MarketplaceToolContext) =>
    await getMarketplaceRuntime(context).view(input),
  adapters: {
    bash: {
      command: "marketplace.view",
      help: {
        summary: "Inspect a published package and its releases.",
        options: [
          {
            name: "listing-id",
            required: true,
            valueRequired: true,
            description: "Owner-qualified Marketplace listing ID.",
          },
          {
            name: "version-page-size",
            valueRequired: true,
            description: "Release page size (maximum 60).",
          },
          {
            name: "version-cursor",
            valueRequired: true,
            description: "Next release cursor from a previous view.",
          },
        ],
        examples: ["marketplace.view --listing-id 'system#telegram-test-command' --format json"],
      },
      parse: defineCliArgsParser<z.input<typeof marketplacePublishedListingInputSchema>>(
        "marketplace.view",
        {
          listingId: { required: true },
          versionPageSize: { kind: "positiveInteger" },
          versionCursor: {},
        },
      ),
      format: (result, options) =>
        options.format === "json" || options.print
          ? { data: result }
          : {
              stdout: [
                `${result.listing.listingId}@${result.listing.latestVersion}`,
                `${result.listing.name} — ${result.listing.publisherName}`,
                result.listing.summary,
                "",
                result.listing.description,
                "",
                `Releases: ${result.versions.map(({ version }) => version).join(", ")}`,
                ...(result.nextVersionCursor
                  ? [`Next version cursor: ${result.nextVersionCursor}`]
                  : []),
                "",
              ].join("\n"),
            },
    },
  },
});

const marketplacePublishTool = defineBackofficeRuntimeTool({
  id: "marketplace.publish",
  namespace: "marketplace",
  name: "publish",
  description:
    "Publish a captured package from a root manifest.json containing name @<organization-slug>/<package-slug>. Versions are immutable by default; System may explicitly replace them. Dry runs write nothing. Author and version overrides require System context.",
  requiredPermissions: ["publish"],
  inputSchema: marketplacePublishInputSchema,
  outputSchema: marketplacePublishResultSchema,
  execute: async (input, context: MarketplaceToolContext) =>
    await getMarketplaceRuntime(context).publish(input),
  adapters: {
    bash: {
      command: "marketplace.publish",
      help: {
        summary:
          "Publish the package identified by its root manifest.json. The accepted snapshot is published asynchronously.",
        options: [
          {
            name: "package-root",
            required: true,
            valueRequired: true,
            description: "Absolute package directory in the current filesystem.",
          },
          {
            name: "dry-run",
            description:
              "Validate owner, version, and selected files without staging or publishing.",
          },
          {
            name: "skip-author-check",
            description: "System only: publish without organization membership.",
          },
          {
            name: "skip-version-check",
            description: "System only: allow older releases and replacement of existing versions.",
          },
        ],
        examples: [
          "marketplace.publish --package-root /workspace/packages/telegram --dry-run",
          "marketplace.publish --package-root /workspace/packages/telegram --format json",
        ],
      },
      parse: defineCliArgsParser<z.input<typeof marketplacePublishInputSchema>>(
        "marketplace.publish",
        {
          packageRoot: { required: true },
          dryRun: { kind: "boolean" },
          skipAuthorCheck: { kind: "boolean" },
          skipVersionCheck: { kind: "boolean" },
        },
      ),
      format: (result, options) =>
        options.format === "json" || options.print
          ? { data: result }
          : {
              stdout:
                `${result.state}\t${result.name}@${result.version}\t${result.listingId}\n` +
                result.files
                  .map(
                    (file) => `${file.relativePath}\t${file.sizeBytes} bytes\t${file.checksum}\n`,
                  )
                  .join("") +
                (result.state === "preview"
                  ? ""
                  : `Workflow: ${result.workflowInstanceId} (System)\n`),
            },
    },
  },
});

/** Registry publishing uses the source filesystem; installation remains a workspace operation. */
export const marketplaceToolFamily = defineBackofficeRuntimeToolFamily({
  namespace: "marketplace",
  permissions: {
    read: "Discover published Marketplace packages and releases.",
    publish: "Publish packages for an organization; publishing overrides require System context.",
  },
  tools: [marketplaceSearchTool, marketplaceViewTool, marketplacePublishTool],
  isAvailable: (context: MarketplaceToolContext) => !!context.runtimes.marketplace,
});
