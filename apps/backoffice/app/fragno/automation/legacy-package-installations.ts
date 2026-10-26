import {
  MARKETPLACE_LOCK_PATH,
  marketplaceLockSchema,
  packagesImportLegacyInputSchema,
  type PackageInstallation,
  type PackagesImportLegacyInput,
  type PackagesImportLegacyResult,
} from "@fragno-dev/backoffice-api/v0/marketplace";
import { z } from "zod";

import { UPLOAD_PROVIDER_DATABASE } from "@/fragno/upload";

import type { createAutomationFragment } from "./index";

type AutomationFragment = Pick<
  ReturnType<typeof createAutomationFragment>,
  "callServices" | "services"
>;

type UploadHttp = { fetch(request: Request): Promise<Response> };

/** Refusals cross object RPC as values; anything else may succeed on a retry and is thrown. */
export type LegacyPackageImportOutcome =
  | { ok: true; result: PackagesImportLegacyResult }
  | { ok: false; message: string };

const LOCK_FILE_KEY = MARKETPLACE_LOCK_PATH.slice("/workspace/".length);

function lockFileUrl(path: string) {
  const url = new URL(`https://upload.internal/api/upload${path}`);
  url.searchParams.set("provider", UPLOAD_PROVIDER_DATABASE);
  url.searchParams.set("key", LOCK_FILE_KEY);
  return url;
}

async function readLegacyLock(upload: UploadHttp) {
  const response = await upload.fetch(new Request(lockFileUrl("/files/by-key/content")));
  if (response.status === 404 || response.status === 410) {
    return null;
  }
  if (!response.ok) {
    throw new Error(`${MARKETPLACE_LOCK_PATH} could not be read (${response.status}).`);
  }
  return await response.text();
}

async function deleteLegacyLock(upload: UploadHttp) {
  const response = await upload.fetch(
    new Request(lockFileUrl("/files/by-key"), { method: "DELETE" }),
  );
  if (!response.ok && response.status !== 404 && response.status !== 410) {
    throw new Error(`${MARKETPLACE_LOCK_PATH} could not be deleted (${response.status}).`);
  }
}

/**
 * Turns the entries of the workspace's legacy Marketplace lock into installation records, then
 * deletes the lock once nothing in it is left to decide. Importing again is safe: listings that
 * already have an installation keep it.
 */
export async function importLegacyPackageInstallations(
  fragment: AutomationFragment,
  { upload, input }: { upload: UploadHttp; input: PackagesImportLegacyInput },
): Promise<LegacyPackageImportOutcome> {
  const { keep } = packagesImportLegacyInputSchema.parse(input);
  const source = await readLegacyLock(upload);
  if (source === null) {
    return {
      ok: true,
      result: { imported: [], alreadyInstalled: [], conflicts: [], lock: "absent" },
    };
  }
  let json: unknown = null;
  try {
    json = JSON.parse(source);
  } catch {
    // Invalid JSON fails the schema below, like any other invalid lock.
  }
  const lock = marketplaceLockSchema.safeParse(json);
  if (!lock.success) {
    return {
      ok: false,
      message: `${MARKETPLACE_LOCK_PATH} is invalid: ${z.prettifyError(lock.error)}. Fix or delete it, then import again.`,
    };
  }

  const entriesByListing = new Map<string, typeof lock.data.entries>();
  for (const entry of lock.data.entries) {
    entriesByListing.set(entry.listingId, [
      ...(entriesByListing.get(entry.listingId) ?? []),
      entry,
    ]);
  }
  for (const kept of keep) {
    if (
      !entriesByListing
        .get(kept.listingId)
        ?.some((entry) => entry.installationRoot === kept.installationRoot)
    ) {
      return {
        ok: false,
        message: `${MARKETPLACE_LOCK_PATH} has no installation of '${kept.listingId}' at '${kept.installationRoot}' to keep.`,
      };
    }
  }

  const installed = new Set(
    (await fragment.callServices(() => fragment.services.listPackageInstallations())).map(
      (installation) => installation.listingId,
    ),
  );
  const candidates: PackageInstallation[] = [];
  const result: PackagesImportLegacyResult = {
    imported: [],
    alreadyInstalled: [],
    conflicts: [],
    lock: "kept",
  };
  for (const [listingId, entries] of entriesByListing) {
    if (installed.has(listingId)) {
      result.alreadyInstalled.push(
        ...entries.map(({ installationRoot }) => ({ listingId, installationRoot })),
      );
      continue;
    }
    const chosen =
      entries.length === 1
        ? entries[0]
        : entries.find(({ installationRoot }) =>
            keep.some(
              (kept) => kept.listingId === listingId && kept.installationRoot === installationRoot,
            ),
          );
    if (!chosen) {
      result.conflicts.push({
        listingId,
        installationRoots: entries.map(({ installationRoot }) => installationRoot),
      });
      continue;
    }
    candidates.push({
      marketplace: chosen.marketplace,
      listingId,
      version: chosen.version,
      installationRoot: chosen.installationRoot,
      permissions: [],
      settings: {},
    });
  }

  const created = await fragment.callServices(() =>
    candidates.map((installation) =>
      fragment.services.createPackageInstallationIfAbsent(installation),
    ),
  );
  candidates.forEach((installation, index) => {
    if (created[index]) {
      result.imported.push(installation);
    } else {
      // Installed since the records were listed.
      result.alreadyInstalled.push({
        listingId: installation.listingId,
        installationRoot: installation.installationRoot,
      });
    }
  });

  if (result.conflicts.length === 0) {
    await deleteLegacyLock(upload);
    result.lock = "deleted";
  }
  return { ok: true, result };
}
