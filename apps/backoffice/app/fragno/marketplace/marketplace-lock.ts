import { z } from "zod";

import { marketplaceListingIdSchema, marketplaceVersionSchema } from "./contracts";

/** Each destination workspace has one root lock file, independent of installation folders. */
export const MARKETPLACE_LOCK_PATH = "/workspace/marketplace-lock.json";

/** The workspace lock reserves its file path, including attempts to use it as a directory. */
export function isMarketplaceLockPath(path: string): boolean {
  return path === MARKETPLACE_LOCK_PATH || path.startsWith(`${MARKETPLACE_LOCK_PATH}/`);
}

/** Installation paths are absolute directories within the destination workspace. */
export const marketplaceInstallationRootSchema = z
  .string()
  .trim()
  .transform((path) => path.replace(/\/+$/u, ""))
  // Declaration generation needs the transform's concrete output schema.
  .pipe(z.string())
  .refine(
    (path) =>
      (path === "/workspace" || path.startsWith("/workspace/")) &&
      !/[\\\p{Cc}]/u.test(path) &&
      path
        .slice(1)
        .split("/")
        .every((part) => part !== "" && part !== "." && part !== ".."),
    "Choose an absolute install path under /workspace without '.' or '..' segments.",
  )
  .refine(
    (path) => !isMarketplaceLockPath(path),
    "The workspace Marketplace lock file cannot be used as an install folder.",
  );

/** The workspace lock records one successful release per listing and installation folder. */
export const marketplaceLockSchema = z
  .strictObject({
    entries: z.array(
      z.strictObject({
        listingId: marketplaceListingIdSchema,
        version: marketplaceVersionSchema,
        installationRoot: marketplaceInstallationRootSchema,
      }),
    ),
  })
  .refine(
    (lock) =>
      new Set(
        lock.entries.map((entry) => JSON.stringify([entry.listingId, entry.installationRoot])),
      ).size === lock.entries.length,
    "Marketplace lock entries must have unique listing and installation folder pairs.",
  );
