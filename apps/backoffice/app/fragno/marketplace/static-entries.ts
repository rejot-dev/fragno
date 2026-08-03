import {
  TELEGRAM_TEST_COMMAND_MARKETPLACE_README,
  TELEGRAM_TEST_COMMAND_WORKFLOW_SOURCE,
  TELEGRAM_TEST_COMMAND_WORKFLOW_V1_1_SOURCE,
} from "@/files/content/telegram-test-command";

import type {
  MarketplaceStaticArtifactEntry,
  MarketplaceStaticArtifactListing,
  MarketplaceStaticArtifactVersion,
} from "./artifacts";
import { compareMarketplaceVersions } from "./version";

export const STATIC_MARKETPLACE_ENTRIES = [
  {
    owner: {
      scope: { kind: "system" },
      publisherName: "Fragno",
    },
    slug: "telegram-test-command",
    metadata: {
      name: "Telegram test command",
      summary: "Send a delayed Telegram reply when a chat receives the /test command.",
      description:
        "A small durable workflow for verifying that Telegram events, workflow sleeps, and delayed replies are configured correctly.",
      category: "communication",
      tags: ["telegram", "testing", "workflow"],
    },
    rootFiles: {
      "README.md": TELEGRAM_TEST_COMMAND_MARKETPLACE_README,
    },
    versions: [
      {
        version: "1.0.0",
        files: {
          "automations/telegram-test-command.workflow.js": TELEGRAM_TEST_COMMAND_WORKFLOW_SOURCE,
        },
      },
      {
        version: "1.1.0",
        files: {
          "automations/telegram-test-command.workflow.js":
            TELEGRAM_TEST_COMMAND_WORKFLOW_V1_1_SOURCE,
        },
      },
    ],
  },
] as const satisfies readonly MarketplaceStaticArtifactListing[];

export const listStaticMarketplaceEntries = (): MarketplaceStaticArtifactEntry[] =>
  STATIC_MARKETPLACE_ENTRIES.flatMap((listing) =>
    listing.versions.map((version) => createStaticMarketplaceEntry(listing, version)),
  );

export const getStaticMarketplaceEntry = (input: {
  slug: string;
  version: string;
}): MarketplaceStaticArtifactEntry | null => {
  const listing = findStaticMarketplaceListing(input);
  const version = listing?.versions.find((candidate) => candidate.version === input.version);
  return listing && version ? createStaticMarketplaceEntry(listing, version) : null;
};

export const getNextStaticMarketplaceEntry = (input: {
  slug: string;
  version: string;
}): MarketplaceStaticArtifactEntry | null => {
  const listing = findStaticMarketplaceListing(input);
  const nextVersion = listing?.versions
    .filter((candidate) => compareMarketplaceVersions(candidate.version, input.version) > 0)
    .sort((left, right) => compareMarketplaceVersions(left.version, right.version))[0];

  return listing && nextVersion ? createStaticMarketplaceEntry(listing, nextVersion) : null;
};

const findStaticMarketplaceListing = (input: {
  slug: string;
  version: string;
}): MarketplaceStaticArtifactListing | null =>
  STATIC_MARKETPLACE_ENTRIES.find(
    (listing) =>
      listing.slug === input.slug &&
      listing.versions.some((version) => version.version === input.version),
  ) ?? null;

const createStaticMarketplaceEntry = (
  listing: MarketplaceStaticArtifactListing,
  version: MarketplaceStaticArtifactVersion,
): MarketplaceStaticArtifactEntry => ({
  owner: listing.owner,
  slug: listing.slug,
  metadata: listing.metadata,
  rootFiles: listing.rootFiles,
  version: version.version,
  files: version.files,
});
