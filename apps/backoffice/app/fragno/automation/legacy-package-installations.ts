import {
  MARKETPLACE_LOCK_PATH,
  marketplaceLockSchema,
  packagesImportLegacyInputSchema,
  type PackageInstallation,
  type PackagesImportLegacyInput,
  type PackagesImportLegacyResult,
} from "@fragno-dev/backoffice-api/v0/marketplace";
import { z } from "zod";

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
  url.searchParams.set("key", LOCK_FILE_KEY);
  return url;
}

function isMissing(response: Response) {
  return response.status === 404 || response.status === 410;
}

/**
 * The lock's content and a revision it has, or not yet had, when read. The revision is read first,
 * so a change in between moves it past what the content shows and the delete below refuses.
 */
async function readLegacyLock(upload: UploadHttp) {
  const metadata = await upload.fetch(new Request(lockFileUrl("/files/by-key")));
  if (isMissing(metadata)) {
    return null;
  }
  if (!metadata.ok) {
    throw new Error(`${MARKETPLACE_LOCK_PATH} could not be read (${metadata.status}).`);
  }
  const file = (await metadata.json()) as { status: string; revision: number };
  if (file.status === "deleted") {
    return null;
  }
  const content = await upload.fetch(new Request(lockFileUrl("/files/by-key/content")));
  if (isMissing(content)) {
    return null;
  }
  if (!content.ok) {
    throw new Error(`${MARKETPLACE_LOCK_PATH} could not be read (${content.status}).`);
  }
  return { source: await content.text(), revision: file.revision };
}

/** Deletes the lock only at the revision that was imported; a newer one is kept to import. */
async function deleteLegacyLock(upload: UploadHttp, revision: number) {
  const response = await upload.fetch(
    new Request("https://upload.internal/api/upload/files/commit-prepared", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        entries: [
          {
            kind: "delete",
            fileKey: LOCK_FILE_KEY,
            precondition: { kind: "revision", revision },
          },
        ],
      }),
    }),
  );
  if (response.ok) {
    return "deleted" as const;
  }
  const error = (await response.json().catch(() => null)) as { code?: unknown } | null;
  if (error?.code === "FILE_PRECONDITION_FAILED") {
    return "changed" as const;
  }
  throw new Error(`${MARKETPLACE_LOCK_PATH} could not be deleted (${response.status}).`);
}

/**
 * Turns the entries of the workspace's legacy Marketplace lock into installation records, then
 * deletes the lock once nothing in it is left to decide, unless it changed while importing. Importing again is safe: listings that
 * already have an installation keep it.
 */
export async function importLegacyPackageInstallations(
  fragment: AutomationFragment,
  { upload, input }: { upload: UploadHttp; input: PackagesImportLegacyInput },
): Promise<LegacyPackageImportOutcome> {
  const { keep } = packagesImportLegacyInputSchema.parse(input);
  const lockFile = await readLegacyLock(upload);
  if (lockFile === null) {
    return {
      ok: true,
      result: { imported: [], alreadyInstalled: [], conflicts: [], lock: "absent" },
    };
  }
  let json: unknown = null;
  try {
    json = JSON.parse(lockFile.source);
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
    result.lock = await deleteLegacyLock(upload, lockFile.revision);
  }
  return { ok: true, result };
}
