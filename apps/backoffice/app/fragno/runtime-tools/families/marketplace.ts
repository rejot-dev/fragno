import { marketplaceSearchInputSchema } from "@fragno-dev/backoffice-api/v0/marketplace";
import { marketplacePublishInputSchema } from "@fragno-dev/backoffice-api/v0/marketplace";
import { marketplaceViewInputSchema } from "@fragno-dev/backoffice-api/v0/marketplace";
import { type MarketplaceFeatureEntry } from "@fragno-dev/backoffice-api/v0/marketplace";
import type { z } from "zod";

import { formatPackagePermissions } from "@/fragno/marketplace/package-declaration";
import { defineCliArgsParser } from "@/fragno/runtime-tools/bash-cli";

import {
  backofficeApiOperationToolFields,
  defineBackofficeRuntimeTool,
  defineBackofficeRuntimeToolFamily,
  type BackofficeToolContext,
} from "../runtime-tools";
import { type MarketplaceRuntime } from "./marketplace-runtime";

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
  ...backofficeApiOperationToolFields("marketplace.search"),
  namespace: "marketplace",
  name: "search",
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
            name: "visibility",
            valueRequired: true,
            description:
              "public (default) reads the public Marketplace; organization reads the current organization's Marketplace.",
          },
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
          visibility: {},
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
  ...backofficeApiOperationToolFields("marketplace.view"),
  namespace: "marketplace",
  name: "view",
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
            name: "visibility",
            valueRequired: true,
            description:
              "public (default) reads the public Marketplace; organization reads the current organization's Marketplace.",
          },
          {
            name: "version",
            valueRequired: true,
            description: "Release whose declaration to show; defaults to the latest release.",
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
      parse: defineCliArgsParser<z.input<typeof marketplaceViewInputSchema>>("marketplace.view", {
        listingId: { required: true },
        visibility: {},
        version: {},
        versionPageSize: { kind: "positiveInteger" },
        versionCursor: {},
      }),
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
                `Permissions to approve for ${result.release.version}: ${formatPackagePermissions(result.release.permissions)}`,
                "",
              ].join("\n"),
            },
    },
  },
});

const marketplacePublishTool = defineBackofficeRuntimeTool({
  ...backofficeApiOperationToolFields("marketplace.publish"),
  namespace: "marketplace",
  name: "publish",
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
            name: "visibility",
            required: true,
            valueRequired: true,
            description:
              "public publishes to the public Marketplace; organization publishes to the owning organization's members-only Marketplace.",
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
          "marketplace.publish --package-root /workspace/packages/telegram --visibility organization --dry-run",
          "marketplace.publish --package-root /workspace/packages/telegram --visibility public --format json",
        ],
      },
      parse: defineCliArgsParser<z.input<typeof marketplacePublishInputSchema>>(
        "marketplace.publish",
        {
          packageRoot: { required: true },
          visibility: { required: true },
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

export function formatMarketplaceFeatureEntry(entry: MarketplaceFeatureEntry): string {
  const window = `${entry.startsAt} → ${entry.until ?? "no end"}`;
  return `${entry.state}\t${entry.listingId}\t${entry.name}\tpriority ${entry.priority}\t${window}${entry.note ? `\t${entry.note}` : ""}\n`;
}

export const MARKETPLACE_CURATION_SCOPE_HELP =
  "System scope curates the public Marketplace (System administrators); organization scope curates that organization's Marketplace (owners and admins).";

const marketplaceFeaturedTool = defineBackofficeRuntimeTool({
  ...backofficeApiOperationToolFields("marketplace.featured"),
  namespace: "marketplace",
  name: "featured",
  execute: async (_input, context: MarketplaceToolContext) =>
    await getMarketplaceRuntime(context).featured(),
  adapters: {
    bash: {
      command: "marketplace.featured",
      help: {
        summary: `List every feature entry with its state. ${MARKETPLACE_CURATION_SCOPE_HELP}`,
        options: [],
        examples: ["marketplace.featured", "marketplace.featured --format json"],
      },
      parse: defineCliArgsParser<Record<string, never>>("marketplace.featured", {}),
      format: (result, options) =>
        options.format === "json" || options.print
          ? { data: result }
          : {
              stdout:
                result.entries.map(formatMarketplaceFeatureEntry).join("") +
                `${result.entries.length}/${result.limit} feature slots used\n`,
            },
    },
  },
});

/** Registry publishing uses the source filesystem; installation remains a workspace operation. */
export const marketplaceToolFamily = defineBackofficeRuntimeToolFamily({
  namespace: "marketplace",
  tools: [
    marketplaceSearchTool,
    marketplaceViewTool,
    marketplacePublishTool,
    marketplaceFeaturedTool,
  ],
  isAvailable: (context: MarketplaceToolContext) => !!context.runtimes.marketplace,
});
