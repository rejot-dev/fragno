import {
  marketplaceListingMetadataSchema,
  marketplacePackageDeclarationSchema,
  marketplaceVersionSchema,
  type MarketplaceListingMetadata,
} from "@fragno-dev/backoffice-api/v0/marketplace";
import type { BackofficePermissionRequirement } from "@fragno-dev/backoffice-api/v0/shared/permissions";
import { z } from "zod";

import { BOOKKEEPER_AGENT_NAME, BOOKKEEPING_APP_SLUG } from "./connection";

/** Where each agent package is installed in its project, beside the files people keep there. */
export const AGENT_PACKAGE_ROOT = "/workspace/bookkeeping";

/**
 * Where a release's files name Bookkeeping's event source, `app:<its app ID>`, which each Backoffice
 * gives it, so the files are published for the Backoffice publishing them.
 */
const EVENT_SOURCE_PLACEHOLDER = "{{eventSource}}";

/** What `marketplace/<slug>/manifest.json` says of a package: its listing, and the version Bookkeeping ships. */
const manifestSchema = z.strictObject({
  slug: z.string().min(1),
  metadata: marketplaceListingMetadataSchema,
  version: marketplaceVersionSchema,
});

/**
 * A package in Bookkeeping's Marketplace in Backoffice that defines one of its agents, with the
 * files it installs beside it under `AGENT_PACKAGE_ROOT`, such as the agent's skills, pages, and
 * workflows, and the routes and events it declares, with the `permissions` they use. Bookkeeping
 * installs it in each project it asks the agent in. Published versions never change, so a changed
 * package needs a new version; the Directory installs it in every project whose version differs.
 */
export type AgentPackage = {
  slug: string;
  version: string;
  metadata: MarketplaceListingMetadata;
  agentName: string;
  /** What installing it approves: what its declaration says its routes use. */
  permissions: BackofficePermissionRequirement[];
  /** The release's files by path, naming the event source as `EVENT_SOURCE_PLACEHOLDER`. */
  files: Record<string, string>;
};

/** Which package each agent project holds: the firm's agent project, or an administration's. */
export type AgentPackageName = "bookkeeper" | "books";

/** Each package's slug, and the agent in it that Bookkeeping prompts. */
const AGENT_PACKAGE_SLUGS: Record<AgentPackageName, { slug: string; agentName: string }> = {
  bookkeeper: { slug: "bookkeeper-agent", agentName: BOOKKEEPER_AGENT_NAME },
  books: { slug: "books-agent", agentName: "books" },
};

/**
 * Bookkeeping's agent packages, as `marketplace/` keeps them: each package's `manifest.json`,
 * naming the version Bookkeeping ships, and that version's files under `package/`. Earlier versions
 * stay published in Backoffice, not on disk. `files` maps paths under `marketplace/` to their
 * content.
 */
export function readAgentPackages(
  files: Record<string, string>,
): Record<AgentPackageName, AgentPackage> {
  const read = ({ slug, agentName }: { slug: string; agentName: string }): AgentPackage => {
    const manifest = manifestSchema.parse(JSON.parse(files[`${slug}/manifest.json`] ?? "null"));
    if (manifest.slug !== slug) {
      throw new Error(`marketplace/${slug}/manifest.json names the package ${manifest.slug}.`);
    }
    const { version } = manifest;
    const prefix = `${slug}/package/`;
    const release = Object.fromEntries(
      Object.entries(files).flatMap(([path, content]) =>
        path.startsWith(prefix) ? [[path.slice(prefix.length), content]] : [],
      ),
    );
    const declaration = marketplacePackageDeclarationSchema.parse(
      JSON.parse(release[".marketplace/installation.json"] ?? "null"),
    );
    return {
      slug,
      version,
      metadata: manifest.metadata,
      agentName,
      permissions: declaration.permissions,
      files: release,
    };
  };
  return {
    bookkeeper: read(AGENT_PACKAGE_SLUGS.bookkeeper),
    books: read(AGENT_PACKAGE_SLUGS.books),
  };
}

/** Bookkeeping owns the packages of its Marketplace, so their listing IDs name it by its slug. */
export function agentPackageListingId(agentPackage: AgentPackage): string {
  return `app:${BOOKKEEPING_APP_SLUG}#${agentPackage.slug}`;
}

/** Where Bookkeeping's events come from in a Backoffice: its app's ID there. */
export function bookkeepingEventSource(appId: string): string {
  return `app:${appId}`;
}

/** A package's files, as the Backoffice where Bookkeeping is the app `appId` publishes them. */
export function agentPackageFiles(
  agentPackage: AgentPackage,
  appId: string,
): Record<string, string> {
  const eventSource = bookkeepingEventSource(appId);
  return Object.fromEntries(
    Object.entries(agentPackage.files).map(([path, content]) => [
      path,
      content.replaceAll(EVENT_SOURCE_PLACEHOLDER, eventSource),
    ]),
  );
}
