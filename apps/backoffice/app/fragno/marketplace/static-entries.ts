import { z } from "zod";

import type { MarketplaceStaticArtifactEntry, MarketplaceStaticArtifactListing } from "./artifacts";
import {
  marketplaceListingMetadataSchema,
  marketplaceOwnerSchema,
  marketplaceSlugSchema,
  marketplaceVersionSchema,
} from "./contracts";
import { compareMarketplaceVersions } from "./version";

export const marketplaceManifestSchema = z.object({
  owner: marketplaceOwnerSchema,
  slug: marketplaceSlugSchema,
  metadata: marketplaceListingMetadataSchema,
  versions: z
    .array(marketplaceVersionSchema)
    .min(1)
    .refine(
      (versions) => new Set(versions).size === versions.length,
      "Marketplace manifest versions must be unique.",
    ),
});

const manifests = import.meta.glob<string>("../../../content/marketplace/*/manifest.json", {
  eager: true,
  query: "?raw",
  import: "default",
});
const artifacts = Object.entries(
  import.meta.glob<string>(
    ["../../../content/marketplace/**/*", "!../../../content/marketplace/*/manifest.json"],
    {
      eager: true,
      // Install workflows live under .marketplace and must survive production glob expansion.
      exhaustive: true,
      query: "?raw",
      import: "default",
    },
  ),
);

export const STATIC_MARKETPLACE_ENTRIES = Object.entries(manifests).map(
  ([manifestPath, source]): MarketplaceStaticArtifactListing => {
    const manifest = marketplaceManifestSchema.parse(JSON.parse(source));
    const listingDirectory = manifestPath.slice(0, -"manifest.json".length);
    const listingFiles = artifacts.reduce<Array<readonly [string, string]>>(
      (files, [path, content]) => {
        if (path.startsWith(listingDirectory)) {
          files.push([path.slice(listingDirectory.length), content]);
        }
        return files;
      },
      [],
    );

    return {
      owner: manifest.owner,
      slug: manifest.slug,
      metadata: manifest.metadata,
      rootFiles: Object.fromEntries(listingFiles.filter(([path]) => !path.startsWith("versions/"))),
      versions: manifest.versions.map((version) => {
        const versionDirectory = `versions/${version}/`;
        return {
          version,
          files: Object.fromEntries(
            listingFiles.reduce<Array<readonly [string, string]>>((files, [path, content]) => {
              if (path.startsWith(versionDirectory)) {
                files.push([path.slice(versionDirectory.length), content]);
              }
              return files;
            }, []),
          ),
        };
      }),
    };
  },
);

const staticMarketplaceVersions: MarketplaceStaticArtifactEntry[] =
  STATIC_MARKETPLACE_ENTRIES.flatMap((listing) =>
    listing.versions.map((version) => ({
      owner: listing.owner,
      slug: listing.slug,
      metadata: listing.metadata,
      rootFiles: listing.rootFiles,
      version: version.version,
      files: version.files,
    })),
  );

export const listStaticMarketplaceEntries = (): MarketplaceStaticArtifactEntry[] => [
  ...staticMarketplaceVersions,
];

export const getStaticMarketplaceEntry = (input: {
  slug: string;
  version: string;
}): MarketplaceStaticArtifactEntry | null =>
  staticMarketplaceVersions.find(
    (entry) => entry.slug === input.slug && entry.version === input.version,
  ) ?? null;

export const getNextStaticMarketplaceEntry = (input: {
  slug: string;
  version: string;
}): MarketplaceStaticArtifactEntry | null =>
  staticMarketplaceVersions
    .filter(
      (entry) =>
        entry.slug === input.slug && compareMarketplaceVersions(entry.version, input.version) > 0,
    )
    .sort((left, right) => compareMarketplaceVersions(left.version, right.version))[0] ?? null;
